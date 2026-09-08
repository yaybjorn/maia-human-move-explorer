# Studio video-to-FEN operations

## Author workflow

In a saved course, open **Videos → Extract positions from video**. Select the distinct main
Course video, a supplemental link, or another YouTube video. Start extraction;
the job remains associated with the course, creating author, saved revision,
video identity, source hash and pinned extraction version. Leaving and reopening
Studio does not cancel it. Jobs and review decisions never save or publish course
content and never replace PGN/game identity.

After completion, review screened candidates, all consecutive position changes,
or raw observations. A result seeks the video in absolute seconds and previews
piece placement; uncertain orientation stays labelled. Accept/reject decisions
are explicit, revision-checked private job annotations. Changing the saved course
revision or attached video makes old jobs read-only/stale, but their results and
exports remain available. An unsaved draft cannot start or review a job.

CSV downloads use `timestamp_seconds;fen`: one numeric seconds field and one
**piece-placement-only** FEN field. Raw includes all detected boards; changes only
compress consecutive observations, never later revisits. Screened candidates are
lossy heuristic suggestions, not certified correct positions. Reviewed exports
contain only explicitly accepted segments. Full gzip JSON evidence retains all
sampled model slots, absence, multiple boards and uncertainty. No turn, castling,
en-passant, move counters, hidden-board reconstruction or automatic publication
is inferred.

Sampling is 1 Hz; short-lived positions can be missed. Public YouTube access may
fail because a source is removed, restricted or challenges the host. Jobs then
fail with a readable message without changing course data. There is no browser
cookie import, authentication bypass or file upload in this version. A bounded
local-file fallback is future work, not a claimed supported flow.

## Existing-host deployment

The worker runs privately on the existing Maia VM, not a new service/listener.
Main HTTP requests do not import ONNX/OpenCV/NumPy or execute extraction.

1. Commit and push the reviewed integration to public `main`. Exact recognizer,
   weights, licenses and acquisition pins are in [video-ocr-provenance.md](video-ocr-provenance.md).
2. Run the committed `scripts/install-video-worker.sh` as root on the existing
   host. It installs Debian's ffmpeg/ffprobe package and Python venv support,
   pinned Node into `video-runtime/bin`, and CPU dependencies in a separate
   `video-runtime/venv`. It does not alter Maia's existing Python environment,
   app configuration, listener or running process.
3. Prepare the pinned model using `scripts/prepare-video-ocr.sh`, verifying its
   SHA-256. Place it at `cache/video-models/yolo26m-finetuned.onnx`, readable by
   the existing `maia` account. Run a short actual Linux inference and verify
   host memory, free disk and concurrent existing interactive requests.
4. `scripts/enable-video-worker.sh` atomically preserves existing environment
   settings and adds the private runtime paths. It does not print credentials
   or restart anything.
5. Use the normal committed atomic `scripts/update.sh` release path. Verify
   `/healthz`, existing functional requests and exact deployed commit.
6. Verify `/studio/api/source` and `/studio/api/source/recognizer` redirect to
   the exact public deployed commit. Exercise a real authenticated author job
   and desktop/mobile review/seek/export; isolated browser fixtures alone are
   not evidence of real authentication or production extraction.

## Limits, durability and recovery

SQLite/job artifacts live in `cache/video-extractions`, mode 0700 for `maia`,
inside the existing systemd writable cache path. Existing backend sessions,
superadmin authorization, CSRF/origin checks and course revisions remain the
source of authority. Jobs and downloads are private to their creating author.
No permanent author credential is stored or inherited by worker subprocesses.

One persistent low-priority supervisor owns an exclusive flock; one extraction
child runs at a time, with one CPU affinity and ONNX/OpenCV/BLAS thread. The child
inherits the lock and Linux parent-death SIGKILL. App lifespan checks supervisor
liveness every ten seconds. On interruption, a replacement marks unfinished
running jobs failed; queued jobs remain durable. Authors can retry explicitly.
Cancellation terminates the child process group; it never produces a completed
result from partial artifacts. Normal app restarts stop the systemd control group;
new code then reopens the durable queue. Do not launch a parallel OCR supervisor
or change deployed source underneath an active standalone worker.

Bounds: global eight active jobs, two per author; finished videos ≤3h, downloader
≤720p and 350MiB; external processing watchdog 6h; child address space 2GiB and
single-file size 450MiB. Runtime adds codec/container/timestamp validation,
1080p/60fps maximum, 512MiB cumulative uncompressed evidence and a six-hour
wall guard. On the existing shared-core e2-medium, sustained reference processing
can take about five hours; short burst-speed smoke timings are not a full-job estimate.
The private store caps at 800MiB and stops admission/progress below
700MiB host free space; engine admission requires 768MiB free. The lower bound
that fails first wins, with a truthful failure instead of a successful partial
export. Monitor actual host space before starting long work.

Downloaded sources are removed after completion/failure/cancellation. An optional
operator-seeded reference source under `sources/{videoID}.mp4` is reused only when
its sibling JSON `videoID` and `sha256` match the actual bytes. Client paths are
never accepted. Cached **source bytes**, not prior OCR outputs, may feed a new job.

Completed evidence/reviews are retained; there is no silent automatic deletion.
When capacity is exhausted, existing results remain readable and new jobs fail
closed. Operators must agree an archival/removal policy before deleting author
artifacts; do not delete active jobs, unrelated caches or releases to force a run.
Runtime installation adds roughly 1GiB including model/reference cache on this
host; check actual disk rather than treating that as a guaranteed footprint.

For a rollback, use the existing previous-release atomic path. Setting
`STUDIO_VIDEO_EXTRACTION_ENABLED=0` then performing the normal app restart disables
new extraction API activity without deleting private job data. Do not restart the
OpenClaw gateway or modify remote access to operate this feature.
