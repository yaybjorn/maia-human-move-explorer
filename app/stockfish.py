import os
import threading
from collections import OrderedDict

import chess
import chess.engine


class StockfishEngine:
    """One lazily started Stockfish process with bounded position caching."""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.getenv("STOCKFISH_PATH", "/usr/local/bin/stockfish")
        self.version = os.getenv("STOCKFISH_VERSION", "18")
        self.time_ms = max(100, int(os.getenv("STOCKFISH_TIME_MS", "500")))
        self.lines = max(1, min(5, int(os.getenv("STOCKFISH_LINES", "3"))))
        self._engine = None
        self._lock = threading.Lock()
        self._cache_size = max(0, int(os.getenv("STOCKFISH_CACHE_SIZE", "2048")))
        self._cache: OrderedDict[str, dict] = OrderedDict()

    def _load(self):
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(self.path)
            self._engine.configure({"Threads": 1, "Hash": 128})
        return self._engine

    def analyze(
        self, board: chess.Board, time_ms: int | None = None, lines: int | None = None
    ) -> dict:
        requested_time_ms = self.time_ms if time_ms is None else max(100, min(5_000, time_ms))
        requested_lines = self.lines if lines is None else max(1, min(5, lines))
        key = f'{board.fen(en_passant="fen")}|{requested_time_ms}|{requested_lines}'
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return {**cached, "lines": [dict(line) for line in cached["lines"]]}
            analyses = self._load().analyse(
                board,
                chess.engine.Limit(time=requested_time_ms / 1000),
                multipv=requested_lines,
            )
            lines = [self._line(board, item) for item in analyses]
            result = {
                "engine": f"Stockfish {self.version}",
                "depth": min((item.get("depth", 0) for item in analyses), default=0),
                "lines": lines,
            }
            if self._cache_size:
                self._cache[key] = {**result, "lines": [dict(line) for line in lines]}
                self._cache.move_to_end(key)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
            return result

    @staticmethod
    def _line(board: chess.Board, analysis: dict) -> dict:
        pv = analysis.get("pv", [])
        move = pv[0] if pv else None
        # Conventional engine evaluations are always shown from White's perspective.
        score = analysis["score"].white()
        mate = score.mate()
        evaluation = ({"type": "mate", "value": mate} if mate is not None else
                      {"type": "cp", "value": score.score(mate_score=100_000)})
        return {
            "uci": move.uci() if move else None,
            "san": board.san(move) if move else None,
            "evaluation": evaluation,
            "pv": board.variation_san(pv[:8]) if pv else "",
        }


stockfish = StockfishEngine()
