"""Private, read-only review assets; course state never enters Studio courses."""
import os
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

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
    prefix = "beyond-basics/unit1-sample-v1/"
    if request.method != "GET" or request.url.query or not path.startswith(prefix):
        raise HTTPException(404, "Review asset not found")
    name = path[len(prefix):]
    if name not in FILES:
        raise HTTPException(404, "Review asset not found")
    session = await upstream_read(request, "session")
    user = session.get("user") or {}
    if not session.get("authenticated"):
        raise HTTPException(401, "Sign in to Course Studio")
    if user.get("id") not in REVIEWER_IDS or "superadmin" not in user.get("roles", []):
        raise HTTPException(403, "This review is not available to this account")
    media_type, download = FILES[name]
    filename = "106399420.mp4" if download else name
    root = Path(os.getenv("BEYOND_BASICS_REVIEW_DIR", "/opt/maia-human-move-explorer/private/beyond-basics/unit1-sample-v1"))
    asset = root / filename
    if asset.is_symlink() or not asset.is_file():
        raise HTTPException(404, "Review asset unavailable")
    headers = {"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Content-Type-Options": "nosniff"}
    return FileResponse(asset, media_type=media_type, headers=headers,
                        filename="how-the-pieces-move.mp4" if download else None)
