"""Validate bounded text-only review proposals; this module has no I/O or authority."""
import re


class InvalidProposal(ValueError):
    """Proposal cannot be safely applied in the private review."""


def _protected_regions(source):
    """Return half-open Python string offsets for quoted/code spans.

    Saved editor bodies are plain Unicode text; no decoding or normalization is
    performed, so offsets are exactly those used by str.index and slicing. HTML,
    entities, and ambiguous angle brackets are not a supported automatic format.
    Malformed delimiters fail the entire field closed. Apostrophes between word
    characters are contractions, not delimiters. Backslash escapes the next glyph.
    """
    if any(char in source for char in '<>&'):
        return None
    pairs = {'"': '"', "'": "'", '“': '”', '‘': '’', '«': '»', '‹': '›',
             '„': '“', '‚': '‘', '「': '」', '『': '』', '《': '》', '〈': '〉',
             '〝': '〞', '❝': '❞', '❮': '❯', '`': '`', '~': '~'}
    closers = set(pairs.values())
    stack, regions = [], []
    i = 0
    while i < len(source):
        char = source[i]
        if char == '\\':
            # Escape syntax outside a protected region has ambiguous intent.
            if not stack or i + 1 >= len(source):
                return None
            i += 2
            continue
        if char in {"'", '’'} and i > 0 and i + 1 < len(source) and source[i - 1].isalnum() and source[i + 1].isalnum():
            i += 1
            continue
        if stack and char == stack[-1][1]:
            start, _ = stack.pop()
            if not stack:
                regions.append((start, i + 1))
        elif stack and stack[-1][1] in {'`', '~'}:
            pass  # Code content is opaque until its delimiter.
        elif char in pairs:
            stack.append((i, pairs[char]))
        elif char in closers:
            return None
        i += 1
    return None if stack else regions


def _ordinary_prose_context(source, position, end, old):
    """Apply lexical checks only outside protected plain-text regions."""
    regions = _protected_regions(source)
    if regions is None or any(position < stop and start < end for start, stop in regions):
        return False
    if old[0].isupper():
        return False
    left = source[:position]
    right = source[end:]
    # Sentence-initial words can be names; no surrounding sentence context is
    # also inherently ambiguous. Avoid instructional metalinguistic contexts.
    sentence_left = re.split(r'[.!?\n]', left)[-1]
    sentence_right = re.split(r'[.!?\n]', right)[0]
    sentence = sentence_left + old + sentence_right
    if not re.search(r'[A-Za-z]', sentence_left) or not re.search(r'[A-Za-z]', sentence_right):
        return False
    if re.search(r'\b(?:name[ds]?|called|player|author|surname|literal|token|spell(?:ing|ed)?|word|example|write|written|type|typed|quote[ds]?|replace|change|correct|incorrect|mistake|typo|error|notation|code|command)\b', sentence, re.IGNORECASE):
        return False
    # Very short function-word misspellings can also be names/identifiers.
    # Permit only recognizable chess/prose grammatical frames.
    before = re.findall(r"[A-Za-z]+", sentence_left.lower())
    after = re.findall(r"[A-Za-z]+", sentence_right.lower())
    if old == 'teh' and (not after or after[0] not in {
        'king', 'queen', 'rook', 'bishop', 'knight', 'pawn', 'piece', 'pieces',
        'board', 'square', 'squares', 'move', 'moves', 'game', 'position',
        'opening', 'variation', 'attack', 'defence', 'opponent', 'player',
        'white', 'black', 'centre', 'center', 'file', 'rank', 'idea', 'plan',
    }):
        return False
    return not (old == 'adn' and (not before or not after or
                before[-1] in {'named', 'called', 'player', 'coach', 'author'}))


def apply_proposal(components, proposal, instruction=None):
    """Return a copied overlay, or reject an entire proposal without partial work.

    Only exact text replacements inside a component title/body are supported.
    The caller must obtain components from trusted review source and commit the
    resulting overlay under the page revision's compare-and-swap transaction.
    """
    if not isinstance(proposal, dict) or set(proposal) != {"status", "message", "patches"}:
        raise InvalidProposal("Invalid proposal shape")
    status, message, patches = proposal["status"], proposal["message"], proposal["patches"]
    if status not in {"completed", "needs-clarification", "failed"} or not isinstance(message, str) or len(message) > 1000:
        raise InvalidProposal("Invalid result")
    if not isinstance(patches, list) or len(patches) > 20:
        raise InvalidProposal("Invalid patches")
    if status != "completed":
        if patches:
            raise InvalidProposal("Non-completed result contains patches")
        return []
    if not patches:
        raise InvalidProposal("Completed result contains no patches")
    replacement = re.fullmatch(r"\s*(?:please\s+)?(?:replace|change)\s+([\"'])(.*?)\1\s+(?:with|to)\s+([\"'])(.*?)\3[.!]?\s*", instruction or "", re.IGNORECASE)
    proofreading = re.fullmatch(r"\s*(?:please\s+)?(?:fix|correct|check|proofread)\s+(?:(?:the|any|all|this|page|text|its|and|spelling|grammar|punctuation|typos?|errors?|mistakes?|on|of)\s*)+[.!]?\s*", instruction or "", re.IGNORECASE)
    if instruction is not None and not replacement and not proofreading:
        raise InvalidProposal("Unsupported instruction")
    if replacement and (len(patches) != 1 or not isinstance(patches[0], dict) or (patches[0].get('old'), patches[0].get('new')) != (replacement.group(2), replacement.group(4))):
        raise InvalidProposal("Patch exceeds instruction")
    # Each rule is a conservative literal correction, not a semantic model verdict.
    # Context checks below limit auto-application; ambiguous cases remain manual.
    safe_typos = {
        ('teh', 'the'), ('Teh', 'The'), ('adn', 'and'), ('Adn', 'And'),
        ('recieve', 'receive'), ('recieved', 'received'), ('seperate', 'separate'),
        ('definately', 'definitely'), ('occured', 'occurred'), ('becuase', 'because'),
        ('thier', 'their'), ('wierd', 'weird'), ('beleive', 'believe'),
        ('acheive', 'achieve'), ('untill', 'until'), ('begining', 'beginning'),
        ('comming', 'coming'), ('wich', 'which'), ('woudl', 'would'),
        ('the pieces is', 'the pieces are'), ('the squares is', 'the squares are'),
        ('the moves is', 'the moves are'), ('the players is', 'the players are'),
        ('there is many', 'there are many'), ('you was', 'you were'),
        (' ,', ','), (' .', '.'), (' !', '!'), (' ?', '?'),
    }
    if proofreading and (len(patches) > 12 or sum(len(p.get('old', '')) + len(p.get('new', ''))
            for p in patches if isinstance(p, dict) and isinstance(p.get('old'), str) and isinstance(p.get('new'), str)) > 240):
        raise InvalidProposal("Proofreading edit budget exceeded")
    result, spans = [], {}
    for patch in patches:
        if not isinstance(patch, dict) or set(patch) != {"component", "field", "old", "new"}:
            raise InvalidProposal("Invalid patch shape")
        index, field, old, new = (patch[k] for k in ("component", "field", "old", "new"))
        if type(index) is not int or index < 0 or index >= len(components) or field not in {"title", "body"}:
            raise InvalidProposal("Invalid target")
        if not isinstance(old, str) or not isinstance(new, str) or not old or old == new or len(old) > 10000 or len(new) > 10000:
            raise InvalidProposal("Invalid text")
        if proofreading and (old, new) not in safe_typos:
            raise InvalidProposal("Proofreading change requires clarification")
        # Exact literal text, never markup, entities, paths or link creation.
        if any(c in old + new for c in "<>&") or re.search(r"(?:https?://|www\.|javascript:)", new, re.IGNORECASE):
            raise InvalidProposal("Only plain text is supported")
        source = components[index].get(field)
        if not isinstance(source, str) or source.count(old) != 1:
            raise InvalidProposal("Target text missing or ambiguous")
        position = source.index(old)
        if source.rfind("<", 0, position) > source.rfind(">", 0, position):
            raise InvalidProposal("Target is not text content")
        end = position + len(old)
        if proofreading and not _ordinary_prose_context(source, position, end, old):
            raise InvalidProposal("Proofreading context requires clarification")
        if proofreading and ((old[0].isalnum() and position and (source[position - 1].isalnum() or source[position - 1] == '_')) or
                            (old[-1].isalnum() and end < len(source) and (source[end].isalnum() or source[end] == '_'))):
            raise InvalidProposal("Proofreading target is not a whole word")
        key = (index, field)
        for start, stop, _ in spans.get(key, []):
            if position < stop and start < end:
                raise InvalidProposal("Overlapping targets")
        spans.setdefault(key, []).append((position, end, new))
    for (index, field), edits in spans.items():
        updated = components[index][field]
        for start, end, new in sorted(edits, reverse=True):
            updated = updated[:start] + new + updated[end:]
        result.append({"component": index, "field": field, "value": updated})
    return result
