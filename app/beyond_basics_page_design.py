"""Small, deterministic private review presentation controls.

Only explicitly recognised requests are mapped to pre-existing design assets.
No source, HTML, URLs or arbitrary styles are accepted from review notes.
"""
import hashlib
import json
import re
from pathlib import Path

BOARD_PAGE = '610bd633a68d2d0c3e06e5bc'
INTRO_PAGE = '610bd633a68d2d0c3e06e5ac'
CHECK_PAGE = '610bd634a68d2d0c3e06e5ce'
STAGES_PAGE = '610bd634a68d2d0c3e06e5f0'
POSES = {'steve': 'c01', 'mark': 'c02', 'max': 'c03',
         'beth': 'c04', 'hal': 'c05', 'magnus': 'c06'}


# These exact historical instructions were source-audited with their course-wide
# effects. Digests prevent partial substring matching of arbitrary extra clauses.
HISTORICAL_REQUESTS = {
    ('610bd633a68d2d0c3e06e5ac', '214683383253a11bc2e9a1a4d4f93b5a263df14ecd3f72b2c5c66f293df7650d'): {'pose_gallery': True},
    ('610bd633a68d2d0c3e06e5bc', '7c6d9d418964c4d6ee18a91812a5c730ca930339ab3cb81ba08214169928036f'): {'highlight_h1': True},
    ('610bd634a68d2d0c3e06e5ce', 'c07e9c77bd6c671256595b7e6a85bb804fb99a7688bd52322b9570aa6b8856db'): {'shared_exercises': True},
    ('610bd634a68d2d0c3e06e5f0', 'a241be9a8a3d9ed86cd2cdc493974545aa91980c494aa3670fc9aab6164b0be2'): {'stage_visuals': True},
}


def requested_design(instruction, page_id):
    instruction = instruction.strip()
    exact = HISTORICAL_REQUESTS.get((page_id, hashlib.sha256(instruction.encode()).hexdigest()))
    if exact:
        return exact.copy()
    # Entire input must parse: no ignored extra clause, command or markup.
    parts = re.split(r'\s*(?:;|\band\s+(?=(?:please\s+)?(?:make|show|use|put|set|flash|highlight|add)\b))\s*', instruction, flags=re.IGNORECASE)
    if not 1 <= len(parts) <= 3:
        return None
    changes = {}
    for part in parts:
        part = re.sub(r'^(?:(?:please|could you|can you|would you)\s+)', '', part.strip(), flags=re.IGNORECASE)
        part = re.sub(r'[.!?]+$', '', part).strip()
        board = re.fullmatch(r'(?:make|show|set)\s+(?:the\s+)?(?:chess\s*)?board\s+(?:a\s+(?:bit|little)\s+)?(smaller|larger|bigger)', part, re.IGNORECASE)
        person = re.fullmatch(r'(?:show|use|put)\s+(steve|mark|max|beth|hal|magnus)(?:\s+(?:as\s+the\s+)?(?:page\s+)?character)?(?:\s+(?:looking\s+)?(happy|thinking|puzzled))?', part, re.IGNORECASE)
        if board and page_id == BOARD_PAGE:
            key, value = 'board_size', 'small' if board[1].lower() == 'smaller' else 'large'
        elif person:
            key, value = 'character', POSES[person[1].lower()] + '-' + (person[2] or 'thinking').lower()
        elif page_id == INTRO_PAGE and re.fullmatch(r'(?:show|use|add)\s+(?:a\s+)?(?:range|variety|three|different)\s+(?:of\s+)?(?:different\s+)?poses\s+(?:for|of)\s+(?:each|all)\s+(?:the\s+)?characters?', part, re.IGNORECASE):
            key, value = 'pose_gallery', True
        elif page_id == BOARD_PAGE and re.fullmatch(r'(?:make|flash|highlight)\s+(?:the\s+)?(?:h1|bottom[- ]right(?:\s+hand)?\s+square)\s+(?:(?:flash|blink)\s+)?red\s+for\s+(?:10|ten)\s+seconds', part, re.IGNORECASE):
            key, value = 'highlight_h1', True
        elif page_id == STAGES_PAGE and re.fullmatch(r'(?:add|show|use)\s+(?:appropriate\s+)?(?:illustrations|visuals|diagrams)\s+for\s+(?:the\s+)?opening,?\s+(?:the\s+)?middlegame,?\s+and\s+(?:the\s+)?(?:endgame|ending)', part, re.IGNORECASE):
            key, value = 'stage_visuals', True
        elif page_id == CHECK_PAGE and re.fullmatch(r'(?:use|show)\s+(?:the\s+)?(?:studio|opening drill)\s+(?:chess\s+)?board\s+for\s+(?:the\s+)?exercises\s+with\s+(?:drag\s+and\s+click|click\s+and\s+drag)', part, re.IGNORECASE):
            key, value = 'shared_exercises', True
        else:
            return None
        if key in changes and changes[key] != value:
            return None
        changes[key] = value
    return changes or None


def current_design(page_id, saved):
    """Effective settings including the reviewed per-page default character."""
    path = Path(__file__).parent / 'review-assets' / 'beyond-basics' / 'review.js'
    source = path.read_text(encoding='utf-8')
    match = re.search(r'const LESSON_POSES=(\{[^\n]*?\});', source)
    if not match:
        raise ValueError('Approved character mapping unavailable')
    defaults = json.loads(match.group(1))
    return {'character': defaults.get(page_id, 'c01-thinking'), 'board_size': 'default', **saved}
