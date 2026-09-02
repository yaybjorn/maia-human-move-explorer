import { StudioAPI, analysisAPI, importedCoursePayload } from "./studio-api.mjs?v=20260902-editor-engine";
import { EngineAnalysisController, engineEvaluationText, whiteEvaluationPercent } from "./studio-engine.mjs?v=20260902-editor-engine";
import {
  addMove, chapterSlices, childrenOf, ensureChapters, importParsedPGN, movesToNode, pgnHasMoves,
  documentForStorage, evaluatePreviewMove, hydrateRestoredDocument, newCourseDocument, nodeByID,
  normalizeDocument, pathToNode, promoteVariation, removeBranch, reorderVariation,
  serializeForPGN, structuralDocument, trainingPack, updateNode, validateDocument,
} from "./studio-document.mjs?v=20260901-teaching-note-links";
import { checkWriting, writingSuggestionLabel } from "./writing-check.js";

const api = new StudioAPI();
const $ = id => document.getElementById(id);
const state = {
  user: null, courses: [], currentCourse: null, courseID: null, revision: null, document: null,
  savedSnapshot: "", undo: [], redo: [], currentNodeID: null, position: null,
  flipped: false, selectedSquare: null, dragFrom: null, view: "dashboard",
  requestToken: 0, analysisToken: 0, validation: null, versions: [],
  chapterDrag: null, chapterAddMode: false, previewIndex: 0, previewChapter: 0,
  previewAttempt: null, previewPosition: null, previewSelectedSquare: null,
  reconciliationError: null, pendingImport: null,
  ignoredWords: [],
  editorEngineEnabled: false, editorEngineEvaluation: null,
};
const pieceAssets = {K:"white-king",Q:"white-queen",R:"white-rook",B:"white-bishop",N:"white-knight",P:"white-pawn",k:"black-king",q:"black-queen",r:"black-rook",b:"black-bishop",n:"black-knight",p:"black-pawn"};
const pieceNames = {K:"white king",Q:"white queen",R:"white rook",B:"white bishop",N:"white knight",P:"white pawn",k:"black king",q:"black queen",r:"black rook",b:"black bishop",n:"black knight",p:"black pawn"};
const RECOVERY_PREFIX = "gingergm-studio-recovery-v1:";

const editorEngine = new EngineAnalysisController({
  analyze: (moves, options) => analysisAPI.stockfish(moves, options),
  onResult: data => {
    const evaluation = data?.lines?.[0]?.evaluation;
    if (!state.editorEngineEnabled || !evaluation) return showEditorEngineError("No evaluation available");
    state.editorEngineEvaluation = evaluation;
    renderEditorEngine();
  },
  onError: () => showEditorEngineError("Engine unavailable"),
});

function escapeHTML(value = "") {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
}
function slugify(value) { return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); }
function dirty() { return Boolean(state.document) && JSON.stringify(state.document) !== state.savedSnapshot; }
function recoveryKey() { return `${RECOVERY_PREFIX}${state.courseID || "unknown"}`; }
function showStatus(message, error = false) {
  const toast = $("global-status");
  toast.textContent = message; toast.classList.toggle("error", error); toast.hidden = false;
  clearTimeout(showStatus.timer); showStatus.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) { button.dataset.label = button.textContent; button.textContent = busyLabel; }
  else if (button.dataset.label) { button.textContent = button.dataset.label; delete button.dataset.label; }
  button.disabled = busy;
}

function showLogin(message = "") {
  state.user = null; $("boot").hidden = true; $("studio").hidden = true; $("login-view").hidden = false;
  $("login-error").textContent = message;
}
async function boot() {
  api.onUnauthorized = () => showLogin("Your session expired. Sign in again—your unsaved work is still in this tab.");
  try {
    const session = await api.session();
    if (!session?.user && !session?.email) return showLogin();
    setUser(session.user || session);
    await showApp();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin(error.message);
  }
}
function setUser(user) {
  state.user = user;
  const name = user.name || user.displayName || user.email?.split("@")[0] || "Author";
  $("account-name").textContent = name;
  $("account-email").textContent = user.email || "";
  $("avatar").textContent = name[0]?.toUpperCase() || "A";
}
async function showApp() {
  $("boot").hidden = true; $("login-view").hidden = true; $("studio").hidden = false;
  await Promise.all([
    loadCourses(),
    refreshIgnoredWords().catch(error=>showStatus(`Shared dictionary unavailable: ${error.message}`,true)),
  ]);
}

async function refreshIgnoredWords() {
  const payload = await api.ignoredWords();
  state.ignoredWords = [...(payload?.words || [])];
  return state.ignoredWords;
}

async function loadCourses() {
  $("course-list").innerHTML = '<div class="loading-card">Loading courses…</div>';
  try {
    const payload = await api.courses();
    state.courses = payload?.courses || payload || [];
    renderDashboard();
  } catch (error) {
    $("course-list").innerHTML = `<div class="loading-card">${escapeHTML(error.message)}</div>`;
  }
}
function renderDashboard() {
  const liveVersion = course => course.currentPublishedVersion || course.publishedVersion;
  const live = state.courses.filter(course => liveVersion(course) || course.status === "published").length;
  const drafts = state.courses.filter(course => course.hasUnpublishedChanges ?? (!liveVersion(course) || Number(course.draftRevision || 0) > Number(course.latestPublishedRevision || course.publishedDocumentRevision || 0))).length;
  $("course-stats").innerHTML = [
    [state.courses.length, "Courses"], [live, "Live in app"], [drafts, "Drafts to finish"],
  ].map(([value,label]) => `<div class="stat"><strong>${value}</strong><span>${escapeHTML(label)}</span></div>`).join("");
  if (!state.courses.length) {
    $("course-list").innerHTML = '<div class="loading-card"><strong>No courses yet.</strong><p>Import a PGN or start from scratch.</p></div>';
    return;
  }
  $("course-list").innerHTML = state.courses.map(course => { const changed = course.hasUnpublishedChanges ?? (Number(course.draftRevision || 0) > Number(course.latestPublishedRevision || course.publishedDocumentRevision || 0)); return `<button type="button" class="course-card" data-course="${escapeHTML(course.id)}" aria-label="Open ${escapeHTML(course.title || "Untitled course")}">
    <span class="course-card-head"><span><span class="course-card-title">${escapeHTML(course.title || "Untitled course")}</span><span class="course-card-description">${escapeHTML(course.subtitle || course.description || "Opening course")}</span></span><span class="tag ${liveVersion(course) ? "live" : "draft"}">${liveVersion(course) ? `Live · ${escapeHTML(liveVersion(course))}` : "Draft"}</span></span>
    <span class="course-meta"><span>${Number(course.draftPositionCount ?? course.positionCount ?? 0)} positions</span><span>${Number(course.draftChapterCount ?? course.chapterCount ?? 0)} chapters</span><span>${changed ? "Unpublished changes" : escapeHTML(course.updatedAt ? formatDate(course.updatedAt) : "Not saved")}</span></span>
  </button>`; }).join("");
  document.querySelectorAll("[data-course]").forEach(card => {
    card.addEventListener("click", () => openCourse(card.dataset.course));
  });
}

async function openCourse(id) {
  if (dirty() && !confirm("Discard your unsaved changes and open another course?")) return;
  showStatus("Opening course…");
  try {
    const payload = await api.course(id);
    const draft = payload.draft || payload;
    state.courseID = payload.course?.id || payload.id || id;
    state.currentCourse = payload.course || state.courses.find(course => course.id === state.courseID) || null;
    state.revision = draft.revision ?? payload.revision ?? 0;
    state.document = normalizeDocument(draft.document || draft || payload.document || {});
    state.document.metadata.slug = payload.course?.slug || state.document.metadata.slug;
    state.reconciliationError = null;
    state.document = await hydrateSourceDocument(state.document);
    state.savedSnapshot = JSON.stringify(state.document); state.undo = []; state.redo = [];
    state.currentNodeID = null; state.previewIndex = 0; state.previewChapter = 0;
    state.previewAttempt = null; state.previewPosition = null; state.previewSelectedSquare = null;
    state.validation = null;
    restoreCrashRecovery();
    $("course-title").textContent = state.document.metadata.title;
    $("course-identity").hidden = false; $("course-navigation").hidden = false;
    $("save").hidden = false; $("publish").hidden = false;
    renderAll(); await refreshPosition(); switchView("editor");
  } catch (error) { showStatus(error.message, true); }
}

async function hydrateSourceDocument(document) {
  if (document.nodes.length || !pgnHasMoves(document.sourcePGN)) return document;
  const parsed = await analysisAPI.parsePGN(document.sourcePGN);
  const hydrated = hydrateRestoredDocument(parsed, document);
  state.reconciliationError = null;
  if (!hydrated.chapters.length) return hydrated;
  try {
    const validation = await api.validateCourse(state.courseID, state.revision);
    const compiled = [...(validation.compiledPreview?.positions || [])]
      .sort((left, right) => (left.learningOrder ?? 0) - (right.learningOrder ?? 0));
    const local = trainingPack(hydrated, hydrated.metadata.slug || "draft").positions;
    const compiledIndex = new Map(compiled.map((position, index) => [position.id, index]));
    if (compiled.length === local.length) {
      const drafts = hydrated.chapters.map((chapter, index) => {
        const start = index === 0 ? 0 : compiledIndex.get(chapter.positionIDs[0]);
        return {
          id: chapter.id,
          title: chapter.title,
          startNodeID: index === 0 ? null : local[start]?.id,
        };
      });
      if (drafts.every((chapter, index) => index === 0 || chapter.startNodeID)) hydrated.chapterDrafts = drafts;
    }
    state.validation = validation;
  } catch (error) {
    state.reconciliationError = `Authored chapters could not be reconciled: ${error.message}`;
  }
  return hydrated;
}

function commit(next, { navigateTo } = {}) {
  const value = typeof next === "function" ? next(structuredClone(state.document)) : next;
  if (!value) return;
  if (JSON.stringify(value) === JSON.stringify(state.document)) {
    if (navigateTo !== undefined && navigateTo !== state.currentNodeID) {
      state.currentNodeID = navigateTo;
      renderAll();
    }
    updateSaveState();
    return;
  }
  state.undo.push(structuredClone(state.document)); if (state.undo.length > 100) state.undo.shift();
  state.redo = []; state.document = value; state.validation = null;
  if (navigateTo !== undefined) state.currentNodeID = navigateTo;
  saveCrashRecovery(); renderAll(); updateSaveState();
}

function saveCrashRecovery() {
  if (!state.document || !state.courseID) return;
  try { localStorage.setItem(recoveryKey(), JSON.stringify({ revision: state.revision, savedAt: Date.now(), document: state.document })); } catch { /* browser storage may be full */ }
}
function clearCrashRecovery() { try { localStorage.removeItem(recoveryKey()); } catch { /* unavailable storage */ } }
function restoreCrashRecovery() {
  let recovery;
  try { recovery = JSON.parse(localStorage.getItem(recoveryKey()) || "null"); } catch { recovery = null; }
  if (!recovery?.document || JSON.stringify(recovery.document) === state.savedSnapshot) return;
  if (confirm(`Unsaved browser recovery from ${formatDate(recovery.savedAt)} was found. Restore it?`)) {
    state.document = normalizeDocument(recovery.document);
    showStatus("Recovered unsaved browser work. Save the draft when ready.");
  } else clearCrashRecovery();
}
function undo() {
  const previous = state.undo.pop(); if (!previous) return;
  state.redo.push(structuredClone(state.document)); state.document = previous;
  if (state.currentNodeID && !nodeByID(state.document, state.currentNodeID)) state.currentNodeID = null;
  saveCrashRecovery(); renderAll(); refreshPosition();
}
function redo() {
  const next = state.redo.pop(); if (!next) return;
  state.undo.push(structuredClone(state.document)); state.document = next;
  saveCrashRecovery(); renderAll(); refreshPosition();
}
function updateSaveState(saving = false) {
  const changed = dirty();
  $("save").disabled = !changed || saving;
  $("save-state").textContent = saving ? "Saving…" : changed ? "Unsaved changes" : "Saved";
  $("save-state").className = `save-state ${saving ? "saving" : changed ? "dirty" : ""}`;
  $("undo").disabled = !state.undo.length; $("redo").disabled = !state.redo.length;
}
async function exportSource(document = state.document) {
  const payload = await analysisAPI.exportPGN(serializeForPGN(document), document.headers);
  if (!payload?.pgn) throw new Error("The course could not be exported safely. Nothing was saved.");
  return payload.pgn;
}
async function saveDraft({ quiet = false } = {}) {
  flushActiveEditor();
  if (!state.document || !dirty()) return true;
  updateSaveState(true);
  try {
    const sourcePGN = await exportSource();
    const localDocument = normalizeDocument({ ...state.document, sourcePGN });
    const payload = await api.saveDraft(state.courseID, state.revision, documentForStorage(localDocument, sourcePGN));
    const saved = payload.draft || payload.document || {};
    state.document = localDocument;
    state.document.metadata = { ...state.document.metadata, ...(saved.metadata || {}) };
    state.document.metadata.slug = payload.course?.slug || state.document.metadata.slug;
    state.currentCourse = payload.course || state.currentCourse;
    state.revision = saved.revision ?? payload.revision ?? state.revision + 1;
    state.savedSnapshot = JSON.stringify(state.document); clearCrashRecovery(); updateSaveState();
    if (!quiet) showStatus("Draft saved.");
    return true;
  } catch (error) {
    updateSaveState();
    if (error.status === 409) { showStatus("A newer server draft exists. Your work is preserved here.", true); $("conflict-dialog").showModal(); }
    else showStatus(error.message, true);
    return false;
  }
}

function flushActiveEditor() {
  const active = document.activeElement;
  if (!active || !active.matches("input,textarea,select")) return;
  if (active.id === "node-comment" || active.id === "node-hint"
      || active.dataset.chapterTitle !== undefined || active.form === $("details-form")) active.blur();
}
function markPendingInput(){if(!state.document)return;$("save").disabled=false;$("save-state").textContent="Unsaved changes";$("save-state").className="save-state dirty"}

function switchView(view) {
  if (view !== "dashboard" && !state.document) view = "dashboard";
  state.view = view;
  document.querySelectorAll(".view").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === view));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  location.hash = view;
  $("content").focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "history") loadHistory();
  if (view === "quality") renderQuality();
  if (["chapters","preview"].includes(view)) renderAll();
  if (view === "editor") queueEditorEngineAnalysis();
  else editorEngine.cancel();
}
function renderAll() {
  if (!state.document) return;
  renderDetails(); renderMoveTree(); renderInspector(); renderAnalysisPath(); renderQuality();
  if (state.view === "chapters") renderChapters();
  if (state.view === "preview") renderPreview();
  $("course-title").textContent = state.document.metadata.title || "Untitled course";
  updateSaveState();
}

function renderDetails() {
  const form = $("details-form");
  if (form.dataset.renderedRevision === String(state.revision) && document.activeElement?.form === form) return;
  for (const [key, value] of Object.entries(state.document.metadata)) if (form.elements[key]) {
    if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
    else form.elements[key].value = value ?? "";
  }
  if (form.elements.priceTier) form.elements.priceTier.value = priceTierFor(state.document.metadata);
  form.dataset.renderedRevision = String(state.revision);
}

function priceTierFor(metadata) {
  if (["free", "usd-4.99", "usd-9.99", "usd-19.99"].includes(metadata.priceTier)) return metadata.priceTier;
  if (metadata.access === "free") return "free";
  return ({ "$4.99": "usd-4.99", "$9.99": "usd-9.99", "$19.99": "usd-19.99" })[metadata.displayPrice] || "usd-4.99";
}

function pieceMap(fen) {
  const output = {};
  fen.split(" ")[0].split("/").forEach((rank, rankIndex) => {
    let file = 0;
    for (const token of rank) {
      if (/\d/.test(token)) file += Number(token);
      else { output["abcdefgh"[file] + (8-rankIndex)] = token; file += 1; }
    }
  });
  return output;
}
function renderBoard(element, position, { interactive = false, selected = null, onSquare = boardSquare, onMove = tryBoardMove } = {}) {
  if (!position?.fen) { element.innerHTML = ""; return; }
  const map = pieceMap(position.fen), files = state.flipped ? "hgfedcba" : "abcdefgh", ranks = state.flipped ? "12345678" : "87654321";
  element.innerHTML = "";
  for (const rank of ranks) for (const file of files) {
    const square = file + rank, button = document.createElement(interactive ? "button" : "span"), piece = map[square];
    const legal = position.legal_moves?.filter(move => move.from === selected && move.to === square) || [];
    button.className = `square ${(files.indexOf(file)+ranks.indexOf(rank))%2 ? "dark" : "light"}${selected===square ? " selected" : ""}${legal.length ? piece ? " capture" : " target" : ""}`;
    button.dataset.square = square;
    if (interactive) button.setAttribute("aria-label", `${square}${piece ? ` ${pieceNames[piece]}` : ""}`);
    button.innerHTML = `${piece ? `<img class="piece" src="/static/pieces/${pieceAssets[piece]}.svg" alt="" draggable="false">` : ""}${file===files[0]?`<span class="coord rank">${rank}</span>`:""}${rank===ranks[7]?`<span class="coord file">${file}</span>`:""}`;
    if (interactive) {
      button.addEventListener("click", () => onSquare(square, map));
      button.addEventListener("pointerdown", () => { if (piece && position.legal_moves.some(move => move.from === square)) state.dragFrom = square; });
      button.addEventListener("pointerup", () => { if (state.dragFrom && state.dragFrom !== square) onMove(state.dragFrom, square); state.dragFrom = null; });
    }
    element.append(button);
  }
}
async function refreshPosition() {
  if (!state.document) return;
  const token = ++state.requestToken;
  if (state.editorEngineEnabled) {
    editorEngine.cancel();
    state.editorEngineEvaluation = null;
    renderEditorEngine("Analysing…");
  }
  try {
    const position = await analysisAPI.position(movesToNode(state.document, state.currentNodeID));
    if (token !== state.requestToken) return;
    state.position = position; renderBoard($("studio-board"), position, { interactive: true, selected: state.selectedSquare });
    const status = $("board-status");
    status.textContent = position.game_over ? "This line ends here." : "";
    status.hidden = !position.game_over;
    queueEditorEngineAnalysis();
  } catch (error) { const status = $("board-status"); status.textContent = error.message; status.hidden = false; }
}

function queueEditorEngineAnalysis() {
  if (!state.editorEngineEnabled || state.view !== "editor" || !state.position) return;
  if (state.position.game_over) {
    editorEngine.cancel();
    state.editorEngineEvaluation = null;
    renderEditorEngine("Game over");
    return;
  }
  renderEditorEngine("Analysing…");
  editorEngine.schedule(movesToNode(state.document, state.currentNodeID));
}

function renderEditorEngine(statusText = "") {
  const stage = $("editor-board-stage"), bar = $("editor-eval-bar"), button = $("toggle-editor-engine");
  stage.classList.toggle("engine-active", state.editorEngineEnabled);
  bar.hidden = !state.editorEngineEnabled;
  button.setAttribute("aria-pressed", String(state.editorEngineEnabled));
  const buttonLabel = state.editorEngineEnabled ? "Turn engine off" : "Turn engine on";
  button.setAttribute("aria-label", buttonLabel);
  button.title = buttonLabel;
  $("editor-engine-status").textContent = state.editorEngineEnabled ? statusText : "";
  if (!state.editorEngineEnabled) return;
  const evaluation = state.editorEngineEvaluation;
  const percent = evaluation ? whiteEvaluationPercent(evaluation) : 50;
  const text = evaluation ? engineEvaluationText(evaluation) : "…";
  $("editor-eval-white").style.height = `${percent}%`;
  $("editor-eval-score").textContent = text;
  bar.classList.toggle("flipped", state.flipped);
  const pawns = evaluation?.type === "cp" ? Number(evaluation.value || 0) / 100 : Number(evaluation?.value || 0) > 0 ? 30 : Number(evaluation?.value || 0) < 0 ? -30 : 0;
  bar.setAttribute("aria-valuenow", String(Math.max(-30, Math.min(30, pawns))));
  bar.setAttribute("aria-valuetext", evaluation ? `White perspective ${text}` : statusText || "Analysis pending");
  if (evaluation) $("editor-engine-status").textContent = `Evaluation ${text}`;
}

function showEditorEngineError(message) {
  if (!state.editorEngineEnabled) return;
  state.editorEngineEvaluation = null;
  renderEditorEngine(message);
}

function toggleEditorEngine() {
  state.editorEngineEnabled = !state.editorEngineEnabled;
  state.editorEngineEvaluation = null;
  editorEngine.cancel();
  renderEditorEngine(state.editorEngineEnabled ? "Analysing…" : "");
  if (state.editorEngineEnabled) queueEditorEngineAnalysis();
}
function boardSquare(square, map) {
  if (!state.position || state.position.game_over) return;
  const candidates = state.selectedSquare ? state.position.legal_moves.filter(move => move.from === state.selectedSquare && move.to === square) : [];
  if (candidates.length) { chooseBoardMove(candidates); return; }
  state.selectedSquare = map[square] && state.position.legal_moves.some(move => move.from === square) ? square : null;
  renderBoard($("studio-board"), state.position, { interactive: true, selected: state.selectedSquare });
}
function tryBoardMove(from, to) {
  const candidates = state.position?.legal_moves.filter(move => move.from === from && move.to === to) || [];
  if (candidates.length) chooseBoardMove(candidates);
}
function chooseBoardMove(candidates) {
  let move = candidates[0];
  if (candidates.length > 1) {
    const promotion = (prompt("Promote to queen, rook, bishop, or knight", "queen") || "queen")[0].toLowerCase();
    move = candidates.find(item => item.uci.endsWith({q:"q",r:"r",b:"b",k:"n",n:"n"}[promotion])) || move;
  }
  const result = addMove(state.document, state.currentNodeID, move);
  commit(result.document, { navigateTo: result.node.id }); state.selectedSquare = null; refreshPosition();
}

function renderMoveTree() {
  const container = $("move-tree"); container.innerHTML = "";
  const start = moveButton(null, "Start"); start.classList.add("start"); container.append(start);
  appendChildren(null, container);
  function appendChildren(parentID, target) {
    const children = childrenOf(state.document, parentID); if (!children.length) return;
    target.append(moveButton(children[0].id, moveLabel(children[0])));
    for (const alternate of children.slice(1)) {
      const variation = document.createElement("span"); variation.className = "variation"; variation.append("(");
      appendBranch(alternate, variation); variation.append(")"); target.append(variation);
    }
    appendChildren(children[0].id, target);
  }
  function appendBranch(node, target) { target.append(moveButton(node.id, moveLabel(node))); appendChildren(node.id, target); }
}
function moveLabel(node) { const number = Math.ceil(node.ply/2); return node.ply%2 ? `${number}. ${node.san}` : `${number}… ${node.san}`; }
function moveButton(id, label) {
  const button = document.createElement("button"); button.type = "button"; button.className = `move-chip${state.currentNodeID === id ? " current" : ""}`; button.textContent = label;
  button.addEventListener("click", () => navigate(id)); return button;
}
function navigate(id) { state.currentNodeID = id; state.selectedSquare = null; state.analysisToken += 1; renderMoveTree(); renderInspector(); renderAnalysisPath(); refreshPosition(); }
function nextNode() { return childrenOf(state.document, state.currentNodeID)[0] || null; }
function endNode() { let id=state.currentNodeID,next; while ((next=childrenOf(state.document,id)[0])) id=next.id; return id; }

function renderInspector() {
  const inspector = $("move-inspector"), node = nodeByID(state.document, state.currentNodeID);
  if (!node) { inspector.innerHTML = '<div class="empty-state"><strong>Starting position</strong><p>Play a move on the board to begin or extend the repertoire.</p></div>'; return; }
  const siblings = childrenOf(state.document, node.parentId), siblingIndex = siblings.findIndex(item => item.id === node.id);
  const learnerMove = node.ply % 2 === (state.document.metadata.side === "white" ? 1 : 0);
  const commentLabel = learnerMove
    ? siblingIndex === 0 ? "Correct-move explanation" : "Wrong-move feedback"
    : "Explanation after this opponent move";
  const variationHelp = learnerMove
    ? siblingIndex === 0
      ? "Play another legal move from the previous position to add a wrong answer, then write its feedback on that variation."
      : "This variation is a wrong learner answer. Its explanation is shown after the mistake."
    : "Alternative moves here are opponent repertoire branches.";
  inspector.innerHTML = `<div class="inspector-head"><div><p class="eyebrow">Selected move</p><h2>${escapeHTML(moveLabel(node))}</h2></div><div class="inspector-actions"><button data-action="earlier" ${siblingIndex===0?"disabled":""} title="Move variation earlier">↑</button><button data-action="later" ${siblingIndex===siblings.length-1?"disabled":""} title="Move variation later">↓</button><button data-action="promote" ${siblingIndex===0?"disabled":""}>Make main</button><button data-action="delete" class="danger">Delete line</button></div></div>
    <label>${commentLabel}<textarea id="node-comment" rows="5" placeholder="What should the learner understand or remember?">${escapeHTML(node.comment)}</textarea><small>${variationHelp}</small></label>
    ${learnerMove&&siblingIndex===0?`<label>Hint<textarea id="node-hint" rows="2" maxlength="240" placeholder="Optional, e.g. Look for checks.">${escapeHTML(node.hint||"")}</textarea><small>Shown after a mistake. Leave empty when this position needs no hint.</small></label>`:""}`;
  const update = patch => commit(updateNode(state.document, node.id, patch));
  $("node-comment").addEventListener("change", event => update({ comment: event.target.value }));
  $("node-hint")?.addEventListener("change", event => update({ hint: event.target.value.trim().replace(/\s+/g," ") }));
  inspector.querySelectorAll("textarea,input").forEach(control=>control.addEventListener("input",markPendingInput));
  inspector.querySelector('[data-action="promote"]').addEventListener("click", () => commit(promoteVariation(state.document,node.id)));
  inspector.querySelector('[data-action="earlier"]').addEventListener("click", () => commit(reorderVariation(state.document,node.id,-1)));
  inspector.querySelector('[data-action="later"]').addEventListener("click", () => commit(reorderVariation(state.document,node.id,1)));
  inspector.querySelector('[data-action="delete"]').addEventListener("click", () => { if(confirm(`Delete ${node.san} and every move after it in this branch?`)){const parent=node.parentId;commit(removeBranch(state.document,node.id),{navigateTo:parent});refreshPosition();} });
}

function renderAnalysisPath() {
  if (!state.document) return;
  const sans = pathToNode(state.document, state.currentNodeID).map(moveLabel);
  $("analysis-path").textContent = sans.join(" ") || "Starting position";
}
async function runPositionAnalysis() {
  const button=$("run-analysis"), token=++state.analysisToken, moves=movesToNode(state.document,state.currentNodeID), positionKey=moves.join(" ");
  setBusy(button,true,"Analysing…");
  $("maia-results").innerHTML='<div class="empty-state"><p>Maia is considering likely human choices…</p></div>';
  $("engine-results").innerHTML='<div class="empty-state"><p>Stockfish is analysing the position…</p></div>';
  const isCurrent=()=>token===state.analysisToken&&movesToNode(state.document,state.currentNodeID).join(" ")===positionKey;
  await Promise.allSettled([
    analysisAPI.maia(moves,Number($("maia-rating").value),Number(state.document.metadata.opponentRating||$("maia-rating").value)).then(data=>{if(isCurrent())renderMaia(data.suggestions,token,positionKey)}).catch(error=>{if(isCurrent())$("maia-results").innerHTML=`<div class="empty-state"><p>${escapeHTML(error.message)}</p></div>`;}),
    analysisAPI.stockfish(moves).then(data=>{if(isCurrent()){renderEngine(data.lines,token,positionKey);$("engine-depth").textContent=`Depth ${data.depth||"—"}`;}}).catch(error=>{if(isCurrent())$("engine-results").innerHTML=`<div class="empty-state"><p>${escapeHTML(error.message)}</p></div>`;}),
  ]); setBusy(button,false);
}
function renderMaia(items=[],token,positionKey) { $("maia-results").innerHTML=items.map((move,index)=>`<div class="suggestion-row"><span>${index+1}</span><span class="move">${escapeHTML(move.san)}</span><span class="meter"><i style="width:${Math.max(0,Math.min(100,move.probability*100))}%"></i></span><button data-accept-move="${escapeHTML(move.uci)}" data-san="${escapeHTML(move.san)}">Add line · ${(move.probability*100).toFixed(1)}%</button></div>`).join("")||'<div class="empty-state"><p>No suggestions returned.</p></div>'; bindSuggestedMoves(token,positionKey); }
function scoreText(e={}) { if(e.type==="mate") return e.value>0?`M${e.value}`:`−M${Math.abs(e.value)}`;const p=(e.value||0)/100;return`${p>=0?"+":""}${p.toFixed(2)}`; }
function renderEngine(items=[],token,positionKey) { $("engine-results").innerHTML=items.map((line,index)=>`<div class="suggestion-row"><span>${index+1}</span><span class="move">${escapeHTML(line.san)}</span><span>${escapeHTML(line.pv||scoreText(line.evaluation))}</span><button data-accept-move="${escapeHTML(line.uci)}" data-san="${escapeHTML(line.san)}">Add line · ${escapeHTML(scoreText(line.evaluation))}</button></div>`).join("")||'<div class="empty-state"><p>No engine lines returned.</p></div>'; bindSuggestedMoves(token,positionKey); }
function bindSuggestedMoves(token,positionKey){document.querySelectorAll("[data-accept-move]").forEach(button=>button.addEventListener("click",()=>{if(token!==state.analysisToken||movesToNode(state.document,state.currentNodeID).join(" ")!==positionKey)return showStatus("That suggestion belongs to an older position. Analyse again before adding it.",true);const result=addMove(state.document,state.currentNodeID,{uci:button.dataset.acceptMove,san:button.dataset.san});commit(result.document,{navigateTo:result.node.id});refreshPosition();showStatus(`${button.dataset.san} added. You remain in control of the explanation.`);}));}
async function runGapCheck(){
  const button=$("run-gap-check"); setBusy(button,true,"Checking…");
  try {
    const pgn=await exportSource();
    const data=await analysisAPI.repertoireGaps(pgn,state.document.metadata.side,Number($("maia-rating").value),.15);
    const findings=(data.findings||[]).map(finding=>({ ...finding, nodeID: nodeIDForHistory(finding.history) }));
    $("gap-results").innerHTML=findings.map((finding,index)=>{
      const missing=(finding.missing||[]).filter(move=>!state.document.ignoredSuggestionIDs.includes(gapSuggestionID(finding,move)));
      if(!missing.length)return"";
      return `<article class="quality-item warning" data-gap="${index}"><span class="quality-icon">!</span><div><h3>${escapeHTML(finding.history||"Repertoire position")}</h3><p>${escapeHTML(missing.map(move=>`${move.san} ${(move.probability*100).toFixed(0)}%`).join(", "))} may need a line.</p><div class="quality-context"><span>Reach ${(100*(finding.reach_probability||0)).toFixed(1)}%</span><span>Missing mass ${(100*(finding.missing_probability_mass||0)).toFixed(1)}%</span><span>Existing ${(finding.existing_replies||[]).map(move=>escapeHTML(move.san)).join(", ")||"none"}</span></div><div class="quality-actions"><button data-gap-jump>Open position</button>${missing.map((move,moveIndex)=>`<button data-gap-add="${moveIndex}">Add ${escapeHTML(move.san)}</button><button data-gap-ignore="${moveIndex}">Deliberately omit ${escapeHTML(move.san)}</button>`).join("")}</div></div></article>`;
    }).join("")||qualityHTML("good",{area:"Coverage looks good",message:`No unreviewed missing responses above the threshold in ${data.positions_analyzed||0} checked positions.`});
    $("gap-results").querySelectorAll("[data-gap]").forEach(card=>{
      const finding=findings[Number(card.dataset.gap)], missing=(finding.missing||[]).filter(move=>!state.document.ignoredSuggestionIDs.includes(gapSuggestionID(finding,move)));
      card.querySelector("[data-gap-jump]")?.addEventListener("click",()=>jumpToFinding(finding));
      card.querySelectorAll("[data-gap-add]").forEach(control=>control.addEventListener("click",()=>addGapMove(finding,missing[Number(control.dataset.gapAdd)])));
      card.querySelectorAll("[data-gap-ignore]").forEach(control=>control.addEventListener("click",()=>{const id=gapSuggestionID(finding,missing[Number(control.dataset.gapIgnore)]);commit({...state.document,ignoredSuggestionIDs:[...new Set([...state.document.ignoredSuggestionIDs,id])]});runGapCheck();}));
    });
  } catch(error){showStatus(error.message,true)} finally {setBusy(button,false)}
}
function gapSuggestionID(finding,move){return`coverage:${finding.history||"start"}:${move.uci}`}
function nodeIDForHistory(history){
  if(!history||history==="Starting position")return null;
  for(const node of state.document.nodes){if(pgnHistory(pathToNode(state.document,node.id))===history)return node.id;}
  return undefined;
}
function pgnHistory(nodes){const chunks=[];for(let index=0;index<nodes.length;index+=2){let chunk=`${index/2+1}. ${nodes[index].san}`;if(nodes[index+1])chunk+=` ${nodes[index+1].san}`;chunks.push(chunk)}return chunks.join(" ")||"Starting position"}
function jumpToFinding(finding){if(finding.nodeID===undefined)return showStatus("This finding no longer matches the edited tree. Run coverage again.",true);navigate(finding.nodeID);switchView("editor")}
function addGapMove(finding,move){if(!move)return;if(finding.nodeID===undefined)return showStatus("Run coverage again after the latest edits.",true);const result=addMove(state.document,finding.nodeID,move);commit(result.document,{navigateTo:result.node.id});refreshPosition();switchView("editor");showStatus(`${move.san} added. Add the author explanation before publishing.`)}

function writingSources(){
  const sources=[];
  const metadataFields=["title","subtitle","description"];
  for(const field of metadataFields){const value=String(state.document.metadata[field]||"");if(value.trim())sources.push({sourceId:`metadata:${field}`,history:`Course ${field}`,comment:value});}
  for(const node of state.document.nodes){
    if(node.comment.trim())sources.push({sourceId:`comment:${node.id}`,history:moveLabel(node),comment:node.comment});
    if(node.hint?.trim())sources.push({sourceId:`hint:${node.id}`,history:`Hint after ${moveLabel(node)}`,comment:node.hint});
    if(node.startingComment.trim())sources.push({sourceId:`starting:${node.id}`,history:`Before ${moveLabel(node)}`,comment:node.startingComment});
  }
  return sources;
}
function loadIgnoredWords(){return [...state.ignoredWords]}
async function runSpellcheck({refreshDictionary=true}={}){const button=$("run-spellcheck");setBusy(button,true,"Checking…");try{flushActiveEditor();if(refreshDictionary)await refreshIgnoredWords();const sources=writingSources(),issues=await checkWriting(sources,{ignoredWords:loadIgnoredWords()});renderWriting(issues,sources.length);}catch(error){showStatus(error.message,true)}finally{setBusy(button,false)}}
async function ignoreWritingWord(issue,button){setBusy(button,true,"Adding…");try{const payload=await api.addIgnoredWord(issue.problem);state.ignoredWords=[...(payload?.words||state.ignoredWords)];showStatus(`“${issue.problem}” added to the shared dictionary.`);await runSpellcheck({refreshDictionary:false});}catch(error){showStatus(`Could not add “${issue.problem}” to the shared dictionary: ${error.message}`,true);setBusy(button,false)}}
function renderWriting(issues,count){$("writing-summary").innerHTML=`<div class="stat"><strong>${count}</strong><span>Writing fields checked</span></div><div class="stat"><strong>${issues.length}</strong><span>Suggestions</span></div><div class="stat"><strong>${loadIgnoredWords().length}</strong><span>Shared words</span></div>`;$("writing-results").innerHTML=issues.map((issue,index)=>`<article class="quality-item warning" data-writing="${index}"><span class="quality-icon">!</span><div><h3>${escapeHTML(issue.history)} · ${escapeHTML(issue.kind)}</h3><p>${highlight(issue.comment,issue.start,issue.end)}</p><p>${escapeHTML(issue.message)}</p><div class="heading-actions">${issue.suggestions.map((suggestion,suggestionIndex)=>`<button data-writing-fix="${suggestionIndex}">${escapeHTML(writingSuggestionLabel(issue.problem,suggestion))}</button>`).join("")}<button data-writing-custom>Custom fix…</button>${issue.canIgnore?`<button data-writing-ignore>Add “${escapeHTML(issue.problem)}” to shared dictionary</button>`:""}</div></div></article>`).join("")||qualityHTML("good",{area:"Writing looks clean",message:`No issues found in ${count} writing fields.`});$("writing-results").querySelectorAll("[data-writing]").forEach(card=>{const issue=issues[Number(card.dataset.writing)];card.querySelectorAll("[data-writing-fix]").forEach(button=>button.addEventListener("click",()=>applyWritingFix(issue,issue.suggestions[Number(button.dataset.writingFix)])));card.querySelector("[data-writing-custom]")?.addEventListener("click",()=>{const value=prompt(`Replace “${issue.problem}” with`,issue.problem);if(value!==null)applyWritingFix(issue,value)});card.querySelector("[data-writing-ignore]")?.addEventListener("click",event=>ignoreWritingWord(issue,event.currentTarget));});}
function highlight(text,start,end){return`${escapeHTML(text.slice(0,start))}<mark>${escapeHTML(text.slice(start,end))}</mark>${escapeHTML(text.slice(end))}`}
function applyWritingFix(issue,replacement){const [kind,key]=String(issue.sourceId).split(":");if(kind==="metadata"){const current=String(state.document.metadata[key]||"");const text=current.slice(0,issue.start)+replacement+current.slice(issue.end);commit({...state.document,metadata:{...state.document.metadata,[key]:text}});}else{const node=nodeByID(state.document,key);if(!node)return;const field=kind==="starting"?"startingComment":kind==="hint"?"hint":"comment",current=node[field]||"";const text=current.slice(0,issue.start)+replacement+current.slice(issue.end);commit(updateNode(state.document,key,{[field]:text}));}runSpellcheck();}

function renderChapters(){
  if(!state.document)return;
  const id=state.document.metadata.slug||"draft",slices=chapterSlices(state.document,id),container=$("studio-chapters"),starts=new Set(slices.slice(1).map(chapter=>chapter.startIndex));
  container.classList.toggle("adding",state.chapterAddMode);
  container.innerHTML=slices.map((chapter,index)=>`<section class="studio-chapter"><div class="studio-chapter-head" draggable="${index>0}" data-chapter-drag="${index}"><span aria-hidden="true">⠿</span><input data-chapter-title="${index}" value="${escapeHTML(chapter.title)}" maxlength="80" aria-label="Chapter ${index+1} name"><span class="chapter-count ${chapter.positions.length<16||chapter.positions.length>32?"outside":""}">${chapter.positions.length} positions</span>${index?`<span class="boundary-controls"><button data-boundary-step="-1" data-boundary-chapter="${index}" aria-label="Move ${escapeHTML(chapter.title)} boundary one position earlier">↑</button><button data-boundary-step="1" data-boundary-chapter="${index}" aria-label="Move ${escapeHTML(chapter.title)} boundary one position later">↓</button></span><button data-delete-chapter="${index}" class="icon-button" aria-label="Delete chapter ${escapeHTML(chapter.title)}">×</button>`:"<span></span><span></span>"}</div>${chapter.positions.map(position=>`${chapterDrop(position.learningOrder,starts.has(position.learningOrder))}<button class="chapter-position-row" data-chapter-position="${escapeHTML(position.id)}"><span>#${position.learningOrder+1} - move ${position.moveNumber} - <strong>${escapeHTML(position.correctMove.san)}</strong></span></button>`).join("")}</section>`).join("");
  bindChapters();
}
function chapterDrop(index,existing){if(index===0)return"";return`<button type="button" class="chapter-drop" data-chapter-drop="${index}" aria-pressed="${existing}" aria-label="${existing?"Move chapter boundary here":"Start a chapter at position "+(index+1)}">Start chapter here</button>`}
function bindChapters(){
  const pack=trainingPack(state.document,state.document.metadata.slug||"draft");
  $("studio-chapters").querySelectorAll("[data-chapter-title]").forEach(input=>{input.addEventListener("input",markPendingInput);input.addEventListener("change",()=>{const index=Number(input.dataset.chapterTitle),drafts=ensureChapters(state.document,state.document.metadata.slug||"draft"),title=input.value.trim()||`Chapter ${index+1}`;if(drafts[index].title===title){updateSaveState();return}drafts[index].title=title;commit({...state.document,chapterDrafts:drafts,chapters:[]});})});
  $("studio-chapters").querySelectorAll("[data-delete-chapter]").forEach(button=>button.addEventListener("click",()=>{const index=Number(button.dataset.deleteChapter),drafts=ensureChapters(state.document,state.document.metadata.slug||"draft");if(!confirm(`Delete “${drafts[index].title}”? Its positions will move into the previous chapter.`))return;drafts.splice(index,1);commit({...state.document,chapterDrafts:drafts,chapters:[]});}));
  $("studio-chapters").querySelectorAll("[data-boundary-step]").forEach(button=>button.addEventListener("click",()=>{const index=Number(button.dataset.boundaryChapter),drafts=ensureChapters(state.document,state.document.metadata.slug||"draft"),current=pack.positions.findIndex(position=>position.id===drafts[index].startNodeID);moveChapterBoundary(index,current+Number(button.dataset.boundaryStep));}));
  $("studio-chapters").querySelectorAll("[data-chapter-drag]").forEach(header=>{header.addEventListener("dragstart",()=>{state.chapterDrag=Number(header.dataset.chapterDrag);$("studio-chapters").classList.add("dragging")});header.addEventListener("dragend",()=>{state.chapterDrag=null;$("studio-chapters").classList.remove("dragging");document.querySelectorAll(".chapter-drop").forEach(zone=>zone.classList.remove("active"));});});
  $("studio-chapters").querySelectorAll("[data-chapter-drop]").forEach(zone=>{zone.addEventListener("dragover",event=>{if(state.chapterDrag!==null){event.preventDefault();zone.classList.add("active")}});zone.addEventListener("dragleave",()=>zone.classList.remove("active"));zone.addEventListener("drop",event=>{event.preventDefault();moveChapterBoundary(state.chapterDrag,Number(zone.dataset.chapterDrop));});zone.addEventListener("click",()=>{const index=Number(zone.dataset.chapterDrop);if(state.chapterAddMode)addChapterBoundary(index);else if(state.chapterDrag!==null)moveChapterBoundary(state.chapterDrag,index);});});
  $("studio-chapters").querySelectorAll("[data-chapter-position]").forEach(button=>button.addEventListener("click",()=>showChapterPosition(pack.positions.find(item=>item.id===button.dataset.chapterPosition))));
}
function moveChapterBoundary(chapterIndex,newIndex){const pack=trainingPack(state.document,state.document.metadata.slug||"draft"),drafts=ensureChapters(state.document,state.document.metadata.slug||"draft"),starts=drafts.map((draft,index)=>index?pack.positions.findIndex(position=>position.id===draft.startNodeID):0);if(chapterIndex<=0)return;const min=starts[chapterIndex-1]+1,max=(starts[chapterIndex+1]??pack.positions.length)-1;const index=Math.max(min,Math.min(max,newIndex));drafts[chapterIndex].startNodeID=pack.positions[index].id;state.chapterDrag=null;commit({...state.document,chapterDrafts:drafts,chapters:[]});}
function addChapterBoundary(index){const pack=trainingPack(state.document,state.document.metadata.slug||"draft"),drafts=ensureChapters(state.document,state.document.metadata.slug||"draft");if(index<=0||index>=pack.positions.length)return;const starts=drafts.map((draft,i)=>i?pack.positions.findIndex(position=>position.id===draft.startNodeID):0);if(starts.includes(index))return;const at=starts.findIndex(start=>start>index),insert=at<0?drafts.length:at;drafts.splice(insert,0,{id:`${state.document.metadata.slug||"draft"}-chapter-${Date.now()}`,title:`Chapter ${insert+1}`,startNodeID:pack.positions[index].id});state.chapterAddMode=false;$("add-chapter").textContent="Add chapter";commit({...state.document,chapterDrafts:drafts,chapters:[]});}
async function showChapterPosition(position){if(!position)return;const data=await analysisAPI.position(position.path);renderBoard($("chapter-board"),data);$("chapter-position").innerHTML=`<h2>${escapeHTML(position.correctMove.san)}</h2><p>${escapeHTML(position.correctMove.feedback||"No teaching note yet.")}</p><p><code>${escapeHTML(data.fen)}</code></p>`;}

function previewChapters(){return chapterSlices(state.document,state.document.metadata.slug||"draft")}
async function renderPreview(){
  if(!state.document)return;
  const chapters=previewChapters();
  if(!chapters.length||!chapters.some(chapter=>chapter.positions.length)){$("preview-board").innerHTML="";$("preview-card").innerHTML='<div class="empty-state"><p>Add learner moves before previewing the course.</p></div>';return;}
  state.previewChapter=Math.max(0,Math.min(state.previewChapter,chapters.length-1));
  const chapter=chapters[state.previewChapter],positions=chapter.positions;
  state.previewIndex=Math.max(0,Math.min(state.previewIndex,positions.length-1));
  const select=$("preview-chapter");
  select.innerHTML=chapters.map((item,index)=>`<option value="${index}" ${index===state.previewChapter?"selected":""}>${escapeHTML(item.title)} · ${item.positions.length}</option>`).join("");
  select.onchange=()=>{state.previewChapter=Number(select.value);restartPreviewChapter()};
  const position=positions[state.previewIndex],token=++state.analysisToken;
  try{
    const data=await analysisAPI.position(position.path);if(token!==state.analysisToken)return;
    state.previewPosition=data;state.previewSelectedSquare=null;
    renderPreviewBoard();renderPreviewCard(position,chapter);
  }catch(error){showStatus(error.message,true)}
}
function renderPreviewBoard(){renderBoard($("preview-board"),state.previewPosition,{interactive:true,selected:state.previewSelectedSquare,onSquare:previewSquare,onMove:tryPreviewMove})}
function previewSquare(square,map){
  if(!state.previewPosition||state.previewAttempt?.correct)return;
  const candidates=state.previewSelectedSquare?state.previewPosition.legal_moves.filter(move=>move.from===state.previewSelectedSquare&&move.to===square):[];
  if(candidates.length){attemptPreviewMove(candidates[0]);return;}
  state.previewSelectedSquare=map[square]&&state.previewPosition.legal_moves.some(move=>move.from===square)?square:null;renderPreviewBoard();
}
function tryPreviewMove(from,to){const candidate=state.previewPosition?.legal_moves.find(move=>move.from===from&&move.to===to);if(candidate)attemptPreviewMove(candidate)}
function attemptPreviewMove(move){
  const chapter=previewChapters()[state.previewChapter],position=chapter.positions[state.previewIndex];
  state.previewAttempt=evaluatePreviewMove(position,move);
  state.previewSelectedSquare=null;renderPreviewBoard();renderPreviewCard(position,chapter);
}
function renderPreviewCard(position,chapter){
  const attempt=state.previewAttempt;
  const answer=attempt?`<div class="learner-answer ${attempt.correct?"":"wrong"}"><strong>${attempt.correct?"Correct":escapeHTML(attempt.move.san)}</strong><span>${escapeHTML(attempt.feedback)}${attempt.hint?`<small class="learner-hint"><b>Hint</b> ${escapeHTML(attempt.hint)}</small>`:""}</span></div>`:'<div class="learner-answer pending"><strong>Answer hidden</strong><span>Make a move on the board to test this position.</span></div>';
  $("preview-card").innerHTML=`<p class="eyebrow">${escapeHTML(chapter.title)} · ${state.previewIndex+1} of ${chapter.positions.length}</p><h2>Find the best move</h2><p>${escapeHTML(position.source.chapter)}</p>${answer}<div class="dialog-actions"><button id="preview-previous" class="secondary" ${state.previewIndex===0?"disabled":""}>Previous</button><button id="preview-next" class="primary" ${!attempt?.correct||state.previewIndex===chapter.positions.length-1?"disabled":""}>Next position</button></div>`;
  $("preview-previous").addEventListener("click",()=>{state.previewIndex-=1;state.previewAttempt=null;renderPreview()});
  $("preview-next").addEventListener("click",()=>{state.previewIndex+=1;state.previewAttempt=null;renderPreview()});
}
function restartPreviewChapter(){state.previewIndex=0;state.previewAttempt=null;state.previewSelectedSquare=null;renderPreview()}

function combinedValidation(remote=null){const local=validateDocument(state.document);if(state.reconciliationError)local.blockers.push({area:"Chapters",message:state.reconciliationError});if(!remote)return local;const source=remote.validation||remote;return{blockers:uniqueChecks([...local.blockers,...(source.blockers||source.errors||[])]),warnings:uniqueChecks([...local.warnings,...(source.warnings||[])])};}
function normalizeCheck(item){if(typeof item==="string")return{area:"Validation",message:item};const area=item.area||item.path||(item.code==="chapter_size"?"Chapters":"Validation");return{area,message:item.message||item.detail||"Course issue",...(item.nodeID?{nodeID:String(item.nodeID)}:{})}}
function uniqueChecks(items){const seen=new Set();return items.map(normalizeCheck).filter(item=>{const key=`${item.area}|${item.message}`.toLocaleLowerCase("en-GB").replace(/\b(?:has|contains)\b/g,"").replace(/\bpositions?\b/g,"position").replace(/[^a-z0-9|]+/g," ").trim();if(seen.has(key))return false;seen.add(key);return true})}
function renderQuality(validation=state.validation){const checks=combinedValidation(validation),count=checks.blockers.length;$("quality-count").textContent=count||"";$("quality-summary").innerHTML=`<div class="stat"><strong>${checks.blockers.length}</strong><span>Publish blockers</span></div><div class="stat"><strong>${checks.warnings.length}</strong><span>Warnings to review</span></div><div class="stat"><strong>${trainingPack(state.document,state.document.metadata.slug||"draft").positions.length}</strong><span>Training positions</span></div>`;$("quality-results").innerHTML=[...checks.blockers.map(item=>qualityHTML("blocker",item,true)),...checks.warnings.map(item=>qualityHTML("warning",item,true))].join("")||qualityHTML("good",{area:"Ready to publish",message:"No blockers or warnings found."});$("quality-results").querySelectorAll("[data-quality-area]").forEach(button=>button.addEventListener("click",()=>reviewQualityItem(button)));return checks;}
function qualityHTML(type,item,navigate=false){return`<article class="quality-item ${type}"><span class="quality-icon">${type==="good"?"✓":type==="blocker"?"×":"!"}</span><div><h3>${escapeHTML(item.area)}</h3><p>${escapeHTML(item.message)}</p>${navigate?`<div class="quality-actions"><button data-quality-area="${escapeHTML(item.area)}"${item.nodeID?` data-quality-node="${escapeHTML(item.nodeID)}"`:""}>Review this area</button></div>`:""}</div></article>`}
function reviewQualityItem(button){switchView(areaView(button.dataset.qualityArea));if(button.dataset.qualityNode)navigate(button.dataset.qualityNode)}
function areaView(area){const value=String(area).toLowerCase();if(value.includes("chapter"))return"chapters";if(value.includes("writing")||value.includes("feedback"))return"writing";if(value.includes("detail")||value.includes("metadata"))return"details";return"editor"}
async function runQuality(){const button=$("refresh-quality");setBusy(button,true,"Checking…");try{if(dirty()&&!await saveDraft({quiet:true}))return null;state.validation=await api.validateCourse(state.courseID,state.revision);renderQuality();showStatus("Quality checks complete.");return state.validation;}catch(error){showStatus(error.message,true);return null}finally{setBusy(button,false)}}
function resolveCompiledChapters(validation){const preview=validation?.compiledPreview||validation?.preview||validation?.compiled_pack;const compiledPositions=[...(preview?.positions||[])].sort((a,b)=>(a.learningOrder??0)-(b.learningOrder??0));const localPositions=trainingPack(state.document,state.document.metadata.slug||"draft").positions;if(!compiledPositions.length||compiledPositions.length!==localPositions.length)return false;if(compiledPositions.some(position=>!String(position.id||"").startsWith("sha256:")))return false;const drafts=ensureChapters(state.document,state.document.metadata.slug||"draft"),indexByLocal=new Map(localPositions.map((position,index)=>[position.id,index]));state.document.chapters=drafts.map((draft,index)=>{const start=index===0?0:indexByLocal.get(draft.startNodeID),end=index+1===drafts.length?compiledPositions.length:indexByLocal.get(drafts[index+1].startNodeID);return{id:draft.id,title:draft.title,positionIDs:compiledPositions.slice(start,end).map(position=>position.id)};});return true;}
async function beginPublish(){
  if(!await saveDraft({quiet:true})) return;
  let validation=await runQuality(); if(!validation) return;
  const checks=combinedValidation(validation);
  if(checks.blockers.length){switchView("quality");return showStatus("Fix the publish blockers first.",true);}
  if(!state.document.chapterDrafts.length) state.document.chapterDrafts=ensureChapters(state.document,state.document.metadata.slug||"draft");
  if(!resolveCompiledChapters(validation)) return showStatus("The compiled chapter positions could not be matched safely. Publishing is blocked.",true);
  if(dirty()){if(!await saveDraft({quiet:true}))return;validation=await runQuality();if(!validation)return;}
  const warnings=combinedValidation(validation).warnings;
  let history={versions:[]};try{history=await api.versions(state.courseID)}catch{/* publication still has local review */}
  const latest=(history.versions||[])[0],liveSummary=latest?.validation?.summary||{},positions=trainingPack(state.document,state.document.metadata.slug).positions.length,chapters=ensureChapters(state.document,state.document.metadata.slug).length;
  const changes=[
    latest?`Training positions: ${liveSummary.positionCount??"unknown"} → ${positions}`:`First publication with ${positions} training positions`,
    latest?`Chapters: ${liveSummary.chapterCount??"unknown"} → ${chapters}`:`${chapters} authored chapters`,
  ];
  $("publish-review").innerHTML=`<p><strong>${escapeHTML(state.document.metadata.title)}</strong> will update in the live app after publication.</p><h3>Changes from ${latest?escapeHTML(latest.version):"no live version"}</h3><ul class="change-list">${changes.map(item=>`<li>${escapeHTML(item)}</li>`).join("")}</ul><h3>Warnings to accept (${warnings.length})</h3>${warnings.length?`<ul class="warning-list">${warnings.map(item=>`<li><strong>${escapeHTML(item.area)}</strong> · ${escapeHTML(item.message)}</li>`).join("")}</ul>`:'<p class="muted">No warnings.</p>'}<p class="muted">Published versions are immutable. You can restore one later without destroying history.</p>`;
  $("publish-dialog").showModal();
}
async function confirmPublish(){const button=$("confirm-publish");setBusy(button,true,"Publishing…");try{const result=await api.publishCourse(state.courseID,state.revision);state.revision=result.revision??state.revision;state.savedSnapshot=JSON.stringify(state.document);$("publish-dialog").close();updateSaveState();showStatus(`Published ${result.version||"successfully"}. The app will receive the update automatically.`);await loadCourses();await loadHistory();}catch(error){showStatus(error.message,true)}finally{setBusy(button,false)}}
async function loadHistory(){if(!state.courseID)return;try{const payload=await api.versions(state.courseID);state.versions=payload.versions||[];const publications=state.versions.map((version,index)=>{const summary=version.validation?.summary||{};return`<article class="history-row"><div><h2>${escapeHTML(version.version||version.id||`Version ${state.versions.length-index}`)} ${index===0?'<span class="tag live">Live</span>':""}</h2><p>${escapeHTML(version.notes||"No release notes")}</p><p>${Number(summary.positionCount||0)} positions · ${Number(summary.chapterCount||0)} chapters · draft revision ${Number(version.documentRevision||0)}</p><p>Published ${escapeHTML(formatDate(version.publishedAt||version.createdAt))} by ${escapeHTML(version.publishedBy?.name||version.author||"Author")}</p></div><button class="secondary" data-restore="${escapeHTML(version.id||version.version)}">Restore as draft</button></article>`}).join("");const revisions=(payload.revisions||[]).slice(0,12).map(revision=>`<article class="history-row"><div><h2>Draft revision ${Number(revision.revision)}</h2><p>${escapeHTML(revision.reason||"save")} · ${escapeHTML(formatDate(revision.createdAt))}</p></div><span class="tag draft">Draft activity</span></article>`).join("");$("history-list").innerHTML=`${publications||'<div class="loading-card">No published versions yet.</div>'}${revisions?`<div class="page-heading compact"><div><h2>Recent draft activity</h2></div></div>${revisions}`:""}`;$("history-list").querySelectorAll("[data-restore]").forEach(button=>button.addEventListener("click",()=>restoreVersion(button.dataset.restore)));}catch(error){$("history-list").innerHTML=`<div class="loading-card">${escapeHTML(error.message)}</div>`}}
async function restoreVersion(versionID){if(dirty()&&!confirm("Restoring will replace this unsaved draft. Continue?"))return;if(!confirm("Restore this published version as a new draft? The live course will not change until you publish again."))return;try{const payload=await api.restoreVersion(state.courseID,versionID,state.revision),raw=payload.draft||payload.document,draft=normalizeDocument(raw);draft.metadata.slug=payload.course?.slug||draft.metadata.slug;state.revision=raw?.revision??payload.revision;state.document=await hydrateSourceDocument(draft);state.savedSnapshot=JSON.stringify(state.document);clearCrashRecovery();state.undo=[];state.redo=[];state.currentNodeID=null;renderAll();refreshPosition();switchView("editor");showStatus("Version restored and rehydrated as a new draft.");}catch(error){showStatus(error.message,true)}}

async function importPGN(file) {if(!file)return;try{const pgn=await file.text(),preview=await api.importPGN(pgn),title=preview.inferredTitle&&preview.inferredTitle!=="?"?preview.inferredTitle:file.name.replace(/\.pgn$/i,"");state.pendingImport={pgn,fileName:file.name,moveCount:preview.moveCount};const form=$("import-form");form.reset();delete form.elements.slug.dataset.edited;form.elements.title.value=title;form.elements.slug.value=slugify(title);$("import-file-name").textContent=`${file.name} · ${Number(preview.moveCount||0)} moves`;$("import-dialog").showModal();}catch(error){showStatus(error.message,true)}}
function formatDate(value){if(!value)return"Unknown date";try{return new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value))}catch{return String(value)}}

$("login-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter;setBusy(button,true,"Signing in…");$("login-error").textContent="";try{const session=await api.login($("login-email").value,$("login-password").value);setUser(session.user||session);$("login-password").value="";await showApp();}catch(error){$("login-error").textContent=error.message}finally{setBusy(button,false)}});
$("logout").addEventListener("click",async()=>{try{await api.logout()}finally{editorEngine.cancel();state.editorEngineEnabled=false;state.document=null;state.savedSnapshot="";showLogin()}});
function setAccountMenu(open){$("account-menu").hidden=!open;$("account-button").setAttribute("aria-expanded",String(open));if(open)$("logout").focus()}
$("account-button").addEventListener("click",()=>setAccountMenu($("account-menu").hidden));
document.querySelectorAll(".nav-item").forEach(item=>item.addEventListener("click",()=>switchView(item.dataset.view)));
document.querySelectorAll("[data-jump-editor]").forEach(button=>button.addEventListener("click",()=>switchView("editor")));
$("new-course").addEventListener("click",()=>{$("create-form").reset();delete $("create-form").elements.slug.dataset.edited;$("create-dialog").showModal()});
$("create-form").elements.title.addEventListener("input",event=>{const slug=$("create-form").elements.slug;if(!slug.dataset.edited)slug.value=slugify(event.target.value)});
$("create-form").elements.slug.addEventListener("input",event=>{event.target.dataset.edited="true"});
$("create-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));const document=newCourseDocument(data);try{const payload=await api.createCourse({...data,document});$("create-dialog").close();await loadCourses();await openCourse(payload.course?.id||payload.id)}catch(error){showStatus(error.message,true)}});
$("dashboard-import").addEventListener("change",event=>{importPGN(event.target.files[0]);event.target.value=""});
$("import-form").elements.title.addEventListener("input",event=>{const slug=$("import-form").elements.slug;if(!slug.dataset.edited)slug.value=slugify(event.target.value)});
$("import-form").elements.slug.addEventListener("input",event=>{event.target.dataset.edited="true"});
$("import-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();if(!state.pendingImport)return;const data=Object.fromEntries(new FormData(event.currentTarget));try{const payload=await api.createCourse(importedCoursePayload({...data,pgn:state.pendingImport.pgn}));$("import-dialog").close();state.pendingImport=null;await loadCourses();await openCourse(payload.course?.id||payload.id)}catch(error){showStatus(error.message,true)}});
$("details-form").addEventListener("change",event=>{if(!event.target.name)return;const value=event.target.type==="number"?Number(event.target.value):event.target.type==="checkbox"?event.target.checked:event.target.value;const metadata={...state.document.metadata,[event.target.name]:value};if(event.target.name==="priceTier"){const pricing={free:{access:"free"},"usd-4.99":{access:"subscriber",displayPrice:"$4.99"},"usd-9.99":{access:"subscriber",displayPrice:"$9.99"},"usd-19.99":{access:"subscriber",displayPrice:"$19.99"}}[value];Object.assign(metadata,pricing);delete metadata.purchaseProductID;}commit({...state.document,metadata})});
$("details-form").addEventListener("input",()=>{$("save").disabled=false;$("save-state").textContent="Unsaved changes";$("save-state").className="save-state dirty"});
$("save").addEventListener("click",()=>saveDraft());$("publish").addEventListener("click",beginPublish);$("undo").addEventListener("click",undo);$("redo").addEventListener("click",redo);
$("go-start").addEventListener("click",()=>navigate(null));$("go-back").addEventListener("click",()=>navigate(nodeByID(state.document,state.currentNodeID)?.parentId??null));$("go-forward").addEventListener("click",()=>nextNode()&&navigate(nextNode().id));$("go-end").addEventListener("click",()=>navigate(endNode()));$("flip-board").addEventListener("click",()=>{state.flipped=!state.flipped;renderBoard($("studio-board"),state.position,{interactive:true,selected:state.selectedSquare});renderEditorEngine();renderPreview()});$("copy-fen").addEventListener("click",async()=>{if(state.position?.fen){await navigator.clipboard.writeText(state.position.fen);showStatus("FEN copied.")}});
$("toggle-editor-engine").addEventListener("click",toggleEditorEngine);
$("export-pgn").addEventListener("click",async()=>{try{const pgn=await exportSource(),blob=new Blob([`${pgn}\n`],{type:"application/x-chess-pgn"}),link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${state.document.metadata.slug||"course"}.pgn`;link.click();URL.revokeObjectURL(link.href)}catch(error){showStatus(error.message,true)}});
$("run-analysis").addEventListener("click",runPositionAnalysis);$("run-gap-check").addEventListener("click",runGapCheck);$("run-spellcheck").addEventListener("click",runSpellcheck);$("refresh-quality").addEventListener("click",runQuality);
$("add-chapter").addEventListener("click",()=>{state.chapterAddMode=!state.chapterAddMode;$("add-chapter").textContent=state.chapterAddMode?"Cancel adding":"Add chapter";renderChapters()});
$("restart-preview").addEventListener("click",restartPreviewChapter);$("close-publish").addEventListener("click",()=>$("publish-dialog").close());$("cancel-publish").addEventListener("click",()=>$("publish-dialog").close());$("confirm-publish").addEventListener("click",confirmPublish);
$("raw-pgn").addEventListener("click",async()=>{try{$("raw-pgn-text").value=await exportSource();$("raw-pgn-error").textContent="";$("raw-pgn-dialog").showModal()}catch(error){showStatus(error.message,true)}});
$("raw-pgn-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const button=$("apply-raw-pgn"),pgn=$("raw-pgn-text").value;setBusy(button,true,"Parsing…");$("raw-pgn-error").textContent="";try{await api.importPGN(pgn);const parsed=await analysisAPI.parsePGN(pgn),imported=importParsedPGN(parsed,state.document.metadata),next=structuralDocument(state.document,{...imported,sourcePGN:pgn,ignoredSuggestionIDs:state.document.ignoredSuggestionIDs,ignoredWords:state.document.ignoredWords});commit(next,{navigateTo:null});$("raw-pgn-dialog").close();refreshPosition();showStatus("Raw PGN parsed and applied.")}catch(error){$("raw-pgn-error").textContent=error.message}finally{setBusy(button,false)}});
$("conflict-keep").addEventListener("click",()=>$("conflict-dialog").close());$("conflict-reload").addEventListener("click",async()=>{$("conflict-dialog").close();state.savedSnapshot=JSON.stringify(state.document);clearCrashRecovery();await openCourse(state.courseID)});
document.addEventListener("click",event=>{if(!$("account-menu").hidden&&!$("account-menu").contains(event.target)&&!$("account-button").contains(event.target))setAccountMenu(false)});
document.addEventListener("keydown",event=>{const editing=event.target.matches("input,textarea,select,[contenteditable=true]");if(event.key==="Escape"&&!$("account-menu").hidden)setAccountMenu(false);if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();saveDraft()}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="z"&&!editing){event.preventDefault();event.shiftKey?redo():undo()}if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&!editing&&state.view==="editor"){if(event.key==="ArrowLeft")navigate(nodeByID(state.document,state.currentNodeID)?.parentId??null);if(event.key==="ArrowRight"&&nextNode())navigate(nextNode().id)}});
window.addEventListener("beforeunload",event=>{flushActiveEditor();if(dirty()){event.preventDefault();event.returnValue=""}});
window.addEventListener("hashchange",()=>{const view=location.hash.slice(1);if(document.querySelector(`[data-panel="${CSS.escape(view)}"]`))switchView(view)});

boot();
