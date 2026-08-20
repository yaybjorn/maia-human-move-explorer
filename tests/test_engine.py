from types import SimpleNamespace

import chess

from app.chess_state import replay
from app.engine import MaiaEngine


class FakeEngine:
    def __init__(self):
        self.cfg = SimpleNamespace(history=8)
        self.calls = 0

    def score_moves(self):
        self.calls += 1
        return None, [{"move": next(iter(self.board.legal_moves)), "policy": 0.5}]


def test_prediction_cache_includes_history_and_ratings(monkeypatch):
    fake = FakeEngine()
    engine = MaiaEngine()
    monkeypatch.setattr(engine, "_load", lambda: fake)
    monkeypatch.setattr("app.engine._tokenize", lambda board: board.fen())

    e4 = replay(chess.STARTING_FEN, ["e2e4"])
    d4 = replay(chess.STARTING_FEN, ["d2d4"])

    first = engine.predict(e4, 1500, 1500)
    assert engine.predict(e4, 1500, 1500) == first
    assert fake.calls == 1

    engine.predict(e4, 1600, 1500)
    engine.predict(d4, 1500, 1500)
    assert fake.calls == 3


def test_prediction_cache_is_bounded(monkeypatch):
    fake = FakeEngine()
    engine = MaiaEngine()
    engine._cache_size = 1
    monkeypatch.setattr(engine, "_load", lambda: fake)
    monkeypatch.setattr("app.engine._tokenize", lambda board: board.fen())

    e4 = replay(chess.STARTING_FEN, ["e2e4"])
    d4 = replay(chess.STARTING_FEN, ["d2d4"])
    engine.predict(e4, 1500, 1500)
    engine.predict(d4, 1500, 1500)
    engine.predict(e4, 1500, 1500)

    assert fake.calls == 3
    assert len(engine._cache) == 1
