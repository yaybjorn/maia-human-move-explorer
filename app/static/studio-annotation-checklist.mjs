import { wrongBranchDepth } from './studio-training-branch.mjs?v=20261027-wrong-feedback';
import { syncActiveChapter, chapterDocument, pathToNode, childrenOf } from './studio-document.mjs?v=20261027-wrong-feedback';

import { sharedHintIndex, sharedHintFor } from './studio-shared-hints.mjs?v=20261027-shared-hints';

// Chess directives (including hint, arrows and clock tags) are not explanations.
export function hasProseComment(value) {
  return String(value || '').replace(/\[%[^\]]*\]/g, ' ').trim().length > 0;
}
export function annotationChecklist(document) {
  const synced = syncActiveChapter(document);
  const chapters = Array.isArray(synced.chapterSources)
    ? synced.chapterSources.filter(chapter => !chapter.archived).map(chapter => ({id:chapter.id,title:chapter.title || 'Untitled chapter',document:chapterDocument(synced,chapter)}))
    : [{id:null,title:'Course repertoire',document:synced}];
  const missingHints = [], missingComments = [], hints = sharedHintIndex(synced);
  let moveCount = 0;
  for (const chapter of chapters) for (const node of chapter.document.nodes) {
    if (!node?.id || !node.uci || !node.san || !Number.isInteger(node.ply) || node.ply < 1) continue;
    moveCount++;
    const history = pathToNode(chapter.document,node.id).map(move => `${Math.ceil(move.ply/2)}${move.ply%2 ? '.' : '…'} ${move.san}`).join(' ');
    const path = pathToNode(chapter.document,node.id).map(move => [move.id,move.uci,move.san,move.ply]);
    const finding = {chapterID:chapter.id,chapterTitle:chapter.title,nodeID:node.id,history,path};
    if (wrongBranchDepth(chapter.document,node.id) >= 0) continue;
    const learnerMove = node.ply % 2 === (document.metadata.side === 'black' ? 0 : 1);
    if (learnerMove && childrenOf(chapter.document,node.parentId)[0]?.id === node.id && !sharedHintFor(hints,chapter.id,node.id)?.hint) missingHints.push(finding);
    if (learnerMove && !hasProseComment(node.comment)) missingComments.push(finding);
  }
  return {moveCount,missingHints,missingComments};
}

// Navigation is safe only while the same finding still exists at the same full path.
// Unlike text-editing diagnostics, unrelated document changes need not block it.
export function currentAnnotationFinding(document, finding, kind) {
  if (!document || !finding || !['hint', 'comment'].includes(kind)) return null;
  const list = annotationChecklist(document)[kind === 'hint' ? 'missingHints' : 'missingComments'];
  return list.find(item => item.chapterID === finding.chapterID && item.nodeID === finding.nodeID
    && JSON.stringify(item.path) === JSON.stringify(finding.path)) || null;
}
