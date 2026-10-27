import { Chess } from './vendor/chessjs/chess.mjs';

// Hints describe the position *before* a learner's main answer. FEN's default
// en-passant field is emitted only when a legal capture exists; clocks are not
// part of position identity. The answer is included to avoid misleading hints.
export function hintPositionKey(board, answer) {
  return `${board.fen().split(" ").slice(0,4).join(" ")}|${answer}`;
}
export function sharedHintIndex(document) {
  const active = document.activeChapterID;
  const chapters = Array.isArray(document.chapterSources)
    ? document.chapterSources.filter(c => !c.archived).map(c => ({ id:c.id, nodes:c.id === active ? document.nodes : c.nodes }))
    : [{ id:null, nodes:document.nodes }];
  const occurrences = [], groups = new Map();
  for (const chapter of chapters) {
    const nodes = chapter.nodes || [], children = new Map();
    for (const node of nodes) { const key=node.parentId ?? null; const list=children.get(key)||[]; list.push(node); children.set(key,list); }
    const visit = (parent, board, path) => {
      const siblings=children.get(parent)||[];
      for (const [i,node] of siblings.entries()) {
        const learner = node.ply % 2 === (document.metadata.side === 'black' ? 0 : 1);
        let next;
        try { next=new Chess(board.fen()); next.move({from:node.uci.slice(0,2),to:node.uci.slice(2,4),promotion:node.uci[4]}); } catch { continue; }
        const nodePath=[...path,node.uci];
        if (learner && i===0) {
          const key=hintPositionKey(board,node.uci);
          const occurrence={chapterID:chapter.id,nodeID:node.id,path:nodePath,key,node};
          occurrences.push(occurrence);const group=groups.get(key)||[];group.push(occurrence);groups.set(key,group);
        }
        // Wrong learner answers are feedback-only: their continuations are
        // not training positions and cannot supply shared hints.
        if (!(learner && i>0)) visit(node.id,next,nodePath);
      }
    };
    visit(null,new Chess(),[]);
  }
  const result=new Map();
  for (const group of groups.values()) {
    const values=[...new Set(group.filter(o=>!['own','inherited'].includes(o.node.hintMode)).map(o=>o.node.hint?.trim()).filter(Boolean))];
    for (const o of group) {
      const own=o.node.hint?.trim()||'', fallback=o.node.hintMode==='inherited' ? own : '';
      const hint=o.node.hintMode==='own' ? own : values.length===1 ? values[0] : values.length===0 ? fallback : (o.node.hintMode==='inherited' ? '' : own);
      result.set(JSON.stringify([o.chapterID,o.nodeID]),{...o,hint,inherited:o.node.hintMode!=='own' && Boolean(hint) && (o.node.hintMode==='inherited' || !own),conflict:values.length>1});
    }
  }
  return result;
}
export function sharedHintFor(index,chapterID,nodeID) { return index.get(JSON.stringify([chapterID ?? null,nodeID])); }

// Export materializes inherited hints for the existing PGN compiler. This
// sidecar records their origin (and deliberate blank overrides), so loading the
// same PGN does not turn generated text into an authored exception.
export function hintOriginRecords(index) {
  return [...index.values()].filter(o=>o.inherited || o.node.hintMode==='own')
    .map(o=>({chapterID:o.chapterID,path:o.path,mode:o.inherited?'inherited':'own',...((o.inherited || o.node.hint)?{value:o.hint}:{})}));
}
export function restoreHintOrigins(document) {
  if (!Array.isArray(document.sharedHintOrigins)) return document;
  const index=sharedHintIndex(document), records=new Map(document.sharedHintOrigins.map(r=>[JSON.stringify([r.chapterID ?? null,r.path]),r]));
  for (const o of index.values()) {
    const record=records.get(JSON.stringify([o.chapterID,o.path]));
    if (record?.mode==='inherited' && o.node.hint===record.value) o.node.hintMode='inherited';
    else if (record?.mode==='own' && (record.value ?? '') === (o.node.hint ?? '')) o.node.hintMode='own';
  }
  return document;
}

const ORIGIN_HEADER='GingerGMHintOrigins';
export function headersWithHintOrigins(headers,index,chapterID) {
  const result={...headers}; delete result[ORIGIN_HEADER];
  const entries=hintOriginRecords(index).filter(item=>item.chapterID===(chapterID ?? null)).map(({chapterID:_,...item})=>item);
  if(entries.length) result[ORIGIN_HEADER]=encodeURIComponent(JSON.stringify({version:1,entries}));
  return result;
}
export function restoreHintHeader(document) {
  const encoded=document.headers?.[ORIGIN_HEADER]; if(!encoded) return document;
  let data; try { data=JSON.parse(decodeURIComponent(encoded)); } catch { return document; }
  if(data?.version!==1 || !Array.isArray(data.entries)) return document;
  const original=document.sharedHintOrigins;
  document.sharedHintOrigins=data.entries.map(entry=>({...entry,chapterID:null}));
  restoreHintOrigins(document);
  document.sharedHintOrigins=original;
  return document;
}

// Equal, unmarked imported hints are the same default, not competing
// overrides. Explicit own-mode occurrences remain independent.
export function coalesceIdenticalHints(document) {
  const groups=new Map();
  for (const o of sharedHintIndex(document).values()) { const group=groups.get(o.key)||[]; group.push(o); groups.set(o.key,group); }
  for (const group of groups.values()) {
    const authored=group.filter(o=>o.node.hint && !['own','inherited'].includes(o.node.hintMode));
    const values=new Set(group.filter(o=>!['own','inherited'].includes(o.node.hintMode)).map(o=>o.node.hint?.trim()).filter(Boolean));
    if (values.size===1 && authored.length>1) for (const o of authored.slice(1)) o.node.hint='';
  }
  return document;
}

export function writeSharedHint(document,chapterID,nodeID,value) {
  const next=structuredClone(document), index=sharedHintIndex(next), target=sharedHintFor(index,chapterID,nodeID);
  if (!target) return next;
  const text=String(value||'').trim().replace(/\s+/g,' ');
  if (target.conflict || target.node.hintMode==='own') { target.node.hint=text; target.node.hintMode='own'; return next; }
  const group=[...index.values()].filter(o=>o.key===target.key);
  const donor=group.find(o=>o.node.hint && !['own','inherited'].includes(o.node.hintMode)) || target;
  donor.node.hint=text; delete donor.node.hintMode;
  for (const occurrence of group) if (occurrence.node.hintMode==='inherited') occurrence.node.hint=text;
  return next;
}

// While editing one course, removal of its last linked donor is an explicit
// removal, not a standalone import. Do not revive a generated fallback.
export function clearDetachedHintFallbacks(previous, next) {
  const before=sharedHintIndex(previous), after=sharedHintIndex(next), donors=new Set();
  for (const o of before.values()) if (o.node.hint && !['own','inherited'].includes(o.node.hintMode)) donors.add(o.key);
  for (const o of after.values()) if (o.node.hint && !['own','inherited'].includes(o.node.hintMode)) donors.delete(o.key);
  for (const o of after.values()) if (donors.has(o.key) && o.node.hintMode==='inherited') o.node.hint='';
  return next;
}
