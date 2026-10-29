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
    (tmp_path/'status.json').write_text(json.dumps({'version':1,'last_success':now,'consecutive_failures':0,'remaining_queued_age_seconds':None}))
    assert s.check(now)=='ok'
    (tmp_path/'status.json').write_text(json.dumps({'version':1,'last_success':now,'consecutive_failures':0,'remaining_queued_age_seconds':601}))
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
        def poll(self): return self.returncode
        def communicate(self,timeout):
            assert timeout < 120
            return b'{"status":"No pending action","queue_age_seconds":null}',None
    monkeypatch.setattr(s.subprocess,'Popen',Process)
    assert s.tick()=='ok'
    state=json.loads((tmp_path/'status.json').read_text())
    assert state['last_success'] and state['remaining_queued_age_seconds'] is None
    lock=os.open(tmp_path/'worker.lock',os.O_RDWR); fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    try: assert s.tick()=='already-running'
    finally: os.close(lock)


def test_alert_failure_not_recorded_as_delivered(tmp_path, monkeypatch):
    monkeypatch.setattr(s,'ROOT',tmp_path)
    monkeypatch.setattr(s.subprocess,'run',lambda args,**kwargs: subprocess.CompletedProcess(args,1,stdout=b'',stderr=b''))
    assert s.alert()=='alert-delivery-failed'
    assert json.loads((tmp_path/'alert.json').read_text())['outcome']=='alert-delivery-failed'


def test_real_supervisor_death_keeps_singleton_until_worker_exits(tmp_path):
    import fcntl, os, signal, sys
    worker=tmp_path/'dummy.py'
    worker.write_text('import signal,time,sys\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(2)\n')
    module=str(Path(__file__).parents[1]/'scripts/review_action_supervisor.py')
    code="import importlib.util,pathlib; s=importlib.util.spec_from_file_location('s',%r); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.ROOT=pathlib.Path(%r);m.WORKER=pathlib.Path(%r);m.tick()" % (module,str(tmp_path),str(worker))
    parent=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
    try:
        deadline=time.monotonic()+3
        while not (tmp_path/'worker.lock').exists() and time.monotonic()<deadline: time.sleep(.01)
        time.sleep(.1); os.kill(parent.pid,signal.SIGKILL); parent.wait(timeout=2)
        fd=os.open(tmp_path/'worker.lock',os.O_RDWR)
        try:
            import pytest
            with pytest.raises(BlockingIOError): fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
            time.sleep(2.2); fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally: os.close(fd)
    finally:
        if parent.poll() is None: parent.kill(); parent.wait()


def test_alert_recovery_and_new_episode(tmp_path,monkeypatch):
    monkeypatch.setattr(s,'ROOT',tmp_path)
    values=iter(['heartbeat-missed','ok','heartbeat-missed'])
    monkeypatch.setattr(s,'check',lambda:next(values))
    calls=[]
    def send(args,**kwargs): calls.append(args); return subprocess.CompletedProcess(args,0,stdout=b'{"messageId":"123"}',stderr=b'')
    monkeypatch.setattr(s.subprocess,'run',send)
    assert [s.alert(),s.alert(),s.alert()]==['alert-sent']*3
    assert [args[-2] for args in calls]==['Private review worker alert: heartbeat-missed','Private review worker alert: recovered','Private review worker alert: heartbeat-missed']
