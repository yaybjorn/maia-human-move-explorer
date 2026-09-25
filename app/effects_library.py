"""Durable, authenticated Recording effects stored outside atomic releases."""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse

MAX_BYTES = 25 * 1024 * 1024
MAX_DURATION = 60
MAX_DIMENSION = 2048
TRANSCODE_CONCURRENCY = max(1, min(2, int(os.getenv("STUDIO_EFFECTS_TRANSCODE_CONCURRENCY", "1"))))
ENCODER_THREADS = max(1, min(4, int(os.getenv("STUDIO_EFFECTS_ENCODER_THREADS", "2"))))
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive"}
ID = re.compile(r"^[a-f0-9-]{36}$")
_process_mutation_lock = asyncio.Lock()
_transcode_admission = asyncio.Semaphore(TRANSCODE_CONCURRENCY)


def root() -> Path:
    path = Path(os.getenv("STUDIO_EFFECTS_DIR", "/opt/maia-human-move-explorer/cache/recording-effects"))
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def is_effect_path(path: str) -> bool:
    return path == "effects" or bool(re.fullmatch(r"effects/[a-f0-9-]{36}(?:/media)?", path))


def load_index() -> list[dict]:
    try:
        value = json.loads((root() / "index.json").read_text())
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []
    except (ValueError, OSError):
        raise HTTPException(503, "Effects library is temporarily unavailable") from None


def save_index(value: list[dict]):
    """Atomically install an index; the caller owns the mutation lock."""
    path = root() / "index.json"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".index-", suffix=".json", dir=root())
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, separators=(",", ":")); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _acquire_file_lock(folder: Path):
    handle = (folder / ".mutation.lock").open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    except BaseException:
        handle.close(); raise
    return handle


@asynccontextmanager
async def mutation_transaction():
    """Serialize complete file/index mutations across workers and processes."""
    async with _process_mutation_lock:
        handle = await asyncio.to_thread(_acquire_file_lock, root())
        try:
            yield
        finally:
            await asyncio.to_thread(handle.close)


def public(item: dict) -> dict:
    return {"id": item["id"], "name": item["name"], "durationMilliseconds": item["durationMilliseconds"], "url": f"/studio/api/effects/{item['id']}/media"}


async def require_author(request, upstream_read, allowed_origins, *, mutation=False):
    session = await upstream_read(request, "session")
    if not session.get("authenticated"): raise HTTPException(401, "Sign in to Course Studio")
    if "superadmin" not in (session.get("user") or {}).get("roles", []): raise HTTPException(403, "Course Studio access required")
    if mutation:
        if request.headers.get("origin") not in allowed_origins: raise HTTPException(403, "Cross-origin mutations are forbidden")
        if request.headers.get("x-csrf-token", "") != session.get("csrfToken"): raise HTTPException(403, "Studio security token expired")
    return session


def valid_name(value) -> str:
    value = str(value or "").strip()
    if not 1 <= len(value) <= 80 or any(ord(c) < 32 for c in value): raise HTTPException(422, "Effect name must be 1–80 printable characters")
    return value


def inspect_and_normalize(source: Path, target: Path) -> int:
    """Decode using alpha-capable libvpx VP9, then encode browser-safe alpha."""
    try:
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)], capture_output=True, text=True, timeout=20, check=True)
        info = json.loads(probe.stdout); streams = info.get("streams", []); videos = [x for x in streams if x.get("codec_type") == "video"]
        duration = float(info.get("format", {}).get("duration") or 0)
        if len(videos) != 1 or len(streams) != 1 or not 0 < duration <= MAX_DURATION or not 0 < int(videos[0].get("width", 0)) <= MAX_DIMENSION or not 0 < int(videos[0].get("height", 0)) <= MAX_DIMENSION: raise ValueError()
        # Native vp9 drops WebM alpha on this host; libvpx-vp9 retains it.
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-c:v", "libvpx-vp9", "-i", str(source), "-map", "0:v:0", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-threads", str(ENCODER_THREADS), "-deadline", "good", "-crf", "32", "-b:v", "0", str(target)], capture_output=True, timeout=90, check=True)
        if not target.exists() or target.stat().st_size > MAX_BYTES: raise ValueError()
        return round(duration * 1000)
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        target.unlink(missing_ok=True)
        raise HTTPException(422, "Use a single silent WebM video up to 60 seconds and 25 MB") from None


async def normalize_with_admission(source: Path, target: Path) -> int:
    async with _transcode_admission:
        # Cancelling the awaiting request does not cancel ``to_thread`` or its
        # FFmpeg child process.  Keep both the admission permit and the outer
        # mutation transaction until that worker has actually completed, so a
        # disconnect cannot admit another encode while the first is still live.
        worker = asyncio.create_task(asyncio.to_thread(inspect_and_normalize, source, target))
        cancelled = False
        while True:
            try:
                result = await asyncio.shield(worker)
                break
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError
        return result


def _temporary(folder: Path, suffix: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=".effects-", suffix=suffix, dir=folder); os.close(descriptor)
    return Path(name)


async def _stream_to(request, destination: Path):
    total = 0
    try:
        with destination.open("wb") as stream:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BYTES: raise HTTPException(413, "Effects are limited to 25 MB")
                stream.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True); raise


async def dispatch(path, request, upstream_read, allowed_origins):
    parts = path.split("/"); is_media = len(parts) == 3 and parts[2] == "media"; mutation = request.method in {"POST", "PUT", "DELETE"}
    await require_author(request, upstream_read, allowed_origins, mutation=mutation)
    if path == "effects" and request.method == "GET": return JSONResponse({"effects": [public(item) for item in load_index()]}, headers=HEADERS)
    if is_media and request.method == "GET":
        item = next((item for item in load_index() if item["id"] == parts[1]), None); file = root() / f"{parts[1]}.webm"
        if not item or not file.is_file(): raise HTTPException(404, "Effect not found")
        return FileResponse(file, media_type="video/webm", headers={**HEADERS, "Cache-Control": "private, max-age=60"})
    if path == "effects" and request.method == "POST":
        name = valid_name(request.headers.get("x-effect-name"))
        if request.headers.get("content-type", "").split(";", 1)[0] not in {"video/webm", "application/octet-stream"}: raise HTTPException(422, "Choose a WebM effect")
        async with mutation_transaction():
            folder, effect_id = root(), str(uuid.uuid4()); source, target = _temporary(folder, ".incoming.webm"), _temporary(folder, ".normalized.webm"); target.unlink()
            try:
                await _stream_to(request, source); duration = await normalize_with_admission(source, target)
                item = {"id": effect_id, "name": name, "durationMilliseconds": duration, "createdAt": time.time()}
                media = folder / f"{effect_id}.webm"
                target.replace(media)
                try: save_index([*load_index(), item])
                except BaseException: media.unlink(missing_ok=True); raise
                return JSONResponse({"effect": public(item)}, status_code=201, headers=HEADERS)
            finally: source.unlink(missing_ok=True); target.unlink(missing_ok=True)
    if len(parts) != 2 or not ID.fullmatch(parts[1]): raise HTTPException(404, "Effect not found")
    async with mutation_transaction():
        index = load_index(); item = next((candidate for candidate in index if candidate["id"] == parts[1]), None)
        if not item: raise HTTPException(404, "Effect not found")
        media = root() / f"{item['id']}.webm"
        if request.method == "DELETE":
            tombstone = _temporary(root(), ".delete.webm")
            try:
                media.replace(tombstone)
                save_index([candidate for candidate in index if candidate["id"] != item["id"]])
                try:
                    tombstone.unlink()
                except OSError as error:
                    # Restore both sides rather than leave an unreachable file.
                    save_index(index)
                    tombstone.replace(media)
                    raise HTTPException(503, "Effect deletion could not be completed") from error
            except BaseException:
                if tombstone.exists() and not media.exists(): tombstone.replace(media)
                raise
            return JSONResponse({}, status_code=204, headers=HEADERS)
        if request.method == "PUT":
            content_type = request.headers.get("content-type", "")
            if content_type.startswith("application/json"):
                try: renamed = {**item, "name": valid_name((await request.json()).get("name"))}
                except ValueError: raise HTTPException(422, "Invalid effect name") from None
                save_index([renamed if candidate["id"] == item["id"] else candidate for candidate in index]); return JSONResponse({"effect": public(renamed)}, headers=HEADERS)
            if content_type.split(";", 1)[0] not in {"video/webm", "application/octet-stream"}: raise HTTPException(422, "Choose a replacement WebM effect")
            source, target, backup = _temporary(root(), ".incoming.webm"), _temporary(root(), ".normalized.webm"), _temporary(root(), ".rollback.webm"); target.unlink(); backup.unlink()
            try:
                await _stream_to(request, source); duration = await normalize_with_admission(source, target); shutil.copyfile(media, backup); target.replace(media)
                replacement = {**item, "durationMilliseconds": duration}
                try: save_index([replacement if candidate["id"] == item["id"] else candidate for candidate in index])
                except BaseException: backup.replace(media); raise
                backup.unlink(missing_ok=True); return JSONResponse({"effect": public(replacement)}, headers=HEADERS)
            finally: source.unlink(missing_ok=True); target.unlink(missing_ok=True); backup.unlink(missing_ok=True)
    raise HTTPException(405, "Method not allowed")
