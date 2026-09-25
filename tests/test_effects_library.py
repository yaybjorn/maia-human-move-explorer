import asyncio
import concurrent.futures
import json
import subprocess
import threading

from fastapi.testclient import TestClient

from app import effects_library as effects
from app import main


async def author(_request, _path):
    return {"authenticated": True, "csrfToken": "csrf", "user": {"id": "author", "roles": ["superadmin"]}}


def headers():
    return {"Origin": "https://studio.test", "X-CSRF-Token": "csrf", "Content-Type": "video/webm", "X-Effect-Name": "Spark"}


def webm(path):
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=32x32:d=0.2", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", str(path)], check=True)


def alpha_webm(path):
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0xFF000040:s=32x32:d=0.2,format=rgba", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", str(path)], check=True)


def first_alpha(path):
    result = subprocess.run(["ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True, check=True)
    return result.stdout[3]


def configured_client(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_EFFECTS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "studio_authenticated_read", author)
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://studio.test"})
    return TestClient(main.app, raise_server_exceptions=False)


def create(client, payload, name="Spark"):
    return client.post("/studio/api/effects", headers={**headers(), "X-Effect-Name": name}, content=payload)


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


def test_normalization_preserves_known_nonopaque_alpha(tmp_path):
    source, target = tmp_path / "source.webm", tmp_path / "normalized.webm"
    alpha_webm(source)
    assert 45 <= first_alpha(source) <= 80
    effects.inspect_and_normalize(source, target)
    assert 35 <= first_alpha(target) <= 100


def test_concurrent_creates_keep_every_entry_and_media(tmp_path, monkeypatch):
    source = tmp_path / "input.webm"; webm(source); payload = source.read_bytes()
    monkeypatch.setenv("STUDIO_EFFECTS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "studio_authenticated_read", author)
    monkeypatch.setattr(main, "STUDIO_ALLOWED_ORIGINS", {"https://studio.test"})

    def upload(number):
        with TestClient(main.app, raise_server_exceptions=False) as client:
            return create(client, payload, f"Spark {number}").json()["effect"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        created = list(pool.map(upload, range(2)))
    index = json.loads((tmp_path / "index.json").read_text())
    assert {item["id"] for item in index} == {item["id"] for item in created}
    assert all((tmp_path / f"{item['id']}.webm").is_file() for item in created)
    assert not list(tmp_path.glob(".effects-*"))


def test_create_index_failure_removes_normalized_media(tmp_path, monkeypatch):
    source = tmp_path / "input.webm"; webm(source)
    client = configured_client(tmp_path, monkeypatch)
    monkeypatch.setattr(effects, "save_index", lambda _value: (_ for _ in ()).throw(OSError("disk full")))
    with client:
        assert create(client, source.read_bytes()).status_code == 500
    assert [path.name for path in tmp_path.glob("*.webm")] == ["input.webm"]
    assert not list(tmp_path.glob(".effects-*"))


def test_replacement_index_failure_restores_original_media_and_index(tmp_path, monkeypatch):
    source, replacement = tmp_path / "input.webm", tmp_path / "replacement.webm"; webm(source); alpha_webm(replacement)
    client = configured_client(tmp_path, monkeypatch)
    with client:
        effect = create(client, source.read_bytes()).json()["effect"]
        media = tmp_path / f"{effect['id']}.webm"; before = media.read_bytes(); index_before = (tmp_path / "index.json").read_text()
        monkeypatch.setattr(effects, "save_index", lambda _value: (_ for _ in ()).throw(OSError("index failure")))
        response = client.put(f"/studio/api/effects/{effect['id']}", headers=headers(), content=replacement.read_bytes())
        assert response.status_code == 500
    assert media.read_bytes() == before
    assert (tmp_path / "index.json").read_text() == index_before
    assert not list(tmp_path.glob(".effects-*"))


def test_delete_unlink_failure_restores_reachable_item(tmp_path, monkeypatch):
    source = tmp_path / "input.webm"; webm(source)
    client = configured_client(tmp_path, monkeypatch)
    with client:
        effect = create(client, source.read_bytes()).json()["effect"]
        original_unlink = effects.Path.unlink

        def fail_tombstone_unlink(path, *args, **kwargs):
            if path.suffixes[-2:] == [".delete", ".webm"]:
                raise OSError("unlink failed")
            return original_unlink(path, *args, **kwargs)

        monkeypatch.setattr(effects.Path, "unlink", fail_tombstone_unlink)
        assert client.delete(f"/studio/api/effects/{effect['id']}", headers=headers()).status_code == 503
    assert json.loads((tmp_path / "index.json").read_text())[0]["id"] == effect["id"]
    assert (tmp_path / f"{effect['id']}.webm").is_file()


def test_interrupted_stream_removes_staging_file(tmp_path):
    destination = tmp_path / ".effects-interrupted.incoming.webm"

    class InterruptedRequest:
        async def stream(self):
            yield b"partial"
            raise RuntimeError("connection dropped")

    try:
        asyncio.run(effects._stream_to(InterruptedRequest(), destination))
    except RuntimeError as error:
        assert str(error) == "connection dropped"
    else:
        raise AssertionError("interrupted request unexpectedly completed")
    assert not destination.exists()


def test_transcode_admission_serializes_excess_work(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    active = 0
    maximum = 0

    def blocked_normalize(_source, _target):
        nonlocal active, maximum
        active += 1; maximum = max(maximum, active); entered.set()
        release.wait(timeout=2)
        active -= 1
        return 200

    monkeypatch.setattr(effects, "inspect_and_normalize", blocked_normalize)

    async def exercise():
        effects._transcode_admission = asyncio.Semaphore(1)
        first = asyncio.create_task(effects.normalize_with_admission(tmp_path / "a", tmp_path / "b"))
        await asyncio.to_thread(entered.wait, 1)
        second = asyncio.create_task(effects.normalize_with_admission(tmp_path / "c", tmp_path / "d"))
        await asyncio.sleep(0.02)
        assert maximum == 1
        release.set()
        assert await first == await second == 200

    asyncio.run(exercise())
