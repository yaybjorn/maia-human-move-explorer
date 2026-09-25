import { Chessground } from "./vendor/chessground/chessground-9.2.1.min.js";

export function legalDestinations(legalMoves = []) {
  const destinations = new Map();
  for (const move of legalMoves) {
    if (!destinations.has(move.from)) destinations.set(move.from, new Set());
    destinations.get(move.from).add(move.to);
  }
  return destinations;
}

export function boardConfig(position, { interactive = false, flipped = false, locked = false, clearShapes = false, onMove } = {}) {
  return {
    fen: position.fen, orientation: flipped ? "black" : "white",
    turnColor: position.fen.split(" ")[1] === "b" ? "black" : "white",
    movable: { color: interactive && !locked ? "both" : undefined, free: false,
      dests: interactive && !locked ? legalDestinations(position.legal_moves) : new Map(),
      showDests: interactive && !locked, events: { after: onMove } },
    selectable: { enabled: interactive && !locked },
    drawable: clearShapes ? { enabled: true, eraseOnClick: false, shapes: [] } : { enabled: true, eraseOnClick: false },
  };
}

/** Shared adapter for the Studio editor and learner-preview boards. */
export function createStudioBoard(element, { onMove }) {
  let positionKey = null;
  const board = Chessground(element, {
    animation: { enabled: true, duration: 180 }, coordinates: true,
    draggable: { enabled: true, showGhost: true },
    movable: { color: "both", free: false, showDests: true, events: { after: onMove } },
    selectable: { enabled: true },
    drawable: { enabled: true, eraseOnClick: false, shapes: [] },
  });
  return {
    render(position, { interactive = false, flipped = false, locked = false } = {}) {
      if (!position?.fen) { element.innerHTML = ""; positionKey = null; return; }
      const changed = positionKey !== position.fen;
      positionKey = position.fen;
      board.set(boardConfig(position, { interactive, flipped, locked, clearShapes: changed, onMove }));
    },
    destroy() { board.destroy(); },
  };
}
