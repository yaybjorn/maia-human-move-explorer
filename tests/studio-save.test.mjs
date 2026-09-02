import assert from "node:assert/strict";
import test from "node:test";

import { SaveQueue, SingleFlight } from "../app/static/studio-save.mjs";

test("concurrent callers share one save operation", async () => {
  const flight = new SingleFlight();
  let calls = 0;
  let finish;
  const operation = () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  };

  const first = flight.run(operation);
  const second = flight.run(operation);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish("saved");
  assert.deepEqual(await Promise.all([first, second]), ["saved", "saved"]);
});

test("a completed or failed save does not block the next operation", async () => {
  const flight = new SingleFlight();
  await assert.rejects(flight.run(async () => { throw new Error("conflict"); }), /conflict/);
  assert.equal(await flight.run(async () => "retried"), "retried");
  assert.equal(await flight.run(async () => "next"), "next");
});

test("save queue persists edits made while an earlier save is in flight", async () => {
  let current = false;
  let calls = 0;
  let finishFirst;
  const queue = new SaveQueue(async () => {
    calls += 1;
    if (calls === 1) await new Promise(resolve => { finishFirst = resolve; });
    else current = true;
    return true;
  }, () => current);

  const save = queue.run();
  await Promise.resolve();
  current = false;
  finishFirst();
  assert.equal(await save, true);
  assert.equal(calls, 2);
});

test("save queue stops after a failed save", async () => {
  let calls = 0;
  const queue = new SaveQueue(async () => { calls += 1; return false; }, () => false);
  assert.equal(await queue.run(), false);
  assert.equal(calls, 1);
});
