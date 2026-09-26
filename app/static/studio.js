import { createExtractionPanel } from "./studio-extraction.mjs?v=20260926-writing-ellipsis";
// Keep the recovery-control module revisioned independently. Studio is often
// kept open through a failed upload; a normal reload must not retain the
// pre-control module from its HTTP cache.
import { createUploadPanel } from "./studio-upload-panel.mjs?v=20260926-upload-recovery-control";
import { StudioAPI, analysisAPI, importedCoursePayload } from "./studio-api.mjs?v=20260923-chapters";

import { EngineAnalysisController, engineEvaluationText, whiteEvaluationPercent } from "./studio-engine.mjs?v=20260902-progressive-engine";
import {
  activateChapter, syncActiveChapter, newChapterCourse, addIndependentChapter, chapterDocument, chapterPGNHeaders,
  addMove, chapterSlices, childrenOf, ensureChapters, importParsedPGN, movesToNode, pgnHasMoves,
  documentForStorage, evaluatePreviewMove, hydrateRestoredDocument, newCourseDocument, nodeByID,
  normalizeDocument, pathToNode, promoteVariation, removeBranch, reorderVariation,
  normalizeCourseVideos, youtubeEmbedURL,
  serializeForPGN, structuralDocument, trainingPack, updateNode, validateDocument,
} from "./studio-document.mjs?v=20260926-writing-ellipsis";
import { checkWriting, groupWritingBulkFixes, writingSuggestionLabel } from "./writing-check.js";
import { SaveQueue, SingleFlight } from "./studio-save.mjs?v=20260902-save-coordination";
import { createStudioBoard } from "./studio-chessground.mjs?v=20260925-chessground";

const api = new StudioAPI();
const $ = id => document.getElementById(id);
const recordingExplosionSource = "/static/media/recording-explosion.webp";
const recordingVikingSource = "/static/media/recording-viking.webp";
const recordingPipeSource = "/static/media/recording-pipe.webm";
const state = {
  user: null, courses: [], currentCourse: null, courseID: null, revision: null, document: null,
  savedSnapshot: "", undo: [], redo: [], currentNodeID: null, position: null,
  flipped: false, selectedSquare: null, dragFrom: null, view: "dashboard",
  requestToken: 0, analysisToken: 0, validation: null, versions: [],
  chapterDrag: null, chapterAddMode: false, previewIndex: 0, previewChapter: 0,
  previewAttempt: null, previewPosition: null, previewSelectedSquare: null,
  reconciliationError: null, pendingImport: null,
  ignoredWords: [], diagnosticGeneration: 0, writingRequest: 0, coverageRequest: 0,
  editorEngineEnabled: false, editorEngineEvaluation: null,
  editorPanels: { tree: true, inspector: true, maia: false }, editorMaiaAbort: null,
  recordingMaiaEnabled: false, recordingMaiaAbort: null, recordingMaiaToken: 0, recordingSuggestions: [], recordingEffectTimer: null, recordingEffectFrame: null,
  sidebarCollapsed: false, effects: [], effectPreviewURL: null,
  userGames: [], userGamesCursor: null, userGamesCourseID: null, userGamesLoading: false, userGamesError: null, userGamesRequest: 0,
  videoDrag: null, videoPreviewID: null, courseVideoPreview: false, publishCandidate: null,
};
const studioBoard = createStudioBoard($("studio-board"), { onMove: tryBoardMove });
const previewBoard = createStudioBoard($("preview-board"), { onMove: tryPreviewMove });
// Recording shares Chessground's native arrow tools, but never supplies an
// onMove callback that can mutate the course document.
const recordingBoard = createStudioBoard($("recording-board"), { onMove: () => {} });
const extractionPanel = createExtractionPanel({
  api,
  getContext: () => state.user && state.document ? {
    courseID: state.courseID, revision: state.revision, metadata: state.document.metadata, dirty: dirty(),
  } : null,
  notify: showStatus,
});
const uploadPanel = createUploadPanel({ api, root: $("staged-upload-panel"), getContext: () => state.user && state.document ? {
  actorID: state.user.id, courseID: state.courseID, revision: state.revision, metadata: state.document.metadata, dirty: dirty(), chapterID: state.document.activeChapterID || null,
  chapterTitle: state.document.chapterSources?.find(chapter => chapter.id === state.document.activeChapterID)?.title || "Chapter video",
} : null, onStaged: async record => {
  if (!record.chapterID || state.courseID !== record.courseID) return;
  const next = syncActiveChapter(state.document);
  const chapter = next.chapterSources?.find(item => item.id === record.chapterID);
  if (!chapter) return;
  if (chapter.videoUploadID === record.uploadID) return startChapterVideoValidation(record.chapterID);
  chapter.videoUploadID = record.uploadID; delete chapter.video;
  commit(next);
  if (await saveDraft({quiet:true})) await startChapterVideoValidation(record.chapterID);
} });
const pieceAssets = {K:"white-king",Q:"white-queen",R:"white-rook",B:"white-bishop",N:"white-knight",P:"white-pawn",k:"black-king",q:"black-queen",r:"black-rook",b:"black-bishop",n:"black-knight",p:"black-pawn"};
const pieceNames = {K:"white king",Q:"white queen",R:"white rook",B:"white bishop",N:"white knight",P:"white pawn",k:"black king",q:"black queen",r:"black rook",b:"black bishop",n:"black knight",p:"black pawn"};
const RECOVERY_PREFIX = "gingergm-studio-recovery-v1:";
const SIDEBAR_KEY = "gingergm-studio-sidebar-collapsed";
const draftSaveQueue = new SaveQueue(options => performSaveDraft(options), () => !dirty());
const publishPreparationFlight = new SingleFlight();
const publishSubmissionFlight = new SingleFlight();
let publishPending = false;

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
  return node.innerHTML.replaceAll('"', "&quot;");
}
function slugify(value) { return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); }
function comparableDocument(document) {
  if (!Array.isArray(document?.chapterSources)) return JSON.stringify(document);
  const { activeChapterID: _active, nodes: _nodes, headers: _headers, sourcePGN: _source, trainingStartPath: _start, ...stored } = syncActiveChapter(document);
  return JSON.stringify(stored);
}
function dirty() {
  if (!state.document) return false;
  try { return comparableDocument(state.document) !== comparableDocument(JSON.parse(state.savedSnapshot || 'null')); }
  catch { return true; }
}
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
  invalidateDiagnostics();
  uploadPanel.clear();
  extractionPanel.clear();
  unmountVideoPreview();
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
  restoreSidebarPreference();
  await Promise.all([
    loadCourses(),
    loadEffects().catch(error=>showStatus(`Effects library unavailable: ${error.message}`,true)),
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

async function openCourse(id, { discardUnsaved = false } = {}) {
  if (dirty() && !discardUnsaved && !confirm("Discard your unsaved changes and open another course?")) return false;
  closeRecordingChoice();
  invalidateDiagnostics();
  stopEditorMaia(); state.analysisToken += 1;
  showStatus("Opening course…");
  try {
    const payload = await api.course(id);
    const draft = payload.draft || payload;
    const courseID = payload.course?.id || payload.id || id;
    const currentCourse = payload.course || state.courses.find(course => course.id === courseID) || null;
    const revision = draft.revision ?? payload.revision ?? 0;
    const courseDocument = normalizeDocument(draft.document || draft || payload.document || {});
    courseDocument.metadata.slug = payload.course?.slug || courseDocument.metadata.slug;
    const hydrated = await hydrateSourceDocument(courseDocument, courseID, revision);
    state.courseID = courseID;
    resetUserGames(courseID);
    state.currentCourse = currentCourse;
    state.revision = revision;
    invalidateDiagnostics();
    setEffectivePosition(hydrated.document, null);
    state.reconciliationError = hydrated.reconciliationError;
    state.validation = hydrated.validation;
    state.savedSnapshot = JSON.stringify(state.document); state.undo = []; state.redo = [];
    state.previewIndex = 0; state.previewChapter = 0;
    state.previewAttempt = null; state.previewPosition = null; state.previewSelectedSquare = null;
    state.videoPreviewID = null; state.courseVideoPreview = false; state.publishCandidate = null;
    if (discardUnsaved) clearCrashRecovery(); else restoreCrashRecovery();
    $("course-title").textContent = state.document.metadata.title;
    $("course-identity").hidden = false; $("course-navigation").hidden = false;
    $("save").hidden = false; $("publish").hidden = false;
    renderAll(); await refreshPosition();
    const requestedView = location.hash.slice(1);
    switchView(requestedView === "videos" ? "game-videos" : document.querySelector(`[data-panel="${CSS.escape(requestedView)}"]`) ? requestedView : "editor");
    return true;
  } catch (error) { showStatus(error.message, true); return false; }
}

async function hydrateSourceDocument(document, courseID, revision) {
  if (Array.isArray(document.chapterSources)) {
    const chapterSources = [];
    for (const chapter of document.chapterSources) {
      const hydrated = pgnHasMoves(chapter.sourcePGN) ? importParsedPGN(await analysisAPI.parsePGN(chapter.sourcePGN), document.metadata) : newCourseDocument(document.metadata);
      chapterSources.push({ ...chapter, nodes: hydrated.nodes, headers: hydrated.headers });
    }
    return { document: activateChapter({ ...document, chapterSources, activeChapterID: null }, document.activeChapterID || chapterSources[0]?.id), reconciliationError: null, validation: null };
  }
  if (document.nodes.length || !pgnHasMoves(document.sourcePGN)) {
    return { document, reconciliationError: null, validation: null };
  }
  const parsed = await analysisAPI.parsePGN(document.sourcePGN);
  const hydrated = hydrateRestoredDocument(parsed, document);
  if (!hydrated.chapters.length) return { document: hydrated, reconciliationError: null, validation: null };
  try {
    const validation = await api.validateCourse(courseID, revision);
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
    return { document: hydrated, reconciliationError: null, validation };
  } catch (error) {
    return {
      document: hydrated,
      reconciliationError: `Authored chapters could not be reconciled: ${error.message}`,
      validation: null,
    };
  }
}

function commit(next, { navigateTo } = {}) {
  const value = typeof next === "function" ? next(structuredClone(state.document)) : next;
  if (!value) return;
  if (JSON.stringify(value) === JSON.stringify(state.document)) {
    if (navigateTo !== undefined && navigateTo !== state.currentNodeID) {
      setEffectivePosition(state.document, navigateTo);
      renderAll();
    }
    updateSaveState();
    return;
  }
  invalidateDiagnostics();
  state.undo.push(structuredClone(state.document)); if (state.undo.length > 100) state.undo.shift();
  state.redo = []; setEffectivePosition(syncActiveChapter(value), navigateTo === undefined ? state.currentNodeID : navigateTo); state.validation = null; state.publishCandidate = null;
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
    invalidateDiagnostics();
    setEffectivePosition(normalizeDocument(recovery.document, { allowIncompleteCourseVideo: true }));
    showStatus("Recovered unsaved browser work. Save the draft when ready.");
  } else clearCrashRecovery();
}
function undo() {
  const previous = state.undo.pop(); if (!previous) return;
  invalidateDiagnostics();
  state.redo.push(structuredClone(state.document)); setEffectivePosition(previous, state.currentNodeID && nodeByID(previous, state.currentNodeID) ? state.currentNodeID : null);
  saveCrashRecovery(); renderAll(); refreshPosition();
}
function redo() {
  const next = state.redo.pop(); if (!next) return;
  invalidateDiagnostics();
  state.undo.push(structuredClone(state.document)); setEffectivePosition(next, state.currentNodeID && nodeByID(next, state.currentNodeID) ? state.currentNodeID : null);
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
  const chapter = Array.isArray(document.chapterSources) ? syncActiveChapter(document).chapterSources.find(c => c.id === document.activeChapterID) : null;
  if (Array.isArray(document.chapterSources) && !chapter) throw new Error('Add a chapter first.');
  const payload = await analysisAPI.exportPGN(serializeForPGN(document), chapter ? chapterPGNHeaders(document, chapter) : document.headers);
  if (!payload?.pgn) throw new Error("The course could not be exported safely. Nothing was saved.");
  return payload.pgn;
}
async function saveDraft(options = {}) {
  const saved = await draftSaveQueue.run({ ...options, quiet: true });
  if (saved && !options.quiet) showStatus("Draft saved.");
  return saved;
}
async function performSaveDraft() {
  flushActiveEditor();
  if (!state.document || !dirty()) return true;
  updateSaveState(true);
  try {
    const startingSnapshot = JSON.stringify(state.document);
    const startingCourseID = state.courseID;
    const startingRevision = state.revision;
    const documentToSave = normalizeDocument({
      ...state.document,
      metadata: {
        ...state.document.metadata,
        videos: normalizeCourseVideos(state.document.metadata.videos || []),
      },
    });
    saveCrashRecovery();
    const localDocument = Array.isArray(documentToSave.chapterSources)
      ? await exportAllChapterSources(documentToSave)
      : normalizeDocument({ ...documentToSave, sourcePGN: await exportSource(documentToSave) });
    const sourcePGN = localDocument.sourcePGN;
    const payload = await api.saveDraft(startingCourseID, startingRevision, documentForStorage(localDocument, sourcePGN));
    if (state.courseID !== startingCourseID) return true;
    const saved = payload.draft || payload.document || {};
    const savedDocument = normalizeDocument({
      ...localDocument,
      metadata: {
        ...localDocument.metadata,
        ...(saved.metadata || {}),
        slug: payload.course?.slug || localDocument.metadata.slug,
      },
    });
    if (JSON.stringify(state.document) === startingSnapshot) state.document = savedDocument;
    else state.document = {
      ...state.document,
      metadata: {
        ...state.document.metadata,
        slug: payload.course?.slug || state.document.metadata.slug,
      },
    };
    state.currentCourse = payload.course || state.currentCourse;
    state.revision = saved.revision ?? payload.revision ?? startingRevision + 1;
    state.savedSnapshot = JSON.stringify(savedDocument);
    uploadPanel.refresh();
    if (state.view === "game-videos" && !Array.isArray(state.document.chapterSources)) extractionPanel.refresh();
    if (!dirty()) clearCrashRecovery();
    else saveCrashRecovery();
    updateSaveState();
    return true;
  } catch (error) {
    updateSaveState();
    if (error.status === 409) { showStatus("Another tab or browser saved a newer version. Your work is safe here.", true); $("conflict-dialog").showModal(); }
    else {
      saveCrashRecovery();
      showStatus(`Save not confirmed. Keep this tab open and try Save draft again. ${error.message}`, true);
    }
    return false;
  }
}

function flushActiveEditor() {
  const active = document.activeElement;
  if (!active || !active.matches("input,textarea,select")) return;
  if (active.id === "node-comment" || active.id === "node-hint"
      || active.dataset.chapterTitle !== undefined || active.dataset.independentTitle !== undefined || active.form === $("details-form")) active.blur();
}
function markPendingInput(){if(!state.document)return;invalidateDiagnostics();extractionPanel.contextChanged();$("save").disabled=false;$("save-state").textContent="Unsaved changes";$("save-state").className="save-state dirty"}

function switchView(view) {
  if (view === "videos") view = "game-videos"; // Legacy deep link: course-level YouTube game videos.
  if (view !== "recording") closeRecordingChoice();
  if (view !== "chapter-video") extractionPanel.suspend();
  if (view === "analysis") view = "editor";
  if (!["dashboard", "effects"].includes(view) && !state.document) view = "dashboard";
  if (view !== "game-videos" && unmountVideoPreview()) {
    renderGameVideos();
  }
  state.view = view;
  document.querySelectorAll(".view").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === view));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
  location.hash = view;
  $("content").focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "history") loadHistory();
  if (view === "user-games") loadUserGames();
  if (view === "effects") loadEffects();
  if (view === "quality") renderQuality();
  if (["chapters","game-videos","chapter-video","preview"].includes(view)) renderAll();
  if (view === "game-videos" && !Array.isArray(state.document.chapterSources)) extractionPanel.refresh();
  if (view === "editor") { queueEditorEngineAnalysis(); queueEditorMaiaAnalysis(); }
  else { editorEngine.cancel(); stopEditorMaia(); }
  if (view === "recording") renderRecording();
  else { clearRecordingMaia(); clearRecordingEffect(); }
}

function safeUserGameURL(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol === "https:" && !url.username && !url.password && ["lichess.org", "chess.com"].includes(host) ? url.href : null;
  } catch { return null; }
}
function userGameProviderLabel(provider) {
  return provider === "chess.com" ? "Chess.com" : provider === "lichess" ? "Lichess" : "Chess game";
}
function resetUserGames(courseID) {
  // Course changes invalidate every in-flight request before its handlers run.
  state.userGamesRequest += 1;
  state.userGames = [];
  state.userGamesCursor = null;
  state.userGamesError = null;
  state.userGamesCourseID = courseID || null;
  state.userGamesLoading = false;
}
function userGamesRequestIsCurrent(request, courseID) {
  return state.userGamesRequest === request && state.courseID === courseID && state.userGamesCourseID === courseID;
}
function renderUserGames() {
  const list = $("user-games-list");
  const loadMore = $("load-more-user-games");
  loadMore.hidden = !state.userGamesCursor;
  loadMore.disabled = state.userGamesLoading;
  if (!state.courseID) {
    list.innerHTML = '<div class="loading-card">Open a course to view submitted games.</div>';
    return;
  }
  if (!state.userGames.length) {
    if (state.userGamesError) {
      list.innerHTML = `<div class="loading-card">${escapeHTML(state.userGamesError)}</div>`;
      return;
    }
    list.innerHTML = state.userGamesLoading ? '<div class="loading-card">Loading submitted games…</div>' : '<div class="loading-card"><strong>No games submitted yet.</strong><p>Submitted Lichess and Chess.com games will appear here.</p></div>';
    return;
  }
  list.innerHTML = state.userGames.map(submission => {
    const url = safeUserGameURL(submission.gameURL);
    const link = url ? `<a class="user-game-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Open on ${escapeHTML(userGameProviderLabel(submission.provider))}</a>` : '<span class="user-game-link unavailable">Game link unavailable</span>';
    const message = typeof submission.message === "string" && submission.message.trim()
      ? `<p class="user-game-message">${escapeHTML(submission.message)}</p>` : "";
    return `<article class="user-game-row"><div><div class="user-game-heading"><h2>${escapeHTML(userGameProviderLabel(submission.provider))}</h2><span class="tag">Submitted ${escapeHTML(formatDate(submission.submittedAt))}</span></div>${message}</div>${link}</article>`;
  }).join("");
}
async function loadUserGames({ append = false } = {}) {
  if (!state.courseID) return;
  if (state.userGamesCourseID !== state.courseID) { resetUserGames(state.courseID); append = false; }
  if (state.userGamesLoading) return;
  if (append && !state.userGamesCursor) return;
  const courseID = state.courseID;
  const request = ++state.userGamesRequest;
  state.userGamesLoading = true; renderUserGames();
  try {
    const payload = await api.userGames(courseID, { limit: 50, ...(append ? { cursor: state.userGamesCursor } : {}) });
    if (!userGamesRequestIsCurrent(request, courseID)) return;
    const submissions = Array.isArray(payload?.submissions) ? payload.submissions : [];
    state.userGames = append ? [...state.userGames, ...submissions] : submissions;
    state.userGamesCursor = typeof payload?.nextCursor === "string" ? payload.nextCursor : null;
  } catch (error) {
    if (!userGamesRequestIsCurrent(request, courseID)) return;
    if (!append) state.userGamesError = error.message;
    else showStatus(error.message, true);
  } finally {
    if (!userGamesRequestIsCurrent(request, courseID)) return;
    state.userGamesLoading = false;
    renderUserGames();
  }
}
function renderAll() {
  if (!state.document) return;
  extractionPanel.contextChanged();
  renderChapterSelector();
  renderDetails(); renderGameVideos(); renderChapterVideo(); renderMoveTree(); renderInspector(); renderEditorPanels(); renderQuality();
  renderRecording();
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

function videoID() { return `video-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
function videoItems() { return state.document?.metadata?.videos || []; }
function replaceVideos(videos) { commit({ ...state.document, metadata: { ...state.document.metadata, videos } }); }
function moveVideo(from, to) {
  const videos = [...videoItems()];
  if (from === to || from < 0 || to < 0 || from >= videos.length || to >= videos.length) return;
  const [video] = videos.splice(from, 1); videos.splice(to, 0, video); replaceVideos(videos);
}
function renderChapterVideo() {
  const chapterFirst = Array.isArray(state.document?.chapterSources);
  if (chapterFirst) extractionPanel.suspend();
  document.querySelector('[data-panel="chapter-video"] .page-heading').after($('staged-upload-panel'));
  if (chapterFirst && !state.document.activeChapterID) uploadPanel.clear(); else uploadPanel.refresh();
  if ($('chapter-video-actions')) $('chapter-video-actions').hidden = !chapterFirst;
  if (chapterFirst) {
    const active = syncActiveChapter(state.document).chapterSources.find(c => c.id === state.document.activeChapterID);
    const selector = $('chapter-video-chapter');
    $('chapter-video-selector').hidden = false;
    selector.innerHTML = state.document.chapterSources.map(chapter => `<option value="${escapeHTML(chapter.id)}" ${chapter.id===state.document.activeChapterID?'selected':''}>${escapeHTML(chapter.title)}</option>`).join('') || '<option value="">No chapters yet</option>';
    selector.disabled = !active;
    renderChapterVideoControls(active);
    if (active?.video) $('staged-upload-panel').hidden = true;
  } else $('chapter-video-selector').hidden = true;
}

function renderGameVideos() {
  renderCourseVideo();
  const container = $("video-list"); if (!container || !state.document) return;
  const videos = videoItems();
  if (!videos.length) { container.innerHTML = '<div class="empty-state"><p>No videos added.</p></div>'; return; }
  container.innerHTML = videos.map((video,index)=>`<article class="video-row" data-video-row="${index}">
    <button class="video-handle" type="button" draggable="true" aria-label="Drag ${escapeHTML(video.title || `video ${index+1}`)} to reorder">⠿</button>
    <div class="video-fields"><label>Title<input data-video-title="${index}" maxlength="120" value="${escapeHTML(video.title)}" required></label><label>YouTube link<input data-video-url="${index}" type="url" value="${escapeHTML(video.youtubeURL)}" placeholder="https://youtu.be/…?t=…" required></label></div>
    <div class="video-actions"><button type="button" class="video-preview-button" data-video-preview="${index}" aria-expanded="${state.videoPreviewID===video.id}"${state.videoPreviewID===video.id?` aria-controls="video-preview-${escapeHTML(video.id)}"`:""} aria-label="${state.videoPreviewID===video.id?"Close preview for":"Preview"} ${escapeHTML(video.title || `video ${index+1}`)}">${state.videoPreviewID===video.id?"Close preview":"Preview"}</button><button type="button" data-video-move="-1" data-video-index="${index}" aria-label="Move ${escapeHTML(video.title || `video ${index+1}`)} up" ${index===0?"disabled":""}>↑</button><button type="button" data-video-move="1" data-video-index="${index}" aria-label="Move ${escapeHTML(video.title || `video ${index+1}`)} down" ${index===videos.length-1?"disabled":""}>↓</button><button type="button" class="danger" data-video-delete="${index}" aria-label="Delete ${escapeHTML(video.title || `video ${index+1}`)}">×</button></div>
    ${state.videoPreviewID===video.id?videoPreviewHTML(video):""}
  </article>`).join("");
  container.querySelectorAll("[data-video-title],[data-video-url]").forEach(input=>{
    input.addEventListener("input",()=>{const index=Number(input.dataset.videoTitle??input.dataset.videoUrl),key=input.dataset.videoTitle!==undefined?"title":"youtubeURL";state.document.metadata.videos[index]={...state.document.metadata.videos[index],[key]:input.value};markPendingInput();});
    input.addEventListener("change",()=>{saveCrashRecovery();updateSaveState();});
  });
  container.querySelectorAll("[data-video-preview]").forEach(button=>button.addEventListener("click",()=>toggleVideoPreview(Number(button.dataset.videoPreview))));
  container.querySelectorAll("[data-video-delete]").forEach(button=>button.addEventListener("click",()=>{const videos=[...videoItems()],removed=videos.splice(Number(button.dataset.videoDelete),1)[0];if(state.videoPreviewID===removed?.id)state.videoPreviewID=null;replaceVideos(videos);}));
  container.querySelectorAll("[data-video-move]").forEach(button=>button.addEventListener("click",()=>moveVideo(Number(button.dataset.videoIndex),Number(button.dataset.videoIndex)+Number(button.dataset.videoMove))));
  container.querySelectorAll("[data-video-row]").forEach(row=>{
    row.addEventListener("dragstart",()=>{state.videoDrag=Number(row.dataset.videoRow);row.classList.add("dragging")});
    row.addEventListener("dragend",()=>{state.videoDrag=null;row.classList.remove("dragging")});
    row.addEventListener("dragover",event=>{if(state.videoDrag!==null){event.preventDefault();row.classList.add("drag-over")}});
    row.addEventListener("dragleave",()=>row.classList.remove("drag-over"));
    row.addEventListener("drop",event=>{event.preventDefault();const target=Number(row.dataset.videoRow);row.classList.remove("drag-over");moveVideo(state.videoDrag,target);state.videoDrag=null;});
  });
}

function renderCourseVideo() {
  const container = $("course-video-editor"); if (!container || !state.document) return;
  const video = state.document.metadata.courseVideo;
  $("add-course-video").hidden = Boolean(video);
  if (!video) { state.courseVideoPreview = false; container.innerHTML = ""; return; }
  container.innerHTML = `<div class="course-video-fields">
    <div class="video-fields"><label>Title<input id="course-video-title" maxlength="120" value="${escapeHTML(video.title)}" required></label><label>YouTube link<input id="course-video-url" type="url" value="${escapeHTML(video.youtubeURL)}" placeholder="https://youtu.be/…?t=…" aria-describedby="course-video-link-help" required></label></div>
    <p id="course-video-link-help">To start partway through, paste a YouTube link with a timestamp (for example, <code>?t=90</code> for 1:30).</p>
    <div class="course-video-actions"><button id="preview-course-video" class="secondary" type="button" aria-expanded="${state.courseVideoPreview}"${state.courseVideoPreview?' aria-controls="course-video-preview"':""}>${state.courseVideoPreview?"Close preview":"Preview course video"}</button><button id="remove-course-video" class="secondary danger" type="button">Remove course video</button></div>
    ${state.courseVideoPreview?videoPreviewHTML(video,"course-video-preview"):""}
  </div>`;
  for (const [id, key] of [["course-video-title", "title"], ["course-video-url", "youtubeURL"]]) {
    $(id).addEventListener("input", event => {
      state.document.metadata.courseVideo = { ...state.document.metadata.courseVideo, [key]: event.target.value };
      state.validation = null; state.publishCandidate = null;
      if (state.courseVideoPreview) {
        state.courseVideoPreview = false; $("course-video-preview")?.remove();
        $("preview-course-video").textContent = "Preview course video";
        $("preview-course-video").setAttribute("aria-expanded", "false");
        $("preview-course-video").removeAttribute("aria-controls");
      }
      saveCrashRecovery(); markPendingInput();
    });
  }
  $("preview-course-video").addEventListener("click", () => {
    const next = !state.courseVideoPreview; unmountVideoPreview(); state.courseVideoPreview = next;
    renderGameVideos(); $("preview-course-video").focus();
  });
  $("remove-course-video").addEventListener("click", () => {
    state.courseVideoPreview = false;
    commit({ ...state.document, metadata: { ...state.document.metadata, courseVideo: null } });
    $("add-course-video").focus();
  });
}

function videoPreviewHTML(video, previewID = `video-preview-${video.id}`) {
  try {
    return `<div id="${escapeHTML(previewID)}" class="video-preview" role="region" aria-label="Video preview"><iframe src="${escapeHTML(youtubeEmbedURL(video.youtubeURL))}" title="Preview: ${escapeHTML(video.title || "Course video")}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`;
  } catch (error) {
    return `<p id="${escapeHTML(previewID)}" class="video-preview-error" role="alert">${escapeHTML(error.message)}</p>`;
  }
}

function toggleVideoPreview(index) {
  const video = videoItems()[index];
  if (!video) return;
  const next = state.videoPreviewID === video.id ? null : video.id;
  unmountVideoPreview(); state.videoPreviewID = next;
  renderGameVideos();
  document.querySelector(`[data-video-preview="${index}"]`)?.focus();
}

function unmountVideoPreview() {
  const mounted = state.videoPreviewID !== null || state.courseVideoPreview || Boolean(document.querySelector(".video-preview,.video-preview-error"));
  state.videoPreviewID = null; state.courseVideoPreview = false;
  document.querySelectorAll(".video-preview,.video-preview-error").forEach(element => element.remove());
  return mounted;
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
  if (state.editorPanels.maia) {
    stopEditorMaia();
    $("maia-results").innerHTML='<div class="empty-state"><p>Maia is considering likely human choices…</p></div>';
  }
  try {
    const position = await analysisAPI.position(movesToNode(state.document, state.currentNodeID));
    if (token !== state.requestToken) return;
    state.position = position; renderStudioBoard();
    if (state.view === "recording") { renderRecordingBoard(); queueRecordingMaia(); }
    const status = $("board-status");
    status.textContent = position.game_over ? "This line ends here." : "";
    status.hidden = !position.game_over;
    queueEditorEngineAnalysis(); queueEditorMaiaAnalysis();
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
  renderStudioBoard();
}
function renderStudioBoard(){studioBoard.render(state.position,{interactive:true,flipped:state.flipped,locked:Boolean(state.position?.game_over)});}
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
  if (Array.isArray(state.document.chapterSources) && !state.document.activeChapterID) { switchView("chapters"); return showStatus("Add or import a chapter before editing moves.", true); }
  const result = addMove(state.document, state.currentNodeID, move);
  commit(result.document, { navigateTo: result.node.id }); state.selectedSquare = null; refreshPosition();
}

function renderMoveTree(container = $("move-tree")) {
  container.innerHTML = "";
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
function renderRecordingTree() { renderMoveTree($("recording-move-tree")); }
function scrollRecordingCurrentIntoView() {
  const tree = $("recording-move-tree"), current = tree.querySelector(".move-chip.current");
  if (!current) return;
  const treeRect = tree.getBoundingClientRect(), moveRect = current.getBoundingClientRect();
  if (moveRect.top < treeRect.top) tree.scrollTop += moveRect.top - treeRect.top;
  else if (moveRect.bottom > treeRect.bottom) tree.scrollTop += moveRect.bottom - treeRect.bottom;
}
function closeRecordingChoice({ restoreFocus = false } = {}) {
  const choice = $("recording-choice");
  if (choice.hidden) return;
  const restore = choice._restoreFocus;
  choice.hidden = true; choice._options = null; choice._selectedIndex = 0; choice._restoreFocus = null;
  if (restoreFocus && restore?.isConnected) restore.focus();
}
function selectRecordingChoice(index) {
  const choice = $("recording-choice"), options = choice._options || [];
  if (!options.length) return;
  choice._selectedIndex = (index + options.length) % options.length;
  choice.querySelectorAll(".recording-choice-option").forEach((button, optionIndex) => {
    const selected = optionIndex === choice._selectedIndex;
    button.setAttribute("aria-selected", String(selected));
    if (selected) button.focus();
  });
}
function confirmRecordingChoice() {
  const choice = $("recording-choice"), node = choice._options?.[choice._selectedIndex];
  if (!node) return;
  closeRecordingChoice(); navigate(node.id);
}
function advanceRecording(initiator) {
  const options = childrenOf(state.document, state.currentNodeID);
  if (options.length < 2) { if (options[0]) navigate(options[0].id); return; }
  const choice = $("recording-choice"), list = $("recording-choice-options");
  choice._options = options; choice._selectedIndex = 0; choice._restoreFocus = initiator || document.activeElement;
  list.innerHTML = "";
  options.forEach((node, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "recording-choice-option";
    button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === 0)); button.textContent = moveLabel(node);
    button.addEventListener("click", () => { choice._selectedIndex = index; confirmRecordingChoice(); }); list.append(button);
  });
  choice.hidden = false; selectRecordingChoice(0);
}

function recordingArrowConfig(items = []) {
  const brushes = {}, shapes = [];
  for (const [index, move] of items.entries()) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.uci || "")) continue;
    // One native Chessground brush per probability: colour remains uniform,
    // while both opacity and line width rise monotonically with likelihood.
    const probability = Math.max(0.100001, Math.min(1, Number(move.probability)));
    const brush = `maia-${index}`;
    // Chessground requires every brush to carry a stable key: it uses the key
    // for the SVG marker id. Without it, its native renderer throws while
    // creating the marker, leaving a successful Maia response arrowless.
    brushes[brush] = { key: brush, color: "#dc2626", opacity: 0.34 + probability * 0.60, lineWidth: 5 + probability * 13 };
    shapes.push({ orig: move.uci.slice(0, 2), dest: move.uci.slice(2, 4), brush });
  }
  return { shapes, brushes };
}
function renderRecordingBoard() {
  const { shapes, brushes } = recordingArrowConfig(state.recordingSuggestions);
  recordingBoard.render(state.position, { interactive: false, flipped: state.flipped, locked: true, suggestionShapes: shapes, suggestionBrushes: brushes });
  if ($("recording-harry-effect").classList.contains("active")) applyRecordingHarryTarget();
}
function renderRecording() {
  if (!state.document) return;
  const independent = Array.isArray(state.document.chapterSources);
  $("recording-chapter-controls").hidden = !independent;
  if (independent) {
    $("recording-active-chapter").innerHTML = state.document.chapterSources.map(chapter => `<option value="${escapeHTML(chapter.id)}" ${chapter.id === state.document.activeChapterID ? "selected" : ""}>${escapeHTML(chapter.title)}</option>`).join("") || "<option>No chapters yet</option>";
  }
  renderRecordingTree(); renderRecordingBoard();
  const toggle = $("recording-maia-toggle");
  toggle.setAttribute("aria-pressed", String(state.recordingMaiaEnabled));
  const maiaToggleLabel = state.recordingMaiaEnabled ? "Hide top Maia moves" : "Show top Maia moves";
  toggle.setAttribute("aria-label", maiaToggleLabel); toggle.title = maiaToggleLabel;
  if (!state.recordingMaiaEnabled) $("recording-message").textContent = "";
  if (state.recordingMaiaEnabled && state.view === "recording" && !state.recordingMaiaAbort && !state.recordingSuggestions.length) queueRecordingMaia();
}
function clearRecordingMaia() {
  state.recordingMaiaAbort?.abort(); state.recordingMaiaAbort = null;
  state.recordingMaiaToken += 1; state.recordingSuggestions = [];
  if (state.view === "recording") renderRecordingBoard();
}
function recordingPositionKey(document = state.document, nodeID = state.currentNodeID) {
  return `${document?.activeChapterID || ""}:${document ? movesToNode(document, nodeID).join(" ") : ""}`;
}
function setEffectivePosition(document, nodeID = state.currentNodeID) {
  // This is the sole effective-position boundary for navigation and document
  // replacement. Invalidate before assignment so an already pending Maia reply
  // cannot paint arrows for the position we are leaving.
  if (recordingPositionKey(document, nodeID) !== recordingPositionKey()) disableRecordingMaiaForPositionChange();
  state.document = document; state.currentNodeID = nodeID;
}
function disableRecordingMaiaForPositionChange() {
  // Maia arrows are temporary position-specific marks.  Invalidate the
  // request before changing node so a late response cannot redraw them.
  state.recordingMaiaEnabled = false;
  clearRecordingMaia();
}
function clearRecordingEffect() {
  clearTimeout(state.recordingEffectTimer); cancelAnimationFrame(state.recordingEffectFrame); state.recordingEffectTimer = null; state.recordingEffectFrame = null;
  const effect = $("recording-effect"); effect.classList.remove("active", "recording-viking-active"); effect.style.backgroundImage = "";
  const harry = $("recording-harry-effect"); harry.classList.remove("active"); harry.style.backgroundImage = ""; delete harry.dataset.square;
  $("recording-board").querySelectorAll("piece.harry-hidden").forEach(piece => piece.classList.remove("harry-hidden"));
  const pipe = $("recording-pipe-effect"); pipe.pause(); pipe.currentTime = 0; pipe.classList.remove("active");
}
function playRecordingLibraryEffect(item) {
  clearRecordingEffect();
  const pipe = $("recording-pipe-effect");
  pipe.src = `${item.url}${item.url.includes("?") ? "&" : "?"}play=${Date.now()}`;
  pipe.classList.add("active");
  pipe.play().catch(() => clearRecordingEffect());
}
async function loadEffects() {
  try { state.effects = (await api.effects()).effects || []; renderEffects(); renderRecordingEffects(); }
  catch (error) { $("effects-list").textContent = error.message; }
}
function renderRecordingEffects() {
  const select = $("recording-effects"), value = select.value;
  // Harry is position-derived rather than a library asset. Shipped files and
  // custom uploads share the API list, so their names stay in sync here.
  select.innerHTML = `<option value="">Effects</option>${state.effects.map(item => `<option value="library:${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join("")}<option value="harry">Harry</option>`;
  select.value = value;
}
function renderEffects() {
  const list = $("effects-list");
  list.innerHTML = state.effects.map(item => { const preview = /\\.webp(?:[?#]|$)/i.test(item.url) ? `<img src="${escapeHTML(item.url)}" alt="">` : `<video muted playsinline loop src="${escapeHTML(item.url)}"></video>`; const reset = item.builtin ? "Reset" : "Delete"; return `<article class="tool-card effect-row" data-effect-id="${escapeHTML(item.id)}">${preview}<strong>${escapeHTML(item.name)}${item.builtin ? '<small>Built-in</small>' : ''}</strong><span>${(item.durationMilliseconds / 1000).toFixed(1)}s</span><button class="secondary" data-effect-rename>Rename</button><label class="secondary file-action">Replace<input type="file" accept="video/webm" data-effect-replace></label><button class="secondary danger" data-effect-delete>${reset}</button></article>`; }).join("") || `<div class="empty-state"><p>No saved effects yet.</p></div>`;
  list.querySelectorAll("video").forEach(video => { video.play().catch(() => {}); });
  list.querySelectorAll("[data-effect-rename]").forEach(button => button.addEventListener("click", async () => { const id = button.closest("[data-effect-id]").dataset.effectId, item = state.effects.find(effect => effect.id === id), name = prompt("Effect name", item?.name || ""); if (name === null) return; try { await api.renameEffect(id, name); await loadEffects(); } catch (error) { showStatus(error.message, true); } }));
  list.querySelectorAll("[data-effect-delete]").forEach(button => button.addEventListener("click", async () => { const id = button.closest("[data-effect-id]").dataset.effectId, item = state.effects.find(effect => effect.id === id), message = item?.builtin ? "Reset this built-in effect to its original name and media?" : "Delete this shared effect?"; if (!confirm(message)) return; try { await api.deleteEffect(id); await loadEffects(); } catch (error) { showStatus(error.message, true); } }));
  list.querySelectorAll("[data-effect-replace]").forEach(input => input.addEventListener("change", async () => { const file = input.files[0]; if (!file) return; try { await api.uploadEffect("", file, input.closest("[data-effect-id]").dataset.effectId); await loadEffects(); } catch (error) { showStatus(error.message, true); } }));
}
function previewEffectFile() { const file = $("effect-file").files[0]; if (state.effectPreviewURL) URL.revokeObjectURL(state.effectPreviewURL); state.effectPreviewURL = file ? URL.createObjectURL(file) : null; $("effect-preview-video").src = state.effectPreviewURL || ""; $("effect-preview").hidden = !file; $("effect-save").disabled = !(file && $("effect-name").value.trim()); }
function playRecordingExplosion() {
  const effect = $("recording-effect"), reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches, duration = reduced ? 450 : 4000;
  clearRecordingEffect();
  // A fresh resource identity restarts the animated WebP on every selection;
  // the physical asset remains the single cached source file.
  effect.style.backgroundImage = `url("${recordingExplosionSource}?play=${Date.now()}")`;
  void effect.offsetWidth;
  effect.classList.add("active");
  state.recordingEffectTimer = window.setTimeout(clearRecordingEffect, duration);
}
function playRecordingViking() {
  const effect = $("recording-effect"), reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches, duration = reduced ? 450 : 3000;
  clearRecordingEffect();
  effect.style.backgroundImage = `url("${recordingVikingSource}?play=${Date.now()}")`;
  void effect.offsetWidth;
  effect.classList.add("active", "recording-viking-active");
  state.recordingEffectTimer = window.setTimeout(clearRecordingEffect, duration);
}
function recordingWhiteHPawnSquare(fen = "") {
  const pieces = pieceMap(fen);
  return [1, 2, 3, 4, 5, 6, 7, 8].map(rank => `h${rank}`).find(square => pieces[square] === "P") || null;
}
function applyRecordingHarryTarget() {
  const harry = $("recording-harry-effect"), square = harry.dataset.square;
  $("recording-board").querySelectorAll("piece.harry-hidden").forEach(piece => piece.classList.remove("harry-hidden"));
  if (!square) return;
  const piece = [...$("recording-board").querySelectorAll("piece.white.pawn")].find(candidate => candidate.cgKey === square);
  if (!piece) return;
  const rank = Number(square[1]);
  harry.style.left = `${state.flipped ? 0 : 87.5}%`;
  harry.style.top = `${(state.flipped ? rank - 1 : 8 - rank) * 12.5}%`;
  piece.classList.add("harry-hidden");
}
function playRecordingHarry() {
  const square = recordingWhiteHPawnSquare(state.position?.fen);
  if (!square) return;
  clearRecordingEffect();
  const harry = $("recording-harry-effect");
  harry.dataset.square = square;
  harry.style.backgroundImage = `url("${recordingVikingSource}?play=${Date.now()}")`;
  applyRecordingHarryTarget();
  void harry.offsetWidth;
  harry.classList.add("active");
  state.recordingEffectTimer = window.setTimeout(clearRecordingEffect, 3000);
}
function playRecordingPipe() {
  clearRecordingEffect();
  const pipe = $("recording-pipe-effect");
  pipe.src = recordingPipeSource;
  pipe.classList.add("active");
  pipe.play().catch(() => clearRecordingEffect());
}
async function queueRecordingMaia() {
  if (!state.recordingMaiaEnabled || state.view !== "recording" || !state.document || !state.position) return;
  clearRecordingMaia();
  const abort = new AbortController(), token = ++state.recordingMaiaToken;
  state.recordingMaiaAbort = abort;
  const moves = movesToNode(state.document, state.currentNodeID), positionKey = moves.join(" ");
  $("recording-message").textContent = "Maia is considering likely human moves…";
  try {
    const data = await analysisAPI.maia(moves, 1500, 1500, { signal: abort.signal });
    const current = !abort.signal.aborted && state.recordingMaiaEnabled && state.view === "recording" && token === state.recordingMaiaToken && movesToNode(state.document, state.currentNodeID).join(" ") === positionKey;
    if (!current) return;
    state.recordingSuggestions = [...(data?.suggestions || [])]
      .filter(move => Number(move.probability) > 0.10)
      .sort((left, right) => Number(right.probability) - Number(left.probability))
      .slice(0, 5);
    renderRecordingBoard();
    $("recording-message").textContent = state.recordingSuggestions.length ? `Showing ${state.recordingSuggestions.length} likely Maia move${state.recordingSuggestions.length === 1 ? "" : "s"}.` : "No Maia moves cleared the 10% threshold.";
  } catch (error) {
    if (!abort.signal.aborted && token === state.recordingMaiaToken) $("recording-message").textContent = error.message;
  } finally {
    if (state.recordingMaiaAbort === abort) state.recordingMaiaAbort = null;
  }
}
function navigate(id) { if (id === state.currentNodeID) return; closeRecordingChoice(); clearRecordingEffect(); setEffectivePosition(state.document, id); state.selectedSquare = null; state.analysisToken += 1; stopEditorMaia(); renderMoveTree(); renderRecordingTree(); renderInspector(); if (state.view === "recording") requestAnimationFrame(scrollRecordingCurrentIntoView); refreshPosition(); }
function nextNode() { return childrenOf(state.document, state.currentNodeID)[0] || null; }
function endNode() { let id=state.currentNodeID,next; while ((next=childrenOf(state.document,id)[0])) id=next.id; return id; }

function renderInspector() {
  const inspector = $("move-inspector"), node = nodeByID(state.document, state.currentNodeID);
  const expanded = state.editorPanels.inspector;
  if (!node) {
    inspector.className = "tool-card collapsible-card";
    inspector.innerHTML = `<div class="card-heading"><div><p class="eyebrow">Selected move</p><h2>Starting position</h2></div>${editorPanelButton("inspector", "Selected move")}</div><div id="move-inspector-content" class="empty-state" ${expanded?"":"hidden"}><p>Play a move on the board to begin or extend the repertoire.</p></div>`;
    bindEditorPanelButtons(inspector);
    return;
  }
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
  inspector.className = "tool-card collapsible-card";
  inspector.innerHTML = `<div class="inspector-head"><div><p class="eyebrow">Selected move</p><h2>${escapeHTML(moveLabel(node))}</h2></div><div class="inspector-head-actions"><div class="inspector-actions"><button data-action="earlier" ${siblingIndex===0?"disabled":""} title="Move variation earlier">↑</button><button data-action="later" ${siblingIndex===siblings.length-1?"disabled":""} title="Move variation later">↓</button><button data-action="promote" ${siblingIndex===0?"disabled":""}>Make main</button><button data-action="delete" class="danger">Delete line</button></div>${editorPanelButton("inspector", "Selected move")}</div></div>
    <div id="move-inspector-content" class="collapsible-content" ${expanded?"":"hidden"}><label>${commentLabel}<textarea id="node-comment" rows="5" placeholder="What should the learner understand or remember?">${escapeHTML(node.comment)}</textarea><small>${variationHelp}</small></label>
    ${learnerMove&&siblingIndex===0?`<label>Hint<textarea id="node-hint" rows="2" maxlength="240" placeholder="Optional, e.g. Look for checks.">${escapeHTML(node.hint||"")}</textarea><small>Shown after a mistake. Leave empty when this position needs no hint.</small></label>`:""}</div>`;
  bindEditorPanelButtons(inspector);
  const update = patch => commit(updateNode(state.document, node.id, patch));
  $("node-comment").addEventListener("change", event => update({ comment: event.target.value }));
  $("node-hint")?.addEventListener("change", event => update({ hint: event.target.value.trim().replace(/\s+/g," ") }));
  inspector.querySelectorAll("textarea,input").forEach(control=>control.addEventListener("input",markPendingInput));
  inspector.querySelector('[data-action="promote"]').addEventListener("click", () => commit(promoteVariation(state.document,node.id)));
  inspector.querySelector('[data-action="earlier"]').addEventListener("click", () => commit(reorderVariation(state.document,node.id,-1)));
  inspector.querySelector('[data-action="later"]').addEventListener("click", () => commit(reorderVariation(state.document,node.id,1)));
  inspector.querySelector('[data-action="delete"]').addEventListener("click", () => { if(confirm(`Delete ${node.san} and every move after it in this branch?`)){const parent=node.parentId;commit(removeBranch(state.document,node.id),{navigateTo:parent});refreshPosition();} });
}

function editorPanelButton(name, label) {
  const expanded = state.editorPanels[name];
  const action = `${expanded?"Collapse":"Expand"} ${label}`;
  return `<button class="collapse-button" type="button" data-editor-panel-toggle="${name}" aria-expanded="${expanded}" aria-label="${action}" title="${action}"><span aria-hidden="true">${expanded?"⌃":"⌄"}</span></button>`;
}
function bindEditorPanelButtons(root=document) {
  root.querySelectorAll("[data-editor-panel-toggle]").forEach(button=>{
    if(button.dataset.panelBound)return;
    button.dataset.panelBound="true";
    button.addEventListener("click",()=>toggleEditorPanel(button.dataset.editorPanelToggle));
  });
}
function renderEditorPanels() {
  const controls = {
    tree: { content: $("move-tree"), label: "Variation tree" },
    inspector: { content: $("move-inspector-content"), label: "Selected move" },
    maia: { content: $("maia-results"), label: "Maia moves" },
  };
  for(const [name,{content,label}] of Object.entries(controls)){
    if(!content)continue;
    const expanded=state.editorPanels[name];
    content.hidden=!expanded;
    content.closest(".collapsible-card")?.classList.toggle("is-collapsed",!expanded);
    const button=document.querySelector(`[data-editor-panel-toggle="${name}"]`);
    if(button){const action=`${expanded?"Collapse":"Expand"} ${label}`;button.setAttribute("aria-expanded",String(expanded));button.setAttribute("aria-label",action);button.title=action;button.querySelector("span").textContent=expanded?"⌃":"⌄";}
  }
  bindEditorPanelButtons();
}
function toggleEditorPanel(name) {
  if(!(name in state.editorPanels))return;
  if(name==="inspector"&&!state.editorPanels.inspector)renderInspector();
  state.editorPanels[name]=!state.editorPanels[name];
  renderEditorPanels();
  if(name!=="maia")return;
  state.analysisToken+=1;
  if(state.editorPanels.maia)queueEditorMaiaAnalysis();
  else {stopEditorMaia();$("maia-results").innerHTML='<div class="empty-state"><p>Expand to see likely human moves.</p></div>';}
}

function stopEditorMaia() {
  state.editorMaiaAbort?.abort();
  state.editorMaiaAbort = null;
}
async function queueEditorMaiaAnalysis() {
  if (!state.editorPanels.maia || state.view !== "editor" || !state.document) return;
  stopEditorMaia();
  const abort = new AbortController(); state.editorMaiaAbort = abort;
  const token=++state.analysisToken, moves=movesToNode(state.document,state.currentNodeID), positionKey=moves.join(" ");
  $("maia-results").innerHTML='<div class="empty-state"><p>Maia is considering likely human choices…</p></div>';
  const isCurrent=()=>!abort.signal.aborted&&state.editorPanels.maia&&state.view==="editor"&&token===state.analysisToken&&movesToNode(state.document,state.currentNodeID).join(" ")===positionKey;
  try {
    const rating=Number($("maia-rating").value);
    const data=await analysisAPI.maia(moves,rating,Number(state.document.metadata.opponentRating||rating),{signal:abort.signal});
    if(isCurrent())renderMaia(data.suggestions,token,positionKey);
  } catch(error) {
    if(isCurrent())$("maia-results").innerHTML=`<div class="empty-state"><p>${escapeHTML(error.message)}</p></div>`;
  } finally {
    if(state.editorMaiaAbort===abort)state.editorMaiaAbort=null;
  }
}
function renderMaia(items=[],token,positionKey) {
  const existingByUCI=new Map(childrenOf(state.document,state.currentNodeID).map(node=>[node.uci,node]));
  $("maia-results").innerHTML=items.map((move,index)=>{
    const existing=existingByUCI.get(move.uci),action=existing?"Show line":"Add line";
    return `<div class="suggestion-row"><span>${index+1}</span><span class="move">${escapeHTML(move.san)}</span><span class="meter"><i style="width:${Math.max(0,Math.min(100,move.probability*100))}%"></i></span><button data-accept-move="${escapeHTML(move.uci)}" data-san="${escapeHTML(move.san)}"${existing?` data-existing-node="${escapeHTML(existing.id)}"`:""}>${action} · ${(move.probability*100).toFixed(1)}%</button></div>`;
  }).join("")||'<div class="empty-state"><p>No suggestions returned.</p></div>';
  bindSuggestedMoves(token,positionKey);
}
function bindSuggestedMoves(token,positionKey){$("maia-results").querySelectorAll("[data-accept-move]").forEach(button=>button.addEventListener("click",()=>{if(token!==state.analysisToken||movesToNode(state.document,state.currentNodeID).join(" ")!==positionKey)return showStatus("That suggestion belongs to an older position. Wait for Maia to update before adding it.",true);if(button.dataset.existingNode){navigate(button.dataset.existingNode);showStatus(`${button.dataset.san} is already in the repertoire.`);return}const result=addMove(state.document,state.currentNodeID,{uci:button.dataset.acceptMove,san:button.dataset.san});commit(result.document,{navigateTo:result.node.id});refreshPosition();showStatus(`${button.dataset.san} added. You remain in control of the explanation.`);}));}
// Diagnostics are capabilities for one exact source, not reusable chapter-local node IDs.
function invalidateDiagnostics() {
  state.diagnosticGeneration += 1;
  state.writingRequest += 1; state.coverageRequest += 1;
  for (const id of ["writing-results", "writing-summary", "gap-results"]) {
    const element = $(id); if (element) element.innerHTML = "";
  }
  setBusy($("run-spellcheck"), false); setBusy($("run-gap-check"), false);
}
function diagnosticContext() {
  return { courseID: state.courseID, chapterID: state.document?.activeChapterID,
    generation: state.diagnosticGeneration, source: JSON.stringify(state.document) };
}
function diagnosticIsCurrent(context) {
  return Boolean(context && state.document && context.courseID === state.courseID
    && context.chapterID === state.document.activeChapterID
    && context.generation === state.diagnosticGeneration
    && context.source === JSON.stringify(state.document));
}
function requireCurrentDiagnostic(context) {
  flushActiveEditor();
  if (diagnosticIsCurrent(context)) return true;
  showStatus("This check belongs to an older chapter or edit. Run the check again.", true);
  return false;
}
function writingIssueIsCurrent(issue) {
  if (!diagnosticIsCurrent(issue.context)) return false;
  const source = writingSources().find(item => item.sourceId === issue.sourceId);
  return Boolean(source && source.comment === issue.comment
    && Number.isInteger(issue.start) && Number.isInteger(issue.end)
    && issue.start >= 0 && issue.end >= issue.start && issue.end <= source.comment.length);
}
async function runGapCheck(){
  flushActiveEditor();
  const context=diagnosticContext(), request=++state.coverageRequest;
  const isCurrent=()=>request===state.coverageRequest&&diagnosticIsCurrent(context);
  const button=$("run-gap-check"); setBusy(button,true,"Checking…");
  try {
    const pgn=await exportSource();
    if(!isCurrent())return;
    const data=await analysisAPI.repertoireGaps(pgn,state.document.metadata.side,Number($("maia-rating").value),.15);
    if(!isCurrent())return;
    const findings=(data.findings||[]).map(finding=>({ ...finding, context, nodeID: nodeIDForHistory(finding.history) }));
    $("gap-results").innerHTML=findings.map((finding,index)=>{
      const missing=(finding.missing||[]).filter(move=>!state.document.ignoredSuggestionIDs.includes(gapSuggestionID(finding,move)));
      if(!missing.length)return"";
      return `<article class="quality-item warning" data-gap="${index}"><span class="quality-icon">!</span><div><h3>${escapeHTML(finding.history||"Repertoire position")}</h3><p>${escapeHTML(missing.map(move=>`${move.san} ${(move.probability*100).toFixed(0)}%`).join(", "))} may need a line.</p><div class="quality-context"><span>Reach ${(100*(finding.reach_probability||0)).toFixed(1)}%</span><span>Missing mass ${(100*(finding.missing_probability_mass||0)).toFixed(1)}%</span><span>Existing ${(finding.existing_replies||[]).map(move=>escapeHTML(move.san)).join(", ")||"none"}</span></div><div class="quality-actions"><button data-gap-jump>Open position</button>${missing.map((move,moveIndex)=>`<button data-gap-add="${moveIndex}">Add ${escapeHTML(move.san)}</button><button data-gap-ignore="${moveIndex}">Deliberately omit ${escapeHTML(move.san)}</button>`).join("")}</div></div></article>`;
    }).join("")||qualityHTML("good",{area:"Coverage looks good",message:`No unreviewed missing responses above the threshold in ${data.positions_analyzed||0} checked positions.`});
    $("gap-results").querySelectorAll("[data-gap]").forEach(card=>{
      const finding=findings[Number(card.dataset.gap)], missing=(finding.missing||[]).filter(move=>!state.document.ignoredSuggestionIDs.includes(gapSuggestionID(finding,move)));
      card.querySelector("[data-gap-jump]")?.addEventListener("click",()=>jumpToFinding(finding));
      card.querySelectorAll("[data-gap-add]").forEach(control=>control.addEventListener("click",()=>addGapMove(finding,missing[Number(control.dataset.gapAdd)])));
      card.querySelectorAll("[data-gap-ignore]").forEach(control=>control.addEventListener("click",()=>{if(!requireCurrentDiagnostic(finding.context))return;const id=gapSuggestionID(finding,missing[Number(control.dataset.gapIgnore)]);commit({...state.document,ignoredSuggestionIDs:[...new Set([...state.document.ignoredSuggestionIDs,id])]});runGapCheck();}));
    });
  } catch(error){if(isCurrent())showStatus(error.message,true)} finally {if(request===state.coverageRequest)setBusy(button,false)}
}
function gapSuggestionID(finding,move){return`coverage:${finding.history||"start"}:${move.uci}`}
function nodeIDForHistory(history){
  if(!history||history==="Starting position")return null;
  for(const node of state.document.nodes){if(pgnHistory(pathToNode(state.document,node.id))===history)return node.id;}
  return undefined;
}
function pgnHistory(nodes){const chunks=[];for(let index=0;index<nodes.length;index+=2){let chunk=`${index/2+1}. ${nodes[index].san}`;if(nodes[index+1])chunk+=` ${nodes[index+1].san}`;chunks.push(chunk)}return chunks.join(" ")||"Starting position"}
function jumpToFinding(finding){if(!requireCurrentDiagnostic(finding.context))return;if(finding.nodeID===undefined)return showStatus("This finding no longer matches the edited tree. Run coverage again.",true);navigate(finding.nodeID);switchView("editor")}
function addGapMove(finding,move){if(!requireCurrentDiagnostic(finding.context))return;if(!move)return;if(finding.nodeID===undefined)return showStatus("Run coverage again after the latest edits.",true);const result=addMove(state.document,finding.nodeID,move);commit(result.document,{navigateTo:result.node.id});refreshPosition();switchView("editor");showStatus(`${move.san} added. Add the author explanation before publishing.`)}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed=Boolean(collapsed);
  $("studio").classList.toggle("sidebar-collapsed",state.sidebarCollapsed);
  const button=$("toggle-sidebar"),label=state.sidebarCollapsed?"Expand menu":"Collapse menu";
  button.setAttribute("aria-pressed",String(state.sidebarCollapsed));button.setAttribute("aria-label",label);button.title=label;
  button.querySelector("span").textContent=state.sidebarCollapsed?"»":"«";
  try{localStorage.setItem(SIDEBAR_KEY,state.sidebarCollapsed?"1":"0")}catch{/* unavailable */}
}
function restoreSidebarPreference(){let collapsed=false;try{collapsed=localStorage.getItem(SIDEBAR_KEY)==="1"}catch{/* unavailable */}setSidebarCollapsed(collapsed)}

function writingSources(){
  const sources=[];
  const metadataFields=["title","subtitle","description"];
  for(const field of metadataFields){const value=String(state.document.metadata[field]||"");if(value.trim())sources.push({sourceId:`metadata:${field}`,history:`Course ${field}`,comment:value});}
  for(const node of state.document.nodes){
    if(node.comment.trim())sources.push({sourceId:`comment:${node.id}`,history:moveLabel(node),comment:node.comment,allowLowercaseOpening:true});
    if(node.hint?.trim())sources.push({sourceId:`hint:${node.id}`,history:`Hint after ${moveLabel(node)}`,comment:node.hint});
    if(node.startingComment.trim())sources.push({sourceId:`starting:${node.id}`,history:`Before ${moveLabel(node)}`,comment:node.startingComment});
  }
  return sources;
}
function loadIgnoredWords(){return [...state.ignoredWords]}
async function runSpellcheck({refreshDictionary=true}={}) {
  flushActiveEditor();
  const context=diagnosticContext(), request=++state.writingRequest;
  const isCurrent=()=>request===state.writingRequest&&diagnosticIsCurrent(context);
  const button=$("run-spellcheck");setBusy(button,true,"Checking…");
  try {
    if(refreshDictionary)await refreshIgnoredWords();
    if(!isCurrent())return;
    const sources=writingSources(),issues=await checkWriting(sources,{ignoredWords:loadIgnoredWords()});
    if(isCurrent())renderWriting(issues.map(issue=>({...issue,context})),sources.length);
  }catch(error){if(isCurrent())showStatus(error.message,true)}
  finally{if(request===state.writingRequest)setBusy(button,false)}
}
async function ignoreWritingWord(issue,button){if(!requireCurrentDiagnostic(issue.context))return;setBusy(button,true,"Adding…");try{const payload=await api.addIgnoredWord(issue.problem);state.ignoredWords=[...(payload?.words||state.ignoredWords)];showStatus(`“${issue.problem}” added to the shared dictionary.`);if(diagnosticIsCurrent(issue.context))await runSpellcheck({refreshDictionary:false});}catch(error){showStatus(`Could not add “${issue.problem}” to the shared dictionary: ${error.message}`,true);setBusy(button,false)}}
function renderWriting(issues,count){const bulkFixes=new Map(groupWritingBulkFixes(issues).map(fix=>[fix.key,fix]));const bulkHTML=[...bulkFixes.values()].map(fix=>`<div class="heading-actions"><button class="primary" data-writing-fix-all="${escapeHTML(fix.key)}">${escapeHTML(fix.label)} (${fix.issues.length})</button></div>`).join("");$("writing-summary").innerHTML=`<div class="stat"><strong>${count}</strong><span>Writing fields checked</span></div><div class="stat"><strong>${issues.length}</strong><span>Suggestions</span></div><div class="stat"><strong>${loadIgnoredWords().length}</strong><span>Shared words</span></div>`;$("writing-results").innerHTML=bulkHTML+issues.map((issue,index)=>`<article class="quality-item warning" data-writing="${index}"><span class="quality-icon">!</span><div><h3>${escapeHTML(issue.history)} · ${escapeHTML(issue.kind)}</h3><p>${highlight(issue.comment,issue.start,issue.end)}</p><p>${escapeHTML(issue.message)}</p><div class="heading-actions">${issue.suggestions.map((suggestion,suggestionIndex)=>`<button data-writing-fix="${suggestionIndex}">${escapeHTML(writingSuggestionLabel(issue.problem,suggestion))}</button>`).join("")}<button data-writing-custom>Custom fix…</button>${issue.canIgnore?`<button data-writing-ignore>Add “${escapeHTML(issue.problem)}” to shared dictionary</button>`:""}</div></div></article>`).join("")||qualityHTML("good",{area:"Writing looks clean",message:`No issues found in ${count} writing fields.`});$("writing-results").querySelectorAll("[data-writing-fix-all]").forEach(button=>button.addEventListener("click",()=>{const fix=bulkFixes.get(button.dataset.writingFixAll);if(fix)applyWritingFixAll(fix.issues,fix.replacement)}));$("writing-results").querySelectorAll("[data-writing]").forEach(card=>{const issue=issues[Number(card.dataset.writing)];card.querySelectorAll("[data-writing-fix]").forEach(button=>button.addEventListener("click",()=>applyWritingFix(issue,issue.suggestions[Number(button.dataset.writingFix)])));card.querySelector("[data-writing-custom]")?.addEventListener("click",()=>{const value=prompt(`Replace “${issue.problem}” with`,issue.problem);if(value!==null)applyWritingFix(issue,value)});card.querySelector("[data-writing-ignore]")?.addEventListener("click",event=>ignoreWritingWord(issue,event.currentTarget));});}
function highlight(text,start,end){return`${escapeHTML(text.slice(0,start))}<mark>${escapeHTML(text.slice(start,end))}</mark>${escapeHTML(text.slice(end))}`}
function applyWritingFix(issue,replacement){if(!requireCurrentDiagnostic(issue.context)||!writingIssueIsCurrent(issue))return;const [kind,key]=String(issue.sourceId).split(":");if(kind==="metadata"){const current=String(state.document.metadata[key]||"");const text=current.slice(0,issue.start)+replacement+current.slice(issue.end);commit({...state.document,metadata:{...state.document.metadata,[key]:text}});}else{const node=nodeByID(state.document,key);if(!node)return;const field=kind==="starting"?"startingComment":kind==="hint"?"hint":"comment",current=node[field]||"";const text=current.slice(0,issue.start)+replacement+current.slice(issue.end);commit(updateNode(state.document,key,{[field]:text}));}runSpellcheck();}
function applyWritingFixAll(issues,replacement){if(!issues.length||!requireCurrentDiagnostic(issues[0].context)||!issues.every(writingIssueIsCurrent))return;let document=state.document;const grouped=new Map();for(const issue of issues){const group=grouped.get(issue.sourceId)||[];group.push(issue);grouped.set(issue.sourceId,group)}for(const [sourceId,sourceIssues] of grouped){const [kind,key]=String(sourceId).split(":");const ordered=[...sourceIssues].sort((left,right)=>right.start-left.start);if(kind==="metadata"){let text=String(document.metadata[key]||"");for(const issue of ordered)text=text.slice(0,issue.start)+replacement+text.slice(issue.end);document={...document,metadata:{...document.metadata,[key]:text}};continue}const node=nodeByID(document,key);if(!node)continue;const field=kind==="starting"?"startingComment":kind==="hint"?"hint":"comment";let text=node[field]||"";for(const issue of ordered)text=text.slice(0,issue.start)+replacement+text.slice(issue.end);document=updateNode(document,key,{[field]:text})}commit(document);runSpellcheck();}

function renderChapters(){
  if(!state.document)return;
  if(Array.isArray(state.document.chapterSources)) return renderIndependentChapters();
  $("chapter-board").hidden=false;
  $("chapter-position").closest("aside").hidden=false;
  $("studio-chapters").parentElement.classList.remove("independent-chapter-layout");
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
  if(!chapters.length||!chapters.some(chapter=>chapter.positions.length)){previewBoard.render(null);$("preview-card").innerHTML='<div class="empty-state"><p>Add learner moves before previewing the course.</p></div>';return;}
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
function renderPreviewBoard(){previewBoard.render(state.previewPosition,{interactive:true,flipped:state.flipped,locked:Boolean(state.previewAttempt?.correct)})}
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
function normalizeCheck(item){if(typeof item==="string")return{area:"Validation",message:item};const area=item.area||item.path||(item.code==="chapter_size"?"Chapters":"Validation");return{area,message:item.message||item.detail||"Course issue",...(item.nodeID?{nodeID:String(item.nodeID)}:{}),...(item.chapterID?{chapterID:String(item.chapterID)}:{})}}
function uniqueChecks(items){const seen=new Set();return items.map(normalizeCheck).filter(item=>{const key=`${item.area}|${item.message}`.toLocaleLowerCase("en-GB").replace(/\b(?:has|contains)\b/g,"").replace(/\bpositions?\b/g,"position").replace(/[^a-z0-9|]+/g," ").trim();if(seen.has(key))return false;seen.add(key);return true})}
function renderQuality(validation=state.validation){const checks=combinedValidation(validation),count=checks.blockers.length;$("quality-count").textContent=count||"";$("quality-summary").innerHTML=`<div class="stat"><strong>${checks.blockers.length}</strong><span>Publish blockers</span></div><div class="stat"><strong>${checks.warnings.length}</strong><span>Warnings to review</span></div><div class="stat"><strong>${trainingPack(state.document,state.document.metadata.slug||"draft").positions.length}</strong><span>Training positions</span></div>`;$("quality-results").innerHTML=[...checks.blockers.map(item=>qualityHTML("blocker",item,true)),...checks.warnings.map(item=>qualityHTML("warning",item,true))].join("")||qualityHTML("good",{area:"Ready to publish",message:"No blockers or warnings found."});$("quality-results").querySelectorAll("[data-quality-area]").forEach(button=>button.addEventListener("click",()=>reviewQualityItem(button)));return checks;}
function qualityHTML(type,item,navigate=false){return`<article class="quality-item ${type}"><span class="quality-icon">${type==="good"?"✓":type==="blocker"?"×":"!"}</span><div><h3>${escapeHTML(item.area)}</h3><p>${escapeHTML(item.message)}</p>${navigate?`<div class="quality-actions"><button data-quality-area="${escapeHTML(item.area)}"${item.chapterID?` data-quality-chapter="${escapeHTML(item.chapterID)}"`:""}${item.nodeID?` data-quality-node="${escapeHTML(item.nodeID)}"`:""}>Review this area</button></div>`:""}</div></article>`}
function reviewQualityItem(button){if(button.dataset.qualityChapter)selectIndependentChapter(button.dataset.qualityChapter,button.dataset.qualityNode?"editor":"chapters");else switchView(areaView(button.dataset.qualityArea));if(button.dataset.qualityNode)navigate(button.dataset.qualityNode)}
function areaView(area){const value=String(area).toLowerCase();if(value.includes("chapter"))return"chapters";if(value.includes("writing")||value.includes("feedback"))return"writing";if(value.includes("video"))return"game-videos";if(value.includes("detail")||value.includes("metadata"))return"details";return"editor"}
async function runQuality({forPublish=false}={}){
  const button=$("refresh-quality");setBusy(button,true,"Checking…");
  try{
    if(dirty()&&!await saveDraft({quiet:true}))return null;
    // A failed fresh request must not leave yesterday's zero-blocker result
    // looking authoritative. This is a service-check blocker, not course data.
    state.validation={valid:false,errors:[{area:"Server checks",message:"Server checks are running; publish readiness is not confirmed yet."}],warnings:[]};
    renderQuality();
    state.validation=await api.validateCourse(state.courseID,state.revision);
    renderQuality();showStatus("Quality checks complete.");return state.validation;
  }catch(error){
    state.validation={valid:false,errors:[{area:"Server checks",message:`Server checks could not complete. No course edit is required to fix this service error. ${error.message}`}],warnings:[]};
    renderQuality();
    showStatus(forPublish?`Publish stopped during quality checks. No publication request was sent. ${error.message}`:error.message,true);return null;
  }finally{setBusy(button,false)}
}
function resolveCompiledChapters(validation){if(Array.isArray(state.document.chapterSources))return (validation?.compiledPreview?.chapters?.length||0)===state.document.chapterSources.length;const preview=validation?.compiledPreview||validation?.preview||validation?.compiled_pack;const compiledPositions=[...(preview?.positions||[])].sort((a,b)=>(a.learningOrder??0)-(b.learningOrder??0));const localPositions=trainingPack(state.document,state.document.metadata.slug||"draft").positions;if(!compiledPositions.length||compiledPositions.length!==localPositions.length)return false;if(compiledPositions.some(position=>!String(position.id||"").startsWith("sha256:")))return false;const drafts=ensureChapters(state.document,state.document.metadata.slug||"draft"),indexByLocal=new Map(localPositions.map((position,index)=>[position.id,index]));state.document.chapters=drafts.map((draft,index)=>{const start=index===0?0:indexByLocal.get(draft.startNodeID),end=index+1===drafts.length?compiledPositions.length:indexByLocal.get(drafts[index+1].startNodeID);return{id:draft.id,title:draft.title,positionIDs:compiledPositions.slice(start,end).map(position=>position.id)};});return true;}
function beginPublish(){return publishPreparationFlight.run(preparePublish)}
async function preparePublish(){
  const button=$("publish");setBusy(button,true,"Preparing…");
  try{
  state.publishCandidate=null;
  if(!await saveDraft({quiet:true})) return;
  let validation=await runQuality({forPublish:true}); if(!validation) return;
  const checks=combinedValidation(validation);
  if(checks.blockers.length){switchView("quality");return showStatus("Fix the publish blockers first.",true);}
  if(!Array.isArray(state.document.chapterSources)&&!state.document.chapterDrafts.length) state.document.chapterDrafts=ensureChapters(state.document,state.document.metadata.slug||"draft");
  if(!resolveCompiledChapters(validation)) return showStatus("The compiled chapter positions could not be matched safely. Publishing is blocked.",true);
  if(dirty()){if(!await saveDraft({quiet:true}))return;validation=await runQuality({forPublish:true});if(!validation)return;}
  const warnings=combinedValidation(validation).warnings;
  let history={versions:[]};try{history=await api.versions(state.courseID)}catch{/* publication still has local review */}
  if(dirty())return showStatus("The course changed while preparing. Press Publish again when you have finished editing.",true);
  const latest=(history.versions||[])[0],liveSummary=latest?.validation?.summary||{},positions=trainingPack(state.document,state.document.metadata.slug).positions.length,chapters=ensureChapters(state.document,state.document.metadata.slug).length;
  const changes=[
    latest?`Training positions: ${liveSummary.positionCount??"unknown"} → ${positions}`:`First publication with ${positions} training positions`,
    latest?`Chapters: ${liveSummary.chapterCount??"unknown"} → ${chapters}`:`${chapters} authored chapters`,
  ];
  if(validation.revision!==state.revision||typeof validation.revisionHash!=="string"||!validation.revisionHash){
    return showStatus("The server did not confirm the exact draft for publication. No publication request was sent. Reload the course before reviewing again.",true);
  }
  state.publishCandidate={courseID:state.courseID,revision:state.revision,revisionHash:validation.revisionHash,savedSnapshot:state.savedSnapshot,attempted:false};
  resetPublishFeedback();
  $("publish-review").innerHTML=`<p><strong>${escapeHTML(state.document.metadata.title)}</strong> will update in the live app after publication.</p><h3>Changes from ${latest?escapeHTML(latest.version):"no live version"}</h3><ul class="change-list">${changes.map(item=>`<li>${escapeHTML(item)}</li>`).join("")}</ul><h3>Warnings to accept (${warnings.length})</h3>${warnings.length?`<ul class="warning-list">${warnings.map(item=>`<li><strong>${escapeHTML(item.area)}</strong> · ${escapeHTML(item.message)}</li>`).join("")}</ul>`:'<p class="muted">No warnings.</p>'}<p class="muted">Published versions are immutable. You can restore one later without destroying history.</p>`;
  $("publish-dialog").showModal();
  }catch(error){showStatus(`Publish preparation stopped. No publication request was sent. ${error.message}`,true);}finally{setBusy(button,false)}
}
function resetPublishFeedback(){
  $("publish-feedback").hidden=true;$("publish-feedback").textContent="";
  $("publish-history").hidden=true;$("confirm-publish").hidden=false;
  $("confirm-publish").disabled=false;$("cancel-publish").textContent="Cancel";
}
function publishFeedback(message,kind){
  const feedback=$("publish-feedback");feedback.textContent=message;feedback.hidden=false;
  feedback.dataset.kind=kind;feedback.setAttribute("role",kind==="error"?"alert":"status");
  // The global toast is outside the modal top layer and inert while it is open.
  // Keep persistent, focusable feedback INSIDE the dialog, including long reviews.
  feedback.focus();feedback.scrollIntoView({block:"nearest"});
}
function confirmPublish(){return publishSubmissionFlight.run(submitReviewedPublication)}
async function submitReviewedPublication(){
  const button=$("confirm-publish"),candidate=state.publishCandidate;
  if(candidate?.attempted)return;
  if(!candidate||candidate.courseID!==state.courseID||candidate.revision!==state.revision||
     candidate.savedSnapshot!==state.savedSnapshot||typeof candidate.revisionHash!=="string"||!candidate.revisionHash||dirty()){
    state.publishCandidate=null;button.hidden=true;
    publishFeedback("The course changed after this review. Close this dialog and review the latest draft before publishing. No publication request was sent.","error");return;
  }
  candidate.attempted=true;publishPending=true;
  setBusy(button,true,"Publishing…");$("close-publish").disabled=true;$("cancel-publish").disabled=true;
  $("publish-dialog").setAttribute("aria-busy","true");
  publishFeedback("Publishing this reviewed draft… Please wait. Do not submit it again.","pending");
  let confirmedVersion=null;
  try{
    const result=await api.publishCourse(candidate.courseID,candidate.revision,candidate.revisionHash);
    confirmedVersion=result.version;state.revision=result.revision;state.savedSnapshot=candidate.savedSnapshot;
    state.publishCandidate=null;updateSaveState();
    publishFeedback(`Published ${confirmedVersion}. The app will receive the update automatically.`,"success");
    try{await loadCourses();await loadHistory({throwOnError:true});}
    catch{publishFeedback(`Published ${confirmedVersion}. The course or history display could not refresh. Close this dialog and reload to see the published version; do not publish again.`,"success");}
  }catch(error){
    // A failed/lost response may follow a committed transaction. Never retry it.
    publishFeedback(`Publication could not be confirmed. Check Version history before trying again. ${error.message}`,"error");
  }finally{
    publishPending=false;setBusy(button,false);button.hidden=true;button.disabled=true;
    $("close-publish").disabled=false;$("cancel-publish").disabled=false;
    $("cancel-publish").textContent=confirmedVersion?"Done":"Close";
    $("publish-history").hidden=false;$("publish-dialog").setAttribute("aria-busy","false");
  }
}
function closePublishDialog(){if(publishPending)return;state.publishCandidate=null;$("publish-dialog").close();}
function showPublicationHistory(){
  if(publishPending)return;closePublishDialog();switchView("history");
}

async function loadHistory({throwOnError=false}={}){if(!state.courseID)return;try{const payload=await api.versions(state.courseID);state.versions=payload.versions||[];const publications=state.versions.map((version,index)=>{const summary=version.validation?.summary||{};return`<article class="history-row"><div><h2>${escapeHTML(version.version||version.id||`Version ${state.versions.length-index}`)} ${index===0?'<span class="tag live">Live</span>':""}</h2><p>${escapeHTML(version.notes||"No release notes")}</p><p>${Number(summary.positionCount||0)} positions · ${Number(summary.chapterCount||0)} chapters · draft revision ${Number(version.documentRevision||0)}</p><p>Published ${escapeHTML(formatDate(version.publishedAt||version.createdAt))} by ${escapeHTML(version.publishedBy?.name||version.author||"Author")}</p></div><button class="secondary" data-restore="${escapeHTML(version.id||version.version)}">Restore as draft</button></article>`}).join("");const revisions=(payload.revisions||[]).slice(0,12).map(revision=>`<article class="history-row"><div><h2>Draft revision ${Number(revision.revision)}</h2><p>${escapeHTML(revision.reason||"save")} · ${escapeHTML(formatDate(revision.createdAt))}</p></div><span class="tag draft">Draft activity</span></article>`).join("");$("history-list").innerHTML=`${publications||'<div class="loading-card">No published versions yet.</div>'}${revisions?`<div class="page-heading compact"><div><h2>Recent draft activity</h2></div></div>${revisions}`:""}`;$("history-list").querySelectorAll("[data-restore]").forEach(button=>button.addEventListener("click",()=>restoreVersion(button.dataset.restore)));}catch(error){$("history-list").innerHTML=`<div class="loading-card">${escapeHTML(error.message)}</div>`;if(throwOnError)throw error;}}
async function restoreVersion(versionID){if(dirty()&&!confirm("Restoring will replace this unsaved draft. Continue?"))return;if(!confirm("Restore this published version as a new draft? The live course will not change until you publish again."))return;try{const payload=await api.restoreVersion(state.courseID,versionID,state.revision),raw=payload.draft||payload.document,draft=normalizeDocument(raw);draft.metadata.slug=payload.course?.slug||draft.metadata.slug;const revision=raw?.revision??payload.revision,hydrated=await hydrateSourceDocument(draft,state.courseID,revision);invalidateDiagnostics();state.revision=revision;setEffectivePosition(hydrated.document,null);state.reconciliationError=hydrated.reconciliationError;state.validation=hydrated.validation;state.savedSnapshot=JSON.stringify(state.document);state.publishCandidate=null;clearCrashRecovery();state.undo=[];state.redo=[];renderAll();refreshPosition();switchView("editor");showStatus("Version restored and rehydrated as a new draft.");}catch(error){showStatus(error.message,true)}}


async function importPGN(file) {if(!file)return;try{const pgn=await file.text(),preview=await api.importPGN(pgn),title=preview.inferredTitle&&preview.inferredTitle!=="?"?preview.inferredTitle:file.name.replace(/\.pgn$/i,"");state.pendingImport={pgn,fileName:file.name,moveCount:preview.moveCount};const form=$("import-form");form.reset();delete form.elements.slug.dataset.edited;form.elements.title.value=title;form.elements.slug.value=slugify(title);$("import-file-name").textContent=`${file.name} · ${Number(preview.moveCount||0)} moves`;$("import-dialog").showModal();}catch(error){showStatus(error.message,true)}}
function formatDate(value){if(!value)return"Unknown date";try{return new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value))}catch{return String(value)}}

$("login-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.submitter;setBusy(button,true,"Signing in…");$("login-error").textContent="";try{const session=await api.login($("login-email").value,$("login-password").value);setUser(session.user||session);$("login-password").value="";await showApp();}catch(error){$("login-error").textContent=error.message}finally{setBusy(button,false)}});
$("logout").addEventListener("click",async()=>{try{await api.logout()}finally{editorEngine.cancel();stopEditorMaia();state.editorEngineEnabled=false;state.document=null;state.savedSnapshot="";showLogin()}});
function setAccountMenu(open){$("account-menu").hidden=!open;$("account-button").setAttribute("aria-expanded",String(open));if(open)$("logout").focus()}
$("account-button").addEventListener("click",()=>setAccountMenu($("account-menu").hidden));
document.querySelectorAll(".nav-item").forEach(item=>item.addEventListener("click",()=>switchView(item.dataset.view)));
$("load-more-user-games").addEventListener("click",()=>loadUserGames({append:true}));
$("toggle-sidebar").addEventListener("click",()=>setSidebarCollapsed(!state.sidebarCollapsed));
document.querySelectorAll("[data-jump-editor]").forEach(button=>button.addEventListener("click",()=>switchView("editor")));
$("new-course").addEventListener("click",()=>{$("create-form").reset();delete $("create-form").elements.slug.dataset.edited;$("create-dialog").showModal()});
$("create-form").elements.title.addEventListener("input",event=>{const slug=$("create-form").elements.slug;if(!slug.dataset.edited)slug.value=slugify(event.target.value)});
$("create-form").elements.slug.addEventListener("input",event=>{event.target.dataset.edited="true"});
$("create-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));const document=newChapterCourse(data);try{const payload=await api.createCourse({...data,document});$("create-dialog").close();await loadCourses();await openCourse(payload.course?.id||payload.id)}catch(error){showStatus(error.message,true)}});
$("dashboard-import").addEventListener("change",event=>{importPGN(event.target.files[0]);event.target.value=""});
$("import-form").elements.title.addEventListener("input",event=>{const slug=$("import-form").elements.slug;if(!slug.dataset.edited)slug.value=slugify(event.target.value)});
$("import-form").elements.slug.addEventListener("input",event=>{event.target.dataset.edited="true"});
$("import-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();if(!state.pendingImport)return;const data=Object.fromEntries(new FormData(event.currentTarget));try{const parsed=await analysisAPI.parsePGN(state.pendingImport.pgn), document=addIndependentChapter(newChapterCourse(data),parsed,parsed.headers?.Event||'Chapter 1',`chapter-${crypto.randomUUID()}`), exported=await exportAllChapterSources(document);const payload=await api.createCourse({...data,document:documentForStorage(exported,'')});$("import-dialog").close();state.pendingImport=null;await loadCourses();await openCourse(payload.course?.id||payload.id)}catch(error){showStatus(error.message,true)}});
$("details-form").addEventListener("change",event=>{if(!event.target.name)return;const value=event.target.type==="number"?Number(event.target.value):event.target.type==="checkbox"?event.target.checked:event.target.value;const metadata={...state.document.metadata,[event.target.name]:value};if(event.target.name==="priceTier"){const pricing={free:{access:"free"},"usd-4.99":{access:"subscriber",displayPrice:"$4.99"},"usd-9.99":{access:"subscriber",displayPrice:"$9.99"},"usd-19.99":{access:"subscriber",displayPrice:"$19.99"}}[value];Object.assign(metadata,pricing);delete metadata.purchaseProductID;}commit({...state.document,metadata})});
$("details-form").addEventListener("input",()=>{$("save").disabled=false;$("save-state").textContent="Unsaved changes";$("save-state").className="save-state dirty"});
$("add-course-video").addEventListener("click", () => {
  commit({ ...state.document, metadata: { ...state.document.metadata, courseVideo: { id: videoID(), title: "", youtubeURL: "" } } });
  $("course-video-title").focus();
});
$("add-video").addEventListener("click",()=>replaceVideos([...videoItems(),{id:videoID(),title:"",youtubeURL:""}]));
$("save").addEventListener("click",()=>saveDraft());$("publish").addEventListener("click",beginPublish);$("undo").addEventListener("click",undo);$("redo").addEventListener("click",redo);
$("go-start").addEventListener("click",()=>navigate(null));$("go-back").addEventListener("click",()=>navigate(nodeByID(state.document,state.currentNodeID)?.parentId??null));$("go-forward").addEventListener("click",()=>nextNode()&&navigate(nextNode().id));$("go-end").addEventListener("click",()=>navigate(endNode()));$("flip-board").addEventListener("click",()=>{state.flipped=!state.flipped;renderStudioBoard();renderEditorEngine();renderPreview()});$("copy-fen").addEventListener("click",async()=>{if(state.position?.fen){await navigator.clipboard.writeText(state.position.fen);showStatus("FEN copied.")}});
$("recording-go-start").addEventListener("click",()=>navigate(null));$("recording-go-back").addEventListener("click",()=>navigate(nodeByID(state.document,state.currentNodeID)?.parentId??null));$("recording-go-forward").addEventListener("click",event=>advanceRecording(event.currentTarget));$("recording-go-end").addEventListener("click",()=>navigate(endNode()));$("recording-flip-board").addEventListener("click",()=>{state.flipped=!state.flipped;renderRecordingBoard()});$("recording-maia-toggle").addEventListener("click",()=>{state.recordingMaiaEnabled=!state.recordingMaiaEnabled;clearRecordingMaia();renderRecording();});$("recording-pipe-effect").addEventListener("ended",clearRecordingEffect);$("recording-effects").addEventListener("change",event=>{const item=state.effects.find(effect=>event.target.value===`library:${effect.id}`);if(event.target.value==="explosion"||(item?.id==="builtin-explosion"&&item.url===recordingExplosionSource))playRecordingExplosion();else if(event.target.value==="viking"||(item?.id==="builtin-viking"&&item.url===recordingVikingSource))playRecordingViking();else if(event.target.value==="pipe"||(item?.id==="builtin-pipe"&&item.url===recordingPipeSource))playRecordingPipe();else if(event.target.value==="harry")playRecordingHarry();else if(item)playRecordingLibraryEffect(item);event.target.value="";});
$("effect-file").addEventListener("change", previewEffectFile);$("effect-name").addEventListener("input", previewEffectFile);$("effect-save").addEventListener("click", async () => { const file=$("effect-file").files[0], name=$("effect-name").value.trim(); if(!file||!name)return; $("effect-error").textContent=""; try { await api.uploadEffect(name,file); $("effect-file").value=""; $("effect-name").value=""; previewEffectFile(); await loadEffects(); } catch(error) { $("effect-error").textContent=error.message; } });
$("toggle-editor-engine").addEventListener("click",toggleEditorEngine);
$("export-pgn").addEventListener("click",async()=>{try{const pgn=await exportSource(),blob=new Blob([`${pgn}\n`],{type:"application/x-chess-pgn"}),link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${state.document.activeChapterID||state.document.metadata.slug||"course"}.pgn`;link.click();URL.revokeObjectURL(link.href)}catch(error){showStatus(error.message,true)}});
$("maia-rating").addEventListener("change",()=>{if(state.editorPanels.maia)queueEditorMaiaAnalysis()});$("run-gap-check").addEventListener("click",runGapCheck);$("run-spellcheck").addEventListener("click",runSpellcheck);$("refresh-quality").addEventListener("click",runQuality);
$("add-chapter").addEventListener("click",()=>{if(Array.isArray(state.document.chapterSources))return createIndependentChapter();state.chapterAddMode=!state.chapterAddMode;$("add-chapter").textContent=state.chapterAddMode?"Cancel adding":"Add chapter";renderChapters()});
$("restart-preview").addEventListener("click",restartPreviewChapter);$("close-publish").addEventListener("click",closePublishDialog);$("cancel-publish").addEventListener("click",closePublishDialog);$("confirm-publish").addEventListener("click",confirmPublish);
$("publish-dialog").addEventListener("cancel",event=>{if(publishPending)event.preventDefault();else state.publishCandidate=null;});
$("publish-history").addEventListener("click",showPublicationHistory);

$("raw-pgn").addEventListener("click",async()=>{try{$("raw-pgn-text").value=await exportSource();$("raw-pgn-error").textContent="";$("raw-pgn-dialog").showModal()}catch(error){showStatus(error.message,true)}});
$("raw-pgn-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const button=$("apply-raw-pgn"),pgn=$("raw-pgn-text").value;setBusy(button,true,"Parsing…");$("raw-pgn-error").textContent="";try{await api.importPGN(pgn);const parsed=await analysisAPI.parsePGN(pgn),imported=importParsedPGN(parsed,state.document.metadata),next=structuralDocument(state.document,{...imported,sourcePGN:pgn,ignoredSuggestionIDs:state.document.ignoredSuggestionIDs,ignoredWords:state.document.ignoredWords});commit(next,{navigateTo:null});$("raw-pgn-dialog").close();refreshPosition();showStatus("Raw PGN parsed and applied.")}catch(error){$("raw-pgn-error").textContent=error.message}finally{setBusy(button,false)}});
$("conflict-keep").addEventListener("click",()=>$("conflict-dialog").close());$("conflict-reload").addEventListener("click",async()=>{$("conflict-dialog").close();await openCourse(state.courseID,{discardUnsaved:true})});
document.addEventListener("click",event=>{if(!$("account-menu").hidden&&!$("account-menu").contains(event.target)&&!$("account-button").contains(event.target))setAccountMenu(false)});
document.addEventListener("keydown",event=>{const editing=event.target.matches("input,textarea,select,[contenteditable=true]"), choiceOpen=!$("recording-choice").hidden;if(choiceOpen){if(["ArrowUp","ArrowDown","Enter","ArrowRight","Escape"].includes(event.key))event.preventDefault();if(event.key==="ArrowUp")selectRecordingChoice($("recording-choice")._selectedIndex-1);if(event.key==="ArrowDown")selectRecordingChoice($("recording-choice")._selectedIndex+1);if(event.key==="Enter"||event.key==="ArrowRight")confirmRecordingChoice();if(event.key==="Escape")closeRecordingChoice({restoreFocus:true});return}if(event.key==="Escape"&&!$("account-menu").hidden)setAccountMenu(false);if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();saveDraft()}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="z"&&!editing){event.preventDefault();event.shiftKey?redo():undo()}if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&!editing&&["editor","recording"].includes(state.view)){if(event.key==="ArrowLeft")navigate(nodeByID(state.document,state.currentNodeID)?.parentId??null);if(event.key==="ArrowRight"){if(state.view==="recording")advanceRecording($("recording-go-forward"));else if(nextNode())navigate(nextNode().id)}}});
window.addEventListener("beforeunload",event=>{flushActiveEditor();if(dirty()){event.preventDefault();event.returnValue=""}});
window.addEventListener("hashchange",()=>{const requestedView=location.hash.slice(1),view=requestedView==="videos"?"game-videos":requestedView;if(document.querySelector(`[data-panel="${CSS.escape(view)}"]`))switchView(view)});

boot();

async function exportAllChapterSources(document) {
  const next = syncActiveChapter(document), chapterSources = [];
  for (const chapter of next.chapterSources) {
    const child = chapterDocument(next, chapter);
    const payload = await analysisAPI.exportPGN(serializeForPGN(child), chapterPGNHeaders(next, chapter));
    if (!payload?.pgn) throw new Error(`${chapter.title} could not be exported. Nothing was saved.`);
    chapterSources.push({ ...chapter, sourcePGN: payload.pgn });
  }
  return activateChapter({ ...next, chapterSources, activeChapterID: null }, next.activeChapterID);
}
function selectIndependentChapter(id, view = 'editor') {
  closeRecordingChoice();
  flushActiveEditor();
  invalidateDiagnostics();
  setEffectivePosition(activateChapter(state.document, id), null);
  state.previewAttempt = null; state.analysisToken += 1;
  stopEditorMaia(); editorEngine.cancel();
  renderAll(); refreshPosition(); switchView(view);
}
function renderChapterSelector() {
  const independent = Array.isArray(state.document.chapterSources);
  $('chapter-editor-controls').hidden = !independent;
  $('import-chapter-label').hidden = !independent;
  $('raw-pgn').hidden = independent;
  $('export-pgn').disabled = independent && !state.document.activeChapterID;
  if (!independent) return;
  const select = $('active-chapter');
  select.innerHTML = state.document.chapterSources.map(chapter => `<option value="${escapeHTML(chapter.id)}" ${chapter.id===state.document.activeChapterID?'selected':''}>${escapeHTML(chapter.title)}</option>`).join('') || '<option>No chapters yet</option>';
  $('chapter-training-start').textContent = (state.document.trainingStartPath || []).length ? `Training begins after ${state.document.trainingStartPath.length} moves.` : 'Training begins at the starting position.';
  $('set-training-start').disabled = !state.document.activeChapterID;
  $('clear-training-start').disabled = !(state.document.trainingStartPath || []).length;
}
function createIndependentChapter(parsed = null, title = '') {
  const id = `chapter-${crypto.randomUUID()}`;
  try {
    commit(addIndependentChapter(state.document, parsed, title || `Chapter ${state.document.chapterSources.length + 1}`, id), { navigateTo: null });
    refreshPosition(); switchView('editor');
  } catch (error) { showStatus(error.message, true); }
}
function renderIndependentChapters() {
  const chapters = chapterSlices(state.document), container = $('studio-chapters');
  container.classList.remove('adding');
  $('chapter-board').hidden = true;
  $('chapter-position').closest('aside').hidden = true;
  container.parentElement.classList.add('independent-chapter-layout');
  container.innerHTML = chapters.map((chapter, index) => `<section class="studio-chapter independent-chapter" data-independent-chapter="${escapeHTML(chapter.id)}" draggable="true">
    <div class="independent-chapter-heading"><span class="chapter-drag-handle" role="button" tabindex="0" aria-label="Reorder chapter ${index+1}: use up and down arrow keys" title="Drag to reorder"><span aria-hidden="true">⠿</span></span><label>Chapter ${index+1}<input data-independent-title="${escapeHTML(chapter.id)}" value="${escapeHTML(chapter.title)}" maxlength="120"></label></div>
    <div class="heading-actions"><button class="secondary" data-chapter-open="${escapeHTML(chapter.id)}">Edit chapter <span class="chapter-button-count">· ${chapter.positions.length} positions</span></button><button class="secondary" data-chapter-video="${escapeHTML(chapter.id)}">${chapter.video || chapter.videoUploadID ? 'Edit video' : 'Add video'}</button>${chapter.videoUploadID ? `<button class="secondary" data-chapter-remove-video="${escapeHTML(chapter.id)}">Remove video</button>` : ''}<button class="secondary" data-chapter-check="${escapeHTML(chapter.id)}">Check chapter</button><button class="secondary" data-chapter-preview="${index}">Preview</button><button class="secondary chapter-delete" data-independent-delete="${escapeHTML(chapter.id)}">Delete</button></div>
    </section>`).join('') || '<div class="empty-state"><h2>Build your course chapter by chapter</h2><p>Import a PGN as a starting point, or add a blank chapter and author its moves here. Video is optional.</p></div>';
  container.querySelectorAll('[data-independent-title]').forEach(input => {
    input.addEventListener('input', markPendingInput);
    input.addEventListener('change', () => {
      const next = syncActiveChapter(state.document);
      next.chapterSources = next.chapterSources.map(chapter => chapter.id === input.dataset.independentTitle ? { ...chapter, title: input.value.trim() || chapter.title } : chapter);
      commit(next);
    });
  });
  container.querySelectorAll('[data-chapter-video]').forEach(button => button.addEventListener('click', () => selectIndependentChapter(button.dataset.chapterVideo, 'chapter-video')));
  container.querySelectorAll('[data-chapter-remove-video]').forEach(button => button.addEventListener('click', () => {
    const next = syncActiveChapter(state.document);
    const chapter = next.chapterSources.find(item => item.id === button.dataset.chapterRemoveVideo);
    if (chapter) { delete chapter.videoUploadID; delete chapter.video; commit(next); }
  }));
  container.querySelectorAll('[data-chapter-open]').forEach(button => button.addEventListener('click', () => selectIndependentChapter(button.dataset.chapterOpen)));
  container.querySelectorAll('[data-chapter-check]').forEach(button => button.addEventListener('click', () => checkIndependentChapter(button.dataset.chapterCheck)));
  container.querySelectorAll('[data-chapter-preview]').forEach(button => button.addEventListener('click', () => { state.previewChapter = Number(button.dataset.chapterPreview); state.previewIndex = 0; state.previewAttempt = null; switchView('preview'); }));
  container.querySelectorAll('[data-independent-delete]').forEach(button => button.addEventListener('click', () => {
    if (!confirm('Delete this chapter and its authored moves? Export its PGN first if you want to keep a copy. The saved course remains unchanged until Save draft.')) return;
    const next = syncActiveChapter(state.document);
    next.chapterSources = next.chapterSources.filter(chapter => chapter.id !== button.dataset.independentDelete);
    commit(activateChapter({ ...next, activeChapterID: null }, next.activeChapterID === button.dataset.independentDelete ? next.chapterSources[0]?.id : next.activeChapterID), { navigateTo: null });
    refreshPosition();
  }));
  container.querySelectorAll('[data-independent-chapter]').forEach((row, index) => {
    const handle = row.querySelector('.chapter-drag-handle');
    handle.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const target = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= chapters.length) return;
      reorderIndependentChapter(index, target);
      container.querySelectorAll('.chapter-drag-handle')[target]?.focus();
    });
    row.addEventListener('dragstart', event => {
      if (event.target.closest('input,button')) { event.preventDefault(); return; }
      state.chapterDrag = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.independentChapter);
      row.classList.add('dragging');
    });
    row.addEventListener('dragover', event => {
      if (state.chapterDrag === null) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', event => { event.preventDefault(); if (state.chapterDrag !== null) reorderIndependentChapter(state.chapterDrag, index); state.chapterDrag = null; });
    row.addEventListener('dragend', () => { state.chapterDrag = null; row.classList.remove('dragging'); });
  });
}
function reorderIndependentChapter(from, to) {
  const next = syncActiveChapter(state.document);
  if (from < 0 || to < 0 || from >= next.chapterSources.length || to >= next.chapterSources.length) return;
  const [chapter] = next.chapterSources.splice(from, 1); next.chapterSources.splice(to, 0, chapter); commit(next);
}
$('active-chapter').addEventListener('change', event => selectIndependentChapter(event.target.value));
$('recording-active-chapter').addEventListener('change', event => selectIndependentChapter(event.target.value, 'recording'));
$('chapter-video-chapter').addEventListener('change', event => {
  if (event.target.value) selectIndependentChapter(event.target.value, 'chapter-video');
});
$('set-training-start').addEventListener('click', () => {
  const path = movesToNode(state.document, state.currentNodeID), learnerPly = state.document.metadata.side === 'black' ? 1 : 0;
  if (path.length % 2 !== learnerPly) return showStatus('Choose a position where the learner is to move.', true);
  const child = chapterDocument(state.document, { ...state.document, chapterSources: undefined, trainingStartPath: [] });
  if (!trainingPack(child).positions.some(position => JSON.stringify(position.path) === JSON.stringify(path))) return showStatus('Choose a position on a trainable repertoire line.', true);
  commit({ ...state.document, trainingStartPath: path });
});
$('clear-training-start').addEventListener('click', () => commit({ ...state.document, trainingStartPath: [] }));
$('chapter-pgn-import').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const courseID = state.courseID;
  try {
    if (file.size > 1800000) throw new Error('PGN exceeds the 1.8 MB limit.');
    const pgn = await file.text(); await api.importPGN(pgn); const parsed = await analysisAPI.parsePGN(pgn);
    if (state.courseID !== courseID) throw new Error('The open course changed. Import the chapter again.');
    createIndependentChapter(parsed, parsed.headers?.Event || file.name.replace(/\.pgn$/i, ''));
  } catch (error) { showStatus(error.message, true); }
});

async function checkIndependentChapter(id) {
  selectIndependentChapter(id, 'quality');
  if (!await saveDraft({ quiet: true })) return;
  const chapter = syncActiveChapter(state.document).chapterSources.find(item => item.id === id);
  if (!chapter) return;
  const courseID = state.courseID, revision = state.revision;
  try {
    const remote = await api.validateChapter(courseID, revision, id);
    if (state.courseID !== courseID || state.revision !== revision || dirty()) return showStatus('The draft changed; check this chapter again.');
    const local = validateDocument(chapterDocument(state.document, chapter));
    const blockers = uniqueChecks([...local.blockers, ...(remote.errors || [])]), warnings = uniqueChecks([...local.warnings, ...(remote.warnings || [])]);
    $('quality-summary').innerHTML = `<div class="stat"><strong>${escapeHTML(chapter.title)}</strong><span>Chapter-only check · ${blockers.length} blockers · ${warnings.length} warnings</span></div>`;
    $('quality-results').innerHTML = [...blockers.map(item => qualityHTML('blocker', item)), ...warnings.map(item => qualityHTML('warning', item))].join('') || qualityHTML('good', { area: chapter.title, message: 'This chapter passes. Publishing still checks every chapter.' });
    showStatus('Chapter checks complete.');
  } catch (error) { showStatus(`Chapter check unavailable: ${error.message}`, true); }
}

const chapterVideoPolls = new Set();
function renderChapterVideoControls(chapter) {
  let box = $('chapter-video-actions');
  if (!box) { box = document.createElement('div'); box.id = 'chapter-video-actions'; document.querySelector('[data-panel="chapter-video"] .page-heading').after(box); }
  box.innerHTML = chapter?.video
    ? `<video class="chapter-video-player" controls preload="metadata" src="/studio/api/courses/${encodeURIComponent(state.courseID)}/chapter-media/${encodeURIComponent(chapter.video.id)}/play">Your browser cannot play this video.</video><button id="remove-chapter-video" class="secondary danger" type="button">Delete video</button>`
    : chapter?.videoUploadID ? '<p>Checking video…</p>' : '';
  $('remove-chapter-video')?.addEventListener('click', async () => {
    const next = syncActiveChapter(state.document), current = next.chapterSources.find(item => item.id === chapter.id);
    if (!current) return;
    delete current.videoUploadID; delete current.video;
    commit(next);
    if (await saveDraft({quiet:true})) {
      uploadPanel.startNew();
      showStatus('Video removed.');
    }
  });
}
async function startChapterVideoValidation(chapterID) {
  if (!await saveDraft({quiet:true})) return;
  const courseID = state.courseID, chapter = syncActiveChapter(state.document).chapterSources.find(c => c.id === chapterID);
  if (!chapter?.videoUploadID) return;
  const uploadID = chapter.videoUploadID, key = `${courseID}/${uploadID}`;
  if (chapterVideoPolls.has(key)) return showStatus('Video validation is running. You can keep editing.');
  chapterVideoPolls.add(key);
  try {
    const path = `/courses/${encodeURIComponent(courseID)}/chapter-media/${encodeURIComponent(uploadID)}`;
    let status = await api.request(`${path}/validate`, {method:'POST', body:{chapterID, revision:state.revision}});
    showStatus('Checking video…');
    while (status.state === 'validating') {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (state.courseID !== courseID) return;
      status = await api.request(path);
    }
    if (status.state !== 'ready' || !status.video) throw new Error(status.error || 'Video is not ready. Retry validation.');
    if (state.courseID !== courseID) return;
    const next = syncActiveChapter(state.document), current = next.chapterSources.find(c => c.id === chapterID);
    if (!current || current.videoUploadID !== uploadID) return;
    uploadPanel.clear();
    current.video = status.video; commit(next);
    if (await saveDraft({quiet:true})) showStatus('Video ready.');
  } catch (error) { showStatus(error.message, true); }
  finally { chapterVideoPolls.delete(key); }
}
