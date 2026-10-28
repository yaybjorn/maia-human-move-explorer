import { Chess } from './vendor/chessjs/chess.mjs';
import { hintPositionKey } from './studio-shared-hints.mjs?v=20261027-shared-hints';

// Directives belong to their original move; only the prose is shared.
export function commentParts(value='') {
  const directives=String(value).match(/\[%[^\]]*\]/g)||[];
  return {prose:String(value).replace(/\[%[^\]]*\]/g,' ').trim(),directives};
}
export function commentWithProse(value, prose) {
  const original=String(value||''), normalized=String(prose||'').trim();
  if(commentParts(original).prose===normalized)return original;
  return [normalized,...commentParts(original).directives].filter(Boolean).join(' ');
}
export function sharedCommentIndex(document) {
  const chapters=Array.isArray(document.chapterSources)
    ? document.chapterSources.filter(c=>!c.archived).map(c=>({id:c.id,nodes:c.id===document.activeChapterID?document.nodes:c.nodes}))
    : [{id:null,nodes:document.nodes}];
  const groups=new Map(), result=new Map();
  for(const chapter of chapters){
    const children=new Map();for(const node of chapter.nodes||[]){const key=node.parentId??null;const list=children.get(key)||[];list.push(node);children.set(key,list)}
    const visit=(parent,board,path,wrong=false)=>{for(const [i,node] of (children.get(parent)||[]).entries()){
      let next;try{next=new Chess(board.fen());next.move({from:node.uci.slice(0,2),to:node.uci.slice(2,4),promotion:node.uci[4]})}catch{continue}
      const learner=node.ply%2===(document.metadata.side==='black'?0:1), category=wrong?'wrong-line':learner?(i?'wrong':'correct'):'opponent';
      const occurrence={chapterID:chapter.id,nodeID:node.id,node,path:[...path,node.uci],key:`${category}|${hintPositionKey(board,node.uci)}`};
      const group=groups.get(occurrence.key)||[];group.push(occurrence);groups.set(occurrence.key,group);
      visit(node.id,next,occurrence.path,wrong||category==='wrong');
    }};visit(null,new Chess(),[]);
  }
  for(const group of groups.values()){
    const values=[...new Set(group.filter(o=>!['own','inherited'].includes(o.node.commentMode)).map(o=>commentParts(o.node.comment).prose).filter(Boolean))];
    for(const o of group){const own=commentParts(o.node.comment).prose, isOwn=o.node.commentMode==='own', inherited=o.node.commentMode==='inherited';
      const prose=isOwn?own:own&&!inherited?own:values.length===1?values[0]:inherited&&values.length===0?own:'';
      result.set(JSON.stringify([o.chapterID,o.nodeID]),{...o,prose,conflict:values.length>1,inherited:!isOwn&&Boolean(prose)&&(inherited||!own)});
    }
  }return result;
}
export function sharedCommentFor(index,chapterID,nodeID){return index.get(JSON.stringify([chapterID??null,nodeID]))}
export function writeSharedComment(document,chapterID,nodeID,value){
  const next=structuredClone(document),index=sharedCommentIndex(next),target=sharedCommentFor(index,chapterID,nodeID);if(!target)return next;
  const prose=commentParts(value).prose;
  if(target.node.commentMode==='own'||target.conflict){target.node.comment=commentWithProse(value,prose);target.node.commentMode='own';return next}
  target.node.comment=commentWithProse(value,commentParts(target.node.comment).prose);
  const group=[...index.values()].filter(o=>o.key===target.key),donor=group.find(o=>commentParts(o.node.comment).prose&&!['own','inherited'].includes(o.node.commentMode))||target;
  const old=target.prose;
  for(const o of group)if(o.node.commentMode!=='own' && (o===donor || o.node.commentMode==='inherited' || (old && commentParts(o.node.comment).prose===old))) {
    o.node.comment=commentWithProse(o.node.comment,prose);if(o===donor)delete o.node.commentMode;
  }
  if(donor===target)donor.node.comment=commentWithProse(value,prose);
  return next;
}
export function commentOriginRecords(index){return [...index.values()].filter(o=>o.inherited||o.node.commentMode==='own').map(o=>({chapterID:o.chapterID,path:o.path,mode:o.inherited?'inherited':'own',value:o.prose}))}
export function restoreCommentOrigins(document){
  if(!Array.isArray(document.sharedCommentOrigins))return document;
  const records=new Map(document.sharedCommentOrigins.map(r=>[JSON.stringify([r.chapterID??null,r.path]),r]));
  for(const o of sharedCommentIndex(document).values()){const record=records.get(JSON.stringify([o.chapterID,o.path]));if(record&&['own','inherited'].includes(record.mode)&&commentParts(o.node.comment).prose===(record.value||''))o.node.commentMode=record.mode}
  return document;
}
const HEADER='GingerGMCommentOrigins';
export function headersWithCommentOrigins(headers,index,chapterID){
  const result={...headers};delete result[HEADER];const entries=commentOriginRecords(index).filter(x=>x.chapterID===(chapterID??null)).map(({chapterID:_,...entry})=>entry);
  if(entries.length)result[HEADER]=encodeURIComponent(JSON.stringify({version:1,entries}));return result;
}
export function restoreCommentHeader(document){
  const encoded=document.headers?.[HEADER];if(!encoded)return document;let data;try{data=JSON.parse(decodeURIComponent(encoded))}catch{return document}
  if(data?.version!==1||!Array.isArray(data.entries))return document;const previous=document.sharedCommentOrigins;
  document.sharedCommentOrigins=data.entries.map(entry=>({...entry,chapterID:null}));restoreCommentOrigins(document);document.sharedCommentOrigins=previous;return document;
}

export function clearDetachedCommentFallbacks(previous,next){
  const before=sharedCommentIndex(previous),after=sharedCommentIndex(next),donors=new Set();
  for(const o of before.values())if(commentParts(o.node.comment).prose&&!['own','inherited'].includes(o.node.commentMode))donors.add(o.key);
  for(const o of after.values())if(commentParts(o.node.comment).prose&&!['own','inherited'].includes(o.node.commentMode))donors.delete(o.key);
  for(const [id,o] of after.entries())if(o.node.commentMode==='inherited' && (donors.has(o.key) || (before.get(id)?.node.commentMode==='inherited' && before.get(id)?.key!==o.key)))o.node.comment=commentWithProse(o.node.comment,'');
  return next;
}
