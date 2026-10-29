"""Install a reviewed key ring from private stdin; never echo credential bytes.

Not an activation command: the directory and group must be pre-provisioned by the
reviewed security procedure. Requires root. No arbitrary destination is accepted.
"""
import grp
import fcntl
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

from app.beyond_basics_action_keyring import lookup

DIRECTORY = Path('/etc/maia-review-action')
DESTINATION = DIRECTORY / 'keys.json'
OWNER_UID = 0


def install(raw):
    if os.geteuid() != 0 or len(raw) > 4096: raise ValueError('Invalid installation')
    st = DIRECTORY.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != OWNER_UID or stat.S_IMODE(st.st_mode) != 0o750:
        raise ValueError('Invalid directory')
    gid = grp.getgrnam('maia').gr_gid
    if st.st_gid != gid: raise ValueError('Invalid directory group')
    fd, name = tempfile.mkstemp(prefix='.ring-', dir=DIRECTORY)
    try:
        os.fchown(fd, OWNER_UID, gid); os.fchmod(fd, 0o640)
        with os.fdopen(fd, 'wb') as f:
            fd = -1; f.write(raw); f.flush(); os.fsync(f.fileno())
        # Validate every key including future successors, without printing it.
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'version', 'source', 'keys'} or data['version'] != 1 or not isinstance(data['keys'], list) or not 1 <= len(data['keys']) <= 2:
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


def transaction(operation, raw):
    """Fixed-root, compare-and-swap over private stdin/stdout, serialized."""
    st=DIRECTORY.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=OWNER_UID or st.st_gid!=grp.getgrnam('maia').gr_gid or stat.S_IMODE(st.st_mode)!=0o750: raise ValueError('Invalid directory')
    lock=os.open(DIRECTORY/'rotation.lock',os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if DESTINATION.is_symlink(): raise ValueError('Invalid destination')
        current=DESTINATION.read_bytes() if DESTINATION.exists() else b''
        if len(current)>4096: raise ValueError('oversize existing ring')
        if operation == 'read': return current
        if operation != 'cas': raise ValueError('unknown action')
        data=json.loads(raw)
        if not isinstance(data,dict) or set(data)!={'expected_sha256','ring'} or data['expected_sha256']!=hashlib.sha256(current).hexdigest(): raise ValueError('ring changed')
        candidate=json.dumps(data['ring'],separators=(',',':')).encode()
        install(candidate)
        return b'ok'
    finally: os.close(lock)


if __name__ == '__main__':
    try:
        if sys.argv[1:] not in (['read'],['cas']): raise ValueError('invalid action')
        raw=sys.stdin.buffer.read(8193)
        if len(raw)>8192: raise ValueError('oversize input')
        result=transaction(sys.argv[1],raw)
        sys.stdout.buffer.write(result)
    except (OSError, ValueError, KeyError, TypeError):
        print('Key ring operation refused', file=sys.stderr)
        raise SystemExit(1) from None
