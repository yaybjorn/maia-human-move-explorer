"""Install a reviewed key ring from private stdin; never echo credential bytes.

Not an activation command: the directory and group must be pre-provisioned by the
reviewed security procedure. Requires root. No arbitrary destination is accepted.
"""
import grp
import os
import stat
import sys
import tempfile
from pathlib import Path

from app.beyond_basics_action_keyring import lookup

DIRECTORY = Path('/etc/maia-review-action')
DESTINATION = DIRECTORY / 'keys.json'


def install(raw):
    if os.geteuid() != 0 or len(raw) > 4096: raise ValueError('Invalid installation')
    st = DIRECTORY.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o750:
        raise ValueError('Invalid directory')
    gid = grp.getgrnam('maia').gr_gid
    if st.st_gid != gid: raise ValueError('Invalid directory group')
    fd, name = tempfile.mkstemp(prefix='.ring-', dir=DIRECTORY)
    try:
        os.fchown(fd, 0, gid); os.fchmod(fd, 0o640)
        with os.fdopen(fd, 'wb') as f:
            fd = -1; f.write(raw); f.flush(); os.fsync(f.fileno())
        # Validate every key including future successors, without printing it.
        import json
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'version', 'keys'} or data['version'] != 1 or not isinstance(data['keys'], list) or not 1 <= len(data['keys']) <= 2:
            raise ValueError('invalid ring')
        for item in data['keys']:
            lookup(name, item['id'], now=item['not_before'])
        os.replace(name, DESTINATION)
        dfd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(dfd)
        finally: os.close(dfd)
    finally:
        if fd != -1: os.close(fd)
        if os.path.exists(name): os.unlink(name)


if __name__ == '__main__':
    try:
        install(sys.stdin.buffer.read(4097))
        print('Key ring installed')
    except (OSError, ValueError, KeyError, TypeError):
        print('Key ring installation refused', file=sys.stderr)
        raise SystemExit(1) from None
