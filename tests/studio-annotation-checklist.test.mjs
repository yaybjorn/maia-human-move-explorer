import test from 'node:test';
import assert from 'node:assert/strict';
import {annotationChecklist,hasProseComment} from '../app/static/studio-annotation-checklist.mjs';
const node=(id,parentId,ply,san,comment='',hint='')=>({id,parentId,ply,san,uci:id,comment,hint,startingComment:'',nags:[]});
function course(side='white'){const a=[node('e2e4',null,1,'e4','[%cal Ge2e4]',''),node('d2d4',null,1,'d4','   ','ignored'),node('e7e5','e2e4',2,'e5','Answer',''),node('g1f3','e7e5',3,'Nf3','A plan','Good hint')],b=[node('d2d4',null,1,'d4','[%hint alone]',''),node('d7d5','d2d4',2,'d5','   ','')];return {metadata:{side},activeChapterID:'a',nodes:a,headers:{},sourcePGN:'',chapterSources:[{id:'a',title:'First',nodes:a,headers:{},sourcePGN:''},{id:'b',title:'Second',nodes:b,headers:{},sourcePGN:''}]};}
test('comments require prose, not directives or whitespace',()=>{for(const s of ['','  ','[%cal Ge2e4] [%csl Re4]','[%hint look here]'])assert.equal(hasProseComment(s),false);assert.equal(hasProseComment('[%cal Ge2e4] Develop!'),true)});
test('white hints only main learner answers; comments cover recommended learner moves in all chapters',()=>{const r=annotationChecklist(course());assert.equal(r.moveCount,6);assert.deepEqual(r.missingHints.map(x=>[x.chapterID,x.nodeID]),[['a','e2e4'],['b','d2d4']]);assert.deepEqual(r.missingComments.map(x=>[x.chapterID,x.nodeID]),[['a','e2e4'],['b','d2d4']]);assert.equal(r.missingComments.at(-1).history,'1. d4')});
test('black main answers, current unsaved active projection, and empty course',()=>{const d=course('black');d.nodes[2]={...d.nodes[2],hint:'Now present'};const r=annotationChecklist(d);assert.deepEqual(r.missingHints.map(x=>[x.chapterID,x.nodeID]),[['b','d7d5']]);assert.deepEqual(r.missingComments.map(x=>[x.chapterID,x.nodeID]),[['b','d7d5']]);assert.equal(annotationChecklist({metadata:{side:'white'},nodes:[],chapterSources:[],activeChapterID:null}).moveCount,0)});

test('black alternatives are optional; white opponent moves do not require comments',()=>{const d=course('black');d.nodes.push(node('c7c5','e2e4',2,'c5','  '));const r=annotationChecklist(d);assert.deepEqual(r.missingComments.map(x=>[x.chapterID,x.nodeID]),[['b','d7d5']]);assert.deepEqual(r.missingHints.map(x=>[x.chapterID,x.nodeID]),[['a','e7e5'],['b','d7d5']]);assert.equal(r.missingComments[0].history,'1. d4 1… d5')});

test('navigation revalidates the current chapter and full path without depending on unrelated document changes', async()=>{
  const {currentAnnotationFinding}=await import('../app/static/studio-annotation-checklist.mjs');
  const d=course(), finding=annotationChecklist(d).missingComments.find(x=>x.chapterID==='b');
  d.metadata.title='Unrelated save normalization';
  assert.equal(currentAnnotationFinding(d,finding,'comment')?.nodeID,'d2d4');
  // Navigation changes the active projection but keeps the same chapter tree.
  const {activateChapter}=await import('../app/static/studio-document.mjs');
  const switched=activateChapter(d,'b');
  assert.equal(currentAnnotationFinding(switched,finding,'comment')?.chapterID,'b');
  switched.nodes[0].uci='e2e4';
  assert.equal(currentAnnotationFinding(switched,finding,'comment'),null);
  switched.nodes[0].uci='d2d4'; switched.nodes[0].comment='Now explained';
  assert.equal(currentAnnotationFinding(switched,finding,'comment'),null);
  switched.nodes[0].comment=''; switched.chapterSources[1].archived=true;
  assert.equal(currentAnnotationFinding(switched,finding,'comment'),null);
});

test('a changed ancestor invalidates a finding even when the destination node is unchanged', async()=>{
  const {currentAnnotationFinding}=await import('../app/static/studio-annotation-checklist.mjs');
  const d=course('black'), finding=annotationChecklist(d).missingComments.find(x=>x.chapterID==='b');
  d.chapterSources[1].nodes[0].uci='e2e4';
  assert.equal(currentAnnotationFinding(d,finding,'comment'),null);
});
