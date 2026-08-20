import os
import threading
from collections import OrderedDict, deque
from hashlib import blake2b

import chess

from .chess_state import ReplayedPosition


class MaiaEngine:
    """One lazily loaded official Maia-3 model, serialized for predictable CPU use."""

    def __init__(self, model: str | None = None) -> None:
        self.model_name = model or os.getenv("MAIA_MODEL", "maia3-5m")
        self._engine = None
        self._lock = threading.Lock()
        self._cache_size = max(0, int(os.getenv("MAIA_PREDICTION_CACHE_SIZE", "2048")))
        self._cache: OrderedDict[bytes, tuple[dict, ...]] = OrderedDict()

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
        self_elo = max(0, min(5000, self_elo))
        opponent_elo = max(0, min(5000, opponent_elo))
        cache_key = self._cache_key(position, self_elo, opponent_elo)
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache.move_to_end(cache_key)
                return [dict(item) for item in cached]

            engine = self._load()
            engine.board = position.board.copy(stack=False)
            engine.history = deque(maxlen=engine.cfg.history)
            for board in position.boards[-engine.cfg.history:]:
                engine.history.append(_tokenize(board))
            engine.self_elo = self_elo
            engine.oppo_elo = opponent_elo
            _, scored = engine.score_moves()
            result = [
                {
                    "uci": item["move"].uci(),
                    "san": position.board.san(item["move"]),
                    "probability": round(float(item["policy"]), 6),
                }
                for item in scored[:5]
            ]
            if self._cache_size:
                self._cache[cache_key] = tuple(dict(item) for item in result)
                self._cache.move_to_end(cache_key)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
            return result

    @staticmethod
    def _cache_key(position: ReplayedPosition, self_elo: int, opponent_elo: int) -> bytes:
        digest = blake2b(digest_size=20)
        digest.update(f"{self_elo}:{opponent_elo}\0".encode())
        for board in position.boards:
            digest.update(board.fen(en_passant="fen").encode())
            digest.update(b"\0")
        return digest.digest()


def _tokenize(board: chess.Board):
    from maia3.dataset import tokenize_board
    return tokenize_board(board)


engine = MaiaEngine()
