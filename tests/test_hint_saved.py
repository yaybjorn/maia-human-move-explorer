import pytest

from app.hint_saved import saved_hint_occurrences


def test_extracts_only_saved_learner_mainline_and_active_chapters():
    draft = {"metadata": {"side": "white"}, "chapterSources": [
        {"id": "one", "sourcePGN": "1. e4 {[%hint Main hint]} (1. d4 {[%hint Wrong]}) e5 2. Nf3 {[%hint Next hint]} *"},
        {"id": "hidden", "archived": True, "sourcePGN": "1. e4 {[%hint Hidden]} *"},
    ]}
    result = saved_hint_occurrences(draft)
    assert {(r["text"], tuple(r["moves"]), r["answer"]) for r in result} == {
        ("Main hint", (), "e2e4"), ("Next hint", ("e2e4", "e7e5"), "g1f3")}
    key = result[0]["positionKey"]
    draft["chapterSources"][0]["scaffoldExclusionKeys"] = [key]
    assert key not in {r["positionKey"] for r in saved_hint_occurrences(draft)}


def test_training_boundary_and_malformed_pgn_fail_closed():
    draft = {"metadata": {"side": "white"}, "chapterSources": [{"id": "c", "trainingStartPath": ["e2e4", "e7e5"], "sourcePGN": "1. e4 {[%hint Before]} e5 2. Nf3 {[%hint After]} *"}]}
    assert [r["text"] for r in saved_hint_occurrences(draft)] == ["After"]
    draft["chapterSources"][0]["sourcePGN"] = "1. e4 e5 2. Ke8 *"
    with pytest.raises(ValueError):
        saved_hint_occurrences(draft)
