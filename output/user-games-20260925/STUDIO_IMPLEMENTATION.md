# Studio User Games implementation

## Scope

- Added the authenticated, read-only Studio proxy allowlist for `courses/{courseUUID}/user-games`.
- Added a course-scoped **User games** sidebar view with the backend's `limit` and `cursor` pagination contract.
- Displays provider, submitted time, optional message, and a hardened external game link.
- Messages are HTML-escaped. Links are accepted only for HTTPS Lichess or Chess.com origins and open with `noopener noreferrer`.
- No PGN import, course mutation, public listing, or backend changes were added.

## Verification

- `node --test tests/studio-api.test.mjs tests/studio-layout.test.mjs` — 24 passing.
- `.venv/bin/pytest -q tests/test_api.py -k 'course_studio_page or user_games_proxy'` — 2 passing.
- `node --check app/static/studio.js`, `node --check app/static/studio-api.mjs`, and Python compilation passed.
- Desktop fixture: opened a selected course, navigated to **User games**, verified the active view, a Lichess HTTPS URL, `target="_blank"`, `rel="noopener noreferrer"`, visible pagination, and literal rendering of a hostile-looking message. See `fixture-desktop.png` and `fixture-desktop.mjs`.

## Release status

Implementation only. No deployment was performed; the integrated auth/data change requires independent review before release.
