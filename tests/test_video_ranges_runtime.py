"""Bounded-media contracts; local synthetic cuts exercise actual FFmpeg without OCR/network."""
import copy
import gzip
import json
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest
from test_video_ocr import mock_extraction

from app import video_jobs_worker as worker
from app.video_jobs import JobError
from app.video_ocr import runtime


@pytest.fixture
def frozen():
    from test_video_ocr import frozen as frozen_fixture

    return frozen_fixture.__wrapped__()


@pytest.mark.parametrize('interval', [None, {}, {'startSeconds': 0},
    {'startSeconds': True, 'endSeconds': 5}, {'startSeconds': 5, 'endSeconds': 5},
    {'startSeconds': 0, 'endSeconds': float('inf')}, {'startSeconds': -1, 'endSeconds': 5},
    {'startSeconds': 0, 'endSeconds': 10801}, {'startSeconds': 0, 'endSeconds': 10**400}])
def test_worker_rejects_historical_or_invalid_range_before_acquisition(interval):
    with pytest.raises(JobError, match='explicit finite'):
        worker.required_range({'source': {'range': interval}})


def test_bounded_fractional_start_absolute_exports_and_exclusive_end(tmp_path, monkeypatch, frozen):
    source, model, capture = mock_extraction(monkeypatch, tmp_path, frozen,
                                             [50, 85, 1051, 2017, 2050, 3050])
    monkeypatch.setattr(runtime, 'probe_video', lambda _: {'duration_seconds': 2, 'fps': 30})
    output, updates = tmp_path / 'result', []
    interval = {'startSeconds': 19.25, 'endSeconds': 21.25}
    summary = runtime.run_video(source, output, model, updates.append, source_range=interval,
                                acquisition={'videoID': 'test-video', 'sourceDurationSeconds': 100})
    rows = [json.loads(line) for line in (output / 'observations.jsonl').read_text().splitlines()]
    assert [row['timestamp_seconds'] for row in rows] == pytest.approx([19.25, 20.251])
    assert [row['requested_timestamp_seconds'] for row in rows] == [19.25, 20.25]
    assert [row['clip_frame_index'] for row in rows] == [0, 2]
    assert all(row['source_frame_index'] is None for row in rows)
    assert capture.index == 4  # endpoint decoded only to stop, never inferred
    assert summary['range'] == interval and summary['frames'] == 2
    assert summary['source_hash_scope'] == 'bounded-clip'
    assert summary['acquisition']['sourceDurationSeconds'] == 100
    assert summary['fen_segments'] > 0
    assert (output / 'positions.csv').read_text().splitlines()[1].startswith('19.25;')
    assert (output / 'positions-changes.csv').read_text().splitlines()[1].startswith('19.25;')
    assert updates[2]['duration_seconds'] == 2 and 0.5 < updates[2]['progress'] < 0.51
    with gzip.open(output / 'raw.jsonl.gz', 'rt') as stream:
        assert json.loads(next(stream))['timestamp_seconds'] == 19.25


def test_bounded_truncated_decode_and_oversized_clip_fail(tmp_path, monkeypatch, frozen):
    source, model, _ = mock_extraction(monkeypatch, tmp_path, frozen, [0, 1000, 1500])
    interval = {'startSeconds': 19, 'endSeconds': 21}
    with pytest.raises(runtime.VideoOCRError, match='does not match'):
        runtime.run_video(source, tmp_path / 'wrongclip', model, source_range=interval)
    monkeypatch.setattr(runtime, 'probe_video', lambda _: {'duration_seconds': 2, 'fps': 30})
    with pytest.raises(runtime.VideoOCRError) as exc:
        runtime.run_video(source, tmp_path / 'shortdecode', model, source_range=interval)
    assert exc.value.code == 'decode_failed'
    assert json.loads((tmp_path / 'shortdecode' / 'manifest.json').read_text())['status'] == 'failed'


def test_disjoint_excerpts_never_merge_review_segments(tmp_path, monkeypatch, frozen):
    for start in (19, 99):
        source, model, _ = mock_extraction(monkeypatch, tmp_path, frozen, [0, 1000, 1967])
        monkeypatch.setattr(runtime, 'probe_video', lambda _: {'duration_seconds': 2, 'fps': 30})
        output = tmp_path / str(start)
        runtime.run_video(source, output, model,
                          source_range={'startSeconds': start, 'endSeconds': start + 2})
        segments = json.loads((output / 'segments.json').read_text())
        assert len(segments) == 1
        assert segments[0]['first_seen_seconds'] == start and segments[0]['observations'] == 2


def test_downloader_expands_section_before_process_info(tmp_path, monkeypatch):
    captured = {}
    info = {'id': 'abcdefghijk', 'duration': 500, 'title': 'fixture'}

    class Downloader:
        def __init__(self, options):
            captured['options'] = options
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def extract_info(self, url, download):
            assert download is False
            return copy.deepcopy(info)
        def process_ie_result(self, video, download):
            assert download is True
            captured['video'] = video
        def process_info(self, *_):
            pytest.fail('process_info bypasses range expansion')

    monkeypatch.setitem(sys.modules, 'yt_dlp', SimpleNamespace(YoutubeDL=Downloader))
    monkeypatch.setattr(worker, 'finish_acquisition', lambda path, provenance, store: provenance)
    store = SimpleNamespace(root=tmp_path, directory=lambda _: tmp_path, check_capacity=lambda: None)
    job = {'id': 'job', 'source': {'videoID': 'abcdefghijk', 'downloadURL': 'https://youtu.be/abcdefghijk',
                                  'range': {'startSeconds': 19.25, 'endSeconds': 20.75}}}
    provenance = worker.obtain_source(job, store, lambda _: None, lambda: False)
    options = captured['options']
    assert options['download_ranges'](info, None) == [{'start_time': 19.25, 'end_time': 20.75}]
    assert options['force_keyframes_at_cuts'] is True
    assert options['external_downloader_args']['ffmpeg_i'] == ['-threads', '1']
    assert '-fs' in options['external_downloader_args']['ffmpeg_o']
    assert 'max_filesize' not in options  # full source size must not block a bounded section
    assert provenance['sourceDurationSeconds'] == 500
    assert provenance['clipOffsetSeconds'] == 19.25
    info['duration'] = 20
    with pytest.raises(JobError, match='beyond'):
        worker.obtain_source(job, store, lambda _: None, lambda: False)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg unavailable')
def test_real_cache_cut_nonzero_start_duration_and_frame_content(tmp_path):
    original, clip = tmp_path / 'original.mp4', tmp_path / 'clip.mp4'
    # Red 0..1, blue 1..2, green 2..3. [1.2,2.4) must be blue then green,
    # never include the earlier red section or continue through the full source.
    subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'color=red:s=32x32:r=10:d=1',
                    '-f', 'lavfi', '-i', 'color=blue:s=32x32:r=10:d=1',
                    '-f', 'lavfi', '-i', 'color=green:s=32x32:r=10:d=1',
                    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
                    '-map', '[v]', '-c:v', 'libx264', '-threads', '1', str(original)], check=True)
    store = SimpleNamespace(root=tmp_path, check_capacity=lambda: None)
    worker.cut_cached_source(original, clip, 1.2, 2.4, store, lambda _: None, lambda: False)
    metadata = runtime.probe_video(clip)
    assert metadata['duration_seconds'] == pytest.approx(1.2, abs=.01)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(clip), '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', 'pipe:1'], check=True, capture_output=True).stdout
    pixels = [raw[i:i+3] for i in range(0, len(raw), 32*32*3)]
    assert len(pixels) == 12
    assert all(pixel[2] > 200 and pixel[0] < 10 for pixel in pixels[:8])
    assert all(pixel[1] > 100 and pixel[2] < 10 for pixel in pixels[8:])
    provenance = {'range': {'startSeconds': 1.2, 'endSeconds': 2.4}, 'videoID': 'abcdefghijk'}
    acquired = worker.finish_acquisition(clip, provenance, store)
    assert acquired.path == clip
    assert len(acquired.provenance['clipSha256']) == 64
    assert json.loads((tmp_path / 'acquisition.json').read_text())['clipMetadata'] == metadata


def test_admission_cap_reserves_engine_floor_and_concurrent_growth(tmp_path, monkeypatch):
    store = SimpleNamespace(root=tmp_path, check_capacity=lambda: None, directory=lambda _: tmp_path)
    floor = worker.ENGINE_MIN_FREE_BYTES + worker.ACQUISITION_RESERVE_BYTES
    monkeypatch.setattr(worker.shutil, 'disk_usage', lambda _: SimpleNamespace(free=floor + 10 * 1024**2))
    assert worker.acquisition_budget(store) == 10 * 1024**2
    partial = tmp_path / 'source.mp4.part'
    partial.write_bytes(b'123456')
    with pytest.raises(JobError, match='byte limit'):
        worker.check_worker_capacity(store, 'job', 5)
    monkeypatch.setattr(worker.shutil, 'disk_usage', lambda _: SimpleNamespace(free=floor - 1))
    with pytest.raises(JobError, match='reserved storage'):
        worker.acquisition_budget(store)
    with pytest.raises(JobError, match='headroom'):
        worker.check_worker_capacity(store)


@pytest.mark.skipif(sys.platform == 'win32', reason='POSIX production process-group contract')
def test_parent_storage_guard_stops_real_writer_grandchild_without_hooks(tmp_path, monkeypatch):
    import os
    import signal
    import time

    output = tmp_path / 'source.mp4.part'
    writer = ("import time; from pathlib import Path; "
              f"f=Path({str(output)!r}).open('wb'); "
              "exec('while True:\\n f.write(b\"x\"*1024); f.flush(); time.sleep(.02)')")
    parent = (f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{writer!r}]); "
              "time.sleep(20)")
    child = subprocess.Popen([sys.executable, '-c', parent], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    updates = []

    def update(job, **values):
        assert child.returncode is not None  # no terminal write before process wait
        updates.append(values)

    store = SimpleNamespace(root=tmp_path, directory=lambda _: tmp_path,
                             check_capacity=lambda: None, update=update)
    try:
        deadline = time.monotonic() + 3
        while (not output.exists() or output.stat().st_size == 0) and time.monotonic() < deadline:
            time.sleep(.02)
        assert output.exists() and output.stat().st_size > 0
        monkeypatch.setattr(worker.shutil, 'disk_usage',
                            lambda _: SimpleNamespace(free=worker.ENGINE_MIN_FREE_BYTES + 1))
        assert worker.supervise_child(child, store, {'id': 'job'}, time.monotonic())
        final_size = output.stat().st_size
        time.sleep(.1)
        assert output.stat().st_size == final_size
        assert updates[0]['status'] == 'failed' and updates[0]['phase'] == 'storage-limit'
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def test_fractional_near_end_raw_and_csv_do_not_round_across_end(tmp_path, monkeypatch, frozen):
    source, model, _ = mock_extraction(monkeypatch, tmp_path, frozen, [0, 33])
    monkeypatch.setattr(runtime, 'probe_video', lambda _: {'duration_seconds': .04, 'fps': 30})
    output = tmp_path / 'near-end'
    start, end = 10799.966667, 10800
    runtime.run_video(source, output, model, source_range={'startSeconds': start, 'endSeconds': end})
    rows = [json.loads(line) for line in (output / 'observations.jsonl').read_text().splitlines()]
    assert rows[0]['timestamp_seconds'] == start
    for name in ('positions.csv', 'positions-changes.csv'):
        times = [float(line.split(';')[0]) for line in (output / name).read_text().splitlines()[1:]]
        assert times == [start] and all(t < end for t in times)
    assert runtime.format_seconds(19.9999996) == '19.9999996'
    accumulator = runtime.ReviewAccumulator()
    for second in (10798.966667, 10799.966667):
        row = copy.deepcopy(frozen[0])
        row['timestamp_seconds'] = second
        row['sample_index'] = int(second)
        row['boards'][0].update(orientation='normal', orientation_conf=.99, board_conf=.99,
                               piece_confs={'e1': .99, 'e8': .99})
        accumulator.add(row)
    accumulator.finish(output)
    screened = (output / 'positions-screened-draft.csv').read_text().splitlines()[1:]
    assert float(screened[0].split(';')[0]) == 10798.966667


def test_linux_parent_death_guard_arms_group_cleanup_and_checks_race(monkeypatch):
    calls = []
    monkeypatch.setattr(worker.os, 'getpgrp', lambda: 42)
    monkeypatch.setattr(worker.os, 'getpid', lambda: 42)
    monkeypatch.setattr(worker.os, 'getppid', lambda: 99)
    monkeypatch.setattr(worker.signal, 'signal', lambda *args: calls.append(('handler', *args)))
    monkeypatch.setattr(worker.ctypes, 'CDLL', lambda _: SimpleNamespace(
        prctl=lambda *args: calls.append(('prctl', *args)) or 0))
    monkeypatch.setattr(worker, 'terminate_job_group', lambda *args: calls.append(('stop',)))
    worker.arm_parent_death_guard(99)
    assert calls == [('handler', worker.signal.SIGTERM, worker.terminate_job_group),
                     ('prctl', 1, worker.signal.SIGTERM)]
    worker.arm_parent_death_guard(98)
    assert calls[-1] == ('stop',)
    monkeypatch.setattr(worker.os, 'getpgrp', lambda: 41)
    with pytest.raises(RuntimeError, match='isolated'):
        worker.arm_parent_death_guard(99)


@pytest.mark.skipif(sys.platform == 'win32', reason='POSIX process-group lifecycle')
def test_parent_death_signal_handler_stops_actual_ffmpeg_like_grandchild(tmp_path):
    import os
    import signal
    import time

    output = tmp_path / 'orphan-source.mp4.part'
    writer = ("import time; from pathlib import Path; "
              f"f=Path({str(output)!r}).open('wb'); "
              "exec('while True:\\n f.write(b\"x\"*1024); f.flush(); time.sleep(.02)')")
    parent = ("import signal,subprocess,sys,time; "
              "from app.video_jobs_worker import terminate_job_group; "
              "signal.signal(signal.SIGTERM,terminate_job_group); "
              f"subprocess.Popen([sys.executable,'-c',{writer!r}]); time.sleep(20)")
    child = subprocess.Popen([sys.executable, '-c', parent], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 3
        while (not output.exists() or output.stat().st_size == 0) and time.monotonic() < deadline:
            time.sleep(.02)
        assert output.exists() and output.stat().st_size > 0
        # This is the signal Linux delivers when the queue owner exits. On macOS
        # the actual group cleanup is tested by delivering it explicitly.
        os.kill(child.pid, signal.SIGTERM)
        child.wait(timeout=3)
        size = output.stat().st_size
        time.sleep(.1)
        assert output.stat().st_size == size and child.returncode == -signal.SIGKILL
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


@pytest.mark.skipif(sys.platform == 'win32', reason='POSIX process-group lifecycle')
def test_crashed_job_residual_writer_is_killed_before_next_claim(tmp_path):
    import os
    import signal
    import time

    output = tmp_path / 'crash-source.mp4.part'
    writer = ("import time; from pathlib import Path; "
              f"f=Path({str(output)!r}).open('wb'); "
              "exec('while True:\\n f.write(b\"x\"*1024); f.flush(); time.sleep(.02)')")
    parent = ("import subprocess,sys,time; "
              f"subprocess.Popen([sys.executable,'-c',{writer!r}]); time.sleep(20)")
    child = subprocess.Popen([sys.executable, '-c', parent], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 3
        while (not output.exists() or output.stat().st_size == 0) and time.monotonic() < deadline:
            time.sleep(.02)
        assert output.exists() and output.stat().st_size > 0
        # Abrupt job-only kill bypasses handlers and leaves the FFmpeg-like child.
        os.kill(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        size = output.stat().st_size
        time.sleep(.1)
        assert output.stat().st_size > size  # reproduce actual orphan before cleanup
        worker.cleanup_job_group(child)
        size = output.stat().st_size
        time.sleep(.1)
        assert output.stat().st_size == size
        worker.cleanup_job_group(child)  # idempotent after normal group disappearance
    finally:
        worker.cleanup_job_group(child)
