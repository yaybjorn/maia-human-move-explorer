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


def test_pgn_parse_and_export_contract():
    parsed = client.post("/api/parse-pgn", json={"pgn": "1. e4 (1. d4) e5 *"})
    assert parsed.status_code == 200
    assert [node["san"] for node in parsed.json()["nodes"]] == ["e4", "e5", "d4"]
    exported = client.post("/api/export-pgn", json={
        "nodes": parsed.json()["nodes"], "headers": parsed.json()["headers"],
    })
    assert exported.status_code == 200
    assert "( 1. d4 )" in exported.json()["pgn"]
