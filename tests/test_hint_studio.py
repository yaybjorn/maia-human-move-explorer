import pytest
from fastapi import HTTPException

from app.hint_studio import validated_position

DRAFT = {"metadata": {"side": "white"}, "sourcePGN": "1. e4 e5 2. Nf3 (2. Bc4) Nc6 *"}


def test_saved_learner_mainline_only():
    validated_position(DRAFT, None, ["e2e4", "e7e5"], "g1f3")
    with pytest.raises(HTTPException) as wrong:
        validated_position(DRAFT, None, ["e2e4", "e7e5"], "f1c4")
    assert wrong.value.status_code == 409
    with pytest.raises(HTTPException) as turn:
        validated_position(DRAFT, None, ["e2e4"], "e7e5")
    assert turn.value.status_code == 400
    with pytest.raises(HTTPException) as missing:
        validated_position(DRAFT, None, ["d2d4"], "d7d5")
    assert missing.value.status_code == 409


def test_chapter_scope_is_enforced():
    draft = {"metadata": {"side": "white"}, "chapterSources": [{"id": "one", "sourcePGN": "1. d4 d5 *"}]}
    validated_position(draft, "one", [], "d2d4")
    with pytest.raises(HTTPException):
        validated_position(draft, "other", [], "d2d4")


def test_review_edit_invalidates_approval_and_rejects_stale_version(tmp_path):
    import json
    import sqlite3

    from app.hint_studio import schema, update_review

    db = tmp_path / "review.sqlite"
    record = {"id": "r", "version": 1, "revisionHash": "hash", "chapterID": None,
              "moves": [], "answer": "e2e4", "candidates": [{"id": "c", "text": "Think carefully", "rating": 0, "status": "approved"}]}
    with sqlite3.connect(db) as conn:
        schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r", "course", 3, "author", json.dumps(record)))
    payload = {"reviewID": "r", "candidateID": "c", "version": 1, "operation": "edit", "text": "Consider your development"}
    response = update_review(db, payload, "reviewer", "course", 3, "hash", None, [], "e2e4")
    updated = json.loads(response.body)
    assert updated["candidates"][0]["status"] == "draft"
    with pytest.raises(HTTPException) as stale:
        update_review(db, payload, "reviewer", "course", 3, "hash", None, [], "e2e4")
    assert stale.value.status_code == 409
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT actor_id,action FROM hint_review_events").fetchone() == ("reviewer", "edit")


def test_reference_selection_holds_out_same_position(tmp_path, monkeypatch):
    import json

    from app.hint_studio import private_references

    file = tmp_path / "refs.json"
    file.write_text(json.dumps([
        {"kind": "handwritten_hint", "text": "Target hint", "source": "target", "san": "Nf3", "piece": "n", "occurrences": [{"positionKey": "same"}]},
        {"kind": "handwritten_hint", "text": "Another hint", "source": "other", "san": "Nf3", "piece": "n", "occurrences": [{"positionKey": "different"}]},
        {"kind": "style_prose", "text": "A commentary", "source": "private PGN"},
    ]))
    file.chmod(0o600)
    monkeypatch.setenv("HINT_REFERENCE_FILE", str(file))
    refs = private_references({"position_key": "same", "answer": {"san": "Nf3", "piece": "n"}})
    assert [r["source"] for r in refs] == ["other", "private PGN"]


def test_endpoint_rejects_anonymous_cross_origin_and_stale_revision(monkeypatch):
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    from app.hint_studio import dispatch

    app = FastAPI()
    state = {"authenticated": False}
    async def upstream(_request, path):
        if path == "session":
            return {"authenticated": state["authenticated"], "user": {"id": "author", "roles": ["superadmin"]}, "csrfToken": "token"}
        return {"draft": {**DRAFT, "revision": 2, "revisionHash": "fresh"}}
    @app.post("/hint")
    async def hint(request: Request):
        return await dispatch(request, upstream, {"https://ggm.example"})
    client = TestClient(app)
    payload = {"courseID": "course", "revision": 1, "revisionHash": "stale", "chapterID": None,
               "moves": [], "answer": "e2e4", "rating": 1500}
    headers = {"origin": "https://ggm.example", "x-csrf-token": "token"}
    assert client.post("/hint", json=payload, headers=headers).status_code == 401
    state["authenticated"] = True
    assert client.post("/hint", json=payload, headers={**headers, "origin": "https://evil.example"}).status_code == 403
    assert client.post("/hint", json=payload, headers={**headers, "x-csrf-token": "wrong"}).status_code == 403
    assert client.post("/hint", json=payload, headers=headers).status_code == 409


def test_review_cannot_apply_unapproved_and_logs_apply_intent(tmp_path):
    import json
    import sqlite3

    from app.hint_studio import schema, update_review

    db = tmp_path / "review.sqlite"
    record = {"id": "r", "version": 1, "revisionHash": "h", "chapterID": None, "moves": [], "answer": "e2e4",
              "candidates": [{"id": "c", "text": "Think of development", "rating": 0, "status": "draft"}]}
    with sqlite3.connect(db) as conn:
        schema(conn)
        conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)", ("r", "course", 1, "a", json.dumps(record)))
    payload = {"reviewID": "r", "candidateID": "c", "version": 1, "operation": "apply"}
    with pytest.raises(HTTPException) as error:
        update_review(db, payload, "reviewer", "course", 1, "h", None, [], "e2e4")
    assert error.value.status_code == 409
    approved = json.loads(update_review(db, {**payload, "operation": "approve"}, "reviewer", "course", 1, "h", None, [], "e2e4").body)
    update_review(db, {**payload, "version": approved["version"]}, "reviewer", "course", 1, "h", None, [], "e2e4")
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT action FROM hint_review_events ORDER BY version").fetchall() == [("approve",), ("apply_intent",)]


def test_generation_retry_returns_same_review_without_second_call(tmp_path, monkeypatch):
    import uuid

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    import app.hint_studio as studio

    monkeypatch.setenv("HINT_REVIEW_DB", str(tmp_path / "reviews.sqlite"))
    calls = []
    monkeypatch.setattr(studio, "analyze_hint", lambda *args: {"position_key": "key", "answer": {"san": "e4", "uci": "e2e4", "piece": "p"}})
    monkeypatch.setattr(studio, "private_references", lambda *_: [{"kind": "handwritten_hint", "source": "fixture", "text": "Think"}])
    def generate(*_):
        calls.append(1)
        return {"candidates": ["candidate one", "candidate two", "candidate three"], "model": "fixture"}
    monkeypatch.setattr(studio, "generate_hints", generate)
    async def upstream(_request, path):
        if path == "session":
            return {"authenticated": True, "user": {"id": "author", "roles": ["superadmin"]}, "csrfToken": "token"}
        return {"draft": {**DRAFT, "revision": 2, "revisionHash": "fresh"}}
    app = FastAPI()
    @app.post("/hint")
    async def hint(request: Request):
        return await studio.dispatch(request, upstream, {"https://ggm.example"})
    client = TestClient(app)
    payload = {"courseID": "course", "revision": 2, "revisionHash": "fresh", "chapterID": None,
               "moves": [], "answer": "e2e4", "rating": 1500, "requestID": str(uuid.uuid4())}
    headers = {"origin": "https://ggm.example", "x-csrf-token": "token"}
    first = client.post("/hint", json=payload, headers=headers)
    again = client.post("/hint", json=payload, headers=headers)
    assert first.status_code == again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert len(calls) == 1
    conflict = client.post("/hint", json={**payload, "rating": 1600}, headers=headers)
    assert conflict.status_code == 409


def test_review_storage_requires_private_permissions(tmp_path, monkeypatch):
    from app.hint_studio import review_db

    db = tmp_path / "review.sqlite"
    monkeypatch.setenv("HINT_REVIEW_DB", str(db))
    assert review_db() == db
    assert db.stat().st_mode & 0o077 == 0
    db.chmod(0o644)
    with pytest.raises(HTTPException) as denied:
        review_db()
    assert denied.value.status_code == 503
