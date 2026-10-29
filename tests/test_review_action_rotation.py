import hashlib
import importlib.util
import json
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0,str(Path(__file__).parents[1]/'scripts'))
import review_action_rotate as r


def test_scheduled_rotation_shortens_and_revokes(tmp_path,monkeypatch):
    now=2_000_000_000; monkeypatch.setattr(r,'ROOT',tmp_path)
    active=tmp_path/'active-key-id'; active.write_text('old'); active.chmod(0o600)
    old_secret='old-secret'*5
    ring={'version':1,'source':'a'*64,'keys':[{'id':'old','key':hashlib.sha256(old_secret.encode()).hexdigest(),'not_before':now-21*86400,'expires':now+9*86400}]}
    store={'ring':ring,'tokens':{'old':old_secret},'published':[]}
    def remote(action,payload=b''):
        current=json.dumps(store['ring'],separators=(',',':')).encode()
        if action=='read': return current
        obj=json.loads(payload); assert obj['expected_sha256']==hashlib.sha256(current).hexdigest()
        store['ring']=obj['ring']; store['published'].append(obj['ring']); return b'ok'
    def keychain(action,key_id,token=None):
        if action=='read': return store['tokens'][key_id]
        if action=='create': store['tokens'][key_id]=token
        if action=='delete': del store['tokens'][key_id]
    class Proc:
        def __init__(self,*args,**kwargs): assert 'pass_fds' in kwargs
        def wait(self,timeout): return 0
    def deny(*args): raise urllib.error.HTTPError('https://fixture.invalid',403,'denied',{},None)
    monkeypatch.setattr(r,'remote',remote); monkeypatch.setattr(r,'keychain',keychain); monkeypatch.setattr(r.subprocess,'Popen',Proc); monkeypatch.setattr(r.worker,'request',deny)
    assert r.run(now)=='rotated'
    first,final=store['published']; assert first['keys'][0]['expires']==now+86400
    assert len(final['keys'])==1 and final['keys'][0]['id']!='old'
    assert 'old' not in store['tokens'] and (tmp_path/'active-key-id').read_text()==final['keys'][0]['id']
    assert json.loads((tmp_path/'rotation.json').read_text())['phase']=='retired'
    assert old_secret not in (tmp_path/'rotation.json').read_text()


def test_failure_after_publish_never_extends_old_expiry(tmp_path,monkeypatch):
    now=2_000_000_000; monkeypatch.setattr(r,'ROOT',tmp_path)
    (tmp_path/'active-key-id').write_text('old'); (tmp_path/'active-key-id').chmod(0o600)
    old='q'*48; state={'ring':{'version':1,'source':'a'*64,'keys':[{'id':'old','key':hashlib.sha256(old.encode()).hexdigest(),'not_before':now-21*86400,'expires':now+9*86400}]},'tokens':{'old':old}}
    def remote(action,payload=b''):
        if action=='read': return json.dumps(state['ring'],separators=(',',':')).encode()
        state['ring']=json.loads(payload)['ring']; return b'ok'
    def keychain(action,key_id,token=None):
        if action=='read': return state['tokens'][key_id]
        if action=='create': state['tokens'][key_id]=token
    class Proc:
        def __init__(self,*args,**kwargs): pass
        def wait(self,timeout): return 1
    monkeypatch.setattr(r,'remote',remote); monkeypatch.setattr(r,'keychain',keychain); monkeypatch.setattr(r.subprocess,'Popen',Proc)
    import pytest
    with pytest.raises(ValueError): r.run(now)
    assert len(state['ring']['keys'])==2 and state['ring']['keys'][0]['expires']==now+86400
    assert json.loads((tmp_path/'rotation.json').read_text())['phase']=='bridge-selected'
