#!/usr/bin/env python3
"""Benchmark an official Maia-3 model on representative histories.

Examples:
  python scripts/benchmark.py --model maia3-5m --warmup 3 --runs 20
  python scripts/benchmark.py --model maia3-23m --runs 20
"""
import argparse
import json
import os
import resource
import statistics
import time

os.environ.setdefault("MAIA_MODEL", "maia3-5m")
from app.chess_state import replay
from app.engine import MaiaEngine

POSITIONS = [
    [],
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"],
    ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "e8g8"],
]


def percentile(values, fraction):
    return sorted(values)[min(len(values) - 1, round((len(values) - 1) * fraction))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="maia3-5m", choices=["maia3-5m", "maia3-23m"])
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--runs", type=int, default=20)
    args = parser.parse_args()
    engine = MaiaEngine(args.model)
    samples = [replay("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", m) for m in POSITIONS]
    started = time.perf_counter()
    engine.predict(samples[0], 1500, 1500)
    cold = time.perf_counter() - started
    for i in range(args.warmup):
        engine.predict(samples[i % len(samples)], 1500, 1500)
    timings = []
    for i in range(args.runs):
        started = time.perf_counter()
        engine.predict(samples[i % len(samples)], 1500, 1600)
        timings.append((time.perf_counter() - started) * 1000)
    result = {
        "model": args.model, "runs": args.runs, "cold_load_seconds": round(cold, 3),
        "warm_ms": {"median": round(statistics.median(timings), 2), "p95": round(percentile(timings, .95), 2), "max": round(max(timings), 2)},
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 if os.uname().sysname == "Linux" else 1024 * 1024), 1),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
