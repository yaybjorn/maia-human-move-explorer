import test from 'node:test';
import assert from 'node:assert/strict';
import { wrongBranchDepth, visibleTrainingChildren } from '../app/static/studio-training-branch.mjs';
import { annotationChecklist } from '../app/static/studio-annotation-checklist.mjs';
import { serializeForPGN, nodeByID } from '../app/static/studio-document.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const n=(id,parentId,ply)=>({id,parentId,ply,uci:id,san:id,comment:'',hint:'',startingComment:'',nags:[]});
function fixture(side) { const nodes=side==='white'?[n('e2e4',null,1),n('d2d4',null,1),n('d7d5','d2d4',2),n('c2c4','d7d5',3),n('e7e5','e2e4',2),n('c7c5','e2e4',2),n('g1f3','c7c5',3)] : [n('e2e4',null,1),n('e7e5','e2e4',2),n('c7c5','e2e4',2),n('g1f3','c7c5',3),n('d7d6','g1f3',4),n('g8f6','e7e5',3),n('d2d4','e7e5',3),n('b8c6','d2d4',4)];return {metadata:{side},nodes,headers:{},sourcePGN:''};}
for (const side of ['white','black']) test(`${side} wrong answer stops after first reply, but source and other opponent lines remain`,()=>{const d=fixture(side),wrong=side==='white'?'d2d4':'c7c5',reply=side==='white'?'d7d5':'g1f3',hidden=side==='white'?'c2c4':'d7d6';assert.equal(wrongBranchDepth(d,wrong),0);assert.equal(wrongBranchDepth(d,reply),1);assert.equal(wrongBranchDepth(d,hidden),2);assert.deepEqual(visibleTrainingChildren(d,wrong).map(x=>x.id),[reply]);assert.deepEqual(visibleTrainingChildren(d,reply),[]);const missing=annotationChecklist(d);assert.ok(!missing.missingHints.some(x=>[wrong,hidden].includes(x.nodeID)));assert.ok(!missing.missingComments.some(x=>[wrong,hidden].includes(x.nodeID)));assert.ok(serializeForPGN(d).some(x=>x.uci===hidden));const opponentLine=side==='white'?'g1f3':'b8c6';assert.equal(wrongBranchDepth(d,opponentLine),-1);assert.ok(missing.missingComments.some(x=>x.nodeID===opponentLine));});

test('effective position clamps a newly hidden selection to the allowed reply',()=>{
 const d=fixture('white'),state={document:d,currentNodeID:'c2c4'};const source=readFileSync(new URL('../app/static/studio.js',import.meta.url),'utf8');
 const start=source.indexOf('function setEffectivePosition('),end=source.indexOf('\nfunction disableRecordingMaiaForPositionChange(',start);
 const ctx=vm.createContext({state,wrongBranchDepth,nodeByID,recordingPositionKey:()=>'',disableRecordingMaiaForPositionChange:()=>{}});vm.runInContext(source.slice(start,end),ctx);
 ctx.setEffectivePosition(d,'c2c4');assert.equal(state.currentNodeID,'d7d5');assert.ok(d.nodes.some(node=>node.id==='c2c4'));
});
