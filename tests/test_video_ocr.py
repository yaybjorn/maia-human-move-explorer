"""Offline contracts and frozen evaluation regressions; no model/network required."""
import copy
import gzip
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.video_ocr import runtime
from app.video_ocr.postprocess import CLASS_NAMES, process_detections


@pytest.fixture
def frozen():
    path = Path(runtime.__file__).parent / "fixtures" / "frozen-observations.jsonl.gz"
    with gzip.open(path, "rt") as stream:
        return {int(row["timestamp_seconds"]): row for row in map(json.loads, stream)}


def test_frozen_upstream_postprocessor_normal_flipped_moved_absent_multiple(frozen):
    # Reuse exact frozen boxes, not a re-run/tuning of the independent benchmark.
    for row in frozen.values():
        boards, _ = process_detections(row["boxes"], CLASS_NAMES)
        assert [board.fen for board in boards] == [board["fen"] for board in row["boards"]]
        assert [board.orientation for board in boards] == [board["orientation"] for board in row["boards"]]
    assert len(frozen[607]["boards"]) == 0
    assert len(frozen[3952]["boards"]) == len(frozen[6020]["boards"]) == 2
    assert frozen[6020]["boards"][0]["orientation"] == "flipped"


def test_frozen_uncertainty_is_preserved_without_claiming_drag_detection(frozen):
    for seconds in (607, 608, 621, 3952, 6020):
        assert runtime.review_flags(frozen[seconds]["boards"])[0] == ["not_exactly_one_board"]
    for seconds in (3262, 3263):
        assert "orientation_unknown" in runtime.review_flags(frozen[seconds]["boards"])[0]
    assert "nonstandard_king_count" in runtime.review_flags(frozen[1202]["boards"])[0]
    # Dragged pawn sample remains an observation; heuristic success is not certified accuracy.
    accumulator = runtime.ReviewAccumulator()
    row = copy.deepcopy(frozen[120])
    accumulator.add(row)
    assert row["boards"] == frozen[120]["boards"]
    assert len(row["raw_model_output"]) == 300


def test_consecutive_only_dedup_gaps_revisits_and_lossy_screening(tmp_path, frozen):
    board = copy.deepcopy(frozen[0]["boards"][0])
    board.update(orientation="normal", orientation_conf=0.99, board_conf=0.99,
                 piece_confs={"e1": 0.99, "e8": 0.99})
    accumulator = runtime.ReviewAccumulator()
    for seconds, boards in [(0, [board]), (1, [board]), (2, []), (3, [board]),
                            (4, [board]), (6, [board]), (7, [board, board]), (8, [board])]:
        accumulator.add({"timestamp_seconds": seconds, "boards": boards})
    summary = accumulator.finish(tmp_path)
    assert [segment["first_seen_seconds"] for segment in accumulator.segments] == [0, 3, 6, 8]
    assert summary["screened_draft_segments"] == 2
    assert (tmp_path / "positions-screened-draft.csv").read_text().splitlines() == [
        "timestamp_seconds;fen", f'0;{board["fen"]}', f'3;{board["fen"]}']
    assert all(" " not in line.split(";")[1]
               for line in (tmp_path / "positions-changes.csv").read_text().splitlines()[1:])


def test_any_flagged_observation_excludes_whole_run(tmp_path, frozen):
    board = copy.deepcopy(frozen[0]["boards"][0])
    board.update(orientation_conf=0.99, board_conf=0.99,
                 piece_confs={"e1": 0.99, "e8": 0.99})
    accumulator = runtime.ReviewAccumulator()
    accumulator.add({"timestamp_seconds": 0, "boards": [board]})
    uncertain = {**board, "orientation": "unknown"}
    accumulator.add({"timestamp_seconds": 1, "boards": [uncertain]})
    accumulator.add({"timestamp_seconds": 2, "boards": [board]})
    assert accumulator.finish(tmp_path)["screened_draft_segments"] == 0
    assert accumulator.segments[0]["observations"] == 3


def probe_payload(duration="2", fps="30/1", width=1280, height=720, codec="h264"):
    return {"streams": [{"duration": duration, "avg_frame_rate": fps,
                         "width": width, "height": height, "codec_name": codec}],
            "format": {"duration": duration, "format_name": "mov,mp4"}}


@pytest.mark.parametrize(("payload", "code"), [
    (probe_payload(duration="10801"), "duration_limit"),
    (probe_payload(duration="nan"), "duration_limit"),
    (probe_payload(fps="0/0"), "invalid_video"),
    (probe_payload(fps="120/1"), "unsupported_video"),
    (probe_payload(width=4000, height=4000), "unsupported_video"),
    (probe_payload(codec="not-a-codec"), "unsupported_video"),
    ({"streams": []}, "invalid_video"),
])
def test_probe_fail_closed(tmp_path, monkeypatch, payload, code):
    source = tmp_path / "sample.mp4"
    source.write_bytes(b"fixture")
    monkeypatch.setattr(runtime.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=json.dumps(payload)))
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.probe_video(source)
    assert exc.value.code == code


def test_probe_rejects_playlist_even_with_supported_codec(tmp_path, monkeypatch):
    source = tmp_path / "sample.m3u8"
    source.write_bytes(b"fixture")
    payload = probe_payload()
    payload["format"]["format_name"] = "hls"
    monkeypatch.setattr(runtime.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=json.dumps(payload)))
    with pytest.raises(runtime.VideoOCRError, match="MP4"):
        runtime.probe_video(source)


def mock_extraction(monkeypatch, tmp_path, frozen, timestamps):
    source, model = tmp_path / "source.mp4", tmp_path / "model.onnx"
    source.write_bytes(b"test source")
    model.write_bytes(b"test model")
    metadata = {"duration_seconds": 2.1, "fps": 30, "width": 1280, "height": 720}
    monkeypatch.setattr(runtime, "probe_video", lambda source: metadata)
    monkeypatch.setattr(runtime, "sha256_file", lambda *args: runtime.MODEL_SHA256)
    monkeypatch.setattr(runtime.importlib.metadata, "version", lambda name: "test-fixture")
    monkeypatch.setattr(runtime.shutil, "disk_usage", lambda path: SimpleNamespace(free=2 * 1024**3))

    class Capture:
        index = -1
        released = False

        def isOpened(self):
            return True

        def grab(self):
            self.index += 1
            return self.index < len(timestamps)

        def get(self, key):
            return timestamps[self.index]

        def retrieve(self):
            return True, SimpleNamespace(shape=(720, 1280, 3))

        def release(self):
            self.released = True

    capture = Capture()
    cv2 = SimpleNamespace(VideoCapture=lambda *args: capture,
                          CAP_FFMPEG=1, CAP_PROP_N_THREADS=1, CAP_PROP_POS_MSEC=1)
    engine = SimpleNamespace(cv2=cv2, predict=lambda image: copy.deepcopy(frozen[0]))
    monkeypatch.setattr(runtime, "Engine", lambda path: engine)
    return source, model, capture


def test_actual_pts_sampling_not_frame_rate_arithmetic(tmp_path, monkeypatch, frozen):
    source, model, capture = mock_extraction(monkeypatch, tmp_path, frozen,
                                            [50, 85, 1051, 1080, 2053])
    updates = []
    output = tmp_path / "result"
    summary = runtime.run_video(source, output, model, updates.append)
    rows = list(map(json.loads, (output / "observations.jsonl").read_text().splitlines()))
    assert [row["timestamp_seconds"] for row in rows] == [0, 1.001, 2.003]
    assert [row["source_frame_index"] for row in rows] == [0, 2, 4]
    assert [row["opencv_pts_ms"] for row in rows] == [50, 1051, 2053]
    assert rows[0]["first_frame_pts_ms"] == 50
    assert summary["frames"] == 3
    assert updates[-1]["progress"] == 1
    assert capture.released
    with gzip.open(output / "raw.jsonl.gz", "rt") as stream:
        assert len(json.loads(next(stream))["raw_model_output"]) == 300


def test_timestamp_stall_fails_with_partial_manifest(tmp_path, monkeypatch, frozen):
    source, model, capture = mock_extraction(monkeypatch, tmp_path, frozen, [0, 0, 1000])
    output = tmp_path / "result"
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.run_video(source, output, model)
    assert exc.value.code == "invalid_timestamps"
    assert json.loads((output / "manifest.json").read_text())["status"] == "failed"
    assert not (output / "positions-screened-draft.csv").exists()
    assert capture.released


def test_cancelled_extraction_never_claims_complete(tmp_path, monkeypatch, frozen):
    source, model, capture = mock_extraction(monkeypatch, tmp_path, frozen, [0, 1000, 2000])
    state = {"cancelled": False}

    def progress(row):
        if row["phase"] == "extracting":
            state["cancelled"] = True

    output = tmp_path / "result"
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.run_video(source, output, model, progress, lambda: state["cancelled"])
    assert exc.value.code == "cancelled"
    assert json.loads((output / "manifest.json").read_text())["status"] == "cancelled"
    assert capture.released


def test_early_eof_is_failure(tmp_path, monkeypatch, frozen):
    source, model, _ = mock_extraction(monkeypatch, tmp_path, frozen, [0, 35])
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.run_video(source, tmp_path / "result", model)
    assert exc.value.code == "decode_failed"


def test_model_hash_mismatch_before_inference(tmp_path, monkeypatch, frozen):
    source, model, capture = mock_extraction(monkeypatch, tmp_path, frozen, [0, 1000, 2000])
    monkeypatch.setattr(runtime, "sha256_file", lambda *args: "wrong hash")
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.run_video(source, tmp_path / "result", model)
    assert exc.value.code == "invalid_model"
    assert capture.index == -1
