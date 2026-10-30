import json
import sqlite3

from fastapi.testclient import TestClient

from app import main

COURSE = "00000000-0000-4000-8000-000000000001"


def test_proxy_replaces_browser_token_and_reconciles_even_after_error(tmp_path, monkeypatch):
    db = tmp_path / "review.sqlite"
    monkeypatch.setenv("HINT_REVIEW_DB", str(db))
    monkeypatch.setattr(main, "STUDIO_PROXY_SECRET", "test-secret")
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://example.test"})
    prior = {"revision":1, "revisionHash":"before", "metadata":{"side":"white"}, "sourcePGN":"1. e4 *"}
    after = {"metadata":{"side":"white"}, "sourcePGN":"1. e4 {[%hint Saved manual]} *"}
    captured = {}
    async def read(_request, path):
        if path == "session":
            return {"authenticated":True, "user":{"id":"author", "email":"author@example.test", "roles":["superadmin"]}}
        if path == f"courses/{COURSE}":
            return {"draft":prior}
        if path.startswith(f"courses/{COURSE}/draft-receipts/"):
            return {"receiptID":captured["token"], "courseID":COURSE, "actorID":"author", "revision":2,
                    "revisionHash":"after", "document":after}
        raise AssertionError(path)
    def send(request):
        payload = json.loads(request.data)
        captured["token"] = payload["hintLearningSaveID"]
        # Simulate an error reported after the backend committed.
        return b'{"error":"late failure"}', 400, {"Content-Type":"application/json"}
    monkeypatch.setattr(main, "studio_authenticated_read", read)
    monkeypatch.setattr(main, "studio_upstream_request", send)
    client = TestClient(main.app)
    response = client.put(f"/studio/api/courses/{COURSE}/draft", headers={"origin":"https://example.test"},
                          json={"revision":1, "hintLearningSaveID":"browser-forgery", "document":after})
    assert response.status_code == 400
    assert captured["token"] != "browser-forgery"
    with sqlite3.connect(db) as conn:
        assert json.loads(conn.execute("SELECT record FROM hint_learning_examples").fetchone()[0])["text"] == "Saved manual"
    assert not main.studio_path_allowed(f"courses/{COURSE}/draft-receipts/{captured['token']}", "GET")


def test_definitive_failure_discarded_and_later_unrelated_save_succeeds(tmp_path, monkeypatch):
    from fastapi import HTTPException

    from app.hint_learning import pending_stages

    db = tmp_path / "review.sqlite"
    monkeypatch.setenv("HINT_REVIEW_DB", str(db))
    monkeypatch.setattr(main, "STUDIO_PROXY_SECRET", "test-secret")
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://example.test"})
    prior = {"revision":1, "revisionHash":"before", "metadata":{"side":"white"}, "sourcePGN":"1. e4 *"}
    async def read(_request, path):
        if path == "session":
            return {"authenticated":True, "user":{"id":"author", "email":"author@example.test"}}
        if "draft-receipts" in path:
            raise HTTPException(404)
        return {"draft":prior}
    monkeypatch.setattr(main, "studio_authenticated_read", read)
    monkeypatch.setattr(main, "studio_upstream_request", lambda _req: (b'{}', 400, {}))
    client = TestClient(main.app)
    for _ in range(105):
        assert client.put(f"/studio/api/courses/{COURSE}/draft", headers={"origin":"https://example.test"}, json={"revision":1}).status_code == 400
    assert pending_stages(db, COURSE) == []
    monkeypatch.setattr(main, "studio_upstream_request", lambda _req: (b'{}', 200, {}))
    assert client.put("/studio/api/courses/00000000-0000-4000-8000-000000000002/draft", headers={"origin":"https://example.test"}, json={"revision":1}).status_code == 200
