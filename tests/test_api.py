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
    monkeypatch.setattr("app.main.engine.predict", lambda *_: [
        {"uci": "e2e4", "san": "e4", "probability": 0.25}
    ])
    response = client.post("/api/predict", json={"rating": 1500, "opponent_rating": 1600})
    assert response.status_code == 200
    assert response.json()["suggestions"][0]["san"] == "e4"


def test_stockfish_contract_without_starting_process(monkeypatch):
    monkeypatch.setattr("app.main.stockfish.analyze", lambda *_: {
        "engine": "Stockfish 18", "depth": 16, "lines": [{
            "uci": "e2e4", "san": "e4", "evaluation": {"type": "cp", "value": 31},
            "pv": "1. e4 e5",
        }],
    })
    response = client.post("/api/stockfish", json={"moves": []})
    assert response.status_code == 200
    assert response.json()["lines"][0]["evaluation"]["value"] == 31


def test_pgn_parse_and_export_contract():
    parsed = client.post("/api/parse-pgn", json={"pgn": "1. e4 (1. d4) e5 *"})
    assert parsed.status_code == 200
    assert [node["san"] for node in parsed.json()["nodes"]] == ["e4", "e5", "d4"]
    exported = client.post("/api/export-pgn", json={
        "nodes": parsed.json()["nodes"], "headers": parsed.json()["headers"],
    })
    assert exported.status_code == 200
    assert "( 1. d4 )" in exported.json()["pgn"]


def test_portsmouth_rejects_wrong_move_with_authored_feedback():
    response = client.post("/api/portsmouth/play", json={"moves": [], "uci": "f2f3"})
    assert response.status_code == 200
    assert response.json()["correct"] is False
    assert "mistake" in response.json()["feedback"]
    assert response.json()["moves"] == []


def test_portsmouth_correct_move_uses_allowed_maia_response(monkeypatch):
    monkeypatch.setattr("app.main.engine.choose", lambda *args: {
        "uci": "c7c5", "san": "c5", "probability": 0.3,
    })
    response = client.post("/api/portsmouth/play", json={"moves": [], "uci": "e2e4"})
    data = response.json()
    assert response.status_code == 200
    assert data["correct"] is True
    assert data["moves"] == ["e2e4", "c7c5"]
    assert data["white_state"]["moves"] == ["e2e4"]
    assert data["opponent_move"]["san"] == "c5"
    assert data["complete"] is False


def test_portsmouth_page_exists():
    response = client.get("/portsmouth")
    assert response.status_code == 200
    assert "Portsmouth Gambit Trainer" in response.text


def test_portsmouth_line_reaches_stockfish_finish(monkeypatch):
    monkeypatch.setattr("app.main.engine.choose", lambda *args: {
        "uci": args[-1][0], "san": "", "probability": 1.0,
    })
    monkeypatch.setattr("app.main.stockfish.analyze", lambda *_: {
        "engine": "Stockfish 18", "depth": 12, "lines": [{
            "uci": "a2a3", "san": "a3", "evaluation": {"type": "cp", "value": 20},
            "pv": "1. a3",
        }],
    })
    moves = []
    for _ in range(100):
        position = client.post("/api/state", json={"moves": moves}).json()
        puzzle = portsmouth.position(chess.Board(position["fen"]))
        response = client.post("/api/portsmouth/play", json={
            "moves": moves, "uci": puzzle["correctMove"]["uci"],
        })
        data = response.json()
        moves = data["moves"]
        if data["complete"]:
            assert data["stockfish"]["lines"][0]["evaluation"]["value"] == 20
            break
    else:
        raise AssertionError("Portsmouth line did not terminate")
