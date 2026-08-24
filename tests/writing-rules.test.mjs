import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canIgnoreWord,
  ignoredWritingRanges,
  normaliseIgnoredWord,
  overlapsIgnoredRange
} from '../app/static/writing-rules.mjs';

test('ignores bracketed PGN directives', () => {
  const comment = 'Plan [%csl Gd4,Ge4,Rg4][%cal Rc3e4,Rc5e4] done';
  const ranges = ignoredWritingRanges(comment);
  const csl = comment.indexOf('csl');
  const comma = comment.indexOf(',');
  assert.equal(overlapsIgnoredRange(csl, csl + 3, ranges), true);
  assert.equal(overlapsIgnoredRange(comma, comma + 1, ranges), true);
});

test('ignores black-move ellipsis notation but not surrounding prose', () => {
  const comment = 'forces ...Be7. After ...Be7 Black is passive.';
  const ranges = ignoredWritingRanges(comment);
  const firstMove = comment.indexOf('...Be7');
  const after = comment.indexOf('After');
  assert.equal(overlapsIgnoredRange(firstMove, firstMove + 3, ranges), true);
  assert.equal(overlapsIgnoredRange(after, after + 5, ranges), false);
});

test('accepts known false-positive phrases', () => {
  const comment = 'Otherwise known as the line for the faint-hearted.';
  const ranges = ignoredWritingRanges(comment);
  assert.equal(overlapsIgnoredRange(0, 9, ranges), true);
  const hearted = comment.indexOf('hearted');
  assert.equal(overlapsIgnoredRange(hearted, hearted + 7, ranges), true);
});

test('normalises and validates user-ignored names without ignoring arbitrary punctuation', () => {
  assert.equal(normaliseIgnoredWord(' Kilkenny '), 'kilkenny');
  assert.equal(canIgnoreWord('Weidenhagen'), true);
  assert.equal(canIgnoreWord('faint-hearted'), true);
  assert.equal(canIgnoreWord('...Be7'), false);
});
