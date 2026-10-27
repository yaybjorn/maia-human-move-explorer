// The first learner move at a position is the recommended answer. Other
// learner moves are feedback-only; their source continuations remain in PGN.
export function wrongBranchDepth(document, nodeID) {
  if (nodeID == null) return -1;
  const byID=new Map((document.nodes||[]).map(node=>[node.id,node]));
  const path=[],seen=new Set();let node=byID.get(nodeID);
  while(node && !seen.has(node.id)) { seen.add(node.id);path.push(node);node=node.parentId==null?null:byID.get(node.parentId); }
  path.reverse();
  const learnerPly=document.metadata.side==='black'?0:1;
  const wrong=path.findIndex(move=>move.ply%2===learnerPly &&
    (document.nodes||[]).find(candidate=>candidate.parentId===move.parentId)?.id!==move.id);
  return wrong<0 ? -1 : path.length-1-wrong;
}
export function visibleTrainingChildren(document,parentID) {
  const children=(document.nodes||[]).filter(node=>node.parentId===(parentID ?? null));
  const depth=wrongBranchDepth(document,parentID);
  return depth<0 ? children : depth===0 ? children.slice(0,1) : [];
}
