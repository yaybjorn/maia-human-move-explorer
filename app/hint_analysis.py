"""Bounded chess evidence for author-reviewed hints, never move substitution."""
from hashlib import sha256

import chess

from .chess_state import PositionError, replay


def analyze_hint(moves: list[str], answer: str, rating: int, maia, stockfish) -> dict:
    if len(moves) > 500 or not 400 <= rating <= 3000:
        raise PositionError("Invalid history or rating")
    before = replay(chess.STARTING_FEN, moves)
    try:
        intended = chess.Move.from_uci(answer)
    except ValueError as exc:
        raise PositionError("Invalid intended move") from exc
    if intended not in before.board.legal_moves:
        raise PositionError("Intended move is illegal")
    san = before.board.san(intended)
    after = replay(chess.STARTING_FEN, [*moves, answer])
    objective_before = stockfish.analyze(before.board, time_ms=300, lines=3)
    if after.board.is_game_over():
        replies, objective_after = [], None
    else:
        replies = maia._predict_all(after, rating, rating)
        objective_after = stockfish.analyze(after.board, time_ms=300, lines=3)
    displayed = replies[:5]
    likely_reply_evaluations = []
    for reply in displayed[:3]:
        reply_position = replay(chess.STARTING_FEN, [*moves, answer, reply["uci"]])
        analysis = None if reply_position.board.is_game_over() else stockfish.analyze(reply_position.board, time_ms=300, lines=1)
        likely_reply_evaluations.append({"reply": reply, "stockfish": analysis})
    covered = min(1.0, sum(item["probability"] for item in displayed))
    semantic_fen = " ".join(before.board.fen().split()[:4])
    position_key = "sha256:" + sha256(f"{semantic_fen}\n{answer}".encode()).hexdigest()
    return {
        "position_key": position_key,
        "answer": {"uci": answer, "san": san, "piece": before.board.piece_at(intended.from_square).symbol().lower()},
        "history": list(moves),
        "rating": rating,
        "stockfish_before": objective_before,
        "stockfish_after_intended": objective_after,
        "maia_replies_after_intended": displayed,
        "stockfish_after_likely_replies": likely_reply_evaluations,
        "maia_shown_probability_mass": round(covered, 6),
        "maia_unshown_probability_mass": round(max(0.0, 1.0 - covered), 6),
        "probability_note": "Maia model estimates, not measured human mistake rates.",
        "evaluation_note": "Stockfish scores are from White's perspective; mate scores remain distinct.",
    }
