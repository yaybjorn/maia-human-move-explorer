# Studio video OCR: runtime, source and licensing

## Exact recognizer provenance

| Component | Pinned source |
| --- | --- |
| Board/FEN postprocessor | [AndrewSpano/2d-chess-ocr at 94d6a8157524825fcfda4f27c430577eec04b356](https://github.com/AndrewSpano/2d-chess-ocr/tree/94d6a8157524825fcfda4f27c430577eec04b356) |
| Distributed pretrained model | [Model repository at 03d9df9fc14fade1a3579683fd0de215b3864ee1](https://huggingface.co/AndrewSpano/2d-chess-ocr/tree/03d9df9fc14fade1a3579683fd0de215b3864ee1) |
| Model file | `yolo26m-finetuned.onnx` |
| Model SHA-256 | `a8e78afa8e00cd7ee39a941f888327bd85a12c3cf5c2140a4fa882ea3f7abff7` |
| Exporter recorded in model | Ultralytics 8.4.56; static float32 1×3×640×640 input, 1×300×6 output; end-to-end/NMS-free |
| Model's exact embedded license string | `AGPL-3.0 License (https://ultralytics.com/license)` |

`app/video_ocr/model-metadata.json` preserves the inspected exact model metadata.
`scripts/prepare-video-ocr.sh` accepts an existing cached model or fetches only the
public pinned revision. Both paths verify the exact SHA-256 before atomically
replacing the model. No model weights, video source, credential, or environment
is committed to this repository.

`app/video_ocr/postprocess.py` vendors the evaluated upstream postprocessor with
its MIT copyright/license in `UPSTREAM-LICENSE`. The unused postponed
`ultralytics.engine.results.Results` annotation import is removed, exactly as in
the evaluated adapter; two comment lines suppress lint on that unused annotation
and one unchanged upstream conditional. Board assignment, piece placement,
orientation and raw turn-guess logic are unchanged. The production runtime
supplies the evaluated fixed 640-pixel letterbox (114 padding), linear resize,
BGR→RGB float32 NCHW/255 preprocessing, confidence threshold 0.25, coordinate
rescaling/clipping and direct CPU ONNX invocation. No extra NMS, chess-legality
repair, training, scene-specific crop, or manually chosen orientation is added.

## Licensing and exact source availability

The upstream repository's LICENSE and model card declare MIT, but the exact ONNX
metadata declares AGPL-3.0. We do **not** describe the model as MIT-cleared based
only on the repository. This service is already AGPL-3.0-or-later; incorporating
the model under its recorded AGPL-3.0 terms is not inherently incompatible and
does not itself require a purchased commercial license.

The integration source, modifications, dependency pins, model acquisition script,
and this provenance record must remain available with the exact committed release
at [yaybjorn/maia-human-move-explorer](https://github.com/yaybjorn/maia-human-move-explorer).
The deployed Studio must retain its prominent source link, resolving to the exact
deployed commit, not merely an unrelated newer branch. Preserve this repository's
AGPL license and upstream MIT notice. Do not deploy an uncommitted runtime.
Deployment verification owns confirming the public source link and actual commit.

The upstream pinned source also includes `model_training/train_yolo.py`,
`model_training/export_yolo.py`, dataset-construction scripts, precomputed labels,
and provenance mappings. The original training images are explicitly not
redistributed by upstream due to copyright. This document records that source
limitation; it does not claim ownership of upstream images or a complete
retrain-from-pixels archive. No training changes, relicensing claim, outreach, or
paid license purchase is part of this implementation. Raw author videos and
private course data are not published as program source.

## Runtime interface and isolation

```python
from app.video_ocr import run_video, VideoOCRError

manifest = run_video(bounded_clip_path, output_dir, model_path,
                     progress=on_progress, cancelled=is_cancelled,
                     source_range={"startSeconds": 19, "endSeconds": 139},
                     acquisition=acquisition_provenance)
```

`bounded_clip_path` and `model_path` are caller-managed local regular files, not URLs.
Every new job requires one explicit finite half-open `[startSeconds,endSeconds)`
interval, `0 <= start < end <= 10800`. End must also be within verified source
metadata duration. Linked playback starts are not game-end boundaries. The worker
rejects historical unbounded jobs before acquisition; their retained results
remain readable. The no-range `run_video` interface remains available only for
frozen offline benchmark compatibility, not a new job path.

Acquisition applies the section before download/decode. Pinned yt-dlp expands its
single `download_ranges` entry through `process_ie_result` (not `process_info`,
which skips range expansion), using `force_keyframes_at_cuts=True`. FFmpeg uses
accurate input seek plus video re-encoding, one decoder/encoder/filter thread,
no audio, and a dynamic output cap no larger than 350 MiB. The cap reserves the
higher 768 MiB engine free-space floor plus 32 MiB for concurrent growth; it is
also bounded by remaining private-store budget. The queue supervisor checks the
same floor and partial acquisition bytes before spawn and once per second,
independently of completion-only FFmpeg download hooks, and kills/waits for the
entire job process group on exhaustion. Linux parent-death cleanup also kills
the job group so a downloader cannot outlive the exclusive queue owner. An operator-seeded, hash-verified full source
cache is accurately section-cut with the same constraints; the recognizer never
decodes that full file. Acquisition/decode fail closed if clip duration differs
from the requested span by more than two frame periods or decoding ends early.
The upstream server may supply neighboring keyframe/container data for seeking;
this is bounded section acquisition, not a promise of exact HTTP byte coverage.
No fallback downloads or scans the full source on section failure.

`acquisition.json` preserves original video ID/URL/duration, optional full-cache
hash, requested interval, cut method, bounded clip metadata and clip SHA-256 after
temporary clip deletion. The same provenance is embedded in `manifest.json`.
The manifest `source_sha256` / job `sourceHash` identifies the **bounded clip**,
not the original complete video (`source_hash_scope=bounded-clip`).
Clip endpoints are quantized to encoded frames; provenance records one frame
period in `cutFrameQuantizationSeconds`. This is not exact appearance timing.
`output_dir` must be empty. `on_progress(dict)` receives `phase`, `progress` from
0 to 1, `frames_processed`, `duration_seconds`, `wall_seconds`, and (after first
sample) `timestamp_seconds`. `is_cancelled()` returns a boolean. Failure raises
`VideoOCRError` with a stable `.code` and safe human message. Only a `completed`
manifest means all results are complete. Partial raw files on cancellation/failure
remain nonterminal evidence, never a successful result. The job layer owns auth,
CSRF, revisions, immutable course/video/source-version binding, concurrency and
review choices; the engine never writes a course, PGN or publication.

Run in a separate, serial worker subprocess. The web request must not load the
model. Install `app/video_ocr/requirements.txt` into a dedicated Python 3.11+
environment; no torch, ultralytics, SAM, training frameworks or Pillow is needed.
The evaluated package versions are retained except NumPy 2.4.6, selected because
evaluated NumPy 2.5.3 requires Python 3.12 and production uses Python 3.11.
Linux x86_64 CPython 3.11 wheels for NumPy 2.4.6 and ONNX Runtime 1.29.0 need
glibc 2.28+; OpenCV 5.0.0.93 also supplies Linux ABI3 wheels. Exact deployment
pins must pass a short real-host fixture inference before a live bounded job.

`ffprobe` on PATH probes media; the existing FFmpeg CLI accurately cuts/acquires
bounded clips. OpenCV's wheel supplies the recognizer's sequential clip decoder.
No new runtime dependency is introduced by range support.
No new public service is introduced. Inference and OpenCV processing/decoding each
use one thread; ONNX spin waits are disabled. Set `OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, and `MKL_NUM_THREADS` to 1 before worker startup. The parent
must also impose a subprocess watchdog and validated memory/CPU limits: Python
cannot reliably interrupt a native decoder/inference hang. Test virtual-memory
limits against the real host; mmap reservation is not equivalent to resident use.

Engine bounds: 3 hours known duration, 2 GiB local source, 1080p/60 fps maximum,
self-contained MP4/MOV/WebM/MKV/AVI with allowlisted codecs, 768 MiB free at
admission, 512 MiB cumulative uncompressed raw/review output, six-hour internal
wall deadline and bounded decoded-frame count. Parent limits may be stricter.
Source metadata errors, unsupported codecs/timestamps, early decoder EOF,
nonincreasing PTS, model hash mismatch, cancellation and storage exhaustion fail
closed. Independent parent watchdog and storage accounting remain required.

## Sampling, exports and uncertainty

Sequential decoder traversal chooses the first frame at or after each whole
second, using decoder PTS rather than average-FPS arithmetic or repeated seeks.
For bounded jobs, observations retain absolute original-video `timestamp_seconds`
and `requested_timestamp_seconds`: requested start plus normalized clip PTS/sample
bucket. Nonzero first clip PTS is normalized; `opencv_pts_ms`, `first_frame_pts_ms`,
`clip_timestamp_seconds` and `clip_frame_index` preserve local decoder evidence.
`source_frame_index` is null for a clip because its original full-video frame
index is not known. All CSV/review/seek timestamps use original-video seconds,
not clip-relative seconds. End is exclusive even if the decoder supplies an
endpoint frame. Progress/duration/frame bounds cover only the requested interval.
Each separate range gets a fresh accumulator, so disjoint excerpts cannot merge
runs. Sample gaps remain gaps; no duplicate frames fill missing seconds.

| Artifact | Contents |
| --- | --- |
| `raw.jsonl.gz` | Every sampled frame, all 300 unfiltered ONNX slots, accepted boxes, all boards, unmatched pieces, PTS/index, confidence and flags |
| `observations.jsonl` | Same complete observation records except the 300 unfiltered model slots; includes absence and multiple boards |
| `positions.csv` | Every detected board; multiple rows at the same timestamp when multiple boards were detected |
| `positions-changes.csv` | Single-board runs compressed only across consecutive sample buckets; absence, multiple boards and gaps break runs; later revisits survive |
| `positions-screened-draft.csv` | Lossy runs with at least two consecutive observations and no frozen heuristic flags in any observation |
| `segments.json` | IDs, first/last sample time, FEN, observation/flagged counts, union flags, consistent orientation or unknown, screened boolean |
| `review-flags.json` | Every flagged observation and its reasons/low-confidence occupied squares |
| `manifest.json` | Status, source/model/extractor hashes, pinned versions, source metadata, timing, counts and limitations |

Every CSV is exactly `timestamp_seconds;fen` with **piece placement only**.
Exported times identify observations, not certified first appearance. At 1 Hz,
short-lived positions/animations may be missed or misread. Flags are fixed,
pre-existing heuristics: not exactly one board; unknown orientation; orientation
confidence <0.5; board confidence <0.9; any occupied-square confidence <0.8; or
not exactly one king of each color. Empty squares have no calibrated confidence.
Screened is not validated/correct. A drag may escape flags. Unknown orientation
retains the upstream normal-orientation assumption and stays visibly uncertain.
No turn, castling, en-passant or counters are invented; raw upstream turn guesses
are transparent observations, not exported full-FEN fields.

The frozen evaluation found 28/28 independently transcribed settled reference
boards matched, excluding a pawn drag before scoring. That is not a whole-video
accuracy/recall claim. Existing frozen observations at 120 seconds (drag), 607–621
(absence), 1202 (popup), 3262–3263 (unknown orientation), 3952/6020 (multiple boards)
are retained in a compact regression fixture with complete model slots. The
frozen benchmark has not been retuned or rescanned. Runtime evidence belongs in
`artifacts/20260908-studio-video-fen/runtime/`; production timing/impact must be
measured by the deployment owner rather than inferred from the Mac evaluation.

Author workflow, private job limits, deployment and recovery are documented in
[studio-video-extraction.md](studio-video-extraction.md).
