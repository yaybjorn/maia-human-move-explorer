import { StagedUpload, PRIVATE_UPLOADS_ENABLED, paidUploadCourse, FREE_UPLOAD_EXPLANATION } from "./studio-upload.mjs?v=20260923-chapters";

export function createUploadPanel({ api, getContext, root, enabled = PRIVATE_UPLOADS_ENABLED, storage, onStaged = () => {} }) {
  let uploader = null, contextKey = null, staged = null, busy = false;
  const find = id => root.querySelector(`[data-upload="${id}"]`);
  const message = text => { find("status").textContent = text; };
  const thumbnail = () => new Blob([
    new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,8,215,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,174,66,96,130])
  ], { type: "image/png" });
  function renderProgress(record) {
    // Reconciliation is deliberately read-only. Show it only while there is
    // saved unfinished work; it cannot create or repeat an upload operation.
    find("check").hidden = !["reservation_unconfirmed", "paused", "blocked", "uploading"].includes(record.state);
    if (record.progress) {
      find("progress").max = record.progress.video.byteLength + record.progress.thumbnail.byteLength;
      find("progress").value = record.progress.video.offset + record.progress.thumbnail.offset;
    }
    if (record.state === "staged") return message("Checking video…");
    const p = record.progress;
    const bytes = p ? p.video.offset + p.thumbnail.offset : 0;
    const total = record.files.video.byteLength + record.files.thumbnail.byteLength;
    find("progress").max = total; find("progress").value = bytes;
    message(record.state === "reservation_unconfirmed" ? "Reservation not confirmed. Its outcome must be checked before another upload."
      : record.state === "blocked" ? "Upload needs attention: an operation is uncertain or expired. No operation will be repeated."
        : record.state === "uploading" ? "Uploading video…" : "Choose the same video to continue upload.");
  }
  function controls(context) {
    const paid = context && (context.chapterID || paidUploadCourse(context.metadata));
    for (const id of ["title", "video", "thumbnail", "start"]) find(id).disabled = !paid || busy || Boolean(context?.dirty);
    find("check").disabled = busy || !uploader;
    find("pause").disabled = !busy;
    if (!paid) message(FREE_UPLOAD_EXPLANATION);
    else if (context.dirty && !busy) message("Save the chapter before uploading a video.");
  }
  function refresh() {
    root.hidden = !enabled;
    if (!enabled) return;
    const context = getContext();
    const key = context && `${context.actorID}:${context.courseID}:${context.revision}:${context.chapterID || ""}`;
    if (key !== contextKey) {
      if (staged && (!context || staged.actorID !== context.actorID || staged.courseID !== context.courseID || staged.chapterID !== (context.chapterID || null))) staged = null;
      uploader?.pause(); uploader = null; contextKey = key;
      find("video").value = ""; find("thumbnail").value = ""; find("title").value = "";
      if (context) {
        try {
          uploader = new StagedUpload({ api, storage: storage ?? globalThis.localStorage, ...context, onProgress: record => { if (`${record.actorID}:${record.courseID}:${record.draftRevision}:${record.chapterID || ""}` === contextKey) renderProgress(record); } });
          const record = uploader.load();
          if (record) { staged = record.state === "staged" ? { key: uploader.key, actorID: context.actorID, courseID: context.courseID, chapterID: context.chapterID || null } : null; find("title").value = record.title; renderProgress(record); }
          else { find("check").hidden = true; message("Choose an MP4 video to upload."); }
        } catch { message("Upload progress storage is unavailable. No upload was started."); }
      }
    }
    controls(context);
  }
  async function uploadSelectedVideo() {
    if (!enabled || busy || !uploader) return;
    const context = getContext();
    if (!context || context.dirty || !(context.chapterID || paidUploadCourse(context.metadata))) return refresh();
    const video = find("video").files?.[0];
    if (!video) return;
    busy = true; const current = uploader; controls(context);
    message("Preparing video…");
    try { const record = await current.run({ title: context.chapterTitle || "Chapter video", video, thumbnail: thumbnail() }); if (current === uploader && record?.state === "staged") { staged = { key: current.key, actorID: context.actorID, courseID: context.courseID, chapterID: context.chapterID || null }; await onStaged(record); } }
    catch (error) { if (current === uploader) message(error.message); }
    finally { busy = false; controls(getContext()); }
  }
  find("start").addEventListener("click", uploadSelectedVideo);
  find("video").addEventListener("change", uploadSelectedVideo);
  find("check").addEventListener("click", async () => {
    if (!enabled || busy || !uploader) return;
    const current = uploader; busy = true; controls(getContext());
    try { const record = await current.inspect(); if (!record) message("No saved upload for this course."); else if (current === uploader && record.state === "staged") await onStaged(record); }
    catch (error) { if (current === uploader) message(error.message); }
    finally { busy = false; controls(getContext()); }
  });
  find("pause").addEventListener("click", () => { uploader?.pause(); message("Pausing after the current operation is reconciled. Acknowledged progress will be kept."); });
  function startNew() {
    if (busy || !uploader) throw new Error("Wait for the current upload or validation to finish.");
    const record = uploader.load();
    if (record && record.state !== "staged") throw new Error("Resume or reconcile the unfinished upload before starting another.");
    const context = getContext();
    const matchingStaged = staged && context && staged.actorID === context.actorID && staged.courseID === context.courseID && staged.chapterID === (context.chapterID || null);
    if (matchingStaged) (storage ?? globalThis.localStorage).removeItem(staged.key);
    else if (record) (storage ?? globalThis.localStorage).removeItem(uploader.key);
    staged = null;
    uploader = null; contextKey = null; refresh();
  }
  return { refresh, startNew, clear: () => { uploader?.pause(); uploader = null; contextKey = null; root.hidden = true; } };
}
