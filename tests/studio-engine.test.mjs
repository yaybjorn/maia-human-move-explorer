import assert from "node:assert/strict";
import test from "node:test";

import {
  EngineAnalysisController,
  engineEvaluationText,
  whiteEvaluationPercent,
} from "../app/static/studio-engine.mjs";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("formats centipawn and mate evaluations from White's perspective", () => {
  assert.equal(engineEvaluationText({ type: "cp", value: 31 }), "+0.31");
  assert.equal(engineEvaluationText({ type: "cp", value: -245 }), "-2.45");
  assert.equal(engineEvaluationText({ type: "mate", value: 3 }), "M3");
  assert.equal(engineEvaluationText({ type: "mate", value: -2 }), "−M2");
});

test("maps evaluations to a bounded White share", () => {
  assert.equal(whiteEvaluationPercent({ type: "cp", value: 0 }), 50);
  assert.ok(whiteEvaluationPercent({ type: "cp", value: 600 }) > 85);
  assert.ok(whiteEvaluationPercent({ type: "cp", value: -600 }) < 15);
  assert.equal(whiteEvaluationPercent({ type: "mate", value: 1 }), 100);
  assert.equal(whiteEvaluationPercent({ type: "mate", value: -1 }), 0);
});

test("debounces rapid positions and ignores stale results", async () => {
  const pending = new Map();
  const results = [];
  const controller = new EngineAnalysisController({
    delay: 1,
    analyze: moves => new Promise(resolve => pending.set(moves.join(" "), resolve)),
    onResult: value => results.push(value),
    onError: error => assert.fail(error),
  });

  controller.schedule(["e2e4"]);
  await wait(5);
  controller.schedule(["d2d4"]);
  await wait(5);
  pending.get("e2e4")({ id: "old" });
  pending.get("d2d4")({ id: "current" });
  await wait(0);
  assert.deepEqual(results, [{ id: "current" }]);
});

test("cancel prevents queued analysis", async () => {
  let calls = 0;
  const controller = new EngineAnalysisController({
    delay: 10,
    analyze: async () => { calls += 1; },
    onResult: () => {},
    onError: error => assert.fail(error),
  });
  controller.schedule([]);
  controller.cancel();
  await wait(15);
  assert.equal(calls, 0);
});
