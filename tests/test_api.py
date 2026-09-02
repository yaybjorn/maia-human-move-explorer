from email.message import Message
from pathlib import Path

import chess
from fastapi.testclient import TestClient

from app.main import PgnRequest, PgnTreeRequest, app, studio_path_allowed
from app.portsmouth import portsmouth

client = TestClient(app)
ROOT = Path(__file__).resolve().parents[1]


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


def test_pgn_round_trip_preserves_comments_nags_directives_and_nested_variations():
    source = (
        '[Event "Course"]\n\n'
        '1. e4! {Main idea. [%csl Ge4]}'
        ' (1. d4 {Queen pawn.} d5 (1... Nf6 $5 {Indian. [%cal Gg1f3]}))'
        ' 1... c5 {Sicilian.} *'
    )
    parsed = client.post("/api/parse-pgn", json={"pgn": source})
    assert parsed.status_code == 200
    nodes = parsed.json()["nodes"]
    assert any(node["comment"] == "Main idea. [%csl Ge4]" for node in nodes)
    assert any(1 in node["nags"] for node in nodes)
    exported = client.post(
        "/api/export-pgn", json={"nodes": nodes, "headers": parsed.json()["headers"]}
    )
    assert exported.status_code == 200
    reparsed = client.post("/api/parse-pgn", json={"pgn": exported.json()["pgn"]})
    assert reparsed.status_code == 200
    semantics = lambda values: sorted(
        (node["uci"], node["comment"], node["starting_comment"], node["nags"])
        for node in values
    )
    assert semantics(reparsed.json()["nodes"]) == semantics(nodes)


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


def test_chapter_editor_page_and_course_proxy(monkeypatch):
    catalog = {
        "openings": [
            {
                "id": "portsmouth-gambit",
                "title": "Portsmouth Gambit",
                "version": "1.2.3",
                "packURL": "packs/portsmouth-gambit/1.2.3.json",
            }
        ]
    }
    pack = {"id": "portsmouth-gambit", "version": "1.2.3", "positions": []}

    def fake_fetch(url):
        return catalog if url.endswith("/v1/catalog") else pack

    monkeypatch.setattr("app.main.fetch_json", fake_fetch)

    page = client.get("/chapters")
    assert page.status_code == 200
    assert "GingerGM Chapter Editor" in page.text
    assert page.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
    courses = client.get("/api/chapter-courses")
    assert courses.json()["openings"][0]["version"] == "1.2.3"
    course = client.get("/api/chapter-courses/portsmouth-gambit")
    assert course.json() == pack
    assert client.get("/api/chapter-courses/not_allowed").status_code == 404


def test_chapter_editor_board_uses_bounded_eight_by_eight_grid():
    css = client.get("/static/chapters.css")

    assert css.status_code == 200
    assert "grid-template-columns:repeat(8,minmax(0,1fr))" in css.text
    assert "grid-template-rows:repeat(8,minmax(0,1fr))" in css.text
    assert ".square{display:grid;place-items:center;min-width:0;min-height:0;overflow:hidden}" in css.text


def test_course_studio_page_and_mobile_safe_board_grid():
    page = client.get("/studio")
    css = client.get("/static/studio.css")
    assert page.status_code == 200
    assert "GingerGM Course Studio" in page.text
    assert page.headers["cache-control"] == "no-store"
    assert '/static/studio.js?v=20260902-course-videos' in page.text
    studio_source = (ROOT / "app" / "static" / "studio.js").read_text()
    assert './studio-api.mjs?v=20260902-editor-engine' in studio_source
    assert './studio-document.mjs?v=20260902-course-videos' in studio_source
    assert './studio-engine.mjs?v=20260902-editor-engine' in studio_source
    assert 'to shared dictionary</button>' in studio_source
    assert 'runSpellcheck({refreshDictionary:false})' in studio_source
    assert page.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
    assert "grid-template-columns:repeat(8,minmax(0,1fr))" in css.text
    assert "grid-template-rows:repeat(8,minmax(0,1fr))" in css.text
    assert "min-width:0;min-height:0;overflow:hidden" in css.text
    assert 'id="raw-pgn-dialog"' in page.text
    assert 'id="preview-chapter"' in page.text
    assert 'id="video-list"' in page.text
    assert 'id="add-video"' in page.text
    assert 'id="editor-eval-bar"' in page.text
    assert 'id="toggle-editor-engine"' in page.text
    assert 'id="flip-board" title="Flip board" aria-label="Flip board">⇅</button>' in page.text
    assert 'id="toggle-editor-engine" type="button" title="Turn engine on" aria-label="Turn engine on" aria-pressed="false"><span aria-hidden="true">⚙</span></button>' in page.text
    assert 'class="editor-engine-control"' not in page.text
    assert ".editor-board-stage.engine-active{grid-template-columns:44px minmax(0,1fr);gap:0}" in css.text
    assert 'aria-expanded="false"' in page.text
    assert "Suggestions never change a course" not in page.text
    assert ".course-card-head{display:flex;align-items:flex-start" in css.text
    assert ".sidebar .nav-item[data-view=details],.sidebar .nav-item[data-view=history]{display:grid}" in css.text


def test_course_studio_dedicated_host_and_legacy_redirect_config():
    dedicated = (ROOT / "deploy" / "nginx.ggm.conf").read_text()
    legacy = (ROOT / "deploy" / "nginx.conf").read_text()

    assert "server_name ggm.fablelabs.no;" in dedicated
    assert "proxy_pass http://127.0.0.1:8310/studio;" in dedicated
    assert "location ^~ /studio/api/" in dedicated
    assert "location ^~ /.well-known/acme-challenge/" in dedicated
    assert "return 308 https://ggm.fablelabs.no/;" in dedicated
    assert "location ^~ /.well-known/acme-challenge/" in legacy
    assert "location = /studio" in legacy
    assert "return 308 https://ggm.fablelabs.no/;" in legacy


def test_course_studio_accepts_full_size_course_pgns():
    schema = PgnRequest.model_json_schema()
    assert schema["properties"]["pgn"]["maxLength"] == 1_800_000
    assert PgnTreeRequest.model_json_schema()["properties"]["nodes"]["maxItems"] == 20_000
    assert studio_path_allowed("import/parse", "POST") is True
    assert studio_path_allowed("ignored-words", "GET") is True
    assert studio_path_allowed("ignored-words", "POST") is True
    assert studio_path_allowed("ignored-words", "DELETE") is False


def test_studio_proxy_is_allowlisted_and_injects_server_secret(monkeypatch):
    received = {}

    def fake_upstream(request):
        received["request"] = request
        headers = Message()
        headers["Content-Type"] = "application/json"
        headers["Set-Cookie"] = "studio_session=abc; Secure; HttpOnly; SameSite=Strict"
        return b'{"user":{"email":"author@example.com"}}', 200, headers

    monkeypatch.setattr("app.main.STUDIO_PROXY_SECRET", "server-only-secret")
    monkeypatch.setattr("app.main.studio_upstream_request", fake_upstream)
    response = client.get(
        "/studio/api/session",
        headers={
            "X-Studio-Proxy-Secret": "attacker-value",
            "X-Studio-Client-IP": "203.0.113.9",
            "Cookie": "studio_session=old",
        },
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["set-cookie"].startswith("studio_session=abc")
    headers = dict(received["request"].header_items())
    assert headers["X-studio-proxy-secret"] == "server-only-secret"
    assert headers["Cookie"] == "studio_session=old"
    assert headers["X-studio-client-ip"] == "testclient"
    assert "Cf-connecting-ip" not in headers
    assert client.delete("/studio/api/courses/course").status_code == 405
    assert client.get("/studio/api/not-allowed").status_code == 404


def test_studio_proxy_rejects_cross_origin_mutations(monkeypatch):
    monkeypatch.setattr("app.main.STUDIO_PROXY_SECRET", "server-only-secret")
    rejected = client.post(
        "/studio/api/login",
        headers={"Origin": "https://attacker.example"},
        json={"email": "author@example.com", "password": "not-a-real-password"},
    )
    assert rejected.status_code == 403


def test_kilkenny_page_and_first_move(monkeypatch):
    response = client.get("/kilkenny")
    assert response.status_code == 200
    assert "Kilkenny Gambit Trainer" in response.text

    monkeypatch.setattr(
        "app.main.engine.choose",
        lambda *args: {"uci": args[-1][0], "san": "", "probability": 1.0},
    )
    wrong = client.post("/api/kilkenny/play", json={"moves": [], "uci": "e2e4"})
    assert wrong.status_code == 200
    assert wrong.json()["correct"] is False

    correct = client.post("/api/kilkenny/play", json={"moves": [], "uci": "d2d4"})
    assert correct.status_code == 200
    assert correct.json()["correct"] is True
    assert correct.json()["moves"][0] == "d2d4"


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


def test_repertoire_check_explains_prose_outside_comment_block():
    response = client.post(
        "/api/check-repertoire",
        json={
            "pgn": "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 "
                   "6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 h7 *",
            "repertoire_side": "white",
        },
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "Invalid PGN near 'h7'" in detail
    assert "comment" in detail


def test_repertoire_check_page_exists():
    response = client.get("/check")
    assert response.status_code == 200
    assert "Repertoire gap check" in response.text
    assert "Writing check" not in response.text
    assert "/spellcheck" in response.text


def test_spellcheck_page_and_context_exist():
    page = client.get("/spellcheck")
    assert page.status_code == 200
    assert "PGN spellcheck" in page.text
    assert "Download fixed PGN" in page.text

    response = client.post(
        "/api/spellcheck-context",
        json={"pgn": "1. e4 {This are wrong.} e5 {A second comment.} *"},
    )
    assert response.status_code == 200
    assert response.json()["sources"] == [
        {
            "history": "1. e4",
            "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            "comment": "This are wrong.",
        },
        {
            "history": "1. e4 e5",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
            "comment": "A second comment.",
        },
    ]


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
