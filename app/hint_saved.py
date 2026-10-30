"""Extract current saved hint occurrences; this alone does not establish eligibility.

Provenance and approval must be established separately before any extracted text
is used as a reference. Never call this on an unverified browser draft.
"""
import hashlib
import re
from io import StringIO

import chess.pgn

HINT = re.compile(r"\[%hint\s+([^\[\]]+)\]", re.IGNORECASE)


def saved_hint_occurrences(draft):
    """Return bounded learner-mainline hint occurrences keyed by chapter/path.

    Raise on invalid PGN or excessive input, so partial parsing never certifies a
    deleted or superseded hint as current. Exclude archived chapters and their
    scaffolding, and don't traverse wrong-answer subtrees.
    """
    if draft.get("metadata", {}).get("side") not in {"white", "black"}:
        raise ValueError("Invalid course side")
    side = draft["metadata"]["side"] == "white"
    sources = draft.get("chapterSources")
    if sources is None:
        sources = [{"id": None, "sourcePGN": draft.get("sourcePGN", "")}]
    if not isinstance(sources, list) or len(sources) > 1000:
        raise ValueError("Invalid chapter sources")
    results, size = [], 0
    for chapter in sources:
        if not isinstance(chapter, dict):
            raise TypeError("Invalid chapter")
        if chapter.get("archived"):
            continue
        pgn = chapter.get("sourcePGN")
        if not isinstance(pgn, str):
            raise TypeError("Invalid PGN")
        size += len(pgn.encode("utf-8"))
        if size > 2_000_000:
            raise ValueError("Draft too large")
        start = chapter.get("trainingStartPath") or []
        exclusions = set(chapter.get("scaffoldExclusionKeys") or [])
        stream = StringIO(pgn)
        while game := chess.pgn.read_game(stream):
            if game.errors or game.headers.get("FEN") or game.headers.get("SetUp") == "1":
                raise ValueError("Invalid saved PGN")
            pending = [(game, ())]
            while pending:
                node, path = pending.pop()
                board = node.board()
                for index, child in enumerate(node.variations):
                    next_path = (*path, child.move.uci())
                    if len(next_path) > 500:
                        raise ValueError("Move path too long")
                    if board.turn == side and index > 0:
                        continue
                    if board.turn == side and path[:len(start)] == tuple(start):
                        matches = HINT.findall(child.comment)
                        if len(matches) > 1:
                            raise ValueError("Multiple hints on move")
                        if matches:
                            text = " ".join(matches[0].split())
                            fen = " ".join(board.fen().split()[:4])
                            key = "sha256:" + hashlib.sha256(f"{fen}\n{child.move.uci()}".encode()).hexdigest()
                            if key not in exclusions and text:
                                if len(text.encode("utf-16-le")) // 2 > 600:
                                    raise ValueError("Hint too long")
                                results.append({"chapterID": chapter.get("id"), "moves": list(path),
                                                "answer": child.move.uci(), "positionKey": key,
                                                "san": board.san(child.move),
                                                "piece": board.piece_at(child.move.from_square).symbol().lower(),
                                                "text": text})
                                if len(results) > 10000:
                                    raise ValueError("Too many hints")
                    pending.append((child, next_path))
    return results
