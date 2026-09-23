"""Validate R2-staged chapter MP4s without storing video bytes on the Studio host.

Existing Studio session/role/CSRF applies throughout. Secret headers stay in
memory; durable state contains only ownership, decode outcomes and signed IDs.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import time
from pathlib import Path

import httpx
from fastapi import HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

MAX_BYTES = 2 * 1024**3
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
ROUTE = re.compile(r"courses/([a-f0-9-]{36})/chapter-media/([a-f0-9-]{36})(?:/(validate|download))?")
_tasks: dict[str, asyncio.Task] = {}
_capacity = asyncio.Semaphore(2)


def root() -> Path:
    path = Path(os.getenv("STUDIO_CHAPTER_MEDIA_DIR", "/opt/maia-human-move-explorer/cache/chapter-media"))
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def is_chapter_media_path(path):
    return bool(re.fullmatch(r"courses/[^/]+/chapter-media(?:/.*)?", path))


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def public(record):
    return {key: record[key] for key in ("id", "state", "error", "video") if key in record}


def sign_video(value, secret):
    payload = base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(secret.encode(), ("chapter-video-v1." + payload).encode(), hashlib.sha256).hexdigest()
    return {**value, "attestation": f"{payload}.{signature}"}


async def decode_stream(url, headers, *, probe=False):
    """Only R2's immutable completed object route is accepted; never user URLs."""
    args = (["ffprobe", "-v", "error", "-protocol_whitelist", "pipe", "-show_format", "-show_streams", "-of", "json", "pipe:0"]
            if probe else ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
                           "-protocol_whitelist", "pipe", "-threads", "1", "-i", "pipe:0",
                           "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"])
    process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                                                 stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    async def output():
        result = bytearray()
        while chunk := await process.stdout.read(65536):
            result.extend(chunk)
            if len(result) > 1024**2:
                raise ValueError("oversized metadata")
        return bytes(result)
    reader = asyncio.create_task(output())
    digest, count, closed = hashlib.sha256(), 0, False
    try:
        async with asyncio.timeout(3600):
            async with (httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), follow_redirects=False) as client,
                        client.stream("GET", url, headers=headers) as response):
                if response.status_code != 200:
                    raise ValueError("private upload unavailable")
                length = int(response.headers.get("content-length", "0"))
                if not 0 < length <= MAX_BYTES:
                    raise ValueError("invalid file size")
                async for chunk in response.aiter_bytes(65536):
                    count += len(chunk)
                    if count > length:
                        raise ValueError("size mismatch")
                    digest.update(chunk)
                    if not closed:
                        try:
                            process.stdin.write(chunk)
                            await asyncio.wait_for(process.stdin.drain(), 60)
                        except (BrokenPipeError, ConnectionResetError):
                            closed = True
                if count != length:
                    raise ValueError("truncated file")
            process.stdin.close()
            code = await process.wait()
            result = await reader
            if code != 0:
                raise ValueError("decode failed; fast-start MP4 required")
            return (json.loads(result) if probe else None), digest.hexdigest(), count
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)


async def validate_video(path, record, url, headers, secret):
    try:
        async with _capacity:
            info, probe_hash, probe_bytes = await decode_stream(url, headers, probe=True)
            streams = info.get("streams", [])
            videos = [s for s in streams if s.get("codec_type") == "video"]
            audios = [s for s in streams if s.get("codec_type") == "audio"]
            duration = float(info["format"].get("duration") or videos[0].get("duration") or 0)
            if ("mp4" not in info["format"]["format_name"].split(",") or len(videos) != 1
                    or videos[0].get("codec_name") != "h264" or len(audios) > 1
                    or any(s.get("codec_name") != "aac" for s in audios)
                    or len(streams) != len(videos) + len(audios)
                    or not 0 < duration <= 21600
                    or not 0 < videos[0].get("width", 0) <= 4096
                    or not 0 < videos[0].get("height", 0) <= 4096):
                raise ValueError("format")
            _, digest, size = await decode_stream(url, headers)
            if digest != probe_hash or size != probe_bytes:
                raise ValueError("object changed")
            video = {"schemaVersion": 1, "id": record["id"], "courseID": record["courseID"],
                     "chapterID": record["chapterID"], "byteLength": size, "sha256": digest,
                     "durationMilliseconds": round(duration * 1000), "mimeType": "video/mp4"}
            record.update(state="ready", video=sign_video(video, secret))
            record.pop("error", None)
    except (OSError, ValueError, KeyError, IndexError, TypeError, httpx.HTTPError, TimeoutError):
        record.update(state="failed", error="Validation could not finish. Use fast-start MP4 with H.264 video and optional AAC audio. Check your session, then retry validation or upload a corrected file.")
    finally:
        save(path, record)


async def dispatch(path, request, upstream_read, allowed_origins, secret, base):
    match = ROUTE.fullmatch(path)
    if not match or not secret or request.url.query:
        raise HTTPException(404, "Unknown chapter video operation")
    course_id, upload_id, action = match.groups()
    session = await upstream_read(request, "session")
    if not session.get("authenticated"):
        raise HTTPException(401, "Sign in to Course Studio")
    if "superadmin" not in (session.get("user") or {}).get("roles", []):
        raise HTTPException(403, "Course Studio access required")
    if request.method != "GET":
        if request.headers.get("origin") not in allowed_origins:
            raise HTTPException(403, "Cross-origin mutations are forbidden")
        token = request.headers.get("x-csrf-token", "")
        if not token or not hmac.compare_digest(token, session.get("csrfToken") or ""):
            raise HTTPException(403, "Studio security token expired")
    course = await upstream_read(request, f"courses/{course_id}")
    draft = course.get("draft", {})
    document = draft.get("document", draft)
    actor = session["user"]["id"]
    record_path = root() / f"{upload_id}.json"
    record = json.loads(record_path.read_text()) if record_path.exists() else None
    # Ready proof also lives in the revision-protected Worker draft. Loss of the
    # host's tiny status cache must not strand retained R2 bytes.
    if not record:
        for chapter in document.get("chapterSources", []):
            video = chapter.get("video") or {}
            if video.get("id") != upload_id:
                continue
            try:
                payload, signature = video["attestation"].split(".")
                expected = hmac.new(secret.encode(), ("chapter-video-v1." + payload).encode(), hashlib.sha256).hexdigest()
                signed = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
                if (not hmac.compare_digest(expected, signature) or signed["id"] != upload_id
                        or signed["courseID"] != course_id or signed["chapterID"] != chapter["id"]):
                    raise ValueError()
                record = {"id": upload_id, "actorID": actor, "courseID": course_id, "chapterID": chapter["id"],
                          "state": "ready", "video": {**signed, "attestation": video["attestation"]}}
            except (ValueError, KeyError, TypeError):
                raise HTTPException(409, "Saved video reference cannot be verified") from None
    if record and (record["courseID"] != course_id or (record["actorID"] != actor and action != "download")):
        raise HTTPException(404, "Video not found")
    url = f"{base}/courses/{course_id}/chapter-media/{upload_id}/video"
    headers = {"X-Studio-Proxy-Secret": secret, "Cookie": request.headers.get("cookie", ""),
               "Accept-Encoding": "identity"}
    if request.method == "POST" and action == "validate":
        if len(_tasks) > 1000:
            for key in [key for key, task in _tasks.items() if task.done()]:
                _tasks.pop(key)
        if sum(not task.done() for task in _tasks.values()) >= 4 and (upload_id not in _tasks or _tasks[upload_id].done()):
            raise HTTPException(429, "Video validation is busy; retry shortly")
        data = await bounded_json(request)
        chapter_id = data.get("chapterID")
        if (data.get("revision") != draft.get("revision")
                or not any(c["id"] == chapter_id for c in document.get("chapterSources", []))):
            raise HTTPException(409, "Save this chapter before validating its video")
        if record and record["chapterID"] != chapter_id:
            raise HTTPException(409, "This upload belongs to another chapter")
        if not record:
            record = {"id": upload_id, "actorID": actor, "courseID": course_id, "chapterID": chapter_id,
                      "state": "validating", "createdAt": time.time()}
        if record["state"] != "ready" and (upload_id not in _tasks or _tasks[upload_id].done()):
            record.update(state="validating")
            record.pop("error", None)
            save(record_path, record)
            _tasks[upload_id] = asyncio.create_task(validate_video(record_path, record.copy(), url, headers, secret))
        return JSONResponse(public(record), headers=HEADERS)
    if not record:
        raise HTTPException(404, "Video validation has not started")
    if request.method == "GET" and action is None:
        if record["state"] == "validating" and (upload_id not in _tasks or _tasks[upload_id].done()):
            record.update(state="failed", error="Validation was interrupted. Retry validation.")
        return JSONResponse(public(record), headers=HEADERS)
    if request.method == "GET" and action == "download" and record["state"] == "ready":
        client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), follow_redirects=False)
        response = await client.send(client.build_request("GET", url, headers=headers), stream=True)
        if response.status_code != 200:
            await response.aclose()
            await client.aclose()
            raise HTTPException(409, "Private video is temporarily unavailable")
        async def stream():
            try:
                async for chunk in response.aiter_bytes(65536):
                    yield chunk
            finally:
                await response.aclose()
                await client.aclose()
        return StreamingResponse(stream(), media_type="video/mp4", headers={**HEADERS,
            "Content-Length": str(record["video"]["byteLength"]), "Content-Disposition": f'attachment; filename="chapter-{upload_id}.mp4"'})
    raise HTTPException(405, "Unsupported chapter video operation")


async def bounded_json(request):
    data = bytearray()
    async with asyncio.timeout(15):
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 4096:
                raise HTTPException(413, "Request too large")
    try:
        value = json.loads(data)
        if not isinstance(value, dict):
            raise TypeError()
        return value
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, "Invalid chapter video request") from exc
