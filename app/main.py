import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import chess
from fastapi import FastAPI, HTTPException
from fastapi import Request as FastAPIRequest
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .chess_state import (
    PositionError,
    export_pgn_tree,
    legal_moves,
    parse_pgn_tree,
    replay,
)
from .engine import engine
from .pgn_trainer import kilkenny
from .portsmouth import portsmouth
from .repertoire_check import check_repertoire, writing_sources
from .stockfish import stockfish

ROOT = Path(__file__).resolve().parent
START_FEN = chess.STARTING_FEN
GINGERGM_API_BASE = os.getenv(
    "GINGERGM_API_BASE", "https://gingergm-opening-drill-api.fablelabs.workers.dev"
).rstrip("/")
GINGERGM_STUDIO_API_BASE = os.getenv(
    "GINGERGM_STUDIO_API_BASE", f"{GINGERGM_API_BASE}/v1/studio"
).rstrip("/")
STUDIO_PROXY_SECRET = os.getenv("STUDIO_PROXY_SECRET", "")
STUDIO_ALLOWED_ORIGINS = {
    value.strip()
    for value in os.getenv(
        "STUDIO_ALLOWED_ORIGINS",
        "https://ggm.fablelabs.no,https://maia.fablelabs.no",
    ).split(",")
    if value.strip()
}
app = FastAPI(title="Maia Human Move Explorer", docs_url=None, redoc_url=None)


class PositionRequest(BaseModel):
    moves: list[str] = Field(default_factory=list, max_length=512)


class PredictRequest(PositionRequest):
    rating: int = Field(default=1500, ge=0, le=5000)
    opponent_rating: int | None = Field(default=None, ge=0, le=5000)


class PgnRequest(BaseModel):
    pgn: str = Field(min_length=1, max_length=1_800_000)


class PgnNode(BaseModel):
    id: int = Field(ge=1)
    parent_id: int | None = Field(default=None, ge=1)
    uci: str = Field(min_length=4, max_length=5)
    comment: str = Field(default="", max_length=20_000)
    starting_comment: str = Field(default="", max_length=20_000)
    nags: list[int] = Field(default_factory=list, max_length=32)


class PgnTreeRequest(BaseModel):
    nodes: list[PgnNode] = Field(default_factory=list, max_length=20_000)
    headers: dict[str, str] = Field(default_factory=dict)


class TrainerMoveRequest(PositionRequest):
    uci: str = Field(min_length=4, max_length=5)
    opponent_rating: int = Field(default=1500, ge=0, le=5000)


class RepertoireCheckRequest(PgnRequest):
    repertoire_side: str = Field(default="white", pattern="^(white|black)$")
    rating: int = Field(default=1500, ge=500, le=3000)
    threshold: float = Field(default=0.30, ge=0.01, le=0.50)


def state_payload(request: PositionRequest, position=None):
    position = position or replay(START_FEN, request.moves)
    board = position.board
    outcome = board.outcome(claim_draw=True)
    return {
        "fen": board.fen(),
        "pgn": position.pgn,
        "turn": "white" if board.turn else "black",
        "moves": request.moves,
        "san_history": position.sans,
        "legal_moves": legal_moves(board),
        "game_over": board.is_game_over(claim_draw=True),
        "result": outcome.result() if outcome else None,
    }


@app.exception_handler(PositionError)
def position_error(_, exc: PositionError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.get("/healthz")
def health():
    return {"status": "ok", "model": engine.model_name, "stockfish": stockfish.version}


@app.post("/api/parse-pgn")
def parse_pgn(request: PgnRequest):
    nodes, headers = parse_pgn_tree(request.pgn)
    return {"nodes": nodes, "headers": headers}


@app.post("/api/export-pgn")
def export_pgn(request: PgnTreeRequest):
    nodes = [node.model_dump() for node in request.nodes]
    return {"pgn": export_pgn_tree(nodes, request.headers)}


@app.post("/api/state")
def state(request: PositionRequest):
    return state_payload(request)


@app.post("/api/predict")
def predict(request: PredictRequest):
    position = replay(START_FEN, request.moves)
    if position.board.is_game_over(claim_draw=True):
        raise HTTPException(409, "The game is over; there are no moves to predict")
    opponent = request.opponent_rating if request.opponent_rating is not None else request.rating
    return {
        **state_payload(request, position),
        "suggestions": engine.predict(position, request.rating, opponent),
        "model": engine.model_name,
    }


@app.post("/api/stockfish")
def stockfish_analysis(request: PositionRequest):
    position = replay(START_FEN, request.moves)
    if position.board.is_game_over(claim_draw=True):
        raise HTTPException(409, "The game is over; there are no moves to analyze")
    return stockfish.analyze(position.board)


@app.post("/api/check-repertoire")
def repertoire_check(request: RepertoireCheckRequest):
    return check_repertoire(
        request.pgn, request.repertoire_side, request.rating, request.threshold, engine, stockfish
    )


@app.post("/api/spellcheck-context")
def spellcheck_context(request: PgnRequest):
    return {"sources": writing_sources(request.pgn)}


def fetch_json(url: str) -> dict:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "MaiaChapterEditor/1"})
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(502, "The GingerGM course API is temporarily unavailable") from exc


@app.get("/api/chapter-courses")
def chapter_courses():
    catalog = fetch_json(f"{GINGERGM_API_BASE}/v1/catalog")
    return {
        "openings": [
            {
                "id": opening["id"],
                "title": opening["title"],
                "version": opening["version"],
                "pack_url": opening["packURL"],
            }
            for opening in catalog.get("openings", [])
            if opening.get("id") and opening.get("version") and opening.get("packURL")
        ]
    }


@app.get("/api/chapter-courses/{pack_id}")
def chapter_course(pack_id: str):
    if not pack_id or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in pack_id):
        raise HTTPException(404, "Unknown course")
    catalog = chapter_courses()
    opening = next((item for item in catalog["openings"] if item["id"] == pack_id), None)
    if opening is None:
        raise HTTPException(404, "Unknown course")
    return fetch_json(f"{GINGERGM_API_BASE}/{opening['pack_url'].lstrip('/')}")


def studio_path_allowed(path: str, method: str) -> bool:
    parts = path.split("/") if path else []
    safe = all(part and len(part) <= 160 and all(c.isalnum() or c in "-_." for c in part)
               for part in parts)
    if not safe:
        return False
    allowed = {
        ("session",): {"GET"},
        ("login",): {"POST"},
        ("logout",): {"POST"},
        ("courses",): {"GET", "POST"},
    }
    if tuple(parts) in allowed:
        return method in allowed[tuple(parts)]
    if tuple(parts) == ("import", "parse"):
        return method == "POST"
    if len(parts) == 2 and parts[0] == "courses":
        return method == "GET"
    if len(parts) == 3 and parts[0] == "courses" and parts[2] in {
        "draft", "validate", "publish", "versions"
    }:
        return method in ({"PUT"} if parts[2] == "draft" else {"GET"} if parts[2] == "versions" else {"POST"})
    return (
        len(parts) == 5 and parts[0] == "courses" and parts[2] == "versions"
        and parts[4] == "restore" and method == "POST"
    )


@app.api_route("/studio/api/{path:path}", methods=["GET", "POST", "PUT"])
async def studio_api_proxy(path: str, request: FastAPIRequest):
    if not studio_path_allowed(path, request.method):
        raise HTTPException(404, "Unknown Studio operation")
    if not STUDIO_PROXY_SECRET:
        raise HTTPException(503, "The Course Studio backend is not configured")
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD"} and origin not in STUDIO_ALLOWED_ORIGINS:
        raise HTTPException(403, "Cross-origin Studio mutations are forbidden")
    body = await request.body()
    if len(body) > 2_000_000:
        raise HTTPException(413, "The Studio draft is too large")
    headers = {
        "Accept": "application/json",
        "Content-Type": request.headers.get("content-type", "application/json"),
        "User-Agent": "GingerGMCourseStudioProxy/1",
        "X-Studio-Proxy-Secret": STUDIO_PROXY_SECRET,
    }
    for name in ("cookie", "x-csrf-token"):
        if value := request.headers.get(name):
            headers[name.title()] = value
    if request.client and request.client.host:
        # CF-Connecting-IP is reserved by Cloudflare. Spoofing it from the VM
        # can be rejected at the edge as a DNS loop, so use our signed
        # proxy-only header instead.
        headers["X-Studio-Client-IP"] = request.client.host
    if origin in STUDIO_ALLOWED_ORIGINS:
        headers["Origin"] = origin
    upstream = Request(
        f"{GINGERGM_STUDIO_API_BASE}/{path}",
        data=body if request.method != "GET" else None,
        headers=headers,
        method=request.method,
    )
    payload, status, response_headers = await run_in_threadpool(studio_upstream_request, upstream)
    outgoing = {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
    }
    for name in ("Content-Type", "Set-Cookie", "X-CSRF-Token"):
        if value := response_headers.get(name):
            outgoing[name] = value
    return Response(content=payload, status_code=status, headers=outgoing)


def studio_upstream_request(upstream: Request):
    try:
        response = urlopen(upstream, timeout=60)
        return response.read(), response.status, response.headers
    except HTTPError as exc:
        return exc.read(), exc.code, exc.headers
    except (URLError, TimeoutError) as exc:
        raise HTTPException(502, "The Course Studio backend is temporarily unavailable") from exc


def trainer_play(request: TrainerMoveRequest, repertoire, label: str):
    position = replay(START_FEN, request.moves)
    puzzle = repertoire.position(position.board)
    if puzzle is None or not position.board.turn:
        raise HTTPException(409, f"This position is outside the {label} repertoire")
    try:
        move = chess.Move.from_uci(request.uci)
    except ValueError as exc:
        raise HTTPException(422, "Invalid move") from exc
    if move not in position.board.legal_moves:
        raise HTTPException(422, "Illegal move")
    correct = puzzle["correctMove"]
    if request.uci != correct["uci"]:
        return {
            "correct": False,
            "feedback": repertoire.wrong_feedback(puzzle, request.uci),
            **state_payload(PositionRequest(moves=request.moves), position),
        }

    moves = [*request.moves, request.uci]
    after_white = replay(START_FEN, moves)
    responses = repertoire.responses(after_white.board)
    opponent_move = None
    if responses:
        allowed = [item["move"]["uci"] for item in responses]
        chosen = engine.choose(after_white, request.opponent_rating, 1500, allowed)
        selected = next(item for item in responses if item["move"]["uci"] == chosen["uci"])
        opponent_move = selected["move"]
        moves.append(opponent_move["uci"])

    final_position = replay(START_FEN, moves)
    complete = repertoire.position(final_position.board) is None
    payload = {
        "correct": True,
        "feedback": correct["feedback"],
        "opponent_move": opponent_move,
        "white_state": state_payload(PositionRequest(moves=moves[:-1] if opponent_move else moves), after_white),
        "complete": complete,
        "repertoire_version": repertoire.version,
        **state_payload(PositionRequest(moves=moves), final_position),
    }
    if complete:
        payload["stockfish"] = stockfish.analyze(final_position.board)
    return payload


@app.post("/api/portsmouth/play")
def portsmouth_play(request: TrainerMoveRequest):
    return trainer_play(request, portsmouth, "Portsmouth")


@app.post("/api/kilkenny/play")
def kilkenny_play(request: TrainerMoveRequest):
    return trainer_play(request, kilkenny, "Kilkenny")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html", headers={"X-Robots-Tag": "noindex, nofollow"})


@app.get("/portsmouth")
def portsmouth_index():
    return FileResponse(
        ROOT / "static" / "portsmouth.html",
        headers={"X-Robots-Tag": "noindex, nofollow"},
    )


@app.get("/kilkenny")
def kilkenny_index():
    return FileResponse(
        ROOT / "static" / "kilkenny.html",
        headers={"X-Robots-Tag": "noindex, nofollow"},
    )


@app.get("/check")
def check_index():
    return FileResponse(
        ROOT / "static" / "check.html",
        headers={"X-Robots-Tag": "noindex, nofollow"},
    )


@app.get("/spellcheck")
def spellcheck_index():
    return FileResponse(
        ROOT / "static" / "spellcheck.html",
        headers={"X-Robots-Tag": "noindex, nofollow"},
    )


@app.get("/chapters")
def chapters_index():
    return FileResponse(
        ROOT / "static" / "chapters.html",
        headers={"X-Robots-Tag": "noindex, nofollow, noarchive"},
    )


@app.get("/studio")
def studio_index():
    return FileResponse(
        ROOT / "static" / "studio.html",
        headers={
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
    )
