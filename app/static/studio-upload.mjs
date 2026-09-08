// Staged bytes only. Never edits a course document or asserts playable readiness.
export const PRIVATE_UPLOADS_ENABLED = false;
export const CHUNK_BYTES = 8 * 1024 ** 2;
export const FREE_UPLOAD_EXPLANATION = "Private video uploads are available for paid courses only.";
const KINDS = ["video", "thumbnail"];
const PRODUCTS = { "cowboy-kilkenny": "com.gingergm.openingdrill.cowboy.kilkenny", "version-2-kilkenny-gambit": "com.gingergm.openingdrill.version.2.kilkenny.gambit" };
export function paidUploadCourse(metadata = {}) {
  const product = Object.hasOwn(PRODUCTS, metadata.slug) && PRODUCTS[metadata.slug];
  return Boolean(product && (Object.hasOwn(metadata, "priceTier")
    ? ["usd-4.99", "usd-9.99", "usd-19.99"].includes(metadata.priceTier)
    : metadata.access === "subscriber" && metadata.purchaseProductID === product));
}
function requireValue(ok, message) { if (!ok) throw new Error(message); }
export async function hashBytes(blob) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}
// Independent bounded reads: no full-video buffer, object URL, credential or bytes in storage.
export async function fingerprint(file, kind) {
  requireValue(file && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= (kind === "video" ? 2 * 1024 ** 3 : 2 * 1024 ** 2), "Choose a video up to 2 GiB and a thumbnail up to 2 MiB.");
  requireValue((kind === "video" ? ["video/mp4"] : ["image/png", "image/jpeg"]).includes(file.type), "Choose an MP4 video and a PNG or JPEG thumbnail.");
  const parts = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const byteLength = Math.min(CHUNK_BYTES, file.size - offset);
    parts.push({ partNumber: parts.length + 1, offset, byteLength, sha256: await hashBytes(file.slice(offset, offset + byteLength)) });
  }
  return { byteLength: file.size, mimeType: file.type, parts };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function matchingPart(a, b) {
  return a && b && ["partNumber", "offset", "byteLength", "sha256"].every(key => a[key] === b[key]);
}
export class StagedUpload {
  constructor({ api, storage, courseID, actorID, revision, metadata, onProgress = () => {} }) {
    Object.assign(this, { api, storage, courseID, actorID, revision, metadata, onProgress });
    requireValue(courseID && actorID, "Sign in and open a saved course first.");
    this.key = `gingergm-staged-upload-v1:${actorID}:${courseID}`;
    this.path = `/courses/${encodeURIComponent(courseID)}/offline-video/uploads`;
    this.busy = false; this.paused = false;
  }
  load() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    requireValue(raw.length <= 100000, "Saved upload progress is invalid.");
    const record = JSON.parse(raw);
    requireValue(record.schema === 1 && record.courseID === this.courseID && record.actorID === this.actorID, "Saved upload belongs to another course or author.");
    return record;
  }
  save(record) { this.storage.setItem(this.key, JSON.stringify(record)); this.onProgress(record); }
  pause() { this.paused = true; }
  request(path, options = {}) { return this.api.request(path, { ...options, signal: AbortSignal.timeout(110000), redirect: "error" }); }
  async inspect() {
    const record = this.load();
    if (!record) return null;
    if (!record.uploadID) return record; // Lost reservation ack: never create a replacement automatically.
    const remote = await this.request(`${this.path}/${encodeURIComponent(record.uploadID)}/operations`);
    this.validateRemote(record, remote);
    record.progress = this.progress(remote);
    // Read-only completion evidence survives expiry of permission to write.
    // run() still denies blocked recovery before preparing/executing any effect.
    record.state = KINDS.every(k => remote.files[k].stored) ? "staged" : remote.blocked ? "blocked" : "paused";
    this.save(record); return record;
  }
  progress(remote) { return Object.fromEntries(KINDS.map(kind => [kind, { offset: remote.files[kind].offset, byteLength: remote.files[kind].byteLength, stored: remote.files[kind].stored }])); }
  validateRemote(record, remote) {
    requireValue(remote?.uploadID === record.uploadID && remote.draftRevision === record.draftRevision && remote.title === record.title && Number.isSafeInteger(remote.revision), "Server upload identity did not match saved progress.");
    for (const kind of KINDS) {
      const expected = record.files[kind], actual = remote.files?.[kind];
      requireValue(actual && actual.byteLength === expected.byteLength && Array.isArray(actual.parts) && actual.parts.length <= expected.parts.length, "Server file identity did not match the selected bytes.");
      requireValue(actual.parts.every((part, index) => matchingPart(part, expected.parts[index])) && actual.offset === actual.parts.reduce((n, p) => n + p.byteLength, 0), "Server part fingerprints did not match the selected bytes.");
      requireValue(!actual.stored || actual.offset === actual.byteLength, "Server storage acknowledgement is incomplete.");
    }
    if (remote.operation) {
      const { token, intent } = remote.operation;
      requireValue(token?.uploadID === record.uploadID && token.fence === remote.revision && KINDS.includes(intent?.kind), "Prepared operation identity mismatch.");
      if (intent.action === "upload_part") requireValue(matchingPart(intent, record.files[intent.kind].parts[intent.partNumber - 1]), "Prepared bytes differ from the selected file.");
      else requireValue(["create_multipart", "complete_multipart"].includes(intent.action), "Unknown prepared operation.");
    }
  }
  async run({ video, thumbnail, title }) {
    requireValue(!this.busy, "An upload is already running in this tab.");
    requireValue(paidUploadCourse(this.metadata), FREE_UPLOAD_EXPLANATION);
    this.busy = true; this.paused = false;
    let record;
    try {
      const files = { video: await fingerprint(video, "video"), thumbnail: await fingerprint(thumbnail, "thumbnail") };
      requireValue(!this.paused, "Upload paused before any new operation.");
      record = this.load();
      if (record) {
        requireValue(record.uploadID, "The reservation response was lost. Its outcome needs checking; a replacement was not created.");
        requireValue(record.draftRevision === this.revision, "The course draft changed. This staged upload cannot continue against a different revision.");
        requireValue(same(record.files, files), "Select the exact same video and thumbnail to resume this upload.");
      } else {
        title = String(title || "").trim();
        requireValue(title.length > 0 && title.length <= 200 && !/[\u0000-\u001f\u007f]/.test(title), "Enter a video title (up to 200 characters).");
        record = { schema: 1, courseID: this.courseID, actorID: this.actorID, draftRevision: this.revision, title, files, state: "reservation_unconfirmed" };
        this.save(record); // Must persist recovery before any reservation; quota/storage failure stops here.
        let response;
        try {
          response = await this.request(this.path, { method: "POST", body: { revision: this.revision, title, video: { byteLength: files.video.byteLength, mimeType: files.video.mimeType }, thumbnail: { byteLength: files.thumbnail.byteLength, mimeType: files.thumbnail.mimeType } } });
        } catch (error) {
          // These explicit route denials precede successful reservation. A lost
          // response/5xx is different: retain uncertainty, never create a replacement.
          if ([400, 401, 403, 404, 409, 413, 429].includes(error.status)) this.storage.removeItem(this.key);
          throw error;
        }
        requireValue(/^[a-f0-9-]{36}$/.test(response?.uploadID) && response.maxChunkBytes === CHUNK_BYTES, "The server did not confirm a compatible upload reservation.");
        record.uploadID = response.uploadID; record.state = "paused"; this.save(record);
      }
      const path = `${this.path}/${encodeURIComponent(record.uploadID)}/operations`;
      // Every iteration reconciles owner evidence. No automatic mutation retry on error.
      for (let step = 0; step < 600; step++) {
        const remote = await this.request(path); this.validateRemote(record, remote);
        record.progress = this.progress(remote);
        if (remote.blocked) { record.state = "blocked"; this.save(record); throw new Error("Upload outcome is uncertain or expired. It will not be repeated; existing progress is retained."); }
        if (KINDS.every(kind => remote.files[kind].stored)) { record.state = "staged"; this.save(record); return record; }
        if (this.paused) { record.state = "paused"; this.save(record); return record; }
        record.state = "uploading"; this.save(record);
        let operation = remote.operation;
        if (!operation) {
          const kind = KINDS.find(k => !remote.files[k].stored), file = remote.files[kind];
          const intent = !file.created ? { kind, action: "create_multipart" } : file.offset === file.byteLength
            ? { kind, action: "complete_multipart" }
            : { kind, action: "upload_part", ...files[kind].parts[file.parts.length] };
          const prepared = await this.request(path, { method: "POST", body: { revision: remote.revision, intent } });
          operation = { token: prepared?.operation, intent };
          this.validateRemote(record, { ...remote, revision: operation.token?.fence, operation });
        }
        const { token, intent } = operation;
        const body = intent.action === "upload_part" ? { video, thumbnail }[intent.kind].slice(intent.offset, intent.offset + intent.byteLength) : undefined;
        if (body) requireValue(await hashBytes(body) === intent.sha256, "Selected bytes changed; this operation was not executed.");
        await this.api.executeStagedOperation(`${path}/${encodeURIComponent(token.id)}`, token.fence, body,
          body ? `bytes ${intent.offset}-${intent.offset + intent.byteLength - 1}/${files[intent.kind].byteLength}` : undefined);
      }
      throw new Error("Upload operation limit reached. Progress is retained.");
    } catch (error) {
      if (record?.uploadID && record.state !== "blocked") { record.state = "paused"; this.save(record); }
      throw error;
    } finally { this.busy = false; }
  }
}
