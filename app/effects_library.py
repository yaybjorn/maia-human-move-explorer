"""Durable, authenticated Recording effects stored outside atomic releases."""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse

MAX_BYTES = 25 * 1024 * 1024
MAX_DURATION = 60
MAX_DIMENSION = 2048
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow, noarchive"}
ID = re.compile(r"^[a-f0-9-]{36}$")


def root() -> Path:
    path = Path(os.getenv("STUDIO_EFFECTS_DIR", "/opt/maia-human-move-explorer/cache/recording-effects"))
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def is_effect_path(path: str) -> bool:
    return path == "effects" or bool(re.fullmatch(r"effects/[a-f0-9-]{36}(?:/media)?", path))


def load_index() -> list[dict]:
    path = root() / "index.json"
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []
    except (ValueError, OSError):
        raise HTTPException(503, "Effects library is temporarily unavailable") from None


def save_index(value: list[dict]):
    path = root() / "index.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")))
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def public(item: dict) -> dict:
    return {"id": item["id"], "name": item["name"], "durationMilliseconds": item["durationMilliseconds"], "url": f"/studio/api/effects/{item['id']}/media"}


async def require_author(request, upstream_read, allowed_origins, *, mutation=False):
    session = await upstream_read(request, "session")
    if not session.get("authenticated"):
        raise HTTPException(401, "Sign in to Course Studio")
    if "superadmin" not in (session.get("user") or {}).get("roles", []):
        raise HTTPException(403, "Course Studio access required")
    if mutation:
        if request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Cross-origin mutations are forbidden")
        token = request.headers.get("x-csrf-token", "")
        if not token or token != session.get("csrfToken"):
            raise HTTPException(403, "Studio security token expired")
    return session


def valid_name(value) -> str:
    value = str(value or "").strip()
    if not 1 <= len(value) <= 80 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, "Effect name must be 1–80 printable characters")
    return value


def inspect_and_normalize(source: Path, target: Path) -> int:
    """Decode untrusted input then create browser-safe VP9 alpha WebM."""
    try:
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)], capture_output=True, text=True, timeout=20, check=True)
        info = json.loads(probe.stdout)
        streams = info.get("streams", [])
        videos = [stream for stream in streams if stream.get("codec_type") == "video"]
        duration = float(info.get("format", {}).get("duration") or 0)
        if len(videos) != 1 or len(streams) != 1 or not 0 < duration <= MAX_DURATION or not 0 < int(videos[0].get("width", 0)) <= MAX_DIMENSION or not 0 < int(videos[0].get("height", 0)) <= MAX_DIMENSION:
            raise ValueError()
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(source), "-map", "0:v:0", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-deadline", "good", "-crf", "32", "-b:v", "0", str(target)], capture_output=True, timeout=90, check=True)
        if not target.exists() or target.stat().st_size > MAX_BYTES:
            raise ValueError()
        return round(duration * 1000)
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
        target.unlink(missing_ok=True)
        raise HTTPException(422, "Use a single silent WebM video up to 60 seconds and 25 MB") from None


async def dispatch(path, request, upstream_read, allowed_origins):
    parts = path.split("/")
    is_media = len(parts) == 3 and parts[2] == "media"
    mutation = request.method in {"POST", "PUT", "DELETE"}
    await require_author(request, upstream_read, allowed_origins, mutation=mutation)
    index = load_index()
    if path == "effects" and request.method == "GET":
        return JSONResponse({"effects": [public(item) for item in index]}, headers=HEADERS)
    if is_media and request.method == "GET":
        item = next((item for item in index if item["id"] == parts[1]), None)
        file = root() / f"{parts[1]}.webm"
        if not item or not file.is_file(): raise HTTPException(404, "Effect not found")
        return FileResponse(file, media_type="video/webm", headers={**HEADERS, "Cache-Control": "private, max-age=60"})
    if path == "effects" and request.method == "POST":
        name = valid_name(request.headers.get("x-effect-name"))
        if request.headers.get("content-type", "").split(";", 1)[0] not in {"video/webm", "application/octet-stream"}:
            raise HTTPException(422, "Choose a WebM effect")
        effect_id, folder = str(uuid.uuid4()), root()
        with tempfile.NamedTemporaryFile(dir=folder, suffix=".webm", delete=False) as temporary:
            source = Path(temporary.name); total = 0
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BYTES: source.unlink(missing_ok=True); raise HTTPException(413, "Effects are limited to 25 MB")
                temporary.write(chunk)
        target = folder / f"{effect_id}.webm"
        try: duration = await asyncio.to_thread(inspect_and_normalize, source, target)
        finally: source.unlink(missing_ok=True)
        item = {"id": effect_id, "name": name, "durationMilliseconds": duration, "createdAt": time.time()}
        save_index([*index, item])
        return JSONResponse({"effect": public(item)}, status_code=201, headers=HEADERS)
    if len(parts) != 2 or not ID.fullmatch(parts[1]): raise HTTPException(404, "Effect not found")
    item = next((item for item in index if item["id"] == parts[1]), None)
    if not item: raise HTTPException(404, "Effect not found")
    if request.method == "DELETE":
        save_index([candidate for candidate in index if candidate["id"] != item["id"]])
        (root() / f"{item['id']}.webm").unlink(missing_ok=True)
        return JSONResponse({}, status_code=204, headers=HEADERS)
    if request.method == "PUT":
        content_type = request.headers.get("content-type", "")
        if content_type.startswith("application/json"):
            try: item["name"] = valid_name((await request.json()).get("name"))
            except ValueError: raise HTTPException(422, "Invalid effect name") from None
            save_index(index); return JSONResponse({"effect": public(item)}, headers=HEADERS)
        if content_type.split(";", 1)[0] not in {"video/webm", "application/octet-stream"}:
            raise HTTPException(422, "Choose a replacement WebM effect")
        temporary = root() / f".{item['id']}.incoming.webm"; total = 0
        with temporary.open("wb") as stream:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BYTES: temporary.unlink(missing_ok=True); raise HTTPException(413, "Effects are limited to 25 MB")
                stream.write(chunk)
        target = root() / f".{item['id']}.normalized.webm"
        try: item["durationMilliseconds"] = await asyncio.to_thread(inspect_and_normalize, temporary, target); target.replace(root() / f"{item['id']}.webm")
        finally: temporary.unlink(missing_ok=True); target.unlink(missing_ok=True)
        save_index(index); return JSONResponse({"effect": public(item)}, headers=HEADERS)
    raise HTTPException(405, "Method not allowed")
