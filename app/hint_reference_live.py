"""Select private references only while their source remains current and accessible."""
import asyncio
import json
import sqlite3

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from .hint_learning import excluded, learning_schema
from .hint_saved import saved_hint_occurrences


def _learning_records(db):
    with sqlite3.connect(db, timeout=5) as conn:
        learning_schema(conn)
        records = []
        for (raw,) in conn.execute("SELECT record FROM hint_learning_examples ORDER BY revision DESC LIMIT 2000"):
            record = json.loads(raw)
            if excluded(record["courseID"], record.get("actorID", "")):
                continue
            if record["kind"] == "ai_assisted_hint":
                provenance = record["provenance"]
                row = conn.execute("SELECT record FROM hint_reviews WHERE id=? AND course_id=?", (provenance["reviewID"], record["courseID"])).fetchone()
                if not row:
                    continue
                review = json.loads(row[0])
                candidate = next((c for c in review.get("candidates", []) if c.get("id") == provenance["candidateID"]), None)
                if not candidate or candidate.get("status") != "approved":
                    continue
                rows = conn.execute("SELECT action FROM hint_review_events WHERE review_id=? AND candidate_id=? ORDER BY version", (provenance["reviewID"], provenance["candidateID"])).fetchall()
                actions = [row[0] for row in rows if row[0] in {"approve", "reject", "edit", "apply_intent"}]
                if not actions or actions[-1] != "apply_intent":
                    continue
            records.append(record)
        return records


async def eligible_references(request, upstream_read, evidence, imported, db):
    """Return bounded, deduplicated examples and independent imported prose.

    Missing, inaccessible, archived, changed, or invalid source courses fail
    closed. Source identity and text are checked against authoritative drafts on
    every call, including when an imported occurrence has since been removed.
    """
    prose = [r for r in imported if r.get("kind") == "style_prose"][:2]
    candidates = [r for r in imported if r.get("kind") == "handwritten_hint"]
    for record in _learning_records(db):
        candidates.append({"kind": record["kind"], "text": record["text"],
                           "san": record["san"], "piece": record["piece"],
                           "source": json.dumps({"courseID": record["courseID"],
                                                 "chapterID": record["chapterID"],
                                                 "revision": record["revision"],
                                                 "provenance": record["provenance"]}, sort_keys=True),
                           "occurrences": [{"courseID": record["courseID"], "chapterID": record["chapterID"],
                                            "positionKey": record["positionKey"]}]})
    candidates = [r for r in candidates if r.get("text") and all(o.get("positionKey") != evidence["position_key"] for o in r.get("occurrences", []))]
    candidates.sort(key=lambda r: (r.get("san") == evidence["answer"]["san"],
                                    r.get("piece") == evidence["answer"]["piece"],
                                    r.get("kind") == "ai_assisted_hint", r.get("kind") != "handwritten_hint"), reverse=True)
    # Limit source reads even for a large imported corpus. The order is relevant
    # first; no inaccessible or excluded source can authorize another source.
    course_ids = []
    for record in candidates:
        for occurrence in record.get("occurrences", []):
            course = occurrence.get("courseID")
            if isinstance(course, str) and not excluded(course, "") and course not in course_ids:
                course_ids.append(course)
            if len(course_ids) >= 50:
                break
        if len(course_ids) >= 50:
            break
    semaphore = asyncio.Semaphore(4)

    async def read(course):
        try:
            async with semaphore:
                payload = await upstream_read(request, f"courses/{course}")
            if (payload.get("course") or {}).get("status") == "archived":
                return course, []
            return course, await run_in_threadpool(saved_hint_occurrences, payload.get("draft") or {})
        except (HTTPException, ValueError, TypeError, KeyError):
            return course, []

    current = dict(await asyncio.gather(*(read(course) for course in course_ids)))
    selected, seen = [], set()
    for ref in candidates:
        occurrences = [o for o in ref.get("occurrences", []) if any(
            item["chapterID"] == o.get("chapterID") and item["positionKey"] == o.get("positionKey")
            and item["text"] == ref["text"] for item in current.get(o.get("courseID"), []))]
        normalized = " ".join(ref["text"].split()).casefold()
        if occurrences and normalized not in seen:
            seen.add(normalized)
            selected.append({"kind": ref["kind"], "text": ref["text"][:600], "source": ref["source"],
                             "occurrences": occurrences[:25]})
            if len(selected) >= 3 and any(item["kind"] in {"handwritten_hint", "manual_hint"} for item in selected):
                break
    # Keep a human-origin anchor in the bounded prompt; corrected AI examples
    # are useful but must not recursively displace every original reference.
    chosen = selected[:3]
    if not any(item["kind"] in {"handwritten_hint", "manual_hint"} for item in chosen):
        human = next((item for item in selected if item["kind"] in {"handwritten_hint", "manual_hint"}), None)
        if human:
            chosen = [*chosen[:2], human]
    return [*chosen, *prose]
