import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("build_hint_references", Path(__file__).parents[1] / "scripts/build_hint_references.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
run = module.run


def test_import_separates_hints_from_clean_style_and_deduplicates(tmp_path):
    snapshot = tmp_path / "snapshot.json"
    chapter = {"id": "chapter", "sourcePGN": "1. e4 {[%hint Find a central move.] Main} (1. d4 {[%hint Wrong]} d5) e5 2. Nf3 {[%hint Develop.]} *"}
    snapshot.write_text(json.dumps({"retrievedAt": "today", "courses": [{"course": {"id": "course"}, "draft": {"metadata": {"side": "white"}, "revision": 3, "revisionHash": "hash", "chapterSources": [chapter, {**chapter, "id": "other"}]}}]}))
    style = tmp_path / "style"
    style.mkdir()
    (style / "source.pgn").write_text("1. e4 {[%csl Re4] A long enough example of commentary.} e5 *")
    output = tmp_path / "private" / "references.json"
    run(snapshot, style, output)
    records = json.loads(output.read_text())
    hints = [r for r in records if r["kind"] == "handwritten_hint"]
    prose = [r for r in records if r["kind"] == "style_prose"]
    assert len(hints) == 2
    assert len(hints[0]["occurrences"]) == 2
    assert all(r["text"] != "Wrong" for r in hints)
    assert len(prose) == 1 and "[%csl" not in prose[0]["text"]
    assert output.stat().st_mode & 0o077 == 0
