import asyncio
import hashlib
import json
import shutil
import subprocess
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import chapter_media as media

COURSE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UPLOAD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
PATH = f"courses/{COURSE}/chapter-media/{UPLOAD}"


def request(method="POST", body=None, csrf="token", origin="https://studio.test"):
    async def receive():
        return {"type": "http.request", "body": json.dumps(body or {"chapterID": "chapter", "revision": 2}).encode(), "more_body": False}
    headers = [(b"origin", origin.encode()), (b"x-csrf-token", csrf.encode())]
    return Request({"type": "http", "method": method, "path": "/" + PATH, "query_string": b"", "headers": headers}, receive)


async def upstream(_request, path):
    if path == "session":
        return {"authenticated": True, "csrfToken": "token", "user": {"id": "actor", "roles": ["superadmin"]}}
    return {"draft": {"revision": 2, "chapterSources": [{"id": "chapter"}]}}


def dispatch(path, req):
    return media.dispatch(path, req, upstream, {"https://studio.test"}, "test-secret", "https://worker.test/v1/studio")


@pytest.mark.parametrize("csrf,origin", [("", "https://studio.test"), ("wrong", "https://studio.test"), ("token", "https://attacker.test")])
def test_mutations_require_existing_csrf_and_origin(tmp_path, monkeypatch, csrf, origin):
    monkeypatch.setenv("STUDIO_CHAPTER_MEDIA_DIR", str(tmp_path))
    with pytest.raises(HTTPException) as error:
        asyncio.run(dispatch(PATH + "/validate", request(csrf=csrf, origin=origin)))
    assert error.value.status_code == 403
    assert list(tmp_path.iterdir()) == []


def test_stale_draft_or_missing_chapter_cannot_validate(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_CHAPTER_MEDIA_DIR", str(tmp_path))
    for data in ({"chapterID": "other", "revision": 2}, {"chapterID": "chapter", "revision": 1}):
        with pytest.raises(HTTPException) as error:
            asyncio.run(dispatch(PATH + "/validate", request(body=data)))
        assert error.value.status_code == 409


def test_interrupted_validation_has_explicit_retry_state_and_wrong_owner_denied(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_CHAPTER_MEDIA_DIR", str(tmp_path))
    record = {"id": UPLOAD, "courseID": COURSE, "chapterID": "chapter", "actorID": "actor", "state": "validating"}
    media.save(tmp_path / f"{UPLOAD}.json", record)
    response = asyncio.run(dispatch(PATH, request("GET")))
    assert json.loads(response.body)["state"] == "failed"
    media.save(tmp_path / f"{UPLOAD}.json", {**record, "actorID": "someone-else"})
    with pytest.raises(HTTPException) as error:
        asyncio.run(dispatch(PATH, request("GET")))
    assert error.value.status_code == 404


def test_real_ffmpeg_stream_decode_and_hash_without_video_disk_staging(tmp_path, monkeypatch):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg runtime not installed")
    fixture = tmp_path / "fixture.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(fixture)], check=True)
    data = fixture.read_bytes()
    class Response:
        status_code = 200
        def __init__(self):
            self.headers = {"content-length": str(len(data))}
        async def aiter_bytes(self, _size):
            for offset in range(0, len(data), 256):
                yield data[offset:offset + 256]
    class Client:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_args):
            pass
        @asynccontextmanager
        async def stream(self, *_args, **_kwargs):
            yield Response()
    monkeypatch.setattr(media.httpx, "AsyncClient", lambda **_kwargs: Client())
    info, digest, size = asyncio.run(media.decode_stream("https://worker.test/private", {}, probe=True))
    assert info["streams"][0]["codec_name"] == "h264"
    assert digest == hashlib.sha256(data).hexdigest()
    assert size == len(data)
    assert asyncio.run(media.decode_stream("https://worker.test/private", {}))[1:] == (digest, size)
    record = {"id": UPLOAD, "courseID": COURSE, "chapterID": "chapter", "actorID": "actor", "state": "validating"}
    path = tmp_path / "result.json"
    asyncio.run(media.validate_video(path, record, "https://worker.test/private", {}, "test-secret"))
    result = json.loads(path.read_text())
    assert result["state"] == "ready"
    assert result["video"]["sha256"] == digest
    assert result["video"]["attestation"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["fixture.mp4", "result.json"]


def test_failed_decode_never_marks_ready(tmp_path, monkeypatch):
    async def fail(*_args, **_kwargs):
        raise ValueError("corrupt")
    monkeypatch.setattr(media, "decode_stream", fail)
    record = {"id": UPLOAD, "state": "validating"}
    path = tmp_path / "result.json"
    asyncio.run(media.validate_video(path, record, "https://worker.test/private", {}, "test-secret"))
    assert json.loads(path.read_text())["state"] == "failed"
    assert "video" not in json.loads(path.read_text())


def test_ready_proof_recovers_from_saved_draft_when_host_status_cache_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_CHAPTER_MEDIA_DIR", str(tmp_path))
    video = media.sign_video({"schemaVersion": 1, "id": UPLOAD, "courseID": COURSE, "chapterID": "chapter", "byteLength": 1024, "sha256": "a" * 64, "durationMilliseconds": 1000, "mimeType": "video/mp4"}, "test-secret")
    async def saved(req, path):
        if path == "session":
            return await upstream(req, path)
        return {"draft": {"revision": 2, "chapterSources": [{"id": "chapter", "video": video}]}}
    response = asyncio.run(media.dispatch(PATH, request("GET"), saved, {"https://studio.test"}, "test-secret", "https://worker.test/v1/studio"))
    assert json.loads(response.body) == {"id": UPLOAD, "state": "ready", "video": video}
    assert list(tmp_path.iterdir()) == []
