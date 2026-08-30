import {
  addBoundary, defaultChapters, manifestFor, moveBoundary, orderedPositions,
  removeChapter, startsFromChapters, validateChapters,
} from "./chapter-editor.mjs";

const elements = Object.fromEntries([
  "course", "summary", "status", "workspace", "timeline", "board", "position-detail",
  "download", "reset", "add-mode", "pack-file", "manifest-file",
].map(id => [id, document.getElementById(id)]));

let pack = null;
let chapters = [];
let originalChapters = [];
let selectedID = null;
let draggedChapter = null;
let addMode = false;

async function loadCatalogue() {
  try {
    const response = await fetch("/api/chapter-courses");
    if (!response.ok) throw new Error("Could not load courses");
    const data = await response.json();
    elements.course.innerHTML = data.openings.map(opening =>
      `<option value="${escapeHTML(opening.id)}">${escapeHTML(opening.title)} · ${escapeHTML(opening.version)}</option>`
    ).join("");
    if (!data.openings.length) throw new Error("No courses are available");
    await loadCourse(data.openings[0].id);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadCourse(id) {
  setStatus("Loading course…");
  disableActions(true);
  try {
    const response = await fetch(`/api/chapter-courses/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Could not load this course");
    setPack(await response.json());
  } catch (error) {
    setStatus(error.message, true);
  }
}

function setPack(nextPack, importedManifest = null) {
  pack = nextPack;
  const candidate = importedManifest?.chapters || pack.chapters || defaultChapters(pack);
  const errors = validateChapters(pack, candidate);
  chapters = errors.length ? defaultChapters(pack) : structuredClone(candidate);
  originalChapters = structuredClone(chapters);
  selectedID = orderedPositions(pack)[0]?.id || null;
  disableActions(false);
  elements.workspace.hidden = false;
  setStatus(errors.length ? `Imported chapters were invalid: ${errors.join(" ")} A balanced draft was created.` : "Ready. Changes stay in this browser until you download the manifest.", errors.length > 0);
  render();
}

function render() {
  const positions = orderedPositions(pack);
  const byID = new Map(positions.map(position => [position.id, position]));
  const starts = startsFromChapters(pack, chapters);
  elements.timeline.classList.toggle("add-mode", addMode);
  elements.timeline.innerHTML = chapters.map((chapter, chapterIndex) => {
    const start = starts[chapterIndex];
    const cards = chapter.positionIDs.map(id => positionCard(byID.get(id))).join("");
    const outside = chapter.positionIDs.length < 16 || chapter.positionIDs.length > 32;
    return `${dropZone(start, chapterIndex)}
      <section class="chapter" data-chapter="${chapterIndex}">
        <div class="chapter-heading" draggable="${chapterIndex > 0}" data-drag-chapter="${chapterIndex}">
          <span class="drag-handle" aria-hidden="true">⠿</span>
          <input class="chapter-title" data-title="${chapterIndex}" value="${escapeHTML(chapter.title)}" aria-label="Chapter ${chapterIndex + 1} name" maxlength="80">
          <span class="chapter-count ${outside ? "outside" : ""}">${chapter.positionIDs.length} moves</span>
          ${chapterIndex ? `<button class="delete-chapter" data-delete="${chapterIndex}" type="button" aria-label="Remove ${escapeHTML(chapter.title)}">×</button>` : ""}
        </div>${cards}
      </section>`;
  }).join("") + dropZone(positions.length, chapters.length);

  elements.summary.innerHTML = `<span><strong>${positions.length}</strong>positions</span><span><strong>${chapters.length}</strong>chapters</span><span><strong>${Math.round(positions.length / chapters.length)}</strong>average size</span>`;
  const errors = validateChapters(pack, chapters);
  elements.download.disabled = errors.length > 0;
  renderSelected(byID.get(selectedID));
  bindTimeline();
}

function positionCard(position) {
  const selected = position.id === selectedID ? " selected" : "";
  const moveNumber = moveLabel(position.fen);
  return `<article class="position${selected}" data-position="${escapeHTML(position.id)}" tabindex="0">
    <span class="position-order">#${(position.learningOrder ?? 0) + 1}</span>
    <span class="position-main"><strong>${escapeHTML(moveNumber)}</strong><span>${escapeHTML(position.source?.chapter || "Repertoire line")}</span></span>
    <span class="move-pill">${escapeHTML(position.correctMove?.san || "—")}</span>
  </article>`;
}

function dropZone(index, chapterIndex) {
  if (index === 0) return "";
  return `<div class="drop-zone" data-drop-index="${index}" data-before-chapter="${chapterIndex}" tabindex="0">Start chapter here</div>`;
}

function bindTimeline() {
  elements.timeline.querySelectorAll("[data-title]").forEach(input => input.addEventListener("change", event => {
    chapters[Number(event.target.dataset.title)].title = event.target.value.trim() || `Chapter ${Number(event.target.dataset.title) + 1}`;
    render();
  }));
  elements.timeline.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", () => {
    chapters = removeChapter(pack, chapters, Number(button.dataset.delete)); render();
  }));
  elements.timeline.querySelectorAll("[data-position]").forEach(card => {
    const select = () => { selectedID = card.dataset.position; render(); };
    card.addEventListener("click", select);
    card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") select(); });
  });
  elements.timeline.querySelectorAll("[data-drag-chapter]").forEach(header => {
    header.addEventListener("dragstart", event => {
      draggedChapter = Number(header.dataset.dragChapter);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggedChapter));
    });
    header.addEventListener("dragend", () => { draggedChapter = null; document.querySelectorAll(".drop-zone").forEach(zone => zone.classList.remove("active")); });
  });
  elements.timeline.querySelectorAll(".drop-zone").forEach(zone => {
    zone.addEventListener("dragover", event => { if (draggedChapter !== null) { event.preventDefault(); zone.classList.add("active"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("active"));
    zone.addEventListener("drop", event => {
      event.preventDefault();
      chapters = moveBoundary(pack, chapters, draggedChapter, Number(zone.dataset.dropIndex));
      draggedChapter = null; render();
    });
    zone.addEventListener("click", () => {
      if (!addMode) return;
      chapters = addBoundary(pack, chapters, Number(zone.dataset.dropIndex));
      addMode = false; elements["add-mode"].textContent = "Add chapter"; render();
    });
  });
}

function renderSelected(position) {
  if (!position) return;
  renderBoard(position.fen);
  elements["position-detail"].innerHTML = `<h2>${escapeHTML(moveLabel(position.fen))} · ${escapeHTML(position.correctMove?.san || "")}</h2>
    <p>${escapeHTML(position.correctMove?.feedback || "No teaching note")}</p>
    <p><strong>Source:</strong> ${escapeHTML(position.source?.chapter || "Repertoire line")}</p>
    <p><code>${escapeHTML(position.fen)}</code></p>`;
}

function renderBoard(fen) {
  const placement = fen.split(" ")[0];
  const squares = [];
  const names = { p:"pawn", n:"knight", b:"bishop", r:"rook", q:"queen", k:"king" };
  for (const rank of placement.split("/")) {
    for (const token of rank) {
      if (/\d/.test(token)) squares.push(...Array(Number(token)).fill(null));
      else squares.push(token);
    }
  }
  elements.board.innerHTML = squares.map((piece, index) => {
    const light = (Math.floor(index / 8) + index % 8) % 2 === 0;
    const image = piece ? `<img alt="${piece === piece.toUpperCase() ? "White" : "Black"} ${names[piece.toLowerCase()]}" src="/static/pieces/${piece === piece.toUpperCase() ? "white" : "black"}-${names[piece.toLowerCase()]}.svg">` : "";
    return `<span class="square ${light ? "light" : "dark"}">${image}</span>`;
  }).join("");
}

function moveLabel(fen) {
  const parts = fen.split(" ");
  const number = Number(parts[5] || 1);
  return parts[1] === "b" ? `Move ${number}…` : `Move ${number}`;
}

function downloadManifest() {
  const blob = new Blob([`${JSON.stringify(manifestFor(pack, chapters), null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${pack.id}-chapters.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Manifest downloaded. Commit it beside the course metadata and PGN to publish these chapters.");
}

async function importJSON(file, kind) {
  try {
    const value = JSON.parse(await file.text());
    if (kind === "pack") setPack(value);
    else {
      if (!pack || value.packID !== pack.id) throw new Error("This manifest belongs to a different course.");
      const errors = validateChapters(pack, value.chapters || []);
      if (errors.length) throw new Error(errors.join(" "));
      chapters = structuredClone(value.chapters); originalChapters = structuredClone(chapters); render(); setStatus("Manifest imported.");
    }
  } catch (error) { setStatus(`Import failed: ${error.message}`, true); }
}

function setStatus(message, error = false) { elements.status.textContent = message; elements.status.style.color = error ? "#9d452d" : ""; }
function disableActions(disabled) { elements.download.disabled = disabled; elements.reset.disabled = disabled; }
function escapeHTML(value = "") { const node = document.createElement("span"); node.textContent = String(value); return node.innerHTML; }

elements.course.addEventListener("change", () => loadCourse(elements.course.value));
elements.download.addEventListener("click", downloadManifest);
elements.reset.addEventListener("click", () => { chapters = structuredClone(originalChapters); render(); setStatus("Changes reset."); });
elements["add-mode"].addEventListener("click", () => { addMode = !addMode; elements["add-mode"].textContent = addMode ? "Cancel adding" : "Add chapter"; render(); });
elements["pack-file"].addEventListener("change", event => event.target.files[0] && importJSON(event.target.files[0], "pack"));
elements["manifest-file"].addEventListener("change", event => event.target.files[0] && importJSON(event.target.files[0], "manifest"));

loadCatalogue();
