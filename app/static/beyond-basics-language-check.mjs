import {checkWriting, writingSuggestionLabel} from './writing-check.js';

// Ignore code and complete PGN move lines as well as the chess tokens already
// excluded by the shared checker. Keep offsets unchanged for safe application.
export function protectedText(value) {
  return value.replace(/```[\s\S]*?```|`[^`\n]*`|^(?:\s*\d+\.(?:\.\.)?\s*\S+.*)$/gm,
    match => match.replace(/[^\n]/g, ' '));
}
export function attachLanguageCheck(body) {
  const wrap = document.createElement('section');
  const run = document.createElement('button');
  run.type = 'button'; run.textContent = 'Check spelling and grammar';
  const status = document.createElement('p'); status.setAttribute('aria-live', 'polite');
  const list = document.createElement('div');
  wrap.append(run, status, list);
  let revision = 0;
  function invalidate() { revision++; list.replaceChildren(); status.textContent = 'Text changed. Check again for current suggestions.'; }
  body.addEventListener('input', invalidate);
  run.addEventListener('click', async () => {
    const snapshot = body.value, token = ++revision;
    list.replaceChildren(); status.textContent = 'Checking spelling and grammar…'; run.disabled = true;
    try {
      const findings = await checkWriting([{sourceId:'page', comment:protectedText(snapshot)}]);
      if (token !== revision || body.value !== snapshot || !body.isConnected) return;
      status.textContent = findings.length ? `${findings.length} suggestion${findings.length === 1 ? '' : 's'} found. Review each before applying.` : 'No spelling or grammar issues found.';
      for (const issue of findings) {
        const row = document.createElement('div');
        const desc = document.createElement('p'); desc.textContent = `${issue.problem} — ${issue.message}`; row.append(desc);
        for (const replacement of issue.suggestions) {
          const apply = document.createElement('button'); apply.type='button'; apply.textContent=writingSuggestionLabel(issue.problem,replacement);
          apply.addEventListener('click', () => {
            if (token !== revision || body.value !== snapshot || body.value.slice(issue.start,issue.end) !== issue.problem) { invalidate(); return; }
            body.setRangeText(replacement,issue.start,issue.end,'end'); body.dispatchEvent(new Event('input',{bubbles:true})); body.focus();
          }); row.append(apply);
        }
        const ignore=document.createElement('button'); ignore.type='button'; ignore.textContent='Ignore'; ignore.addEventListener('click',()=>{row.remove(); if (!list.children.length) status.textContent='All suggestions reviewed.'}); row.append(ignore); list.append(row);
      }
    } catch (_) { if(token === revision) status.textContent = 'The check could not run. Your text is unchanged; please try again.'; }
    finally { run.disabled = false; }
  });
  return wrap;
}

function attachToPage() {
  const body = document.querySelector('#draft');
  if (!body || body.dataset.languageCheckAttached) return;
  body.dataset.languageCheckAttached = 'true';
  body.after(attachLanguageCheck(body));
}
if (typeof document !== 'undefined') {
  new MutationObserver(attachToPage).observe(document.querySelector('#app'), {childList:true, subtree:true});
  attachToPage();
}
