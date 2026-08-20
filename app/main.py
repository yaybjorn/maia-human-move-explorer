from pathlib import Path
from typing import Annotated

import chess
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .chess_state import PositionError, legal_moves, replay, validate_fen
from .engine import engine

ROOT = Path(__file__).resolve().parent
START_FEN = chess.STARTING_FEN
app = FastAPI(title="Maia Human Move Explorer", docs_url=None, redoc_url=None)


class PositionRequest(BaseModel):
    initial_fen: str = START_FEN
    moves: list[str] = Field(default_factory=list, max_length=512)


class PredictRequest(PositionRequest):
    rating: int = Field(default=1500, ge=0, le=5000)
    opponent_rating: int | None = Field(default=None, ge=0, le=5000)


def state_payload(request: PositionRequest):
    position = replay(request.initial_fen, request.moves)
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
        "position_only": request.initial_fen != START_FEN and not request.moves,
    }


@app.exception_handler(PositionError)
def position_error(_, exc: PositionError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.get("/healthz")
def health():
    return {"status": "ok", "model": engine.model_name}


@app.get("/api/validate-fen")
def validate(fen: Annotated[str, Query(min_length=1, max_length=128)]):
    board = validate_fen(fen)
    return {"valid": True, "fen": board.fen()}


@app.post("/api/state")
def state(request: PositionRequest):
    return state_payload(request)


@app.post("/api/predict")
def predict(request: PredictRequest):
    position = replay(request.initial_fen, request.moves)
    if position.board.is_game_over(claim_draw=True):
        raise HTTPException(409, "The game is over; there are no moves to predict")
    opponent = request.opponent_rating if request.opponent_rating is not None else request.rating
    return {
        **state_payload(request),
        "suggestions": engine.predict(position, request.rating, opponent),
        "model": engine.model_name,
    }


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html", headers={"X-Robots-Tag": "noindex, nofollow"})

