import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../app/static/vendor/chessjs/chess.mjs';
import { initialPosition, advancePosition } from '../app/static/studio-position-cache.mjs';

test('cached paths reproduce fresh-board keys and FENs across branches, castling and en passant', () => {
  const lines = [
    ['e2e4','a7a6','e4e5','d7d5','e5d6'],
    ['e2e4','e7e5','g1f3','b8c6','f1e2','g8f6','e1g1'],
    ['e2e4','e7e5','g1f3','b8c6','f1c4'],
  ];
  for (let pass = 0; pass < 2; pass++) for (const line of lines) {
    let state = initialPosition, board = new Chess();
    for (const uci of line) {
      const expectedKey = `${board.fen().split(' ').slice(0,4).join(' ')}|${uci}`;
      board = new Chess(board.fen());
      board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});
      state = advancePosition(state,uci);
      assert.equal(state.key,expectedKey);
      assert.equal(state.fen,board.fen());
    }
  }
});

test('invalid moves cannot poison valid paths or ambiguous histories', () => {
  const malformed = advancePosition(initialPosition,'e2e4 e7e5');
  const first = advancePosition(initialPosition,'e2e4');
  assert.notEqual(advancePosition(first,'e7e5').fen, malformed.fen);
  assert.equal(advancePosition(first,'e2e4'),null);
  assert.ok(advancePosition(first,'c7c5'));
});
