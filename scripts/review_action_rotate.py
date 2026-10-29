"""Serialized fixed-purpose credential rotation; no model or secret-bearing argv.

Not installed or activated. Uses existing operator SSH identity only. The worker
never receives this identity; remote ring bytes stay in private pipes/memory.
"""
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
from pathlib import Path

import review_action_supervisor as supervisor
import review_action_worker as worker

ROOT=supervisor.ROOT
SERVICE=worker.SERVICE
GCLOUD='/opt/homebrew/bin/gcloud'
REMOTE='cd /opt/maia-human-move-explorer/current && sudo /usr/bin/python3 -B -m scripts.review_action_keyring_admin '
SOURCE=re.compile(r'^[0-9a-f]{64}$')


def remote(action, payload=b''):
    if action not in ('read','cas'): raise ValueError('Invalid action')
    env=dict(os.environ, CLOUDSDK_PYTHON='/opt/homebrew/bin/python3.12')
    result=subprocess.run([GCLOUD,'--configuration=fablelabs','compute','ssh','fablelabs-web-1','--zone=europe-north1-a','--command',REMOTE+action],input=payload,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=40,env=env,check=True)
    if len(result.stdout)>8192: raise ValueError('Invalid response')
    return result.stdout


def keychain(action, key_id, token=None):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}',key_id): raise ValueError('Invalid identity')
    account='token-'+key_id
    if action=='read':
        result=subprocess.run(['/usr/bin/security','find-generic-password','-s',SERVICE,'-a',account,'-w'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,check=True)
        return result.stdout.decode().strip()
    if action=='create':
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}',token): raise ValueError('Invalid secret')
        # Interactive security receives the secret over stdin, not OS arguments.
        command=f'add-generic-password -s {SERVICE} -a {account} -w {token}\n'
        subprocess.run(['/usr/bin/security','-i'],input=command.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=True)
        if keychain('read',key_id)!=token: raise ValueError('Keychain write not verified')
        return None
    if action=='delete':
        subprocess.run(['/usr/bin/security','delete-generic-password','-s',SERVICE,'-a',account],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,check=True)
        return None
    raise ValueError('Invalid operation')


def atomic(name, value):
    import tempfile
    fd,path=tempfile.mkstemp(prefix='.rotation-',dir=ROOT)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as f:
            fd=-1; f.write(value); f.flush(); os.fsync(f.fileno())
        os.replace(path,ROOT/name)
    finally:
        if fd!=-1: os.close(fd)
        if os.path.exists(path): os.unlink(path)


def read_active():
    path=ROOT/'active-key-id'; st=path.lstat()
    if path.is_symlink() or st.st_uid!=os.getuid() or (st.st_mode&0o777)!=0o600: raise ValueError('Invalid pointer')
    value=path.read_text().strip()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}',value): raise ValueError('Invalid pointer')
    return value


def store_phase(phase, old_id, next_id, started):
    atomic('rotation.json',json.dumps({'phase':phase,'old':old_id,'next':next_id,'started':started}))


def cas(raw, data):
    body=json.dumps({'expected_sha256':hashlib.sha256(raw).hexdigest(),'ring':data},separators=(',',':')).encode()
    if remote('cas',body)!=b'ok': raise ValueError('Rotation unverified')


def run(now=None):
    now=int(time.time() if now is None else now)
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid!=os.getuid() or (ROOT.stat().st_mode&0o777)!=0o700: raise ValueError('Invalid directory')
    lock=os.open(ROOT/'rotation.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return 'already-running'
        raw=remote('read'); data=json.loads(raw); rows=data['keys']
        if data.get('version')!=1 or not SOURCE.fullmatch(data.get('source','')) or not isinstance(rows,list) or len(rows) not in (1,2): raise ValueError('Invalid ring')
        active=read_active(); old=next((x for x in rows if x['id']==active),None)
        if old is None: raise ValueError('Unknown active identity')
        journal=ROOT/'rotation.json'
        try: prior=json.loads(journal.read_text())
        except FileNotFoundError: prior={}
        if len(rows)==1:
            if prior.get('phase') == 'successor-verified' and rows[0]['id'] == prior.get('next'):
                old_secret=keychain('read',prior['old'])
                try:
                    worker.request('finish',{'id':'0'*64,'lease_token':'invalid','proposal':{}},(prior['old'],old_secret))
                except urllib.error.HTTPError as exc:
                    if exc.code != 403: raise ValueError('Old key rejection unverified') from None
                else: raise ValueError('Old key still accepted')
                keychain('delete',prior['old']); store_phase('retired',prior['old'],prior['next'],now)
                return 'rotation-reconciled'
            if prior.get('phase') not in (None,'retired'): raise ValueError('Reconciliation required')
            if now-old['not_before']<21*86400: return 'not-due'
            next_id='k'+secrets.token_hex(12); token=secrets.token_urlsafe(32)
            store_phase('prepared',active,next_id,now)
            keychain('create',next_id,token)
            shortened=dict(old,expires=min(old['expires'],now+86400))
            candidate={'version':1,'source':data['source'],'keys':[shortened,{'id':next_id,'key':hashlib.sha256(token.encode()).hexdigest(),'not_before':now,'expires':now+30*86400}]}
            cas(raw,candidate); store_phase('ring-published',active,next_id,now)
            rows=candidate['keys']; raw=remote('read')
        else:
            if prior.get('phase') not in ('prepared','ring-published','bridge-selected','successor-verified') or {x['id'] for x in rows}!={prior.get('old'),prior.get('next')}: raise ValueError('Reconciliation required')
            next_id=prior['next']; active=prior['old']; token=keychain('read',next_id)
        successor=next(x for x in rows if x['id']==next_id)
        if hashlib.sha256(token.encode()).hexdigest()!=successor['key']: raise ValueError('Successor mismatch')
        worker_lock=os.open(ROOT/'worker.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            try: fcntl.flock(worker_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: return 'worker-busy'
            atomic('active-key-id',next_id); atomic('active-key-expires',str(successor['expires']))
            store_phase('bridge-selected',active,next_id,now)
            # Normal invocation: a claimed job is processed and finished, never discarded.
            env=dict(os.environ,REVIEW_ACTION_SUPERVISED='1')
            proc=subprocess.Popen([sys.executable,str(Path(worker.__file__))],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,pass_fds=(worker_lock,),env=env)
            try: rc=proc.wait(timeout=105)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid,9); proc.wait(timeout=5); raise ValueError('Worker timed out')
            if rc: raise ValueError('Successor verification failed')
            store_phase('successor-verified',active,next_id,now)
            old_secret=keychain('read',active)
            current=remote('read'); observed=json.loads(current)
            if {x['id'] for x in observed['keys']}!={active,next_id}: raise ValueError('Ring changed')
            cas(current,{'version':1,'source':data['source'],'keys':[successor]})
            try:
                worker.request('finish',{'id':'0'*64,'lease_token':'invalid','proposal':{}},(active,old_secret))
            except urllib.error.HTTPError as exc:
                if exc.code!=403: raise ValueError('Old key rejection unverified') from None
            else: raise ValueError('Old key still accepted')
            keychain('delete',active); store_phase('retired',active,next_id,now)
            return 'rotated'
        finally: os.close(worker_lock)
    finally: os.close(lock)


if __name__=='__main__':
    try:
        result=run(); atomic('rotation-outcome.json',json.dumps({'outcome':result,'at':int(time.time())})); print(result)
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError,urllib.error.URLError):
        try: atomic('rotation-outcome.json',json.dumps({'outcome':'rotation-failed','at':int(time.time())}))
        except OSError: pass
        print('rotation-failed')
        raise SystemExit(1) from None
