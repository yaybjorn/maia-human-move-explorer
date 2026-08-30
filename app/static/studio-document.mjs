const DEFAULT_METADATA = Object.freeze({
  title: "Untitled course",
  subtitle: "",
  description: "",
  side: "white",
  access: "subscriber",
  catalogVisible: true,
  fallbackFeedback: "That move is not part of this repertoire. Try another idea.",
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
    wrongMoveFeedback: [...(node.wrongMoveFeedback || [])].map(item => ({
      uci: item.uci || "", san: item.san || item.uci || "", feedback: item.feedback || "",
    })),
  }));
  document.chapters = structuredClone((input.chapters || []).filter(chapter => chapter.positionIDs));
  // Draft boundaries use editor node IDs. They are never sent as positionIDs.
  const drafts = input.chapterDrafts || (input.chapters || []).filter(chapter => !chapter.positionIDs);
  document.chapterDrafts = drafts.map((chapter, index) => ({
    id: chapter.id || `chapter-${index + 1}`,
    title: chapter.title || `Chapter ${index + 1}`,
    startNodeID: chapter.startNodeID === null ? null : String(chapter.startNodeID),
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
    wrongMoveFeedback: [],
  };
  next.nodes.push(node);
  return { document: next, node, created: true };
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
  next.chapters = next.chapters.map(chapter => ({
    ...chapter, positionIDs: chapter.positionIDs.filter(positionID => !descendants.has(positionID)),
  })).filter(chapter => chapter.positionIDs.length);
  return next;
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
  return next;
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
  return next;
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
  const visit = parentID => {
    const children = childrenOf(document, parentID);
    const parentPly = parentID === null ? 0 : nodeByID(document, parentID)?.ply || 0;
    const learnerTurn = learnerOnOddPly ? parentPly % 2 === 0 : parentPly % 2 === 1;
    if (learnerTurn && children.length) {
      const positionID = parentID === null ? "start" : String(parentID);
      const main = children[0];
      positions.push({
        id: positionID,
        learningOrder: positions.length,
        correctMove: { san: main.san, uci: main.uci, feedback: main.comment },
        path: movesToNode(document, parentID),
        source: { chapter: main.startingComment || "Repertoire line" },
      });
    }
    children.forEach(child => visit(child.id));
  };
  visit(null);
  return { id: packID, positions };
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
      .forEach(chapter => warnings.push({ area: "Chapters", message: `${chapter.title} has ${chapter.positions.length} positions.` }));
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
