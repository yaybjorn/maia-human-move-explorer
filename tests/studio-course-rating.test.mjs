import test from "node:test";
import assert from "node:assert/strict";
import { courseOpponentRating, newCourseDocument, normalizeDocument, documentForStorage } from "../app/static/studio-document.mjs";

test("course rating survives storage and reload; switching courses does not leak", () => {
  const first = newCourseDocument({ title: "First", opponentRating: 2300 });
  const stored = documentForStorage(first, "");
  const reloaded = normalizeDocument(JSON.parse(JSON.stringify(stored)));
  const second = normalizeDocument({ metadata: { title: "Legacy" } });
  assert.equal(courseOpponentRating(reloaded), 2300);
  assert.equal(courseOpponentRating(second), 1500);
  assert.equal(courseOpponentRating(reloaded), 2300);
  assert.throws(() => courseOpponentRating({ metadata: { opponentRating: 3001 } }), /400 to 3000/);
});
