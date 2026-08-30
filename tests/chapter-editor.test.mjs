import test from "node:test";
import assert from "node:assert/strict";
import {
  addBoundary, defaultChapters, manifestFor, moveBoundary, removeChapter, validateChapters,
} from "../app/static/chapter-editor.mjs";

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
