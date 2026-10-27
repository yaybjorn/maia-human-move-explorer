import { syncActiveChapter, chapterDocument, pathToNode, childrenOf } from './studio-document.mjs?v=20261013-chapter-archive';

// Chess directives (including hint, arrows and clock tags) are not explanations.
export function hasProseComment(value) {
  return String(value || '').replace(/\[%[^\]]*\]/g, ' ').trim().length > 0;
}
export function annotationChecklist(document) {
  const synced = syncActiveChapter(document);
  const chapters = Array.isArray(synced.chapterSources)
    ? synced.chapterSources.filter(chapter => !chapter.archived).map(chapter => ({id:chapter.id,title:chapter.title || 'Untitled chapter',document:chapterDocument(synced,chapter)}))
    : [{id:null,title:'Course repertoire',document:synced}];
  const missingHints = [], missingComments = [];
  let moveCount = 0;
  for (const chapter of chapters) for (const node of chapter.document.nodes) {
    if (!node?.id || !node.uci || !node.san || !Number.isInteger(node.ply) || node.ply < 1) continue;
    moveCount++;
    const history = pathToNode(chapter.document,node.id).map(move => `${Math.ceil(move.ply/2)}${move.ply%2 ? '.' : '…'} ${move.san}`).join(' ');
    const finding = {chapterID:chapter.id,chapterTitle:chapter.title,nodeID:node.id,history};
    const learnerMove = node.ply % 2 === (document.metadata.side === 'black' ? 0 : 1);
    if (learnerMove && childrenOf(chapter.document,node.parentId)[0]?.id === node.id && !String(node.hint || '').trim()) missingHints.push(finding);
    if (learnerMove && !hasProseComment(node.comment)) missingComments.push(finding);
  }
  return {moveCount,missingHints,missingComments};
}
