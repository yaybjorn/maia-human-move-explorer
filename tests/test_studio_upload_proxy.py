import asyncio

import httpx
import pytest
from starlette.requests import Request

from app import studio_upload_proxy as proxy

COURSE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
UPLOAD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
OP = "cccccccc-cccc-cccc-cccc-cccccccccccc"
BASE = f"courses/{COURSE}/offline-video/uploads"
PATH = f"{BASE}/{UPLOAD}/operations/{OP}"
ORIGIN = "https://studio.example"
HTTPX_CLIENT = httpx.AsyncClient


def invoke(monkeypatch, *, path=PATH, method="PUT", chunks=(b"ab", b"cd"), headers=None,
           enabled=True, upstream_status=200, upstream_body=b'{"state":"receipt_recorded"}',
           upstream_headers=None, receive_delay=0, upstream_delay=0, fail=False):
    recorded, pulls = [], []

    async def upstream(request):
        recorded.append(request)
        if upstream_delay:
            await asyncio.sleep(upstream_delay)
        if fail:
            raise httpx.ConnectError("PRIVATE CREDENTIAL SHOULD NEVER ESCAPE")
        return httpx.Response(upstream_status, content=upstream_body, headers=upstream_headers)

    def factory(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return HTTPX_CLIENT(transport=httpx.MockTransport(upstream), **kwargs)

    monkeypatch.setattr(proxy.httpx, "AsyncClient", factory)
    values = {"origin": ORIGIN, "cookie": "fixture-session=local", "x-csrf-token": "fixture-csrf",
              "x-upload-fence": "2", "content-range": "bytes 0-3/4", "content-length": "4",
              "content-type": "application/octet-stream", "x-studio-proxy-secret": "forged",
              "authorization": "forged", "x-studio-client-ip": "forged"}
    values.update(headers or {})
    values = {k: v for k, v in values.items() if v is not None}
    incoming = iter(chunks)

    async def receive():
        pulls.append(True)
        if receive_delay:
            await asyncio.sleep(receive_delay)
        chunk = next(incoming, None)
        return {"type": "http.request", "body": chunk or b"", "more_body": chunk is not None}

    request = Request({"type": "http", "method": method, "scheme": "https", "path": f"/studio/api/{path}",
                       "query_string": b"", "server": ("studio.example", 443), "client": ("192.0.2.1", 1),
                       "headers": [(k.encode(), v.encode()) for k, v in values.items()]}, receive)
    response = asyncio.run(proxy.proxy_upload(path, request, enabled=enabled,
                                              base="https://worker.example/v1/studio", secret="fixture-proxy",
                                              allowed_origins={ORIGIN}))
    return response, recorded, pulls


def test_exact_streaming_headers_and_no_credentials_reflection(monkeypatch):
    response, calls, pulls = invoke(monkeypatch)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert len(pulls) == 3
    request = calls[0]
    assert request.content == b"abcd"
    assert request.headers["content-range"] == "bytes 0-3/4"
    assert request.headers["content-length"] == "4"
    assert request.headers["x-upload-fence"] == "2"
    assert request.headers["x-studio-proxy-secret"] == "fixture-proxy"
    assert request.headers["x-studio-client-ip"] == "192.0.2.1"
    assert "authorization" not in request.headers
    assert "x-studio-proxy-secret" not in response.headers


@pytest.mark.parametrize("headers,status", [
    ({"origin": "https://evil.example"}, 403), ({"cookie": None}, 401),
    ({"x-csrf-token": None}, 403), ({"content-encoding": "gzip"}, 400),
    ({"content-length": "5"}, 400), ({"content-length": None}, 400),
    ({"x-upload-fence": "601"}, 400), ({"content-range": "bytes 0-8388608/8388609"}, 400),
])
def test_rejected_before_read_or_forward(monkeypatch, headers, status):
    response, calls, pulls = invoke(monkeypatch, headers=headers)
    assert response.status_code == status
    assert not calls and not pulls


@pytest.mark.parametrize("options", [{"enabled": False}, {"path": f"{BASE}/{UPLOAD}/complete"}])
def test_default_off_and_narrow_allowlist(monkeypatch, options):
    response, calls, pulls = invoke(monkeypatch, **options)
    assert response.status_code == 404
    assert not calls and not pulls


@pytest.mark.parametrize("chunks,status", [((b"abcde",), 413), ((b"a",), 400)])
def test_actual_stream_length_is_bounded(monkeypatch, chunks, status):
    response, calls, _ = invoke(monkeypatch, chunks=chunks)
    assert response.status_code == status
    assert not calls
    assert proxy._active == 0


def test_bodyless_effect_and_owner_readback_no_chunked_body(monkeypatch):
    headers = {"content-range": None, "content-length": "0", "content-type": None}
    response, calls, _ = invoke(monkeypatch, chunks=(), headers=headers)
    assert response.status_code == 200
    assert calls[0].content == b"" and "transfer-encoding" not in calls[0].headers
    response, calls, _ = invoke(monkeypatch, path=f"{BASE}/{UPLOAD}/operations", method="GET", chunks=(), headers=headers)
    assert response.status_code == 200
    assert calls[0].content == b"" and "transfer-encoding" not in calls[0].headers
    assert "x-csrf-token" not in calls[0].headers


def test_bounded_prepare_json_and_upstream_paid_denial(monkeypatch):
    headers = {"content-range": None, "content-length": "2", "content-type": "application/json"}
    response, calls, _ = invoke(monkeypatch, path=f"{BASE}/{UPLOAD}/operations", method="POST", chunks=(b"{}",), headers=headers,
                                 upstream_status=403, upstream_body=b'{"error":{"code":"free_media_not_enabled"}}')
    assert response.status_code == 403 and b"free_media_not_enabled" in response.body
    assert calls[0].content == b"{}"


def test_idle_and_total_deadlines_release_admission(monkeypatch):
    monkeypatch.setattr(proxy, "IDLE_SECONDS", .001)
    response, _, _ = invoke(monkeypatch, receive_delay=.03)
    assert response.status_code == 408 and proxy._active == 0
    monkeypatch.setattr(proxy, "TOTAL_SECONDS", .001)
    response, _, _ = invoke(monkeypatch, upstream_delay=.03)
    assert response.status_code == 408 and proxy._active == 0


def test_capacity_is_fail_closed_without_body_pull(monkeypatch):
    monkeypatch.setattr(proxy, "_active", proxy.MAX_ACTIVE)
    response, calls, pulls = invoke(monkeypatch)
    assert response.status_code == 429 and not calls and not pulls


def test_redirect_response_limit_and_transport_errors_are_sanitized(monkeypatch):
    response, _, _ = invoke(monkeypatch, upstream_status=307, upstream_headers={"Location": "https://untrusted.example"})
    assert response.status_code == 502 and "location" not in response.headers
    response, _, _ = invoke(monkeypatch, upstream_body=b"x" * (proxy.MAX_RESPONSE + 1))
    assert response.status_code == 502
    response, _, _ = invoke(monkeypatch, fail=True)
    assert response.status_code == 503 and b"PRIVATE" not in response.body


def test_real_dispatch_is_default_off_and_does_not_widen_legacy_proxy(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    client = TestClient(main.app)
    monkeypatch.setattr(main, "STUDIO_PRIVATE_UPLOADS_ENABLED", False)
    response = client.put(f"/studio/api/{PATH}", content=b"abcd")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "studio_route_not_found"}}
    assert not main.studio_path_allowed(PATH, "PUT")
    assert main.studio_path_allowed(f"courses/{COURSE}/draft", "PUT")


def test_nginx_upload_limit_and_no_spooling_are_narrowly_nested():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for name in ("nginx.conf", "nginx.ggm.conf"):
        text = (root / "deploy" / name).read_text()
        prefix = text.split("location ^~ /studio/api/ {", 1)[1]
        nested, ordinary = prefix.split("location ~ ^/studio/api/courses/", 1)[1].split("}", 1)
        assert "/offline-video/uploads" in nested
        assert "client_max_body_size 8m;" in nested
        assert "proxy_request_buffering off;" in nested
        assert "proxy_http_version 1.1;" in nested
        assert "client_body_timeout 30s;" in nested
        assert "client_max_body_size 2m;" in ordinary
        assert "proxy_request_buffering on;" in ordinary
