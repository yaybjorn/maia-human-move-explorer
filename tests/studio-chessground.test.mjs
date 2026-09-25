import assert from "node:assert/strict";
import { boardConfig, legalDestinations } from "../app/static/studio-chessground.mjs";

const destinations = legalDestinations([
  { from: "e1", to: "g1", uci: "e1g1" }, { from: "e1", to: "c1", uci: "e1c1" },
  { from: "e5", to: "d6", uci: "e5d6" }, { from: "a7", to: "a8", uci: "a7a8q" },
  { from: "a7", to: "a8", uci: "a7a8n" },
]);
assert.deepEqual([...destinations.get("e1")].sort(), ["c1", "g1"]);
assert.deepEqual([...destinations.get("e5")], ["d6"]);
assert.deepEqual([...destinations.get("a7")], ["a8"]);
assert.equal(destinations.has("b2"), false);

const position = { fen: "8/8/8/8/8/8/8/8 b - - 0 1", legal_moves: [{ from: "e5", to: "d6" }] };
const config = boardConfig(position, { interactive: true, flipped: true, clearShapes: true });
assert.equal(config.orientation, "black");
assert.equal(config.turnColor, "black");
assert.equal(config.movable.color, "both");
assert.deepEqual(config.drawable.shapes, []);
const locked = boardConfig(position, { interactive: true, locked: true });
assert.equal(locked.selectable.enabled, false);
assert.equal(locked.movable.dests.size, 0);
