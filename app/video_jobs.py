"""Private, durable extraction artifacts; never a course/publication database."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .video_ocr import EXTRACTION_VERSION

ACTIVE = {"queued", "running"}
MAX_SOURCE_BYTES = 350 * 1024 * 1024
MIN_FREE_BYTES = 700 * 1024 * 1024
MAX_STORE_BYTES = 800 * 1024 * 1024


class JobError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def now() -> float:
    return time.time()


def canonical_source(candidate: dict, metadata: dict) -> dict:
    if not isinstance(candidate, dict):
        raise JobError(422, "Choose a YouTube video")
    role = candidate.get("videoRole", "external")
    if role not in {"main", "supplemental", "external"}:
        raise JobError(422, "Unknown video selection")
    attached = None
    if role == "main":
        attached = metadata.get("courseVideo")
    elif role == "supplemental":
        attached = next((v for v in metadata.get("videos", [])
                         if v.get("id") == candidate.get("attachmentID")), None)
    if role != "external" and (not attached or attached.get("id") != candidate.get("attachmentID")
                               or attached.get("youtubeURL") != candidate.get("youtubeURL")):
        raise JobError(409, "This attached video changed. Reload the course and select it again.")
    raw = candidate.get("youtubeURL")
    if not isinstance(raw, str) or len(raw) > 2048:
        raise JobError(422, "Use a specific YouTube video link")
    try:
        url = urlparse(raw.strip())
        host = (url.hostname or "").removeprefix("www.")
        parts = url.path.strip("/").split("/")
        video_id = (parts[0] if host == "youtu.be" else
                    parse_qs(url.query).get("v", [""])[0] if url.path == "/watch" else
                    parts[1] if len(parts) == 2 and parts[0] in {"live", "shorts", "embed"} else "")
        if (url.scheme not in {"https", "http"} or url.username or url.password or url.port
                or host not in {"youtube.com", "m.youtube.com", "youtu.be"}
                or not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id)):
            raise ValueError()
    except ValueError as exc:
        raise JobError(422, "Use a specific youtube.com or youtu.be video link") from exc
    return {
        "youtubeURL": raw.strip(), "downloadURL": f"https://www.youtube.com/watch?v={video_id}",
        "videoID": video_id, "videoRole": role,
        "attachmentID": attached.get("id") if attached else None,
        "title": attached.get("title", "YouTube video") if attached else "YouTube video",
    }


def source_stale(job: dict, revision: int, metadata: dict) -> bool:
    if job["revision"] != revision:
        return True
    try:
        return canonical_source(job["source"], metadata) != job["source"]
    except JobError:
        return True


class JobStore:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.root / "jobs.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, course TEXT NOT NULL,
                    request_id TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                    updated REAL NOT NULL, payload TEXT NOT NULL,
                    UNIQUE(owner, course, request_id)
                );
                CREATE INDEX IF NOT EXISTS jobs_course ON jobs(owner, course, created);
            """)

    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def directory(self, job_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            raise JobError(404, "Extraction not found")
        return self.root / job_id

    def get(self, job_id: str, owner: str | None = None, course: str | None = None) -> dict:
        self.directory(job_id)
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or (owner is not None and row["owner"] != owner) or (
                course is not None and row["course"] != course):
            raise JobError(404, "Extraction not found")
        return json.loads(row["payload"])

    def list(self, owner: str, course: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM jobs WHERE owner=? AND course=? "
                              "ORDER BY created DESC LIMIT 50", (owner, course)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def create(self, owner: str, course: str, revision: int, source: dict,
               request_id: str, source_pgn: str) -> dict:
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", request_id):
            raise JobError(422, "Missing extraction request identity")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM jobs WHERE owner=? AND course=? AND request_id=?",
                             (owner, course, request_id)).fetchone()
            if row:
                previous = json.loads(row[0])
                if previous["revision"] != revision or previous["source"] != source:
                    raise JobError(409, "This request identity belongs to a different extraction")
                return previous
            active = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
            own = db.execute("SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('queued','running')",
                             (owner,)).fetchone()[0]
            if active >= 8 or own >= 2:
                raise JobError(429, "The extraction queue is full. Finish or cancel a current job first.")
            self.check_capacity()
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "owner": owner, "courseID": course, "revision": revision,
                       "source": source, "sourcePGNHash": hashlib.sha256(source_pgn.encode()).hexdigest(),
                       "extractionVersion": EXTRACTION_VERSION, "status": "queued", "phase": "queued",
                       "progress": 0, "createdAt": now(), "updatedAt": now(), "error": None, "stats": {},
                       "reviewRevision": 0, "decisions": {}, "cancelRequested": False}
            self.directory(job_id).mkdir(mode=0o700)
            db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)",
                       (job_id, owner, course, request_id, "queued", job["createdAt"],
                        job["updatedAt"], json.dumps(job)))
            return job

    def check_capacity(self):
        if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
            raise JobError(507, "Video extraction storage is nearly full. No new job was started.")
        size = sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())
        if size > MAX_STORE_BYTES:
            raise JobError(507, "The extraction artifact store is full. Existing results remain available.")

    def update(self, job_id: str, **updates) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise JobError(404, "Extraction not found")
            job = json.loads(row[0])
            job.update(updates, updatedAt=now())
            db.execute("UPDATE jobs SET status=?,updated=?,payload=? WHERE id=?",
                       (job["status"], job["updatedAt"], json.dumps(job), job_id))
            return job

    def claim(self) -> dict | None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
            if not row:
                return None
            job = json.loads(row[0])
            job.update(status="running", phase="source", startedAt=now(), updatedAt=now())
            db.execute("UPDATE jobs SET status='running',updated=?,payload=? WHERE id=?",
                       (job["updatedAt"], json.dumps(job), job["id"]))
            return job

    def recover_interrupted(self):
        # Only called by the exclusive worker-lock holder; never interrupts a live worker.
        with self.connect() as db:
            rows = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
        for row in rows:
            self.update(row[0], status="failed", phase="interrupted",
                        error="Extraction was interrupted by a worker restart. Start a new job to retry.")

    def review(self, job_id: str, expected: int, decisions: list[dict], row_ids: set[str]) -> dict:
        if not isinstance(decisions, list) or not 1 <= len(decisions) <= 100:
            raise JobError(422, "Review between one and 100 positions at a time")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
            job = json.loads(row[0])
            if job["reviewRevision"] != expected:
                raise JobError(409, "The review changed in another tab. Reload this extraction.")
            if job["status"] != "completed":
                raise JobError(409, "Wait for the extraction to finish")
            for item in decisions:
                if not isinstance(item, dict) or item.get("rowID") not in row_ids or item.get("decision") not in {
                    "accepted", "rejected", "unreviewed"
                }:
                    raise JobError(422, "Unknown position or review decision")
                job["decisions"][item["rowID"]] = item["decision"]
            job.update(reviewRevision=expected + 1, updatedAt=now())
            db.execute("UPDATE jobs SET updated=?,payload=? WHERE id=?",
                       (job["updatedAt"], json.dumps(job), job_id))
            return job


def configured_root() -> Path:
    return Path(os.getenv("STUDIO_VIDEO_JOBS_DIR", "/opt/maia-human-move-explorer/cache/video-extractions"))


def kick_worker():
    if os.getenv("STUDIO_VIDEO_EXTRACTION_ENABLED") != "1":
        return
    root = configured_root()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Fast liveness check avoids repeated processes while the persistent worker owns its lock.
    with (root / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    # Child holds flock for its entire queue loop. Competing starters exit immediately.
    with (root / "worker.log").open("ab") as log:
        subprocess.Popen(
            [os.getenv("STUDIO_VIDEO_PYTHON", sys.executable), "-m", "app.video_jobs_worker",
             "--root", str(root)], cwd=Path(__file__).resolve().parents[1],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
            env={**{key: value for key, value in os.environ.items()
                    if key in {"PATH", "LANG", "STUDIO_VIDEO_MODEL", "STUDIO_VIDEO_PYTHON"}},
                 "PATH": os.getenv("STUDIO_VIDEO_BIN", "/usr/local/bin") + os.pathsep + os.getenv("PATH", "/usr/bin:/bin"),
                 "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"},
        )
