# Chessground review fixes

**Base implementation:** `91795a7777f10b3315b7f1981f90e351a5b8b38c`
**Fix phase:** 2026-09-25
**Runtime model metadata:** unknown (not exposed in this isolated worker context)

## Resolved findings

- **CG-001 — lifecycle:** `createStudioBoard` now destroys its Chessground
  instance before clearing the host, restores the original host class, and
  creates a new instance for the next populated position. The empty learner
  preview calls this adapter lifecycle path instead of directly assigning to
  the mounted host's `innerHTML`.
- **CG-002 — keyboard/accessibility:** resolved by the correction below.

### CG-002 correction

The initial CG-002 implementation incorrectly decorated Chessground's
transient `square` highlight elements. The adapter now owns a stable,
visually-hidden 8×8 semantic grid instead: the visible host is the one
focusable `role="grid"` controller, retains focus with
`aria-activedescendant`, and exposes all 64 named `gridcell`s at rest. It
synchronizes piece names, selected origin, legal destinations, lock state, and
orientation-aware arrow-key navigation. Enter/Space selects or submits through
the existing `onMove` path; the adapter calls Chessground's selection API only
to retain its visual move feedback. The visible board remains one Chessground
board, including its existing pointer/right-draw behavior.

## Focused evidence

- `node --check app/static/studio-chessground.mjs` — passed
- `node --check app/static/studio.js` — passed
- `node --test tests/studio-chessground.test.mjs` — passed (adapter DOM-harness
  empty → populated → interactive lifecycle, destroy/recreate, accessible
  square names, legal destination semantics, and keyboard move entry)
- `git diff --check` — passed

The retained real-vendor Playwright fixture must be rerun after this correction
with focus on the board controller, a 64-cell-at-rest assertion, and keyboard
move entry; its earlier `cg-board square` selector intentionally does not
represent the stable semantic layer.

No production course data was changed and no deployment was performed. Desktop
right-button drawing remains owned by Chessground's existing drawable
configuration; palette and move handling remain unchanged.
