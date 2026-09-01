import assert from 'node:assert/strict';
import test from 'node:test';

import { checkWriting, writingSuggestionLabel } from '../app/static/writing-check.js';

function source(comment, sourceId = 'comment-1') {
  return [{ sourceId, history: '19. O-O', comment }];
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

test('ignores template placeholders while linting surrounding prose at original offsets', async () => {
  const fallbackIssues = await checkWriting(source(
    'The repertoire move is {san}.',
    'metadata:fallbackFeedback'
  ));
  assert.equal(fallbackIssues.some(issue => issue.problem === 'san'), false);

  const comment = 'Use {san}, then misspeled prose.';
  const issues = await checkWriting(source(comment, 'metadata:fallbackFeedback'));

  assert.equal(issues.some(issue => issue.problem === 'san'), false);
  const spelling = issues.find(issue => issue.problem === 'misspeled');
  assert.ok(spelling);
  assert.equal(spelling.start, comment.indexOf('misspeled'));
  assert.equal(spelling.end, comment.indexOf('misspeled') + 'misspeled'.length);
});

test('does not ignore placeholders outside fallback feedback or arbitrary braced prose', async () => {
  const commentIssues = await checkWriting(source('The repertoire move is {san}.'));
  assert.equal(commentIssues.some(issue => issue.problem === 'san'), true);

  const fallbackIssues = await checkWriting(source(
    'Use {correctMove} and {this is misspeled}.',
    'metadata:fallbackFeedback'
  ));
  assert.equal(fallbackIssues.some(issue => issue.problem === 'correctMove'), true);
  assert.equal(fallbackIssues.some(issue => issue.problem === 'misspeled'), true);
});

test('offers a one-click missing-space correction for initials attached to surnames', async () => {
  const comment = 'Was played in J.Christiansen vs S.Tifferet.';
  const issues = await checkWriting(source(comment));

  for (const initial of ['J.', 'S.']) {
    const issue = issues.find(candidate => candidate.problem === initial);
    assert.ok(issue);
    assert.equal(issue.suggestions[0], `${initial} `);
    const fixed = comment.slice(0, issue.start) + issue.suggestions[0] + comment.slice(issue.end);
    assert.equal(fixed.includes(`${initial}${initial === 'J.' ? 'Christiansen' : 'Tifferet'}`), false);
    assert.equal(fixed.includes(`${initial} ${initial === 'J.' ? 'Christiansen' : 'Tifferet'}`), true);
    assert.equal(writingSuggestionLabel(issue.problem, issue.suggestions[0]), 'Add space');
  }
});

test('accepts spaced initials while leaving unknown surnames available for the dictionary', async () => {
  const issues = await checkWriting(source('Was played in J. Christiansen vs S. Tifferet.'));
  assert.equal(issues.some(issue => issue.problem === 'J.' || issue.problem === 'S.'), false);
  assert.equal(issues.some(issue => issue.problem === 'Christiansen'), true);
  assert.equal(issues.some(issue => issue.problem === 'Tifferet'), true);
});

test('preserves commas when applying Harper missing-space suggestions', async () => {
  const comment = 'Yoo,C (2599)-Niemann,H (2688).';
  const issues = await checkWriting(source(comment));
  const commaIssues = issues.filter(issue => issue.kind === 'Punctuation' && issue.problem === ',');
  assert.equal(commaIssues.length, 2);

  for (const issue of commaIssues) {
    assert.equal(issue.suggestions[0], ', ');
    assert.equal(writingSuggestionLabel(issue.problem, issue.suggestions[0]), 'Add space');
    const fixed = comment.slice(0, issue.start) + issue.suggestions[0] + comment.slice(issue.end);
    assert.equal(fixed.slice(issue.start, issue.start + 2), ', ');
  }
});
