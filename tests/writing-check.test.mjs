import assert from 'node:assert/strict';
import test from 'node:test';

import { checkWriting } from '../app/static/writing-check.js';

function source(comment) {
  return [{ sourceId: 'comment-1', history: '19. O-O', comment }];
}

test('does not treat an annotated SAN move as the end of a sentence', async () => {
  const issues = await checkWriting(source('White is better now with ideas like f5! to follow.'));
  assert.equal(issues.some(issue => issue.kind === 'Capitalization' && issue.problem === 'to'), false);
});

test('does not treat move-number-prefixed annotated SAN as sentence punctuation', async () => {
  for (const comment of [
    'White is better after 19.f5! to follow.',
    'White is better after 19...f5! to follow.',
    'White is better after ...f5! to follow.',
  ]) {
    const issues = await checkWriting(source(comment));
    assert.equal(issues.some(issue => issue.kind === 'Capitalization' && issue.problem === 'to'), false);
  }
});

test('still treats an ordinary prose exclamation mark as sentence punctuation', async () => {
  const issues = await checkWriting(source('Excellent! to follow.'));
  assert.equal(issues.some(issue => issue.kind === 'Capitalization' && issue.problem === 'to'), true);
});
