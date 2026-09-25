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
    positionKey = null;
    currentPosition = null;
    keyboardSelected = null;
  }

  function decorateSquares() {
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
    element.querySelector("cg-board")?.setAttribute("role", "grid");
    element.querySelectorAll("cg-board square").forEach(square => {
      const key = square.cgKey || square.getAttribute("data-key");
      if (!key) return;
      const selected = key === keyboardSelected, destination = legal.has(key);
      square.setAttribute("role", "button");
      square.setAttribute("tabindex", key === keyboardFocus ? "0" : "-1");
      square.setAttribute("aria-pressed", String(selected));
      square.setAttribute("aria-label", squareAccessibleName(key, pieces[key], { selected, destinationFrom: destination ? keyboardSelected : null }));
      square.classList.toggle("keyboard-selected", selected);
      square.classList.toggle("keyboard-destination", destination);
    });
  }

  function selectKeyboardSquare(square) {
    if (!currentPosition || options.locked || !options.interactive) return;
    const moves = currentPosition.legal_moves || [];
    const candidate = keyboardSelected && moves.find(move => move.from === keyboardSelected && move.to === square);
    if (candidate) {
      keyboardSelected = null;
      onMove(candidate.from, candidate.to);
    } else {
      keyboardSelected = moves.some(move => move.from === square) ? square : null;
      decorateSquares();
    }
  }

  element.addEventListener("keydown", event => {
    const square = event.target?.cgKey || event.target?.getAttribute?.("data-key") || keyboardFocus;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      keyboardFocus = keyboardSquareAfter(square, event.key, options.flipped);
      decorateSquares();
      element.querySelectorAll("cg-board square").forEach(item => {
        const key = item.cgKey || item.getAttribute("data-key");
        if (key === keyboardFocus) item.focus();
      });
      event.preventDefault();
    } else if (event.key === "Enter" || event.key === " ") {
      keyboardFocus = square;
      selectKeyboardSquare(square);
      event.preventDefault();
    } else if (event.key === "Escape") {
      keyboardSelected = null;
      decorateSquares();
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
      // Keep the keyboard semantics on Chessground's single rendered board.
      decorateSquares();
    },
    destroy() { reset(); },
  };
}
