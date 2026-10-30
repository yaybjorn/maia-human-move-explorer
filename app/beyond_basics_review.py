"""Private, read-only review assets; course state never enters Studio courses."""
import json
import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response

from app.beyond_basics_action_service import service as action_service
from app.beyond_basics_names import effective_course_script
from app.beyond_basics_review_state import review_state

# A single immutable version, explicitly mapped; no user-supplied filesystem paths.
FILES = {
    "index.html": ("text/html", False),
    "sample.css": ("text/css", False),
    "sample.js": ("application/javascript", False),
    "106399420.mp4": ("video/mp4", False),
    "download.mp4": ("video/mp4", True),
}
REVIEWER_IDS = {
    "623cab89-7ab8-493e-9c2d-4ec6f58c4028",  # Simon
    "e4fcd230-aa60-47bf-8d20-30a413479be2",  # Existing Odin QA account
}


async def dispatch(path, request, upstream_read):
    sample_prefix = "beyond-basics/unit1-sample-v1/"
    extension_prefix = "beyond-basics/course-review-v2/"
    if path in {extension_prefix + "action-claim", extension_prefix + "action-finish"}:
        manifest = json.loads(Path(__file__).with_name("beyond_basics_course_review_manifest.json").read_text())
        return await action_service(request, manifest, "claim" if path.endswith("action-claim") else "finish")
    if path == extension_prefix + "review-state":
        if request.url.query:
            raise HTTPException(404, "Review asset not found")
        session = await upstream_read(request, "session")
        user = session.get("user") or {}
        if not session.get("authenticated"):
            raise HTTPException(401, "Sign in to Course Studio")
        if user.get("id") not in REVIEWER_IDS or "superadmin" not in user.get("roles", []):
            raise HTTPException(403, "This review is not available to this account")
        manifest = json.loads(Path(__file__).with_name("beyond_basics_course_review_manifest.json").read_text())
        return await review_state(request, manifest)
    if request.method != "GET" or request.url.query:
        raise HTTPException(404, "Review asset not found")
    if path.startswith(sample_prefix):
        name = path[len(sample_prefix):]
        files = FILES
        root = Path(os.getenv("BEYOND_BASICS_REVIEW_DIR", "/opt/maia-human-move-explorer/private/beyond-basics/unit1-sample-v1"))
    elif path.startswith(extension_prefix):
        name = path[len(extension_prefix):]
        manifest = json.loads(Path(__file__).with_name("beyond_basics_course_review_manifest.json").read_text())
        files = {key: (value["media_type"], False) for key, value in manifest["files"].items()}
        for key in list(files):
            if key.endswith(".mp4"):
                files["download-" + key] = ("video/mp4", True)
        root = Path(os.getenv("BEYOND_BASICS_COURSE_REVIEW_DIR", "/opt/maia-human-move-explorer/private/beyond-basics/course-review-v2"))
    else:
        raise HTTPException(404, "Review asset not found")
    if name not in files:
        raise HTTPException(404, "Review asset not found")
    session = await upstream_read(request, "session")
    user = session.get("user") or {}
    if not session.get("authenticated"):
        raise HTTPException(401, "Sign in to Course Studio")
    if user.get("id") not in REVIEWER_IDS or "superadmin" not in user.get("roles", []):
        raise HTTPException(403, "This review is not available to this account")
    media_type, download = files[name]
    filename = ("106399420.mp4" if name == "download.mp4" else name.removeprefix("download-")) if download else name
    asset = Path(__file__).with_name("review-assets") / "beyond-basics" / filename if path == extension_prefix + "review.js" else root / filename
    if asset.is_symlink() or not asset.is_file():
        raise HTTPException(404, "Review asset unavailable")
    headers = {"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Content-Type-Options": "nosniff"}
    if path == extension_prefix + "course.js":
        try:
            effective = effective_course_script(asset.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            raise HTTPException(503, "Review content unavailable") from None
        return Response(effective, media_type=media_type, headers=headers)
    return FileResponse(asset, media_type=media_type, headers=headers,
                        filename=("how-the-pieces-move.mp4" if name == "download.mp4" else filename) if download else None)
