import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as doc from '../app/static/studio-document.mjs';

const source = readFileSync(new URL('../app/static/studio.js', import.meta.url), 'utf8');
// Execute production functions; only browser rendering/network boundaries are stubbed.
const names = ['invalidateDiagnostics','diagnosticContext','diagnosticIsCurrent','requireCurrentDiagnostic',
  'writingIssueIsCurrent','writingSources','loadIgnoredWords','runSpellcheck','applyWritingFix','applyWritingFixAll',
  'runGapCheck','gapSuggestionID','nodeIDForHistory','pgnHistory','addGapMove','jumpToFinding',
  'selectIndependentChapter','commit','undo','redo','recordingPositionKey','setEffectivePosition',
  'clearRecordingMaia','disableRecordingMaiaForPositionChange','queueRecordingMaia','navigate'];
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const end = rest.search(/\n(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}
function harness() {
  const parsed = comment => ({nodes:[{id:1,parent_id:null,ply:1,uci:'e2e4',san:'e4',comment}]});
  let document = doc.addIndependentChapter(doc.newChapterCourse({title:'Course',side:'white'}),parsed('teh centre'),'A','a');
  document = doc.addIndependentChapter(document,parsed('Keep centre'),'B','b');
  document = doc.activateChapter(document,'a');
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id,{innerHTML:'',value:'1500',querySelectorAll:()=>[]});
    return elements.get(id);
  };
  const state = {document,courseID:'course',diagnosticGeneration:0,writingRequest:0,coverageRequest:0,
    ignoredWords:[],undo:[],redo:[],analysisToken:0,view:'editor',position:{fen:'start'},currentNodeID:null,
    recordingMaiaEnabled:false,recordingMaiaAbort:null,recordingMaiaToken:0,recordingSuggestions:[]};
  const noop = () => {};
  const sandbox = {...doc,state,$,structuredClone, console,
    setBusy:noop,flushActiveEditor:noop,showStatus:noop,renderAll:noop,refreshPosition:noop,switchView:noop,
    stopEditorMaia:noop,editorEngine:{cancel:noop},saveCrashRecovery:noop,updateSaveState:noop,closeRecordingChoice:noop,
    clearRecordingEffect:noop,renderMoveTree:noop,renderRecordingTree:noop,renderInspector:noop,renderRecording:noop,renderRecordingBoard:noop,
    requestAnimationFrame:noop,scrollRecordingCurrentIntoView:noop,AbortController,
    moveLabel:()=> 'e4',refreshIgnoredWords:async()=>{},checkWriting:async()=>[],
    renderWriting:(issues)=>{sandbox.rendered=issues},exportSource:async()=> '1. e4 *',
    analysisAPI:{repertoireGaps:async()=>({findings:[]})},escapeHTML:String,qualityHTML:()=> 'clean'};
  vm.createContext(sandbox);
  vm.runInContext(names.map(functionSource).join('\n'),sandbox);
  sandbox.issue = () => ({sourceId:'comment:1',comment:'teh centre',start:0,end:3,problem:'teh',context:sandbox.diagnosticContext()});
  return sandbox;
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('stale single/bulk Writing and Coverage actions cannot mutate chapter B (or revived A)',()=>{
  for(const action of ['single','bulk','coverage']) {
    const h=harness(),issue=h.issue(),finding={context:issue.context,nodeID:'1'};
    h.$('writing-results').innerHTML='old results';h.$('gap-results').innerHTML='old results';
    h.selectIndependentChapter('b');
    assert.equal(h.$('writing-results').innerHTML,'');assert.equal(h.$('gap-results').innerHTML,'');
    const perform=()=>action==='single'?h.applyWritingFix(issue,'the'):action==='bulk'?h.applyWritingFixAll([issue],'the'):h.addGapMove(finding,{uci:'e7e5',san:'e5'});
    const before=JSON.stringify(h.state.document);perform();assert.equal(JSON.stringify(h.state.document),before);
    assert.equal(h.state.document.nodes[0].comment,'Keep centre');
    h.selectIndependentChapter('a');const back=JSON.stringify(h.state.document);perform();assert.equal(JSON.stringify(h.state.document),back);
  }
});
test('same chapter edits and course changes reject old actions, including uncommitted in-place text/tree changes',()=>{
  for(const change of [h=>h.commit(doc.updateNode(h.state.document,'1',{comment:'New text'})),
    h=>{h.state.courseID='different'},h=>{h.state.document.nodes[0].comment='New text'},
    h=>{h.state.document.nodes[0].uci='d2d4'}]) {
    const h=harness(),issue=h.issue();change(h);const before=JSON.stringify(h.state.document);
    h.applyWritingFix(issue,'the');h.applyWritingFixAll([issue],'the');h.addGapMove({nodeID:'1',context:issue.context},{uci:'e7e5',san:'e5'});
    assert.equal(JSON.stringify(h.state.document),before);
  }
});
test('valid single/bulk writing fixes and coverage Add still work; bulk validates before mutation',()=>{
  for(const bulk of [false,true]) {
    const h=harness(),issue=h.issue();
    if(bulk)h.applyWritingFixAll([issue],'the');else h.applyWritingFix(issue,'the');
    assert.equal(h.state.document.nodes[0].comment,'the centre');
  }
  const h=harness();h.addGapMove({nodeID:'1',context:h.diagnosticContext()},{uci:'e7e5',san:'e5'});
  assert.equal(h.state.document.nodes.length,2);
  const bad=harness(),issue=bad.issue();
  bad.applyWritingFixAll([issue,{...issue,comment:'different'}],'the');
  assert.equal(bad.state.document.nodes[0].comment,'teh centre');
});
test('delayed Writing responses and dictionary loading never render after switch or edit',async()=>{
  for(const stage of ['dictionary','check'])for(const change of ['switch','edit']) {
    const h=harness(),wait=deferred();
    if(stage==='dictionary')h.refreshIgnoredWords=()=>wait.promise;else h.checkWriting=()=>wait.promise;
    const pending=h.runSpellcheck();await Promise.resolve();
    if(change==='switch')h.selectIndependentChapter('b');else h.commit(doc.updateNode(h.state.document,'1',{hint:'new hint'}));
    wait.resolve([]);await pending;assert.equal(h.rendered,undefined);
  }
});
test('delayed Coverage export/analysis responses never render after switch or edit',async()=>{
  for(const stage of ['export','analysis'])for(const change of ['switch','edit']) {
    const h=harness(),wait=deferred();
    if(stage==='export')h.exportSource=()=>wait.promise;else h.analysisAPI.repertoireGaps=()=>wait.promise;
    const pending=h.runGapCheck();await Promise.resolve();
    if(change==='switch')h.selectIndependentChapter('b');else h.commit(doc.updateNode(h.state.document,'1',{hint:'new hint'}));
    wait.resolve(stage==='export'?'PGN':{findings:[{history:'Starting position',missing:[]}]});await pending;
    assert.equal(h.$('gap-results').innerHTML,'');
  }
});
test('current async checks render and Writing attaches the originating context',async()=>{
  const h=harness();h.checkWriting=async()=>[{sourceId:'comment:1',comment:'teh centre',start:0,end:3}];
  await h.runSpellcheck();assert.equal(h.rendered.length,1);assert.ok(h.diagnosticIsCurrent(h.rendered[0].context));
  await h.runGapCheck();assert.equal(h.$('gap-results').innerHTML,'clean');
});
test('undo/redo invalidate diagnostics even when the old source is restored',()=>{
  const h=harness(),issue=h.issue();h.commit(doc.updateNode(h.state.document,'1',{hint:'new'}));h.undo();
  assert.equal(h.diagnosticIsCurrent(issue.context),false);
  const context=h.diagnosticContext();h.redo();h.undo();assert.equal(h.diagnosticIsCurrent(context),false);
});
test('Recording Maia turns off and a pending reply cannot render after navigation or undo/redo',async()=>{
  for (const transition of ['navigate','undo','redo']) {
    const h=harness(),wait=deferred();
    h.state.view='recording';h.state.recordingMaiaEnabled=true;h.state.currentNodeID=null;
    h.analysisAPI.maia=()=>wait.promise;
    if (transition==='undo') { const previous=structuredClone(h.state.document);previous.nodes=[];h.state.undo.push(previous);h.state.currentNodeID='1'; }
    if (transition==='redo') { const next=structuredClone(h.state.document);next.nodes[0].uci='d2d4';h.state.currentNodeID='1';h.state.redo.push(next); }
    const pending=h.queueRecordingMaia();await Promise.resolve();
    if (transition==='navigate') h.navigate('1'); else h[transition]();
    assert.equal(h.state.recordingMaiaEnabled,false,transition);
    const token=h.state.recordingMaiaToken;wait.resolve({suggestions:[{probability:.9,uci:'e7e5'}]});await pending;
    assert.equal(h.state.recordingMaiaToken,token,transition);
    assert.equal(h.state.recordingSuggestions.length,0,transition);
  }
});
test('bulk applies multiple current offsets from right to left without overwriting unrelated chapter',()=>{
  const h=harness();h.commit(doc.updateNode(h.state.document,'1',{comment:'teh teh'}));
  const context=h.diagnosticContext(),base={sourceId:'comment:1',comment:'teh teh',context};
  h.applyWritingFixAll([{...base,start:0,end:3},{...base,start:4,end:7}],'the');
  assert.equal(h.state.document.nodes[0].comment,'the the');
  h.selectIndependentChapter('b');assert.equal(h.state.document.nodes[0].comment,'Keep centre');
});
test('Fix all ellipses survives the production apply, save-payload, and reload hydration boundary',()=>{
  const h=harness();
  h.state.document=doc.normalizeDocument({metadata:{title:'Ellipses',slug:'ellipses',side:'white'},nodes:Array.from({length:16},(_,index)=>({
    id:`node-${index + 1}`,parentId:index ? `node-${index}` : null,uci:index % 2 ? 'e7e5' : 'e2e4',san:index % 2 ? 'e5' : 'e4',ply:index + 1,
    ...(index % 2 === 0 ? {hint:`Hint ${index / 2 + 1}...`} : {}),comment:index === 0 ? 'Keep 1... Nf6 notation.' : '',nags:index === 0 ? [1] : [],
  }))});
  const context=h.diagnosticContext();
  const issues=h.state.document.nodes.filter(node=>node.hint).map(node=>({sourceId:`hint:${node.id}`,comment:node.hint,start:node.hint.indexOf('...'),end:node.hint.length,problem:'...',context}));
  h.applyWritingFixAll(issues,'…');
  assert.deepEqual(h.state.document.nodes.filter(node=>node.hint).map(node=>node.hint),Array.from({length:8},(_,index)=>`Hint ${index + 1}…`));
  const serialized=doc.serializeForPGN(h.state.document);
  const saved=doc.normalizeDocument(doc.documentForStorage(h.state.document,'1. e4 e5 *'));
  const parsed={headers:{},nodes:serialized.map((node,index)=>({...node,parent_id:index ? index : null,uci:index % 2 ? 'e7e5' : 'e2e4',san:index % 2 ? 'e5' : 'e4',ply:index + 1}))};
  const reloaded=doc.hydrateRestoredDocument(parsed,saved);
  assert.deepEqual(reloaded.nodes.filter(node=>node.hint).map(node=>node.hint),Array.from({length:8},(_,index)=>`Hint ${index + 1}…`));
  assert.equal(reloaded.nodes[0].comment,'Keep 1... Nf6 notation.');
  assert.deepEqual(reloaded.nodes[0].nags,[1]);
});
test('newer Writing request wins even when older response returns last for the same source',async()=>{
  const h=harness(),first=deferred(),second=deferred();let count=0;
  h.checkWriting=()=>++count===1?first.promise:second.promise;
  const a=h.runSpellcheck({refreshDictionary:false});
  const b=h.runSpellcheck({refreshDictionary:false});
  second.resolve([{sourceId:'comment:1',comment:'teh centre',start:0,end:3,marker:'new'}]);await b;
  first.resolve([{marker:'old'}]);await a;
  assert.equal(h.rendered[0].marker,'new');
});
