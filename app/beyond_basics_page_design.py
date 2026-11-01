"""Small, deterministic private review presentation controls.

Only explicitly recognised requests are mapped to pre-existing design assets.
No source, HTML, URLs or arbitrary styles are accepted from review notes.
"""
import json
import re
from pathlib import Path

BOARD_PAGE = '610bd633a68d2d0c3e06e5bc'
POSES = {'steve': 'c01', 'mark': 'c02', 'max': 'c03',
         'beth': 'c04', 'hal': 'c05', 'magnus': 'c06'}


def requested_design(instruction, page_id):
    instruction = instruction.strip()
    m = re.fullmatch(r'(?:please\s+)?(?:make|show)\s+(?:the\s+)?(?:chess\s*)?board\s+(smaller|larger|bigger)[.!]?', instruction, re.IGNORECASE)
    if m and page_id == BOARD_PAGE:
        return {'board_size': 'small' if m[1].lower() == 'smaller' else 'large'}
    m = re.fullmatch(r'(?:please\s+)?(?:show|use)\s+(steve|mark|max|beth|hal|magnus)(?:\s+(?:as\s+the\s+)?(?:page\s+)?character)?(?:\s+(?:looking\s+)?(happy|thinking|puzzled))?[.!]?', instruction, re.IGNORECASE)
    if m:
        return {'character': POSES[m[1].lower()] + '-' + (m[2] or 'thinking').lower()}
    return None


def current_design(page_id, saved):
    """Effective settings including the reviewed per-page default character."""
    path = Path(__file__).parent / 'review-assets' / 'beyond-basics' / 'review.js'
    source = path.read_text(encoding='utf-8')
    match = re.search(r'const LESSON_POSES=(\{[^\n]*?\});', source)
    if not match:
        raise ValueError('Approved character mapping unavailable')
    defaults = json.loads(match.group(1))
    return {'character': defaults.get(page_id, 'c01-thinking'), 'board_size': 'default', **saved}
