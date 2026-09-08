#!/usr/bin/env bash
# Provision only the pinned public OCR model. Dependencies belong to the worker venv.
# Usage: prepare-video-ocr.sh MODEL_DIRECTORY [EXISTING_CACHED_MODEL]
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: prepare-video-ocr.sh MODEL_DIRECTORY [EXISTING_CACHED_MODEL]' >&2
  exit 2
fi
ocr_directory=$1
ocr_cached_model=${2:-}
mkdir -p "$ocr_directory"
ocr_python=${VIDEO_OCR_PYTHON:-python3}
"$ocr_python" - "$ocr_directory" "$ocr_cached_model" <<'PY'
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request

destination = Path(sys.argv[1]) / 'yolo26m-finetuned.onnx'
expected = 'a8e78afa8e00cd7ee39a941f888327bd85a12c3cf5c2140a4fa882ea3f7abff7'
url = ('https://huggingface.co/AndrewSpano/2d-chess-ocr/resolve/'
       '03d9df9fc14fade1a3579683fd0de215b3864ee1/yolo26m-finetuned.onnx')

def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()

if destination.is_file() and digest(destination) == expected:
    print('Pinned OCR model already verified.')
    raise SystemExit(0)
fd, temporary_name = tempfile.mkstemp(prefix='.ocr-model-', dir=destination.parent)
os.close(fd)
temporary = Path(temporary_name)
try:
    if sys.argv[2]:
        cached = Path(sys.argv[2])
        if not cached.is_file() or cached.stat().st_size > 256 * 1024**2:
            raise SystemExit('Cached OCR model missing or oversized.')
        shutil.copyfile(cached, temporary)
    else:
        # Public asset only: no authentication, secrets, or environment credentials.
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as out:
            written = 0
            while chunk := response.read(1024 * 1024):
                written += len(chunk)
                if written > 256 * 1024**2:
                    raise SystemExit('Model download exceeded expected size bound.')
                out.write(chunk)
    if digest(temporary) != expected:
        raise SystemExit('Model SHA-256 mismatch; existing model was not changed.')
    temporary.chmod(0o644)
    temporary.replace(destination)
    print('Pinned OCR model verified and installed.')
finally:
    temporary.unlink(missing_ok=True)
PY
