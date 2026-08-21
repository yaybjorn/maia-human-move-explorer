from pathlib import Path

import chess
import chess.pgn

from .portsmouth import fen_key


class PgnTrainerRepertoire:
    """Build a White opening trainer from an annotated PGN variation tree."""

    def __init__(self, path: Path, title: str, version: str) -> None:
        self.title = title
        self.version = version
        self._positions: dict[str, dict] = {}
        self._responses: dict[str, list[dict]] = {}
        with path.open(encoding="utf-8-sig") as source:
            game = chess.pgn.read_game(source)
        if game is None or game.errors:
            detail = str(game.errors[0]) if game and game.errors else "PGN contains no game"
            raise ValueError(f"Invalid {title} PGN: {detail}")
        self._visit(game, game.board())

    def _visit(self, node: chess.pgn.GameNode, board: chess.Board) -> None:
        if board.turn == chess.WHITE:
            if not node.variations:
                return
            chosen = node.variations[0]
            move = chosen.move
            san = board.san(move)
            position = {
                "fen": board.fen(),
                "correctMove": {
                    "uci": move.uci(),
                    "san": san,
                    "feedback": chosen.comment.strip() or f"The repertoire move is {san}.",
                },
                "wrongMoves": [],
            }
            self._positions[fen_key(board.fen())] = position
            next_board = board.copy(stack=False)
            next_board.push(move)
            self._visit(chosen, next_board)
            return

        for reply in node.variations:
            move = reply.move
            san = board.san(move)
            next_board = board.copy(stack=False)
            next_board.push(move)
            self._responses.setdefault(fen_key(board.fen()), []).append({
                "move": {"uci": move.uci(), "san": san},
            })
            self._visit(reply, next_board)

    def position(self, board: chess.Board) -> dict | None:
        return self._positions.get(fen_key(board.fen()))

    def responses(self, board: chess.Board) -> list[dict]:
        return self._responses.get(fen_key(board.fen()), [])

    @staticmethod
    def wrong_feedback(_position: dict, _uci: str) -> str:
        return "That is not the repertoire move. Please try again."


DATA = Path(__file__).resolve().parent / "data" / "kilkenny-gambit.pgn"
kilkenny = PgnTrainerRepertoire(DATA, "Kilkenny Gambit", "2026-08-20.1")
