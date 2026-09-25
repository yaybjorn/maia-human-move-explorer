import { Chessground } from "./vendor/chessground/chessground-9.2.1.min.js";

export function legalDestinations(legalMoves = []) {
  const destinations = new Map();
  for (const move of legalMoves) {
    if (!destinations.has(move.from)) destinations.set(move.from, []);
    // Chessground's pointer path checks destinations with Array#includes().
    // Keep promotion variants collapsed onto one target without passing a Set,
    // which renders highlights but rejects the actual pointer move.
    if (!destinations.get(move.from).includes(move.to)) destinations.get(move.from).push(move.to);
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

const pieceNames = { p: "black pawn", n: "black knight", b: "black bishop", r: "black rook", q: "black queen", k: "black king", P: "white pawn", N: "white knight", B: "white bishop", R: "white rook", Q: "white queen", K: "white king" };

export function keyboardSquareAfter(square, key, flipped = false) {
  const files = "abcdefgh", file = files.indexOf(square[0]), rank = Number(square[1]);
  const direction = flipped ? -1 : 1;
  const next = key === "ArrowLeft" ? [file - direction, rank] : key === "ArrowRight" ? [file + direction, rank] : key === "ArrowUp" ? [file, rank + direction] : key === "ArrowDown" ? [file, rank - direction] : null;
  return next && next[0] >= 0 && next[0] < 8 && next[1] >= 1 && next[1] <= 8 ? `${files[next[0]]}${next[1]}` : square;
}

export function squareAccessibleName(square, piece, { selected = false, destinationFrom = null } = {}) {
  return `${square}, ${pieceNames[piece] || "empty square"}${selected ? ", selected" : ""}${destinationFrom ? `, legal destination from ${destinationFrom}` : ""}`;
}

/** Shared adapter for the Studio editor and learner-preview boards. */
export function createStudioBoard(element, { onMove, chessground = Chessground }) {
  let positionKey = null;
  let board = null, currentPosition = null, options = {}, keyboardSelected = null, keyboardFocus = "e4";
  const initialClassName = element.className;
  const keyboardID = `chessground-keyboard-${Math.random().toString(36).slice(2)}`;

  function createBoard() {
    if (board) return board;
    board = chessground(element, {
      animation: { enabled: true, duration: 180 }, coordinates: true,
      draggable: { enabled: true, showGhost: true },
      movable: { color: "both", free: false, showDests: true, events: { after: onMove } },
      selectable: { enabled: true },
      drawable: { enabled: true, eraseOnClick: false, shapes: [] },
    });
    return board;
  }

  function reset() {
    if (board) board.destroy();
    board = null;
    // Chessground retains references to its generated tree. Only clear after
    // destroying it, so a later populated render always gets a fresh adapter.
    element.replaceChildren();
    element.className = initialClassName;
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
    element.removeAttribute("aria-activedescendant");
    positionKey = null;
    currentPosition = null;
    keyboardSelected = null;
  }

  function keyboardCells() {
    return element.querySelectorAll("[data-chessground-keyboard-square]");
  }

  function ensureKeyboardLayer() {
    if (element.querySelector("[data-chessground-keyboard-layer]")) return;
    const document = element.ownerDocument || globalThis.document;
    if (!document?.createElement) return;
    const layer = document.createElement("div");
    layer.className = "visually-hidden chessground-keyboard-grid";
    layer.dataset.chessgroundKeyboardLayer = "";
    for (let rank = 8; rank >= 1; rank -= 1) {
      const row = document.createElement("div");
      row.setAttribute("role", "row");
      for (const file of "abcdefgh") {
        const square = `${file}${rank}`, cell = document.createElement("span");
        cell.id = `${keyboardID}-${square}`;
        cell.dataset.chessgroundKeyboardSquare = square;
        cell.setAttribute("role", "gridcell");
        row.append(cell);
      }
      layer.append(row);
    }
    element.append(layer);
    element.setAttribute("role", "grid");
    element.setAttribute("tabindex", "0");
  }

  function updateKeyboardLayer() {
    if (!currentPosition?.fen) return;
    const pieces = {};
    let file = 0;
    currentPosition.fen.split(" ")[0].split("/").forEach((rank, rankIndex) => {
      file = 0;
      for (const token of rank) {
        if (/\d/.test(token)) file += Number(token);
        else { pieces[`abcdefgh`[file] + (8 - rankIndex)] = token; file += 1; }
      }
    });
    const legal = new Set((currentPosition.legal_moves || []).filter(move => move.from === keyboardSelected).map(move => move.to));
    ensureKeyboardLayer();
    keyboardCells().forEach(square => {
      const key = square.dataset.chessgroundKeyboardSquare;
      const selected = key === keyboardSelected, destination = legal.has(key);
      square.setAttribute("aria-selected", String(selected));
      square.setAttribute("aria-label", squareAccessibleName(key, pieces[key], { selected, destinationFrom: destination ? keyboardSelected : null }));
      square.setAttribute("aria-disabled", String(options.locked || !options.interactive));
    });
    element.setAttribute("aria-activedescendant", `${keyboardID}-${keyboardFocus}`);
  }

  function selectKeyboardSquare(square) {
    if (!currentPosition || options.locked || !options.interactive) return;
    const moves = currentPosition.legal_moves || [];
    const candidate = keyboardSelected && moves.find(move => move.from === keyboardSelected && move.to === square);
    if (candidate) {
      keyboardSelected = null;
      board?.selectSquare?.(null);
      onMove(candidate.from, candidate.to);
    } else {
      keyboardSelected = moves.some(move => move.from === square) ? square : null;
      board?.selectSquare?.(keyboardSelected);
      updateKeyboardLayer();
    }
  }

  element.addEventListener("keydown", event => {
    const square = keyboardFocus;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      keyboardFocus = keyboardSquareAfter(square, event.key, options.flipped);
      updateKeyboardLayer();
      event.preventDefault();
    } else if (event.key === "Enter" || event.key === " ") {
      keyboardFocus = square;
      selectKeyboardSquare(square);
      event.preventDefault();
    } else if (event.key === "Escape") {
      keyboardSelected = null;
      board?.selectSquare?.(null);
      updateKeyboardLayer();
      event.preventDefault();
    }
  });

  return {
    render(nextPosition, { interactive = false, flipped = false, locked = false } = {}) {
      if (!nextPosition?.fen) { reset(); return; }
      const changed = positionKey !== nextPosition.fen;
      positionKey = nextPosition.fen;
      keyboardSelected = changed ? null : keyboardSelected;
      keyboardFocus ||= "e4";
      currentPosition = nextPosition;
      options = { interactive, flipped, locked };
      createBoard().set(boardConfig(nextPosition, { interactive, flipped, locked, clearShapes: changed, onMove }));
      // The stable semantic grid belongs to this adapter, not Chessground's
      // transient move/check highlight nodes.
      updateKeyboardLayer();
    },
    destroy() { reset(); },
  };
}
