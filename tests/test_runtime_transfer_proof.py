import asyncio
import json
from urllib.error import HTTPError

import pytest

from app import runtime_transfer_proof as proof

RUN = "62172a97-1bde-44b5-b725-964a45de24c0"
PATH = f"{proof.PREFIX}/{RUN}/redirect-cross-origin/received"
MARKER = f"Bearer offline-proof-synthetic-{RUN}-2".encode()


def invoke(*, path=PATH, method="GET", scheme="https", headers=(), query=b"",
           body=b"", more=False, enabled=True, secret="synthetic-test-proxy",
           sender=None, raw_path=None, logged_scopes=None):
    events, outgoing = [], []

    def capture(event, supplied_secret):
        events.append((event, supplied_secret))
        return 204

    async def fallback(scope, receive, send):
        await send({"type": "http.response.start", "status": 299, "headers": []})
        await send({"type": "http.response.body", "body": b"fallback"})

    async def receive():
        return {"type": "http.request", "body": body, "more_body": more}

    async def send(message):
        outgoing.append(message)
        if logged_scopes is not None:
            logged_scopes.append({key: scope[key] for key in (
                "path", "raw_path", "query_string",
            )})

    middleware = proof.RuntimeProofReceiverMiddleware(
        fallback, enabled=enabled, proxy_secret=secret, sender=sender or capture,
    )
    scope = {"type": "http", "path": path, "raw_path": raw_path or path.encode(),
             "scheme": scheme, "method": method, "query_string": query,
             "headers": [(b"host", proof.HOST), *headers]}
    asyncio.run(middleware(scope, receive, send))
    return outgoing[0]["status"], outgoing[1]["body"], events, outgoing[0]["headers"]


def test_exact_redacted_contract_never_forwards_caller_headers():
    status, body, events, headers = invoke(headers=[
        (b"authorization", MARKER), (b"cookie", b"private-cookie-never-forward"),
        (b"origin", b"https://unrelated.invalid"), (b"x-studio-proxy-secret", b"forged"),
    ])
    assert status == 204 and body == b""
    assert events == [({
        "runID": RUN, "scenario": "redirect-cross-origin", "method": "GET",
        "authorizationPresent": True, "syntheticGeneration": 2,
        "invalidAuthorization": False,
    }, "synthetic-test-proxy")]
    assert b"location" not in dict(headers)
    assert b"no-store" in dict(headers)[b"cache-control"]


@pytest.mark.parametrize("auth", [
    b"Bearer not-a-synthetic-marker", b"", MARKER + b" ", MARKER.replace(b"-2", b"-02"),
    MARKER.replace(b"-2", b"-1000000"), MARKER.replace(b"62172", b"62173"),
    b"Bearer \xff", b"x" * 10000,
])
def test_invalid_authorization_records_presence_not_value(auth, caplog, capsys):
    status, _, events, _ = invoke(headers=[(b"authorization", auth)])
    assert status == 403
    assert events[0][0]["authorizationPresent"] is True
    assert events[0][0]["syntheticGeneration"] is None
    assert events[0][0]["invalidAuthorization"] is True
    assert set(events[0][0]) == {
        "runID", "scenario", "method", "authorizationPresent", "syntheticGeneration",
        "invalidAuthorization",
    }
    assert not caplog.text and capsys.readouterr() == ("", "")


def test_duplicate_auth_is_invalid_even_if_both_synthetic():
    status, _, events, _ = invoke(headers=[(b"authorization", MARKER)] * 2)
    assert status == 403 and events[0][0]["invalidAuthorization"] is True


def test_absent_auth_receiver_positive_control_and_head():
    for method in ("GET", "HEAD"):
        status, body, events, _ = invoke(method=method)
        assert status == 204 and body == b""
        assert events[0][0]["authorizationPresent"] is False
        assert events[0][0]["invalidAuthorization"] is False
        assert events[0][0]["method"] == method


@pytest.mark.parametrize("kwargs, expected", [
    ({"enabled": False}, 404), ({"secret": ""}, 503),
    ({"scheme": "http"}, 403), ({"method": "POST"}, 405),
    ({"method": "OPTIONS"}, 405), ({"query": b"bad=private"}, 400),
    ({"headers": [(b"host", b"evil.invalid")]}, 403),
    ({"headers": [(b"content-length", b"1")]}, 400),
    ({"headers": [(b"transfer-encoding", b"chunked")]}, 400),
    ({"body": b"private-body"}, 400), ({"more": True}, 400),
    ({"raw_path": PATH.replace("received", "%72eceived").encode()}, 400),
    ({"path": PATH.replace("received", "manifest")}, 404),
    ({"path": PATH.replace("redirect-cross-origin", "unknown")}, 404),
    ({"path": PATH.replace(RUN, RUN.upper())}, 404),
    ({"path": PATH + "/"}, 404), ({"path": proof.PREFIX + "typo"}, 404),
])
def test_fail_closed_no_author_handler_or_upstream(kwargs, expected):
    status, _, events, _ = invoke(**kwargs)
    assert status == expected and events == []


def test_unrelated_studio_route_passes_unchanged():
    assert invoke(path="/studio/api/session")[0] == 299


@pytest.mark.parametrize("kwargs", [
    {}, {"enabled": False}, {"secret": ""}, {"scheme": "http"},
    {"query": b"untrusted=query"}, {"path": proof.PREFIX + "/unknown-name"},
    {"path": proof.PREFIX + "/health"}, {"method": "POST"},
    {"body": b"invalid-input"}, {"sender": lambda *_: 429},
])
def test_fixture_access_scope_is_redacted_before_every_response(kwargs):
    scopes = []
    invoke(logged_scopes=scopes, **kwargs)
    assert scopes and all(scope == {
        "path": proof.LOG_PATH, "raw_path": proof.LOG_PATH.encode(), "query_string": b"",
    } for scope in scopes)


def test_unrelated_access_scope_unchanged():
    scopes = []
    invoke(path="/studio/api/session", query=b"example=value", logged_scopes=scopes)
    assert all(scope == {
        "path": "/studio/api/session", "raw_path": b"/studio/api/session",
        "query_string": b"example=value",
    } for scope in scopes)


def test_health_static_never_uses_author_or_accounting():
    status, body, events, _ = invoke(path=proof.PREFIX + "/health", secret="")
    assert (status, body, events) == (200, b"synthetic-runtime-fixture", [])
    assert invoke(path=proof.PREFIX + "/health", headers=[(b"authorization", MARKER)])[0] == 403
    status, body, _, headers = invoke(path=proof.PREFIX + "/health", method="HEAD")
    assert status == 200 and body == b""
    assert dict(headers)[b"content-length"] == b"25"


@pytest.mark.parametrize("upstream", [400, 403, 404, 429, 503, 200, 302, 307, 308, 500])
def test_only_known_upstream_statuses_propagate(upstream):
    status, body, _, headers = invoke(sender=lambda *_: upstream)
    assert status == (upstream if upstream in proof.UPSTREAM_ERRORS else 503)
    assert body == b"" and b"location" not in dict(headers)


def test_upstream_exceptions_never_log_values(caplog, capsys):
    def fail(*args):
        raise RuntimeError("sensitive-error-value")
    assert invoke(sender=fail)[0] == 503
    assert not caplog.text and capsys.readouterr() == ("", "")


def test_transport_fixed_target_secret_only_and_zero_response_reads(monkeypatch):
    seen = []

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, *args):
            raise AssertionError("Response body must never be read")

    class Opener:
        def open(self, request, timeout):
            seen.append((request, timeout))
            return Response()

    def opener(*handlers):
        assert handlers[0].proxies == {}
        assert isinstance(handlers[1], proof._NoRedirect)
        return Opener()

    monkeypatch.setattr(proof, "build_opener", opener)
    event = {"runID": RUN, "scenario": "normal", "method": "HEAD",
             "authorizationPresent": False, "syntheticGeneration": None,
             "invalidAuthorization": False}
    assert proof.post_redacted_event(event, "synthetic-test-proxy") == 204
    request, timeout = seen[0]
    assert request.full_url == proof.UPSTREAM and request.method == "POST" and timeout == 2
    assert json.loads(request.data) == event
    assert set(dict(request.header_items())) == {
        "Content-type", "Accept", "User-agent", "X-studio-proxy-secret",
    }
    assert proof._NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil") is None


def test_transport_redirect_closed_without_body_read_or_log(monkeypatch, caplog):
    class Opener:
        def open(self, *args, **kwargs):
            raise HTTPError("hidden-url", 302, "hidden-error", {}, None)
    monkeypatch.setattr(proof, "build_opener", lambda *args: Opener())
    assert proof.post_redacted_event({}, "synthetic-test-proxy") == 503
    assert not caplog.text


def test_transport_concurrency_exhaustion_no_network(monkeypatch):
    semaphore = proof.threading.BoundedSemaphore(1)
    semaphore.acquire()
    monkeypatch.setattr(proof, "_UPSTREAM_SLOTS", semaphore)
    monkeypatch.setattr(proof, "build_opener", lambda *args: pytest.fail("must not connect"))
    assert proof.post_redacted_event({}, "synthetic-test-proxy") == 503


def test_missing_request_event_times_out_without_upstream():
    sent = []

    async def receive():
        await asyncio.sleep(10)

    async def send(message):
        sent.append(message)

    middleware = proof.RuntimeProofReceiverMiddleware(
        None, enabled=True, proxy_secret="synthetic-test-proxy",
        sender=lambda *_: pytest.fail("must not send"),
    )
    asyncio.run(middleware({"type": "http", "path": PATH, "scheme": "https",
                           "method": "GET", "headers": [(b"host", proof.HOST)]}, receive, send))
    assert sent[0]["status"] == 400
