import { StagedUpload, PRIVATE_UPLOADS_ENABLED, paidUploadCourse, FREE_UPLOAD_EXPLANATION } from "./studio-upload.mjs";

export function createUploadPanel({ api, getContext, root, enabled = PRIVATE_UPLOADS_ENABLED, storage }) {
  let uploader = null, contextKey = null, busy = false;
  const find = id => root.querySelector(`[data-upload="${id}"]`);
  const message = text => { find("status").textContent = text; };
  function renderProgress(record) {
    if (record.progress) {
      find("progress").max = record.progress.video.byteLength + record.progress.thumbnail.byteLength;
      find("progress").value = record.progress.video.offset + record.progress.thumbnail.offset;
    }
    if (record.state === "staged") return message("Files staged — awaiting validation. Not selected for this course or published.");
    const p = record.progress;
    const bytes = p ? p.video.offset + p.thumbnail.offset : 0;
    const total = record.files.video.byteLength + record.files.thumbnail.byteLength;
    find("progress").max = total; find("progress").value = bytes;
    message(record.state === "reservation_unconfirmed" ? "Reservation not confirmed. Its outcome must be checked before another upload."
      : record.state === "blocked" ? "Upload needs attention: an operation is uncertain or expired. No operation will be repeated."
        : `${record.state === "uploading" ? "Uploading" : "Paused"} · ${bytes.toLocaleString()} of ${total.toLocaleString()} bytes acknowledged. ${record.state === "uploading" ? "" : "Reselect the same files to resume."}`);
  }
  function controls(context) {
    const paid = context && paidUploadCourse(context.metadata);
    for (const id of ["title", "video", "thumbnail", "start"]) find(id).disabled = !paid || busy || Boolean(context?.dirty);
    find("check").disabled = busy || !uploader;
    find("pause").disabled = !busy;
    if (!paid) message(FREE_UPLOAD_EXPLANATION);
    else if (context.dirty && !busy) message("Save draft changes before staging a video. Uploads do not save or publish your draft.");
  }
  function refresh() {
    root.hidden = !enabled;
    if (!enabled) return;
    const context = getContext();
    const key = context && `${context.actorID}:${context.courseID}:${context.revision}`;
    if (key !== contextKey) {
      uploader?.pause(); uploader = null; contextKey = key;
      find("video").value = ""; find("thumbnail").value = ""; find("title").value = "";
      if (context) {
        try {
          uploader = new StagedUpload({ api, storage: storage ?? globalThis.localStorage, ...context, onProgress: record => { if (`${record.actorID}:${record.courseID}:${record.draftRevision}` === contextKey) renderProgress(record); } });
          const record = uploader.load();
          if (record) { find("title").value = record.title; renderProgress(record); }
          else message("Stage an MP4 video and PNG or JPEG thumbnail. Validation is required before the course can use them.");
        } catch { message("Upload progress storage is unavailable. No upload was started."); }
      }
    }
    controls(context);
  }
  find("start").addEventListener("click", async () => {
    if (!enabled || busy || !uploader) return;
    const context = getContext();
    if (!context || context.dirty || !paidUploadCourse(context.metadata)) return refresh();
    busy = true; const current = uploader; controls(context);
    message("Checking file fingerprints… Keep these files available to resume later.");
    try { await current.run({ title: find("title").value, video: find("video").files[0], thumbnail: find("thumbnail").files[0] }); }
    catch (error) { if (current === uploader) message(error.message); }
    finally { busy = false; controls(getContext()); }
  });
  find("check").addEventListener("click", async () => {
    if (!enabled || busy || !uploader) return;
    const current = uploader; busy = true; controls(getContext());
    try { if (!await current.inspect()) message("No saved upload for this course."); }
    catch (error) { if (current === uploader) message(error.message); }
    finally { busy = false; controls(getContext()); }
  });
  find("pause").addEventListener("click", () => { uploader?.pause(); message("Pausing after the current operation is reconciled. Acknowledged progress will be kept."); });
  return { refresh, clear: () => { uploader?.pause(); uploader = null; contextKey = null; root.hidden = true; } };
}
