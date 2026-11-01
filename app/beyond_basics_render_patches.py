"""Conservative component-preserving edits against the immutable private source."""
import hashlib
import html
import json
import os
import re
from pathlib import Path
from xml.etree import ElementTree as ET

from app.beyond_basics_names import effective_course_script

_ALLOWED = {'p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h4', 'div', 'span'}
_BLOCK = {'p', 'br', 'li', 'h4', 'div'}


def source_nodes(page_id, source_asset):
    root = Path(os.getenv('BEYOND_BASICS_COURSE_REVIEW_DIR', '/opt/maia-human-move-explorer/private/beyond-basics/course-review-v2'))
    path = root / 'course.js'
    if path.is_symlink() or not path.is_file() or not isinstance(source_asset, dict):
        raise ValueError('Verified private source unavailable')
    raw = path.read_bytes()
    if len(raw) != source_asset.get('bytes') or hashlib.sha256(raw).hexdigest() != source_asset.get('sha256'):
        raise ValueError('Private source does not match the reviewed manifest')
    script = effective_course_script(raw.decode('utf-8'))
    course, _ = json.JSONDecoder().raw_decode(script[len('const COURSE='):])
    pages = [p for unit in course for p in unit.get('pages', []) if p.get('id') == page_id]
    if len(pages) != 1:
        raise ValueError('Page missing or ambiguous')
    nodes, parts = [], []

    def plain(value):
        # Only a well-formed, unambiguous HTML subset has matching XML/browser
        # text-node and whitespace semantics. Everything else fails closed.
        if '<!' in value or '<?' in value:
            raise ValueError('Unsupported source markup')
        try:
            normalized = re.sub(r'&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);', lambda m: html.escape(html.unescape(m.group()), quote=False), value)
            normalized = re.sub(r'<br\s*>', '<br/>', normalized, flags=re.IGNORECASE)
            root_node = ET.fromstring('<root>' + normalized + '</root>')
        except ET.ParseError as exc:
            raise ValueError('Unsupported source markup') from exc
        def walk(node, ancestors=()):
            if node.tag in _BLOCK and node.tag != 'br' and 'p' in ancestors:
                raise ValueError('Unsupported nested paragraph')
            if node.tag != 'root' and (node.tag not in _ALLOWED or node.attrib):
                raise ValueError('Unsupported source markup')
            out = node.text or ''
            if node.text:
                nodes.append(node.text)
            for child in node:
                out += walk(child, (*ancestors, node.tag))
                if child.tail:
                    nodes.append(child.tail)
                    out += child.tail
            if node.tag in _BLOCK:
                out += '\n'
            return out
        return walk(root_node).strip()

    for component in pages[0].get('components', []):
        for value in (component.get('title'), component.get('body')):
            if value:
                parts.append(plain(value))
        if component.get('type') == 'mediaCarousel':
            for item in component.get('items', []):
                parts.append(plain(item.get('body') or ''))
        if component.get('type') == 'table':
            for row in component.get('rows', []):
                if not all(isinstance(value, str) for value in row):
                    raise ValueError('Unsupported table')
                nodes.extend(row)
                parts.append(' — '.join(row))
    return nodes, '\n\n'.join(p for p in parts if p)


def verify_renderable(page_id, prior, patches, source_asset=None, saved_body=None):
    nodes, aggregate = source_nodes(page_id, source_asset)
    for patch in prior:
        old, new = patch['old'], patch['new']
        matches = [i for i, text in enumerate(nodes) if old in text]
        if len(matches) != 1 or nodes[matches[0]].count(old) != 1 or aggregate.count(old) != 1:
            raise ValueError('Prior edit does not map uniquely')
        nodes[matches[0]] = nodes[matches[0]].replace(old, new, 1)
        aggregate = aggregate.replace(old, new, 1)
    if saved_body != aggregate:
        raise ValueError('Saved text does not match rendered source')
    for patch in patches:
        old, new = patch['old'], patch['new']
        matches = [i for i, text in enumerate(nodes) if old in text]
        if len(matches) != 1 or nodes[matches[0]].count(old) != 1 or aggregate.count(old) != 1:
            raise ValueError('Edit does not map uniquely to the lesson')
        nodes[matches[0]] = nodes[matches[0]].replace(old, new, 1)
        aggregate = aggregate.replace(old, new, 1)
    return [{'old': p['old'], 'new': p['new']} for p in patches]
