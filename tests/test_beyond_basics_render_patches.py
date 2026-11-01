import hashlib
import json

import pytest

from app.beyond_basics_render_patches import verify_renderable


def course(tmp_path, monkeypatch, components):
    monkeypatch.setenv('BEYOND_BASICS_COURSE_REVIEW_DIR', str(tmp_path))
    raw = ('const COURSE=' + json.dumps([{'pages':[{'id':'p','components':components}]}]) + ';').encode()
    (tmp_path / 'course.js').write_bytes(raw)
    return {'bytes':len(raw), 'sha256':hashlib.sha256(raw).hexdigest()}


def test_exact_edits_preserve_source_structure_and_compose(tmp_path, monkeypatch):
    asset = course(tmp_path, monkeypatch, [{'body':'<p>Move teh king &amp; queen.</p>'}, {'type':'graphic','body':''}])
    patch = {'old':'teh','new':'the'}
    assert verify_renderable('p', [], [patch], asset, 'Move teh king & queen.') == [patch]
    assert verify_renderable('p', [patch], [{'old':'king','new':'rook'}], asset, 'Move the king & queen.') == [{'old':'king','new':'rook'}]


def test_ambiguous_cross_node_or_divergent_text_refuses_automatic_completion(tmp_path, monkeypatch):
    asset = course(tmp_path, monkeypatch, [{'body':'<p>Move the <em>king</em>.</p><p>Protect the king.</p>'}])
    for old in ('king', 'Move the king', 'missing'):
        with pytest.raises(ValueError):
            verify_renderable('p', [], [{'old':old,'new':'queen'}], asset, 'Move the king.\n\nProtect the king.')
    with pytest.raises(ValueError):
        verify_renderable('p', [], [{'old':'Move','new':'See'}], asset, 'legacy divergent body')


def test_hash_and_unsupported_browser_markup_fail_closed(tmp_path, monkeypatch):
    asset = course(tmp_path, monkeypatch, [{'body':'<template>Move teh king.</template>'}])
    with pytest.raises(ValueError):
        verify_renderable('p', [], [{'old':'teh','new':'the'}], asset, 'Move teh king.')
    with pytest.raises(ValueError):
        verify_renderable('p', [], [{'old':'teh','new':'the'}], {'bytes':1,'sha256':'0'*64}, 'Move teh king.')
