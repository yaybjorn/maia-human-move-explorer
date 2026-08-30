import assert from "node:assert/strict";
import test from "node:test";

import { StudioAPI, StudioAPIError } from "../app/static/studio-api.mjs";

test("uses same-origin cookies and server-issued CSRF for mutations", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ csrfToken: "csrf-value", revision: 2 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const api = new StudioAPI("/studio/api", fetcher);
  await api.session();
  await api.saveDraft("course-1", 1, { schemaVersion: 1 });
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[1].options.headers["X-CSRF-Token"], "csrf-value");
  assert.equal(calls[1].url, "/studio/api/courses/course-1/draft");
  assert.equal(calls[1].options.method, "PUT");
});

test("login and logout use the canonical routes without browser tokens", async () => {
  const urls = [];
  const api = new StudioAPI("/studio/api", async (url) => {
    urls.push(url); return new Response("{}", { status: 200 });
  });
  await api.login("author@example.com", "secret"); await api.logout();
  assert.deepEqual(urls, ["/studio/api/login", "/studio/api/logout"]);
});

test("surfaces edit conflicts without discarding response details", async () => {
  const api = new StudioAPI("/studio/api", async () => new Response(JSON.stringify({
    error: {
      code: "revision_conflict",
      message: "A newer draft exists",
      details: { currentRevision: 4 },
    },
  }), { status: 409, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(api.saveDraft("course", 3, {}), error => {
    assert.ok(error instanceof StudioAPIError); assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.equal(error.message, "A newer draft exists");
    assert.equal(error.details.currentRevision, 4); return true;
  });
});
