import asyncio

from app.hint_learning import reconcile_stage, stage_save
from app.hint_reference_live import eligible_references
from app.hint_saved import saved_hint_occurrences


def draft(revision, text):
    return {"revision": revision, "revisionHash": f"hash{revision}", "metadata": {"side":"white"},
            "sourcePGN": f"1. e4 {{[%hint {text}]}} *" if text else "1. e4 *"}


def test_only_current_accessible_saved_references_are_selected(tmp_path):
    db = tmp_path / "private.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    assert reconcile_stage(db, token, {"receiptID":token, "courseID":"course", "actorID":"author", "revision":2,
                                       "revisionHash":"hash2", "document":draft(2, "New manual hint")})
    old = draft(1, "Original hint")
    key = saved_hint_occurrences(old)[0]["positionKey"]
    static = [{"kind":"handwritten_hint", "text":"Original hint", "source":"original", "san":"e4", "piece":"p",
               "occurrences":[{"courseID":"original-course", "chapterID":None, "positionKey":key}]},
              {"kind":"style_prose", "source":"private prose", "text":"Separate prose."}]
    courses = {"original-course":old, "course":draft(2,"New manual hint")}
    async def upstream(_request, path):
        return {"course":{"status":"published"}, "draft":courses[path.split("/")[1]]}
    evidence = {"position_key":"some-other-position", "answer":{"san":"e4", "piece":"p"}}
    select = lambda: asyncio.run(eligible_references(None, upstream, evidence, static, db))
    refs = select()
    assert {r["text"] for r in refs} == {"Original hint", "New manual hint", "Separate prose."}
    courses["course"] = draft(3, "Removed or changed")
    courses["original-course"] = draft(2, "")
    assert [r["text"] for r in select()] == ["Separate prose."]


def test_next_generation_receives_new_eligible_reference(tmp_path, monkeypatch):
    import uuid

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    import app.hint_studio as studio

    db = tmp_path / "reviews.sqlite"
    monkeypatch.setenv("HINT_REVIEW_DB", str(db))
    token = stage_save(db, "source-course", "author", draft(1, ""))
    assert reconcile_stage(db, token, {"receiptID":token, "courseID":"source-course", "actorID":"author", "revision":2,
                                       "revisionHash":"hash2", "document":draft(2, "New manual reference")})
    seen = []
    monkeypatch.setattr(studio, "analyze_hint", lambda *_: {"position_key":"target", "answer":{"san":"Nf3", "uci":"g1f3", "piece":"n"}})
    monkeypatch.setattr(studio, "private_references", lambda *_: [])
    def generate(_evidence, refs):
        seen.extend(refs)
        return {"candidates":["one", "two", "three"], "model":"mock"}
    monkeypatch.setattr(studio, "generate_hints", generate)
    target = {"revision":1, "revisionHash":"targethash", "metadata":{"side":"white"}, "sourcePGN":"1. e4 e5 2. Nf3 *"}
    async def upstream(_request, path):
        if path == "session":
            return {"authenticated":True, "user":{"id":"author", "roles":["superadmin"]}, "csrfToken":"csrf"}
        if path == "courses/target-course":
            return {"course":{"status":"published"}, "draft":target}
        if path == "courses/source-course":
            return {"course":{"status":"published"}, "draft":draft(2, "New manual reference")}
        raise AssertionError(path)
    app = FastAPI()
    @app.post("/hint")
    async def endpoint(request: Request):
        return await studio.dispatch(request, upstream, {"https://example.test"})
    response = TestClient(app).post("/hint", headers={"origin":"https://example.test", "x-csrf-token":"csrf"},
        json={"courseID":"target-course", "revision":1, "revisionHash":"targethash", "chapterID":None,
              "moves":["e2e4", "e7e5"], "answer":"g1f3", "rating":1500, "requestID":str(uuid.uuid4())})
    assert response.status_code == 200
    assert any(r["text"] == "New manual reference" and r["kind"] == "manual_hint" for r in seen)


def test_rejected_review_invalidates_previously_saved_ai_reference(tmp_path):
    import json
    import sqlite3

    from app.hint_learning import learning_schema

    db = tmp_path / "private.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"review", "revisionHash":"hash1", "chapterID":None, "moves":[], "answer":"e2e4",
              "candidates":[{"id":"candidate", "text":"Approved AI", "status":"approved", "rating":5}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("review","course",1,"author",json.dumps(review)))
        for version, action in enumerate(("approve", "apply_intent"), 1):
            conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(version),"review","author",action,"candidate",version,"{}"))
    assert reconcile_stage(db, token, {"receiptID":token, "courseID":"course", "actorID":"author", "revision":2,
                                       "revisionHash":"hash2", "document":draft(2, "Approved AI")})
    async def upstream(_request, _path):
        return {"course":{"status":"published"}, "draft":draft(2,"Approved AI")}
    evidence = {"position_key":"other", "answer":{"san":"e4", "piece":"p"}}
    assert [r["kind"] for r in asyncio.run(eligible_references(None, upstream, evidence, [], db))] == ["ai_assisted_hint"]
    review["candidates"][0]["status"] = "rejected"
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE hint_reviews SET record=? WHERE id='review'", (json.dumps(review),))
    assert asyncio.run(eligible_references(None, upstream, evidence, [], db)) == []


def test_imported_duplicate_cannot_override_revoked_ai_lineage(tmp_path):
    import json
    import sqlite3

    from app.hint_learning import learning_schema

    db = tmp_path / "private.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"r", "revisionHash":"hash1", "chapterID":None, "moves":[], "answer":"e2e4",
              "candidates":[{"id":"c", "text":"AI hint", "status":"approved"}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r","course",1,"author",json.dumps(review)))
        for version, action in enumerate(("approve", "apply_intent"), 1):
            conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(version),"r","author",action,"c",version,"{}"))
    assert reconcile_stage(db, token, {"receiptID":token, "courseID":"course", "actorID":"author", "revision":2,
                                       "revisionHash":"hash2", "document":draft(2, "AI hint")})
    review["candidates"][0]["status"] = "rejected"
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE hint_reviews SET record=? WHERE id='r'", (json.dumps(review),))
    key = saved_hint_occurrences(draft(2, "AI hint"))[0]["positionKey"]
    static = [{"kind":"handwritten_hint", "text":"AI hint", "source":"import", "san":"e4", "piece":"p",
               "occurrences":[{"courseID":"course", "chapterID":None, "positionKey":key},
                              {"courseID":"independent", "chapterID":None, "positionKey":key}]}]
    async def upstream(_request, path):
        return {"course":{"status":"published"}, "draft":draft(2, "AI hint")}
    evidence = {"position_key":"other", "answer":{"san":"e4", "piece":"p"}}
    refs = asyncio.run(eligible_references(None, upstream, evidence, static, db))
    assert len(refs) == 1 and refs[0]["occurrences"][0]["courseID"] == "independent"


def test_imported_rejected_initial_candidate_is_suppressed(tmp_path):
    import json
    import sqlite3

    from app.hint_learning import learning_schema

    db = tmp_path / "private.sqlite"
    token = stage_save(db, "course", "author", draft(1, ""))
    review = {"id":"r", "revisionHash":"hash1", "chapterID":None, "moves":[], "answer":"e2e4",
              "candidates":[{"id":"c", "text":"Rejected hint", "status":"rejected"}]}
    with sqlite3.connect(db) as conn:
        learning_schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r","course",1,"author",json.dumps(review)))
    saved = draft(2, "Rejected hint")
    assert reconcile_stage(db, token, {"receiptID":token, "courseID":"course", "actorID":"author", "revision":2,
                                       "revisionHash":"hash2", "document":saved})
    key = saved_hint_occurrences(saved)[0]["positionKey"]
    static = [{"kind":"handwritten_hint", "text":"Rejected hint", "source":"import", "san":"e4", "piece":"p",
               "occurrences":[{"courseID":"course", "chapterID":None, "positionKey":key}]}]
    async def upstream(_request, _path):
        return {"course":{"status":"published"}, "draft":saved}
    assert asyncio.run(eligible_references(None, upstream, {"position_key":"other", "answer":{"san":"e4", "piece":"p"}}, static, db)) == []
