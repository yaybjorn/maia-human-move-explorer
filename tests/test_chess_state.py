import chess
import pytest

from app.chess_state import PositionError, export_pgn_tree, parse_pgn_tree, replay, validate_fen


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


def test_parse_and_export_pgn_variations():
    nodes, headers = parse_pgn_tree('[Event "Test"]\n\n1. e4 (1. d4 d5) e5 2. Nf3 *')
    assert [(node["san"], node["parent_id"]) for node in nodes] == [
        ("e4", None), ("e5", 1), ("Nf3", 2), ("d4", None), ("d5", 4),
    ]
    exported = export_pgn_tree(nodes, headers)
    assert "1. e4" in exported and "1... e5 2. Nf3" in exported
    assert "( 1. d4 d5 )" in exported


def test_rejects_position_only_pgn():
    pgn = '[SetUp "1"]\n[FEN "8/8/8/8/8/4k3/8/4K3 w - - 0 1"]\n\n*'
    with pytest.raises(PositionError, match="standard starting position"):
        parse_pgn_tree(pgn)


def test_rejects_text_that_is_not_a_game():
    with pytest.raises(PositionError, match="contains no moves"):
        parse_pgn_tree("not actually a PGN")
