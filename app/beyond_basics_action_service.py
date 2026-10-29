"""Fixed-purpose private review queue endpoint; disabled without scoped configuration."""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from app.beyond_basics_action_queue import claim, ensure_schema, finish
from app.beyond_basics_action_keyring import lookup


def page_components(manifest, page_id, conn, generation):
    if page_id not in manifest['page_ids']:
        raise ValueError('Unknown page')
    row = conn.execute('SELECT body FROM revisions WHERE source=? AND page_id=? AND generation=?',
                       (manifest['source_sha256'], page_id, generation)).fetchone()
    if not row or not isinstance(row[0], str):
        raise ValueError('Saved revision unavailable')
    return [{'body': row[0]}]


def authorize(request, body, db, source=None):
    """No fallback to browser sessions, and no credential ever reaches inference."""
    supplied = request.headers.get('authorization', '')
    if request.headers.get('origin') or len(supplied) > 256:
        raise HTTPException(403, 'Unavailable')
    ring = os.getenv('BEYOND_BASICS_ACTION_KEYRING', '')
    try:
        if ring:
            if not supplied.startswith('Review-HMAC2 '): raise ValueError('scheme')
            key_id, timestamp, nonce, signature = supplied[13:].split(':')
            configured = lookup(ring, key_id, source=source)
            prefix = key_id + '\n'
        else:
            configured = os.getenv('BEYOND_BASICS_ACTION_TOKEN_SHA256', '')
            expiry = int(os.getenv('BEYOND_BASICS_ACTION_TOKEN_EXPIRES', ''))
            if not supplied.startswith('Review-HMAC ') or time.time() >= expiry or not re.fullmatch(r'[0-9a-f]{64}', configured): raise ValueError('configuration')
            timestamp, nonce, signature = supplied[12:].split(':')
            prefix = ''
        if not (timestamp.isdigit() and abs(time.time() - int(timestamp)) <= 60 and re.fullmatch(r'[0-9a-f]{32}', nonce) and re.fullmatch(r'[0-9a-f]{64}', signature)):
            raise ValueError('signature format')
        content_hash = hashlib.sha256(body).hexdigest()
        message = f'{prefix}{request.method}\n{request.url.path}\n{timestamp}\n{nonce}\n{content_hash}'.encode()
        expected = hmac.new(bytes.fromhex(configured), message, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature): raise ValueError('signature')
    except (ValueError, TypeError, OSError, KeyError, json.JSONDecodeError):
        raise HTTPException(403, 'Unavailable') from None
    with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('CREATE TABLE IF NOT EXISTS review_action_nonces (nonce TEXT PRIMARY KEY, used_at REAL NOT NULL)')
        conn.execute('DELETE FROM review_action_nonces WHERE used_at < ?', (time.time() - 120,))
        if conn.execute('SELECT count(*) FROM review_action_nonces').fetchone()[0] >= 120:
            conn.rollback()
            raise HTTPException(429, 'Please retry later')
        try:
            conn.execute('INSERT INTO review_action_nonces VALUES (?,?)', (nonce, time.time()))
        except sqlite3.IntegrityError:
            conn.rollback()
            raise HTTPException(403, 'Unavailable') from None
        conn.commit()


async def service(request, manifest, action):
    if request.method != 'POST' or request.url.query:
        raise HTTPException(404, 'Unavailable')
    if request.headers.get('content-type', '').split(';')[0] != 'application/json':
        raise HTTPException(415, 'JSON required')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 128000:
            raise HTTPException(413, 'Request too large')
    try:
        data = json.loads(body)
    except ValueError:
        raise HTTPException(400, 'Invalid request') from None
    if not isinstance(data, dict):
        raise HTTPException(400, 'Invalid request')
    db = Path(os.getenv('BEYOND_BASICS_REVIEW_STATE_DB', '/opt/maia-human-move-explorer/private/beyond-basics/review-state/reviews.sqlite3'))
    if not db.parent.is_dir() or db.parent.is_symlink() or db.is_symlink():
        raise HTTPException(503, 'Unavailable')
    source = manifest['source_sha256']
    authorize(request, body, db, source)
    try:
        with sqlite3.connect(db, timeout=5, isolation_level=None) as conn:
            ensure_schema(conn)
            if action == 'claim' and data == {}:
                job = claim(conn, source)
                if job:
                    components = page_components(manifest, job['page_id'], conn, job['generation'])
                    job['components'] = [{key: c[key] for key in ('title', 'body') if isinstance(c.get(key), str)} for c in components]
                    if len(json.dumps(job, ensure_ascii=True)) > 128000:
                        raise ValueError('Page too large')
                oldest = conn.execute("SELECT min(updated_at) FROM review_actions WHERE source=? AND status='queued'", (source,)).fetchone()[0]
                age = None if oldest is None else max(0, min(int(time.time() - oldest), 31 * 86400))
                return JSONResponse({'job': job, 'queue_age_seconds': age}, headers={'Cache-Control': 'private, no-store'})
            if action == 'finish' and set(data) == {'id', 'lease_token', 'proposal'}:
                action_id, token = data['id'], data['lease_token']
                if not isinstance(action_id, str) or not re.fullmatch(r'[0-9a-f]{64}', action_id) or not isinstance(token, str) or len(token) > 100:
                    raise ValueError('Invalid action')
                row = conn.execute('SELECT page_id,generation FROM review_actions WHERE source=? AND id=?', (source, action_id)).fetchone()
                if not row:
                    raise ValueError('Invalid action')
                components = page_components(manifest, row[0], conn, row[1])
                status = finish(conn, source, action_id, token, data['proposal'], components)
                return JSONResponse({'status': status}, headers={'Cache-Control': 'private, no-store'})
    except (ValueError, KeyError, OSError, sqlite3.Error):
        raise HTTPException(400, 'Request could not be completed') from None
    raise HTTPException(400, 'Invalid request')
