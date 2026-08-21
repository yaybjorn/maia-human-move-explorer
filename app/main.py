from pathlib import Path

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
from .portsmouth import portsmouth
from .stockfish import stockfish

ROOT = Path(__file__).resolve().parent
START_FEN = chess.STARTING_FEN
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


class PortsmouthMoveRequest(PositionRequest):
    uci: str = Field(min_length=4, max_length=5)
    rating: int = Field(default=1500, ge=0, le=5000)


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


@app.post("/api/portsmouth/play")
def portsmouth_play(request: PortsmouthMoveRequest):
    position = replay(START_FEN, request.moves)
    puzzle = portsmouth.position(position.board)
    if puzzle is None or not position.board.turn:
        raise HTTPException(409, "This position is outside the Portsmouth repertoire")
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
            "feedback": portsmouth.wrong_feedback(puzzle, request.uci),
            **state_payload(PositionRequest(moves=request.moves), position),
        }

    moves = [*request.moves, request.uci]
    after_white = replay(START_FEN, moves)
    responses = portsmouth.responses(after_white.board)
    opponent_move = None
    if responses:
        allowed = [item["move"]["uci"] for item in responses]
        chosen = engine.choose(after_white, request.rating, request.rating, allowed)
        selected = next(item for item in responses if item["move"]["uci"] == chosen["uci"])
        opponent_move = selected["move"]
        moves.append(opponent_move["uci"])

    final_position = replay(START_FEN, moves)
    complete = not responses
    payload = {
        "correct": True,
        "feedback": correct["feedback"],
        "opponent_move": opponent_move,
        "complete": complete,
        "repertoire_version": portsmouth.version,
        **state_payload(PositionRequest(moves=moves), final_position),
    }
    if complete:
        payload["stockfish"] = stockfish.analyze(final_position.board)
    return payload


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
