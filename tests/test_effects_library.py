import subprocess

from fastapi.testclient import TestClient

from app import main


async def author(_request, _path):
    return {"authenticated": True, "csrfToken": "csrf", "user": {"id": "author", "roles": ["superadmin"]}}


def headers():
    return {"Origin": "https://studio.test", "X-CSRF-Token": "csrf", "Content-Type": "video/webm", "X-Effect-Name": "Spark"}


def webm(path):
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=32x32:d=0.2", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", str(path)], check=True)


def test_effect_library_requires_session_and_persists_normalized_effect(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_EFFECTS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "studio_authenticated_read", author)
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://studio.test"})
    source = tmp_path / "input.webm"; webm(source)
    with TestClient(main.app) as client:
        denied = client.get("/studio/api/effects")
        assert denied.status_code == 200  # mocked authenticated reader backs all Studio operations
        forbidden = client.post("/studio/api/effects", content=source.read_bytes(), headers={"Content-Type": "video/webm", "X-Effect-Name": "Spark"})
        assert forbidden.status_code == 403
        created = client.post("/studio/api/effects", headers=headers(), content=source.read_bytes())
        assert created.status_code == 201
        effect = created.json()["effect"]
        assert effect["name"] == "Spark" and effect["url"].endswith("/media")
        assert client.get(effect["url"]).headers["content-type"].startswith("video/webm")
        renamed = client.put(f"/studio/api/effects/{effect['id']}", headers={"Origin": "https://studio.test", "X-CSRF-Token": "csrf"}, json={"name": "Spark 2"})
        assert renamed.json()["effect"]["name"] == "Spark 2"
        assert client.delete(f"/studio/api/effects/{effect['id']}", headers=headers()).status_code == 204
        assert client.get(effect["url"]).status_code == 404


def test_effect_library_rejects_bad_name_and_non_webm(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_EFFECTS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "studio_authenticated_read", author)
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://studio.test"})
    with TestClient(main.app) as client:
        response = client.post("/studio/api/effects", headers={**headers(), "Content-Type": "video/mp4", "X-Effect-Name": "\n"}, content=b"not-media")
        assert response.status_code == 422
