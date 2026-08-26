import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyIssueSuggestion,
  attachMoveHistories,
  extractCommentSources,
  fixedFilename
} from '../app/static/pgn-spellcheck.mjs';

test('extracts editable brace and semicolon comments but skips percent lines', () => {
  const pgn = '[Event "Test"]\n% generated metadata\n1. e4 { This are wrong. } e5 ; Another typo\n2. Nf3 *';
  const sources = extractCommentSources(pgn);
  assert.deepEqual(sources.map(source => source.comment), ['This are wrong.', 'Another typo']);
  assert.equal(pgn.slice(sources[0].contentStart, sources[0].contentEnd), 'This are wrong.');
});

test('attaches move histories without losing duplicate comments', () => {
  const sources = extractCommentSources('1. e4 {Same.} e5 {Same.} *');
  const attached = attachMoveHistories(sources, [
    {comment:'Same.', history:'1. e4'},
    {comment:'Same.', history:'1. e4 e5'}
  ]);
  assert.deepEqual(attached.map(source => source.history), ['1. e4', '1. e4 e5']);
});

test('applies a suggestion only inside the selected comment', () => {
  const pgn = '1. e4 {This are wrong.} e5 *';
  const fixed = applyIssueSuggestion(pgn, {sourceId:0, start:5, end:8}, 'is');
  assert.equal(fixed, '1. e4 {This is wrong.} e5 *');
});

test('creates a separate fixed filename', () => {
  assert.equal(fixedFilename('London.pgn'), 'London-fixed.pgn');
  assert.equal(fixedFilename('London.PGN'), 'London-fixed.pgn');
});
