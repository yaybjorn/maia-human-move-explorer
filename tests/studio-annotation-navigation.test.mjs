import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as doc from '../app/static/studio-document.mjs';
import {annotationChecklist,currentAnnotationFinding} from '../app/static/studio-annotation-checklist.mjs';
const source=readFileSync(new URL('../app/static/studio.js',import.meta.url),'utf8');
const body=source.match(/function renderAnnotationChecklist\(\) \{[\s\S]*?\n\}\n\nfunction writingSources/)[0].replace(/\n\nfunction writingSources$/, '');
function setup(){
 const parsed=uci=>({nodes:[{id:1,parent_id:null,ply:1,uci,san:uci==='e2e4'?'e4':'d4',comment:''}]});
 let document=doc.addIndependentChapter(doc.newChapterCourse({side:'white'}),parsed('e2e4'),'A','a');
 document=doc.addIndependentChapter(document,parsed('d2d4'),'B','b');document=doc.activateChapter(document,'a');
 const state={courseID:'course',document,editorPanels:{},currentNodeID:null,diagnosticGeneration:0};let buttons=[],status='';
 const container={innerHTML:'',querySelectorAll:()=>buttons};
 const sandbox={state,annotationChecklist,currentAnnotationFinding,...doc,escapeHTML:String,flushActiveEditor(){},
  $(id){return id==='annotation-checklist'?container:{focus(){}}},requestAnimationFrame(fn){fn()},
  showStatus(s){status=s},selectIndependentChapter(id){state.document=doc.activateChapter(state.document,id)},
  navigate(id){state.currentNodeID=id},renderInspector(){},switchView(){}};
 vm.createContext(sandbox);vm.runInContext(body,sandbox);
 buttons=['a','b'].map((_,i)=>({dataset:{annotationKind:'comment',annotationIndex:String(i)},addEventListener(_event,fn){this.click=fn}}));
 sandbox.renderAnnotationChecklist();return {state,buttons,get status(){return status}};
}
test('production Open move handler tolerates save normalization and opens the exact other chapter, without content edits',()=>{
 const h=setup(),snapshot=JSON.stringify(h.state.document);h.state.document.metadata.title='Normalized by save';
 assert.notEqual(JSON.stringify(h.state.document),snapshot); // previous whole-document guard rejected this
 const expected=doc.syncActiveChapter(h.state.document);h.buttons[1].click();
 assert.equal(h.state.document.activeChapterID,'b');assert.equal(h.state.currentNodeID,'1');
 assert.deepEqual(doc.syncActiveChapter(h.state.document).chapterSources,expected.chapterSources);assert.equal(h.status,'');
});
test('production Open move handler rejects changed, removed and explained targets',()=>{
 for(const mutation of [d=>d.chapterSources[1].nodes[0].uci='e2e4',d=>d.chapterSources[1].nodes=[],d=>d.chapterSources[1].nodes[0].comment='Explained']){
  const h=setup();mutation(h.state.document);const before=JSON.stringify(h.state.document);h.buttons[1].click();
  assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.currentNodeID,null);assert.match(h.status,/changed/);
 }
});

test('handler rejects a finding from a different course',()=>{
 const h=setup();h.state.courseID='other';h.buttons[1].click();assert.equal(h.state.currentNodeID,null);assert.match(h.status,/changed/);
});
