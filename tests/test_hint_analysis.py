import chess
import pytest

from app.chess_state import PositionError
from app.hint_analysis import analyze_hint


class Maia:
    def _predict_all(self, position, self_elo, opponent_elo):
        assert position.sans == ["e4", "e5", "Nf3"]
        assert len(position.boards) == 4
        assert self_elo == opponent_elo == 1500
        return [{"uci": "b8c6", "san": "Nc6", "probability": 0.4},
                {"uci": "g8f6", "san": "Nf6", "probability": 0.3}]


class Stockfish:
    def analyze(self, board, time_ms, lines):
        return {"turn": "white" if board.turn == chess.WHITE else "black",
                "lines": [{"evaluation": {"type": "mate", "value": -3}}]}


def test_evidence_is_after_intended_move_and_preserves_probability_and_mate():
    result = analyze_hint(["e2e4", "e7e5"], "g1f3", 1500, Maia(), Stockfish())
    assert result["answer"]["san"] == "Nf3"
    assert result["stockfish_after_intended"]["turn"] == "black"
    assert result["stockfish_before"]["lines"][0]["evaluation"] == {"type": "mate", "value": -3}
    assert result["maia_unshown_probability_mass"] == 0.3
    assert result["stockfish_after_likely_replies"][0]["reply"]["uci"] == "b8c6"
    assert result["stockfish_after_likely_replies"][0]["stockfish"]["turn"] == "white"


def test_illegal_intended_move_fails_closed():
    with pytest.raises(PositionError):
        analyze_hint([], "e2e5", 1500, Maia(), Stockfish())
