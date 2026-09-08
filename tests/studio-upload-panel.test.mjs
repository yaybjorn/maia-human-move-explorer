import test from "node:test";
import assert from "node:assert/strict";
import { createUploadPanel } from "../app/static/studio-upload-panel.mjs";
function dom() {
  const nodes = Object.fromEntries(["title", "video", "thumbnail", "start", "check", "pause", "status", "progress"].map(id => [id, { value: "", disabled: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } }]));
  return { nodes, root: { hidden: true, querySelector: s => nodes[s.match(/"(\w+)"/)[1]] } };
}
const paid = { actorID: "author", courseID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", revision: 207, metadata: { slug: "cowboy-kilkenny", priceTier: "usd-4.99" }, dirty: false };
test("default-disabled panel cannot access storage, send requests or show upload controls", async () => {
  const { root, nodes } = dom(); let access = 0;
  const panel = createUploadPanel({ root, api: { request: () => { throw Error("unexpected request"); } }, getContext: () => paid, storage: { getItem: () => { access++; throw Error("unavailable"); } } });
  panel.refresh(); await nodes.start.listeners.click();
  assert.equal(root.hidden, true); assert.equal(access, 0);
});
test("free controls explain restriction; paid dirty draft blocks start without legacy writes", () => {
  const { root, nodes } = dom(); let context = { ...paid, metadata: { ...paid.metadata, priceTier: "free" } };
  const before = structuredClone(context);
  const panel = createUploadPanel({ root, api: {}, getContext: () => context, enabled: true, storage: { getItem: () => null } });
  panel.refresh();
  for (const id of ["title", "video", "thumbnail", "start"]) assert.equal(nodes[id].disabled, true);
  assert.match(nodes.status.textContent, /paid courses only/); assert.deepEqual(context, before);
  context = { ...paid, dirty: true }; panel.refresh(); assert.equal(nodes.start.disabled, true); assert.match(nodes.status.textContent, /Save draft/);
});
test("reopened staged result is labelled awaiting validation, never ready or selected", () => {
  const { root, nodes } = dom();
  const record = { schema: 1, actorID: paid.actorID, courseID: paid.courseID, draftRevision: 207, title: "Lesson", state: "staged" };
  const panel = createUploadPanel({ root, api: {}, getContext: () => paid, enabled: true, storage: { getItem: () => JSON.stringify(record) } });
  panel.refresh(); assert.match(nodes.status.textContent, /awaiting validation/); assert.match(nodes.status.textContent, /Not selected/);
  assert.equal(nodes.title.value, "Lesson"); panel.clear(); assert.equal(root.hidden, true);
});
