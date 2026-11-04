import json

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.beyond_basics_review import REVIEWER_IDS, dispatch


def test_review_durable_conflict_ready_and_access(tmp_path, monkeypatch):
    monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB', str(tmp_path / 'review.db'))
    app = FastAPI()
    session = {'authenticated': False}

    async def upstream(_request, _path):
        return session

    @app.api_route('/studio/api/{path:path}', methods=['GET', 'PUT'])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)

    client = TestClient(app)
    base = '/studio/api/beyond-basics/course-review-v2/review-state'
    manifest = json.loads((__import__('pathlib').Path(__file__).parents[1] / 'app/beyond_basics_course_review_manifest.json').read_text())
    page = manifest['page_ids'][0]
    source = manifest['source_sha256']
    data = {'source': source, 'page_id': page, 'generation': 0, 'operation': 'save', 'body': 'Edited content', 'notes': 'Review note', 'decision': 'Approve'}
    headers = {'Origin': 'https://ggm.fablelabs.no'}
    assert client.get(base).status_code == 401
    session.update(authenticated=True, user={'id': 'other', 'roles': ['superadmin']})
    assert client.put(base, json=data, headers=headers).status_code == 403
    session['user']['id'] = next(iter(REVIEWER_IDS))
    assert client.put(base, json=data).status_code == 403
    assert client.put(base, json=data, headers={'Origin': 'https://attacker.example'}).status_code == 403
    assert client.put(base, json={**data, 'source': 'old'}, headers=headers).status_code == 400
    assert client.put(base, json={**data, 'operation': []}, headers=headers).status_code == 400
    assert client.put(base, json={**data, 'page_id': []}, headers=headers).status_code == 400
    assert client.put(base, json=data, headers=headers).json()['generation'] == 1
    assert client.get(base).json()['pages'][page]['body'] == 'Edited content'
    assert client.put(base, json=data, headers=headers).status_code == 409
    assert client.put(base, json={'source': source, 'page_id': page, 'generation': 1, 'operation': 'ready'}, headers=headers).status_code == 409
    import sqlite3
    with sqlite3.connect(tmp_path / 'review.db') as conn:
        conn.execute("UPDATE review_actions SET status='completed'")
    assert client.put(base, json={'source': source, 'page_id': page, 'generation': 1, 'operation': 'ready'}, headers=headers).json()['ready'] is True
    assert client.get(base).json()['pages'][page]['ready'] is True
    assert client.put(base, json={**data, 'generation': 2, 'notes': 'Changed'}, headers=headers).json()['ready'] is False
    result = client.get(base).json()['pages'][page]
    assert result['generation'] == 3 and result['notes'] == 'Changed' and not result['ready']
    assert client.put(base, json={**data, 'generation': 2}, headers=headers).status_code == 409
    assert client.put(base, json={**data, 'page_id': '../other'}, headers=headers).status_code == 400
    import sqlite3
    with sqlite3.connect(tmp_path / 'review.db') as conn:
        assert conn.execute('select count(*) from revisions').fetchone()[0] == 3


def test_save_action_and_retry_are_atomic(tmp_path, monkeypatch):
    import sqlite3
    from pathlib import Path

    monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB', str(tmp_path / 'review.db'))
    app = FastAPI()
    async def upstream(_request, _path):
        return {'authenticated': True, 'user': {'id': next(iter(REVIEWER_IDS)), 'roles': ['superadmin']}}
    @app.api_route('/studio/api/{path:path}', methods=['GET', 'PUT'])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)
    client = TestClient(app)
    manifest = json.loads((Path(__file__).parents[1] / 'app/beyond_basics_course_review_manifest.json').read_text())
    base = '/studio/api/beyond-basics/course-review-v2/review-state'
    headers = {'Origin': 'https://ggm.fablelabs.no'}
    data = {'source': manifest['source_sha256'], 'page_id': manifest['page_ids'][0], 'generation': 0,
            'operation': 'save', 'body': 'Lesson', 'notes': 'Correct grammar', 'decision': '',
            'request_id': '12345678-1234-1234-1234-123456789abc'}
    first = client.put(base, json=data, headers=headers)
    assert first.status_code == 200
    assert client.put(base, json=data, headers=headers).json() == first.json()
    assert client.put(base, json={**data, 'notes': 'Different'}, headers=headers).status_code == 409
    assert client.put(base, json={**data, 'generation': 1, 'notes': 'x' * 4001, 'request_id': '22345678-1234-1234-1234-123456789abc'}, headers=headers).status_code == 400
    with sqlite3.connect(tmp_path / 'review.db') as conn:
        assert conn.execute('SELECT count(*) FROM revisions').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM review_actions').fetchone()[0] == 1


def test_effective_names_do_not_rewrite_history_or_drop_action(tmp_path, monkeypatch):
    import sqlite3
    from pathlib import Path
    monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB', str(tmp_path / 'review.db'))
    app = FastAPI()
    async def upstream(_request, _path):
        return {'authenticated': True, 'user': {'id': next(iter(REVIEWER_IDS)), 'roles': ['superadmin']}}
    @app.api_route('/studio/api/{path:path}', methods=['GET', 'PUT'])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)
    client = TestClient(app)
    manifest = json.loads((Path(__file__).parents[1] / 'app/beyond_basics_course_review_manifest.json').read_text())
    base = '/studio/api/beyond-basics/course-review-v2/review-state'
    payload = {'source': manifest['source_sha256'], 'page_id': manifest['page_ids'][0],
               'generation': 0, 'operation': 'save', 'body': "Russell, Manning, Kay, Kayak, Max, Hal, Magnus",
               'notes': 'Keep Russell note', 'decision': '', 'request_id': '12345678-1234-1234-1234-123456789abc'}
    headers = {'Origin': 'https://ggm.fablelabs.no'}
    assert client.put(base, json=payload, headers=headers).status_code == 200
    page = client.get(base).json()['pages'][payload['page_id']]
    assert page['body'] == 'Steve, Mark, Beth, Kayak, Max, Hal, Magnus'
    assert page['notes'] == 'Keep Russell note' and page['action']['status'] == 'queued'
    with sqlite3.connect(tmp_path / 'review.db') as conn:
        assert conn.execute('select body from revisions').fetchone()[0] == payload['body']
    assert client.put(base, json={**payload, 'body': 'stale newer edit'}, headers=headers).status_code == 409
    assert client.get(base).json()['pages'][payload['page_id']]['body'] == page['body']


def test_natural_composite_save_runs_worker_and_returns_private_result(tmp_path, monkeypatch):
    import sqlite3
    from pathlib import Path

    from app.beyond_basics_action_queue import claim, finish
    from scripts import review_action_worker as worker

    database = tmp_path / 'review.db'
    monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB', str(database))
    app = FastAPI()
    async def upstream(_request, _path):
        return {'authenticated': True, 'user': {'id': next(iter(REVIEWER_IDS)), 'roles': ['superadmin']}}
    @app.api_route('/studio/api/{path:path}', methods=['GET', 'PUT'])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)
    client = TestClient(app)
    manifest = json.loads((Path(__file__).parents[1] / 'app/beyond_basics_course_review_manifest.json').read_text())
    source = manifest['source_sha256']
    page = '610bd633a68d2d0c3e06e5bc'
    base = '/studio/api/beyond-basics/course-review-v2/review-state'
    data = {'source':source,'page_id':page,'generation':0,'operation':'save','body':'Lesson text',
            'notes':'Could you make the board a bit smaller and show Steve looking happy?', 'decision':'',
            'request_id':'12345678-1234-1234-1234-123456789abc'}
    headers = {'Origin':'https://ggm.fablelabs.no'}
    assert client.put(base,json=data,headers=headers).status_code == 200
    assert client.put(base,json=data,headers=headers).json()['generation'] == 1
    monkeypatch.setattr(worker,'credential',lambda:'fixture')
    def request(action, payload, _credential):
        with sqlite3.connect(database, isolation_level=None) as conn:
            if action == 'claim':
                job = claim(conn,source,now=100)
                job['components'] = [{'body':'Lesson text'}]
                return {'job':job}
            return {'status':finish(conn,source,payload['id'],payload['lease_token'],payload['proposal'],[{'body':'Lesson text'}],now=101)}
    monkeypatch.setattr(worker,'request',request)
    assert worker.run() == 'completed'
    result = client.get(base).json()['pages'][page]
    assert result['generation'] == 2 and result['body'] == 'Lesson text'
    assert result['design'] == {'board_size':'small','character':'c01-happy'}
    assert result['action']['status'] == 'completed'
    assert client.put(base,json={**data,'generation':1,'request_id':'22345678-1234-1234-1234-123456789abc'},headers=headers).status_code == 409
