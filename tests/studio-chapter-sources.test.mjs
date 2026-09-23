import assert from 'node:assert/strict';
import test from 'node:test';
import { newChapterCourse, addIndependentChapter, activateChapter, syncActiveChapter, chapterDocument, chapterPGNHeaders, trainingPack, updateNode, documentForStorage, normalizeDocument, validateDocument, serializeForPGN } from '../app/static/studio-document.mjs';
const parsed = { headers: { Event: 'Imported chapter' }, nodes: [
 { id: 1, parent_id: null, ply: 1, uci: 'e2e4', san: 'e4', comment: 'Centre [%hint Original hint]', nags: [1] },
 { id: 2, parent_id: 1, ply: 2, uci: 'e7e5', san: 'e5', comment: '[%csl Ge4]' },
 { id: 3, parent_id: 2, ply: 3, uci: 'g1f3', san: 'Nf3', comment: 'Develop' },
 { id: 4, parent_id: 1, ply: 2, uci: 'c7c5', san: 'c5', starting_comment: 'Sicilian' },
 { id: 5, parent_id: 4, ply: 3, uci: 'g1f3', san: 'Nf3', comment: 'Other branch' },
] };
const course = () => addIndependentChapter(addIndependentChapter(newChapterCourse({ title: 'Course', slug: 'course', side: 'white' }), parsed, 'First', 'first'), parsed, 'Second', 'second');
test('edits are chapter-owned even when imported node IDs and board positions repeat', () => {
 let document = course();
 document = updateNode(document, '1', { hint: 'Second hint' });
 document = activateChapter(document, 'first');
 assert.equal(document.nodes[0].hint, 'Original hint');
 document = activateChapter(document, 'second');
 assert.equal(document.nodes[0].hint, 'Second hint');
 const positions = trainingPack(document).positions;
 assert.equal(new Set(positions.map(p => p.id)).size, positions.length);
 assert.deepEqual(positions.filter(p => p.ply === 1).map(p => p.hint), ['Original hint', 'Second hint']);
});
test('training marker filters exercises without deleting history, hints, NAGs or branches', () => {
 let document = course(); document.trainingStartPath = ['e2e4', 'e7e5'];
 const chapter = syncActiveChapter(document).chapterSources[1];
 assert.equal(trainingPack(chapterDocument(document, chapter)).positions.length, 1);
 assert.equal(chapter.nodes.length, 5);
 assert.deepEqual(serializeForPGN(chapterDocument(document, chapter))[0].nags, [1]);
 assert.match(serializeForPGN(chapterDocument(document, chapter))[0].comment, /Original hint/);
 assert.equal(chapterPGNHeaders(document, chapter).GingerGMTrainingStart, 'e2e4 e7e5');
 const imported = addIndependentChapter(newChapterCourse(document.metadata), { ...parsed, headers: chapterPGNHeaders(document, chapter) }, 'Reimported', 'new');
 assert.deepEqual(imported.trainingStartPath, document.trainingStartPath);
 assert.equal(trainingPack(imported).positions.length, 1);
});
test('storage sends each source once and normalization preserves source order/identity', () => {
 let document = syncActiveChapter(course());
 document.chapterSources[0].sourcePGN = 'FIRST PGN'; document.sourcePGN = 'SECOND PGN';
 const stored = documentForStorage(document, 'ignored projection');
 assert.equal(stored.sourcePGN, ''); assert.deepEqual(stored.nodes, []);
 assert.equal(stored.chapterSources[0].sourcePGN, 'FIRST PGN'); assert.equal(stored.chapterSources[1].sourcePGN, 'SECOND PGN');
 assert.equal(stored.chapterSources[0].nodes, undefined);
 assert.deepEqual(normalizeDocument(stored).chapterSources.map(c => c.id), ['first', 'second']);
});
test('blank and stale training-start chapters cannot pass local publish checks', () => {
 const blank = newChapterCourse({ title: 'Course', slug: 'course', side: 'white' });
 assert.equal(validateDocument(blank).blockers.length, 1);
 const document = course(); document.trainingStartPath = ['d2d4'];
 assert.ok(validateDocument(document).blockers.some(b => b.message.includes('No training positions')));
});

test('chapter staging association survives save and cannot be mistaken for ready video', () => {
 const document = course();
 document.chapterSources[1].videoUploadID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const stored = documentForStorage(document);
 assert.equal(stored.chapterSources[1].videoUploadID, document.chapterSources[1].videoUploadID);
 assert.ok(validateDocument(document).blockers.some(b => /not ready/.test(b.message)));
});
