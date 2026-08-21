import chess

from app.pgn_trainer import kilkenny
from app.portsmouth import fen_key


def test_kilkenny_repertoire_tree_is_legal_and_connected():
    start = chess.Board()
    seen = set()
    pending = [start]

    while pending:
        board = pending.pop()
        key = fen_key(board.fen())
        if key in seen:
            continue
        seen.add(key)
        puzzle = kilkenny.position(board)
        assert puzzle is not None
        white_move = chess.Move.from_uci(puzzle["correctMove"]["uci"])
        assert white_move in board.legal_moves
        board.push(white_move)
        for response in kilkenny.responses(board):
            branch = board.copy(stack=False)
            black_move = chess.Move.from_uci(response["move"]["uci"])
            assert black_move in branch.legal_moves
            branch.push(black_move)
            if kilkenny.position(branch) is not None:
                pending.append(branch)

    assert len(seen) == len(kilkenny._positions) == 181


def test_kilkenny_starts_with_d4_and_has_terminal_lines():
    assert kilkenny.position(chess.Board())["correctMove"]["san"] == "d4"
    terminals = 0
    for puzzle in kilkenny._positions.values():
        board = chess.Board(puzzle["fen"])
        board.push_uci(puzzle["correctMove"]["uci"])
        terminals += not bool(kilkenny.responses(board))
    assert terminals > 0
