import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {SingleFlight} from '../app/static/studio-save.mjs';
const source=readFileSync(new URL('../app/static/studio.js',import.meta.url),'utf8');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const quality=between('async function runQuality(', 'function beginPublish');
const confirm=between('function resetPublishFeedback()', '\nasync function loadHistory');
function context(overrides={}) {
 const messages=[],busy=[],elements=new Map();let calls=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'Publish to app',hidden:false,disabled:false,dataset:{},setAttribute(){},close(){this.closed=true},focus(){this.focused=true},scrollIntoView(){this.scrolled=true}});return elements.get(id);};
 const state={courseID:'course',revision:210,savedSnapshot:'saved',publishCandidate:{courseID:'course',revision:210,revisionHash:'server-hash',savedSnapshot:'saved'}};
 const ctx={state,$:element,publishSubmissionFlight:new SingleFlight(),publishPending:false,switchView(){},dirty:()=>false,setBusy:(_b,v)=>busy.push(v),showStatus:m=>messages.push(m),
  saveDraft:async()=>true,renderQuality(){},updateSaveState(){},loadCourses:async()=>{},loadHistory:async()=>{},
  api:{validateCourse:async()=>{throw Error('Server limit');},publishCourse:async()=>{calls++;throw Error('Response unavailable');}},...overrides};
 vm.createContext(ctx);vm.runInContext(quality+'\n'+confirm,ctx);
 return {ctx,messages,busy,elements,feedback:()=>element('publish-feedback').textContent,calls:()=>calls};
}
test('pre-publication check failure says no publication request was sent',async()=>{
 const f=context();await f.ctx.runQuality({forPublish:true});
 assert.match(f.messages.at(-1),/No publication request was sent/);assert.equal(f.calls(),0);assert.equal(f.busy.at(-1),false);
});
test('normal Quality failure does not make publication claims',async()=>{
 const f=context();await f.ctx.runQuality();assert.equal(f.messages.at(-1),'Server limit');
});
test('a fresh failed check replaces stale passing results with a service blocker',async()=>{
 const f=context();f.ctx.state.validation={valid:true,errors:[],warnings:[]};
 await f.ctx.runQuality();assert.equal(f.ctx.state.validation.valid,false);
 assert.equal(f.ctx.state.validation.errors[0].area,'Server checks');
 assert.match(f.ctx.state.validation.errors[0].message,/could not complete/);
});
test('pending checks are not shown as passing and successful retry replaces the failure',async()=>{
 const result={valid:true,revision:210,errors:[],warnings:[]};let pending;
 const f=context({api:{validateCourse:async()=>{pending=f.ctx.state.validation;return result;}}});
 f.ctx.state.validation={valid:false,errors:[{message:'previous failure'}]};
 await f.ctx.runQuality();assert.equal(pending.valid,false);assert.match(pending.errors[0].message,/running/);
 assert.equal(f.ctx.state.validation,result);assert.equal(f.messages.at(-1),'Quality checks complete.');
});
test('lost publish response is uncertain and never retries automatically',async()=>{
 const f=context();await f.ctx.confirmPublish();assert.equal(f.calls(),1);
 assert.match(f.feedback(),/could not be confirmed.*Check Version history/);assert.equal(f.ctx.state.revision,210);assert.equal(f.busy.at(-1),false);
});
test('acknowledged publication stays confirmed if history refresh fails',async()=>{
 const f=context({api:{publishCourse:async()=>({version:'2026-09-14.1',revision:211})},loadCourses:async()=>{throw Error('Refresh failed')}});
 await f.ctx.confirmPublish();assert.match(f.feedback(),/^Published 2026-09-14.1/);
 assert.doesNotMatch(f.feedback(),/could not be confirmed/);assert.equal(f.ctx.state.revision,211);
});


test('final pending and error are inside modal, focusable and persistent; no repeat submit',async()=>{
 let reject,requests=0;
 const f=context({api:{publishCourse:()=>{requests++;return new Promise((_r,j)=>{reject=j;});}}});
 const one=f.ctx.confirmPublish(),two=f.ctx.confirmPublish();await Promise.resolve();
 assert.equal(one,two);assert.equal(requests,1);assert.match(f.feedback(),/Publishing this reviewed draft/);
 assert.equal(f.elements.get('cancel-publish').disabled,true);
 assert.equal(f.elements.get('publish-feedback').focused,true);
 f.ctx.closePublishDialog();assert.notEqual(f.elements.get('publish-dialog').closed,true);
 reject(Error('Conflict'));await one;
 assert.match(f.feedback(),/could not be confirmed.*Conflict/);assert.equal(f.elements.get('publish-feedback').hidden,false);
 assert.equal(f.elements.get('publish-history').hidden,false);assert.equal(f.elements.get('confirm-publish').hidden,true);
 await f.ctx.confirmPublish();assert.equal(requests,1);
});
test('frozen review hash, revision and snapshot are sent to final API',async()=>{
 let args;const f=context({api:{publishCourse:async(...a)=>{args=a;return{version:'2026-09-14.1',revision:210};}}});
 await f.ctx.confirmPublish();assert.deepEqual(args,['course',210,'server-hash']);
 assert.match(f.feedback(),/^Published/);assert.equal(f.elements.get('publish-dialog').closed,undefined);
});
test('stale or missing reviewed source cannot submit',async()=>{
 for(const change of [s=>s.revision++,s=>s.savedSnapshot='changed',s=>s.publishCandidate.revisionHash='',s=>s.courseID='other']){
  const f=context();change(f.ctx.state);await f.ctx.confirmPublish();assert.equal(f.calls(),0);assert.match(f.feedback(),/No publication request was sent/);
 }
});
test('ambiguous server commit followed by lost acknowledgement never claims failure or retries',async()=>{
 let committed=0;const f=context({api:{publishCourse:async()=>{committed++;throw Error('Network interrupted after commit');}}});
 await f.ctx.confirmPublish();await f.ctx.confirmPublish();assert.equal(committed,1);assert.match(f.feedback(),/could not be confirmed/);
 assert.doesNotMatch(f.feedback(),/not published|No publication request was sent|^Published/);
});
test('confirmed receipt survives a specific history refresh error',async()=>{
 let options;const f=context({api:{publishCourse:async()=>({version:'2026-09-14.1',revision:210})},loadHistory:async(o)=>{options=o;throw Error('history failed');}});
 await f.ctx.confirmPublish();assert.equal(options.throwOnError,true);assert.match(f.feedback(),/^Published.*could not refresh/);
});
test('final feedback markup is inside the actual modal, not the global toast',()=>{
 const html=readFileSync(new URL('../app/static/studio.html',import.meta.url),'utf8');
 const dialog=html.slice(html.indexOf('<dialog id="publish-dialog"'),html.indexOf('</dialog>',html.indexOf('<dialog id="publish-dialog"')));
 assert.match(dialog,/id="publish-feedback".*aria-live="polite".*tabindex="-1"/);
 assert.match(dialog,/id="publish-history"/);assert.match(source,/publish-dialog.*addEventListener\("cancel"/);
});

test('publish review freezes the last server validation hash after preparation',async()=>{
 const prepare=between('async function preparePublish()', '\nfunction resetPublishFeedback');
 for(const stale of [false,true]){
  const f=context({
   runQuality:async()=>({revision:stale?209:210,revisionHash:'latest-server-hash'}),
   combinedValidation:()=>({blockers:[],warnings:[]}),resolveCompiledChapters:()=>true,
   trainingPack:()=>({positions:[{}]}),ensureChapters:()=>[{}],escapeHTML:x=>x,
   api:{versions:async()=>({versions:[]})},
  });
  f.ctx.state.document={chapterDrafts:[{}],metadata:{title:'Fixture',slug:'fixture'}};
  f.ctx.$('publish-dialog').showModal=()=>{};
  // runQuality declaration from the source extraction is replaced with a test response.
  f.ctx.runQuality=async()=>({revision:stale?209:210,revisionHash:'latest-server-hash'});f.ctx.resolveCompiledChapters=()=>true;
  vm.runInContext(prepare,f.ctx);await f.ctx.preparePublish();
  if(stale){assert.equal(f.ctx.state.publishCandidate,null);assert.match(f.messages.at(-1),/No publication request was sent/);}
  else {assert.equal(f.ctx.state.publishCandidate.revisionHash,'latest-server-hash');assert.equal(f.ctx.state.publishCandidate.attempted,false);}
 }
});
