import { youtubeEmbedURL } from './studio-document.mjs';

const ACTIVE = new Set(['queued', 'running']);
const KINDS = ['screened', 'changes', 'raw'];
const KIND_LABELS = { screened: 'Screened candidates', changes: 'All position changes', raw: 'Raw observations' };
const FLAG_LABELS = { not_exactly_one_board: 'No single clear board', orientation_unknown: 'Board direction unknown', 'orientation_conf_below_0.5': 'Board direction uncertain', 'board_conf_below_0.9': 'Board detection uncertain', 'piece_conf_below_0.8': 'Some pieces uncertain', nonstandard_king_count: 'King count needs checking', uncertain_observations: 'Some observations need review' };
const orientationLabel = value => ({normal:'White at bottom',white:'White at bottom',flipped:'Black at bottom',black:'Black at bottom'}[value] || 'Board direction unknown');
const PIECES = { K: 'white-king', Q: 'white-queen', R: 'white-rook', B: 'white-bishop', N: 'white-knight', P: 'white-pawn', k: 'black-king', q: 'black-queen', r: 'black-rook', b: 'black-bishop', n: 'black-knight', p: 'black-pawn' };

export function extractionSources(metadata = {}) {
  const sources = [];
  if (metadata.courseVideo?.youtubeURL) sources.push({ ...metadata.courseVideo, videoRole: 'main', attachmentID: metadata.courseVideo.id });
  for (const video of metadata.videos || []) {
    if (video.youtubeURL) sources.push({ ...video, videoRole: 'supplemental', attachmentID: video.id });
  }
  return sources;
}

export function extractionTimestamp(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function placementSquares(fen, orientation = 'white') {
  // Never fill in unknown game state or interpret a full FEN as an OCR placement.
  orientation = orientation === 'normal' ? 'white' : orientation === 'flipped' ? 'black' : orientation;
  if (typeof fen !== 'string' || fen.includes(' ') || !['white', 'black'].includes(orientation)) return null;
  const ranks = fen.split('/');
  if (ranks.length !== 8) return null;
  const squares = [];
  for (const rank of ranks) {
    const row = [];
    for (const symbol of rank) {
      if (/^[1-8]$/.test(symbol)) row.push(...Array(Number(symbol)).fill(null));
      else if (PIECES[symbol]) row.push(symbol);
      else return null;
    }
    if (row.length !== 8) return null;
    squares.push(...row);
  }
  return orientation === 'black' ? squares.reverse() : squares;
}

export function extractionSeekURL(source, seconds) {
  const url = new URL(youtubeEmbedURL(source));
  url.searchParams.set('start', String(Math.max(0, Math.floor(Number(seconds) || 0))));
  return url.toString();
}

export function extractionReviewAllowed(context, job) {
  return Boolean(context && !context.dirty && job?.status === 'completed' && !job.stale && context.revision === job.revision);
}

// API requests cannot be aborted by StudioAPI, so ignore responses from an old
// course/session/revision. Selection requests have their own sequence below.
export class ExtractionScope {
  constructor(getContext) { this.getContext = getContext; this.epoch = 0; this.active = false; }
  open() { this.active = true; this.epoch += 1; return this.capture(); }
  close() { this.active = false; this.epoch += 1; }
  capture() {
    const context = this.getContext();
    return { epoch: this.epoch, courseID: context?.courseID, revision: context?.revision };
  }
  current(token) {
    const now = this.getContext();
    return this.active && token.epoch === this.epoch && token.courseID === now?.courseID && token.revision === now?.revision;
  }
}

export function createExtractionPanel({ api, getContext, notify = () => {} }) {
  const root = document.getElementById('studio-extraction');
  if (!root) throw new Error('Studio extraction panel is missing.');
  const scope = new ExtractionScope(getContext);
  let courseID = null, jobs = [], selected = null, rows = [], total = 0, offset = 0, kind = 'screened';
  let timer = null, selectionSequence = 0, listSequence = 0, busy = false, sources = [];
  let pendingRequest = null;
  const PAGE_SIZE = 50;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, className = 'secondary') => {
    const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', handler); return node;
  };
  const field = (text, input) => { const label = el('label', text); input.setAttribute('aria-label', text); label.append(input); return label; };
  const sourceSelect = el('select'); sourceSelect.id = 'extraction-source';
  const sourceURL = el('input'); sourceURL.type = 'url'; sourceURL.placeholder = 'https://www.youtube.com/watch?v=…'; sourceURL.id = 'extraction-url';
  const pastedField = field('YouTube link', sourceURL);
  const start = button('Extract positions', startJob, 'primary'); start.id = 'extraction-start';
  const refreshButton = button('Refresh jobs', () => refresh());
  const startHint = el('p', '', 'muted');
  const status = el('p', '', 'extraction-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const jobList = el('div', undefined, 'extraction-jobs'); jobList.id = 'extraction-jobs';
  const detail = el('section', undefined, 'extraction-detail'); detail.hidden = true;
  const controls = el('div', undefined, 'extraction-source-controls');
  controls.append(field('Video source', sourceSelect), pastedField);
  const actions = el('div', undefined, 'extraction-actions'); actions.append(start, refreshButton);
  root.replaceChildren(controls, startHint, actions, status, jobList, detail);
  sourceSelect.addEventListener('change', () => { pastedField.hidden = sourceSelect.value !== 'external'; pendingRequest = null; });
  sourceURL.addEventListener('input', () => { pendingRequest = null; });

  function path(id = '') { return `/courses/${encodeURIComponent(courseID)}/extractions${id ? `/${encodeURIComponent(id)}` : ''}`; }
  function stopTimer() { clearTimeout(timer); timer = null; }
  function setStatus(message, error = false) { status.textContent = message; status.classList.toggle('form-error', error); }
  function report(error) { setStatus(error.message || 'The extraction request failed. Refresh jobs to retry.', true); }
  function updateStart() {
    const context = getContext();
    start.disabled = busy || !scope.active || !context?.courseID || context.courseID !== courseID || context.dirty || !Number.isInteger(context.revision);
    startHint.textContent = context?.dirty ? 'Save draft first to extract or review positions from this version.' : 'Scans the full video at one-second intervals, even when the link includes a start time. You can leave and reopen this course while it runs.';
  }
  function renderSources() {
    const previous = sourceSelect.value;
    sources = extractionSources(getContext()?.metadata);
    sourceSelect.replaceChildren();
    sources.forEach((source, index) => {
      const option = el('option', `${source.videoRole === 'main' ? 'Course video' : 'Supplemental'} — ${source.title || 'Untitled video'}`);
      option.value = String(index); sourceSelect.append(option);
    });
    const external = el('option', 'Paste another YouTube link'); external.value = 'external'; sourceSelect.append(external);
    if (previous === 'external' || (previous !== '' && sources[Number(previous)])) sourceSelect.value = previous;
    else sourceSelect.value = sources.length ? '0' : 'external';
    pastedField.hidden = sourceSelect.value !== 'external';
    updateStart();
  }
  function renderJobs() {
    jobList.replaceChildren();
    if (!jobs.length) { jobList.append(el('p', 'No extractions for this course yet.', 'muted')); return; }
    jobs.forEach(job => {
      const row = el('div', undefined, 'extraction-job');
      const open = button(`${job.source?.title || job.source?.youtubeURL || 'Video extraction'} · ${job.status}`, () => openJob(job.id));
      open.setAttribute('aria-pressed', String(selected?.id === job.id));
      const summary = el('div');
      const when = new Date(typeof job.createdAt === 'number' ? job.createdAt * 1000 : job.createdAt).toLocaleString();
      summary.append(open, el('small', `Draft revision ${job.revision}${job.createdAt ? ` · ${when}` : ''}${job.stale ? ' · Older source/version' : ''}`));
      row.append(summary);
      if (ACTIVE.has(job.status)) {
        const progress = el('progress'); progress.max = 1; progress.value = Math.min(1, Math.max(0, Number(job.progress) || 0));
        progress.setAttribute('aria-label', `${job.phase || job.status}: ${Math.round(progress.value * 100)}%`);
        row.append(progress, el('small', `${job.phase || job.status} · ${Math.round(progress.value * 100)}%`));
      }
      jobList.append(row);
    });
  }
  function schedule() {
    stopTimer();
    if (!scope.active || document.hidden || !jobs.some(job => ACTIVE.has(job.status))) return;
    timer = setTimeout(() => loadJobs(), 5000);
  }
  async function loadJobs() {
    const token = scope.capture(), request = ++listSequence;
    try {
      const response = await api.request(path());
      if (!scope.current(token) || request !== listSequence) return;
      jobs = response.jobs || []; renderJobs(); updateStart();
      if (selected) {
        const updated = jobs.find(job => job.id === selected.id);
        if (updated && (updated.status !== selected.status || updated.stale !== selected.stale || updated.reviewRevision !== selected.reviewRevision)) await openJob(selected.id, false);
        else if (updated && ACTIVE.has(updated.status)) { selected = updated; renderDetail(); }
      }
      schedule();
    } catch (error) { if (scope.current(token) && request === listSequence) { report(error); stopTimer(); } }
  }
  async function refresh() {
    stopTimer();
    const context = getContext();
    if (!context?.courseID) { clear(); return; }
    const changed = courseID !== context.courseID;
    const token = scope.open(); busy = false;
    if (changed) {
      courseID = context.courseID; selected = null; jobs = []; rows = []; offset = 0; kind = 'screened';
      sourceURL.value = ''; sourceSelect.value = ''; pendingRequest = null; detail.replaceChildren(); detail.hidden = true; busy = false;
    }
    renderSources(); renderJobs(); setStatus('');
    // Invalidate pending result requests but retain the current job on same-course reopen.
    selectionSequence += 1;
    await loadJobs();
    if (scope.current(token) && selected && !changed) await openJob(selected.id, false);
  }
  async function startJob() {
    updateStart();
    if (start.disabled) return;
    const token = scope.capture(), context = getContext();
    let source;
    try {
      const attached = sourceSelect.value === 'external' ? null : sources[Number(sourceSelect.value)];
      source = attached ? { youtubeURL: attached.youtubeURL, videoRole: attached.videoRole, attachmentID: attached.attachmentID }
        : { youtubeURL: sourceURL.value.trim(), videoRole: 'external' };
      youtubeEmbedURL(source.youtubeURL); // Same strict YouTube-origin validation as existing previews.
    } catch { setStatus('Choose an attached video or enter a valid, specific YouTube video link.', true); return; }
    const identity = JSON.stringify({ courseID, revision: context.revision, source });
    if (pendingRequest?.identity !== identity) pendingRequest = { identity, id: crypto.randomUUID() };
    busy = true; updateStart(); setStatus('Submitting extraction…');
    try {
      const response = await api.request(path(), { method: 'POST', body: { revision: context.revision, source, requestID: pendingRequest.id } });
      if (!scope.current(token)) return;
      pendingRequest = null;
      jobs = [response.job, ...jobs.filter(job => job.id !== response.job.id)]; renderJobs();
      setStatus('Extraction saved. Its progress and results remain available when you reopen this course.');
      await openJob(response.job.id); schedule();
    } catch (error) { if (scope.current(token)) report(error); }
    finally { if (scope.current(token)) { busy = false; updateStart(); } }
  }
  async function openJob(id, reset = true) {
    const token = scope.capture(), request = ++selectionSequence;
    if (reset) { kind = 'screened'; offset = 0; }
    detail.hidden = false; detail.replaceChildren(el('p', 'Loading extraction…', 'muted'));
    try {
      const response = await api.request(path(id));
      if (!scope.current(token) || request !== selectionSequence) return;
      selected = response.job; rows = []; total = 0; renderJobs();
      if (selected.status === 'completed') await loadRows(token, request);
      else renderDetail();
    } catch (error) { if (scope.current(token) && request === selectionSequence) report(error); }
  }
  async function loadRows(token = scope.capture(), request = ++selectionSequence) {
    const id = selected.id;
    detail.replaceChildren(el('p', 'Loading observations…', 'muted'));
    try {
      const response = await api.request(`${path(id)}/results?kind=${kind}&offset=${offset}&limit=${PAGE_SIZE}`);
      if (!scope.current(token) || request !== selectionSequence || selected?.id !== id) return;
      rows = response.rows || []; total = response.total || 0; renderDetail();
    } catch (error) { if (scope.current(token) && request === selectionSequence) report(error); }
  }
  function renderDetail() {
    detail.replaceChildren(); detail.hidden = !selected;
    if (!selected) return;
    const heading = el('div', undefined, 'card-heading');
    const title = el('div'); title.append(el('h3', selected.source?.title || 'Video extraction'), el('p', `${selected.status} · ${selected.phase || selected.status} · Draft revision ${selected.revision}`));
    heading.append(title); detail.append(heading);
    const sourceRole = selected.source?.videoRole === 'main' ? 'Course video' : selected.source?.videoRole === 'supplemental' ? 'Supplemental video' : 'Pasted video link';
    detail.append(el('p', `${sourceRole}: ${selected.source?.youtubeURL || 'Source unavailable'}`, 'extraction-fen muted'));
    if (selected.stale || selected.revision !== getContext()?.revision) detail.append(el('p', 'This extraction belongs to an older draft or video source. You can inspect and download it, but cannot review it for the current version. Start a new extraction from the saved draft.', 'extraction-notice'));
    if (selected.error) detail.append(el('p', selected.error, 'form-error'));
    if (ACTIVE.has(selected.status)) {
      detail.append(el('p', 'You can leave this page. Reopen Videos to see the saved job and its progress.', 'muted'));
      const cancel = button('Cancel extraction', () => mutateJob('cancel'));
      cancel.disabled = busy || Boolean(getContext()?.dirty); detail.append(cancel); return;
    }
    if (selected.status !== 'completed') return;
    const filters = el('div', undefined, 'extraction-actions');
    for (const view of KINDS) {
      const tab = button(KIND_LABELS[view], () => { kind = view; offset = 0; loadRows(); });
      tab.setAttribute('aria-pressed', String(kind === view)); filters.append(tab);
    }
    detail.append(filters, el('p', kind === 'screened' ? 'Lossy shortlist: consecutive observations without screening flags. These candidates still need human review.' : kind === 'changes' ? 'Consecutive duplicates are compressed; later revisits remain separate. Flags identify uncertainty, not measured errors.' : 'Every sampled observation, including no board, occlusion, multiple boards and unknown orientation. Raw observations are read-only.', 'muted'));
    const downloads = el('div', undefined, 'extraction-downloads');
    downloads.append(el('span', 'CSV (seconds; piece-placement FEN):'));
    for (const downloadKind of [...KINDS, 'reviewed']) {
      const link = el('a', downloadKind === 'reviewed' ? 'Accepted candidates' : KIND_LABELS[downloadKind]);
      link.href = `${api.base || '/studio/api'}${path(selected.id)}/download?kind=${downloadKind}`; link.className = 'secondary';
      downloads.append(link);
    }
    const evidence = el('a', 'Raw evidence (JSON)');
    evidence.href = `${api.base || '/studio/api'}${path(selected.id)}/evidence`; evidence.className = 'secondary'; downloads.append(evidence);
    detail.append(downloads);
    detail.append(el('p', 'Raw CSV lists detected placements. Raw JSON also preserves no-board observations, multiple detections and uncertainty.', 'muted'));
    if (getContext()?.dirty) detail.append(el('p', 'Save draft before changing review decisions.', 'extraction-notice'));
    const preview = el('div', undefined, 'extraction-preview'); preview.id = 'extraction-preview'; preview.hidden = true;
    detail.append(preview);
    const resultList = el('div', undefined, 'extraction-rows');
    if (!rows.length) resultList.append(el('p', 'No observations in this view. Check All position changes or Raw observations.', 'muted'));
    for (const row of rows) {
      const item = el('article', undefined, 'extraction-row');
      const rowHead = el('div', undefined, 'extraction-row-head');
      const seek = button(`▶ ${extractionTimestamp(row.timestamp_seconds)}`, () => showPreview(preview, row));
      seek.setAttribute('aria-label', `Preview and seek video to ${extractionTimestamp(row.timestamp_seconds)}`);
      rowHead.append(seek, el('small', `${row.timestamp_seconds} s · ${row.observations || 1} observation${row.observations === 1 ? '' : 's'}`));
      item.append(rowHead);
      item.append(el('code', row.fen || 'No unambiguous single-board placement', 'extraction-fen'));
      const flags = Array.isArray(row.flags) ? row.flags.map(value => FLAG_LABELS[value] || String(value).replaceAll('_', ' ')) : [];
      item.append(el('p', `${orientationLabel(row.orientation)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`, flags.length ? 'extraction-flags' : 'muted'));
      if (Array.isArray(row.boards) && (row.boards.length !== 1 || !row.fen)) {
        const raw = el('details'); raw.append(el('summary', `${row.boards.length} detected boards — raw evidence`), el('pre', JSON.stringify(row.boards, null, 2))); item.append(raw);
      }
      if (kind !== 'raw' && /^segment-\d+$/.test(row.id)) {
        const decision = el('select');
        for (const [value, label] of [['unreviewed', 'Not reviewed'], ['accepted', 'Accept candidate'], ['rejected', 'Reject candidate']]) {
          const option = el('option', label); option.value = value; decision.append(option);
        }
        decision.value = row.decision || 'unreviewed';
        decision.disabled = busy || !extractionReviewAllowed(getContext(), selected);
        decision.addEventListener('change', () => mutateJob('review', [{ rowID: row.id, decision: decision.value }]));
        item.append(field(`Review at ${extractionTimestamp(row.timestamp_seconds)}`, decision));
      }
      resultList.append(item);
    }
    detail.append(resultList);
    const paging = el('div', undefined, 'extraction-actions');
    const back = button('Previous 50', () => { offset = Math.max(0, offset - PAGE_SIZE); loadRows(); }); back.disabled = offset === 0;
    const next = button('Next 50', () => { offset += PAGE_SIZE; loadRows(); }); next.disabled = offset + rows.length >= total;
    paging.append(back, el('span', total ? `${offset + 1}–${offset + rows.length} of ${total}` : '0 results'), next); detail.append(paging);
  }
  function showPreview(container, row) {
    container.replaceChildren(); container.hidden = false;
    const title = el('div', undefined, 'extraction-actions');
    title.append(el('strong', `Preview at ${extractionTimestamp(row.timestamp_seconds)}`), button('Close preview', () => { container.replaceChildren(); container.hidden = true; })); container.append(title);
    const grid = el('div', undefined, 'extraction-preview-grid');
    try {
      const iframe = el('iframe'); iframe.src = extractionSeekURL(selected.source.youtubeURL, row.timestamp_seconds);
      iframe.title = `Video at ${extractionTimestamp(row.timestamp_seconds)}`;
      iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'; iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin'; grid.append(iframe);
    } catch { grid.append(el('p', 'The source link cannot be previewed.', 'form-error')); }
    const squares = placementSquares(row.fen, row.orientation || 'unknown');
    if (squares) {
      const board = el('div', undefined, 'extraction-board'); board.setAttribute('role', 'img'); board.setAttribute('aria-label', `OCR piece placement at ${extractionTimestamp(row.timestamp_seconds)}: ${row.fen}. ${['black', 'flipped'].includes(row.orientation) ? 'Black' : 'White'} at bottom.`);
      squares.forEach((piece, index) => {
        const square = el('span', undefined, `extraction-square ${(Math.floor(index / 8) + index % 8) % 2 ? 'dark' : 'light'}`);
        if (piece) { const image = el('img'); image.src = `/static/pieces/${PIECES[piece]}.svg`; image.alt = ''; image.draggable = false; square.append(image); }
        board.append(square);
      }); grid.append(board);
    } else grid.append(el('p', 'No unambiguous single-board placement for this observation. Inspect the video and raw evidence.', 'extraction-notice'));
    container.append(grid, el('p', 'Placement only: no side to move, castling rights, en passant or move counters. This does not identify a course training position.', 'muted'));
    container.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  async function mutateJob(operation, decisions) {
    const context = getContext();
    if (busy || !scope.active || !context || context.courseID !== courseID || context.dirty || (operation === 'review' && !extractionReviewAllowed(context, selected))) { updateStart(); return; }
    const token = scope.capture(), id = selected.id;
    busy = true; renderDetail(); updateStart();
    try {
      const response = await api.request(`${path(id)}/${operation}`, { method: 'POST', body: { revision: context.revision, ...(decisions ? { reviewRevision: selected.reviewRevision, decisions } : {}) } });
      if (!scope.current(token)) return;
      // A selection may change while a mutation is saving. Never reopen the old job.
      if (selected?.id === id) selected = response.job;
      jobs = jobs.map(job => job.id === id ? response.job : job); renderJobs();
      setStatus(operation === 'review' ? 'Review decision saved. No course content was changed.' : 'Cancellation requested.');
      if (selected?.id === id && operation === 'review') await loadRows();
      schedule();
    } catch (error) { if (scope.current(token)) { report(error); if (selected?.id === id) await openJob(id, false); } }
    finally { if (scope.current(token)) { busy = false; updateStart(); renderDetail(); } }
  }
  function suspend() {
    scope.close(); stopTimer(); busy = false; selectionSequence += 1; listSequence += 1;
    // Remove the iframe so audio cannot continue after leaving Videos.
    const preview = document.getElementById('extraction-preview'); if (preview) { preview.replaceChildren(); preview.hidden = true; }
  }
  function clear() {
    suspend(); courseID = null; jobs = []; selected = null; rows = []; pendingRequest = null; sourceURL.value = '';
    sourceSelect.replaceChildren(); detail.replaceChildren(); detail.hidden = true; jobList.replaceChildren(); setStatus(''); updateStart();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTimer(); else if (scope.active) loadJobs(); });
  function contextChanged() { if (scope.active) { renderSources(); renderDetail(); } }
  return { refresh, suspend, clear, contextChanged };
}
