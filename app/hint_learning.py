"""Private, revision-fenced learning from authoritative Studio draft saves.

A pre-save journal bridges the independent course and review databases. The
journal is never itself evidence of a save; reconciliation requires a fresh,
authenticated read of exactly the succeeding revision. Retrieval rechecks each
source against its current authoritative saved draft.
"""
import json
import os
import sqlite3
import uuid

from .hint_saved import saved_hint_occurrences
from .hint_studio import schema


def learning_schema(conn):
    schema(conn)
    conn.execute("""CREATE TABLE IF NOT EXISTS hint_learning_journal (
        id TEXT PRIMARY KEY, course_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL, base_hash TEXT NOT NULL, before_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
    conn.execute("CREATE INDEX IF NOT EXISTS hint_learning_journal_course ON hint_learning_journal(course_id,state)")
    conn.execute("""CREATE TABLE IF NOT EXISTS hint_learning_examples (
        course_id TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL,
        revision_hash TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(course_id,identity))""")
    conn.execute("CREATE TABLE IF NOT EXISTS hint_learning_watermarks (course_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)")


def identity(item):
    return json.dumps([item["chapterID"], item["moves"], item["answer"]], separators=(",", ":"))


def excluded(course_id, actor_id):
    courses = set(filter(None, os.getenv("HINT_LEARNING_EXCLUDED_COURSES", "").split(",")))
    actors = set(filter(None, os.getenv("HINT_LEARNING_EXCLUDED_ACTORS", "").split(",")))
    return course_id in courses or actor_id in actors


def stage_save(db, course_id, actor_id, draft, actor_email=""):
    """Journal the verified starting revision before attempting the upstream save."""
    excluded_emails = {value.strip().casefold() for value in os.getenv(
        "HINT_LEARNING_EXCLUDED_EMAILS", "odin-qa@fablelabs.no").split(",") if value.strip()}
    if excluded(course_id, actor_id) or actor_email.strip().casefold() in excluded_emails:
        return None
    revision, digest = draft.get("revision"), draft.get("revisionHash")
    if type(revision) is not int or not isinstance(digest, str) or not digest:
        raise ValueError("Missing authoritative draft revision")
    before = draft
    with sqlite3.connect(db, timeout=5) as conn:
        learning_schema(conn)
        # Keep journal bounded and never replace an unresolved attempt.
        count = conn.execute("SELECT COUNT(*) FROM hint_learning_journal WHERE state='pending'").fetchone()[0]
        if count >= 100:
            raise ValueError("Learning journal is full")
        token = str(uuid.uuid4())
        conn.execute("INSERT INTO hint_learning_journal(id,course_id,actor_id,base_revision,base_hash,before_json) VALUES (?,?,?,?,?,?)",
                     (token, course_id, actor_id, revision, digest, json.dumps(before, ensure_ascii=False)))
    return token


def discard_stage(db, token):
    if token is None:
        return
    with sqlite3.connect(db, timeout=5) as conn:
        learning_schema(conn)
        conn.execute("UPDATE hint_learning_journal SET state='aborted', before_json='{}' WHERE id=? AND state='pending'", (token,))


def quarantine_stage(db, token, course):
    """Exclude an unparseable receipt without blocking ordinary future saves."""
    with sqlite3.connect(db, timeout=5) as conn:
        learning_schema(conn)
        conn.execute("UPDATE hint_learning_journal SET state='unindexable', before_json='{}' WHERE id=? AND state='pending'", (token,))
        conn.execute("DELETE FROM hint_learning_examples WHERE course_id=?", (course,))


def _reviews(conn, course_id, revision, base_hash, item, actor, reviews):
    """Return (applied approved candidate, generated texts) for one source."""
    approved = None
    generated = set()
    for review in reviews:
        if (review.get("revision") != revision or review.get("revisionHash") != base_hash or review.get("chapterID") != item["chapterID"]
                or review.get("moves") != item["moves"] or review.get("answer") != item["answer"]):
            continue
        for candidate in review.get("candidates", []):
            generated.add(candidate.get("text", "").casefold())
            if candidate.get("status") != "approved":
                continue
            events = conn.execute("SELECT action FROM hint_review_events WHERE review_id=? AND candidate_id=? AND actor_id=? ORDER BY version",
                                  (review["id"], candidate["id"], actor)).fetchall()
            actions = [event[0] for event in events if event[0] in {"approve", "reject", "edit", "apply_intent"}]
            if actions and actions[-1] == "apply_intent" and "approve" in actions:
                approved = {"reviewID": review["id"], "candidateID": candidate["id"],
                            "rating": candidate.get("rating", 0), "approvedText": candidate.get("text", "")}
    return approved, generated


def reconcile_stage(db, token, receipt):
    """Reconcile an exact successful save; anything ambiguous is discarded.

    Only an authenticated exact immutable backend receipt proves the save.
    Current-source validation still happens separately at retrieval.
    """
    if token is None:
        return False
    with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
        learning_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT course_id,actor_id,base_revision,base_hash,before_json,state FROM hint_learning_journal WHERE id=?", (token,)).fetchone()
        if not row or row[5] != "pending":
            conn.execute("COMMIT")
            return False
        course, actor, revision, digest, before_json, _ = row
        earlier = conn.execute("SELECT 1 FROM hint_learning_journal WHERE course_id=? AND state='pending' AND base_revision<? LIMIT 1", (course, revision)).fetchone()
        if earlier:
            conn.execute("COMMIT")
            return False
        # The immutable backend receipt, not the presence of a journal or a
        # latest-draft read, proves this exact save committed.
        if (receipt.get("receiptID") != token or receipt.get("courseID") != course
                or receipt.get("actorID") != actor or receipt.get("revision") != revision + 1
                or not isinstance(receipt.get("revisionHash"), str)
                or not isinstance(receipt.get("document"), dict)):
            conn.execute("COMMIT")
            return False
        current = {**receipt["document"], "revision": receipt["revision"], "revisionHash": receipt["revisionHash"]}
        watermark = conn.execute("SELECT revision FROM hint_learning_watermarks WHERE course_id=?", (course,)).fetchone()
        if watermark and watermark[0] >= current["revision"]:
            conn.execute("UPDATE hint_learning_journal SET state='superseded', before_json='{}' WHERE id=?", (token,))
            conn.execute("COMMIT")
            return False
        previous = {identity(x): x for x in saved_hint_occurrences(json.loads(before_json))}
        after = {identity(x): x for x in saved_hint_occurrences(current)}
        prior_rows = conn.execute("SELECT identity,record FROM hint_learning_examples WHERE course_id=?", (course,)).fetchall()
        prior = {key: json.loads(raw) for key, raw in prior_rows}
        reviews = conn.execute("SELECT record,revision FROM hint_reviews WHERE course_id=? ORDER BY revision DESC LIMIT 2001", (course,)).fetchall()
        # Fail closed rather than overlook older generated lineage if this
        # bounded review scan would be incomplete.
        if len(reviews) > 2000:
            raise ValueError("Too many reviews to establish provenance")
        historical = [{**json.loads(raw), "revision": saved_revision} for raw, saved_revision in reviews]
        reviews_by_identity = {}
        for review in historical:
            key = json.dumps([review.get("chapterID"), review.get("moves"), review.get("answer")], separators=(",", ":"))
            reviews_by_identity.setdefault(key, []).append(review)
        decisions = {key: _reviews(conn, course, revision, digest, item, actor, reviews_by_identity.get(key, []))
                     for key, item in after.items()}
        shared_applied = {(item["positionKey"], item["text"]): decisions[key][0]
                          for key, item in after.items() if decisions[key][0]}
        shared_ambiguous = {item["positionKey"] for key, item in after.items() if decisions[key][1]}
        generated_text = {c.get("text", "").casefold() for review in historical for c in review.get("candidates", [])}
        conn.execute("DELETE FROM hint_learning_examples WHERE course_id=?", (course,))
        for key, item in after.items():
            old = previous.get(key)
            existing = prior.get(key)
            applied, generated = decisions[key]
            applied = applied or shared_applied.get((item["positionKey"], item["text"]))
            prior_review = bool(reviews_by_identity.get(key))
            if old and old["text"] == item["text"]:
                record = existing if existing and existing.get("text") == item["text"] else None
            elif applied:
                record = {**item, "kind": "ai_assisted_hint", "provenance": applied}
            elif existing and existing.get("kind") == "ai_assisted_hint" and old and existing.get("text") == old["text"]:
                # Later editorial changes retain lineage; they do not become handwritten.
                record = {**item, "kind": "ai_assisted_hint", "provenance": existing["provenance"]}
            elif generated or item["positionKey"] in shared_ambiguous or item["text"].casefold() in generated_text or prior_review:
                # Unapplied/draft/rejected and untracked historical suggestions
                # make attribution ambiguous, including shared occurrences.
                record = None
            else:
                record = {**item, "kind": "manual_hint", "provenance": {"actorID": actor}}
            if record:
                record.update({"courseID": course, "actorID": actor, "revision": current["revision"], "revisionHash": current["revisionHash"]})
                conn.execute("INSERT INTO hint_learning_examples(course_id,identity,revision,revision_hash,record) VALUES (?,?,?,?,?)",
                             (course, key, current["revision"], current["revisionHash"], json.dumps(record, ensure_ascii=False)))
        conn.execute("INSERT INTO hint_learning_watermarks(course_id,revision) VALUES (?,?) ON CONFLICT(course_id) DO UPDATE SET revision=excluded.revision", (course, current["revision"]))
        conn.execute("UPDATE hint_learning_journal SET state='reconciled', before_json='{}' WHERE id=?", (token,))
        conn.execute("COMMIT")
    return True


def pending_stages(db, course_id=None):
    with sqlite3.connect(db, timeout=5) as conn:
        learning_schema(conn)
        return conn.execute("SELECT id,course_id,base_revision FROM hint_learning_journal WHERE state='pending' AND (? IS NULL OR course_id=?) ORDER BY base_revision,created_at LIMIT 100", (course_id, course_id)).fetchall()


async def recover_stages(db, request, upstream_read, course_id=None):
    """Reconcile recoverable exact receipts using the current superadmin session."""
    from fastapi import HTTPException

    blocked = set()
    for token, course, base_revision in pending_stages(db, course_id):
        if course in blocked:
            continue
        try:
            receipt = await upstream_read(request, f"courses/{course}/draft-receipts/{token}")
            reconcile_stage(db, token, receipt)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            # If the authoritative draft has advanced, this CAS can no longer
            # commit; a missing immutable receipt means it was not this save.
            latest = await upstream_read(request, f"courses/{course}")
            if (latest.get("draft") or {}).get("revision", -1) > base_revision:
                discard_stage(db, token)
            else:
                blocked.add(course)
        except (ValueError, TypeError):
            # Studio allows temporarily invalid drafts. Do not index a partial
            # parse or let one invalid receipt strand every later save.
            quarantine_stage(db, token, course)
