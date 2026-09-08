"""Single, low-priority private extraction worker, launched outside HTTP requests."""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path

from .video_jobs import MAX_SOURCE_BYTES, JobError, JobStore

# A shared-core host may take longer than the source duration; match the engine guard.
PROCESSING_LIMIT_SECONDS = 6 * 3600


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def obtain_source(job: dict, store: JobStore, progress, cancelled) -> Path:
    # Only operator-seeded, hash-bound source caches are reused. Never accept a client path.
    cache = store.root / "sources"
    cache.mkdir(mode=0o700, exist_ok=True)
    video_id = job["source"]["videoID"]
    manifest_path = cache / f"{video_id}.json"
    if manifest_path.is_file():
        info = json.loads(manifest_path.read_text())
        source = cache / f"{video_id}.mp4"
        if (source.is_file() and source.stat().st_size <= MAX_SOURCE_BYTES
                and info.get("videoID") == video_id and file_hash(source) == info.get("sha256")):
            progress({"phase": "source-cache", "progress": 0, "sourceHash": info["sha256"]})
            return source
    import yt_dlp

    destination = store.directory(job["id"]) / "source.mp4"
    last_check = 0.0

    def hook(data):
        nonlocal last_check
        if cancelled():
            raise JobError(409, "Extraction cancelled")
        if data.get("downloaded_bytes", 0) > MAX_SOURCE_BYTES:
            raise JobError(413, "Video exceeds the 350 MB source limit")
        if time.monotonic() - last_check > 2:
            store.check_capacity()
            last_check = time.monotonic()
            progress({"phase": "downloading", "progress": 0,
                      "downloadedBytes": data.get("downloaded_bytes", 0)})

    class QuietLogger:
        def debug(self, *_):
            pass
        def warning(self, *_):
            pass
        def error(self, *_):
            pass

    options = {
        "format": "bestvideo[height<=720][ext=mp4][vcodec^=avc1]/bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]",
        "js_runtimes": {"node": {}},
        "outtmpl": str(destination), "noplaylist": True, "quiet": True,
        "no_warnings": True, "logger": QuietLogger(), "progress_hooks": [hook],
        "max_filesize": MAX_SOURCE_BYTES, "socket_timeout": 20, "retries": 2,
        "fragment_retries": 2, "concurrent_fragment_downloads": 1,
        "cachedir": False, "restrictfilenames": True,
    }
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(job["source"]["downloadURL"], download=False)
            if (not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}
                    or info.get("id") != video_id or info.get("is_live")
                    or not isinstance(info.get("duration"), (int, float))
                    or not 0 < info["duration"] <= 10800):
                raise JobError(422, "Use a finished YouTube video no longer than three hours")
            downloader.process_info(info)
    except JobError:
        raise
    except Exception as exc:
        raise JobError(422, "YouTube could not supply this video. It may be unavailable, restricted, "
                       "or require a sign-in. No course data was changed.") from exc
    if not destination.is_file() or not 0 < destination.stat().st_size <= MAX_SOURCE_BYTES:
        raise JobError(422, "The source download was incomplete or exceeded 350 MB")
    return destination


def execute(job: dict, store: JobStore):
    from .video_ocr import VideoOCRError, run_video

    job_id = job["id"]
    output = store.directory(job_id) / "results"
    start = time.monotonic()
    last_update = 0.0

    def cancelled():
        return store.get(job_id).get("cancelRequested", False)

    def progress(values):
        nonlocal last_update
        if time.monotonic() - start > PROCESSING_LIMIT_SECONDS:
            raise JobError(408, "Extraction reached the six-hour processing limit")
        if time.monotonic() - last_update < 1 and values.get("phase") == "extracting":
            return
        store.check_capacity()
        last_update = time.monotonic()
        changes = {"phase": values.get("phase", "extracting"),
                   "progress": min(0.99, max(0, float(values.get("progress", 0)))),
                   "stats": {**store.get(job_id).get("stats", {}), **values}}
        store.update(job_id, **changes)

    try:
        store.check_capacity()
        source = obtain_source(job, store, progress, cancelled)
        store.update(job_id, phase="extracting", sourceHash=file_hash(source))
        summary = run_video(source, output, Path(os.environ["STUDIO_VIDEO_MODEL"]),
                            progress=progress, cancelled=cancelled)
        if cancelled():
            store.update(job_id, status="cancelled", phase="cancelled")
        else:
            store.update(job_id, status="completed", phase="completed", progress=1,
                         stats=summary, completedAt=time.time(), error=None)
    except (JobError, VideoOCRError) as exc:
        is_cancelled = cancelled() or getattr(exc, "code", "") == "cancelled"
        store.update(job_id, status="cancelled" if is_cancelled else "failed",
                     phase="cancelled" if is_cancelled else "failed", error=str(exc))
    except Exception:  # noqa: BLE001 - fail closed without leaking downloader details
        # Untrusted downloader/model messages may contain URLs. Do not leak raw traces to authors.
        store.update(job_id, status="failed", phase="failed",
                     error="Extraction could not finish. Your source and course data were not changed.")
    finally:
        for path in store.directory(job_id).glob("source.mp4*"):
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--job")
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    if args.job:
        if sys.platform == "linux":
            ctypes.CDLL(None).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
            if os.getppid() != args.parent_pid:
                return
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (450 * 1024**2, 450 * 1024**2))
        store = JobStore(args.root)
        execute(store.get(args.job), store)
        return
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        os.nice(12)
        # Bound each artifact and process; leave the interactive host its own CPU/memory.
        resource.setrlimit(resource.RLIMIT_FSIZE, (450 * 1024 * 1024, 450 * 1024 * 1024))
        if hasattr(os, "sched_setaffinity"):
            allowed = os.sched_getaffinity(0)
            if len(allowed) > 1:
                os.sched_setaffinity(0, {max(allowed)})
        store = JobStore(args.root)
        store.recover_interrupted()
        while True:
            job = store.claim()
            if job is None:
                time.sleep(2)
                continue
            child = subprocess.Popen([sys.executable, "-m", "app.video_jobs_worker",
                                      "--root", str(args.root), "--job", job["id"],
                                      "--parent-pid", str(os.getpid())],
                                     pass_fds=(lock.fileno(),), start_new_session=True)
            started = time.monotonic()
            while child.poll() is None:
                current = store.get(job["id"])
                if current.get("cancelRequested") or time.monotonic() - started > PROCESSING_LIMIT_SECONDS:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    cancelled = current.get("cancelRequested", False)
                    store.update(job["id"], status="cancelled" if cancelled else "failed",
                                 phase="cancelled" if cancelled else "timeout",
                                 error=None if cancelled else "Extraction exceeded its processing time limit.")
                    break
                time.sleep(1)
            if store.get(job["id"])["status"] == "running":
                store.update(job["id"], status="failed", phase="failed",
                             error="The extraction worker stopped. Start a new job to retry.")
            for path in store.directory(job["id"]).glob("source.mp4*"):
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
