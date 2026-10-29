import importlib.util
import json
import subprocess
import time
from pathlib import Path

spec=importlib.util.spec_from_file_location('review_action_supervisor',Path(__file__).parents[1]/'scripts/review_action_supervisor.py')
s=importlib.util.module_from_spec(spec); spec.loader.exec_module(s)


def test_monitor_categories_and_alert_redaction(tmp_path, monkeypatch):
    monkeypatch.setattr(s,'ROOT',tmp_path); now=int(time.time())
    (tmp_path/'active-key-expires').write_text(str(now+14*86400)); (tmp_path/'active-key-expires').chmod(0o600)
    (tmp_path/'status.json').write_text(json.dumps({'version':1,'last_success':now,'consecutive_failures':0,'queue_age_seconds':None}))
    assert s.check(now)=='ok'
    (tmp_path/'status.json').write_text(json.dumps({'version':1,'last_success':now,'consecutive_failures':0,'queue_age_seconds':601}))
    assert s.check(now)=='queue-delayed'
    calls=[]
    def send(args,**kwargs):
        calls.append(args); return subprocess.CompletedProcess(args,0,stdout=b'{"messageId":"123"}',stderr=b'')
    monkeypatch.setattr(s.subprocess,'run',send)
    assert s.alert()=='alert-sent'
    assert s.alert()=='alert-recent'
    assert len(calls)==1 and calls[0][-2]=='Private review worker alert: queue-delayed'
    assert 'instruction' not in ' '.join(calls[0])


def test_singleton_and_redacted_worker_receipt(tmp_path, monkeypatch):
    import fcntl, os
    monkeypatch.setattr(s,'ROOT',tmp_path)
    class Process:
        returncode=0
        def __init__(self,*args,**kwargs): pass
        def communicate(self,timeout):
            assert timeout < 120
            return b'{"status":"No pending action","queue_age_seconds":null}',None
    monkeypatch.setattr(s.subprocess,'Popen',Process)
    assert s.tick()=='ok'
    state=json.loads((tmp_path/'status.json').read_text())
    assert state['last_success'] and state['queue_age_seconds'] is None
    lock=os.open(tmp_path/'worker.lock',os.O_RDWR); fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    try: assert s.tick()=='already-running'
    finally: os.close(lock)


def test_alert_failure_not_recorded_as_delivered(tmp_path, monkeypatch):
    monkeypatch.setattr(s,'ROOT',tmp_path)
    monkeypatch.setattr(s.subprocess,'run',lambda args,**kwargs: subprocess.CompletedProcess(args,1,stdout=b'',stderr=b''))
    assert s.alert()=='alert-delivery-failed'
    assert not (tmp_path/'alert.json').exists()
