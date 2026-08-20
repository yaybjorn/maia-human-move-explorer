import chess
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_does_not_load_model():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["model"] == "maia3-5m"


def test_state_contract_and_history():
    response = client.post("/api/state", json={"moves": ["e2e4", "c7c5"]})
    data = response.json()
    assert response.status_code == 200
    assert data["san_history"] == ["e4", "c5"]
    assert len(data["legal_moves"]) == 30
    assert data["position_only"] is False


def test_pasted_fen_is_position_only():
    fen = "8/8/8/8/8/4k3/8/4K3 w - - 0 1"
    response = client.post("/api/state", json={"initial_fen": fen, "moves": []})
    assert response.json()["position_only"] is True


def test_validation_and_input_limits():
    assert client.get("/api/validate-fen", params={"fen": chess.STARTING_FEN}).json()["valid"]
    assert client.get("/api/validate-fen", params={"fen": "bad"}).status_code == 422
    assert client.post("/api/predict", json={"rating": 5001}).status_code == 422


def test_predict_contract_without_loading_weights(monkeypatch):
    monkeypatch.setattr("app.main.engine.predict", lambda *_: [
        {"uci": "e2e4", "san": "e4", "probability": 0.25}
    ])
    response = client.post("/api/predict", json={"rating": 1500, "opponent_rating": 1600})
    assert response.status_code == 200
    assert response.json()["suggestions"][0]["san"] == "e4"

