# Effects preview and delete — review-ready

## Outcome

- Explosion and Viking now render their animated WebP thumbnails as images; Pipe remains a decoded WebM video thumbnail.
- Every library item says **Delete**. Deletion opens a native modal: Cancel makes no mutation, while confirmation performs the API delete.
- Deleting a built-in writes a durable hidden marker. It removes that effect from both Effects and Recording after reload without deleting the bundled original or any retained author replacement media.

## Evidence

- `node --check app/static/studio.js` passed.
- `node --test tests/studio-effects-ui.test.mjs` passed: 2 tests.
- `.venv/bin/pytest -q tests/test_effects_library.py` passed: 12 tests.
- Disposable authenticated local Playwright fixture passed. `runtime-result.json` records visible Explosion/Viking/Pipe previews, cancelled Viking deletion remaining listed, and confirmed fixture deletion absent from Effects and Recording after reload. It preserved all three built-ins.

## Review/deployment gate

This changes durable effects persistence and is release-significant. An independent Sol review of the persistence contract is required before deployment. No push or deployment was performed.

## Routing

The assigned implementation lane is `gpt-5.6-terra` with isolated context, but runtime-model metadata was not available in this continuation and is therefore unverified.
