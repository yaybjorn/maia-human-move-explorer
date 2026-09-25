import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../app/static/studio.js", import.meta.url), "utf8");
const start = source.indexOf("function resetUserGames(");
const end = source.indexOf("\nfunction renderAll()", start);
assert.ok(start >= 0 && end > start, "User games request fencing is present");
const userGamesSource = source.slice(start, end);

function deferred() {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function harness() {
  const requests = [];
  const state = {
    courseID: "course-a", userGames: [], userGamesCursor: null, userGamesCourseID: null,
    userGamesLoading: false, userGamesError: null, userGamesRequest: 0,
  };
  const context = vm.createContext({
    state,
    api: { userGames(courseID, options) { const request = deferred(); requests.push({ courseID, options, request }); return request.promise; } },
    showStatus() {},
    Array,
  });
  vm.runInContext(userGamesSource, context);
  context.renderUserGames = () => {};
  return { state, requests, load: options => vm.runInContext(`loadUserGames(${JSON.stringify(options || {})})`, context) };
}

test("ignores a resolved stale course request before loading and paginating the replacement course", async () => {
  const h = harness();
  const pendingA = h.load();
  assert.equal(h.requests.length, 1);
  h.state.courseID = "course-b";
  const pendingB = h.load();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests.map(item => item.courseID), ["course-a", "course-b"]);

  h.requests[0].request.resolve({ submissions: [{ id: "from-a" }], nextCursor: "a-next" });
  await pendingA;
  assert.equal(h.state.userGames.length, 0);
  assert.equal(h.state.userGamesCursor, null);
  assert.equal(h.state.userGamesLoading, true);

  h.requests[1].request.resolve({ submissions: [{ id: "b-page-1" }], nextCursor: "b-next" });
  await pendingB;
  const pendingPageTwo = h.load({ append: true });
  assert.equal(h.requests.length, 3);
  assert.deepEqual({ ...h.requests[2].options }, { limit: 50, cursor: "b-next" });
  h.requests[2].request.resolve({ submissions: [{ id: "b-page-2" }], nextCursor: null });
  await pendingPageTwo;
  assert.deepEqual(Array.from(h.state.userGames, item => item.id), ["b-page-1", "b-page-2"]);
  assert.equal(h.state.userGamesCursor, null);
});

test("ignores a rejected stale course request without clearing the replacement load", async () => {
  const h = harness();
  const pendingA = h.load();
  h.state.courseID = "course-b";
  const pendingB = h.load();
  h.requests[0].request.reject(new Error("course-a failed"));
  await pendingA;
  assert.equal(h.state.userGamesError, null);
  assert.equal(h.state.userGamesLoading, true);

  h.requests[1].request.resolve({ submissions: [{ id: "b-only" }], nextCursor: null });
  await pendingB;
  assert.deepEqual(Array.from(h.state.userGames, item => item.id), ["b-only"]);
  assert.equal(h.state.userGamesError, null);
  assert.equal(h.state.userGamesLoading, false);
});
