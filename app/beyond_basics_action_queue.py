"""Transactional private review action state. No inference or network authority."""
import hashlib
import json
import secrets
import time

from app.beyond_basics_action_patches import InvalidProposal, apply_proposal, is_copy_edit_request
from app.beyond_basics_page_design import current_design, requested_design

MAX_ATTEMPTS = 3
MAX_ACTIVE_ACTIONS = 100
MAX_INSTRUCTION_LENGTH = 4000
LEASE_SECONDS = 120


def ensure_schema(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS review_actions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, page_id TEXT NOT NULL,
        generation INTEGER NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
        lease_until REAL, updated_at REAL NOT NULL,
        UNIQUE(source,page_id,generation))""")
    conn.execute('CREATE TABLE IF NOT EXISTS review_preview_unsynced (source TEXT NOT NULL,page_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(source,page_id,generation))')
    conn.execute('CREATE TABLE IF NOT EXISTS review_render_patches (source TEXT NOT NULL,page_id TEXT NOT NULL,generation INTEGER NOT NULL,patches TEXT NOT NULL,PRIMARY KEY(source,page_id,generation))')
    conn.execute('CREATE TABLE IF NOT EXISTS review_design (source TEXT NOT NULL,page_id TEXT NOT NULL,generation INTEGER NOT NULL,settings TEXT NOT NULL,PRIMARY KEY(source,page_id,generation))')
    if 'suggestions' not in {row[1] for row in conn.execute('PRAGMA table_info(review_actions)')}:
        conn.execute("ALTER TABLE review_actions ADD COLUMN suggestions TEXT NOT NULL DEFAULT '[]'")
    conn.execute('CREATE TABLE IF NOT EXISTS review_overlays (source TEXT NOT NULL,page_id TEXT NOT NULL,generation INTEGER NOT NULL,patches TEXT NOT NULL,PRIMARY KEY(source,page_id,generation))')


def enqueue(conn, source, page_id, generation, instruction):
    """Call inside the same transaction as the saved revision."""
    if not isinstance(instruction, str) or len(instruction) > MAX_INSTRUCTION_LENGTH:
        raise ValueError('Invalid instruction')
    if not instruction.strip():
        return None
    existing = conn.execute('SELECT id,instruction FROM review_actions WHERE source=? AND page_id=? AND generation=?', (source, page_id, generation)).fetchone()
    if existing:
        if existing[1] != instruction:
            raise ValueError('Action already exists with different instruction')
        return existing[0]
    active = conn.execute("SELECT count(*) FROM review_actions WHERE source=? AND status IN ('queued','running','specialist','specialist-dispatched')", (source,)).fetchone()[0]
    if active >= MAX_ACTIVE_ACTIONS:
        raise ValueError('Review queue is full')
    action_id = hashlib.sha256(f'{source}\0{page_id}\0{generation}'.encode()).hexdigest()
    conn.execute("INSERT OR IGNORE INTO review_actions(id,source,page_id,generation,instruction,status,updated_at) VALUES (?,?,?,?,?,'queued',?)", (action_id, source, page_id, generation, instruction, time.time()))
    return action_id


def claim(conn, source, now=None):
    """Atomically acquire one current action; stale and exhausted work fail closed."""
    now = time.time() if now is None else now
    conn.execute('BEGIN IMMEDIATE')
    try:
        conn.execute("UPDATE review_actions SET status='failed',message='Retries exhausted',lease_token=NULL,lease_until=NULL,updated_at=? WHERE source=? AND status='running' AND lease_until<=? AND attempts>=?", (now, source, now, MAX_ATTEMPTS))
        conn.execute("UPDATE review_actions SET status='queued',lease_token=NULL,lease_until=NULL,updated_at=? WHERE source=? AND status='running' AND lease_until<=? AND attempts<?", (now, source, now, MAX_ATTEMPTS))
        conn.execute("""UPDATE review_actions SET status='needs-clarification',message='A newer page revision exists',updated_at=?
            WHERE source=? AND status='queued' AND generation !=
            (SELECT max(generation) FROM revisions WHERE source=review_actions.source AND page_id=review_actions.page_id)""", (now, source))
        if conn.execute("SELECT 1 FROM review_actions WHERE source=? AND status='running' LIMIT 1", (source,)).fetchone():
            conn.commit()
            return None
        row = conn.execute("SELECT id,page_id,generation,instruction FROM review_actions WHERE source=? AND status='queued' ORDER BY updated_at,id LIMIT 1", (source,)).fetchone()
        if not row:
            conn.commit()
            return None
        token = secrets.token_urlsafe(32)
        conn.execute("UPDATE review_actions SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?", (token, now + LEASE_SECONDS, now, row[0]))
        conn.commit()
        return {'id': row[0], 'page_id': row[1], 'generation': row[2], 'instruction': row[3], 'lease_token': token}
    except Exception:
        conn.rollback()
        raise


def finish(conn, source, action_id, lease_token, proposal, components, now=None, renderable=True):
    """Validate and commit the page overlay and action outcome atomically.

    Caller supplies components from a trusted source, never from the worker.
    """
    now = time.time() if now is None else now
    conn.execute('BEGIN IMMEDIATE')
    try:
        action = conn.execute("SELECT page_id,generation,status,lease_token,lease_until,instruction FROM review_actions WHERE id=? AND source=?", (action_id, source)).fetchone()
        if not action or action[2] != 'running' or action[3] != lease_token or action[4] <= now:
            raise ValueError('Invalid or expired lease')
        page_id, generation = action[:2]
        latest = conn.execute('SELECT generation FROM revisions WHERE source=? AND page_id=? ORDER BY generation DESC LIMIT 1', (source, page_id)).fetchone()
        suggestions = []
        render_row = conn.execute('SELECT patches FROM review_render_patches WHERE source=? AND page_id=? AND generation=?', (source,page_id,generation)).fetchone()
        render_patches = json.loads(render_row[0]) if render_row else []
        design_row = conn.execute('SELECT settings FROM review_design WHERE source=? AND page_id=? AND generation=?', (source, page_id, generation)).fetchone()
        design = json.loads(design_row[0]) if design_row else {}
        if not latest or latest[0] != generation:
            status, message, patches = 'needs-clarification', 'A newer page revision exists', []
        else:
            try:
                row = conn.execute('SELECT body FROM revisions WHERE source=? AND page_id=? AND generation=?', (source,page_id,generation)).fetchone()
                if not row or components != [{'body': row[0]}]:
                    raise InvalidProposal('Saved source changed')
                change = requested_design(action[5], page_id)
                if conn.execute('SELECT 1 FROM review_preview_unsynced WHERE source=? AND page_id=? AND generation=?', (source,page_id,generation)).fetchone():
                    raise InvalidProposal('Saved text does not match the lesson preview')
                if proposal == {'status': 'specialist', 'message': 'Request specialist follow-up', 'patches': []}:
                    status, message, patches = 'needs-clarification', 'Instruction saved but not applied; this request is not supported yet.', []
                elif change and proposal == {'status': 'completed', 'message': 'Apply supported design', 'patches': []}:
                    already = all(current_design(page_id, design).get(k) == v for k, v in change.items())
                    design.update(change)
                    patches = [{'component': 0, 'field': 'body', 'value': row[0]}]
                    status, message = 'completed', ('Requested changes already in place.' if already else 'Requested changes applied to the private review.')
                else:
                    patches = apply_proposal(components, proposal, action[5])
                    status, message = proposal['status'], proposal['message']
                    if status == 'completed' and not renderable:
                        status, message, patches = 'needs-clarification', 'Instruction saved but not applied; this request is not supported yet.', []
                    elif status == 'completed':
                        render_patches.extend({'old': p['old'], 'new': p['new']} for p in proposal['patches'])
                        message = 'Text edit applied; please review its meaning.' if is_copy_edit_request(action[5]) else 'Verified edits applied; other issues may remain.'
            except (InvalidProposal, TypeError, KeyError, ValueError, OSError):
                status, message, patches = 'needs-clarification', 'Review the suggested edits manually; they were not applied.', []
                # Only structurally safe, source-bound suggestions are retained.
                # They grant no mutation authority; the author edits and saves.
                try:
                    if row and components == [{'body': row[0]}]:
                        apply_proposal(components, proposal)
                        suggestions = [{'old': p['old'], 'new': p['new']} for p in proposal['patches']
                                       if p['component'] == 0 and p['field'] == 'body']
                        if suggestions:
                            status, message = 'needs-clarification', 'Instruction saved but not applied; review suggested edits manually.'
                except (InvalidProposal, TypeError, KeyError):
                    pass
        if status == 'completed':
            if len(patches) != 1 or patches[0]['component'] != 0 or patches[0]['field'] != 'body':
                raise ValueError('Invalid saved-body result')
            # A correction is a new immutable revision, fencing any stale editor.
            new_generation = generation + 1
            inserted = conn.execute("""INSERT INTO revisions(source,page_id,generation,body,notes,decision,ready)
                SELECT source,page_id,?, ?,notes,decision,0 FROM revisions
                WHERE source=? AND page_id=? AND generation=? AND body=?""",
                (new_generation,patches[0]['value'],source,page_id,generation,row[0]))
            if inserted.rowcount != 1:
                raise ValueError('Saved-body compare-and-swap failed')
            if conn.execute('SELECT 1 FROM review_preview_unsynced WHERE source=? AND page_id=? AND generation=?',(source,page_id,generation)).fetchone():
                conn.execute('INSERT INTO review_preview_unsynced VALUES (?,?,?)',(source,page_id,new_generation))
            if render_patches:
                conn.execute('INSERT INTO review_render_patches VALUES (?,?,?,?)', (source,page_id,new_generation,json.dumps(render_patches,ensure_ascii=True)))
            if design:
                conn.execute('INSERT INTO review_design VALUES (?,?,?,?)', (source, page_id, new_generation, json.dumps(design, sort_keys=True)))
            new_id = hashlib.sha256(f'{source}\0{page_id}\0{new_generation}'.encode()).hexdigest()
            conn.execute("INSERT INTO review_actions(id,source,page_id,generation,instruction,status,message,updated_at) VALUES (?,?,?,?,?,'completed',?,?)",
                         (new_id,source,page_id,new_generation,action[5],message,now))
        conn.execute('UPDATE review_actions SET status=?,message=?,suggestions=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?', (status,message,json.dumps(suggestions, ensure_ascii=True),now,action_id))
        conn.commit()
        return status
    except Exception:
        conn.rollback()
        raise
