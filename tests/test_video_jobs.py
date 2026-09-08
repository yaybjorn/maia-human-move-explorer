import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.video_jobs import JobError, JobStore, canonical_source

COURSE = "course-one"
URL = "https://www.youtube.com/watch?v=8y9gWaB8zk4"
BASE = f"/studio/api/courses/{COURSE}/extractions"
HEADERS = {"Origin": "https://ggm.fablelabs.no", "X-CSRF-Token": "test-csrf"}
FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"


@pytest.fixture
def client(tmp_path, monkeypatch):
    state = {"authenticated": True, "user": {"id": "author-one", "roles": ["superadmin"]},
             "csrfToken": "test-csrf", "revision": 4}
    metadata = {"courseVideo": {"id": "main-video", "title": "Main", "youtubeURL": URL},
                "videos": [{"id": "extra", "title": "Extra", "youtubeURL": URL + "&t=30"}]}

    async def upstream(_request, path):
        if path == "session":
            return state
        assert path.startswith("courses/")
        return {"course": {"id": path.split("/")[1]},
                "draft": {"revision": state["revision"],
                          "document": {"metadata": metadata, "sourcePGN": "1. e4 e5 *"}}}

    monkeypatch.setenv("STUDIO_VIDEO_EXTRACTION_ENABLED", "1")
    monkeypatch.setenv("STUDIO_VIDEO_JOBS_DIR", str(tmp_path))
    monkeypatch.setattr("app.main.studio_authenticated_read", upstream)
    monkeypatch.setattr("app.main.kick_worker", lambda: None)
    monkeypatch.setattr("app.video_jobs_api.kick_worker", lambda: None)
    c = TestClient(app)
    c.state = state
    c.metadata = metadata
    c.root = tmp_path
    return c


def create(client, request_id="request-one", source=None):
    return client.post(BASE, headers=HEADERS, json={"revision": 4, "requestID": request_id,
                       "source": source or {"youtubeURL": URL, "videoRole": "main", "attachmentID": "main-video"}})


def complete(client, job):
    store = JobStore(client.root)
    out = store.directory(job["id"]) / "results"
    out.mkdir()
    rows = [{"first_seen_seconds": 10, "last_seen_seconds": 11, "fen": FEN,
             "observations": 2, "flagged_observations": 0, "orientation": "normal", "flags": []},
            {"first_seen_seconds": 20, "last_seen_seconds": 20, "fen": FEN,
             "observations": 1, "flagged_observations": 1, "orientation": "unknown", "flags": ["unknown_orientation"]},
            {"first_seen_seconds": 30, "last_seen_seconds": 32, "fen": FEN,
             "observations": 3, "flagged_observations": 0, "orientation": "flipped", "flags": []}]
    (out / "segments.json").write_text(json.dumps(rows))
    observations = [{"timestamp_seconds": 10, "boards": [{"fen": FEN, "orientation": "normal"}], "flags": []},
                    {"timestamp_seconds": 12, "boards": [], "flags": ["board_count_0"]},
                    {"timestamp_seconds": 13, "boards": [{"fen": FEN}, {"fen": FEN}], "flags": ["board_count_2"]}]
    (out / "observations.jsonl").write_text("\n".join(json.dumps(x) for x in observations))
    for name in ("positions-screened-draft.csv", "positions-changes.csv", "positions.csv"):
        (out / name).write_text(f"timestamp_seconds;fen\n10;{FEN}\n30;{FEN}\n")
    store.update(job["id"], status="completed", progress=1)
    return f"{BASE}/{job['id']}"


def test_auth_origin_csrf_and_role_are_required(client):
    client.state["authenticated"] = False
    assert client.get(BASE).status_code == 401
    client.state["authenticated"] = True
    client.state["user"]["roles"] = []
    assert client.get(BASE).status_code == 403
    client.state["user"]["roles"] = ["superadmin"]
    payload = {"revision": 4, "requestID": "request-one", "source": {"youtubeURL": URL}}
    assert client.post(BASE, json=payload).status_code == 403
    assert client.post(BASE, headers={**HEADERS, "Origin": "https://evil.invalid"}, json=payload).status_code == 403
    assert client.post(BASE, headers={**HEADERS, "X-CSRF-Token": "wrong"}, json=payload).status_code == 403
    assert not list(client.root.glob("jobs.sqlite3"))


def test_create_idempotency_revision_and_attached_video_integrity(client):
    first = create(client)
    assert first.status_code == 202
    job = first.json()["job"]
    assert create(client).json()["job"]["id"] == job["id"]
    assert "owner" not in job
    assert job["source"]["videoRole"] == "main"
    assert job["source"]["videoID"] == "8y9gWaB8zk4"
    assert create(client, source={"youtubeURL": URL, "videoRole": "supplemental", "attachmentID": "main-video"}).status_code == 409
    client.state["revision"] = 5
    assert create(client).status_code == 409
    assert client.get(BASE).json()["jobs"][0]["stale"] is True


def test_ownership_isolation_and_no_foreign_download_or_mutation(client):
    job = create(client).json()["job"]
    url = complete(client, job)
    client.state["user"]["id"] = "author-two"
    assert client.get(BASE).json()["jobs"] == []
    for path in [url, url + "/results", url + "/download", url + "/evidence"]:
        assert client.get(path).status_code == 404
    assert client.post(url + "/cancel", headers=HEADERS, json={"revision": 4}).status_code == 404
    client.state["user"]["id"] = "author-one"
    assert client.get(url.replace(COURSE, "different-course")).status_code == 404


def test_uncertainty_revisits_review_revision_and_csv(client):
    url = complete(client, create(client).json()["job"])
    screened = client.get(url + "/results?kind=screened").json()["rows"]
    assert [row["id"] for row in screened] == ["segment-0", "segment-2"]
    assert screened[0]["fen"] == screened[1]["fen"]
    changes = client.get(url + "/results?kind=changes").json()["rows"]
    assert len(changes) == 3
    raw = client.get(url + "/results?kind=raw").json()["rows"]
    assert raw[1]["fen"] is None and raw[1]["flags"]
    assert raw[2]["fen"] is None and len(raw[2]["boards"]) == 2
    payload = {"revision": 4, "reviewRevision": 0,
               "decisions": [{"rowID": "segment-2", "decision": "accepted"}]}
    assert client.post(url + "/review", headers=HEADERS, json=payload).status_code == 200
    assert client.post(url + "/review", headers=HEADERS, json=payload).status_code == 409
    csv = client.get(url + "/download?kind=reviewed")
    assert csv.status_code == 200
    assert csv.text == f"timestamp_seconds;fen\n30;{FEN}\n"
    assert csv.headers["cache-control"] == "no-store"
    client.state["revision"] = 5
    payload.update(revision=5, reviewRevision=1)
    assert client.post(url + "/review", headers=HEADERS, json=payload).status_code == 409
    assert client.get(url + "/download?kind=screened").status_code == 200
    assert client.get(url + "/results?offset=-1").status_code == 422


@pytest.mark.parametrize("url", ["https://youtube.com.evil.invalid/watch?v=8y9gWaB8zk4",
                                  "file:///tmp/movie.mp4", "http://127.0.0.1/movie",
                                  "https://youtube.com:8443/watch?v=8y9gWaB8zk4",
                                  "https://name:password@youtube.com/watch?v=8y9gWaB8zk4",
                                  "https://youtube.com/playlist?list=xyz"])
def test_sources_are_specific_youtube_only(url):
    with pytest.raises(JobError):
        canonical_source({"youtubeURL": url}, {})


def test_durable_queue_claim_cancel_and_restart(client):
    job = create(client).json()["job"]
    reloaded = JobStore(client.root)
    assert reloaded.get(job["id"])["status"] == "queued"
    assert reloaded.claim()["id"] == job["id"]
    assert reloaded.claim() is None
    reloaded.recover_interrupted()
    assert reloaded.get(job["id"])["status"] == "failed"
    second = create(client, "request-two").json()["job"]
    assert client.post(f"{BASE}/{second['id']}/cancel", headers=HEADERS,
                       json={"revision": 4}).json()["job"]["status"] == "cancelled"
    assert reloaded.claim() is None


def test_queue_and_request_bounds(client):
    assert create(client).status_code == 202
    assert create(client, "request-two").status_code == 202
    assert create(client, "request-three").status_code == 429
    assert client.post(BASE, headers=HEADERS, content='[').status_code == 422
    assert client.post(BASE, headers=HEADERS, json={"revision": True}).status_code == 409


def test_public_source_offer_resolves_exact_deployed_revision():
    client = TestClient(app)
    response = client.get("/studio/api/source", follow_redirects=False)
    assert response.status_code == 303
    assert len(response.headers["location"].split("/")[-1]) == 40
    assert "github.com/yaybjorn/maia-human-move-explorer/tree/" in response.headers["location"]
    assert client.post("/studio/api/source").status_code == 405
