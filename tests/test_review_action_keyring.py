import hashlib
import hmac
import json
import os
import time

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app import beyond_basics_action_keyring as ring
from app.beyond_basics_action_service import authorize


def test_ring_permissions_rotation_replay_and_revocation(tmp_path, monkeypatch):
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid()); monkeypatch.setattr(ring, 'service_gid', os.getgid)
    directory = tmp_path / 'private'; directory.mkdir(mode=0o750); directory.chmod(0o750)
    path = directory / 'keys.json'; now=int(time.time())
    keys=[{'id':'old','key':hashlib.sha256(b'old').hexdigest(),'not_before':now-10,'expires':now+30},
          {'id':'next','key':hashlib.sha256(b'next').hexdigest(),'not_before':now-10,'expires':now+60}]
    def write(rows):
        candidate=directory/'candidate'; candidate.write_text(json.dumps({'version':1,'source':'a'*64,'keys':rows})); candidate.chmod(0o640); candidate.replace(path)
    write(keys)
    monkeypatch.setenv('BEYOND_BASICS_ACTION_KEYRING',str(path))
    app=FastAPI()
    @app.post('/claim')
    async def endpoint(request: Request):
        authorize(request,await request.body(),tmp_path/'nonces.db','a'*64); return {'ok':True}
    client=TestClient(app)
    def call(key_id, secret, nonce):
        body=b'{}'; timestamp=str(int(time.time())); message=f'{key_id}\nPOST\n/claim\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}'.encode()
        signature=hmac.new(hashlib.sha256(secret).digest(),message,hashlib.sha256).hexdigest()
        return client.post('/claim',content=body,headers={'authorization':f'Review-HMAC2 {key_id}:{timestamp}:{nonce}:{signature}'})
    assert call('old',b'old','a'*32).status_code==200
    assert call('old',b'old','a'*32).status_code==403
    assert call('next',b'next','b'*32).status_code==200
    write(keys[1:])
    assert call('old',b'old','c'*32).status_code==403
    assert call('next',b'next','d'*32).status_code==200
    path.chmod(0o644)
    assert call('next',b'next','e'*32).status_code==403
    path.chmod(0o640); path.unlink(); path.symlink_to('/etc/passwd')
    assert call('next',b'next','f'*32).status_code==403


def test_ring_refuses_expired_duplicate_and_malformed(tmp_path, monkeypatch):
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid()); monkeypatch.setattr(ring, 'service_gid', os.getgid)
    root=tmp_path/'private'; root.mkdir(mode=0o750); root.chmod(0o750); p=root/'keys.json'
    key={'id':'key','key':'a'*64,'not_before':1,'expires':100}
    def write(keys): p.write_text(json.dumps({'version':1,'source':'a'*64,'keys':keys})); p.chmod(0o640)
    write([key])
    with pytest.raises(ValueError): ring.lookup(p,'key',now=100)
    write([key,key])
    with pytest.raises(ValueError): ring.lookup(p,'key',now=50)
    p.write_text('{')
    with pytest.raises(ValueError): ring.lookup(p,'key',now=50)


def test_overlapping_key_lifetimes_cannot_exceed_one_day(tmp_path, monkeypatch):
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid()); monkeypatch.setattr(ring, 'service_gid', os.getgid)
    root=tmp_path/'private'; root.mkdir(); root.chmod(0o750); p=root/'keys.json'
    rows=[{'id':'old','key':'a'*64,'not_before':0,'expires':200000},
          {'id':'next','key':'b'*64,'not_before':100000,'expires':250000}]
    p.write_text(json.dumps({'version':1,'source':'a'*64,'keys':rows})); p.chmod(0o640)
    with pytest.raises(ValueError): ring.lookup(p,'next',now=100001)
    rows[0]['expires']=186400
    p.write_text(json.dumps({'version':1,'source':'a'*64,'keys':rows}))
    assert ring.lookup(p,'next',now=100001)=='b'*64


def test_manifest_group_material_and_max_lifetime_fail_closed(tmp_path,monkeypatch):
    monkeypatch.setattr(ring,'OWNER_UID',os.getuid()); monkeypatch.setattr(ring,'service_gid',os.getgid)
    root=tmp_path/'private'; root.mkdir(); root.chmod(0o750); p=root/'keys.json'
    row={'id':'first','key':'a'*64,'not_before':1,'expires':100}
    def write(rows): p.write_text(json.dumps({'version':1,'source':'b'*64,'keys':rows})); p.chmod(0o640)
    write([row])
    with pytest.raises(ValueError): ring.lookup(p,'first',now=50,source='c'*64)
    monkeypatch.setattr(ring,'service_gid',lambda:os.getgid()+1)
    with pytest.raises(ValueError): ring.lookup(p,'first',now=50,source='b'*64)
    monkeypatch.setattr(ring,'service_gid',os.getgid)
    write([row,dict(row,id='second')])
    with pytest.raises(ValueError): ring.lookup(p,'first',now=50,source='b'*64)
    write([dict(row,expires=1+30*86400+1)])
    with pytest.raises(ValueError): ring.lookup(p,'first',now=50,source='b'*64)


def test_hmac2_scoped_claim_finish_applies_cas(tmp_path,monkeypatch):
    import sqlite3
    from app.beyond_basics_action_queue import enqueue,ensure_schema
    from app.beyond_basics_action_service import service
    monkeypatch.setattr(ring,'OWNER_UID',os.getuid()); monkeypatch.setattr(ring,'service_gid',os.getgid)
    directory=tmp_path/'private'; directory.mkdir(); directory.chmod(0o750); path=directory/'keys.json'
    now=int(time.time()); secret=b'fixture-key'; source='e'*64
    path.write_text(json.dumps({'version':1,'source':source,'keys':[{'id':'key','key':hashlib.sha256(secret).hexdigest(),'not_before':now-1,'expires':now+100}]})); path.chmod(0o640)
    monkeypatch.setenv('BEYOND_BASICS_ACTION_KEYRING',str(path)); monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB',str(tmp_path/'db'))
    with sqlite3.connect(tmp_path/'db') as db:
        db.execute('CREATE TABLE revisions(source TEXT,page_id TEXT,generation INTEGER,body TEXT,notes TEXT DEFAULT "",decision TEXT DEFAULT "",ready INTEGER DEFAULT 0,PRIMARY KEY(source,page_id,generation))')
        ensure_schema(db); db.execute('INSERT INTO revisions(source,page_id,generation,body) VALUES (?,?,?,?)',(source,'p',1,'Move teh king safely')); enqueue(db,source,'p',1,'Correct spelling')
    app=FastAPI()
    @app.post('/{action}')
    async def endpoint(action:str,request:Request): return await service(request,{'source_sha256':source,'page_ids':['p']},action)
    client=TestClient(app)
    def call(action,body,nonce):
        payload=json.dumps(body,separators=(',',':')).encode(); ts=str(int(time.time()))
        msg=f'key\nPOST\n/{action}\n{ts}\n{nonce}\n{hashlib.sha256(payload).hexdigest()}'.encode(); sig=hmac.new(hashlib.sha256(secret).digest(),msg,hashlib.sha256).hexdigest()
        return client.post('/'+action,content=payload,headers={'authorization':f'Review-HMAC2 key:{ts}:{nonce}:{sig}','content-type':'application/json'})
    claimed=call('claim',{},'1'*32); assert claimed.status_code==200; job=claimed.json()['job']
    body={'id':job['id'],'lease_token':job['lease_token'],'proposal':{'status':'completed','message':'Corrected','patches':[{'component':0,'field':'body','old':'teh','new':'the'}]}}
    assert call('finish',body,'2'*32).json()['status']=='completed'
    with sqlite3.connect(tmp_path/'db') as db: assert 'the king' in db.execute('SELECT body FROM revisions ORDER BY generation DESC').fetchone()[0]


def test_atomic_installer_never_exposes_partial_json(tmp_path,monkeypatch):
    import concurrent.futures
    from scripts import review_action_keyring_admin as admin
    monkeypatch.setattr(ring,'OWNER_UID',os.getuid()); monkeypatch.setattr(ring,'service_gid',os.getgid)
    root=tmp_path/'private'; root.mkdir(); root.chmod(0o750); path=root/'keys.json'
    monkeypatch.setattr(admin,'DIRECTORY',root); monkeypatch.setattr(admin,'DESTINATION',path); monkeypatch.setattr(admin,'OWNER_UID',os.getuid())
    monkeypatch.setattr(admin.os,'geteuid',lambda:0); monkeypatch.setattr(admin.os,'fchown',lambda *args:None)
    monkeypatch.setattr(admin.grp,'getgrnam',lambda name:type('Group',(),{'gr_gid':os.getgid()})())
    def payload(key): return json.dumps({'version':1,'source':'c'*64,'keys':[{'id':'key','key':key,'not_before':1,'expires':100}]}).encode()
    admin.install(payload('a'*64))
    def reader():
        for _ in range(150):
            assert ring.lookup(path,'key',now=50,source='c'*64) in ('a'*64,'b'*64)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        future=pool.submit(reader)
        for i in range(30): admin.install(payload(('a' if i%2 else 'b')*64))
        future.result()


def test_default_missing_ring_never_falls_back_to_legacy(tmp_path,monkeypatch):
    monkeypatch.delenv('BEYOND_BASICS_ACTION_KEYRING',raising=False)
    monkeypatch.delenv('BEYOND_BASICS_ACTION_LEGACY_CANARY',raising=False)
    monkeypatch.setenv('BEYOND_BASICS_ACTION_TOKEN_SHA256',hashlib.sha256(b'old').hexdigest())
    monkeypatch.setenv('BEYOND_BASICS_ACTION_TOKEN_EXPIRES',str(int(time.time())+300))
    app=FastAPI()
    @app.post('/claim')
    async def endpoint(request:Request): authorize(request,await request.body(),tmp_path/'db','a'*64); return {'ok':True}
    client=TestClient(app); ts=str(int(time.time())); nonce='a'*32; body=b'{}'
    msg=f'POST\n/claim\n{ts}\n{nonce}\n{hashlib.sha256(body).hexdigest()}'.encode(); sig=hmac.new(hashlib.sha256(b'old').digest(),msg,hashlib.sha256).hexdigest()
    assert client.post('/claim',content=body,headers={'authorization':f'Review-HMAC {ts}:{nonce}:{sig}'}).status_code==403
