"""Single fixed-purpose bounded worker and redacted liveness status.

This writes no credentials or lesson content and does not itself send alerts.
"""
import fcntl
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path.home() / '.openclaw' / 'review-action'
WORKER = Path(__file__).with_name('review_action_worker.py')
TIMEOUT = 105


def status_write(value):
    fd, name = tempfile.mkstemp(prefix='.status-', dir=ROOT)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            fd = -1; json.dump(value, f); f.flush(); os.fsync(f.fileno())
        os.replace(name, ROOT / 'status.json')
    finally:
        if fd != -1: os.close(fd)
        if os.path.exists(name): os.unlink(name)


def tick():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = ROOT.lstat()
    if ROOT.is_symlink() or st.st_uid != os.getuid() or (st.st_mode & 0o777) != 0o700: raise ValueError('Invalid state directory')
    lock = os.open(ROOT / 'worker.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return 'already-running'
        previous = {}
        try: previous = json.loads((ROOT / 'status.json').read_text())
        except (OSError, ValueError): pass
        proc = subprocess.Popen([sys.executable, str(WORKER)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            output, _ = proc.communicate(timeout=TIMEOUT); code = proc.returncode
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=5)
            output = b''; code = 1
        age = None
        if code == 0:
            try:
                data = json.loads(output)
                age = data['queue_age_seconds']
                if age is not None and (type(age) is not int or not 0 <= age <= 31 * 86400): raise ValueError('bad age')
            except (ValueError, KeyError, TypeError): code = 1
        now = int(time.time()); ok = code == 0
        status_write({'version':1, 'last_attempt':now, 'last_success':now if ok else previous.get('last_success', 0), 'consecutive_failures':0 if ok else min(int(previous.get('consecutive_failures', 0)) + 1, 1000), 'queue_age_seconds': age})
        return 'ok' if ok else 'failed'
    finally:
        os.close(lock)


def check(now=None):
    try:
        state=json.loads((ROOT / 'status.json').read_text())
        if state.get('version') != 1: raise ValueError('bad state')
        now=int(time.time() if now is None else now)
        if state['consecutive_failures'] >= 3: return 'consecutive-failures'
        if now - state['last_success'] > 300: return 'heartbeat-missed'
        if state.get('queue_age_seconds') is not None and state['queue_age_seconds'] > 600: return 'queue-delayed'
        expiry_path = ROOT / 'active-key-expires'
        st = expiry_path.lstat()
        if expiry_path.is_symlink() or st.st_uid != os.getuid() or (st.st_mode & 0o777) != 0o600 or st.st_size > 20: return 'expiry-unavailable'
        expiry = int(expiry_path.read_text().strip())
        if expiry <= now: return 'credential-expired'
        if expiry - now <= 7 * 86400: return 'credential-expiring'
        return 'ok'
    except (OSError, ValueError, KeyError, TypeError): return 'status-unavailable'


def alert():
    """Fixed destination and fixed categories only; no content or arbitrary input."""
    category=check()
    if category == 'ok': return 'ok'
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock=os.open(ROOT/'alert.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return 'already-running'
        previous={}
        try: previous=json.loads((ROOT/'alert.json').read_text())
        except (OSError, ValueError): pass
        now=int(time.time())
        if previous.get('category')==category and now-int(previous.get('sent_at',0)) < 3600: return 'alert-recent'
        result=subprocess.run(['/opt/homebrew/bin/openclaw','message','send','--channel','discord','--target','user:598095875029467136','--message','Private review worker alert: '+category,'--json'], stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20,check=False)
        if result.returncode != 0: return 'alert-delivery-failed'
        try:
            receipt=json.loads(result.stdout)
            if not receipt.get('messageId') and not (isinstance(receipt.get('payload'),dict) and receipt['payload'].get('messageId')): return 'alert-delivery-unverified'
        except (ValueError, TypeError): return 'alert-delivery-unverified'
        fd,name=tempfile.mkstemp(prefix='.alert-',dir=ROOT)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'w') as f:
                fd=-1; json.dump({'category':category,'sent_at':now},f); f.flush(); os.fsync(f.fileno())
            os.replace(name,ROOT/'alert.json')
        finally:
            if fd != -1: os.close(fd)
            if os.path.exists(name): os.unlink(name)
        return 'alert-sent'
    finally: os.close(lock)


if __name__ == '__main__':
    try:
        result=check() if sys.argv[1:] == ['--check'] else alert() if sys.argv[1:] == ['--alert'] else tick() if not sys.argv[1:] else 'invalid-argument'
        print(result)
        raise SystemExit(0 if result in ('ok', 'already-running', 'alert-sent', 'alert-recent') else 1)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print('supervisor-unavailable')
        raise SystemExit(1) from None
