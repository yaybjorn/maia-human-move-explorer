import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canIgnoreWord,
  ignoredWritingRanges,
  normaliseIgnoredWord,
  overlapsIgnoredRange,
  writingTextForLint
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

test('treats annotated SAN punctuation as chess notation rather than a sentence boundary', () => {
  const comment = 'Ideas include f5! to follow, Nf3?! before Bxe6+!, and O-O! next.';
  const masked = writingTextForLint(comment);
  assert.equal(masked, 'Ideas include f5  to follow, Nf3   before Bxe6+ , and O-O  next.');

  const ranges = ignoredWritingRanges(comment);
  for (const token of ['f5!', 'Nf3?!', 'Bxe6+!', 'O-O!']) {
    const start = comment.indexOf(token);
    assert.equal(overlapsIgnoredRange(start, start + token.length, ranges), true);
  }
});

test('does not mask ordinary prose exclamation marks', () => {
  const comment = 'Excellent! this remains ordinary prose.';
  assert.equal(writingTextForLint(comment), comment);
});

test('covers numbered, promoted, disambiguated, castling and mate SAN forms', () => {
  const examples = [
    ['19.f5! to follow', '19.f5  to follow'],
    ['19...Nf3?! to follow', '19...Nf3   to follow'],
    ['...Bxe6+! to follow', '...Bxe6+  to follow'],
    ['axb8=Q#!! to follow', 'axb8=Q#   to follow'],
    ['R1e2?? to follow', 'R1e2   to follow'],
    ['O-O!? to follow', 'O-O   to follow'],
    ['0-0-0?! to follow', '0-0-0   to follow'],
    ['Qh7++! to follow', 'Qh7++  to follow'],
  ];
  for (const [comment, expected] of examples) {
    assert.equal(writingTextForLint(comment), expected);
  }
});

test('preserves UTF-16 lint offsets when SAN follows Unicode prose', () => {
  const comment = 'Sharp ♟ idea: “f5!” to follow.';
  const masked = writingTextForLint(comment);
  assert.equal(masked.length, comment.length);
  assert.equal(masked.indexOf('to follow'), comment.indexOf('to follow'));
  assert.equal(masked, 'Sharp ♟ idea: “f5 ” to follow.');
});

test('normalises and validates user-ignored names without ignoring arbitrary punctuation', () => {
  assert.equal(normaliseIgnoredWord(' Kilkenny '), 'kilkenny');
  assert.equal(canIgnoreWord('Weidenhagen'), true);
  assert.equal(canIgnoreWord('faint-hearted'), true);
  assert.equal(canIgnoreWord('...Be7'), false);
});
