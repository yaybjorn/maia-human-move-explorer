import assert from "node:assert/strict";
import test from "node:test";

import { StudioAPI, StudioAPIError, importedCoursePayload } from "../app/static/studio-api.mjs";

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

test("import payload preserves the chosen side without duplicating the PGN", () => {
  const payload = importedCoursePayload({
    title: "Black course", slug: "black-course", side: "black", pgn: "1. e4 e5 *",
  });
  assert.equal(payload.side, "black");
  assert.equal(payload.sourcePGN, "1. e4 e5 *");
  assert.equal(payload.document, undefined);
  assert.equal(JSON.stringify(payload).match(/1\. e4 e5/g)?.length, 1);
});

test("server-side import preview uses the authenticated Studio route", async () => {
  const calls = [];
  const api = new StudioAPI("/studio/api", async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ valid: true }), { status: 200 });
  });
  await api.importPGN("1. d4 d5 *");
  assert.equal(calls[0].url, "/studio/api/import/parse");
  assert.deepEqual(JSON.parse(calls[0].options.body), { pgn: "1. d4 d5 *" });
});

test("Stockfish analysis forwards progressive options and an abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ lines: [] }), { status: 200 });
  };
  try {
    const controller = new AbortController();
    const { analysisAPI } = await import(`../app/static/studio-api.mjs?signal=${Date.now()}`);
    await analysisAPI.stockfish(["e2e4"], { signal: controller.signal, timeMs: 750, lines: 1 });
    assert.equal(calls[0].url, "/api/stockfish");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      moves: ["e2e4"], time_ms: 750, lines: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared ignored words use authenticated GET and CSRF-protected POST routes", async () => {
  const calls = [];
  const api = new StudioAPI("/studio/api", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ csrfToken: "csrf", words: ["Dragon"] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  await api.session();
  assert.deepEqual((await api.ignoredWords()).words, ["Dragon"]);
  await api.addIgnoredWord("Kilkenny");
  assert.equal(calls[1].url, "/studio/api/ignored-words");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[2].url, "/studio/api/ignored-words");
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[2].options.headers["X-CSRF-Token"], "csrf");
  assert.deepEqual(JSON.parse(calls[2].options.body), { word: "Kilkenny" });
});
