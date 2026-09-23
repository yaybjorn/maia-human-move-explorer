# Independent chapter authoring

New courses contain ordered `chapterSources`; legacy source-only courses remain
editable without being silently converted. Importing a PGN creates one chapter.
Each chapter has stable identity, its own tree/hints and one optional training
start path. Reordering/renaming never changes compiled position identity.

`GingerGMTrainingStart` PGN tag stores a space-separated UCI ancestral path.
Export retains the complete opening tree, NAGs, comments and `[%hint ...]`.
Only descendants of the selected start become exercises; earlier/sibling
branches stay in the editable/exported PGN. A start must be learner-to-move.
No timestamp mapping or hint-migration/review UI is added.

## Private chapter video

The existing authenticated, bounded R2 upload pipeline handles MP4 and thumbnail
bytes, including pause/resume and uncertain-operation protection. Chapter-first
courses do not require a paid-product mapping. Legacy course upload policy stays
unchanged. Uploading saves the staging association on the chapter; completed
staging alone cannot publish.

The existing Studio host reads the immutable completed R2 object twice: ffprobe
inspects codecs/dimensions/duration, then ffmpeg fully decodes. Both reads stream
via stdin; no video bytes are staged on the host disk. Only fast-start MP4/H.264
with optional AAC audio is supported (2 GB/file, six-hour maximum duration).
A PNG/JPEG thumbnail is currently selected alongside the video. Decode outcomes
are stored as tiny private JSON files under
`/opt/maia-human-move-explorer/cache/chapter-media` (override with
`STUDIO_CHAPTER_MEDIA_DIR`). At most two decoders/four jobs run concurrently.

A domain-separated HMAC using the existing server-only Studio proxy secret binds
the measured media ID/hash/size/duration to the exact course and chapter. The
Worker validates the signature before a draft save; unsigned properties are
ignored. Save draft retains the validated result. Course publication emits only
the chapter video summary, never the attestation or a public URL. Removing a
video affects future draft/publication only; retained R2 bytes are not deleted.

Studio downloads require the existing authenticated superadmin session. A ready
saved reference allows another course author to download it. Ready proofs can be
recovered from the saved Worker draft if the host status cache is lost. A
validation interrupted by restart or expired session is explicitly retryable.

**Native app chapter downloads are not implemented by this change.** The
published chapter media metadata is the input for that separate app/backend
learner-delivery work; the author-only URL is not a learner access mechanism.

## Deployment and acceptance

1. Review exact frontend/backend commits independently.
2. Apply backend migration `0013_chapter_video_count_quota.sql`: up to 100 upload
   reservations/course for chapter-first courses, while preserving existing
   3 GB/course, 4 GB/actor and 8 GB/global byte budgets. Legacy counts stay 4/8.
   No automatic deletion or quota reclamation for issued objects is introduced.
3. Confirm existing `PRIVATE_COURSE_MEDIA` R2 binding and
   `STUDIO_PRIVATE_UPLOADS_ENABLED=true` on Worker and web proxy. Do not configure
   the legacy validated-media-selection/publication gates for this path.
4. Deploy backend then committed web release through normal atomic deployment.
   Existing host `ffprobe` and `ffmpeg` must be on PATH; cache must be writable by
   the `maia` service user. No new dependency or service is needed.
5. Authenticated live acceptance: import two chapter PGNs, distinct hints at the
   same opening, edit/start/export/reimport, rename/reorder/save/reopen, chapter
   checks and whole-course publish. Upload a small actual MP4/thumbnail, wait for
   real validation, save/reopen/download and compare bytes/hash. Repeat one
   failure/retry; inspect desktop/mobile. Remove QA content through supported
   course lifecycle after evidence, never replace the recoverable real backups.

Backups/archival/new Kilkenny creation are coordinator-owned operations, not
performed automatically by application startup or this implementation.
