import test from "node:test";
import assert from "node:assert/strict";
import {
  addBoundary, defaultChapters, manifestFor, moveBoundary, removeChapter, validateChapters,
} from "../app/static/chapter-editor.mjs";
import { deleteIndependentChapter, documentForStorage, duplicateIndependentChapter, normalizeDocument } from "../app/static/studio-document.mjs";

const pack = {
  id: "test-course",
  positions: Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, learningOrder: index })),
};

test("balanced chapters preserve every position in learning order", () => {
  const chapters = defaultChapters(pack, 4);
  assert.deepEqual(chapters.map(chapter => chapter.positionIDs.length), [3, 4, 3]);
  assert.deepEqual(validateChapters(pack, chapters), []);
});

test("boundaries move without emptying adjacent chapters", () => {
  const chapters = defaultChapters(pack, 4);
  const moved = moveBoundary(pack, chapters, 1, 1);
  assert.deepEqual(moved.map(chapter => chapter.positionIDs.length), [1, 6, 3]);
  assert.deepEqual(validateChapters(pack, moved), []);
});

test("chapters can be added and removed with stable existing IDs", () => {
  const initial = [{ id: "test-course-main", title: "Main", positionIDs: pack.positions.map(p => p.id) }];
  const added = addBoundary(pack, initial, 4);
  assert.equal(added[0].id, "test-course-main");
  assert.deepEqual(added.map(chapter => chapter.positionIDs.length), [4, 6]);
  assert.deepEqual(removeChapter(pack, added, 1), initial);
});

test("manifest validation rejects missing and reordered positions", () => {
  const good = defaultChapters(pack, 5);
  assert.equal(manifestFor(pack, good).packID, "test-course");
  good[0].positionIDs.reverse();
  assert.match(validateChapters(pack, good)[0], /exactly once in learning order/);
});

test("duplicated independent chapter has a fresh identity and no private video binding", () => {
  const document = { metadata: {}, activeChapterID: "chapter-a", nodes: [{ id: "a", hint: "Keep pressure" }], headers: { Event: "Main" }, sourcePGN: "1. e4", trainingStartPath: ["e2e4"], chapterSources: [
    { id: "chapter-a", title: "Main line", nodes: [{ id: "a", hint: "Keep pressure" }], headers: { Event: "Main" }, sourcePGN: "1. e4", trainingStartPath: ["e2e4"], video: { id: "private-video" }, videoUploadID: "upload-a" },
    { id: "chapter-b", title: "Side line", nodes: [], headers: {}, sourcePGN: "", trainingStartPath: [] },
  ] };
  const copied = duplicateIndependentChapter(document, "chapter-a", "chapter-copy");
  assert.equal(copied.activeChapterID, "chapter-copy");
  assert.deepEqual(copied.chapterSources.map(chapter => chapter.id), ["chapter-a", "chapter-copy", "chapter-b"]);
  assert.equal(copied.chapterSources[1].title, "Copy of Main line");
  assert.deepEqual(copied.chapterSources[1].nodes, [{ id: "a", hint: "Keep pressure" }]);
  assert.deepEqual(copied.chapterSources[1].headers, { Event: "Main" });
  assert.equal(copied.chapterSources[1].sourcePGN, "1. e4");
  assert.deepEqual(copied.chapterSources[1].trainingStartPath, ["e2e4"]);
  assert.equal(copied.chapterSources[1].video, undefined);
  assert.equal(copied.chapterSources[1].videoUploadID, undefined);
  const reloaded = normalizeDocument(JSON.parse(JSON.stringify(documentForStorage(copied))));
  assert.equal(reloaded.chapterSources[1].title, "Copy of Main line");
  assert.equal(reloaded.chapterSources[1].sourcePGN, "1. e4");
  assert.equal(reloaded.chapterSources[1].video, undefined);
  copied.chapterSources[1].nodes[0].hint = "Changed copy";
  assert.equal(copied.chapterSources[0].nodes[0].hint, "Keep pressure");
});

test("deleting an independent chapter selects safely and keeps the final chapter safe", () => {
  const document = { metadata: {}, activeChapterID: "chapter-c", nodes: [], headers: {}, sourcePGN: "", trainingStartPath: [], chapterSources: [
    { id: "chapter-a", title: "A", nodes: [], headers: {}, sourcePGN: "", trainingStartPath: [] },
    { id: "chapter-b", title: "B", nodes: [], headers: {}, sourcePGN: "", trainingStartPath: [] },
    { id: "chapter-c", title: "C", nodes: [], headers: {}, sourcePGN: "", trainingStartPath: [] },
  ] };
  const deleted = deleteIndependentChapter(document, "chapter-b");
  assert.deepEqual(deleted.chapterSources.map(chapter => chapter.id), ["chapter-a", "chapter-c"]);
  assert.equal(deleted.activeChapterID, "chapter-c");
  const final = deleteIndependentChapter(deleted, "chapter-c");
  assert.equal(final.activeChapterID, "chapter-a");
  assert.throws(() => deleteIndependentChapter(final, "chapter-a"), /at least one chapter/);
});
