import sqlite3

import pytest

from app.beyond_basics_action_queue import claim, enqueue, ensure_schema, finish


def db():
    conn = sqlite3.connect(':memory:', isolation_level=None)
    conn.execute('CREATE TABLE revisions(source TEXT,page_id TEXT,generation INTEGER,body TEXT,notes TEXT DEFAULT "",decision TEXT DEFAULT "",ready INTEGER DEFAULT 0,PRIMARY KEY(source,page_id,generation))')
    ensure_schema(conn)
    conn.execute("INSERT INTO revisions(source,page_id,generation,body) VALUES ('s','p',1,'Move teh king safely')")
    return conn


def test_queue_deduplicates_and_applies_with_readback():
    conn = db()
    a = enqueue(conn, 's', 'p', 1, 'Correct the spelling')
    assert enqueue(conn, 's', 'p', 1, 'Correct the spelling') == a
    job = claim(conn, 's', now=100)
    assert claim(conn, 's', now=100) is None
    proposal = {'status': 'completed', 'message': 'Fixed', 'patches': [{'component': 0, 'field': 'body', 'old': 'teh', 'new': 'the'}]}
    assert finish(conn, 's', a, job['lease_token'], proposal, [{'body': 'Move teh king safely'}], now=101) == 'completed'
    assert 'the king' in conn.execute('SELECT body FROM revisions ORDER BY generation DESC').fetchone()[0]
    with pytest.raises(ValueError):
        finish(conn, 's', a, job['lease_token'], proposal, [{'body': 'Move teh king safely'}], now=102)


def test_newer_revision_and_expired_fencing_never_apply():
    conn = db()
    a = enqueue(conn, 's', 'p', 1, 'Change text')
    first = claim(conn, 's', now=100)
    second = claim(conn, 's', now=221)
    proposal = {'status': 'completed', 'message': 'Fixed', 'patches': [{'component': 0, 'field': 'body', 'old': 'old', 'new': 'new'}]}
    with pytest.raises(ValueError):
        finish(conn, 's', a, first['lease_token'], proposal, [{'body': 'old'}], now=222)
    conn.execute("INSERT INTO revisions(source,page_id,generation,body) VALUES ('s','p',2,'new')")
    assert finish(conn, 's', a, second['lease_token'], proposal, [{'body': 'old'}], now=222) == 'needs-clarification'
    assert conn.execute("SELECT count(*) FROM review_overlays").fetchone()[0] == 0


def test_bad_proposal_fails_and_expired_attempts_are_bounded():
    conn = db()
    a = enqueue(conn, 's', 'p', 1, 'Change')
    for now in [0, 121, 242]:
        assert claim(conn, 's', now=now)['id'] == a
    assert claim(conn, 's', now=363) is None
    assert conn.execute('SELECT status FROM review_actions').fetchone()[0] == 'failed'


def test_production_finish_contextual_proofreading():
    """Unsafe suggestions do not create revisions; ordinary prose still does."""
    cases = [
        ('Teh played a brilliant move.', 'Teh', 'The', False),
        ('The student must not write "teh" as the correct spelling.', 'teh', 'the', False),
        ('Do not change the literal token "adn" in this exercise.', 'adn', 'and', False),
        ('The player named teh played a strong move.', 'teh', 'the', False),
        ('Remember the word adn means something in this lesson.', 'adn', 'and', False),
        ('Try `adn` in the code sample here.', 'adn', 'and', False),
        ('<p>Use <code>adn</code> in this example.</p>', 'adn', 'and', False),
        ('<p>Say "Move <b>teh king safely</b>" here.</p>', 'teh', 'the', False),
        ('The label «adn» identifies the active diagram.', 'adn', 'and', False),
        ('The label ‹adn› identifies the active diagram.', 'adn', 'and', False),
        ('The label “adn” identifies the active diagram.', 'adn', 'and', False),
        ("The label 'adn' identifies the active diagram.", 'adn', 'and', False),
        ('The label 「adn」 identifies the active diagram.', 'adn', 'and', False),
        ('The label «adn identifies the active diagram.', 'adn', 'and', False),
        ('The label adn» identifies the active diagram.', 'adn', 'and', False),
        ('The label `adn identifies the active diagram.', 'adn', 'and', False),
        (r'The label \"adn\" identifies the active diagram.', 'adn', 'and', False),
        ('The label &quot;adn&quot; identifies the active diagram.', 'adn', 'and', False),
        ('The label &#34;adn&#34; identifies the active diagram.', 'adn', 'and', False),
        ('The label &#x22;adn&#x22; identifies the active diagram.', 'adn', 'and', False),
        ('The label &ldquo;adn&rdquo; identifies the active diagram.', 'adn', 'and', False),
        ('The label «diagram» is here. Move teh king safely.', 'teh', 'the', True),
        ("Don't move teh king too soon.", 'teh', 'the', True),
        ('Don’t move teh king too soon.', 'teh', 'the', True),
        ('Move teh king to safety.', 'teh', 'the', True),
        ('Protect the rook adn queen together.', 'adn', 'and', True),
        ('On this board the pieces is ready.', 'the pieces is', 'the pieces are', True),
        ('You recieved a useful position here.', 'recieved', 'received', True),
        ('This move is strong , but risky.', ' ,', ',', True),
    ]
    for body, old, new, accepted in cases:
        conn = sqlite3.connect(':memory:', isolation_level=None)
        conn.execute('CREATE TABLE revisions(source TEXT,page_id TEXT,generation INTEGER,body TEXT,notes TEXT,decision TEXT,ready INTEGER,PRIMARY KEY(source,page_id,generation))')
        ensure_schema(conn)
        instruction = 'Correct spelling and grammar and punctuation'
        conn.execute('INSERT INTO revisions VALUES (?,?,?,?,?,?,?)', ('s', 'p', 1, body, instruction, '', 0))
        action = enqueue(conn, 's', 'p', 1, instruction)
        job = claim(conn, 's', now=100)
        proposal = {'status': 'completed', 'message': 'fixed', 'patches': [
            {'component': 0, 'field': 'body', 'old': old, 'new': new}]}
        status = finish(conn, 's', action, job['lease_token'], proposal, [{'body': body}], now=101)
        generation, readback = conn.execute('SELECT generation,body FROM revisions ORDER BY generation DESC LIMIT 1').fetchone()
        suggestions = conn.execute('SELECT suggestions FROM review_actions WHERE id=?', (action,)).fetchone()[0]
        if accepted:
            assert (status, generation, readback) == ('completed', 2, body.replace(old, new))
        else:
            assert (status, generation, readback) == ('needs-clarification', 1, body)
            assert old in suggestions and new in suggestions
        conn.close()
