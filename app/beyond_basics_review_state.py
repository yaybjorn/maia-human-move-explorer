"""Private review revisions; never modifies or publishes a Studio course."""
import hashlib
import json
import os
import sqlite3
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.beyond_basics_action_queue import enqueue, ensure_schema
from app.beyond_basics_names import renamed_text


async def review_state(request, manifest):
    if request.headers.get("origin") != "https://ggm.fablelabs.no" and request.method != "GET":
        raise HTTPException(403, "Invalid origin")
    if request.method not in {"GET", "PUT"}:
        raise HTTPException(405, "Method not allowed")
    db = Path(os.getenv("BEYOND_BASICS_REVIEW_STATE_DB", "/opt/maia-human-move-explorer/private/beyond-basics/review-state/reviews.sqlite3"))
    if not db.parent.is_dir() or db.parent.is_symlink() or db.is_symlink():
        raise HTTPException(503, "Review storage unavailable")
    source = manifest["source_sha256"]
    with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS revisions (source TEXT NOT NULL, page_id TEXT NOT NULL, generation INTEGER NOT NULL, body TEXT NOT NULL, notes TEXT NOT NULL, decision TEXT NOT NULL, ready INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,page_id,generation))")
        ensure_schema(conn)
        conn.execute("CREATE TABLE IF NOT EXISTS review_save_requests (source TEXT NOT NULL, page_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(source,page_id,request_id))")
        conn.execute("CREATE TABLE IF NOT EXISTS review_overlays (source TEXT NOT NULL,page_id TEXT NOT NULL,generation INTEGER NOT NULL,patches TEXT NOT NULL,PRIMARY KEY(source,page_id,generation))")
        if request.method == "GET":
            rows = conn.execute("SELECT r.page_id,r.generation,r.body,r.notes,r.decision,r.ready FROM revisions r WHERE r.source=? AND r.generation=(SELECT max(x.generation) FROM revisions x WHERE x.source=r.source AND x.page_id=r.page_id)", (source,)).fetchall()
            pages = {r[0]:{"generation":r[1],"body":renamed_text(r[2]),"notes":r[3],"decision":r[4],"ready":bool(r[5])} for r in rows}
            actions = conn.execute("SELECT a.page_id,a.status,a.message,a.suggestions FROM review_actions a WHERE a.source=? AND a.generation=(SELECT max(x.generation) FROM revisions x WHERE x.source=a.source AND x.page_id=a.page_id)", (source,)).fetchall()
            for page_id, status, message, suggestions in actions:
                if page_id in pages:
                    pages[page_id]["action"] = {"status":status,"message":message,"suggestions":json.loads(suggestions)}
            return JSONResponse({"source":source,"pages":pages}, headers={"Cache-Control":"private, no-store"})
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON required")
        try:
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            raise HTTPException(400, "Invalid content length") from None
        if content_length < 0 or content_length > 150000:
            raise HTTPException(413, "Review too large")
        data_bytes = await request.body()
        if len(data_bytes) > 150000:
            raise HTTPException(413, "Review too large")
        try:
            data = json.loads(data_bytes)
            page_id = data["page_id"]
            expected = data["generation"]
            operation = data["operation"]
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "Invalid review") from None
        if data.get("source") != source or not isinstance(page_id, str) or page_id not in manifest["page_ids"] or type(expected) is not int or expected < 0 or not isinstance(operation, str) or operation not in {"save", "ready"}:
            raise HTTPException(400, "Invalid review")
        conn.execute("BEGIN IMMEDIATE")
        request_id = data.get("request_id")
        if request_id is not None and (operation != "save" or not isinstance(request_id, str) or len(request_id) != 36 or any(c not in "0123456789abcdef-" for c in request_id)):
            conn.execute("ROLLBACK")
            raise HTTPException(400, "Invalid request ID")
        payload_hash = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
        if request_id:
            prior = conn.execute("SELECT payload_hash,generation FROM review_save_requests WHERE source=? AND page_id=? AND request_id=?", (source,page_id,request_id)).fetchone()
            if prior:
                conn.execute("ROLLBACK")
                if prior[0] != payload_hash:
                    raise HTTPException(409, "Request ID already used")
                return JSONResponse({"generation":prior[1],"ready":False}, headers={"Cache-Control":"private, no-store"})
        row = conn.execute("SELECT generation,body,notes,decision,ready FROM revisions WHERE source=? AND page_id=? ORDER BY generation DESC LIMIT 1", (source,page_id)).fetchone()
        current = row[0] if row else 0
        if current != expected:
            conn.execute("ROLLBACK")
            raise HTTPException(409, "Page changed elsewhere; reload before saving")
        if operation == "ready":
            if not row:
                conn.execute("ROLLBACK")
                raise HTTPException(400, "Save this page before marking ready")
            action = conn.execute("SELECT status FROM review_actions WHERE source=? AND page_id=? AND generation=?", (source,page_id,current)).fetchone()
            if action and action[0] != "completed":
                conn.execute("ROLLBACK")
                raise HTTPException(409, "Resolve the saved instruction before marking ready")
            if row[3] == "Request changes":
                conn.execute("ROLLBACK")
                raise HTTPException(400, "Resolve change request before marking ready")
            body,notes,decision,ready = row[1],row[2],row[3],1
        else:
            body,notes,decision=data.get("body"),data.get("notes"),data.get("decision")
            if not isinstance(body,str) or not isinstance(notes,str) or not isinstance(decision,str) or len(body)>100000 or len(notes)>20000 or decision not in {"", "Approve", "Request changes"}:
                conn.execute("ROLLBACK")
                raise HTTPException(400, "Invalid review fields")
            ready=0
        generation=current+1
        conn.execute("INSERT INTO revisions(source,page_id,generation,body,notes,decision,ready) VALUES (?,?,?,?,?,?,?)",(source,page_id,generation,body,notes,decision,ready))
        if operation == "save":
            try:
                enqueue(conn, source, page_id, generation, notes)
            except ValueError:
                conn.execute("ROLLBACK")
                raise HTTPException(400, "Invalid instruction or review queue full") from None
            if request_id:
                conn.execute("INSERT INTO review_save_requests VALUES (?,?,?,?,?)", (source,page_id,request_id,payload_hash,generation))
        conn.execute("COMMIT")
    return JSONResponse({"generation":generation,"ready":bool(ready)}, headers={"Cache-Control":"private, no-store"})
