# Opening Drill web tools handoff

## Ownership

The Maia web tools are part of GingerGM Opening Drill product work and are handled in `#opening_drill` (`1526981218833403995`). The source repository is `yaybjorn/maia-human-move-explorer`; production is `https://maia.fablelabs.no` on the existing Fable Labs VM with no added paid infrastructure.

## Routes

- `/check`: Simon uploads a standard-start PGN and finds probable opponent replies not covered by PGN variations or explicitly named in position comments.
- `/spellcheck`: Simon checks PGN comments in British English, applies individual suggestions, and downloads a corrected copy.
- `/chapters`: Simon loads a current GingerGM course, names its learning chapters, and moves contiguous chapter boundaries before downloading a version-controlled manifest.
- `https://ggm.fablelabs.no/`: authenticated end-to-end course authoring for superadmins, including PGN import,
  blank-course creation, board/tree editing, Maia and Stockfish suggestions, writing checks,
  chapters, validation, publication, and immutable version history.
- `/portsmouth`: White repertoire trainer built from the approved Portsmouth pack.
- `/kilkenny`: White repertoire trainer built from Simon’s Kilkenny PGN.
- `/`: general history-aware Maia move explorer with PGN variations and separate Stockfish analysis.

## `/check` current behavior

- Inputs: PGN, White/Black repertoire side, opponent rating 500–3000, probability threshold 5–50%.
- Current default threshold: 30%.
- If the PGN contains comments, checking starts at the first commented position on each line; moves used merely to reach the opening are excluded.
- At each opponent-to-move position, Maia scores all legal moves using the complete ancestral move sequence.
- A reply is covered when it exists as a PGN variation or its SAN/UCI is explicitly mentioned in the position comment.
- Findings show a fixed 8×8 board, move history, uncovered replies and probabilities, existing PGN replies, comments, reach probability, missing probability mass, and Stockfish evaluation.
- Priority is `reach probability × missing probability mass`; findings below 0.5% are hidden.
- Positions where Stockfish already evaluates the repertoire side at +2.0 or better are hidden, with excluded counts shown.
- Findings are sorted by descending priority score, then earlier ply.
- Custom-FEN PGNs and malformed PGNs are rejected. Malformed comment braces receive a human-readable error.

## `/spellcheck` current behavior

- PGN comments receive a British English spelling and grammar check grouped by move history.
- Harper runs entirely in the browser; comment text is not sent to a third-party writing service.
- Square-bracketed PGN directives and black-move ellipsis notation are excluded. Known course terms are preloaded, and authors can persistently ignore additional names in their own browser.
- Each proposed replacement has its own fix button. A custom-fix control also accepts any replacement text when the preferred wording is not suggested. Fixes update the original uploaded PGN without reformatting its moves, headers, variations, or untouched comments.
- The corrected PGN downloads as a separate `-fixed.pgn` file; the uploaded file is never overwritten.

## `/chapters` current behavior

- The current course catalogue and packs are loaded through a narrow server-side proxy to the public GingerGM course API.
- Chapter headers can be dragged to any boundary in the stable learning order. Chapters may also be added, removed, and renamed.
- The editor previews each position and warns when a chapter falls outside the suggested 16–32 move range.
- A local pack or existing manifest can be imported. The result downloads as `<pack-id>-chapters.json` for review and commit beside the course PGN and metadata.
- The editor never writes directly to production. Backend compilation validates full coverage, uniqueness, and unchanged learning order before a manifest can ship.

## `/studio` architecture

The public authoring URL is `https://ggm.fablelabs.no/`. The legacy
`https://maia.fablelabs.no/studio` route redirects there; the internal API prefix remains
`/studio/api` so existing clients and backend route contracts stay stable.

- The browser never receives backend proxy credentials. FastAPI allowlists Studio routes and
  injects `X-Studio-Proxy-Secret` from the host environment when proxying to the GingerGM Worker.
- Login uses an HttpOnly same-origin session cookie. Mutations require the session CSRF token and
  a validated same-origin `Origin`; auth tokens are never stored in browser storage.
- Every save first exports the current structured variation tree to PGN locally. Publication is
  blocked if comments, NAGs, bracket directives, or nested variations cannot be exported.
- Imported and saved drafts send the PGN once; hydrated editor nodes are rebuilt from that source
  when opened. The author chooses White or Black before an import creates a course. A browser-local
  recovery snapshot protects unsaved edits without becoming a publication authority.
- Maia, Stockfish, spellcheck, and coverage results remain suggestions until an author explicitly
  accepts a change. Results for an older board position cannot be applied.
- Chapter dividers use temporary authoring node IDs in `chapterDrafts`. Validation returns compiled
  preview positions, after which the browser resolves boundaries to canonical `sha256:` position
  IDs before the final save and publication. Dividers can start at every training position and can
  be moved with drag, touch-friendly step buttons, or the keyboard.
- Learner preview is chapter-aware and interactive: answers remain hidden until an attempted move,
  authored wrong feedback is exercised, and only a correct move enables the next position.
- Published versions are immutable. Restore creates a new working draft and does not alter the live
  catalogue until the author publishes again.

## Trainer behavior

- The learner plays White and must find the authored repertoire move.
- Wrong moves leave the position unchanged and show feedback.
- After a correct move, Maia chooses among authored Black branches, weighted by the selected opponent rating.
- Click-to-move and pointer drag-and-drop both work. White/Black moves animate without duplicate ghosts or board flashes.
- At the end of a line, Stockfish 18 reveals the final White-perspective evaluation and continuation, then offers restart.
- Portsmouth uses its compiled authored pack. Kilkenny uses its separate PGN-derived repertoire tree. Do not merge their data.

## Architecture

- FastAPI/Python backend; browser clients are plain HTML/CSS/JavaScript.
- Maia-3 5M runs server-side on CPU with complete move history and a bounded 2,048-entry cache keyed by history and ratings.
- Stockfish 18 runs server-side with a 500 ms budget, three lines where applicable, and a separate 2,048-position cache.
- One application worker is intentional because model inference is an in-process singleton guarded by a lock.

## Safe change loop

Use the proportional verification tiers in the repo-local `AGENTS.md`.

1. Inspect this document, the affected route, and the complete proposed diff.
2. Implement in this repository without changing Opening Drill iOS/backend unless the request requires it.
3. For a micro presentation-only fix, use the fast lane: cheapest relevant static check, atomic deploy, `/healthz`, and exact live-element verification. Do not validate the catalogue or all course positions.
4. For scoped behaviour, run directly affected tests and exercise the exact live flow.
5. For publication, course data, PGN/compiler, auth, shared behaviour or infrastructure, use the full relevant suites, data validation and independent QA.
6. Commit and push exact source before deployment to preserve AGPL source parity; do not restart the OpenClaw gateway.

## Likely next work

Requests for improvements to `/check` should begin by reviewing the live results with a representative PGN and deciding whether the ranking, filtering, explanations, board interaction, or export/handoff format best helps Simon address repertoire gaps. Do not assume a redesign or add paid compute without evidence.
