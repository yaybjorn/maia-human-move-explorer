import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createUploadPanel } from "../app/static/studio-upload-panel.mjs";
import { StagedUpload } from "../app/static/studio-upload.mjs";

// Execute the production save body with the real upload panel. No browser,
// network, provider or persisted course mutation; only deterministic local fixtures.
const source = await readFile(new URL("../app/static/studio.js", import.meta.url), "utf8");
const start = source.indexOf("async function performSaveDraft() {");
const end = source.indexOf("\nfunction flushActiveEditor()", start);
assert.ok(start >= 0 && end > start);
const saveSource = source.slice(start, end);

function setup(record = null) {
  const nodes = Object.fromEntries(["title", "video", "thumbnail", "start", "check", "pause", "status", "progress"].map(id => [id, {
    value: "", listeners: {}, addEventListener(event, listener) { this.listeners[event] = listener; },
  }]));
  const state = { user: { id: "fixture-owner" }, courseID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 207, view: "videos",
    document: { metadata: { slug: "cowboy-kilkenny", priceTier: "usd-4.99", title: "Saved title", videos: [{ id: "supplemental-keep" }], courseVideo: { id: "main-keep" } }, sourcePGN: "fixture" }, savedSnapshot: "older draft" };
  const dirty = () => JSON.stringify(state.document) !== state.savedSnapshot;
  let entered, finish;
  const saving = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const calls = [], storage = new Map();
  if (record) storage.set(`gingergm-staged-upload-v1:${state.user.id}:${state.courseID}`, JSON.stringify(record));
  const api = {
    saveDraft: async (...args) => { entered(args); return response; },
    request: async (path, options) => { calls.push({ path, options }); throw new Error("Fixture stops before reservation"); },
  };
  const panel = createUploadPanel({ root: { querySelector: selector => nodes[selector.match(/"(\w+)"/)[1]] }, enabled: true, api,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    getContext: () => ({ actorID: state.user.id, courseID: state.courseID, revision: state.revision, metadata: state.document.metadata, dirty: dirty() }) });
  let extractionRefreshes = 0;
  panel.refresh();
  const context = vm.createContext({ state, JSON, structuredClone, dirty,
    flushActiveEditor() {}, updateSaveState() {}, normalizeDocument: structuredClone,
    normalizeCourseVideos: value => value, saveCrashRecovery() {}, clearCrashRecovery() {},
    exportSource: async () => "fixture", documentForStorage: value => value, api,
    extractionPanel: { refresh() { extractionRefreshes++; } }, uploadPanel: panel, showStatus() {},
  });
  return { state, nodes, dirty, saving, calls, storage, finish, get extractionRefreshes() { return extractionRefreshes; },
    save: () => vm.runInContext(`${saveSource}\nperformSaveDraft()`, context) };
}

test("confirmed clean production save refreshes and enables upload using the new revision", async () => {
  const s = setup(); assert.equal(s.nodes.start.disabled, true);
  const saved = s.save(); await s.saving; s.finish({ draft: { revision: 208 } });
  assert.equal(await saved, true); assert.equal(s.state.revision, 208); assert.equal(s.dirty(), false);
  assert.equal(s.extractionRefreshes, 1); assert.equal(s.nodes.start.disabled, false);
  assert.doesNotMatch(s.nodes.status.textContent, /Save draft changes/);
  s.nodes.title.value = "New staged lesson";
  s.nodes.video.files = [new Blob(["video"], { type: "video/mp4" })];
  s.nodes.thumbnail.files = [new Blob(["thumbnail"], { type: "image/png" })];
  await s.nodes.start.listeners.click();
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].options.body.revision, 208);
  assert.deepEqual(s.state.document.metadata.videos, [{ id: "supplemental-keep" }]);
  assert.deepEqual(s.state.document.metadata.courseVideo, { id: "main-keep" });
});

test("edits during production save remain dirty and upload controls stay disabled", async () => {
  const s = setup(), saved = s.save(); await s.saving;
  s.state.document = { ...s.state.document, metadata: { ...s.state.document.metadata, title: "Edited while saving" } };
  s.finish({ draft: { revision: 208 } });
  assert.equal(await saved, true); assert.equal(s.state.revision, 208); assert.equal(s.dirty(), true);
  assert.equal(s.state.document.metadata.title, "Edited while saving");
  assert.equal(JSON.parse(s.state.savedSnapshot).metadata.title, "Saved title");
  assert.equal(s.nodes.start.disabled, true); assert.match(s.nodes.status.textContent, /Save draft changes/);
  await s.nodes.start.listeners.click(); assert.equal(s.calls.length, 0);
});

test("save refresh pauses the old context without rebinding or clearing its immutable upload record", async () => {
  const record = { schema: 1, actorID: "fixture-owner", courseID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", draftRevision: 207,
    uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Existing upload", state: "paused",
    files: { video: { byteLength: 5, mimeType: "video/mp4", parts: [] }, thumbnail: { byteLength: 9, mimeType: "image/png", parts: [] } } };
  const s = setup(record), before = [...s.storage.entries()], paused = [];
  const original = StagedUpload.prototype.pause;
  StagedUpload.prototype.pause = function () { paused.push(this.revision); return original.call(this); };
  try {
    s.state.view = "details"; // Saving away from Videos must still pause/reconcile its context.
    const saved = s.save(); await s.saving; s.finish({ draft: { revision: 208 } }); await saved;
    assert.deepEqual(paused, [207]); assert.deepEqual([...s.storage.entries()], before);
    s.nodes.video.files = [new Blob(["video"], { type: "video/mp4" })];
    s.nodes.thumbnail.files = [new Blob(["thumbnail"], { type: "image/png" })];
    await s.nodes.start.listeners.click();
    assert.match(s.nodes.status.textContent, /draft changed/); assert.equal(s.calls.length, 0);
    assert.deepEqual([...s.storage.entries()], before);
  } finally { StagedUpload.prototype.pause = original; }
});
