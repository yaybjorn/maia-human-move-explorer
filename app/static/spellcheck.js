import { checkWriting } from './writing-check.js';
import {
  applyIssueSuggestion,
  attachMoveHistories,
  extractCommentSources,
  fixedFilename
} from './pgn-spellcheck.mjs';

const form = document.querySelector('#spellcheck-form');
const fileInput = document.querySelector('#pgn-file');
const drop = document.querySelector('.drop');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const writingStatus = document.querySelector('#writing-status');
const writingFindings = document.querySelector('#writing-findings');
const downloadButton = document.querySelector('#download-fixed');
const IGNORED_WORDS_KEY = 'maia-writing-check-ignored-words-v1';
let currentPgn = '';
let originalName = '';
let fixesApplied = 0;

function escapeHtml(value) { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML; }
function highlightProblem(comment, start, end) {
  return `${escapeHtml(comment.slice(0,start))}<mark class="writing-problem">${escapeHtml(comment.slice(start,end))}</mark>${escapeHtml(comment.slice(end))}`;
}
function loadIgnoredWords() {
  try {
    const value = JSON.parse(localStorage.getItem(IGNORED_WORDS_KEY) || '[]');
    return Array.isArray(value) ? value.filter(word => typeof word === 'string') : [];
  } catch { return []; }
}
function saveIgnoredWord(word) {
  const words = new Set(loadIgnoredWords().map(value => value.toLocaleLowerCase('en-GB')));
  words.add(word.toLocaleLowerCase('en-GB'));
  localStorage.setItem(IGNORED_WORDS_KEY, JSON.stringify([...words].sort()));
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) document.querySelector('#file-name').textContent = fileInput.files[0].name;
});
for (const event of ['dragenter','dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); });
for (const event of ['dragleave','drop']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', e => {
  if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); }
});

async function contextFor(pgn) {
  const response = await fetch('/api/spellcheck-context', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pgn})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'The PGN could not be read.');
  return data.sources;
}

async function runCheck() {
  const rawSources = extractCommentSources(currentPgn);
  const contexts = await contextFor(currentPgn);
  const sources = attachMoveHistories(rawSources, contexts);
  const issues = await checkWriting(sources, { ignoredWords: loadIgnoredWords() });
  results.hidden = false;
  writingFindings.innerHTML = '';
  downloadButton.disabled = fixesApplied === 0;
  if (!sources.length) {
    writingStatus.textContent = 'No PGN comments to check.';
    return;
  }
  if (!issues.length) {
    const commentLabel = sources.length === 1 ? 'comment' : 'comments';
    const fixLabel = fixesApplied === 1 ? 'fix' : 'fixes';
    writingStatus.textContent = `No spelling or grammar issues found in ${sources.length} ${commentLabel}.${fixesApplied ? ` ${fixesApplied} ${fixLabel} applied.` : ''}`;
    return;
  }
  const commentLabel = sources.length === 1 ? 'comment' : 'comments';
  const fixLabel = fixesApplied === 1 ? 'fix' : 'fixes';
  writingStatus.textContent = `${issues.length} possible ${issues.length === 1 ? 'issue' : 'issues'} found in ${sources.length} ${commentLabel}.${fixesApplied ? ` ${fixesApplied} ${fixLabel} applied.` : ''}`;
  writingFindings.innerHTML = issues.map((issue, issueIndex) => `<article class="writing-issue">
    <h3>${escapeHtml(issue.history)} · ${escapeHtml(issue.kind)}</h3>
    <p class="writing-original">${highlightProblem(issue.comment,issue.start,issue.end)}</p>
    <p class="writing-message">${escapeHtml(issue.message)}</p>
    <div class="suggestion-buttons">
      ${issue.suggestions.map((suggestion, suggestionIndex) => `<button type="button" class="fix-suggestion" data-issue="${issueIndex}" data-suggestion="${suggestionIndex}">Fix: ${escapeHtml(suggestion || 'Remove')}</button>`).join('')}
      <button type="button" class="custom-fix-toggle" data-issue="${issueIndex}">Custom fix…</button>
    </div>
    <form class="custom-fix-form" data-issue="${issueIndex}" hidden>
      <label for="custom-fix-${issueIndex}">Replace “${escapeHtml(issue.problem)}” with</label>
      <div class="custom-fix-controls">
        <input id="custom-fix-${issueIndex}" class="custom-fix-input" type="text" value="${escapeHtml(issue.problem)}" autocomplete="off">
        <button type="submit">Apply</button>
        <button type="button" class="custom-fix-cancel">Cancel</button>
      </div>
    </form>
    ${issue.canIgnore ? `<button class="ignore-word" type="button" data-issue="${issueIndex}">Ignore “${escapeHtml(issue.problem)}”</button>` : ''}
  </article>`).join('');
  writingFindings.querySelectorAll('.fix-suggestion').forEach(button => {
    button.addEventListener('click', async () => {
      const issue = issues[Number(button.dataset.issue)];
      const replacement = issue.suggestions[Number(button.dataset.suggestion)];
      currentPgn = applyIssueSuggestion(currentPgn, issue, replacement);
      fixesApplied += 1;
      status.textContent = 'Fix applied. Checking the updated PGN…';
      await runCheck();
      status.textContent = 'Updated PGN ready to download.';
    });
  });
  writingFindings.querySelectorAll('.custom-fix-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const customForm = writingFindings.querySelector(`.custom-fix-form[data-issue="${button.dataset.issue}"]`);
      customForm.hidden = false;
      button.hidden = true;
      const input = customForm.querySelector('.custom-fix-input');
      input.focus();
      input.select();
    });
  });
  writingFindings.querySelectorAll('.custom-fix-form').forEach(customForm => {
    const issueIndex = Number(customForm.dataset.issue);
    customForm.addEventListener('submit', async event => {
      event.preventDefault();
      const replacement = customForm.querySelector('.custom-fix-input').value;
      currentPgn = applyIssueSuggestion(currentPgn, issues[issueIndex], replacement);
      fixesApplied += 1;
      status.textContent = 'Custom fix applied. Checking the updated PGN…';
      await runCheck();
      status.textContent = 'Updated PGN ready to download.';
    });
    customForm.querySelector('.custom-fix-cancel').addEventListener('click', () => {
      customForm.hidden = true;
      const toggle = writingFindings.querySelector(`.custom-fix-toggle[data-issue="${issueIndex}"]`);
      toggle.hidden = false;
      toggle.focus();
    });
  });
  writingFindings.querySelectorAll('.ignore-word').forEach(button => {
    button.addEventListener('click', async () => {
      saveIgnoredWord(issues[Number(button.dataset.issue)].problem);
      await runCheck();
    });
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true; results.hidden = true; status.textContent = 'Checking PGN comments locally…';
  try {
    currentPgn = await file.text();
    originalName = file.name;
    fixesApplied = 0;
    await runCheck();
    status.textContent = 'Spellcheck complete.';
  } catch (error) {
    status.textContent = error.message;
  } finally { button.disabled = false; }
});

downloadButton.addEventListener('click', () => {
  const blob = new Blob([currentPgn], {type:'application/x-chess-pgn;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fixedFilename(originalName);
  link.click();
  URL.revokeObjectURL(url);
});
