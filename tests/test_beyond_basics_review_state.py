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


def test_effective_names_preserve_saved_review_history(tmp_path, monkeypatch):
    import sqlite3

    from app.beyond_basics_names import effective_course_script

    script = 'const COURSE=[{"id":"Kay","title":"Russell’s lesson","body":"Manning and Kay meet Max, Hal and Magnus.","url":"/Kay.png"}];\nconst GRAPHICS={"Kay":"art.png"};'
    result = effective_course_script(script)
    assert 'Steve’s lesson' not in result  # JSON deliberately escapes non-ASCII
    assert 'Steve\\u2019s lesson' in result
    assert 'Mark and Beth meet Max, Hal and Magnus.' in result
    assert '"id":"Kay"' in result and '"url":"/Kay.png"' in result
    assert result.endswith('const GRAPHICS={"Kay":"art.png"};')

    monkeypatch.setenv('BEYOND_BASICS_REVIEW_STATE_DB', str(tmp_path / 'review.db'))
    app = FastAPI()
    async def upstream(_request, _path):
        return {'authenticated': True, 'user': {'id': next(iter(REVIEWER_IDS)), 'roles': ['superadmin']}}
    @app.api_route('/studio/api/{path:path}', methods=['GET', 'PUT'])
    async def route(path: str, request: Request):
        return await dispatch(path, request, upstream)
    client = TestClient(app)
    base = '/studio/api/beyond-basics/course-review-v2/review-state'
    manifest = json.loads((__import__('pathlib').Path(__file__).parents[1] / 'app/beyond_basics_course_review_manifest.json').read_text())
    page, source = manifest['page_ids'][0], manifest['source_sha256']
    data = {'source': source, 'page_id': page, 'generation': 0, 'operation': 'save', 'body': "Russell's Manning and Kay; Kayak", 'notes': 'Keep Russell note', 'decision': 'Approve'}
    headers = {'Origin': 'https://ggm.fablelabs.no'}
    assert client.put(base, json=data, headers=headers).status_code == 200
    assert client.put(base, json={'source': source, 'page_id': page, 'generation': 1, 'operation': 'ready'}, headers=headers).status_code == 200
    effective = client.get(base).json()['pages'][page]
    assert effective == {'generation': 2, 'body': "Steve's Mark and Beth; Kayak", 'notes': 'Keep Russell note', 'decision': 'Approve', 'ready': True}
    with sqlite3.connect(tmp_path / 'review.db') as conn:
        assert conn.execute('select body,notes,decision,ready from revisions order by generation desc limit 1').fetchone() == (data['body'], data['notes'], 'Approve', 1)
    assert client.put(base, json={**data, 'generation': 2, 'body': effective['body'] + ' Extra edit'}, headers=headers).status_code == 200
    assert client.get(base).json()['pages'][page]['body'] == "Steve's Mark and Beth; Kayak Extra edit"
