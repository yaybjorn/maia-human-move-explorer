"""Authenticated Studio extraction endpoints backed by private VM artifacts."""
from __future__ import annotations

import csv
import hmac
import io
import json
import os
import re

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .video_jobs import (
    JobError,
    JobStore,
    canonical_source,
    configured_root,
    kick_worker,
    source_stale,
)

NO_STORE = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive"}


def is_extraction_path(path: str) -> bool:
    parts = path.split("/")
    return len(parts) >= 3 and parts[0] == "courses" and parts[2] == "extractions"


def public_job(job, revision, metadata):
    return {key: value for key, value in {**job, "stale": source_stale(job, revision, metadata)}.items()
            if key not in {"owner", "decisions", "cancelRequested"}}


def read_segments(store, job):
    path = store.directory(job["id"]) / "results" / "segments.json"
    if job["status"] != "completed" or not path.is_file():
        raise JobError(409, "Wait for extraction to finish before reviewing results")
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("segments", [])
    rows = []
    for index, item in enumerate(data):
        row_id = f"segment-{index}"
        flagged = item.get("flagged_observations", 0)
        flags = item.get("flags", [])
        if flagged and not flags:
            flags = ["uncertain_observations"]
        rows.append({**item, "id": row_id,
                     "timestamp_seconds": item.get("first_seen_seconds", item.get("timestamp_seconds", 0)),
                     "flags": flags,
                     "screened": item.get("observations", 0) >= 2 and not flagged and not flags,
                     "decision": job.get("decisions", {}).get(row_id, "unreviewed")})
    return rows


def raw_page(store, job, offset, limit):
    if job["status"] != "completed":
        raise JobError(409, "Wait for extraction to finish before reviewing results")
    path = store.directory(job["id"]) / "results" / "observations.jsonl"
    rows, total = [], 0
    with path.open() as handle:
        for index, line in enumerate(handle):
            total = index + 1
            if not offset <= index < offset + limit:
                continue
            item = json.loads(line)
            boards = item.get("boards", [])
            rows.append({**item, "id": f"raw-{index}",
                         "fen": boards[0].get("fen") if len(boards) == 1 else None,
                         "orientation": boards[0].get("orientation") if len(boards) == 1 else None,
                         "flags": item.get("flags", []), "screened": False,
                         "decision": "unreviewed", "observations": 1})
    return {"rows": rows, "total": total, "offset": offset, "limit": limit}


def result_rows(store, job, kind):
    rows = read_segments(store, job)
    if kind == "screened":
        return [row for row in rows if row["screened"]]
    if kind == "reviewed":
        return [row for row in rows if row["decision"] == "accepted"]
    if kind == "changes":
        return rows
    raise JobError(422, "Unknown extraction result view")


async def dispatch(path, request, upstream_read, allowed_origins):
    try:
        parts = path.split("/")
        if (not 3 <= len(parts) <= 5 or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", parts[1])
                or (len(parts) >= 4 and not re.fullmatch(r"[a-f0-9]{32}", parts[3]))):
            raise JobError(404, "Unknown extraction operation")
        action = parts[4] if len(parts) == 5 else None
        method = request.method
        expected_methods = {None: {"GET", "POST"} if len(parts) == 3 else {"GET"},
                            "results": {"GET"}, "download": {"GET"}, "evidence": {"GET"},
                            "review": {"POST"}, "cancel": {"POST"}}
        if method not in expected_methods.get(action, set()):
            raise JobError(405, "Unsupported extraction operation")
        session = await upstream_read(request, "session")
        user = session.get("user") or {}
        if not session.get("authenticated") or not user.get("id"):
            raise JobError(401, "Sign in to Course Studio")
        if "superadmin" not in user.get("roles", []):
            raise JobError(403, "This account does not have Course Studio access")
        if method != "GET":
            if request.headers.get("origin") not in allowed_origins:
                raise JobError(403, "Cross-origin Studio mutations are forbidden")
            csrf = request.headers.get("x-csrf-token", "")
            expected_csrf = session.get("csrfToken", "")
            if not csrf or not expected_csrf or not hmac.compare_digest(csrf, expected_csrf):
                raise JobError(403, "The Course Studio security token is missing or expired")
        course_id = parts[1]
        course = await upstream_read(request, f"courses/{course_id}")
        draft = course.get("draft", {})
        document = draft.get("document", draft)
        revision = draft.get("revision", course.get("revision", 0))
        metadata = document.get("metadata", {})
        if os.getenv("STUDIO_VIDEO_EXTRACTION_ENABLED") != "1":
            raise JobError(503, "Video extraction is not available on this host yet")
        store = await run_in_threadpool(JobStore, configured_root())
        body = {}
        if method != "GET":
            raw = await request.body()
            if len(raw) > 32768:
                raise JobError(413, "Extraction request is too large")
            try:
                body = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as exc:
                raise JobError(422, "Invalid extraction request") from exc
            if not isinstance(body, dict):
                raise JobError(422, "Invalid extraction request")
            if type(body.get("revision")) is not int or body["revision"] != revision:
                raise JobError(409, "The course changed. Reload and save the current draft first.")
        if len(parts) == 3:
            if method == "GET":
                jobs = await run_in_threadpool(store.list, user["id"], course_id)
                return JSONResponse({"jobs": [public_job(j, revision, metadata) for j in jobs]}, headers=NO_STORE)
            source = canonical_source(body.get("source"), metadata)
            job = await run_in_threadpool(store.create, user["id"], course_id, revision, source,
                                         body.get("requestID"), document.get("sourcePGN", ""))
            kick_worker()
            return JSONResponse({"job": public_job(job, revision, metadata)}, status_code=202, headers=NO_STORE)
        job = await run_in_threadpool(store.get, parts[3], user["id"], course_id)
        if action is None:
            return JSONResponse({"job": public_job(job, revision, metadata)}, headers=NO_STORE)
        if action == "cancel":
            if job["status"] == "queued":
                job = store.update(job["id"], status="cancelled", phase="cancelled", cancelRequested=True)
            elif job["status"] == "running":
                job = store.update(job["id"], cancelRequested=True, phase="cancelling")
            return JSONResponse({"job": public_job(job, revision, metadata)}, headers=NO_STORE)
        if action == "review":
            if source_stale(job, revision, metadata):
                raise JobError(409, "This extraction belongs to an older course/video revision. Start a new extraction to review it.")
            if type(body.get("reviewRevision")) is not int:
                raise JobError(422, "Missing review revision")
            rows = await run_in_threadpool(read_segments, store, job)
            job = await run_in_threadpool(store.review, job["id"], body["reviewRevision"],
                                         body.get("decisions"), {row["id"] for row in rows})
            return JSONResponse({"job": public_job(job, revision, metadata)}, headers=NO_STORE)
        if action == "evidence":
            if job["status"] != "completed":
                raise JobError(409, "Wait for the extraction to finish")
            return FileResponse(store.directory(job["id"]) / "results" / "raw.jsonl.gz",
                                media_type="application/gzip", filename=f"{job['id']}-raw-observations.jsonl.gz",
                                headers=NO_STORE)
        kind = request.query_params.get("kind", "screened")
        if action == "download" and kind != "reviewed":
            filenames = {"screened": "positions-screened-draft.csv", "changes": "positions-changes.csv", "raw": "positions.csv"}
            if kind not in filenames:
                raise JobError(422, "Unknown extraction export")
            if job["status"] != "completed":
                raise JobError(409, "Wait for extraction to finish")
            return FileResponse(store.directory(job["id"]) / "results" / filenames[kind],
                                media_type="text/csv; charset=utf-8",
                                filename=f"{job['source']['videoID']}-{kind}-piece-placement.csv", headers=NO_STORE)
        if action == "download":
            rows = await run_in_threadpool(result_rows, store, job, kind)
            output = io.StringIO(newline="")
            writer = csv.writer(output, delimiter=";", lineterminator="\n")
            writer.writerow(["timestamp_seconds", "fen"])
            for row in rows:
                writer.writerow([row["timestamp_seconds"], row["fen"]])
            return Response(output.getvalue(), media_type="text/csv; charset=utf-8", headers={
                **NO_STORE, "Content-Disposition": f'attachment; filename="{job["source"]["videoID"]}-reviewed-piece-placement.csv"'})
        try:
            offset = int(request.query_params.get("offset", "0"))
            limit = int(request.query_params.get("limit", "50"))
        except ValueError as exc:
            raise JobError(422, "Invalid result page") from exc
        if offset < 0 or not 1 <= limit <= 100:
            raise JobError(422, "Invalid result page")
        if kind == "raw":
            page = await run_in_threadpool(raw_page, store, job, offset, limit)
            return JSONResponse(page, headers=NO_STORE)
        rows = await run_in_threadpool(result_rows, store, job, kind)
        return JSONResponse({"rows": rows[offset:offset + limit], "total": len(rows),
                             "offset": offset, "limit": limit}, headers=NO_STORE)
    except JobError as exc:
        return JSONResponse({"message": str(exc)}, status_code=exc.status, headers=NO_STORE)
    except HTTPException:
        raise
