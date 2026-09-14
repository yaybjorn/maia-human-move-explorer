import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app/static/studio.js',import.meta.url),'utf8');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const quality=between('async function runQuality(', 'function beginPublish');
const confirm=between('async function confirmPublish()', '\nasync function loadHistory');
function context(overrides={}) {
 const messages=[],busy=[];let calls=0;
 const state={courseID:'course',revision:210,savedSnapshot:'saved',publishCandidate:{courseID:'course',revision:210,savedSnapshot:'saved'}};
 const ctx={state,$:()=>({close(){}}),dirty:()=>false,setBusy:(_b,v)=>busy.push(v),showStatus:m=>messages.push(m),
  saveDraft:async()=>true,renderQuality(){},updateSaveState(){},loadCourses:async()=>{},loadHistory:async()=>{},
  api:{validateCourse:async()=>{throw Error('Server limit');},publishCourse:async()=>{calls++;throw Error('Response unavailable');}},...overrides};
 vm.createContext(ctx);vm.runInContext(quality+'\n'+confirm,ctx);
 return {ctx,messages,busy,calls:()=>calls};
}
test('pre-publication check failure says no publication request was sent',async()=>{
 const f=context();await f.ctx.runQuality({forPublish:true});
 assert.match(f.messages.at(-1),/No publication request was sent/);assert.equal(f.calls(),0);assert.equal(f.busy.at(-1),false);
});
test('normal Quality failure does not make publication claims',async()=>{
 const f=context();await f.ctx.runQuality();assert.equal(f.messages.at(-1),'Server limit');
});
test('lost publish response is uncertain and never retries automatically',async()=>{
 const f=context();await f.ctx.confirmPublish();assert.equal(f.calls(),1);
 assert.match(f.messages.at(-1),/could not be confirmed.*Check Version history/);assert.equal(f.ctx.state.revision,210);assert.equal(f.busy.at(-1),false);
});
test('acknowledged publication stays confirmed if history refresh fails',async()=>{
 const f=context({api:{publishCourse:async()=>({version:'2026-09-14.1',revision:211})},loadCourses:async()=>{throw Error('Refresh failed')}});
 await f.ctx.confirmPublish();assert.match(f.messages.at(-1),/^Published 2026-09-14.1/);
 assert.doesNotMatch(f.messages.at(-1),/could not be confirmed/);assert.equal(f.ctx.state.revision,211);
});
