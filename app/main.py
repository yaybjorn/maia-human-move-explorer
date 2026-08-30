import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import chess
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
app = FastAPI(title="Maia Human Move Explorer", docs_url=None, redoc_url=None)


class PositionRequest(BaseModel):
    moves: list[str] = Field(default_factory=list, max_length=512)


class PredictRequest(PositionRequest):
    rating: int = Field(default=1500, ge=0, le=5000)
    opponent_rating: int | None = Field(default=None, ge=0, le=5000)


class PgnRequest(BaseModel):
    pgn: str = Field(min_length=1, max_length=200_000)


class PgnNode(BaseModel):
    id: int = Field(ge=1)
    parent_id: int | None = Field(default=None, ge=1)
    uci: str = Field(min_length=4, max_length=5)


class PgnTreeRequest(BaseModel):
    nodes: list[PgnNode] = Field(default_factory=list, max_length=2048)
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
