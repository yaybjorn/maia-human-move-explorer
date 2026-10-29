"""Read an atomic, owner-protected, finite review-action key ring."""
import json
import os
import re
import stat
import time
from pathlib import Path

KEY_ID = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
KEY = re.compile(r'^[0-9a-f]{64}$')
OWNER_UID = 0


def lookup(path, key_id, now=None):
    if not KEY_ID.fullmatch(key_id):
        raise ValueError('invalid key identity')
    path = Path(path)
    if not path.is_absolute() or path.name in ('', '.', '..'):
        raise ValueError('invalid keyring path')
    # Open the directory and entry without following symlinks; the resulting
    # descriptors bind reads to the checked objects across atomic replacements.
    dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        ds = os.fstat(dfd)
        if ds.st_uid != OWNER_UID or stat.S_IMODE(ds.st_mode) != 0o750:
            raise ValueError('invalid keyring directory')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != OWNER_UID or stat.S_IMODE(st.st_mode) != 0o640 or st.st_size > 4096:
                raise ValueError('invalid keyring file')
            with os.fdopen(fd, 'rb') as f:
                fd = -1
                raw = f.read(4097)
        finally:
            if fd != -1: os.close(fd)
    finally:
        os.close(dfd)
    if len(raw) > 4096: raise ValueError('keyring too large')
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {'version', 'keys'} or data['version'] != 1 or not isinstance(data['keys'], list) or not 1 <= len(data['keys']) <= 2:
        raise ValueError('invalid keyring')
    seen = set(); selected = None; windows = []
    for row in data['keys']:
        if not isinstance(row, dict) or set(row) != {'id', 'key', 'not_before', 'expires'}:
            raise ValueError('invalid key')
        ident, key, start, end = row['id'], row['key'], row['not_before'], row['expires']
        if not isinstance(ident, str) or not KEY_ID.fullmatch(ident) or ident in seen or not isinstance(key, str) or not KEY.fullmatch(key) or type(start) is not int or type(end) is not int or end <= start or end - start > 31 * 86400:
            raise ValueError('invalid key')
        seen.add(ident); windows.append((start, end))
        if ident == key_id and start <= (time.time() if now is None else now) < end: selected = key
    if len(windows) == 2 and min(w[1] for w in windows) - max(w[0] for w in windows) > 86400:
        raise ValueError('overlap exceeds one day')
    if selected is None: raise ValueError('key unavailable')
    return selected
