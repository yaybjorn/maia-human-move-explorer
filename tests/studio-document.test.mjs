import assert from "node:assert/strict";
import test from "node:test";

import {
  addMove, chapterSlices, childrenOf, importParsedPGN, movesToNode, normalizeDocument,
  promoteVariation, removeBranch, reorderVariation, serializeForPGN, trainingPack,
  updateNode, validateDocument,
} from "../app/static/studio-document.mjs";

const parsed = {
  headers: { Event: "Test course" },
  nodes: [
    { id: 1, parent_id: null, uci: "e2e4", san: "e4", ply: 1, comment: "Main idea.", nags: [1] },
    { id: 2, parent_id: 1, uci: "c7c5", san: "c5", ply: 2, starting_comment: "The Sicilian", comment: "[%csl Gd4]" },
    { id: 3, parent_id: 1, uci: "e7e5", san: "e5", ply: 2, comment: "Alternative." },
    { id: 4, parent_id: 2, uci: "g1f3", san: "Nf3", ply: 3 },
  ],
};

test("normalises imported nested variations and preserves authored semantics", () => {
  const document = importParsedPGN(parsed, { title: "Test", slug: "test", side: "white" });
  assert.deepEqual(childrenOf(document, "1").map(node => node.san), ["c5", "e5"]);
  assert.deepEqual(movesToNode(document, "4"), ["e2e4", "c7c5", "g1f3"]);
  assert.equal(document.nodes[1].startingComment, "The Sicilian");
  assert.equal(document.nodes[1].comment, "[%csl Gd4]");
  assert.deepEqual(serializeForPGN(document)[0].nags, [1]);
});

test("supports add, delete, reorder, promote, comments and undo-safe immutable changes", () => {
  const original = importParsedPGN(parsed, { title: "Test", slug: "test", side: "white" });
  const promoted = promoteVariation(original, "3");
  assert.deepEqual(childrenOf(promoted, "1").map(node => node.san), ["e5", "c5"]);
  assert.deepEqual(childrenOf(reorderVariation(promoted, "3", 1), "1").map(node => node.san), ["c5", "e5"]);
  const edited = updateNode(original, "1", { comment: "Changed." });
  assert.equal(original.nodes[0].comment, "Main idea.");
  assert.equal(edited.nodes[0].comment, "Changed.");
  const added = addMove(original, "4", { uci: "b8c6", san: "Nc6" });
  assert.equal(added.created, true);
  assert.deepEqual(movesToNode(added.document, added.node.id), ["e2e4", "c7c5", "g1f3", "b8c6"]);
  assert.equal(removeBranch(original, "2").nodes.some(node => node.id === "4"), false);
});

test("chapter drafts never masquerade as compiled position IDs", () => {
  const document = importParsedPGN(parsed, { title: "Test", slug: "test", side: "white" });
  document.chapterDrafts = [{ id: "intro", title: "Introduction", startNodeID: null }];
  const pack = trainingPack(document, "test");
  assert.deepEqual(pack.positions.map(position => position.id), ["start", "2"]);
  assert.equal(chapterSlices(document, "test")[0].positions.length, 2);
  assert.deepEqual(document.chapters, []);
  assert.equal(JSON.stringify(document.chapters).includes("start"), false);
});

test("validation separates blockers and advisory warnings", () => {
  const invalid = normalizeDocument({ metadata: { title: "", slug: "Bad slug" } });
  assert.ok(validateDocument(invalid).blockers.length >= 3);
  const document = importParsedPGN(parsed, { title: "Test", slug: "test", side: "white" });
  assert.ok(validateDocument(document).warnings.some(item => item.area === "Chapters"));
});
