import chess

from app.portsmouth import fen_key, portsmouth


def test_every_repertoire_position_and_transition_is_connected():
    start = chess.Board()
    seen = set()
    pending = [start]

    while pending:
        board = pending.pop()
        key = fen_key(board.fen())
        if key in seen:
            continue
        seen.add(key)
        puzzle = portsmouth.position(board)
        assert puzzle is not None
        move = chess.Move.from_uci(puzzle["correctMove"]["uci"])
        assert move in board.legal_moves
        board.push(move)
        for response in portsmouth.responses(board):
            branch = board.copy(stack=False)
            reply = chess.Move.from_uci(response["move"]["uci"])
            assert reply in branch.legal_moves
            branch.push(reply)
            assert portsmouth.position(branch) == response["next"]
            pending.append(branch)

    assert len(seen) == 113


def test_repertoire_has_terminal_lines():
    terminals = 0
    for puzzle in portsmouth._positions.values():
        board = chess.Board(puzzle["fen"])
        board.push_uci(puzzle["correctMove"]["uci"])
        terminals += not bool(portsmouth.responses(board))
    assert terminals > 0
