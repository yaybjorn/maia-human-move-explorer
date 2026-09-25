# Studio User Games race repair

Date: 2026-09-25
Finding closed: `STUDIO-UG-001`

## Repair

- Added a monotonic User Games request generation and synchronous course-scoped reset.
- `openCourse` invalidates and clears User Games state as soon as the selected course changes.
- `loadUserGames` now resolves course reconciliation before considering an existing load, then fences success, failure, and final render/loading mutations by the captured request generation and course ID.
- A stale request can neither populate rows/cursors nor clear the active course's loading state, including when it rejects.

## Focused verification

- `node --test tests/studio-api.test.mjs tests/studio-layout.test.mjs tests/studio-user-games-race.test.mjs` — 26 passed.
- `node --check app/static/studio.js` — passed.
- `git diff --check` — passed.

`tests/studio-user-games-race.test.mjs` uses controllable deferred promises to cover:

1. course A request, switch to B, then stale A resolve;
2. B initial response followed by cursor-based page-two append;
3. course A request, switch to B, then stale A rejection.

No deployment, authentication changes, course writes, backend changes, or infrastructure changes were made.
