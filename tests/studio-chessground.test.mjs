import assert from "node:assert/strict";
import { boardConfig, createStudioBoard, keyboardSquareAfter, legalDestinations, squareAccessibleName } from "../app/static/studio-chessground.mjs";

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

assert.equal(keyboardSquareAfter("e4", "ArrowUp"), "e5");
assert.equal(keyboardSquareAfter("e4", "ArrowUp", true), "e3");
assert.equal(squareAccessibleName("e4", "P", { selected: true }), "e4, white pawn, selected");
assert.equal(squareAccessibleName("e4", null, { destinationFrom: "e2" }), "e4, empty square, legal destination from e2");

// Minimal DOM harness: exercise the adapter against a live-looking Chessground
// tree without adding a runtime test dependency.
class Square {
  constructor(key) { this.cgKey = key; this.attributes = {}; this.focused = false; this.classList = { values: new Set(), toggle: (name, on) => on ? this.classList.values.add(name) : this.classList.values.delete(name) }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { this.focused = true; }
}
class Host {
  constructor() { this.className = "chessboard"; this.squares = []; this.listeners = {}; this.attributes = {}; this.board = { setAttribute: (name, value) => { this.board[name] = value; } }; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren() { this.squares = []; }
  querySelector(selector) { return selector === "cg-board" && this.squares.length ? this.board : null; }
  querySelectorAll(selector) { return selector === "cg-board square" ? this.squares : []; }
  key(key, square) { let prevented = false; this.listeners.keydown({ key, target: square, preventDefault: () => { prevented = true; } }); return prevented; }
}
const host = new Host(), instances = [], attempted = [];
const keyboardPosition = { fen: "8/8/8/8/8/8/8/8 w - - 0 1", legal_moves: [{ from: "e2", to: "e3" }] };
const fakeChessground = element => {
  const instance = { destroyed: false, sets: [], set(config) { this.sets.push(config); element.squares = ["e2", "e3", "e4"].map(key => new Square(key)); }, destroy() { this.destroyed = true; } };
  instances.push(instance); return instance;
};
const adapter = createStudioBoard(host, { chessground: fakeChessground, onMove: (from, to) => attempted.push(`${from}${to}`) });
// Empty preview disposal must destroy the mounted board, then recreate it for a
// later populated position rather than mutating Chessground's live DOM.
adapter.render(null);
assert.equal(instances.length, 0);
adapter.render(keyboardPosition, { interactive: true });
assert.equal(instances.length, 1);
adapter.render(null);
assert.equal(instances[0].destroyed, true);
assert.equal(host.squares.length, 0);
adapter.render(keyboardPosition, { interactive: true });
assert.equal(instances.length, 2);
const e2 = host.squares.find(square => square.cgKey === "e2"), e3 = host.squares.find(square => square.cgKey === "e3");
assert.ok(e2 && e3);
host.key("ArrowDown", e2); host.key("ArrowDown", e2);
host.key("Enter", e2);
host.key("ArrowUp", e2);
host.key(" ", e3);
assert.deepEqual(attempted, ["e2e3"]);
