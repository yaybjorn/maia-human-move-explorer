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
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid())
    directory = tmp_path / 'private'; directory.mkdir(mode=0o750); directory.chmod(0o750)
    path = directory / 'keys.json'; now=int(time.time())
    keys=[{'id':'old','key':hashlib.sha256(b'old').hexdigest(),'not_before':now-10,'expires':now+30},
          {'id':'next','key':hashlib.sha256(b'next').hexdigest(),'not_before':now-10,'expires':now+60}]
    def write(rows):
        candidate=directory/'candidate'; candidate.write_text(json.dumps({'version':1,'keys':rows})); candidate.chmod(0o640); candidate.replace(path)
    write(keys)
    monkeypatch.setenv('BEYOND_BASICS_ACTION_KEYRING',str(path))
    app=FastAPI()
    @app.post('/claim')
    async def endpoint(request: Request):
        authorize(request,await request.body(),tmp_path/'nonces.db'); return {'ok':True}
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
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid())
    root=tmp_path/'private'; root.mkdir(mode=0o750); root.chmod(0o750); p=root/'keys.json'
    key={'id':'key','key':'a'*64,'not_before':1,'expires':100}
    def write(keys): p.write_text(json.dumps({'version':1,'keys':keys})); p.chmod(0o640)
    write([key])
    with pytest.raises(ValueError): ring.lookup(p,'key',now=100)
    write([key,key])
    with pytest.raises(ValueError): ring.lookup(p,'key',now=50)
    p.write_text('{')
    with pytest.raises(ValueError): ring.lookup(p,'key',now=50)


def test_overlapping_key_lifetimes_cannot_exceed_one_day(tmp_path, monkeypatch):
    monkeypatch.setattr(ring, 'OWNER_UID', os.getuid())
    root=tmp_path/'private'; root.mkdir(); root.chmod(0o750); p=root/'keys.json'
    rows=[{'id':'old','key':'a'*64,'not_before':0,'expires':200000},
          {'id':'next','key':'b'*64,'not_before':100000,'expires':250000}]
    p.write_text(json.dumps({'version':1,'keys':rows})); p.chmod(0o640)
    with pytest.raises(ValueError): ring.lookup(p,'next',now=100001)
    rows[0]['expires']=186400
    p.write_text(json.dumps({'version':1,'keys':rows}))
    assert ring.lookup(p,'next',now=100001)=='b'*64
