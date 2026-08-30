# Maia Human Move Explorer agent contract

This repository owns the public, unlisted Maia web tools at `maia.fablelabs.no`.

## Channel scope

`#opening_drill` (`1526981218833403995`) is the canonical product channel for:

- `/check` — reusable PGN repertoire-gap analysis;
- `/spellcheck` — local British English checking and correction for PGN comments;
- `/portsmouth` — Portsmouth Gambit White trainer;
- `/kilkenny` — Kilkenny Gambit White trainer;
- shared Maia/Stockfish behavior and UI used by those routes.

In that channel, a request referring to “the checker,” “the check page,” `/check`, or `/spellcheck` means this repository. Work on these routes is Opening Drill product work and does not require returning to `#brain` unless it introduces workspace-wide infrastructure, security-sensitive exposure, paid infrastructure, a separate repository/service, or another product’s scope.

Read `docs/opening-drill-handoff.md` before changing these routes.

## Product rules

- Annotated standard-start PGNs are the authoring source. Preserve complete move history for Maia.
- Maia represents likely human play; Stockfish represents objective evaluation. Keep them visibly and technically separate.
- Do not add FEN-only analysis to the trainers or checker unless explicitly requested; history-aware analysis is the point.
- Keep the site public but unlisted: HTTPS, `noindex`, `nofollow`, `noarchive`, and inference rate limiting remain enabled.
- No paid infrastructure may be added without founder approval and cost options.
- The service and exact deployed source remain public under AGPL. Do not deploy uncommitted source.
- Preserve the accepted Cburnett pieces, cream/green board palette, fixed 8×8 squares, and mobile-friendly layout unless a redesign is explicitly requested.
- Every CSS chessboard grid must constrain both axes with `repeat(8,minmax(0,1fr))`, and every square must use `min-width:0`, `min-height:0`, and clipped overflow. Do not rely on `repeat(8,1fr)` or implicit rows: SVG intrinsic sizing can stretch the grid on mobile Safari.

## Implementation and verification

- Canonical repo: `/Users/odin/.openclaw/workspace/repos/web/maia-human-move-explorer`
- Default branch: `main`
- Local checks: `.venv/bin/pytest -q`, `.venv/bin/ruff check app tests`, and `node --check` for touched JavaScript.
- Production deploys clone committed `main` into a timestamped release and atomically update `/opt/maia-human-move-explorer/current` on `fablelabs-web-1`.
- After deployment, verify `/healthz`, the exact affected public route, and at least one live functional request. Visual or interaction changes also require desktop and mobile runtime review.
- Preserve unrelated working-tree changes and the untracked local `output/` directory.
