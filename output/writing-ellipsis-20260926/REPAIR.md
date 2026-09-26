# Writing ellipsis repair — 2026-09-26

## Cause

`normalizeHint` used JavaScript `String.prototype.normalize("NFKC")`. NFKC
compatibility-normalises the Unicode ellipsis (`U+2026`, `…`) into three ASCII
full stops (`...`). Hint serialization calls `normalizeHint`, so **Fix all
ellipses** looked clean in the editor but reverted when **Save draft** exported
the hint to `sourcePGN` and a later draft load hydrated it.

## Repair

`normalizeHint` now applies NFKC separately to each non-ellipsis segment and
joins them with the original Unicode ellipsis. This retains existing NFKC and
whitespace folding for all other hint content while preserving intended prose
ellipsis characters. Chess move-number notation such as `1... Nf6` remains
ASCII and is not rewritten.

## Reproduction and verification

Before the repair:

```js
"…".normalize("NFKC") // "..."
```

The focused browser-model regression executes the real Studio
`applyWritingFixAll` handler across eight hint fields, then exercises
`serializeForPGN` → `documentForStorage` (the Save draft payload) →
`hydrateRestoredDocument`. After reload, all eight hints still end in `…`; the
fixture also verifies unchanged `1... Nf6` notation and a NAG.

Focused checks passed:

```text
node --test --test-name-pattern='Fix all ellipses' tests/studio-diagnostics.test.mjs
node --test tests/studio-document.test.mjs tests/writing-check.test.mjs
node --check app/static/studio-document.mjs
.venv/bin/pytest -q tests/test_api.py -k 'pgn_round_trip'
```

The Python API check covers the actual parse/export service boundary with a
Unicode hint ellipsis. No production course data was read, saved, or published.
