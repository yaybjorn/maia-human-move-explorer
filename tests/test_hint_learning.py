import json
import sqlite3

from app.hint_learning import learning_schema, reconcile_stage, stage_save


def draft(revision, text):
    return {"revision": revision, "revisionHash": f"hash{revision}", "metadata": {"side": "white"},
            "sourcePGN": f"1. e4 {{[%hint {text}]}} *" if text else "1. e4 *"}


def receipt(token, actor, revision, text):
    return {"receiptID": token, "courseID": "course", "actorID": actor, "revision": revision,
            "revisionHash": f"hash{revision}", "document": draft(revision, text)}


def examples(db):
    with sqlite3.connect(db) as conn:
        return [json.loads(row[0]) for row in conn.execute("SELECT record FROM hint_learning_examples")]


def test_manual_requires_exact_committed_receipt_and_tracks_edits_and_removal(tmp_path):
    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    assert not reconcile_stage(db, token, receipt(token, "other", 2, "Manual"))
    assert not reconcile_stage(db, token, receipt(token, "author", 3, "Manual"))
    assert examples(db) == []
    assert reconcile_stage(db, token, receipt(token, "author", 2, "Manual"))
    assert [(x["text"], x["kind"]) for x in examples(db)] == [("Manual", "manual_hint")]
    token = stage_save(db, "course", "author", draft(2, "Manual"))
    assert reconcile_stage(db, token, receipt(token, "author", 3, "Corrected"))
    assert [x["text"] for x in examples(db)] == ["Corrected"]
    token = stage_save(db, "course", "author", draft(3, "Corrected"))
    assert reconcile_stage(db, token, receipt(token, "author", 4, ""))
    assert examples(db) == []


def test_approved_applied_edited_ai_keeps_lineage_and_rejected_is_excluded(tmp_path):
    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"review", "courseID":"course", "revision":1, "revisionHash":"hash1", "chapterID":None,
              "moves":[], "answer":"e2e4", "candidates":[{"id":"candidate", "text":"AI wording", "status":"approved", "rating":5}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("review","course",1,"author",json.dumps(review)))
        for version, action in enumerate(("approve", "apply_intent"), 1):
            conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(version),"review","author",action,"candidate",version,"{}"))
    assert reconcile_stage(db, token, receipt(token, "author", 2, "AI wording"))
    assert examples(db)[0]["kind"] == "ai_assisted_hint"
    token = stage_save(db, "course", "author", draft(2, "AI wording"))
    assert reconcile_stage(db, token, receipt(token, "author", 3, "Further corrected"))
    assert examples(db)[0]["kind"] == "ai_assisted_hint"


def test_rejected_or_unapplied_suggestion_never_becomes_manual(tmp_path):
    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"review", "courseID":"course", "revision":1, "revisionHash":"hash1", "chapterID":None,
              "moves":[], "answer":"e2e4", "candidates":[{"id":"candidate", "text":"Draft wording", "status":"rejected", "rating":0}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("review","course",1,"author",json.dumps(review)))
    assert reconcile_stage(db, token, receipt(token, "author", 2, "Edited draft wording"))
    assert examples(db) == []


def test_timeout_then_later_save_recovers_exact_original_receipt(tmp_path):
    import asyncio

    from app.hint_learning import recover_stages

    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "original-author", draft(1, ""))
    # A later revision exists, but the immutable receipt still identifies the
    # original actor and exact saved content independently of current state.
    async def upstream(_request, path):
        assert path == f"courses/course/draft-receipts/{token}"
        return receipt(token, "original-author", 2, "Saved before timeout")
    asyncio.run(recover_stages(db, object(), upstream))
    assert [(x["text"], x["kind"]) for x in examples(db)] == [("Saved before timeout", "manual_hint")]
    asyncio.run(recover_stages(db, object(), upstream))
    assert len(examples(db)) == 1


def test_qa_identity_and_explicit_course_scope_are_excluded(tmp_path, monkeypatch):
    db = tmp_path / "review.sqlite"
    assert stage_save(db, "qa", "id", draft(1, ""), "ODIN-QA@fablelabs.no") is None
    monkeypatch.setenv("HINT_LEARNING_EXCLUDED_COURSES", "qa-fixture")
    assert stage_save(db, "qa-fixture", "id", draft(1, "")) is None


def test_shared_ai_hint_never_turns_into_manual_on_inherited_occurrence(tmp_path):
    db = tmp_path / "review.sqlite"
    before = {"revision":1, "revisionHash":"hash1", "metadata":{"side":"white"},
              "chapterSources":[{"id":"a", "sourcePGN":"1. e4 *"}, {"id":"b", "sourcePGN":"1. e4 *"}]}
    after = {**before, "chapterSources":[{"id":"a", "sourcePGN":"1. e4 {[%hint Original AI hint]} *"},
                                          {"id":"b", "sourcePGN":"1. e4 {[%hint Original AI hint]} *"}]}
    token = stage_save(db, "course", "author", before)
    review = {"id":"r", "revisionHash":"hash1", "chapterID":"a", "moves":[], "answer":"e2e4",
              "candidates":[{"id":"c", "text":"Original AI hint", "status":"approved", "rating":4}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r","course",1,"author",json.dumps(review)))
        for version, action in enumerate(("approve", "apply_intent"), 1):
            conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(version),"r","author",action,"c",version,"{}"))
    assert reconcile_stage(db, token, {"receiptID":token,"courseID":"course","actorID":"author","revision":2,"revisionHash":"hash2","document":after})
    assert {x["kind"] for x in examples(db)} == {"ai_assisted_hint"}
    assert len(examples(db)) == 2


def test_later_receipt_waits_for_earlier_commit_to_preserve_lineage(tmp_path):
    db = tmp_path / "review.sqlite"
    first = stage_save(db, "course", "author", draft(1, ""))
    second = stage_save(db, "course", "author", draft(2, "Saved first"))
    assert not reconcile_stage(db, second, receipt(second, "author", 3, "Saved first"))
    assert reconcile_stage(db, first, receipt(first, "author", 2, "Saved first"))
    assert reconcile_stage(db, second, receipt(second, "author", 3, "Saved first"))
    assert [(x["text"], x["kind"]) for x in examples(db)] == [("Saved first", "manual_hint")]


def test_removed_ai_hint_reintroduced_later_retains_ai_provenance(tmp_path):
    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"r", "revisionHash":"hash1", "chapterID":None, "moves":[], "answer":"e2e4",
              "candidates":[{"id":"c", "text":"AI original", "status":"approved", "rating":4}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r","course",1,"author",json.dumps(review)))
        for version, action in enumerate(("approve", "apply_intent"), 1):
            conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(version),"r","author",action,"c",version,"{}"))
    assert reconcile_stage(db, token, receipt(token, "author", 2, "AI original"))
    token = stage_save(db, "course", "author", draft(2, "AI original"))
    assert reconcile_stage(db, token, receipt(token, "author", 3, ""))
    assert examples(db) == []
    token = stage_save(db, "course", "author", draft(3, ""))
    assert reconcile_stage(db, token, receipt(token, "author", 4, "Restored edited hint"))
    assert examples(db)[0]["kind"] == "ai_assisted_hint"


def test_rejected_second_review_cannot_borrow_old_approval(tmp_path):
    from app.hint_studio import update_review

    db = tmp_path / "review.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        for name, text in (("old", "Old approved"), ("new", "New rejected")):
            review = {"id":name, "version":0, "revisionHash":"hash1", "chapterID":None,
                      "moves":[], "answer":"e2e4", "candidates":[{"id":name, "text":text, "status":"draft", "rating":0}]}
            conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", (name,"course",1,"author",json.dumps(review)))
    def action(name, version, operation):
        update_review(db, {"reviewID":name, "candidateID":name, "version":version, "operation":operation},
                      "author", "course", 1, "hash1", None, [], "e2e4")
    action("old", 0, "approve")
    action("old", 1, "apply")
    action("new", 0, "reject")
    assert reconcile_stage(db, token, receipt(token, "author", 2, "New rejected"))
    assert examples(db) == []


def test_pending_attempts_do_not_block_unrelated_saves_and_uncertain_receipts_survive(tmp_path):
    import asyncio

    from fastapi import HTTPException

    from app.hint_learning import pending_stages, recover_stages

    db = tmp_path / "review.sqlite"
    tokens = [stage_save(db, f"course-{i}", "author", draft(1, "")) for i in range(105)]
    later = stage_save(db, "unrelated", "author", draft(1, ""))
    async def no_receipt(_request, path):
        if "draft-receipts" in path:
            raise HTTPException(404)
        return {"draft":draft(1, "")}
    asyncio.run(recover_stages(db, None, no_receipt, "course-0"))
    assert tokens[0] in [row[0] for row in pending_stages(db, "course-0")]
    asyncio.run(recover_stages(db, None, no_receipt, "course-0", tokens[0]))
    assert pending_stages(db, "course-0") == []
    assert later in [row[0] for row in pending_stages(db, "unrelated")]
