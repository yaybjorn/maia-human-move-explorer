"""Default-off, bounded streaming Studio upload proxy. Never stages media on disk."""
import asyncio
import re

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response

UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
ROUTE = re.compile(rf"courses/{UUID}/offline-video/uploads(?:/({UUID})(?:/(operations)(?:/({UUID}))?)?)?")
MAX_CHUNK = 8 * 1024**2
MAX_RESPONSE = 128 * 1024
TOTAL_SECONDS = 100
IDLE_SECONDS = 30
MAX_ACTIVE = 4  # Per process, not a global platform quota.
_active = 0


def is_upload_path(path: str) -> bool:
    return "/offline-video/" in path


def failure(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


class UploadInputError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


async def proxy_upload(path: str, request: Request, *, enabled: bool, base: str,
                       secret: str, allowed_origins: set[str]) -> Response:
    global _active
    if not enabled:
        return failure(404, "studio_route_not_found")
    match = ROUTE.fullmatch(path)
    if not match or request.url.query:
        return failure(404, "studio_route_not_found")
    upload, operations, operation = match.groups()
    allowed = {"PUT"} if operation else {"GET", "POST"} if operations else {"GET"} if upload else {"POST"}
    if request.method not in allowed:
        return failure(405, "studio_method_not_allowed")
    if not secret or not base.startswith("https://"):
        return failure(503, "upload_unavailable")
    mutation = request.method != "GET"
    origin = request.headers.get("origin")
    if mutation and origin not in allowed_origins:
        return failure(403, "origin_forbidden")
    if not request.headers.get("cookie"):
        return failure(401, "unauthorized")
    if mutation and not request.headers.get("x-csrf-token"):
        return failure(403, "csrf_failed")
    # Worker remains authentication/ownership/paid-policy authority on EVERY request.
    headers = {"Accept": "application/json", "Accept-Encoding": "identity", "X-Studio-Proxy-Secret": secret,
               "User-Agent": "GingerGMCourseStudioProxy/1", "Cookie": request.headers["cookie"]}
    if mutation:
        headers["Origin"] = origin
        headers["X-CSRF-Token"] = request.headers["x-csrf-token"]
    if request.client:
        headers["X-Studio-Client-IP"] = request.client.host
    if request.headers.get("content-encoding") is not None:
        return failure(400, "invalid_request")
    length = request.headers.get("content-length")
    if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length)):
        return failure(400, "invalid_request")
    limit = 4096 if request.method == "POST" else 0
    if operation:
        fence = request.headers.get("x-upload-fence", "")
        if not re.fullmatch(r"[1-9][0-9]{0,2}", fence) or int(fence) > 600:
            return failure(400, "invalid_request")
        headers["X-Upload-Fence"] = fence
        content_range = request.headers.get("content-range")
        if content_range:
            part = re.fullmatch(r"bytes ([0-9]{1,10})-([0-9]{1,10})/([0-9]{1,10})", content_range)
            if not part or request.headers.get("content-type") != "application/octet-stream":
                return failure(400, "invalid_request")
            start, end, total = map(int, part.groups())
            if not (0 <= start <= end < total <= 2 * 1024**3 and end - start < MAX_CHUNK):
                return failure(400, "invalid_request")
            limit = end - start + 1
            if length != str(limit):
                return failure(400, "invalid_request")
            headers.update({"Content-Range": content_range, "Content-Type": "application/octet-stream"})
        elif length not in (None, "0"):
            return failure(400, "invalid_request")
    elif request.method == "POST":
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            return failure(400, "invalid_request")
        headers["Content-Type"] = "application/json"
    if length is not None:
        if int(length) > limit:
            return failure(413, "request_too_large")
        headers["Content-Length"] = length
    if _active >= MAX_ACTIVE:
        return failure(429, "upload_proxy_capacity")
    _active += 1  # No await between admission check/acquire.
    source = request.stream().__aiter__()
    input_error = None

    async def chunks():
        nonlocal input_error
        count = 0
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(anext(source), timeout=IDLE_SECONDS)
                except StopAsyncIteration:
                    break
                count += len(chunk)
                if count > limit:
                    raise UploadInputError(413, "request_too_large")
                # ASGI server owns receive chunks; forward with backpressure, no accumulation.
                if chunk:
                    yield chunk
            if length is not None and count != int(length):
                raise UploadInputError(400, "invalid_upload_length")
        except TimeoutError:
            input_error = UploadInputError(408, "media_stream_timeout")
            raise input_error from None
        except UploadInputError as exc:
            input_error = exc
            raise

    try:
        async with asyncio.timeout(TOTAL_SECONDS):
            if limit == 0:
                async for _ in chunks():
                    pass
                headers.pop("Content-Length", None)
            async with (
                httpx.AsyncClient(timeout=httpx.Timeout(70, connect=5, write=30, pool=5),
                                  follow_redirects=False, trust_env=False) as client,
                client.stream(request.method, f"{base}/{path}", headers=headers,
                              content=chunks() if limit else None) as response,
            ):
                if response.is_redirect:
                    return failure(502, "upload_upstream_redirect")
                if response.headers.get("content-encoding", "identity") != "identity":
                    return failure(502, "upload_upstream_encoding")
                payload = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(payload) + len(chunk) > MAX_RESPONSE:
                        return failure(502, "upload_upstream_response_too_large")
                    payload.extend(chunk)
                return Response(bytes(payload), status_code=response.status_code,
                                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                         "Content-Type": "application/json", "X-Robots-Tag": "noindex, nofollow, noarchive"})
    except UploadInputError as exc:
        return failure(exc.status, exc.code)
    except TimeoutError:
        return failure(408, "media_stream_timeout")
    except Exception:  # noqa: BLE001 — sanitize transport/stream ExceptionGroups at this trust boundary.
        if input_error:
            return failure(input_error.status, input_error.code)
        # Never serialize provider exceptions, headers, cookies or proxy credentials.
        return failure(503, "upload_unavailable")
    finally:
        _active -= 1
        await source.aclose()
