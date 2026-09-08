# Private staged upload — disabled local integration

This is an author-only **staged bytes** flow, not video validation, draft selection,
publication, a purchaser grant, or native download readiness. No deployment or enablement
is part of this increment. `PRIVATE_UPLOADS_ENABLED = false` in the client and the
literal `STUDIO_PRIVATE_UPLOADS_ENABLED=true` requirement independently gate both
the Maia proxy and the Worker. No configuration enables either server gate.

## Explicit author wire

Browser base `/studio/api/courses/:courseUUID/offline-video/uploads` proxies only to
the same backend's `/v1/studio/courses/:courseUUID/offline-video/uploads`.
All responses are no-store. Existing Studio cookie, Origin, CSRF and authenticated
superadmin checks remain; no credential is returned or persisted by this integration.

1. `POST base` with `{revision,title,video:{byteLength,mimeType},thumbnail:{byteLength,mimeType}}`.
   Revision is the saved **course draft** revision. Returns
   `{uploadID,revision:0,expiresAt,maxChunkBytes:8388608,state:'reserved'}`.
2. `GET base/:uploadID/operations` is **owner-only, read-only recovery**:

   ```ts
   {
     uploadID, draftRevision, title, expiresAt, revision,
     files: {
       video: { byteLength, offset, created, stored,
         parts: [{partNumber,offset,byteLength,sha256}] },
       thumbnail: { /* same allowlisted structure */ }
     },
     blocked: boolean,
     operation: null | {
       token: {id,uploadID,fence,deadlineAt},
       intent: {kind,action,partNumber?,offset?,byteLength?,sha256?}
     }
   }
   ```

   No keys, multipart IDs, provider ETags, receipts or credentials are serialized.
   A token is reconstructed only for the exact active immutable operation that is
   still prepared, unissued, unexpired and unquarantined under the database clock.
   This is **not a permit**; the unchanged atomic one-shot issue fence remains final
   authority. Expired/issued/uncertain states never return an executable token.
   Readback remains available after a draft/price change; mutations remain denied.
   Concurrent readback may conservatively lose a later prepare/issue CAS; it cannot
   authorize duplicate provider work. The client never treats a timeout as absence.
3. `POST base/:uploadID/operations` with `{revision,intent}` prepares an immutable
   intent. This revision is the **upload operation** revision. Actions are
   `create_multipart`, `upload_part`, `complete_multipart`; kind is `video` or
   `thumbnail`. Only parts include `{partNumber,offset,byteLength,sha256}`.
   Returns `{operation:{id,uploadID,fence,deadlineAt}}`.
4. `PUT base/:uploadID/operations/:operationID` executes that exact token with
   `X-Upload-Fence`. Create/complete have no body. Parts have raw bounded bytes,
   `Content-Type: application/octet-stream`, exact `Content-Range: bytes start-end/total`
   and exact Content-Length. The Worker independently verifies length/SHA-256 before
   issuing the one provider effect. Acknowledgement uses `state:'receipt_recorded'`.
5. `GET base/:uploadID` retains the earlier safe progress schema.

There is **no** `/uploads/:id/complete` playable-asset endpoint. Explicit multipart
completion stores one file only. The earlier one-call `/video`/`thumbnail` sketch
is not supported. Native purchaser grant/manifest wire is unchanged.

## Reopen, retry and file identity

The browser hashes each selected file in at most 8 MiB parts, sequentially, before
reservation. Persisted metadata contains the owner/course/draft/upload identity,
title, exact file sizes/MIME claims, part ranges/SHA-256 fingerprints and acknowledged
progress — no media bytes, cookies, CSRF, grants or provider credentials. Browser
storage failure stops new reservations. Stored filenames are not required or saved.

Resume requires reselecting **both exact files**, rehashing every part and matching
all saved fingerprints plus immutable server acknowledged/prepared part metadata.
MIME is only an admission claim, never decode evidence. Server progress is checked
before every mutation. A lost prepare response is recovered through the read-only
operation endpoint without replacement. A lost execute acknowledgement is reconciled:
successful work advances, still-prepared exact work may retry, issued/quarantined work
stops. No automatic mutation retries, fence resets, expiry takeovers or orphan deletion.
Pause finishes/reconciles the current operation; reopening does not require local
files merely to read acknowledged progress. The same-tab controller is single-flight;
cross-tab races still face backend CAS/fencing and body admission.

**Known safe limitation:** a lost *initial reservation* acknowledgement has no returned
upload ID. The client keeps `reservation_unconfirmed` and refuses automatic replacement;
manual owner-side investigation is required. This increment only adds lost-*prepare*
ack recovery. Clearing browser storage also loses full-file fingerprints and is not
a supported way to resume an old namespace. Explicit reservation-denial 4xx responses
clear only that local unconfirmed reservation record, permitting a later user retry;
network/5xx uncertainty retains it. No quota reclamation policy is added here.

## Proxy bounds and existing UI

The dedicated async proxy streams input with backpressure, never `request.body()` or
disk staging: 8 MiB maximum exact binary part; 4 KiB JSON; four active requests per
process; 30-second input idle and 100-second total budget. Response bytes are bounded
at 128 KiB, identity-encoded; redirects are rejected. Real Worker auth/policy remains
authoritative. Browser requests have a 110-second deadline. `httpx>=0.27,<1` moves from
the existing test extra to runtime; no version range change or remote install occurred.

Both nginx templates have a nested upload-only location with 8 MiB limit, HTTP/1.1,
request/response buffering off and bounded timeouts. The ordinary Studio 2 MiB JSON
prefix, login limits, FEN runtime-proof path and all other routes are unchanged.
The location is prepared locally only; **real nginx syntax/loading and live network
streaming remain unverified** because this increment neither deploys nor uses the
OCR host. Per-process/per-isolate admission is not a global ingress or total heap bound.

The additive Videos card uses existing form/button classes. Free/unsupported course
upload inputs are disabled with “Private video uploads are available for paid courses
only.” Dirty drafts must be saved before starting. The existing `courseVideo` YouTube
editor and ordered `videos[]` code/data remain untouched. The controller never calls
draft-save, select or publish. Completed bytes say **“Files staged — awaiting validation.
Not selected for this course or published.”** Screenshots and real browser interaction
are separate future enabled-fixture/live acceptance gates; the default-off page is not
claimed as an enabled production flow.
