const DEFAULT_METADATA = Object.freeze({
  title: "Untitled course",
  subtitle: "",
  description: "",
  side: "white",
  access: "subscriber",
  catalogVisible: true,
  fallbackFeedback: "The repertoire move is {san}.",
  opponentRating: 1500,
  slug: "",
  versionNotes: "",
});

export function newCourseDocument(metadata = {}) {
  return {
    schemaVersion: 1,
    metadata: { ...DEFAULT_METADATA, ...metadata },
    sourcePGN: "",
    headers: {},
    nodes: [],
    chapters: [],
    chapterDrafts: [],
    ignoredSuggestionIDs: [],
  };
}

export function normalizeDocument(input = {}) {
  const metadata = { ...(input.metadata || {}) };
  if (!metadata.side && metadata.repertoireSide) metadata.side = metadata.repertoireSide;
  delete metadata.repertoireSide;
  const document = newCourseDocument(metadata);
  document.schemaVersion = Number(input.schemaVersion || 1);
  document.headers = { ...(input.headers || {}) };
  document.sourcePGN = input.sourcePGN || "";
  document.nodes = (input.nodes || []).map((node, index) => ({
    id: String(node.id ?? `move-${index + 1}`),
    parentId: node.parentId === null || node.parent_id === null || node.parentId === undefined && node.parent_id === undefined
      ? null : String(node.parentId ?? node.parent_id),
    uci: node.uci,
    san: node.san || node.uci,
    ply: Number(node.ply || 1),
    comment: node.comment || "",
    startingComment: node.startingComment || node.starting_comment || "",
    nags: [...(node.nags || [])].map(Number).filter(Number.isInteger),
  }));
  document.chapters = structuredClone((input.chapters || []).filter(chapter => chapter.positionIDs));
  // Draft boundaries use editor node IDs. They are never sent as positionIDs.
  const drafts = input.chapterDrafts || (input.chapters || []).filter(chapter => !chapter.positionIDs);
  document.chapterDrafts = drafts.map((chapter, index) => ({
    id: chapter.id || `chapter-${index + 1}`,
    title: chapter.title || `Chapter ${index + 1}`,
    startNodeID: chapter.startNodeID === null ? null : String(chapter.startNodeID),
    startIndex: Number.isInteger(chapter.startIndex) ? chapter.startIndex : null,
    startPath: Array.isArray(chapter.startPath) ? chapter.startPath.map(String) : null,
  }));
  document.ignoredSuggestionIDs = [...(input.ignoredSuggestionIDs || [])];
  return document;
}

export function importParsedPGN(parsed, metadata = {}) {
  return normalizeDocument({
    metadata,
    headers: parsed.headers,
    nodes: parsed.nodes,
  });
}

export function pgnHasMoves(pgn = "") {
  const movetext = String(pgn)
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith("["))
    .join("\n")
    .replace(/\{[^}]*\}/gs, " ")
    .replace(/;[^\r\n]*/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\b(?:1-0|0-1|1\/2-1\/2)\b|\*/g, " ")
    .replace(/\d+\.(?:\.\.)?/g, " ")
    .trim();
  return movetext.length > 0;
}

export function childrenOf(document, parentID) {
  const key = parentID === null ? null : String(parentID);
  return document.nodes.filter(node => node.parentId === key);
}

export function nodeByID(document, id) {
  const key = id === null ? null : String(id);
  return key === null ? null : document.nodes.find(node => node.id === key) || null;
}

export function pathToNode(document, id) {
  const output = [];
  let node = nodeByID(document, id);
  const seen = new Set();
  while (node) {
    if (seen.has(node.id)) throw new Error("The variation tree contains a cycle.");
    seen.add(node.id);
    output.push(node);
    node = node.parentId === null ? null : nodeByID(document, node.parentId);
  }
  return output.reverse();
}

export function movesToNode(document, id) {
  return pathToNode(document, id).map(node => node.uci);
}

export function addMove(document, parentID, move) {
  const existing = childrenOf(document, parentID).find(node => node.uci === move.uci);
  if (existing) return { document, node: existing, created: false };
  const next = structuredClone(document);
  const id = uniqueNodeID(next);
  const parent = parentID === null ? null : nodeByID(next, parentID);
  const node = {
    id,
    parentId: parent ? parent.id : null,
    uci: move.uci,
    san: move.san || move.uci,
    ply: parent ? parent.ply + 1 : 1,
    comment: "",
    startingComment: "",
    nags: [],
  };
  next.nodes.push(node);
  return { document: structuralDocument(document, next), node, created: true };
}

export function removeBranch(document, id) {
  const descendants = new Set([String(id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of document.nodes) {
      if (node.parentId !== null && descendants.has(node.parentId) && !descendants.has(node.id)) {
        descendants.add(node.id);
        changed = true;
      }
    }
  }
  const next = structuredClone(document);
  next.nodes = next.nodes.filter(node => !descendants.has(node.id));
  return structuralDocument(document, next);
}

export function promoteVariation(document, id) {
  const next = structuredClone(document);
  const node = nodeByID(next, id);
  if (!node) return next;
  const siblings = childrenOf(next, node.parentId);
  const firstIndex = next.nodes.findIndex(item => item.id === siblings[0]?.id);
  const nodeIndex = next.nodes.findIndex(item => item.id === node.id);
  if (firstIndex < 0 || nodeIndex < 0 || firstIndex === nodeIndex) return next;
  next.nodes.splice(nodeIndex, 1);
  next.nodes.splice(firstIndex, 0, node);
  return structuralDocument(document, next);
}

export function reorderVariation(document, id, direction) {
  const next = structuredClone(document);
  const node = nodeByID(next, id);
  if (!node) return next;
  const siblings = childrenOf(next, node.parentId);
  const siblingIndex = siblings.findIndex(item => item.id === node.id);
  const targetSibling = siblings[siblingIndex + direction];
  if (!targetSibling) return next;
  const nodeIndex = next.nodes.findIndex(item => item.id === node.id);
  const targetIndex = next.nodes.findIndex(item => item.id === targetSibling.id);
  [next.nodes[nodeIndex], next.nodes[targetIndex]] = [next.nodes[targetIndex], next.nodes[nodeIndex]];
  return structuralDocument(document, next);
}

export function updateNode(document, id, patch) {
  const next = structuredClone(document);
  const node = nodeByID(next, id);
  if (node) Object.assign(node, patch);
  return next;
}

export function trainingPack(document, packID = "draft") {
  const learnerOnOddPly = document.metadata.side !== "black";
  const positions = [];
  const visitLine = startingParentID => {
    let parentID = startingParentID;
    const deferredOpponentBranches = [];
    while (true) {
      const children = childrenOf(document, parentID);
      if (!children.length) break;
      const parentPly = parentID === null ? 0 : nodeByID(document, parentID)?.ply || 0;
      const learnerTurn = learnerOnOddPly ? parentPly % 2 === 0 : parentPly % 2 === 1;
      const main = children[0];
      if (learnerTurn) {
        const positionID = parentID === null ? "start" : String(parentID);
        positions.push({
          id: positionID,
          learningOrder: positions.length,
          ply: main.ply,
          moveNumber: Math.ceil(main.ply / 2),
          correctMove: { san: main.san, uci: main.uci, feedback: main.comment },
          wrongMoves: children.slice(1).map(child => ({
            san: child.san, uci: child.uci, feedback: child.comment,
          })),
          path: movesToNode(document, parentID),
          breadcrumb: pathToNode(document, parentID).map(moveLabel).join(" ") || "Starting position",
          source: { chapter: main.startingComment || "Repertoire line" },
        });
        // Learner siblings are feedback-only; their continuations never train.
      } else {
        // Like the compiler, defer every opponent sibling until the complete
        // current main sequence has been visited.
        deferredOpponentBranches.push(...children.slice(1).map(child => child.id));
      }
      parentID = main.id;
    }
    deferredOpponentBranches.forEach(branchID => visitLine(branchID));
  };
  visitLine(null);
  return { id: packID, positions };
}

export function reconcileChapterDrafts(previous, next, packID = "draft") {
  const oldPositions = trainingPack(previous, packID).positions;
  const newPositions = trainingPack(next, packID).positions;
  const newIDs = new Set(newPositions.map(position => position.id));
  const oldIndex = new Map(oldPositions.map((position, index) => [position.id, index]));
  const drafts = ensureChapters(previous, packID);
  if (!newPositions.length) return [];
  const reconciled = drafts.map((chapter, index) => {
    if (index === 0) return { ...chapter, startNodeID: null };
    if (newIDs.has(chapter.startNodeID)) return { ...chapter };
    const preferred = Math.min(oldIndex.get(chapter.startNodeID) ?? index, newPositions.length - 1);
    return { ...chapter, startNodeID: newPositions[preferred]?.id || null };
  });
  const seen = new Set();
  return reconciled.filter((chapter, index) => {
    const key = index === 0 ? "__start__" : chapter.startNodeID;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function structuralDocument(previous, next, packID = previous.metadata?.slug || "draft") {
  const output = structuredClone(next);
  output.chapterDrafts = reconcileChapterDrafts(previous, output, packID);
  output.chapters = [];
  return output;
}

export function hydrateRestoredDocument(parsed, saved) {
  const hydrated = importParsedPGN(parsed, saved.metadata);
  hydrated.sourcePGN = saved.sourcePGN || "";
  hydrated.chapters = structuredClone(saved.chapters || []);
  const positions = trainingPack(hydrated, hydrated.metadata.slug || "draft").positions;
  const byPath = new Map(positions.map(position => [JSON.stringify(position.path), position.id]));
  hydrated.chapterDrafts = (saved.chapterDrafts || []).map((chapter, index) => {
    if (index === 0) return { ...chapter, startNodeID: null };
    const pathID = Array.isArray(chapter.startPath) ? byPath.get(JSON.stringify(chapter.startPath)) : null;
    const indexedID = Number.isInteger(chapter.startIndex) ? positions[chapter.startIndex]?.id : null;
    return { ...chapter, startNodeID: pathID || indexedID || chapter.startNodeID };
  });
  hydrated.ignoredSuggestionIDs = [...(saved.ignoredSuggestionIDs || [])];
  return hydrated;
}

export function documentForStorage(document, sourcePGN) {
  // The PGN is the move-tree authority. Omitting hydrated nodes avoids sending
  // the same large course twice and keeps create/save requests under the proxy
  // ceiling; opening the draft deterministically hydrates the tree again.
  const stored = structuredClone(document);
  // Writing ignores live in the authenticated Studio-global dictionary. Drop
  // legacy course-local copies whenever a draft is next saved.
  delete stored.ignoredWords;
  const positions = trainingPack(document, document.metadata.slug || "draft").positions;
  const chapters = ensureChapters(document, document.metadata.slug || "draft");
  const positionIndex = new Map(positions.map((position, index) => [position.id, index]));
  stored.chapterDrafts = chapters.map((chapter, index) => {
    const startIndex = index === 0 ? 0 : positionIndex.get(chapter.startNodeID);
    return {
      ...chapter,
      startIndex,
      startPath: positions[startIndex]?.path || [],
    };
  });
  return { ...stored, sourcePGN, nodes: [] };
}

export function evaluatePreviewMove(position, move, fallbackFeedback) {
  const correct = move.uci === position.correctMove.uci;
  const authored = (position.wrongMoves || []).find(item => item.uci === move.uci);
  return {
    correct,
    move,
    feedback: correct
      ? position.correctMove.feedback || "Correct."
      : authored?.feedback || String(fallbackFeedback || "The repertoire move is {san}.")
        .replaceAll("{san}", position.correctMove.san),
  };
}

export function ensureChapters(document, packID = "draft") {
  const pack = trainingPack(document, packID);
  if (!pack.positions.length) return [];
  const indexByID = new Map(pack.positions.map((position, index) => [position.id, index]));
  const valid = document.chapterDrafts.length && document.chapterDrafts[0].startNodeID === null
    && document.chapterDrafts.every((chapter, index) => index === 0 || indexByID.has(chapter.startNodeID));
  if (valid) return structuredClone(document.chapterDrafts);
  const count = Math.max(1, Math.round(pack.positions.length / 24));
  return Array.from({ length: count }, (_, index) => {
    const start = Math.round(index * pack.positions.length / count);
    return {
      id: `${packID}-chapter-${index + 1}`,
      title: `Chapter ${index + 1}`,
      startNodeID: index === 0 ? null : pack.positions[start].id,
    };
  });
}

export function chapterSlices(document, packID = "draft") {
  const pack = trainingPack(document, packID);
  const chapters = ensureChapters(document, packID);
  const indexByID = new Map(pack.positions.map((position, index) => [position.id, index]));
  return chapters.map((chapter, index) => {
    const start = index === 0 ? 0 : indexByID.get(chapter.startNodeID);
    const end = index + 1 === chapters.length ? pack.positions.length : indexByID.get(chapters[index + 1].startNodeID);
    return { ...chapter, positions: pack.positions.slice(start, end), startIndex: start };
  });
}

export function validateDocument(document) {
  const blockers = [];
  const warnings = [];
  const ids = new Set(document.nodes.map(node => node.id));
  if (!document.metadata.title.trim()) blockers.push({ area: "Course details", message: "Add a course title." });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.metadata.slug || "")) {
    blockers.push({ area: "Course details", message: "The course ID must use lowercase words and hyphens." });
  }
  if (!document.nodes.length) blockers.push({ area: "Repertoire", message: "Add at least one move." });
  if (ids.size !== document.nodes.length) blockers.push({ area: "Repertoire", message: "Move IDs are not unique." });
  for (const node of document.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) blockers.push({ area: "Repertoire", message: `${node.san} has a missing parent move.` });
    if (!node.comment.trim() && node.ply % 2 === (document.metadata.side === "white" ? 1 : 0)) {
      warnings.push({ area: "Writing", message: `${node.san} has no teaching note.` });
    }
  }
  const pack = trainingPack(document, document.metadata.slug || "draft");
  if (pack.positions.length) {
    const chapters = ensureChapters(document, pack.id);
    if (!chapters.length || chapters.some(chapter => !chapter.title.trim())) {
      blockers.push({ area: "Chapters", message: "Every training position needs a named chapter." });
    }
    chapterSlices(document, pack.id).filter(chapter => chapter.positions.length < 16 || chapter.positions.length > 32)
      .forEach(chapter => { const count=chapter.positions.length;warnings.push({ area: "Chapters", message: `${chapter.title} has ${count} ${count===1?"position":"positions"}.` }); });
  }
  return { blockers: uniqueMessages(blockers), warnings: uniqueMessages(warnings) };
}

export function serializeForPGN(document) {
  return document.nodes.map(node => ({
    id: numericID(node.id, document.nodes),
    parent_id: node.parentId === null ? null : numericID(node.parentId, document.nodes),
    uci: node.uci,
    comment: node.comment,
    starting_comment: node.startingComment,
    nags: node.nags,
  }));
}

function numericID(id, nodes) {
  return nodes.findIndex(node => node.id === String(id)) + 1;
}

function moveLabel(node) {
  const number = Math.ceil(node.ply / 2);
  return node.ply % 2 ? `${number}. ${node.san}` : `${number}… ${node.san}`;
}

function uniqueNodeID(document) {
  const used = new Set(document.nodes.map(node => node.id));
  let value;
  do value = `move-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  while (used.has(value));
  return value;
}

function uniqueMessages(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.area}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
