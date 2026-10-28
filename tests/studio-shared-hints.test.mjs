import {sharedCommentIndex,sharedCommentFor,commentWithProse,commentParts} from '../app/static/studio-shared-comments.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../app/static/vendor/chessjs/chess.mjs';
import { sharedHintIndex, sharedHintFor, hintOriginRecords, restoreHintOrigins, hintPositionKey, headersWithHintOrigins, restoreHintHeader, coalesceIdenticalHints, writeSharedHint, clearDetachedHintFallbacks } from '../app/static/studio-shared-hints.mjs';
import { annotationChecklist } from '../app/static/studio-annotation-checklist.mjs';
import { trainingPack, serializeForPGN, commentWithHint } from '../app/static/studio-document.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
function chapter(id,moves,hint='',mode='') { const chess=new Chess();let parentId=null;const nodes=moves.map((uci,i)=>{const m=chess.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});const n={id:`${id}${i}`,parentId,uci,san:m.san,ply:i+1,comment:'',startingComment:'',hint:i===moves.length-1?hint:'',...(i===moves.length-1&&mode?{hintMode:mode}:{})};parentId=n.id;return n});return {id,title:id,nodes,headers:{},sourcePGN:'',trainingStartPath:[]}; }
const seq1=['g1f3','g8f6','g2g3','g7g6','f1g2'];
const seq2=['g2g3','g7g6','g1f3','g8f6','f1g2'];
function course(hints=['Remember the bishop','','']) { const cs=[chapter('a',seq1,hints[0]),chapter('b',seq2,hints[1]),chapter('c',seq2,hints[2])];return {metadata:{side:'white'},activeChapterID:'a',nodes:structuredClone(cs[0].nodes),headers:{},sourcePGN:'',chapterSources:cs}; }
test('same legal position and answer inherits across transpositions, preview and checklist',()=>{const d=course();const index=sharedHintIndex(d);assert.equal(sharedHintFor(index,'b','b4').hint,'Remember the bishop');assert.equal(sharedHintFor(index,'b','b4').inherited,true);assert.equal(trainingPack(d).positions.find(p=>p.chapterID==='b'&&p.correctMove.uci==='f1g2').hint,'Remember the bishop');assert.ok(!annotationChecklist(d).missingHints.some(x=>x.chapterID==='b'&&x.nodeID==='b4'));});
test('conflicts reuse a stable hint; explicit blank override survives origin roundtrip',()=>{const d=course(['One','Two','']);let ix=sharedHintIndex(d);assert.equal(sharedHintFor(ix,'c','c4').hint,'One');assert.equal(sharedHintFor(ix,'c','c4').conflict,true);d.chapterSources[1].nodes[4].hint='';d.chapterSources[2].nodes[4].hintMode='own';ix=sharedHintIndex(d);assert.equal(sharedHintFor(ix,'b','b4').hint,'One');assert.equal(sharedHintFor(ix,'c','c4').hint,'');d.sharedHintOrigins=hintOriginRecords(ix);d.chapterSources[1].nodes[4].hint='One';delete d.chapterSources[2].nodes[4].hintMode;restoreHintOrigins(d);assert.equal(d.chapterSources[1].nodes[4].hint,'One');assert.equal(d.chapterSources[1].nodes[4].hintMode,'inherited');assert.equal(d.chapterSources[2].nodes[4].hintMode,'own');assert.equal(sharedHintFor(sharedHintIndex(d),'b','b4').hint,'One');});
test('different intended answers do not share',()=>{const d=course();d.chapterSources[1]=chapter('b',['g2g3','g7g6','g1f3','g8f6','b1c3']);assert.equal(sharedHintFor(sharedHintIndex(d),'b','b4').hint,'');});

test('position keys preserve castling and legal en passant, ignore clocks and irrelevant en passant',()=>{
  const k=(fen)=>hintPositionKey(new Chess(fen),'e1e2');
  assert.equal(k('4k3/8/8/8/8/8/8/4K3 w - - 0 1'),k('4k3/8/8/8/8/8/8/4K3 w - - 40 90'));
  assert.notEqual(k('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'),k('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1'));
  assert.notEqual(k('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'),k('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1'));
  assert.equal(k('4k3/8/8/3p4/8/8/8/4K3 w - d6 0 1'),k('4k3/8/8/3p4/8/8/8/4K3 w - - 0 1'));
});

test('identical imported hints share by default, explicit own and conflicts remain',()=>{
 const d=course(['Same','Same','Same']);d.chapterSources[2].nodes[4].hintMode='own';
 coalesceIdenticalHints(d);assert.equal(d.chapterSources[1].nodes[4].hint,'');assert.equal(d.chapterSources[2].nodes[4].hint,'Same');
 d.nodes[4].hint='New';const index=sharedHintIndex(d);assert.equal(sharedHintFor(index,'b','b4').hint,'New');assert.equal(sharedHintFor(index,'b','b4').conflict,false);assert.equal(sharedHintFor(index,'c','c4').hint,'Same');
 const clean=course(['Same','Same','']);coalesceIdenticalHints(clean);clean.nodes[4].hint='New';assert.equal(sharedHintFor(sharedHintIndex(clean),'b','b4').hint,'New');
});
test('exported PGN headers restore inheritance and intentional blank on import',()=>{
 const d=course();d.chapterSources[2].nodes[4].hintMode='own';const index=sharedHintIndex(d);
 for (const id of ['b','c']) { const ch=d.chapterSources.find(c=>c.id===id),source=sharedHintFor(index,id,`${id}4`);const headers=headersWithHintOrigins({},index,id);
   const imported={metadata:d.metadata,nodes:structuredClone(ch.nodes),headers};imported.nodes[4].hint=source.hint;delete imported.nodes[4].hintMode;restoreHintHeader(imported);
   assert.equal(imported.nodes[4].hint,id==='b'?'Remember the bishop':'');assert.equal(imported.nodes[4].hintMode,id==='c'?'own':'inherited');
 }
});

test('editing an inherited shared hint updates its donor without changing explicit exceptions',()=>{
 const d=course(['Original','','Exception']);d.chapterSources[2].nodes[4].hintMode='own';
 const next=writeSharedHint(d,'b','b4','Revised');const index=sharedHintIndex(next);
 assert.equal(sharedHintFor(index,'a','a4').hint,'Revised');assert.equal(sharedHintFor(index,'b','b4').hint,'Revised');assert.equal(sharedHintFor(index,'c','c4').hint,'Exception');
});

test('standalone exported inherited hint remains usable without its original donor',()=>{
 const d=course(), index=sharedHintIndex(d), ch=d.chapterSources[1], headers=headersWithHintOrigins({},index,'b');
 const imported={metadata:d.metadata,nodes:structuredClone(ch.nodes),headers};imported.nodes[4].hint=sharedHintFor(index,'b','b4').hint;restoreHintHeader(imported);
 assert.equal(sharedHintFor(sharedHintIndex(imported),null,'b4').hint,'Remember the bishop');
});

test('clearing a shared donor removes generated fallbacks rather than resurrecting old hints',()=>{
 const d=course(['Old','','']);d.chapterSources[1].nodes[4].hint='Old';d.chapterSources[1].nodes[4].hintMode='inherited';
 const cleared=writeSharedHint(d,'a','a4','');const index=sharedHintIndex(cleared);
 assert.equal(sharedHintFor(index,'a','a4').hint,'');assert.equal(sharedHintFor(index,'b','b4').hint,'');assert.equal(cleared.chapterSources[1].nodes[4].hint,'');
});

test('deleting a linked donor clears fallback; importing an orphan retains it',()=>{
 const d=course(['Old','','']);d.chapterSources[1].nodes[4].hint='Old';d.chapterSources[1].nodes[4].hintMode='inherited';
 const next=structuredClone(d);next.nodes=next.nodes.slice(0,4);next.chapterSources[0].nodes=next.nodes;
 clearDetachedHintFallbacks(d,next);assert.equal(sharedHintFor(sharedHintIndex(next),'b','b4').hint,'');
 const orphan={metadata:d.metadata,nodes:structuredClone(d.chapterSources[1].nodes)};
 assert.equal(sharedHintFor(sharedHintIndex(orphan),null,'b4').hint,'Old');
});

test('compiler-facing serialization replaces a stale fallback with the selected hint',()=>{
 const d=course(['One','Two','']);d.chapterSources[2].nodes[4].hint='Old';d.chapterSources[2].nodes[4].hintMode='inherited';
 const src=readFileSync(new URL('../app/static/studio.js',import.meta.url),'utf8');const start=src.indexOf('function serializeEffectiveHints('),end=src.indexOf('\nasync function exportAllChapterSources',start);
 const context=vm.createContext({sharedHintIndex,sharedHintFor,serializeForPGN,commentWithHint,sharedCommentIndex,sharedCommentFor,commentWithProse,commentParts});vm.runInContext(src.slice(start,end),context);
 const result=context.serializeEffectiveHints(d,d.chapterSources[2],'c');assert.match(result[4].comment,/\[%hint One\]/);
});

test('continuations after a wrong learner answer cannot donate training hints',()=>{
 const a=chapter('a',['e2e4','e7e5','g1f3'],'Main');const wrong=chapter('x',['d2d4','d7d5','g1f3'],'Wrong branch');wrong.nodes[0].parentId=null;
 const nodes=[...a.nodes,...wrong.nodes];const d={metadata:{side:'white'},nodes};const index=sharedHintIndex(d);
 assert.equal(sharedHintFor(index,null,'x2'),undefined);assert.equal(sharedHintFor(index,null,'a2').hint,'Main');
});

 test('conflicting defaults preserve authored values and survive save and export origins',()=>{
 const d=course(['One','Two','']);const before=structuredClone(d);let index=sharedHintIndex(d);
 assert.equal(sharedHintFor(index,'a','a4').hint,'One');assert.equal(sharedHintFor(index,'b','b4').hint,'Two');
 for(let i=0;i<3;i++) assert.equal(sharedHintFor(sharedHintIndex(d),'c','c4').hint,'One');
 assert.deepEqual(d,before);
 const headers=headersWithHintOrigins({},index,'c'), ch=d.chapterSources[2];
 const imported={metadata:d.metadata,nodes:structuredClone(ch.nodes),headers}; imported.nodes[4].hint='One';restoreHintHeader(imported);
 assert.equal(imported.nodes[4].hintMode,'inherited');assert.equal(sharedHintFor(sharedHintIndex(imported),null,'c4').hint,'One');
 const saved=structuredClone(d);saved.sharedHintOrigins=hintOriginRecords(index);saved.chapterSources[2].nodes[4].hint='One';restoreHintOrigins(saved);
 assert.equal(sharedHintFor(sharedHintIndex(saved),'c','c4').hint,'One');
 const edited=writeSharedHint(d,'c','c4','Personal');assert.equal(sharedHintFor(sharedHintIndex(edited),'c','c4').hint,'Personal');
 assert.equal(edited.chapterSources[2].nodes[4].hintMode,'own');assert.equal(edited.chapterSources[1].nodes[4].hint,'Two');
 assert.equal(sharedHintFor(sharedHintIndex(course(['Other','',''])),'c','c4').hint,'Other');
});
