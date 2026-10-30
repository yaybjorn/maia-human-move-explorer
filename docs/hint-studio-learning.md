# Hint Studio editorial references

Saving the course draft is required. A suggestion becomes eligible only after it
is approved, applied and saved; applying alone does not save the course. Edit a
suggestion in the review and approve it again before applying. Later editorial
corrections to an applied hint retain its AI-assisted lineage. Newly written,
saved manual hints may also become examples. Unapproved or rejected generated
suggestions and unresolved provenance are excluded. Ratings are recorded as
editorial context; a rating alone neither approves nor admits a suggestion.

At generation time, eligible examples are checked against current accessible
saved courses, deduplicated and selected for relevance. Removed, superseded,
archived, inaccessible and rejected sources do not remain good examples.
Original imported course hints are also checked against their current source;
separately imported prose remains style context. The review shows source and
manual/AI-assisted provenance. References are private context for a single
request, not model retraining. Nothing is published automatically.

The dedicated Studio QA account is excluded by default. Operators can add
comma-separated IDs to `HINT_LEARNING_EXCLUDED_COURSES` and
`HINT_LEARNING_EXCLUDED_ACTORS`, and emails to
`HINT_LEARNING_EXCLUDED_EMAILS` (include `odin-qa@fablelabs.no` when
setting the latter). Set course exclusions before creating test content, and
use isolated private databases for automated tests. Exclusions must remain set
while test courses exist. Pending uncertain saves are reconciled only against an
immutable backend receipt; without one they never qualify. If the private
journal reaches its bounded limit, saving is stopped before a backend write and
an operator must reconcile the pending entries.
