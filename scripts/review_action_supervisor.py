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
        env = dict(os.environ, REVIEW_ACTION_SUPERVISED='1')
        proc = subprocess.Popen([sys.executable, str(WORKER)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(lock,), env=env)
        previous_term = signal.getsignal(signal.SIGTERM)
        def terminate(signum, frame): raise SystemExit(1)
        signal.signal(signal.SIGTERM, terminate)
        try:
            try:
                output, _ = proc.communicate(timeout=TIMEOUT); code = proc.returncode
            except subprocess.TimeoutExpired:
                output = b''; code = 1
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        age = None
        if code == 0:
            try:
                data = json.loads(output)
                age = data['queue_age_seconds']
                if age is not None and (type(age) is not int or not 0 <= age <= 31 * 86400): raise ValueError('bad age')
            except (ValueError, KeyError, TypeError): code = 1
        now = int(time.time()); ok = code == 0
        status_write({'version':1, 'last_attempt':now, 'last_success':now if ok else previous.get('last_success', 0), 'consecutive_failures':0 if ok else min(int(previous.get('consecutive_failures', 0)) + 1, 1000), 'remaining_queued_age_seconds': age})
        return 'ok' if ok else 'failed'
    finally:
        os.close(lock)


def check(now=None):
    try:
        state=json.loads((ROOT / 'status.json').read_text())
        if state.get('version') != 1: raise ValueError('bad state')
        now=int(time.time() if now is None else now)
        try:
            rotation=json.loads((ROOT/'rotation-outcome.json').read_text())
            if rotation.get('outcome')=='rotation-failed': return 'rotation-failed'
        except FileNotFoundError: pass
        if state['consecutive_failures'] >= 3: return 'consecutive-failures'
        if now - state['last_success'] > 300: return 'heartbeat-missed'
        if state.get('remaining_queued_age_seconds') is not None and state['remaining_queued_age_seconds'] > 600: return 'queue-delayed'
        expiry_path = ROOT / 'active-key-expires'
        st = expiry_path.lstat()
        if expiry_path.is_symlink() or st.st_uid != os.getuid() or (st.st_mode & 0o777) != 0o600 or st.st_size > 20: return 'expiry-unavailable'
        expiry = int(expiry_path.read_text().strip())
        if expiry <= now: return 'credential-expired'
        if expiry - now <= 7 * 86400: return 'credential-expiring'
        return 'ok'
    except (OSError, ValueError, KeyError, TypeError): return 'status-unavailable'


def alert():
    """Fixed destination and categories; persist delivery failures and episodes."""
    category=check()
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock=os.open(ROOT/'alert.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return 'already-running'
        previous={}
        try: previous=json.loads((ROOT/'alert.json').read_text())
        except (OSError, ValueError): pass
        now=int(time.time())
        episode=previous.get('episode')
        if category == 'ok' and not episode: return 'ok'
        message_category='recovered' if category == 'ok' else category
        if category != 'ok' and episode==category and now-int(previous.get('sent_at',0)) < 3600:
            return 'alert-recent'
        outcome='alert-delivery-failed'
        try:
            result=subprocess.run(['/opt/homebrew/bin/openclaw','message','send','--channel','discord','--target','user:598095875029467136','--message','Private review worker alert: '+message_category,'--json'], stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20,check=False)
            if result.returncode == 0:
                receipt=json.loads(result.stdout)
                if not isinstance(receipt,dict): raise ValueError('invalid receipt')
                if receipt.get('messageId') or (isinstance(receipt.get('payload'),dict) and receipt['payload'].get('messageId')): outcome='alert-sent'
                else: outcome='alert-delivery-unverified'
        except (OSError, ValueError, TypeError, subprocess.SubprocessError): pass
        state={'outcome':outcome,'attempt_at':now,'episode':episode,'sent_at':previous.get('sent_at',0)}
        if outcome == 'alert-sent':
            state['episode']=None if category == 'ok' else category
            state['sent_at']=now
        fd,name=tempfile.mkstemp(prefix='.alert-',dir=ROOT)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'w') as f:
                fd=-1; json.dump(state,f); f.flush(); os.fsync(f.fileno())
            os.replace(name,ROOT/'alert.json')
        finally:
            if fd != -1: os.close(fd)
            if os.path.exists(name): os.unlink(name)
        return outcome
    finally: os.close(lock)


if __name__ == '__main__':
    try:
        result=check() if sys.argv[1:] == ['--check'] else alert() if sys.argv[1:] == ['--alert'] else tick() if not sys.argv[1:] else 'invalid-argument'
        print(result)
        raise SystemExit(0 if result in ('ok', 'already-running', 'alert-sent', 'alert-recent') else 1)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print('supervisor-unavailable')
        raise SystemExit(1) from None
