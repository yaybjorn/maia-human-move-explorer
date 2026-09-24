import test from "node:test";
import assert from "node:assert/strict";
import { createUploadPanel } from "../app/static/studio-upload-panel.mjs";
import { StagedUpload } from "../app/static/studio-upload.mjs?v=20260923-chapters";
function dom() {
  const nodes = Object.fromEntries(["title", "video", "thumbnail", "start", "check", "pause", "status", "progress"].map(id => [id, { value: "", disabled: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } }]));
  return { nodes, root: { hidden: true, querySelector: s => nodes[s.match(/"(\w+)"/)[1]] } };
}
const paid = { actorID: "author", courseID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 207, metadata: { slug: "cowboy-kilkenny", priceTier: "usd-4.99" }, dirty: false };
test("explicitly disabled panel cannot access storage, send requests or show upload controls", async () => {
  const { root, nodes } = dom(); let access = 0;
  const panel = createUploadPanel({ root, enabled: false, api: { request: () => { throw Error("unexpected request"); } }, getContext: () => paid, storage: { getItem: () => { access++; throw Error("unavailable"); } } });
  panel.refresh(); await nodes.start.listeners.click();
  assert.equal(root.hidden, true); assert.equal(access, 0);
});
test("free controls explain restriction; dirty chapters block upload without legacy writes", () => {
  const { root, nodes } = dom(); let context = { ...paid, metadata: { ...paid.metadata, priceTier: "free" } };
  const before = structuredClone(context);
  const panel = createUploadPanel({ root, api: {}, getContext: () => context, enabled: true, storage: { getItem: () => null } });
  panel.refresh();
  for (const id of ["title", "video", "thumbnail", "start"]) assert.equal(nodes[id].disabled, true);
  assert.match(nodes.status.textContent, /paid courses only/); assert.deepEqual(context, before);
  context = { ...paid, dirty: true }; panel.refresh(); assert.equal(nodes.video.disabled, true); assert.match(nodes.status.textContent, /Save the chapter/);
});
test("reopened staged result is labelled as checking, never ready or selected", () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, draftRevision: 207, title: "Lesson", state: "staged", files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const panel = createUploadPanel({ root, api: {}, getContext: () => paid, enabled: true, storage: { getItem: () => JSON.stringify(record) } });
  panel.refresh(); assert.match(nodes.status.textContent, /Checking video/);
  assert.equal(nodes.title.value, "Lesson"); panel.clear(); assert.equal(root.hidden, true);
});
test("cancelling the chooser leaves the next file selection usable", async () => {
  const { root, nodes } = dom(); let runs = 0;
  const original = StagedUpload.prototype.run;
  StagedUpload.prototype.run = async function () { runs++; return { state: "paused" }; };
  try {
    const panel = createUploadPanel({ root, api: {}, getContext: () => ({ ...paid, chapterID: "chapter-a", chapterTitle: "Lesson" }), enabled: true, storage: { getItem: () => null } });
    panel.refresh();
    await nodes.video.listeners.change();
    nodes.video.files = [new Blob(["video"], { type: "video/mp4" })];
    await nodes.video.listeners.change();
    assert.equal(runs, 1);
  } finally { StagedUpload.prototype.run = original; }
});
test("clearing a staged chapter upload removes its local identity after a save advances the revision", () => {
  const { root } = dom(), storage = new Map();
  let context = { ...paid, chapterID: "chapter-a" };
  const key = `gingergm-staged-upload-v1:${context.actorID}:${context.courseID}:chapter:${context.chapterID}`;
  storage.set(key, JSON.stringify({ schema: 1, actorID: context.actorID, courseID: context.courseID, chapterID: context.chapterID,
    draftRevision: context.revision, uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Lesson", state: "staged",
    files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } }));
  const panel = createUploadPanel({ root, api: {}, getContext: () => context, enabled: true, storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
  panel.refresh(); context = { ...context, revision: 208 }; panel.refresh(); panel.startNew();
  assert.equal(storage.has(key), false);
});
