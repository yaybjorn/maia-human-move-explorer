#!/usr/bin/env bash
# Enable a fully prepared private runtime on next normal app restart. No restart here.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
python3 - <<'PY'
import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path
root = Path('/opt/maia-human-move-explorer')
model = root / 'cache/video-models/yolo26m-finetuned.onnx'
expected = 'a8e78afa8e00cd7ee39a941f888327bd85a12c3cf5c2140a4fa882ea3f7abff7'
with model.open('rb') as handle:
    assert hashlib.file_digest(handle, 'sha256').hexdigest() == expected, 'Model hash mismatch'
for path in ['video-runtime/venv/bin/python', 'video-runtime/bin/ffprobe', 'video-runtime/bin/node']:
    assert (root / path).is_file(), 'Runtime missing'
settings = {
    'STUDIO_VIDEO_EXTRACTION_ENABLED': '1',
    'STUDIO_VIDEO_JOBS_DIR': str(root / 'cache/video-extractions'),
    'STUDIO_VIDEO_MODEL': str(model),
    'STUDIO_VIDEO_PYTHON': str(root / 'video-runtime/venv/bin/python'),
    'STUDIO_VIDEO_BIN': str(root / 'video-runtime/bin'),
}
env = Path('/etc/maia-human-move-explorer.env')
if env.exists():
    backup = env.with_name(env.name + '.video-backup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    shutil.copyfile(env, backup)
    backup.chmod(0o600)
lines = env.read_text().splitlines() if env.exists() else []
retained = [line for line in lines if line.split('=', 1)[0] not in settings]
temporary = env.with_suffix('.env.video-next')
temporary.touch(mode=0o600, exist_ok=False)
try:
    temporary.write_text('\n'.join(retained + [f'{key}={value}' for key, value in settings.items()]) + '\n')
    temporary.chmod(0o600)
    temporary.replace(env)
finally:
    temporary.unlink(missing_ok=True)
print('Private video worker enabled for next normal app restart. No secrets displayed.')
PY
