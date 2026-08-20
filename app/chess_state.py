from dataclasses import dataclass

import chess
import chess.pgn


class PositionError(ValueError):
    pass


@dataclass
class ReplayedPosition:
    board: chess.Board
    boards: list[chess.Board]
    sans: list[str]

    @property
    def pgn(self) -> str:
        game = chess.pgn.Game.from_board(self.board)
        exporter = chess.pgn.StringExporter(headers=False, variations=False, comments=False)
        return game.accept(exporter).strip()


def validate_fen(fen: str) -> chess.Board:
    try:
        board = chess.Board(fen.strip())
    except (ValueError, IndexError) as exc:
        raise PositionError(f"Invalid FEN: {exc}") from exc
    if not board.is_valid():
        raise PositionError("Invalid FEN: the position is not a valid chess position")
    return board


def replay(initial_fen: str, moves: list[str]) -> ReplayedPosition:
    board = validate_fen(initial_fen)
    boards = [board.copy(stack=False)]
    sans: list[str] = []
    for index, uci in enumerate(moves):
        try:
            move = chess.Move.from_uci(uci)
        except ValueError as exc:
            raise PositionError(f"Move {index + 1} is not valid UCI") from exc
        if move not in board.legal_moves:
            raise PositionError(f"Move {index + 1} ({uci}) is illegal")
        sans.append(board.san(move))
        board.push(move)
        boards.append(board.copy(stack=False))
    return ReplayedPosition(board, boards, sans)


def legal_moves(board: chess.Board) -> list[dict[str, str]]:
    return [
        {"uci": move.uci(), "from": chess.square_name(move.from_square),
         "to": chess.square_name(move.to_square), "san": board.san(move)}
        for move in board.legal_moves
    ]

