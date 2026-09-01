import assert from "node:assert/strict";
import test from "node:test";

import {
  addMove, chapterSlices, childrenOf, importParsedPGN, movesToNode, normalizeDocument,
  commentWithHint,
  documentForStorage, evaluatePreviewMove, hydrateRestoredDocument, pgnHasMoves, promoteVariation, removeBranch,
  reorderVariation, serializeForPGN, splitHintDirective, trainingPack, updateNode, validateDocument,
} from "../app/static/studio-document.mjs";

test("recognises a header-only PGN as an editable blank course", () => {
  const blank = `[Event "Blank course"]\n[Result "*"]\n\n*\n`;
  assert.equal(pgnHasMoves(blank), false);
  assert.equal(pgnHasMoves(`${blank}1. e4 e5 *`), true);
});

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
  assert.equal(document.metadata.fallbackFeedback, "The repertoire move is {san}.");
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

test("training traversal matches compiler semantics for learner wrong lines", () => {
  const document = normalizeDocument({
    metadata: { title: "Parity", slug: "parity", side: "white" },
    nodes: [
      { id: "correct", parentId: null, uci: "e2e4", san: "e4", ply: 1, comment: "Correct." },
      { id: "opponent", parentId: "correct", uci: "c7c5", san: "c5", ply: 2 },
      { id: "next", parentId: "opponent", uci: "g1f3", san: "Nf3", ply: 3, comment: "Develop." },
      { id: "wrong", parentId: null, uci: "d2d4", san: "d4", ply: 1, comment: "Too soon." },
      { id: "wrong-reply", parentId: "wrong", uci: "d7d5", san: "d5", ply: 2 },
      { id: "must-not-train", parentId: "wrong-reply", uci: "c2c4", san: "c4", ply: 3 },
    ],
  });
  const positions = trainingPack(document, "parity").positions;
  assert.deepEqual(positions.map(position => position.id), ["start", "opponent"]);
  assert.deepEqual(positions[0].wrongMoves, [{ san: "d4", uci: "d2d4", feedback: "Too soon." }]);
});

test("training traversal defers opponent branches in compiler sequence order", () => {
  const document = normalizeDocument({
    metadata: { title: "Order", slug: "order", side: "white" },
    nodes: [
      { id: "e4", parentId: null, uci: "e2e4", san: "e4", ply: 1 },
      { id: "c5", parentId: "e4", uci: "c7c5", san: "c5", ply: 2 },
      { id: "e5", parentId: "e4", uci: "e7e5", san: "e5", ply: 2 },
      { id: "nf3", parentId: "c5", uci: "g1f3", san: "Nf3", ply: 3 },
      { id: "nc6", parentId: "nf3", uci: "b8c6", san: "Nc6", ply: 4 },
      { id: "d6", parentId: "nf3", uci: "d7d6", san: "d6", ply: 4 },
      { id: "bb5", parentId: "nc6", uci: "f1b5", san: "Bb5", ply: 5 },
      { id: "alt-e5", parentId: "e5", uci: "g1f3", san: "Nf3", ply: 3 },
      { id: "alt-d6", parentId: "d6", uci: "d2d4", san: "d4", ply: 5 },
    ],
  });
  assert.deepEqual(trainingPack(document, "order").positions.map(position => position.id), [
    "start", "c5", "nc6", "e5", "d6",
  ]);
});

test("structural edits clear compiled chapter ids but preserve authored chapter drafts", () => {
  const document = importParsedPGN(parsed, { title: "Test", slug: "test", side: "white" });
  document.chapterDrafts = [{ id: "intro", title: "Introduction", startNodeID: null }];
  document.chapters = [{ id: "intro", title: "Introduction", positionIDs: ["sha256:old"] }];
  const result = addMove(document, "4", { uci: "b8c6", san: "Nc6" });
  assert.deepEqual(result.document.chapters, []);
  assert.equal(result.document.chapterDrafts[0].title, "Introduction");
});

test("source-only restores hydrate safely and storage payload does not duplicate move nodes", () => {
  const saved = normalizeDocument({
    metadata: { title: "Restored", slug: "restored", side: "white" },
    sourcePGN: "1. e4 c5 *",
    chapters: [{ id: "intro", title: "Intro", positionIDs: ["sha256:one"] }],
    chapterDrafts: [
      { id: "intro", title: "Intro", startNodeID: null, startIndex: 0, startPath: [] },
      { id: "branch", title: "Branch", startNodeID: "old-node-id", startIndex: 1, startPath: ["e2e4", "c7c5"] },
    ],
    ignoredWords: ["Kilkenny"],
  });
  const hydrated = hydrateRestoredDocument(parsed, saved);
  assert.equal(hydrated.nodes.length, 4);
  assert.equal(hydrated.ignoredWords, undefined);
  assert.equal(hydrated.chapterDrafts[1].startNodeID, "2");
  const stored = documentForStorage(hydrated, saved.sourcePGN);
  assert.deepEqual(stored.nodes, []);
  assert.equal(stored.sourcePGN, "1. e4 c5 *");
  assert.deepEqual(stored.chapterDrafts[1].startPath, ["e2e4", "c7c5"]);
  assert.equal(stored.chapterDrafts[1].startIndex, 1);
  assert.equal(stored.ignoredWords, undefined);
});

test("authored chapter boundaries may start at any training position", () => {
  const document = normalizeDocument({
    metadata: { title: "Boundaries", slug: "boundaries", side: "white" },
    nodes: [
      { id: "a", parentId: null, uci: "e2e4", san: "e4", ply: 1 },
      { id: "b", parentId: "a", uci: "e7e5", san: "e5", ply: 2 },
      { id: "c", parentId: "b", uci: "g1f3", san: "Nf3", ply: 3 },
      { id: "d", parentId: "c", uci: "b8c6", san: "Nc6", ply: 4 },
      { id: "e", parentId: "d", uci: "f1b5", san: "Bb5", ply: 5 },
    ],
    chapterDrafts: [
      { id: "one", title: "One", startNodeID: null },
      { id: "two", title: "Two", startNodeID: "b" },
      { id: "three", title: "Three", startNodeID: "d" },
    ],
  });
  assert.deepEqual(chapterSlices(document, "boundaries").map(chapter => chapter.positions.length), [1, 1, 1]);
});

test("learner preview hides answers until evaluating a move and uses authored wrong feedback", () => {
  const position = {
    correctMove: { uci: "e2e4", san: "e4", feedback: "Take the centre." },
    wrongMoves: [{ uci: "d2d4", san: "d4", feedback: "That belongs to another course." }],
  };
  assert.deepEqual(evaluatePreviewMove(position, { uci: "d2d4", san: "d4" }, "Play {san}."), {
    correct: false, move: { uci: "d2d4", san: "d4" }, feedback: "That belongs to another course.",
  });
  assert.equal(evaluatePreviewMove(position, { uci: "c2c4", san: "c4" }, "Play {san}.").feedback, "Play e4.");
  assert.equal(evaluatePreviewMove(position, { uci: "e2e4", san: "e4" }, "Play {san}.").correct, true);
});

test("imports, edits, clears, previews, and exports optional learner hints", () => {
  const hinted = importParsedPGN({
    headers: { Event: "Hints" },
    nodes: [
      { id: 1, parent_id: null, uci: "e2e4", san: "e4", ply: 1,
        comment: "Take the centre. [%hint Try a developing move.]" },
    ],
  }, { title: "Hints", slug: "hints", side: "white" });

  assert.equal(hinted.nodes[0].comment, "Take the centre.");
  assert.equal(hinted.nodes[0].hint, "Try a developing move.");
  assert.equal(trainingPack(hinted, "hints").positions[0].hint, "Try a developing move.");
  assert.equal(serializeForPGN(hinted)[0].comment, "Take the centre. [%hint Try a developing move.]" );
  assert.deepEqual(
    evaluatePreviewMove(trainingPack(hinted, "hints").positions[0], { uci: "d2d4", san: "d4" }, "Play {san}."),
    { correct: false, move: { uci: "d2d4", san: "d4" }, hint: "Try a developing move.", feedback: "Play e4." },
  );

  const cleared = updateNode(hinted, "1", { hint: "" });
  assert.equal(serializeForPGN(cleared)[0].comment, "Take the centre.");
  assert.equal(trainingPack(cleared, "hints").positions[0].hint, undefined);
});

test("validates hint directive syntax, placement, length, and plain-text safety", () => {
  assert.deepEqual(splitHintDirective("Main. [%hint  Look for checks. ]"), {
    comment: "Main.", hint: "Look for checks.",
  });
  assert.equal(commentWithHint("Main.", "  Develop a piece. "), "Main. [%hint Develop a piece.]");
  assert.throws(() => splitHintDirective("Main. [%hint Look at [checks]]"), /Malformed/);
  assert.throws(() => commentWithHint("Main.", "x".repeat(241)), /240/);
  assert.throws(() => commentWithHint("Main.", "Look [here]"), /square brackets/);

  const misplaced = normalizeDocument({
    metadata: { title: "Misplaced", slug: "misplaced", side: "white" },
    nodes: [
      { id: "main", parentId: null, uci: "e2e4", san: "e4", ply: 1, comment: "Main." },
      { id: "wrong", parentId: null, uci: "d2d4", san: "d4", ply: 1, comment: "Wrong.", hint: "Not here." },
    ],
  });
  assert.ok(validateDocument(misplaced).blockers.some(item => /correct learner move/.test(item.message)));
});
