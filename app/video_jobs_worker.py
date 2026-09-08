"""Single, low-priority private extraction worker, launched outside HTTP requests."""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import json
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .video_jobs import MAX_SOURCE_BYTES, MAX_STORE_BYTES, JobError, JobStore
from .video_ocr.runtime import MIN_FREE_BYTES as ENGINE_MIN_FREE_BYTES

# A shared-core host may take longer than the source duration; match the engine guard.
PROCESSING_LIMIT_SECONDS = 6 * 3600
ACQUISITION_RESERVE_BYTES = 32 * 1024**2


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class AcquiredSource:
    path: Path
    provenance: dict


def required_range(job):
    interval = job.get("source", {}).get("range")
    try:
        start, end = interval["startSeconds"], interval["endSeconds"]
        valid = (type(start) in (int, float) and type(end) in (int, float)
                 and 0 <= start < end <= 10800 and math.isfinite(start) and math.isfinite(end))
    except (TypeError, KeyError):
        valid = False
    if not valid:
        raise JobError(422, "Select an explicit finite start and end; unbounded jobs cannot run")
    return float(start), float(end)


def acquisition_budget(store):
    store.check_capacity()
    free = shutil.disk_usage(store.root).free
    used = sum(p.stat().st_size for p in store.root.rglob("*") if p.is_file())
    limit = min(MAX_SOURCE_BYTES, free - ENGINE_MIN_FREE_BYTES - ACQUISITION_RESERVE_BYTES,
                MAX_STORE_BYTES - used - ACQUISITION_RESERVE_BYTES)
    if limit < 1024**2:
        raise JobError(507, "Insufficient reserved storage for a bounded excerpt")
    return int(limit)


def check_worker_capacity(store, job_id=None, source_limit=None):
    # The parent queue process calls this throughout acquisition as well as OCR.
    # FFmpeg downloader hooks are completion-only and cannot be our disk guard.
    if shutil.disk_usage(store.root).free < ENGINE_MIN_FREE_BYTES + ACQUISITION_RESERVE_BYTES:
        raise JobError(507, "Extraction stopped before its reserved storage headroom was consumed")
    store.check_capacity()
    if job_id is not None and source_limit is not None:
        size = sum(p.stat().st_size for p in store.directory(job_id).glob("source.mp4*") if p.is_file())
        if size > source_limit:
            raise JobError(507, "The excerpt reached its reserved acquisition byte limit")


def cut_cached_source(source, destination, start, end, store, progress, cancelled, source_limit=MAX_SOURCE_BYTES):
    # Input -ss uses accurate decoder seek; re-encoding (not stream copy) discards
    # pre-roll before the requested start and normalizes the clip timeline.
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-threads", "1", "-ss", str(start), "-i", str(source),
               "-t", str(end - start), "-map", "0:v:0", "-an",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
               "-threads", "1", "-filter_threads", "1", "-pix_fmt", "yuv420p",
               "-fs", str(source_limit), "-y", str(destination)]
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        while child.poll() is None:
            if cancelled():
                raise JobError(409, "Extraction cancelled")
            check_worker_capacity(store)
            progress({"phase": "source-cache-cut", "progress": 0})
            time.sleep(0.5)
        if child.returncode:
            raise JobError(422, "The cached source could not supply the chosen interval")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def obtain_source(job: dict, store: JobStore, progress, cancelled) -> AcquiredSource:
    from .video_ocr.runtime import probe_video

    start, end = required_range(job)
    source_limit = acquisition_budget(store)
    progress({"phase": "source", "progress": 0, "sourceByteLimit": source_limit})
    # Only operator-seeded, hash-bound source caches are reused. Never accept a client path.
    cache = store.root / "sources"
    cache.mkdir(mode=0o700, exist_ok=True)
    video_id = job["source"]["videoID"]
    destination = store.directory(job["id"]) / "source.mp4"
    provenance = {"videoID": video_id, "originalURL": job["source"]["downloadURL"],
                  "range": {"startSeconds": start, "endSeconds": end},
                  "mediaKind": "accurately-cut-bounded-clip", "clipOffsetSeconds": start,
                  "cut": "accurate-seek-reencode", "sourceDurationSeconds": None,
                  "sourceByteLimit": source_limit, "reservedFreeBytes": ENGINE_MIN_FREE_BYTES + ACQUISITION_RESERVE_BYTES}
    manifest_path = cache / f"{video_id}.json"
    if manifest_path.is_file():
        info = json.loads(manifest_path.read_text())
        source = cache / f"{video_id}.mp4"
        if (source.is_file() and not source.is_symlink() and source.stat().st_size <= MAX_SOURCE_BYTES
                and info.get("videoID") == video_id and file_hash(source) == info.get("sha256")):
            metadata = probe_video(source)
            if end > metadata["duration_seconds"]:
                raise JobError(422, "The chosen end is beyond the source video duration")
            provenance.update({"acquisition": "operator-cache-section", "originalSourceSha256": info["sha256"],
                               "sourceDurationSeconds": metadata["duration_seconds"]})
            progress({"phase": "source-cache-cut", "progress": 0})
            cut_cached_source(source, destination, start, end, store, progress, cancelled, source_limit)
            return finish_acquisition(destination, provenance, store)
    import yt_dlp

    last_check = 0.0

    def hook(data):
        nonlocal last_check
        if cancelled():
            raise JobError(409, "Extraction cancelled")
        if data.get("downloaded_bytes", 0) > source_limit:
            raise JobError(413, "Video excerpt exceeds its reserved source byte limit")
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
        "socket_timeout": 20, "retries": 2,
        "fragment_retries": 2, "concurrent_fragment_downloads": 1,
        "cachedir": False, "restrictfilenames": True,
        "download_ranges": lambda *_: [{"start_time": start, "end_time": end}],
        "force_keyframes_at_cuts": True,
        "external_downloader_args": {"ffmpeg_i": ["-threads", "1"],
                                     "ffmpeg_o": ["-an", "-c:v", "libx264", "-preset", "veryfast",
                                                  "-crf", "18", "-threads", "1", "-filter_threads", "1",
                                                  "-pix_fmt", "yuv420p", "-fs", str(source_limit)]},
    }
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(job["source"]["downloadURL"], download=False)
            if (not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}
                    or info.get("id") != video_id or info.get("is_live")
                    or type(info.get("duration")) not in (int, float)
                    or not 0 < info["duration"] <= 10800 or not math.isfinite(info["duration"])
                    or info.get("section_start") or info.get("section_end")):
                raise JobError(422, "Use a finished YouTube video no longer than three hours")
            if end > info["duration"]:
                raise JobError(422, "The chosen end is beyond the source video duration")
            provenance.update({"acquisition": "youtube-section", "sourceDurationSeconds": info["duration"],
                               "sourceTitle": info.get("title", "")})
            # process_info alone bypasses the download_ranges expansion.
            # process_ie_result applies our single range and chooses FFmpeg;
            # force_keyframes_at_cuts prevents keyframe-rounded stream copies.
            downloader.process_ie_result(info, download=True)
    except JobError:
        raise
    except Exception as exc:
        raise JobError(422, "YouTube could not supply this excerpt. It may be unavailable, restricted, "
                       "or require a sign-in. No course data was changed.") from exc
    return finish_acquisition(destination, provenance, store)


def finish_acquisition(destination, provenance, store):
    from .video_ocr.runtime import probe_video

    if not destination.is_file() or not 0 < destination.stat().st_size <= provenance.get("sourceByteLimit", MAX_SOURCE_BYTES):
        raise JobError(422, "The excerpt download was incomplete or exceeded 350 MB")
    metadata = probe_video(destination)
    interval = provenance["range"]
    span = interval["endSeconds"] - interval["startSeconds"]
    if abs(metadata["duration_seconds"] - span) > 2 / metadata["fps"] + 0.001:
        raise JobError(422, "The acquired excerpt does not match the requested interval")
    check_worker_capacity(store)
    provenance.update({"clipSha256": file_hash(destination), "clipMetadata": metadata,
                       "cutFrameQuantizationSeconds": 1 / metadata["fps"]})
    # Retain source identity and the meaning of the hash after temporary media cleanup.
    (destination.parent / "acquisition.json").write_text(json.dumps(provenance, indent=2))
    return AcquiredSource(destination, provenance)


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
        store.update(job_id, phase="extracting", sourceHash=source.provenance["clipSha256"])
        summary = run_video(source.path, output, Path(os.environ["STUDIO_VIDEO_MODEL"]),
                            progress=progress, cancelled=cancelled,
                            source_range=job["source"]["range"], acquisition=source.provenance)
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


def supervise_child(child, store, current, started):
    cancelled = current.get("cancelRequested", False)
    phase, error = "timeout", "Extraction exceeded its processing time limit."
    stop = cancelled or time.monotonic() - started > PROCESSING_LIMIT_SECONDS
    if not stop:
        try:
            check_worker_capacity(store, current["id"], current.get("stats", {}).get("sourceByteLimit"))
        except JobError as exc:
            stop, phase, error = True, "storage-limit", str(exc)
    if not stop:
        return False
    # One process group includes the job, yt-dlp and its FFmpeg child. Wait for
    # the job process before marking terminal or allowing another queue claim.
    cleanup_job_group(child)
    store.update(current["id"], status="cancelled" if cancelled else "failed",
                 phase="cancelled" if cancelled else phase, error=None if cancelled else error)
    return True


def cleanup_job_group(child):
    # Also required after spontaneous job exit/OOM/SIGKILL: FFmpeg descendants
    # may still own the process group after Python has already been reaped.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def terminate_job_group(*_):
    # The job is the dedicated session/process-group leader. Parent death must
    # stop external FFmpeg too, not only Python and its in-process recognizer.
    os.killpg(os.getpgrp(), signal.SIGKILL)


def arm_parent_death_guard(parent_pid):
    if os.getpgrp() != os.getpid():
        raise RuntimeError("Video jobs must own an isolated process group")
    signal.signal(signal.SIGTERM, terminate_job_group)
    if ctypes.CDLL(None).prctl(1, signal.SIGTERM) != 0:  # PR_SET_PDEATHSIG
        raise RuntimeError("Could not arm video worker parent-death cleanup")
    if os.getppid() != parent_pid:
        terminate_job_group()  # parent may have exited before prctl was armed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--job")
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    if args.job:
        if sys.platform == "linux":
            arm_parent_death_guard(args.parent_pid)
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
            try:
                check_worker_capacity(store)
            except JobError as exc:
                store.update(job["id"], status="failed", phase="storage-limit", error=str(exc))
                continue
            child = subprocess.Popen([sys.executable, "-m", "app.video_jobs_worker",
                                      "--root", str(args.root), "--job", job["id"],
                                      "--parent-pid", str(os.getpid())],
                                     pass_fds=(lock.fileno(),), start_new_session=True)
            started = time.monotonic()
            try:
                while child.poll() is None:
                    current = store.get(job["id"])
                    if supervise_child(child, store, current, started):
                        break
                    time.sleep(1)
            finally:
                cleanup_job_group(child)
            if store.get(job["id"])["status"] == "running":
                store.update(job["id"], status="failed", phase="failed",
                             error="The extraction worker stopped. Start a new job to retry.")
            for path in store.directory(job["id"]).glob("source.mp4*"):
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
