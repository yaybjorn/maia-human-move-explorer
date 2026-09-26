"""Disposable authenticated local host for effects preview/delete QA only."""
import os

os.environ["STUDIO_EFFECTS_DIR"] = os.environ["EFFECTS_QA_DIR"]

from app import main  # noqa: E402


async def qa_author(_request, _path):
    return {"authenticated": True, "csrfToken": "runtime-csrf", "user": {"id": "qa", "roles": ["superadmin"]}}


main.studio_authenticated_read = qa_author
main.STUDIO_ALLOWED_ORIGINS = {"http://127.0.0.1:8934"}
