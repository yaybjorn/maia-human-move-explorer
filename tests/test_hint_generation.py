import io
import json

import pytest

from app.hint_generation import HintGenerationError, generate_hints


class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): self.close()


def test_generation_sends_server_side_secret_and_rejects_spoilers(tmp_path, monkeypatch):
    key = tmp_path / "key"
    key.write_text("test-secret")
    key.chmod(0o600)
    monkeypatch.setenv("HINT_OPENAI_KEY_FILE", str(key))
    evidence = {"answer": {"san": "Nf3", "uci": "g1f3"}}
    refs = [{"kind": "handwritten_hint", "text": "Focus on development", "source": "course"}]
    def opener(request, timeout):
        assert request.get_header("Authorization") == "Bearer test-secret"
        payload = json.loads(request.data)
        assert payload["store"] is False
        assert payload["model"] == "gpt-6-astra"
        return Response(json.dumps({"status": "completed", "model": "gpt-6-astra", "output": [{"content": [{"type": "output_text", "text": json.dumps({"candidates": ["Develop with Nf3 now", "Consider piece activity", "Bring a piece towards f3"]})}]}]}).encode())
    with pytest.raises(HintGenerationError, match="disclosed"):
        generate_hints(evidence, refs, opener=opener)


def test_missing_authentic_references_fails_before_key_access():
    with pytest.raises(HintGenerationError, match="reference corpus"):
        generate_hints({}, [{"kind": "style_prose"}])


def test_generation_rejects_unexpected_response_model(tmp_path, monkeypatch):
    key = tmp_path / "key"
    key.write_text("test-secret")
    key.chmod(0o600)
    monkeypatch.setenv("HINT_OPENAI_KEY_FILE", str(key))
    monkeypatch.setenv("HINT_OPENAI_MODEL", "gpt-4.1-mini")
    def opener(request, timeout):
        assert json.loads(request.data)["model"] == "gpt-6-astra"
        return Response(json.dumps({"status": "completed", "model": "gpt-4.1-mini"}).encode())
    with pytest.raises(HintGenerationError, match="unexpected model"):
        generate_hints({"answer": {"san": "Nf3", "uci": "g1f3"}}, [{"kind": "handwritten_hint"}], opener=opener)
