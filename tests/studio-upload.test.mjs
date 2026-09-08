import test from "node:test";
import assert from "node:assert/strict";
import { StagedUpload, CHUNK_BYTES, paidUploadCourse, PRIVATE_UPLOADS_ENABLED } from "../app/static/studio-upload.mjs";
import { StudioAPI } from "../app/static/studio-api.mjs";
const courseID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", uploadID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const metadata = { slug: "cowboy-kilkenny", priceTier: "usd-4.99", courseVideo: { id: "keep" }, videos: [{ id: "keep-too" }] };
function setup({ lostPrepare = false, lostExecute = false, uncertain = false, lostReserve = false } = {}) {
  const stored = new Map(), storage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) };
  const inputs = { video: new Blob([new Uint8Array(CHUNK_BYTES + 3).fill(7)], { type: "video/mp4" }), thumbnail: new Blob([new Uint8Array(3).fill(8)], { type: "image/png" }), title: "Private lesson" };
  const remote = { uploadID, draftRevision: 207, title: inputs.title, revision: 0, blocked: false, operation: null, files: Object.fromEntries(["video", "thumbnail"].map(k => [k, { byteLength: inputs[k].size, offset: 0, stored: false, created: false, parts: [] }])) };
  const effects = [], prepares = [], requests = [];
  const api = {
    async request(path, opts = {}) {
      requests.push([path, opts.method || "GET"]);
      if (opts.method === "POST" && !path.endsWith("operations")) { if (lostReserve) throw Error("lost reserve"); return { uploadID, maxChunkBytes: CHUNK_BYTES }; }
      if (opts.method === "POST") {
        assert.equal(remote.operation, null); assert.equal(opts.body.revision, remote.revision);
        const intent = opts.body.intent; prepares.push(intent);
        const token = { id: `00000000-0000-0000-0000-${String(++remote.revision).padStart(12, "0")}`, uploadID, fence: remote.revision, deadlineAt: Date.now() + 120000 };
        remote.operation = { token, intent };
        if (lostPrepare) { lostPrepare = false; throw Error("lost prepare"); }
        return { operation: token };
      }
      return structuredClone(remote);
    },
    async executeStagedOperation(path, fence, body, range) {
      const op = remote.operation; assert.ok(op); assert.equal(fence, op.token.fence); assert.ok(path.endsWith(op.token.id));
      effects.push(op.token.id);
      if (uncertain) { remote.operation = null; remote.blocked = true; throw Error("uncertain effect"); }
      const { intent } = op, file = remote.files[intent.kind];
      if (intent.action === "create_multipart") { assert.equal(body, undefined); file.created = true; }
      else if (intent.action === "upload_part") {
        assert.equal(range, `bytes ${intent.offset}-${intent.offset + intent.byteLength - 1}/${file.byteLength}`);
        assert.equal(body.size, intent.byteLength);
        const { partNumber, offset, byteLength, sha256 } = intent;
        file.parts.push({ partNumber, offset, byteLength, sha256 }); file.offset += byteLength;
      } else file.stored = true;
      remote.operation = null;
      if (lostExecute) { lostExecute = false; throw Error("lost execute"); }
      return { state: "receipt_recorded" };
    },
  };
  const make = (changes = {}) => new StagedUpload({ api, storage, courseID, actorID: "author", revision: 207, metadata, ...changes });
  return { storage, stored, inputs, remote, effects, prepares, requests, make, api };
}
test("stages sequential bounded chunks with exact ranges without touching legacy links", async () => {
  const s = setup(), before = structuredClone(metadata), result = await s.make().run(s.inputs);
  assert.equal(result.state, "staged"); assert.deepEqual(metadata, before);
  assert.equal(s.effects.length, 7); assert.equal(new Set(s.effects).size, 7);
  assert.deepEqual(s.prepares.filter(p => p.action === "upload_part").map(p => p.byteLength), [CHUNK_BYTES, 3, 3]);
  assert.equal(result.progress.video.offset, s.inputs.video.size);
  assert.doesNotMatch([...s.stored.values()].join(""), /csrf|cookie|token|base64|blob:|ready|published|private-staged/i);
});
test("lost prepare ack reopens the exact operation without preparing a replacement", async () => {
  const s = setup({ lostPrepare: true }); await assert.rejects(s.make().run(s.inputs), /lost prepare/);
  assert.equal(s.prepares.length, 1); assert.equal(s.effects.length, 0);
  const id = s.remote.operation.token.id;
  assert.equal((await s.make().run(s.inputs)).state, "staged");
  assert.equal(s.effects[0], id); assert.equal(s.prepares.length, 7);
});
test("lost execution ack uses successful readback; no second effect", async () => {
  const s = setup({ lostExecute: true }); await assert.rejects(s.make().run(s.inputs), /lost execute/);
  await s.make().run(s.inputs); assert.equal(s.effects.length, 7); assert.equal(new Set(s.effects).size, 7);
});
test("uncertain/issued recovery never repeats or replaces an operation", async () => {
  const s = setup({ uncertain: true }); await assert.rejects(s.make().run(s.inputs), /uncertain/);
  await assert.rejects(s.make().run(s.inputs), /uncertain or expired/);
  assert.equal(s.effects.length, 1); assert.equal(s.prepares.length, 1);
});
test("lost reservation acknowledgement cannot create a duplicate reservation on retry", async () => {
  const s = setup({ lostReserve: true }); await assert.rejects(s.make().run(s.inputs), /lost reserve/);
  await assert.rejects(s.make().run(s.inputs), /reservation response was lost/);
  assert.equal(s.requests.length, 1);
});
test("explicit reservation capacity denial permits a later user retry without uncertain replacement", async () => {
  const s = setup(), original = s.api.request;
  s.api.request = async () => { throw Object.assign(Error("capacity"), { status: 429 }); };
  await assert.rejects(s.make().run(s.inputs), /capacity/); assert.equal(s.stored.size, 0);
  s.api.request = original; assert.equal((await s.make().run(s.inputs)).state, "staged");
});
test("same-size substituted files, stale revision and server part mismatch stop before mutation", async () => {
  const s = setup({ lostExecute: true }); await assert.rejects(s.make().run(s.inputs));
  const count = s.requests.filter(r => r[1] === "POST").length;
  await assert.rejects(s.make().run({ ...s.inputs, thumbnail: new Blob([new Uint8Array(3)], { type: "image/png" }) }), /exact same/);
  await assert.rejects(s.make({ revision: 208 }).run(s.inputs), /draft changed/);
  s.remote.files.video.parts = [{ partNumber: 1, offset: 0, byteLength: 3, sha256: "f".repeat(64) }];
  await assert.rejects(s.make().run(s.inputs), /fingerprints/);
  assert.equal(s.requests.filter(r => r[1] === "POST").length, count);
});
test("free or unknown paid mapping is denied; production gate remains false", async () => {
  assert.equal(PRIVATE_UPLOADS_ENABLED, false);
  const s = setup(); await assert.rejects(s.make({ metadata: { ...metadata, priceTier: "free" } }).run(s.inputs), /paid courses only/);
  assert.equal(paidUploadCourse({ slug: "unknown", priceTier: "usd-4.99" }), false);
  assert.equal(s.requests.length, 0);
});
test("storage unavailable fails before any remote reservation", async () => {
  const s = setup(); await assert.rejects(s.make({ storage: { getItem: () => null, setItem: () => { throw Error("quota"); } } }).run(s.inputs), /quota/);
  assert.equal(s.requests.length, 0);
});
test("pause preserves acknowledged progress and reopen does not require media for status", async () => {
  const s = setup(); let uploader;
  uploader = s.make({ onProgress: r => { if (r.state === "uploading") uploader.pause(); } });
  const paused = await uploader.run(s.inputs); assert.equal(paused.state, "paused"); assert.equal(s.effects.length, 1);
  assert.equal((await s.make().inspect()).state, "paused");
  assert.equal((await s.make().run(s.inputs)).state, "staged");
});
test("binary execution forwards exact headers/no JSON and rejects fake success, handles auth loss", async () => {
  const calls = []; let status = 200, payload = { state: "receipt_recorded" };
  const api = new StudioAPI("/studio/api", async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(payload), { status }); });
  api.csrfToken = "fixture-csrf"; const body = new Blob(["abc"]);
  await api.executeStagedOperation("/test", 2, body, "bytes 0-2/3");
  assert.equal(calls[0].body, body); assert.equal(calls[0].headers["X-Upload-Fence"], "2");
  assert.equal(calls[0].headers["Content-Range"], "bytes 0-2/3"); assert.equal(calls[0].headers["X-CSRF-Token"], "fixture-csrf");
  assert.equal(calls[0].redirect, "error"); assert.equal(calls[0].credentials, "same-origin");
  payload = {}; await assert.rejects(api.executeStagedOperation("/test", 2), /did not confirm/);
  let unauthorized = false; api.onUnauthorized = () => { unauthorized = true; }; status = 401;
  await assert.rejects(api.executeStagedOperation("/test", 2)); assert.equal(unauthorized, true);
});

test("retained completed files remain inspectable after write expiry without authorizing new effects", async () => {
  const s = setup();
  await s.make().run(s.inputs);
  const effects = s.effects.length, prepares = s.prepares.length;
  s.remote.blocked = true; // Expired reservation: receipts remain, no write permit.
  const record = await s.make().inspect();
  assert.equal(record.state, "staged");
  assert.ok(Object.values(record.progress).every(file => file.stored));
  await assert.rejects(s.make().run(s.inputs), /uncertain or expired/);
  assert.equal(s.effects.length, effects);
  assert.equal(s.prepares.length, prepares);
});

test("retained partial upload stays blocked after write expiry", async () => {
  const s = setup({ lostExecute: true });
  await assert.rejects(s.make().run(s.inputs), /lost execute/);
  s.remote.blocked = true;
  assert.equal((await s.make().inspect()).state, "blocked");
  assert.equal(s.effects.length, 1);
});
