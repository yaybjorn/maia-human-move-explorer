import test from 'node:test';import assert from 'node:assert/strict';
import {newChapterCourse,addIndependentChapter,activateChapter,trainingPack,normalizeDocument,importParsedPGN} from '../app/static/studio-document.mjs';
import {sharedCommentIndex,sharedCommentFor,writeSharedComment,commentParts,commentOriginRecords,restoreCommentOrigins,headersWithCommentOrigins} from '../app/static/studio-shared-comments.mjs';
import {annotationChecklist} from '../app/static/studio-annotation-checklist.mjs';
const parsed=(comment='')=>({nodes:[{id:1,parent_id:null,ply:1,uci:'e2e4',san:'e4',comment}]});
function fixture(a='A plan',b=''){let d=addIndependentChapter(newChapterCourse({side:'white'}),parsed(a),'A','a');d=addIndependentChapter(d,parsed(b),'B','b');return activateChapter(d,'a')}
test('same position and move shares prose but preserves local directives and learner/checklist output',()=>{const d=fixture('A plan [%cal Ge2e4]','[%csl Re4]'),i=sharedCommentIndex(d);assert.equal(sharedCommentFor(i,'b','1').prose,'A plan');assert.equal(sharedCommentFor(i,'b','1').inherited,true);assert.ok(!annotationChecklist(d).missingComments.some(x=>x.chapterID==='b'));assert.match(trainingPack(d).positions.find(x=>x.chapterID==='b').correctMove.feedback,/A plan/);assert.equal(commentParts(d.chapterSources[1].nodes[0].comment).directives[0],'[%csl Re4]')});
test('distinct authored comments are retained and no default is chosen for blank matches',()=>{let d=fixture('One','Two');d=addIndependentChapter(d,parsed(''),'C','c');const i=sharedCommentIndex(d);assert.equal(sharedCommentFor(i,'a','1').prose,'One');assert.equal(sharedCommentFor(i,'b','1').prose,'Two');assert.equal(sharedCommentFor(i,'c','1').prose,'');assert.equal(sharedCommentFor(i,'c','1').conflict,true)});
test('explicit blank and inherited values survive origin restore and exported header import',()=>{let d=fixture();d.chapterSources[1].nodes[0].commentMode='own';const records=commentOriginRecords(sharedCommentIndex(d));let reopened=normalizeDocument({...d,sharedCommentOrigins:records});delete reopened.chapterSources[1].nodes[0].commentMode;restoreCommentOrigins(reopened);assert.equal(sharedCommentFor(sharedCommentIndex(reopened),'b','1').prose,'');assert.equal(reopened.chapterSources[1].nodes[0].commentMode,'own');const h=headersWithCommentOrigins({},sharedCommentIndex(d),'b');const imported=importParsedPGN({...parsed(''),headers:h},{side:'white'});assert.equal(imported.nodes[0].commentMode,'own')});
test('editing a shared occurrence updates the shared donor, not an explicit exception',()=>{let d=fixture();d=writeSharedComment(d,'b','1','New plan');assert.equal(sharedCommentFor(sharedCommentIndex(d),'a','1').prose,'New plan');assert.equal(sharedCommentFor(sharedCommentIndex(d),'b','1').prose,'New plan')});
test('the same move as correct in one chapter and wrong in another never shares feedback',()=>{
 let d=fixture('Correct text','');d.chapterSources[1].nodes.unshift({id:'alternative',parentId:null,ply:1,uci:'d2d4',san:'d4',comment:'',hint:'',startingComment:'',nags:[]});
 assert.equal(sharedCommentFor(sharedCommentIndex(d),'b','1').prose,'');
});
test('inherited materialized prose retains its link after save normalization and reload',()=>{
 const d=fixture(),records=commentOriginRecords(sharedCommentIndex(d));d.chapterSources[1].nodes[0].comment='A plan';d.sharedCommentOrigins=records;
 const reopened=normalizeDocument(d);restoreCommentOrigins(reopened);
 assert.equal(reopened.chapterSources[1].nodes[0].commentMode,'inherited');
 const edited=writeSharedComment(reopened,'b','1','Updated');assert.equal(sharedCommentFor(sharedCommentIndex(edited),'a','1').prose,'Updated');
});
test('deleting a donor clears detached inherited fallback without deleting directives',async()=>{
 const {clearDetachedCommentFallbacks}=await import('../app/static/studio-shared-comments.mjs');let old=fixture('Text','Text [%csl Re4]');old.chapterSources[1].nodes[0].commentMode='inherited';let next=structuredClone(old);next.nodes=[];next.chapterSources[0].nodes=[];
 clearDetachedCommentFallbacks(old,next);assert.equal(commentParts(next.chapterSources[1].nodes[0].comment).prose,'');assert.deepEqual(commentParts(next.chapterSources[1].nodes[0].comment).directives,['[%csl Re4]']);
});
test('editing a shared value updates every equivalent donor while retaining directives',()=>{
 let d=fixture('Same [%cal Ge2e4]','Same [%csl Re4]');d=addIndependentChapter(d,parsed(''),'C','c');d=writeSharedComment(d,'c','1','Updated');const index=sharedCommentIndex(d);
 for(const id of ['a','b','c'])assert.equal(sharedCommentFor(index,id,'1').prose,'Updated');
 assert.deepEqual(commentParts(d.chapterSources[0].nodes[0].comment).directives,['[%cal Ge2e4]']);assert.deepEqual(commentParts(d.chapterSources[1].nodes[0].comment).directives,['[%csl Re4]']);
});
test('moving an inherited occurrence to a different position or answer clears stale prose',async()=>{
 const {clearDetachedCommentFallbacks}=await import('../app/static/studio-shared-comments.mjs');const old=fixture('E4 plan','E4 plan [%csl Re4]');old.chapterSources[1].nodes[0].commentMode='inherited';const next=structuredClone(old);next.chapterSources[1].nodes[0].uci='d2d4';next.chapterSources[1].nodes[0].san='d4';clearDetachedCommentFallbacks(old,next);
 assert.equal(commentParts(next.chapterSources[1].nodes[0].comment).prose,'');assert.deepEqual(commentParts(next.chapterSources[1].nodes[0].comment).directives,['[%csl Re4]']);
});
test('unchanged comments preserve their exact formatting and directive order',async()=>{
 const {commentWithProse}=await import('../app/static/studio-shared-comments.mjs');const value='  Plan  [%cal Ge2e4]  then develop  ';assert.equal(commentWithProse(value,commentParts(value).prose),value);
});
