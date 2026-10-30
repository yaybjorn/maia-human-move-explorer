"""Authenticated, revision-fenced private candidate and review storage."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import sqlite3
import uuid
from io import StringIO
from pathlib import Path

import chess.pgn
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .chess_state import PositionError
from .engine import engine
from .hint_analysis import analyze_hint
from .hint_generation import HintGenerationError, generate_hints
from .stockfish import stockfish

GENERATION_LOCK = asyncio.Lock()


def validated_position(draft, chapter_id, moves, answer):
    sources = draft.get("chapterSources")
    if sources is not None:
        chapter = next((c for c in sources if c.get("id") == chapter_id and not c.get("archived")), None)
        if not chapter:
            raise HTTPException(409, "Chapter is unavailable")
        pgn = chapter.get("sourcePGN", "")
    else:
        if chapter_id is not None:
            raise HTTPException(409, "Chapter changed")
        pgn = draft.get("sourcePGN", "")
    game = chess.pgn.read_game(StringIO(pgn))
    if not game or game.errors or game.headers.get("FEN") or game.headers.get("SetUp") == "1":
        raise HTTPException(409, "Saved chapter cannot be analyzed")
    if sources is not None:
        start = chapter.get("trainingStartPath") or []
        if moves[:len(start)] != start:
            raise HTTPException(409, "This move is outside the chapter training start")
    node = game
    side = draft.get("metadata", {}).get("side")
    if side not in {"white", "black"}:
        raise HTTPException(409, "Course side is invalid")
    for uci in moves:
        if node.board().turn == (side == "white") and (not node.variations or node.variations[0].move.uci() != uci):
            raise HTTPException(409, "Wrong-answer branches are not training positions")
        node = next((v for v in node.variations if v.move.uci() == uci), None)
        if node is None:
            raise HTTPException(409, "Saved move history changed")
    board = node.board()
    if board.turn != (side == "white"):
        raise HTTPException(400, "Select a learner move")
    if not node.variations or node.variations[0].move.uci() != answer:
        raise HTTPException(409, "Select the saved correct learner move")
    if sources is not None:
        fen = " ".join(board.fen().split()[:4])
        key = "sha256:" + hashlib.sha256(f"{fen}\n{answer}".encode()).hexdigest()
        if key in (chapter.get("scaffoldExclusionKeys") or []):
            raise HTTPException(409, "This move is excluded chapter scaffolding")


def private_references(evidence):
    path = Path(os.getenv("HINT_REFERENCE_FILE", "/opt/maia-human-move-explorer/private/hint-studio/references.json"))
    try:
        if path.is_symlink() or path.stat().st_mode & 0o077 or path.stat().st_size > 2_000_000:
            raise OSError("Unavailable")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            raise TypeError("Invalid references")
        valid = [r for r in data if isinstance(r, dict) and r.get("kind") in {"handwritten_hint", "style_prose"}
                 and isinstance(r.get("source"), str) and isinstance(r.get("text"), str)]
        hints = sorted((r for r in valid if r["kind"] == "handwritten_hint" and all(o.get("positionKey") != evidence["position_key"] for o in r.get("occurrences", []))),
                       key=lambda r: (r.get("san") == evidence["answer"]["san"],
                                      r.get("piece") == evidence["answer"]["piece"]), reverse=True)[:3]
        prose = [r for r in valid if r["kind"] == "style_prose"][:2]
        return [{"kind": r["kind"], "source": r["source"], "text": r["text"][:600], "occurrences": r.get("occurrences", [])[:25]}
                for r in [*hints, *prose]]
    except (OSError, ValueError, TypeError):
        raise HTTPException(503, "Private hint references are unavailable") from None


async def dispatch(request, upstream_read, allowed_origins):
    session = await upstream_read(request, "session")
    user = session.get("user") or {}
    if not session.get("authenticated"):
        raise HTTPException(401, "Sign in to Course Studio")
    if "superadmin" not in user.get("roles", []):
        raise HTTPException(403, "Course author permission required")
    if request.method != "POST":
        raise HTTPException(405, "Method not allowed")
    csrf = request.headers.get("x-csrf-token", "")
    if request.headers.get("origin") not in allowed_origins or not csrf or not hmac.compare_digest(csrf, session.get("csrfToken", "")):
        raise HTTPException(403, "Invalid authoring security token or origin")
    raw = await request.body()
    if len(raw) > 100_000:
        raise HTTPException(413, "Request too large")
    try:
        data = json.loads(raw)
        course_id, revision, revision_hash = data["courseID"], data["revision"], data["revisionHash"]
        chapter_id, moves, answer, rating = data.get("chapterID"), data["moves"], data["answer"], data["rating"]
        if (not isinstance(course_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", course_id)
                or type(revision) is not int or not isinstance(revision_hash, str)
                or not isinstance(moves, list) or len(moves) > 500
                or any(not isinstance(m, str) or not re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", m) for m in moves)
                or not isinstance(answer, str) or not re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", answer)
                or type(rating) is not int or not 400 <= rating <= 3000):
            raise ValueError("Invalid input")
    except (KeyError, ValueError, TypeError):
        raise HTTPException(400, "Invalid hint request") from None
    course = await upstream_read(request, f"courses/{course_id}")
    draft = course.get("draft") or {}
    if draft.get("revision") != revision or draft.get("revisionHash") != revision_hash:
        raise HTTPException(409, "The course draft changed; reload before generating")
    validated_position(draft, chapter_id, moves, answer)
    db = review_db()
    action = data.get("action", "generate")
    if action == "list":
        with sqlite3.connect(db, timeout=5) as conn:
            schema(conn)
            rows = conn.execute("SELECT record FROM hint_reviews WHERE course_id=? AND revision=? ORDER BY created_at DESC LIMIT 50", (course_id, revision)).fetchall()
        records = [json.loads(row[0]) for row in rows]
        records = [r for r in records if r["revisionHash"] == revision_hash and r["chapterID"] == chapter_id and r["moves"] == moves and r["answer"] == answer]
        return JSONResponse({"reviews": records}, headers={"Cache-Control": "private, no-store"})
    if action == "review":
        return update_review(db, data, user["id"], course_id, revision, revision_hash, chapter_id, moves, answer)
    if action != "generate":
        raise HTTPException(400, "Invalid operation")
    request_id = data.get("requestID")
    try:
        if str(uuid.UUID(request_id)) != request_id:
            raise ValueError("Invalid request ID")
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, "A generation request ID is required") from None
    fingerprint = hashlib.sha256(json.dumps({"actor": user["id"], "course": course_id, "revision": revision,
        "hash": revision_hash, "chapter": chapter_id, "moves": moves, "answer": answer, "rating": rating},
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if GENERATION_LOCK.locked():
        raise HTTPException(429, "Hint generation is busy; try again shortly")
    async with GENERATION_LOCK:
        with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
            schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            prior = conn.execute("SELECT payload_hash,review_id FROM hint_generation_requests WHERE id=?", (request_id,)).fetchone()
            if prior:
                if prior[0] != fingerprint:
                    raise HTTPException(409, "Generation request ID was already used")
                if prior[1] is None:
                    raise HTTPException(409, "This generation request is pending or its outcome is uncertain; inspect saved reviews")
                row = conn.execute("SELECT record FROM hint_reviews WHERE id=?", (prior[1],)).fetchone()
                if not row:
                    raise HTTPException(503, "Saved generation receipt is unavailable")
                return JSONResponse(json.loads(row[0]), headers={"Cache-Control": "private, no-store"})
            conn.execute("INSERT INTO hint_generation_requests(id,payload_hash,review_id) VALUES (?,?,NULL)", (request_id, fingerprint))
            conn.execute("COMMIT")
        try:
            evidence = await run_in_threadpool(analyze_hint, moves, answer, rating, engine, stockfish)
            refs = private_references(evidence)
            result = await run_in_threadpool(generate_hints, evidence, refs)
        except PositionError as exc:
            raise HTTPException(400, str(exc)) from None
        except HintGenerationError as exc:
            raise HTTPException(503, str(exc)) from None
        current = (await upstream_read(request, f"courses/{course_id}")).get("draft") or {}
        if current.get("revision") != revision or current.get("revisionHash") != revision_hash:
            raise HTTPException(409, "The draft changed during generation; result discarded")
        review_id = str(uuid.uuid4())
        record = {"id": review_id, "courseID": course_id, "revision": revision, "revisionHash": revision_hash,
                  "chapterID": chapter_id, "moves": moves, "answer": answer, "rating": rating,
                  "actorID": user["id"], "version": 1, "evidence": evidence, "references": refs, "model": result["model"], "promptVersion": "hint-v1-20261030", "usage": result.get("usage", {}),
                  "candidates": [{"id": str(uuid.uuid4()), "text": text, "status": "draft", "rating": 0} for text in result["candidates"]]}
        with sqlite3.connect(db, timeout=5) as conn:
            schema(conn)
            conn.execute("INSERT INTO hint_reviews(id,course_id,revision,actor_id,record) VALUES (?,?,?,?,?)",
                         (review_id, course_id, revision, user["id"], json.dumps(record, ensure_ascii=False)))
            conn.execute("UPDATE hint_generation_requests SET review_id=? WHERE id=? AND payload_hash=?", (review_id, request_id, fingerprint))
        return JSONResponse(record, headers={"Cache-Control": "private, no-store"})


def review_db():
    db = Path(os.getenv("HINT_REVIEW_DB", "/opt/maia-human-move-explorer/private/hint-studio/reviews.sqlite3"))
    if not db.parent.is_dir() or db.parent.is_symlink() or db.is_symlink() or db.parent.stat().st_mode & 0o077:
        raise HTTPException(503, "Private hint storage unavailable")
    try:
        fd = os.open(db, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)
    except FileExistsError:
        if not db.is_file() or db.stat().st_mode & 0o077:
            raise HTTPException(503, "Private hint storage unavailable") from None
    except OSError:
        raise HTTPException(503, "Private hint storage unavailable") from None
    return db


def schema(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS hint_reviews (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    conn.execute("CREATE TABLE IF NOT EXISTS hint_generation_requests (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, review_id TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS hint_review_events (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, candidate_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")


def update_review(db, data, actor, course, revision, revision_hash, chapter, moves, answer):
    review_id, candidate_id, expected, operation = (data.get("reviewID"), data.get("candidateID"), data.get("version"), data.get("operation"))
    if not isinstance(review_id, str) or not isinstance(candidate_id, str) or type(expected) is not int or operation not in {"edit", "rate", "approve", "reject", "apply"}:
        raise HTTPException(400, "Invalid review operation")
    with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
        schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT record FROM hint_reviews WHERE id=? AND course_id=? AND revision=?", (review_id, course, revision)).fetchone()
        if not row:
            raise HTTPException(404, "Review not found")
        record = json.loads(row[0])
        if (record["version"] != expected or record["revisionHash"] != revision_hash or record["chapterID"] != chapter
                or record["moves"] != moves or record["answer"] != answer):
            raise HTTPException(409, "Review or draft changed; reload")
        candidate = next((c for c in record["candidates"] if c["id"] == candidate_id), None)
        if candidate is None:
            raise HTTPException(404, "Candidate not found")
        if operation == "edit":
            value = data.get("text")
            if not isinstance(value, str) or not 1 <= len(value.strip().encode("utf-16-le")) // 2 <= 600 or re.search(r"[\[\]{}\x00-\x1f\x7f]", value):
                raise HTTPException(400, "Invalid hint text")
            candidate["text"] = " ".join(value.split())
            candidate["status"] = "draft"
        elif operation == "rate":
            value = data.get("value")
            if type(value) is not int or value not in range(6):
                raise HTTPException(400, "Invalid rating")
            candidate["rating"] = value
        elif operation == "apply":
            if candidate["status"] != "approved":
                raise HTTPException(409, "Approve the candidate before applying")
        else:
            candidate["status"] = "approved" if operation == "approve" else "rejected"
            if operation == "approve":
                for other in record["candidates"]:
                    if other is not candidate and other["status"] == "approved":
                        other["status"] = "draft"
        record["version"] += 1
        conn.execute("UPDATE hint_reviews SET record=? WHERE id=?", (json.dumps(record, ensure_ascii=False), review_id))
        conn.execute("INSERT INTO hint_review_events(id,review_id,actor_id,action,candidate_id,version,payload) VALUES (?,?,?,?,?,?,?)", (str(uuid.uuid4()), review_id, actor, "apply_intent" if operation == "apply" else operation, candidate_id, record["version"], json.dumps({"text": candidate["text"], "rating": candidate["rating"]}, ensure_ascii=False)))
        conn.execute("COMMIT")
    return JSONResponse(record, headers={"Cache-Control": "private, no-store"})
