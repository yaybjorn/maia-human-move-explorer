# Effects library implementation — 2026-09-25

## Status

Ready for independent Heimdall review. Not deployed.

## Implementation

- Added the authenticated shared `/studio/api/effects` lifecycle: list, create, rename, replace, delete, and private media playback.
- Assets and index live under `STUDIO_EFFECTS_DIR` (default `/opt/maia-human-move-explorer/cache/recording-effects`), outside atomic release directories.
- Uploads are CSRF/origin/role protected, raw-stream size bounded to 25 MB, accept one silent video stream only, decode through ffprobe/ffmpeg, and normalize to VP9 `yuva420p` WebM to preserve alpha in browsers.
- Added compact sidebar Effects manager with pre-save WebM preview over the fixed chessboard palette. Saved items immediately populate Recording’s Effects dropdown.
- Existing Explosion, Viking, Pipe, and Harry paths remain separate. Harry still targets only the first white h-file pawn and is not exposed to library edits.

## Evidence

- `tests/test_effects_library.py`: create → normalized playback → rename → delete; cross-origin mutation rejection; bad name/type rejection.
- `ruff check app tests`, `node --check` for Studio scripts, and focused Studio API/layout tests pass.

## Remaining acceptance

- Heimdall independent review must PASS before deployment.
- Authenticated desktop/mobile live browser lifecycle, fixed-board playback/replay, opacity, and release deployment verification remain intentionally pending review/deploy.

TERMINAL_REPORT
STATUS: FINISHED
SUMMARY: Shared durable Effects library is implemented and review-ready; deployment has not started.
EVIDENCE: Authenticated lifecycle tests, alpha-preserving normalization path, lint and Studio JS/API/layout checks pass.
BLOCKER: Independent Heimdall PASS is required before deploy.
USER_ACTION: Parent should request independent review, then deploy and complete authenticated live QA after PASS.
END_TERMINAL_REPORT
