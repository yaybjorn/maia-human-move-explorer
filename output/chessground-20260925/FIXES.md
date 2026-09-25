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
- **CG-002 — keyboard/accessibility:** the single rendered Chessground board
  now exposes its actual squares as roving-focus keyboard controls. Arrow keys
  move focus in the displayed orientation; Enter/Space selects a legal origin
  or submits a legal destination; Escape clears selection. Each square has a
  square/piece accessible name, selected origin state, and legal-destination
  context. Keyboard selection and destination highlights use the existing
  cream/green board and do not add a second visual board.

## Focused evidence

- `node --check app/static/studio-chessground.mjs` — passed
- `node --check app/static/studio.js` — passed
- `node --test tests/studio-chessground.test.mjs` — passed (adapter DOM-harness
  empty → populated → interactive lifecycle, destroy/recreate, accessible
  square names, legal destination semantics, and keyboard move entry)
- `git diff --check` — passed

No production course data was changed and no deployment was performed. Desktop
right-button drawing remains owned by Chessground's existing drawable
configuration; palette and move handling remain unchanged.
