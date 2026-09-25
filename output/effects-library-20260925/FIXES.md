# Effects library review fixes — candidate `96f03f49be17bc5b7399035e4db720ead8d5f742`

## Closed ledger

- **H1:** Normalization now explicitly selects the `libvpx-vp9` decoder before
  the input and encodes `yuva420p`. The focused regression generates a source
  with a first alpha byte near 64, decodes with `libvpx-vp9`, normalizes, then
  decodes again and asserts the normalized alpha remains non-opaque.
- **H2:** Every create, rename, replacement, and delete holds an in-process
  async lock plus an advisory `flock` file lock for the entire staged-media and
  index transaction. Index state is freshly read only while held. All staging
  names are `mkstemp`-unique. Spawned-process mixed-mutation coverage runs
  rename/replace, rename/delete, and replace/delete against the same durable
  directory and verifies no resurrection, lost retained rename, orphaned media,
  or staging files. Parallel-create coverage remains in place.
- **M1:** Transcoding has a dedicated bounded admission semaphore (default one
  encode; host-configurable maximum two) and FFmpeg is explicitly limited to
  two encoder threads (bounded to four). A cancelled request now shields and
  awaits the active `to_thread` worker before it releases the admission permit
  or outer mutation transaction; the cancellation regression proves a second
  encode cannot enter early and handler staging is cleaned afterward.
- **M2:** Interrupted streams remove their staging files. Create rolls back
  installed media on index failure. Replacement copies old media to a private
  rollback file and restores it if index commit fails. Delete moves media to a
  reversible tombstone, restores index and media on tombstone unlink failure,
  and only completes after both sides succeed.

## Focused evidence

- `.venv/bin/pytest -q tests/test_effects_library.py` — **11 passed**.
- `.venv/bin/ruff check app/effects_library.py tests/test_effects_library.py`
  — **passed**.
- `git diff --check` — **passed**.

The tests cover alpha preservation, concurrent creates, interrupted stream
cleanup, create index-write failure, replacement index-write rollback, delete
unlink rollback, cancellation worker lifetime/staging cleanup, and real
cross-process mixed mutations. Existing non-Effects diagnostics were not
rerun; their baseline failures remain unrelated to this candidate.

## Outstanding constraints

- This candidate is not deployed. Runtime compositing over the chessboard and
  durable-directory ownership/capacity/backup verification remain deployment
  prerequisites.
- The cross-process lock relies on local advisory `flock`, appropriate for the
  single-host durable directory; it requires the deployed effects directory to
  be on a filesystem honoring POSIX locks.
- Independent Sol re-review is required before deployment.
