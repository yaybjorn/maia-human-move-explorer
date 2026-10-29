from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.beyond_basics_review import REVIEWER_IDS, dispatch


def test_private_review_access_and_ranges(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("private sample")
    (tmp_path / "106399420.mp4").write_bytes(b"0123456789")
    monkeypatch.setenv("BEYOND_BASICS_REVIEW_DIR", str(tmp_path))
    app = FastAPI()
    session = {"authenticated": False}

    async def upstream(_request, _path):
        return session

    @app.api_route("/studio/api/{path:path}", methods=["GET", "POST"])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)

    client = TestClient(app)
    base = "/studio/api/beyond-basics/unit1-sample-v1/"
    assert client.get(base + "index.html").status_code == 401
    session.update(authenticated=True, user={"id": "unrelated"})
    assert client.get(base + "index.html").status_code == 403
    assert client.get(base + "106399420.mp4").status_code == 403
    session["user"]["id"] = next(iter(REVIEWER_IDS))
    assert client.get(base + "index.html").status_code == 403
    session["user"]["roles"] = ["superadmin"]
    response = client.get(base + "index.html")
    assert response.text == "private sample"
    assert response.headers["cache-control"] == "private, no-store"
    partial = client.get(base + "106399420.mp4", headers={"Range": "bytes=2-5"})
    assert partial.status_code == 206 and partial.content == b"2345"
    assert partial.headers["content-range"] == "bytes 2-5/10"
    assert client.get(base + "106399420.mp4", headers={"Range": "bytes=99-100"}).status_code == 416
    download = client.get(base + "download.mp4")
    assert download.content == b"0123456789"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert client.get(base + "%2e%2e%2findex.html").status_code == 404
    assert client.post(base + "index.html").status_code == 404
    assert client.get(base + "index.html?x=1").status_code == 404
    (tmp_path / "index.html").unlink()
    (tmp_path / "index.html").symlink_to(tmp_path / "106399420.mp4")
    assert client.get(base + "index.html").status_code == 404
