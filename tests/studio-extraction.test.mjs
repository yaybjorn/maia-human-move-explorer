import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtractionPanel, extractionSources, extractionRange, extractionSourceStart, extractionRangeLabel, extractionTimestamp, extractionSeekURL, extractionReviewAllowed, placementSquares, ExtractionScope } from '../app/static/studio-extraction.mjs';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const SOURCE = 'https://www.youtube.com/watch?v=8y9gWaB8zk4&t=90';

test('main and ordered supplemental sources remain distinct and do not mutate metadata', () => {
  const metadata = { courseVideo: { id: 'main', title: 'Main', youtubeURL: SOURCE }, videos: [{ id: 'extra', title: 'Extra', youtubeURL: SOURCE }] };
  const before = structuredClone(metadata);
  assert.deepEqual(extractionSources(metadata).map(source => [source.videoRole, source.attachmentID]), [['main', 'main'], ['supplemental', 'extra']]);
  assert.deepEqual(metadata, before);
  assert.deepEqual(extractionSources({ courseVideo: null }), []);
});

test('placement preview uses exactly 64 squares and respects flipped orientation without inventing game state', () => {
  const white = placementSquares(FEN), black = placementSquares(FEN, 'black');
  assert.equal(white.length, 64); assert.equal(white[0], 'r'); assert.equal(white[60], 'K');
  assert.deepEqual(black, [...white].reverse());
  assert.deepEqual(placementSquares(FEN, 'normal'), white);
  assert.deepEqual(placementSquares(FEN, 'flipped'), black);
  for (const invalid of [null, '', `${FEN} w KQkq - 0 1`, '9/8/8/8/8/8/8/8', '7/8/8/8/8/8/8/8', '<img>/8/8/8/8/8/8/8']) assert.equal(placementSquares(invalid), null);
  assert.equal(placementSquares(FEN, 'unknown'), null);
});

test('seeks with absolute seconds rather than retaining the source timestamp', () => {
  assert.equal(new URL(extractionSeekURL(SOURCE, 1202)).searchParams.get('start'), '1202');
  assert.equal(new URL(extractionSeekURL(SOURCE, 0)).searchParams.get('start'), '0');
  assert.equal(extractionTimestamp(7236), '2:00:36');
  assert.equal(extractionTimestamp(607), '10:07');
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.example/watch?v=8y9gWaB8zk4', 'https://user:password@youtube.com/watch?v=8y9gWaB8zk4']) assert.throws(() => extractionSeekURL(url, 0));
});

test('review fails closed for dirty, stale, wrong-revision and incomplete jobs', () => {
  const context = { courseID: 'course-a', revision: 5, dirty: false };
  const job = { status: 'completed', revision: 5, stale: false };
  assert.equal(extractionReviewAllowed(context, job), true);
  assert.equal(extractionReviewAllowed({ ...context, dirty: true }, job), false);
  assert.equal(extractionReviewAllowed(context, { ...job, stale: true }), false);
  assert.equal(extractionReviewAllowed(context, { ...job, revision: 4 }), false);
  assert.equal(extractionReviewAllowed(context, { ...job, status: 'running' }), false);
  assert.equal(extractionReviewAllowed(null, job), false);
});

test('course switches, revisions, suspension and reopening invalidate in-flight responses', () => {
  let context = { courseID: 'a', revision: 1 };
  const scope = new ExtractionScope(() => context), first = scope.open();
  assert.equal(scope.current(first), true);
  context = { courseID: 'b', revision: 1 }; assert.equal(scope.current(first), false);
  context = { courseID: 'a', revision: 2 }; assert.equal(scope.current(first), false);
  const second = scope.open(); scope.close(); assert.equal(scope.current(second), false);
  scope.open(); assert.equal(scope.current(second), false);
});

// Small DOM harness exercises the real panel's API boundaries without adding a
// runtime dependency. Browser rendering/keyboard/mobile evidence is separate.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.textContent = ''; this.className = ''; this.disabled = false; this.hidden = false; this.attributes = {}; this.classList = { toggle: () => {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  scrollIntoView() {}
}
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) { const result = find(child, predicate); if (result) return result; }
  return null;
}
function all(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
}
function harness(request, initial = {}) {
  const root = new Element('div'); root.id = 'studio-extraction';
  globalThis.document = { hidden: false, createElement: tag => new Element(tag), getElementById: id => find(root, node => node.id === id), addEventListener: () => {} };
  let context = { courseID: 'course-a', revision: 5, dirty: false, metadata: {}, ...initial };
  const calls = [];
  const panel = createExtractionPanel({ api: { base: '/studio/api', request: async (path, options = {}) => { calls.push({ path, options }); return request(path, options); } }, getContext: () => context });
  return { root, panel, calls, context: value => { context = value; }, byID: id => find(root, node => node.id === id), button: text => find(root, node => node.tagName === 'button' && node.textContent === text) };
}
const job = (id, overrides = {}) => ({ id, revision: 5, status: 'completed', phase: 'complete', source: { title: 'Reference video', youtubeURL: SOURCE }, stale: false, reviewRevision: 0, ...overrides });
const row = { id: 'segment-0', timestamp_seconds: 1202, fen: FEN, orientation: 'white', observations: 2, flags: ['popup_occlusion'], decision: 'unreviewed' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('dirty draft does not submit an extraction; external source uses revision and idempotency key', async () => {
  const h = harness(async (path, options) => options.method === 'POST' ? { job: job('new') } : path.endsWith('/new') ? { job: job('new') } : path.includes('/results?') ? { rows: [], total: 0 } : { jobs: [] }, { dirty: true });
  await h.panel.refresh();
  h.byID('extraction-url').value = SOURCE;
  assert.equal(h.byID('extraction-start').disabled, true);
  await h.byID('extraction-start').listeners.click();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  h.context({ courseID: 'course-a', revision: 5, dirty: false, metadata: {} }); await h.panel.refresh();
  h.byID('extraction-source').value = 'external'; h.byID('extraction-url').value = SOURCE;
  h.byID('extraction-url').listeners.input(); h.byID('extraction-range-end').value = '139';
  await h.byID('extraction-start').listeners.click();
  const submission = h.calls.find(call => call.options.method === 'POST');
  assert.equal(submission.options.body.revision, 5);
  assert.deepEqual(submission.options.body.source, { youtubeURL: SOURCE, videoRole: 'external', range: { startSeconds: 90, endSeconds: 139 } });
  assert.match(submission.options.body.requestID, /^[a-f0-9-]{36}$/);
  assert.equal(h.calls.some(call => /publish|draft|pgn/.test(call.path)), false);
  h.panel.clear();
});

test('late course-A listing cannot replace course-B jobs', async () => {
  let releaseA;
  const h = harness(path => path.startsWith('/courses/course-a/') ? new Promise(resolve => { releaseA = resolve; }) : { jobs: [job('b', { source: { title: 'B only' } })] });
  const old = h.panel.refresh();
  h.context({ courseID: 'course-b', revision: 5, dirty: false, metadata: {} }); await h.panel.refresh();
  releaseA({ jobs: [job('a', { source: { title: 'A stale' } })] }); await old;
  assert.ok(h.button('B only · completed'));
  assert.equal(h.button('A stale · completed'), null);
  h.panel.clear();
});

test('completed results keep uncertainty, use authenticated CSV links, and save only review decisions', async () => {
  let selected = job('existing');
  const h = harness((path, options) => {
    if (options.method === 'POST') { selected = { ...selected, reviewRevision: 1 }; return { job: selected }; }
    if (path.includes('/results?')) return { rows: [row], total: 1 };
    if (path.endsWith('/existing')) return { job: selected };
    return { jobs: [selected] };
  });
  await h.panel.refresh(); await h.button('Reference video · completed').listeners.click();
  assert.ok(find(h.root, node => node.textContent.includes('popup occlusion')));
  const downloads = all(h.root, node => node.tagName === 'a');
  assert.equal(downloads.length, 5);
  assert.ok(downloads.slice(0, 4).every(link => link.href.startsWith('/studio/api/courses/course-a/extractions/existing/download?kind=')));
  assert.equal(downloads[4].href, '/studio/api/courses/course-a/extractions/existing/evidence');
  const review = all(h.root, node => node.tagName === 'select').find(node => node !== h.byID('extraction-source'));
  review.value = 'accepted'; await review.listeners.change(); await tick();
  const call = h.calls.find(call => call.options.method === 'POST');
  assert.equal(call.path, '/courses/course-a/extractions/existing/review');
  assert.deepEqual(call.options.body, { revision: 5, reviewRevision: 0, decisions: [{ rowID: 'segment-0', decision: 'accepted' }] });
  assert.equal(h.calls.some(call => /publish|draft|pgn/.test(call.path)), false);
  h.panel.clear();
});

test('raw multiple boards preserve evidence with no review control or invented placement preview', async () => {
  const h = harness(path => path.includes('/results?') ? { rows: [{ id: 'raw-3952', timestamp_seconds: 3952, fen: null, orientation: 'unknown', flags: ['multiple_boards'], boards: [{ fen: FEN }, { fen: FEN }] }], total: 1 } : path.endsWith('/existing') ? { job: job('existing') } : { jobs: [job('existing')] });
  await h.panel.refresh(); await h.button('Reference video · completed').listeners.click();
  await h.button('Raw observations').listeners.click(); await tick();
  assert.equal(all(h.root, node => node.tagName === 'select').length, 1);
  assert.ok(find(h.root, node => node.textContent === '2 detected boards — raw evidence'));
  await h.button('▶ 1:05:52').listeners.click();
  assert.equal(all(h.root, node => node.className === 'extraction-board').length, 0);
  assert.equal(all(h.root, node => node.tagName === 'iframe').length, 1);
  h.panel.suspend(); assert.equal(all(h.root, node => node.tagName === 'iframe').length, 0);
  h.panel.clear();
});

test('late result from the previously selected job cannot overwrite the reopened job', async () => {
  let release;
  const h = harness(path => path.includes('/first/results?') ? new Promise(resolve => { release = resolve; }) : path.includes('/second/results?') ? { rows: [{ ...row, fen: '8/8/8/8/8/8/8/8' }], total: 1 } : path.endsWith('/first') ? { job: job('first', { source: { title: 'First' } }) } : path.endsWith('/second') ? { job: job('second', { source: { title: 'Second' } }) } : { jobs: [job('first', { source: { title: 'First' } }), job('second', { source: { title: 'Second' } })] });
  await h.panel.refresh(); const first = h.button('First · completed').listeners.click(); await tick();
  await h.button('Second · completed').listeners.click();
  release({ rows: [row], total: 1 }); await first;
  assert.ok(find(h.root, node => node.textContent === '8/8/8/8/8/8/8/8'));
  assert.equal(find(h.root, node => node.tagName === 'code' && node.textContent === FEN), null);
  h.panel.clear();
});

test('an uncertain submit retry reuses its request ID and suspended panels cannot mutate', async () => {
  const h = harness((path, options) => {
    if (options.method === 'POST') throw new Error('Network unavailable');
    return { jobs: [] };
  });
  await h.panel.refresh();
  h.byID('extraction-source').value = 'external'; h.byID('extraction-url').value = SOURCE;
  h.byID('extraction-url').listeners.input(); h.byID('extraction-range-end').value = '139';
  await h.byID('extraction-start').listeners.click();
  await h.byID('extraction-start').listeners.click();
  const mutations = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].options.body.requestID, mutations[1].options.body.requestID);
  h.panel.suspend(); await h.byID('extraction-start').listeners.click();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 2);
  h.panel.clear();
});


test('finite explicit ranges reject absent/reversed/nonfinite/out-of-source bounds', () => {
  assert.deepEqual(extractionRange('19.5', '139.25'), { startSeconds: 19.5, endSeconds: 139.25 });
  assert.deepEqual(extractionRange(0, 10800), { startSeconds: 0, endSeconds: 10800 });
  for (const bounds of [[0, ''], ['', 10], [null, 10], [false, 10], [0, true], [-1, 10], [19, 19], [20, 19], [0, Infinity], [NaN, 10], [0, 10800.1]]) assert.throws(() => extractionRange(...bounds));
  assert.match(extractionRangeLabel({ range: { startSeconds: 19, endSeconds: 139 } }), /\[19, 139\).*end excluded/);
  assert.match(extractionRangeLabel({}), /Legacy full video/);
});

test('attached and pasted timestamp anchors prefill only start; source changes clear explicit end', async () => {
  const metadata = { courseVideo: { id: 'main', title: 'Main', youtubeURL: SOURCE }, videos: [{ id: 'game', title: 'Game', youtubeURL: 'https://youtu.be/hPM32iF75Pk?t=19' }] };
  const before = structuredClone(metadata);
  const h = harness(() => ({ jobs: [] }), { metadata });
  await h.panel.refresh();
  assert.equal(h.byID('extraction-range-start').value, '90');
  assert.equal(h.byID('extraction-range-end').value, '');
  h.byID('extraction-range-end').value = '139';
  h.panel.contextChanged();
  assert.equal(h.byID('extraction-range-end').value, '139');
  h.byID('extraction-source').value = '1'; h.byID('extraction-source').listeners.change();
  assert.equal(h.byID('extraction-range-start').value, '19');
  assert.equal(h.byID('extraction-range-end').value, '');
  h.byID('extraction-source').value = 'external'; h.byID('extraction-source').listeners.change();
  h.byID('extraction-url').value = 'https://youtu.be/hPM32iF75Pk#t=1m12s'; h.byID('extraction-url').listeners.input();
  assert.equal(h.byID('extraction-range-start').value, '72');
  assert.equal(h.byID('extraction-range-end').value, '');
  assert.equal(extractionSourceStart('https://youtube.com/watch?v=hPM32iF75Pk&start=19'), 19);
  assert.deepEqual(metadata, before);
  h.panel.clear();
});

test('missing end cannot submit; changed range gets a distinct idempotency key without course writes', async () => {
  const h = harness((path, options) => { if (options.method === 'POST') throw new Error('Network unavailable'); return { jobs: [] }; });
  await h.panel.refresh();
  h.byID('extraction-url').value = SOURCE; h.byID('extraction-url').listeners.input();
  await h.byID('extraction-start').listeners.click();
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  assert.ok(find(h.root, node => node.textContent.includes('explicit end')));
  h.byID('extraction-range-end').value = '139';
  await h.byID('extraction-start').listeners.click();
  h.byID('extraction-range-end').value = '140.5';
  await h.byID('extraction-start').listeners.click();
  const posts = h.calls.filter(call => call.options.method === 'POST');
  assert.notEqual(posts[0].options.body.requestID, posts[1].options.body.requestID);
  assert.deepEqual(posts[1].options.body.source.range, { startSeconds: 90, endSeconds: 140.5 });
  assert.ok(posts.every(call => call.path.endsWith('/extractions')));
  h.panel.clear();
});

test('bounded completed jobs show immutable excerpt bounds and use absolute seek without adding start again', async () => {
  const selected = job('bounded', { source: { title: 'Excerpt', youtubeURL: SOURCE, range: { startSeconds: 19, endSeconds: 139 } } });
  const h = harness(path => path.includes('/results?') ? { rows: [{ ...row, timestamp_seconds: 90 }], total: 1 } : path.endsWith('/bounded') ? { job: selected } : { jobs: [selected] });
  await h.panel.refresh(); await h.button('Excerpt · completed').listeners.click();
  assert.ok(find(h.root, node => node.textContent.includes('[19, 139) seconds')));
  assert.ok(find(h.root, node => node.textContent.includes('not a verified full game')));
  await h.button('▶ 1:30').listeners.click();
  const iframe = find(h.root, node => node.tagName === 'iframe');
  assert.equal(new URL(iframe.src).searchParams.get('start'), '90');
  h.panel.clear();
});
