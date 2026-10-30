"""Build a private corpus from an authorized read-only Studio export and private PGNs."""
import argparse
import hashlib
import json
import re
from io import StringIO
from pathlib import Path

import chess.pgn

HINT = re.compile(r"\[%hint\s+([^\[\]]+)\]", re.IGNORECASE)
DIRECTIVE = re.compile(r"\[%[^\]]*\]")


def read_games(text):
    stream = StringIO(text)
    while game := chess.pgn.read_game(stream):
        if game.errors:
            raise ValueError("Reference PGN contains parsing errors")
        yield game


def position_key(board, move):
    fen = " ".join(board.fen().split()[:4])
    return "sha256:" + hashlib.sha256(f"{fen}\n{move.uci()}".encode()).hexdigest()


def run(source, style_dir, output):
    snapshot = json.loads(source.read_text(encoding="utf-8"))
    records = {}
    for entry in snapshot["courses"]:
        course, draft = entry["course"], entry["draft"]
        side = draft["metadata"]["side"] == "white"
        chapters = draft.get("chapterSources") or [{"id": None, "sourcePGN": draft["sourcePGN"]}]
        for chapter in chapters:
            if chapter.get("archived"):
                continue
            exclusions = set(chapter.get("scaffoldExclusionKeys") or [])
            for game in read_games(chapter["sourcePGN"]):
                def visit(node, path=(), side=side, exclusions=exclusions, course=course, chapter=chapter, draft=draft):
                    board = node.board()
                    for index, child in enumerate(node.variations):
                        match = HINT.search(child.comment)
                        if (board.turn == side and index == 0 and match and position_key(board, child.move) not in exclusions
                                and tuple(path[:len(chapter.get("trainingStartPath") or [])]) == tuple(chapter.get("trainingStartPath") or [])):
                            text = " ".join(match.group(1).split())
                            key = (position_key(board, child.move), text)
                            provenance = {"courseID": course["id"], "chapterID": chapter.get("id"),
                                          "revision": draft["revision"], "revisionHash": draft["revisionHash"],
                                          "positionKey": key[0], "retrievedAt": snapshot.get("retrievedAt")}
                            record = records.setdefault(key, {"kind": "handwritten_hint", "text": text,
                                                               "san": board.san(child.move), "piece": board.piece_at(child.move.from_square).symbol().lower(),
                                                               "source": json.dumps(provenance, sort_keys=True), "occurrences": []})
                            record["occurrences"].append(provenance)
                        if board.turn != side or index == 0:
                            visit(child, (*path, child.move.uci()))
                visit(game)
    styles = []
    for file in sorted(style_dir.glob("*.pgn")):
        for game in read_games(file.read_text(encoding="utf-8-sig")):
            def visit(node, file=file):
                for child in node.variations:
                    text = " ".join(DIRECTIVE.sub("", child.comment).split())
                    if len(text) >= 30:
                        styles.append({"kind": "style_prose", "text": text[:600], "source": file.name})
                    visit(child)
            visit(game)
    result = [*records.values(), *styles]
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    output.chmod(0o600)
    print(f"Private corpus: {len(records)} unique authentic hints, {len(styles)} style comments")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("style_dir", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    run(args.snapshot, args.style_dir, args.output)
