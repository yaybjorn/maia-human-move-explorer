const form = document.querySelector('#check-form');
const fileInput = document.querySelector('#pgn-file');
const drop = document.querySelector('.drop');
const status = document.querySelector('#status');
const results = document.querySelector('#results');

for (const id of ['rating', 'threshold']) {
  const input = document.querySelector(`#${id}`);
  const output = document.querySelector(`#${id}-output`);
  input.addEventListener('input', () => output.value = id === 'threshold' ? `${input.value}%` : input.value);
}
fileInput.addEventListener('change', () => { if (fileInput.files[0]) document.querySelector('#file-name').textContent = fileInput.files[0].name; });
for (const event of ['dragenter','dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); });
for (const event of ['dragleave','drop']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); } });

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  const button = form.querySelector('button');
  button.disabled = true; results.hidden = true; status.textContent = 'Checking each opponent position with Maia…';
  try {
    const response = await fetch('/api/check-repertoire', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      pgn: await file.text(), repertoire_side:document.querySelector('#side').value,
      rating:Number(document.querySelector('#rating').value), threshold:Number(document.querySelector('#threshold').value)/100
    })});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'The check failed');
    render(data);
    status.textContent = 'Repertoire check complete. Checking the writing locally…';
    await renderWriting(data.writing_sources || []);
    status.textContent = `Checked ${data.positions_analyzed} opponent positions and ${data.writing_sources?.length || 0} comments.`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

function escapeHtml(value) { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML; }
function highlightProblem(comment, start, end) {
  return `${escapeHtml(comment.slice(0,start))}<mark class="writing-problem">${escapeHtml(comment.slice(start,end))}</mark>${escapeHtml(comment.slice(end))}`;
}

async function renderWriting(sources) {
  const writingStatus = document.querySelector('#writing-status');
  const writingFindings = document.querySelector('#writing-findings');
  writingFindings.innerHTML = '';
  if (!sources.length) {
    writingStatus.textContent = 'No PGN comments to check.';
    return;
  }

  writingStatus.textContent = `Checking ${sources.length} comments in your browser…`;
  try {
    const { checkWriting } = await import('./writing-check.js');
    const issues = await checkWriting(sources);
    if (!issues.length) {
      writingStatus.textContent = `No spelling or grammar issues found in ${sources.length} comments.`;
      return;
    }
    writingStatus.textContent = `${issues.length} possible ${issues.length === 1 ? 'issue' : 'issues'} found. Chess names and terminology may need your judgement.`;
    writingFindings.innerHTML = issues.map(issue => `<article class="writing-issue">
      <h3>${escapeHtml(issue.history)} · ${escapeHtml(issue.kind)}</h3>
      <p class="writing-original">${highlightProblem(issue.comment,issue.start,issue.end)}</p>
      <p class="writing-message">${escapeHtml(issue.message)}</p>
      ${issue.suggestions.length ? `<p class="writing-suggestion">Suggested: ${issue.suggestions.map(escapeHtml).join(' / ')}</p>` : ''}
    </article>`).join('');
  } catch (error) {
    writingStatus.textContent = 'The writing checker could not load. The repertoire results are still complete.';
    console.error(error);
  }
}

function render(data) {
  results.hidden = false;
  document.querySelector('#summary').innerHTML = [
    [data.positions_analyzed,'positions checked'],[data.positions_needing_attention,'positions to address'],
    [data.missing_moves,'uncovered opponent moves'],[data.excluded_before_opening,'pre-opening positions hidden'],[data.excluded_low_priority,'low-priority positions hidden'],
    [data.excluded_already_winning,'winning positions hidden']
  ].map(([value,label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');
  const findings = document.querySelector('#findings');
  if (!data.findings.length) { findings.innerHTML='<div class="empty"><strong>No repertoire gaps found at this threshold.</strong></div>'; return; }
  findings.innerHTML = data.findings.map((item,index) => `<article class="finding">
    <div class="board" data-fen="${escapeHtml(item.fen)}" data-side="${escapeHtml(data.repertoire_side)}"></div>
    <div class="finding-copy"><h2>Priority ${index+1} · score ${(item.priority_score*100).toFixed(1)}</h2>
    <div class="history">${escapeHtml(item.history)}</div>
    <div class="moves">${item.missing.map(move => `<span class="move">${escapeHtml(move.san)} · ${(move.probability*100).toFixed(1)}%</span>`).join('')}</div>
    <p class="metrics">Reached ${(item.reach_probability*100).toFixed(1)}% · ${(item.missing_probability_mass*100).toFixed(1)}% missing probability · ${formatEval(item.evaluation, data.repertoire_side)}</p>
    <p class="existing">In PGN: ${item.existing_replies.map(move=>escapeHtml(move.san)).join(', ') || 'none'}</p>
    ${item.comments.length ? `<p class="comments">Comment: ${escapeHtml(item.comments.join(' / '))}</p>` : ''}
  </div></article>`).join('');
  document.querySelectorAll('.board').forEach(renderBoard);
}

function formatEval(evaluation, side) {
  if (!evaluation) return 'not engine checked';
  if (evaluation.type === 'mate') return `Stockfish ${evaluation.value > 0 ? '+' : '-'}M${Math.abs(evaluation.value)}`;
  const white = evaluation.value / 100;
  const score = side === 'white' ? white : -white;
  return `Stockfish ${score >= 0 ? '+' : ''}${score.toFixed(1)} for us`;
}

function renderBoard(board) {
  const [placement] = board.dataset.fen.split(' ');
  const rows = placement.split('/');
  const pieces = {p:'black-pawn',r:'black-rook',n:'black-knight',b:'black-bishop',q:'black-queen',k:'black-king',P:'white-pawn',R:'white-rook',N:'white-knight',B:'white-bishop',Q:'white-queen',K:'white-king'};
  const squares = [];
  rows.forEach(row => { for (const symbol of row) { if (/\d/.test(symbol)) squares.push(...Array(Number(symbol)).fill(null)); else squares.push(symbol); } });
  if (board.dataset.side === 'black') squares.reverse();
  board.innerHTML = squares.map((piece,index) => `<span class="square ${(Math.floor(index/8)+index%8)%2?'dark':'light'}">${piece ? `<img src="/static/pieces/${pieces[piece]}.svg" alt="">` : ''}</span>`).join('');
}
