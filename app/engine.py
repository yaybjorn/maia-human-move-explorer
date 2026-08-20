import os
import threading
from collections import deque

import chess

from .chess_state import ReplayedPosition


class MaiaEngine:
    """One lazily loaded official Maia-3 model, serialized for predictable CPU use."""

    def __init__(self, model: str | None = None) -> None:
        self.model_name = model or os.getenv("MAIA_MODEL", "maia3-5m")
        self._engine = None
        self._lock = threading.Lock()

    def _load(self):
        if self._engine is None:
            # Maia's maintained UCI engine exposes score_moves(), the official policy
            # probability path. We use it in-process to avoid parsing lossy MultiPV output.
            from maia3.uci import Maia3UCIEngine, parse_args

            cfg = parse_args([
                "--model", self.model_name,
                "--device", "cpu",
                "--use-uci-history",
                "--multipv", "5",
                "--no-use-amp",
            ])
            self._engine = Maia3UCIEngine(cfg)
            self._engine.ensure_model_loaded()
        return self._engine

    def predict(self, position: ReplayedPosition, self_elo: int, opponent_elo: int):
        with self._lock:
            engine = self._load()
            engine.board = position.board.copy(stack=False)
            engine.history = deque(maxlen=engine.cfg.history)
            for board in position.boards[-engine.cfg.history:]:
                engine.history.append(engine.__class__.__module__ and _tokenize(board))
            engine.self_elo = max(0, min(5000, self_elo))
            engine.oppo_elo = max(0, min(5000, opponent_elo))
            _, scored = engine.score_moves()
            return [
                {
                    "uci": item["move"].uci(),
                    "san": position.board.san(item["move"]),
                    "probability": round(float(item["policy"]), 6),
                }
                for item in scored[:5]
            ]


def _tokenize(board: chess.Board):
    from maia3.dataset import tokenize_board
    return tokenize_board(board)


engine = MaiaEngine()

