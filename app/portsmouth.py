import json
from pathlib import Path

import chess

from .chess_state import ReplayedPosition

DATA = Path(__file__).resolve().parent / "data" / "portsmouth-gambit.json"


def fen_key(fen: str) -> str:
    return " ".join(fen.split()[:4])


class PortsmouthRepertoire:
    def __init__(self, path: Path = DATA) -> None:
        pack = json.loads(path.read_text())
        self.version = pack["version"]
        self.title = pack["title"]
        self._positions = {fen_key(item["fen"]): item for item in pack["positions"]}
        self._responses: dict[str, list[dict]] = {}
        for item in pack["positions"]:
            transition = item.get("opponentTransition")
            if transition:
                self._responses.setdefault(fen_key(transition["beforeFen"]), []).append({
                    "move": transition["move"],
                    "next": item,
                })

    def position(self, board: chess.Board) -> dict | None:
        return self._positions.get(fen_key(board.fen()))

    def responses(self, board: chess.Board) -> list[dict]:
        return self._responses.get(fen_key(board.fen()), [])

    def wrong_feedback(self, position: dict, uci: str) -> str:
        wrong = next((item for item in position["wrongMoves"] if item["uci"] == uci), None)
        return wrong["feedback"] if wrong else "That is not the repertoire move. Please try again."

    @staticmethod
    def after(position: ReplayedPosition, uci: str) -> ReplayedPosition:
        board = position.board.copy(stack=False)
        move = chess.Move.from_uci(uci)
        san = board.san(move)
        board.push(move)
        return ReplayedPosition(board, [*position.boards, board.copy(stack=False)], [*position.sans, san])


portsmouth = PortsmouthRepertoire()
