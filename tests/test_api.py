import chess
from fastapi.testclient import TestClient

from app.main import app
from app.portsmouth import portsmouth

client = TestClient(app)


def test_health_does_not_load_model():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["model"] == "maia3-5m"
    assert response.json()["stockfish"] == "18"


def test_state_contract_and_history():
    response = client.post("/api/state", json={"moves": ["e2e4", "c7c5"]})
    data = response.json()
    assert response.status_code == 200
    assert data["san_history"] == ["e4", "c5"]
    assert len(data["legal_moves"]) == 30
    assert "position_only" not in data


def test_validation_and_input_limits():
    assert client.post("/api/predict", json={"rating": 5001}).status_code == 422


def test_predict_contract_without_loading_weights(monkeypatch):
    monkeypatch.setattr(
        "app.main.engine.predict", lambda *_: [{"uci": "e2e4", "san": "e4", "probability": 0.25}]
    )
    response = client.post("/api/predict", json={"rating": 1500, "opponent_rating": 1600})
    assert response.status_code == 200
    assert response.json()["suggestions"][0]["san"] == "e4"


def test_stockfish_contract_without_starting_process(monkeypatch):
    monkeypatch.setattr(
        "app.main.stockfish.analyze",
        lambda *_: {
            "engine": "Stockfish 18",
            "depth": 16,
            "lines": [
                {
                    "uci": "e2e4",
                    "san": "e4",
                    "evaluation": {"type": "cp", "value": 31},
                    "pv": "1. e4 e5",
                }
            ],
        },
    )
    response = client.post("/api/stockfish", json={"moves": []})
    assert response.status_code == 200
    assert response.json()["lines"][0]["evaluation"]["value"] == 31


def test_pgn_parse_and_export_contract():
    parsed = client.post("/api/parse-pgn", json={"pgn": "1. e4 (1. d4) e5 *"})
    assert parsed.status_code == 200
    assert [node["san"] for node in parsed.json()["nodes"]] == ["e4", "e5", "d4"]
    exported = client.post(
        "/api/export-pgn",
        json={
            "nodes": parsed.json()["nodes"],
            "headers": parsed.json()["headers"],
        },
    )
    assert exported.status_code == 200
    assert "( 1. d4 )" in exported.json()["pgn"]


def test_portsmouth_rejects_wrong_move_with_authored_feedback():
    response = client.post("/api/portsmouth/play", json={"moves": [], "uci": "f2f3"})
    assert response.status_code == 200
    assert response.json()["correct"] is False
    assert "mistake" in response.json()["feedback"]
    assert response.json()["moves"] == []


def test_portsmouth_correct_move_uses_allowed_maia_response(monkeypatch):
    received = {}

    def choose(*args):
        received["self_elo"] = args[1]
        return {
            "uci": "c7c5",
            "san": "c5",
            "probability": 0.3,
        }

    monkeypatch.setattr("app.main.engine.choose", choose)
    response = client.post(
        "/api/portsmouth/play",
        json={
            "moves": [],
            "uci": "e2e4",
            "opponent_rating": 2100,
        },
    )
    data = response.json()
    assert response.status_code == 200
    assert data["correct"] is True
    assert data["moves"] == ["e2e4", "c7c5"]
    assert data["white_state"]["moves"] == ["e2e4"]
    assert data["opponent_move"]["san"] == "c5"
    assert data["complete"] is False
    assert received["self_elo"] == 2100


def test_portsmouth_accepts_be3_after_qe4_check(monkeypatch):
    moves = [
        "e2e4", "c7c5", "g1f3", "b8c6", "b2b4", "c5b4", "d2d4", "d7d5",
        "e4d5", "d8d5", "c2c4", "b4c3", "b1c3", "d5a5", "a1b1", "e7e6",
        "c1d2", "f8b4", "b1b4", "a5b4", "d4d5", "e6d5", "c3d5", "b4e4",
    ]
    monkeypatch.setattr(
        "app.main.engine.choose",
        lambda *args: {"uci": args[-1][0], "san": "", "probability": 1.0},
    )

    response = client.post(
        "/api/portsmouth/play",
        json={"moves": moves, "uci": "d2e3", "opponent_rating": 1500},
    )

    assert response.status_code == 200
    assert response.json()["correct"] is True
    assert response.json()["white_state"]["san_history"][-1] == "Be3"


def test_portsmouth_page_exists():
    response = client.get("/portsmouth")
    assert response.status_code == 200
    assert "Portsmouth Gambit Trainer" in response.text


def test_repertoire_check_finds_probable_missing_opponent_reply(monkeypatch):
    monkeypatch.setattr(
        "app.main.engine._predict_all",
        lambda *_: [
            {"uci": "e7e5", "san": "e5", "probability": 0.48},
            {"uci": "c7c5", "san": "c5", "probability": 0.24},
            {"uci": "e7e6", "san": "e6", "probability": 0.08},
        ],
    )
    monkeypatch.setattr(
        "app.main.stockfish.analyze",
        lambda *_: {"lines": [{"evaluation": {"type": "cp", "value": 0}}]},
    )
    response = client.post(
        "/api/check-repertoire",
        json={"pgn": "1. e4 e5 *", "repertoire_side": "white", "threshold": 0.1},
    )
    data = response.json()
    assert response.status_code == 200
    assert data["positions_analyzed"] == 1
    assert data["positions_needing_attention"] == 1
    assert data["findings"][0]["existing_replies"][0]["san"] == "e5"
    assert data["findings"][0]["missing"] == [
        {"uci": "c7c5", "san": "c5", "probability": 0.24}
    ]


def test_repertoire_check_treats_move_named_in_comment_as_addressed(monkeypatch):
    monkeypatch.setattr(
        "app.main.engine._predict_all",
        lambda *_: [{"uci": "c7c5", "san": "c5", "probability": 0.24}],
    )
    monkeypatch.setattr(
        "app.main.stockfish.analyze",
        lambda *_: {"lines": [{"evaluation": {"type": "cp", "value": 0}}]},
    )
    response = client.post(
        "/api/check-repertoire",
        json={"pgn": "1. e4 {c5 transposes elsewhere.} e5 *", "repertoire_side": "white"},
    )
    assert response.status_code == 200
    assert response.json()["positions_needing_attention"] == 0


def test_repertoire_check_starts_at_first_commented_position(monkeypatch):
    monkeypatch.setattr(
        "app.main.engine._predict_all",
        lambda *_: [
            {"uci": "c5b4", "san": "cxb4", "probability": 0.40},
            {"uci": "g8f6", "san": "Nf6", "probability": 0.20},
        ],
    )
    monkeypatch.setattr(
        "app.main.stockfish.analyze",
        lambda *_: {"lines": [{"evaluation": {"type": "cp", "value": 0}}]},
    )
    response = client.post(
        "/api/check-repertoire",
        json={
            "pgn": "1. e4 c5 2. Nf3 Nc6 3. b4 {The Portsmouth Attack.} cxb4 *",
            "repertoire_side": "white",
            "threshold": 0.1,
        },
    )
    data = response.json()
    assert response.status_code == 200
    assert data["opening_boundary"] == "first_comment"
    assert data["excluded_before_opening"] == 2
    assert data["positions_analyzed"] == 1
    assert data["findings"][0]["history"] == "1. e4 c5 2. Nf3 Nc6 3. b4"
    assert data["findings"][0]["missing"][0]["san"] == "Nf6"


def test_repertoire_check_page_exists():
    response = client.get("/check")
    assert response.status_code == 200
    assert "Repertoire gap check" in response.text


def test_portsmouth_line_reaches_stockfish_finish(monkeypatch):
    monkeypatch.setattr(
        "app.main.engine.choose",
        lambda *args: {
            "uci": args[-1][0],
            "san": "",
            "probability": 1.0,
        },
    )
    monkeypatch.setattr(
        "app.main.stockfish.analyze",
        lambda *_: {
            "engine": "Stockfish 18",
            "depth": 12,
            "lines": [
                {
                    "uci": "a2a3",
                    "san": "a3",
                    "evaluation": {"type": "cp", "value": 20},
                    "pv": "1. a3",
                }
            ],
        },
    )
    moves = []
    for _ in range(100):
        position = client.post("/api/state", json={"moves": moves}).json()
        puzzle = portsmouth.position(chess.Board(position["fen"]))
        response = client.post(
            "/api/portsmouth/play",
            json={
                "moves": moves,
                "uci": puzzle["correctMove"]["uci"],
            },
        )
        data = response.json()
        moves = data["moves"]
        if data["complete"]:
            assert data["stockfish"]["lines"][0]["evaluation"]["value"] == 20
            break
    else:
        raise AssertionError("Portsmouth line did not terminate")
