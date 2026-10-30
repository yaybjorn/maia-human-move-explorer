import test from "node:test";
import assert from "node:assert/strict";
import { createUploadPanel } from "../app/static/studio-upload-panel.mjs";
import { StagedUpload } from "../app/static/studio-upload.mjs?v=20261030-lock-contention";
import fs from "node:fs";
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

test("validation failure replaces only the matching staged upload status", () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, chapterID: "chapter-a", draftRevision: 207, uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Lesson", state: "staged", files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const context = { ...paid, chapterID: "chapter-a" };
  const panel = createUploadPanel({ root, api: {}, getContext: () => context, enabled: true, storage: { getItem: () => JSON.stringify(record) } });
  panel.refresh();
  panel.validationFailed({ courseID: paid.courseID, chapterID: "chapter-a", uploadID: record.uploadID, error: "Validation failed." });
  assert.equal(nodes.status.textContent, "Validation failed.");
  panel.validationFailed({ courseID: paid.courseID, chapterID: "chapter-a", uploadID: "other", error: "Wrong upload." });
  assert.equal(nodes.status.textContent, "Validation failed.");
});

test("fresh staged upload keeps its identity for a matching validation failure", async () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, chapterID: "chapter-a", draftRevision: 207, uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Lesson", state: "staged", files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const original = StagedUpload.prototype.run;
  StagedUpload.prototype.run = async () => record;
  try {
    const panel = createUploadPanel({ root, api: {}, getContext: () => ({ ...paid, chapterID: "chapter-a" }), enabled: true, storage: { getItem: () => null } });
    panel.refresh(); nodes.video.files = [new Blob(["video"], { type: "video/mp4" })]; await nodes.video.listeners.change();
    panel.validationFailed({ courseID: paid.courseID, chapterID: "chapter-a", uploadID: record.uploadID, error: "Validation failed." });
    assert.equal(nodes.status.textContent, "Validation failed.");
  } finally { StagedUpload.prototype.run = original; }
});

test("inspection stages a matching upload before reporting its validation failure", async () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, chapterID: "chapter-a", draftRevision: 207, uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Lesson", state: "staged", files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const original = StagedUpload.prototype.inspect;
  StagedUpload.prototype.inspect = async () => record;
  try {
    const panel = createUploadPanel({ root, api: {}, getContext: () => ({ ...paid, chapterID: "chapter-a" }), enabled: true, storage: { getItem: () => JSON.stringify({ ...record, state: "blocked" }) } });
    panel.refresh(); await nodes.check.listeners.click();
    panel.validationFailed({ courseID: paid.courseID, chapterID: "chapter-a", uploadID: record.uploadID, error: "Validation failed." });
    assert.equal(nodes.status.textContent, "Validation failed.");
  } finally { StagedUpload.prototype.inspect = original; }
});
test("blocked saved upload exposes only the read-only progress check", () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, draftRevision: 207, title: "Lesson", state: "blocked",
    files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const panel = createUploadPanel({ root, api: {}, getContext: () => paid, enabled: true, storage: { getItem: () => JSON.stringify(record) } });
  panel.refresh();
  assert.equal(nodes.check.hidden, false);
  assert.equal(nodes.check.disabled, false);
  assert.match(nodes.status.textContent, /No operation will be repeated/);
});
test("Studio revisions the recovery-control module so a reload cannot retain its pre-control cache entry", () => {
  const source = fs.readFileSync(new URL("../app/static/studio.js", import.meta.url), "utf8");
  assert.match(source, /studio-upload-panel\.mjs\?v=20261030-lock-contention/);
  const document = fs.readFileSync(new URL("../app/static/studio.html", import.meta.url), "utf8");
  assert.match(document, /studio\.js\?v=20261030-lock-contention/);
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

test("checking a staged upload from an old draft never attaches it to the current chapter", async () => {
  const { root, nodes } = dom(); let attaches = 0;
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, chapterID: "chapter-a", draftRevision: 207, uploadID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Lesson", state: "staged", files: { video: { byteLength: 1 }, thumbnail: { byteLength: 1 } } };
  const original = StagedUpload.prototype.inspect; StagedUpload.prototype.inspect = async () => record;
  try {
    const panel = createUploadPanel({ root, api: {}, getContext: () => ({ ...paid, revision: 208, chapterID: "chapter-a" }), enabled: true, storage: { getItem: () => JSON.stringify(record) }, onStaged: () => { attaches++; } });
    panel.refresh(); await nodes.check.listeners.click(); assert.equal(attaches, 0);
  } finally { StagedUpload.prototype.inspect = original; }
});


test("refresh after a chapter video becomes ready hides the upload panel and blocks a new upload", async () => {
  const { root, nodes } = dom(); let context = { ...paid, chapterID: "chapter-a" }, requests = 0;
  const panel = createUploadPanel({ root, api: { request: () => { requests++; } }, getContext: () => context, enabled: true, storage: { getItem: () => null } });
  panel.refresh(); assert.equal(root.hidden, false);
  context = { ...context, hasVideo: true }; panel.refresh(); assert.equal(root.hidden, true);
  nodes.video.files = [new Blob(["video"], { type: "video/mp4" })]; await nodes.video.listeners.change(); assert.equal(requests, 0);
  context = { ...context, hasVideo: false }; panel.refresh(); assert.equal(root.hidden, false);
});

test("failed upload leaves file chooser ready to select the same file again", async () => {
  const {root,nodes}=dom();const original=StagedUpload.prototype.run;StagedUpload.prototype.run=async()=>{throw Error('Another Studio tab is using this chapter');};
  try {const panel=createUploadPanel({root,api:{},getContext:()=>({...paid,chapterID:'chapter-a'}),enabled:true,storage:{getItem:()=>null}});panel.refresh();nodes.video.value='fixture.mp4';nodes.video.files=[new Blob(['video'],{type:'video/mp4'})];await nodes.video.listeners.change();assert.equal(nodes.video.value,'');assert.match(nodes.status.textContent,/Another Studio tab/);assert.equal(nodes.video.disabled,false);}finally{StagedUpload.prototype.run=original;}
});
