"""Disabled-by-default, synthetic-only receiver. Never proxies caller credentials.

Only the existing Worker may admit runs or account evidence; this hop holds no
run state and cannot reset shared budgets. No author APIs are used.
"""

import asyncio
import json
import re
import threading
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

PREFIX = "/studio/api/runtime-proof"
LOG_PATH = PREFIX + "/redacted"
HOST = b"ggm.fablelabs.no"
UPSTREAM = (
    "https://gingergm-opening-drill-api.fablelabs.workers.dev"
    "/v1/runtime-proof-internal/received"
)
SCENARIOS = frozenset({
    "normal", "expired-once", "denied", "wrong-range", "short-body", "ignored-range",
    "ignored-range-nonzero", "redirect-same-origin", "redirect-same-origin-307",
    "redirect-same-origin-308", "redirect-cross-origin", "redirect-cross-origin-307",
    "redirect-cross-origin-308",
})
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ROUTE = re.compile(rf"{PREFIX}/({UUID})/([a-z0-9-]{{1,40}})/received")
UPSTREAM_ERRORS = frozenset({400, 403, 404, 429, 503})
# A timed-out thread keeps its slot until the socket has actually closed.
_UPSTREAM_SLOTS = threading.BoundedSemaphore(2)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_redacted_event(event: dict, proxy_secret: str) -> int:
    """Fixed destination and status-only response; no exceptions or values logged.

    No response body is read (zero-byte bound). No environment proxies, redirects,
    caller headers, cookies or automatic retries. Socket wait is capped at 2s.
    """
    if not proxy_secret or not _UPSTREAM_SLOTS.acquire(blocking=False):
        return 503
    try:
        request = Request(UPSTREAM, method="POST", data=json.dumps(
            event, ensure_ascii=True, separators=(",", ":")
        ).encode("ascii"), headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "GingerGMRuntimeProofReceiver/1",
            "X-Studio-Proxy-Secret": proxy_secret,
        })
        opener = build_opener(ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(request, timeout=2) as response:
                status = response.status
        except HTTPError as response:
            status = response.code
            response.close()
        return status if status == 204 or status in UPSTREAM_ERRORS else 503
    except Exception:  # noqa: BLE001 - transport failures must never expose request values
        # HTTP exceptions can include sensitive headers/response text. Never log
        # or propagate them to ASGI error middleware.
        return 503
    finally:
        _UPSTREAM_SLOTS.release()


class RuntimeProofReceiverMiddleware:
    def __init__(self, app, *, enabled=False, proxy_secret="", sender=post_redacted_event):
        self.app = app
        self.enabled = enabled is True
        self.proxy_secret = proxy_secret
        self.sender = sender

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith(PREFIX):
            await self.app(scope, receive, send)
            return
        # Uvicorn formats access entries from this mutable scope when sending
        # response.start. Preserve validation input privately, but sanitize the
        # server's original scope before *any* fixture outcome (including errors
        # and disabled/unknown routes). This does not sanitize upstream nginx;
        # ingress logging needs its own independently verified namespace policy.
        request_scope = dict(scope)
        scope["path"] = LOG_PATH
        scope["raw_path"] = LOG_PATH.encode("ascii")
        scope["query_string"] = b""
        status, content = await self._dispatch(request_scope, receive)
        body = content if scope.get("method") != "HEAD" else b""
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"text/plain; charset=utf-8"),
            (b"content-length", str(len(content)).encode("ascii")),
            (b"cache-control", b"private, no-store, no-transform"),
            (b"x-robots-tag", b"noindex, nofollow, noarchive"),
        ]})
        await send({"type": "http.response.body", "body": body})

    async def _dispatch(self, scope, receive):
        if not self.enabled:
            return 404, b""
        method = scope.get("method")
        headers = scope.get("headers", ())
        hosts = [value for key, value in headers if key.lower() == b"host"]
        if scope.get("scheme") != "https" or hosts != [HOST]:
            return 403, b""
        if method not in {"GET", "HEAD"}:
            return 405, b""
        path = scope["path"]
        if (scope.get("query_string") or "#" in path
                or scope.get("raw_path", path.encode()) != path.encode()):
            return 400, b""
        # Reject framed request bodies before reading. An unframed ASGI body is
        # also refused; never buffer or forward any bytes or drain long streams.
        if any(key.lower() == b"transfer-encoding" or
               (key.lower() == b"content-length" and value != b"0")
               for key, value in headers):
            return 400, b""
        try:
            message = await asyncio.wait_for(receive(), timeout=0.5)
        except Exception:  # noqa: BLE001 - ASGI disconnect/errors are intentionally opaque
            return 400, b""
        if (message.get("type") != "http.request" or message.get("body")
                or message.get("more_body")):
            return 400, b""
        auth = [value for key, value in headers if key.lower() == b"authorization"]
        if path == f"{PREFIX}/health":
            return (403, b"") if auth else (200, b"synthetic-runtime-fixture")
        match = ROUTE.fullmatch(path)
        if not match or match[2] not in SCENARIOS:
            return 404, b""
        run_id, scenario = match.groups()
        generation = None
        if len(auth) == 1 and len(auth[0]) < 100:
            marker = re.fullmatch(
                rb"Bearer offline-proof-synthetic-" + run_id.encode() + rb"-([1-9][0-9]{0,5})",
                auth[0],
            )
            if marker:
                generation = int(marker[1])
        event = {
            "runID": run_id, "scenario": scenario, "method": method,
            "authorizationPresent": bool(auth), "syntheticGeneration": generation,
            "invalidAuthorization": bool(auth) and generation is None,
        }
        if not self.proxy_secret:
            return 503, b""
        try:
            # Client-facing total deadline; no retry if the durable operation
            # committed after the deadline. Worker owns authoritative accounting.
            status = await asyncio.wait_for(
                asyncio.to_thread(self.sender, event, self.proxy_secret), timeout=3,
            )
        except Exception:  # noqa: BLE001 - do not leak upstream exception/request details
            return 503, b""
        if status == 204:
            return (403 if event["invalidAuthorization"] else 204), b""
        return (status if status in UPSTREAM_ERRORS else 503), b""
