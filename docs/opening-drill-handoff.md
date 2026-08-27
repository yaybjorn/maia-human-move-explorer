# Opening Drill web tools handoff

## Ownership

The Maia web tools are part of GingerGM Opening Drill product work and are handled in `#opening_drill` (`1526981218833403995`). The source repository is `yaybjorn/maia-human-move-explorer`; production is `https://maia.fablelabs.no` on the existing Fable Labs VM with no added paid infrastructure.

## Routes

- `/check`: Simon uploads a standard-start PGN and finds probable opponent replies not covered by PGN variations or explicitly named in position comments.
- `/spellcheck`: Simon checks PGN comments in British English, applies individual suggestions, and downloads a corrected copy.
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

1. Inspect this document, the affected route, and its tests.
2. Implement in this repository without changing Opening Drill iOS/backend unless the request requires it.
3. Run Python tests/lint and JavaScript syntax checks.
4. Commit and push exact source before deployment to preserve AGPL source parity.
5. Deploy atomically with the existing update script; do not restart the OpenClaw gateway.
6. Verify live API behavior and the affected desktop/mobile UI.

## Likely next work

Requests for improvements to `/check` should begin by reviewing the live results with a representative PGN and deciding whether the ranking, filtering, explanations, board interaction, or export/handoff format best helps Simon address repertoire gaps. Do not assume a redesign or add paid compute without evidence.
