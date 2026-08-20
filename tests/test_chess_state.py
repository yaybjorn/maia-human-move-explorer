import chess
import pytest

from app.chess_state import PositionError, replay, validate_fen


def test_replay_preserves_history_and_san():
    result = replay(chess.STARTING_FEN, ["e2e4", "e7e5", "g1f3"])
    assert len(result.boards) == 4
    assert result.sans == ["e4", "e5", "Nf3"]
    assert result.board.fen().startswith("rnbqkbnr/pppp1ppp")
    assert "1. e4 e5 2. Nf3" in result.pgn


def test_rejects_bad_fen_and_illegal_move():
    with pytest.raises(PositionError, match="Invalid FEN"):
        validate_fen("not fen")
    with pytest.raises(PositionError, match="illegal"):
        replay(chess.STARTING_FEN, ["e2e5"])

