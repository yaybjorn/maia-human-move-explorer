import { Chess } from './vendor/chessjs/chess.mjs';

// A position depends only on its full UCI history from the standard start, not
// on chapter metadata or annotations. Share this bounded, in-memory cache across
// hint and comment indexes; never cache authored values or mutable nodes.
const positions = new Map();
const limit = 50000;
export const initialPosition = { fen: new Chess().fen(), path: [] };

export function advancePosition(parent, uci) {
  const path = [...parent.path, uci], cacheKey = JSON.stringify(path);
  if (positions.has(cacheKey)) return positions.get(cacheKey);
  let result = null;
  try {
    const board = new Chess(parent.fen);
    const key = `${board.fen().split(' ').slice(0, 4).join(' ')}|${uci}`;
    board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    result = { fen: board.fen(), path, key };
  } catch { /* Invalid move: match the indexers' existing skip behaviour. */ }
  if (positions.size >= limit) positions.clear();
  positions.set(cacheKey, result);
  return result;
}
