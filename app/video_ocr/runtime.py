"""Pinned CPU recognizer and timestamp-based, sequential 1 Hz extraction.

Run in a dedicated process, never an interactive HTTP handler. Files are local,
caller-owned paths; no URL fetching, course modification or publication occurs.
"""
from __future__ import annotations

import gzip
import hashlib
import importlib.metadata
import json
import math
import shutil
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

from .postprocess import CLASS_NAMES, process_detections

EXTRACTION_VERSION = "2d-chess-ocr-94d6a81-cpu-1hz-v1"
SOURCE_REVISION = "94d6a8157524825fcfda4f27c430577eec04b356"
MODEL_REVISION = "03d9df9fc14fade1a3579683fd0de215b3864ee1"
MODEL_SHA256 = "a8e78afa8e00cd7ee39a941f888327bd85a12c3cf5c2140a4fa882ea3f7abff7"
MAX_DURATION_SECONDS = 3 * 60 * 60
MAX_SOURCE_BYTES = 2 * 1024**3
MAX_OUTPUT_BYTES = 512 * 1024**2
MIN_FREE_BYTES = 768 * 1024**2
MAX_WALL_SECONDS = 6 * 60 * 60
MAX_DECODED_FRAMES = MAX_DURATION_SECONDS * 60 + 120
NOTE = (
    "1 Hz sampled observations, not exact first appearances. Short-lived positions may be missed. "
    "Screening is lossy and heuristic, not certified correctness. Unknown orientation assumes "
    "normal in the recognizer and stays flagged. Empty squares have no calibrated confidence. "
    "Only piece placement is exported; turn, castling, en passant and counters are not inferred."
)
ARTIFACTS = [
    "raw.jsonl.gz", "observations.jsonl", "positions.csv", "positions-changes.csv",
    "positions-screened-draft.csv", "segments.json", "review-flags.json", "manifest.json",
]


class VideoOCRError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _check_cancel(cancelled):
    if cancelled and cancelled():
        raise VideoOCRError("cancelled", "Extraction was cancelled.")


def sha256_file(path, cancelled=None):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            _check_cancel(cancelled)
            digest.update(chunk)
    return digest.hexdigest()


def probe_video(source_path):
    """Fail closed before model allocation for unsupported/unbounded sources."""
    source = Path(source_path)
    if not source.is_file() or source.is_symlink():
        raise VideoOCRError("invalid_source", "A local regular video file is required.")
    if not 0 < source.stat().st_size <= MAX_SOURCE_BYTES:
        raise VideoOCRError("source_too_large", "Video must be nonempty and at most 2 GiB.")
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
             "-show_entries", ("stream=codec_name,width,height,avg_frame_rate,duration,"
                               "start_time:format=duration,format_name"),
             "-of", "json", str(source.resolve())],
            capture_output=True, timeout=30, check=True,
        )
        metadata = json.loads(result.stdout)
        stream = metadata["streams"][0]
        duration = float(stream.get("duration") or metadata["format"]["duration"])
        numerator, denominator = stream["avg_frame_rate"].split("/")
        fps = float(numerator) / float(denominator)
        width, height = int(stream["width"]), int(stream["height"])
    except FileNotFoundError as exc:
        raise VideoOCRError("runtime_unavailable", "Video probe is not installed.") from exc
    except (subprocess.SubprocessError, ValueError, KeyError, IndexError, ZeroDivisionError) as exc:
        raise VideoOCRError("invalid_video", "Video metadata could not be decoded.") from exc
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise VideoOCRError("duration_limit", "Video duration must be known and at most 3 hours.")
    if not math.isfinite(fps) or not 0 < fps <= 60.01:
        raise VideoOCRError("unsupported_video", "Video must have a known frame rate up to 60 fps.")
    if not (0 < width <= 1920 and 0 < height <= 1920 and width * height <= 1920 * 1080):
        raise VideoOCRError("unsupported_video", "Video resolution must not exceed 1080p.")
    if stream.get("codec_name") not in {"h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mjpeg"}:
        raise VideoOCRError("unsupported_video", "Video codec is not supported.")
    # Restrict to self-contained containers, not playlists or network references.
    formats = set(metadata.get("format", {}).get("format_name", "").split(","))
    if not formats.intersection({"mov", "mp4", "matroska", "webm", "avi"}):
        raise VideoOCRError("unsupported_video", "Use an MP4, MOV, WebM, MKV or AVI video.")
    return {"duration_seconds": duration, "fps": fps, "width": width, "height": height,
            "codec": stream["codec_name"], "stream_start_time": stream.get("start_time"),
            "size_bytes": source.stat().st_size}


class Engine:
    """Evaluated fixed letterbox + ONNX adapter; one CPU inference thread."""

    def __init__(self, model_path):
        try:
            import cv2
            import numpy as np
            import onnxruntime as ort
        except ImportError as exc:
            raise VideoOCRError("runtime_unavailable", "OCR dependencies are not installed.") from exc
        self.cv2, self.np = cv2, np
        cv2.setNumThreads(1)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        opts.add_session_config_entry("session.inter_op.allow_spinning", "0")
        self.session = ort.InferenceSession(str(model_path), sess_options=opts,
                                            providers=["CPUExecutionProvider"])
        self.name = self.session.get_inputs()[0].name
        if (self.session.get_inputs()[0].shape != [1, 3, 640, 640]
                or self.session.get_outputs()[0].shape != [1, 300, 6]):
            raise VideoOCRError("invalid_model", "Pinned model tensor contract does not match.")

    def predict(self, bgr):
        cv2, np = self.cv2, self.np
        started = time.monotonic()
        height, width = bgr.shape[:2]
        ratio = min(640 / height, 640 / width)
        resized = (round(width * ratio), round(height * ratio))
        dw, dh = (640 - resized[0]) / 2, (640 - resized[1]) / 2
        image = cv2.resize(bgr, resized, interpolation=cv2.INTER_LINEAR)
        left, right = round(dw - 0.1), round(dw + 0.1)
        top, bottom = round(dh - 0.1), round(dh + 0.1)
        image = cv2.copyMakeBorder(image, top, bottom, left, right,
                                  cv2.BORDER_CONSTANT, value=(114, 114, 114))
        inputs = np.ascontiguousarray(image[:, :, ::-1].transpose(2, 0, 1)[None],
                                     dtype=np.float32) / 255.0
        raw = self.session.run(None, {self.name: inputs})[0][0]
        if not np.isfinite(raw).all():
            raise VideoOCRError("invalid_prediction", "Recognizer returned nonfinite detections.")
        boxes = []
        for detection in raw:
            if float(detection[4]) < 0.25:
                continue
            xyxy = detection[:4].astype(float)
            xyxy[[0, 2]] = np.clip((xyxy[[0, 2]] - left) / ratio, 0, width)
            xyxy[[1, 3]] = np.clip((xyxy[[1, 3]] - top) / ratio, 0, height)
            class_id = int(detection[5])
            if class_id not in CLASS_NAMES or xyxy[2] <= xyxy[0] or xyxy[3] <= xyxy[1]:
                raise VideoOCRError("invalid_prediction", "Recognizer returned invalid geometry.")
            boxes.append({"class_id": class_id, "conf": float(detection[4]), "xyxy": xyxy.tolist()})
        boards, unmatched = process_detections(boxes, CLASS_NAMES)
        return {"boards": [asdict(board) for board in boards], "boxes": boxes,
                "raw_model_output": raw.tolist(), "unmatched_pieces": unmatched,
                "timing": {"total_s": time.monotonic() - started}}


def review_flags(boards):
    """Unchanged frozen screening thresholds. These are not accuracy measurements."""
    if len(boards) != 1:
        return ["not_exactly_one_board"], {}
    board = boards[0]
    reasons = []
    if board["orientation"] == "unknown":
        reasons.append("orientation_unknown")
    if board["orientation_conf"] < 0.5:
        reasons.append("orientation_conf_below_0.5")
    if board["board_conf"] < 0.9:
        reasons.append("board_conf_below_0.9")
    low = {square: conf for square, conf in board["piece_confs"].items() if conf < 0.8}
    if low:
        reasons.append("piece_conf_below_0.8")
    if board["fen"].count("k") != 1 or board["fen"].count("K") != 1:
        reasons.append("nonstandard_king_count")
    return reasons, low


class ReviewAccumulator:
    """Bounded aggregate of runs/flags, never full model arrays or decoded frames."""

    def __init__(self):
        self.segments, self.flagged = [], []
        self.last = None
        self.counts = {"frames": 0, "boards": 0, "no_board_frames": 0, "multi_board_frames": 0}

    def add(self, row):
        boards = row["boards"]
        seconds = row["timestamp_seconds"]
        # sample index is the requested 1 Hz time bucket, independent of variable-frame-rate PTS.
        sample_index = row.get("sample_index", int(seconds))
        reasons, low = review_flags(boards)
        row["review_flags"] = reasons
        row["flags"] = reasons
        row["low_confidence_squares"] = low
        row["observation_kind"] = "absent" if not boards else "multiple" if len(boards) > 1 else "single"
        self.counts["frames"] += 1
        self.counts["boards"] += len(boards)
        self.counts["no_board_frames"] += not boards
        self.counts["multi_board_frames"] += len(boards) > 1
        if reasons:
            self.flagged.append({"timestamp_seconds": seconds, "sample_index": sample_index,
                                 "reasons": reasons, "boards": len(boards),
                                 "low_confidence_squares": low})
        if len(boards) != 1:
            self.last = None
            return
        fen = boards[0]["fen"]
        if (self.last is not None and self.last["fen"] == fen
                and sample_index == self.last["last_sample_index"] + 1):
            self.last["last_seen_seconds"] = seconds
            self.last["last_sample_index"] = sample_index
            self.last["observations"] += 1
            self.last["flagged_observations"] += bool(reasons)
            self.last["screened"] = self.last["flagged_observations"] == 0
            self.last["flags"] = sorted(set(self.last["flags"]) | set(reasons))
            if self.last["orientation"] != boards[0]["orientation"]:
                self.last["orientation"] = "unknown"
        else:
            self.last = {"id": f"segment-{len(self.segments)}", "first_seen_seconds": seconds,
                         "last_seen_seconds": seconds, "last_sample_index": sample_index,
                         "fen": fen, "observations": 1, "flagged_observations": int(bool(reasons)),
                         "screened": False, "flags": reasons,
                         "orientation": boards[0]["orientation"]}
            self.segments.append(self.last)

    def finish(self, output_dir):
        directory = Path(output_dir)
        for name, segments in (("positions-changes.csv", self.segments),
                               ("positions-screened-draft.csv",
                                [segment for segment in self.segments if segment["screened"]])):
            with (directory / name).open("w") as stream:
                stream.write("timestamp_seconds;fen\n")
                for segment in segments:
                    stream.write(f'{segment["first_seen_seconds"]:g};{segment["fen"]}\n')
        (directory / "segments.json").write_text(json.dumps(self.segments, separators=(",", ":")))
        (directory / "review-flags.json").write_text(json.dumps(self.flagged, separators=(",", ":")))
        return {**self.counts, "fen_segments": len(self.segments), "flagged_frames": len(self.flagged),
                "screened_draft_segments": sum(segment["screened"] for segment in self.segments)}


def _write_manifest(directory, manifest):
    temporary = directory / ".manifest.tmp"
    temporary.write_text(json.dumps(manifest, indent=2, allow_nan=False))
    temporary.replace(directory / "manifest.json")


def run_video(source_path, output_dir, model_path, progress=None, cancelled=None):
    """Extract a local <=3 hour video and return its manifest.

    progress receives dicts (phase, progress 0..1, frames_processed,
    timestamp_seconds, duration_seconds, wall_seconds). cancelled returns bool.
    Only a completed manifest means exports are complete. Failure leaves partial
    raw observations for diagnosis, marked failed/cancelled, never usable as success.
    """
    source, directory, model = Path(source_path), Path(output_dir), Path(model_path)
    _check_cancel(cancelled)
    metadata = probe_video(source)
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise VideoOCRError("output_exists", "Extraction output directory must be empty.")
    if shutil.disk_usage(directory).free < MIN_FREE_BYTES:
        raise VideoOCRError("storage_limit", "Insufficient free storage for extraction.")
    started = time.monotonic()
    manifest = {"status": "running", "extraction_version": EXTRACTION_VERSION,
                "upstream_revision": SOURCE_REVISION, "model_revision": MODEL_REVISION,
                "model_sha256": MODEL_SHA256, "model_license_metadata": "AGPL-3.0",
                "source": metadata, "sampling_interval_seconds": 1, "note": NOTE,
                "artifacts": ARTIFACTS, "inference_threads": 1, "decode_threads": 1}
    capture = None
    try:
        if progress:
            progress({"phase": "initializing", "progress": 0, "frames_processed": 0,
                      "duration_seconds": metadata["duration_seconds"], "wall_seconds": 0})
        if not model.is_file() or sha256_file(model, cancelled) != MODEL_SHA256:
            raise VideoOCRError("invalid_model", "OCR model is missing or fails its pinned SHA-256.")
        manifest["source_sha256"] = sha256_file(source, cancelled)
        _write_manifest(directory, manifest)
        engine = Engine(model)
        manifest["dependency_versions"] = {
            name: importlib.metadata.version(name)
            for name in ("numpy", "onnxruntime", "opencv-python-headless")
        }
        manifest["extractor_sha256"] = hashlib.sha256(
            Path(__file__).read_bytes() + (Path(__file__).parent / "postprocess.py").read_bytes()
        ).hexdigest()
        cv2 = engine.cv2
        capture = cv2.VideoCapture(str(source.resolve()), cv2.CAP_FFMPEG,
                                   [cv2.CAP_PROP_N_THREADS, 1])
        if not capture.isOpened():
            raise VideoOCRError("invalid_video", "Video could not be opened by the decoder.")
        accumulator = ReviewAccumulator()
        frame_index, next_sample, previous_pts, first_pts = 0, 0, None, None
        written = 0
        with gzip.open(directory / "raw.jsonl.gz", "wt", compresslevel=3) as raw_stream, \
                (directory / "observations.jsonl").open("w") as review_stream, \
                (directory / "positions.csv").open("w") as csv_stream:
            csv_stream.write("timestamp_seconds;fen\n")
            while capture.grab():
                _check_cancel(cancelled)
                if frame_index > MAX_DECODED_FRAMES or time.monotonic() - started > MAX_WALL_SECONDS:
                    raise VideoOCRError("runtime_limit", "Extraction exceeded its bounded runtime.")
                pts_ms = capture.get(cv2.CAP_PROP_POS_MSEC)
                if not math.isfinite(pts_ms) or pts_ms < 0:
                    raise VideoOCRError("invalid_timestamps", "Video has unsupported frame timestamps.")
                if previous_pts is not None and pts_ms <= previous_pts:
                    raise VideoOCRError("invalid_timestamps", "Frame timestamps are not increasing.")
                if first_pts is None:
                    first_pts = pts_ms
                seconds = (pts_ms - first_pts) / 1000
                previous_pts = pts_ms
                if seconds > MAX_DURATION_SECONDS or seconds > metadata["duration_seconds"] + 1:
                    raise VideoOCRError("duration_limit", "Decoded video exceeds declared duration.")
                if seconds + 1e-7 >= next_sample:
                    ok, image = capture.retrieve()
                    if not ok or image is None:
                        raise VideoOCRError("decode_failed", "A sampled video frame could not be decoded.")
                    height, width = image.shape[:2]
                    if width * height > 1920 * 1080 or max(width, height) > 1920:
                        raise VideoOCRError("unsupported_video", "Decoded resolution exceeds 1080p.")
                    prediction = engine.predict(image)
                    prediction.update({"timestamp_seconds": round(seconds, 6),
                                       "sample_index": math.floor(seconds + 1e-7),
                                       "requested_timestamp_seconds": next_sample,
                                       "source_frame_index": frame_index, "opencv_pts_ms": pts_ms,
                                       "first_frame_pts_ms": first_pts})
                    accumulator.add(prediction)
                    raw_line = json.dumps(prediction, separators=(",", ":"), allow_nan=False) + "\n"
                    raw_stream.write(raw_line)
                    compact = {key: value for key, value in prediction.items() if key != "raw_model_output"}
                    review_line = json.dumps(compact, separators=(",", ":"), allow_nan=False) + "\n"
                    review_stream.write(review_line)
                    written += len(raw_line) + len(review_line)
                    if written > MAX_OUTPUT_BYTES:
                        raise VideoOCRError("storage_limit", "Extraction output exceeded its size bound.")
                    for board in prediction["boards"]:
                        csv_stream.write(f'{seconds:g};{board["fen"]}\n')
                    next_sample = math.floor(seconds + 1e-7) + 1
                    if progress:
                        progress({"phase": "extracting", "progress": min(seconds / metadata["duration_seconds"], 0.99),
                                  "frames_processed": accumulator.counts["frames"],
                                  "timestamp_seconds": seconds,
                                  "duration_seconds": metadata["duration_seconds"],
                                  "wall_seconds": time.monotonic() - started})
                    if accumulator.counts["frames"] % 60 == 0:
                        raw_stream.flush()
                        review_stream.flush()
                        csv_stream.flush()
                        if shutil.disk_usage(directory).free < 128 * 1024**2:
                            raise VideoOCRError("storage_limit", "Extraction stopped before storage filled.")
                frame_index += 1
        if not accumulator.counts["frames"] or seconds < metadata["duration_seconds"] - max(1, 2 / metadata["fps"]):
            raise VideoOCRError("decode_failed", "Video ended before its declared duration.")
        _check_cancel(cancelled)
        manifest.update(accumulator.finish(directory))
        manifest.update({"status": "completed", "wall_seconds": time.monotonic() - started,
                         "decoded_frames": frame_index, "last_pts_ms": previous_pts,
                         "first_pts_ms": first_pts})
        _write_manifest(directory, manifest)
        if progress:
            progress({"phase": "completed", "progress": 1, "frames_processed": manifest["frames"],
                      "timestamp_seconds": seconds, "duration_seconds": metadata["duration_seconds"],
                      "wall_seconds": manifest["wall_seconds"]})
        return manifest
    except Exception as exc:
        error = exc if isinstance(exc, VideoOCRError) else VideoOCRError(
            "extraction_failed", "Extraction failed while reading or recognizing the video.")
        manifest.update({"status": "cancelled" if error.code == "cancelled" else "failed",
                         "error": {"code": error.code, "message": str(error)},
                         "wall_seconds": time.monotonic() - started})
        _write_manifest(directory, manifest)
        if error is exc:
            raise
        raise error from exc
    finally:
        if capture is not None:
            capture.release()
