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
    render(data); status.textContent = `Checked ${data.positions_analyzed} opponent positions.`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

function escapeHtml(value) { const node=document.createElement('span'); node.textContent=String(value); return node.innerHTML; }
function render(data) {
  results.hidden = false;
  document.querySelector('#summary').innerHTML = [
    [data.positions_analyzed,'positions checked'],[data.positions_needing_attention,'positions to address'],[data.missing_moves,'missing replies']
  ].map(([value,label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');
  const findings = document.querySelector('#findings');
  if (!data.findings.length) { findings.innerHTML='<div class="empty"><strong>No repertoire gaps found at this threshold.</strong></div>'; return; }
  findings.innerHTML = data.findings.map((item,index) => `<article class="finding">
    <h2>Position ${index+1} · after ${item.ply} ply</h2><div class="history">${escapeHtml(item.history)}</div>
    <div class="moves">${item.missing.map(move => `<span class="move">${escapeHtml(move.san)} · ${(move.probability*100).toFixed(1)}%</span>`).join('')}</div>
    <p class="existing">In PGN: ${item.existing_replies.map(move=>escapeHtml(move.san)).join(', ') || 'none'}</p>
    ${item.comments.length ? `<p class="comments">Comment: ${escapeHtml(item.comments.join(' / '))}</p>` : ''}
  </article>`).join('');
}
