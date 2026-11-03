/** Pure presentation policy; backend remains authoritative for all mutations. */
export function reviewButtonVisible(priceTier) { return priceTier !== 'free'; }
export function firstPaidNeedsReview(priceTier, hasPublishedVersion) {
  return reviewButtonVisible(priceTier) && !hasPublishedVersion;
}
export function publicationAccessPolicy(priceTier, hasPublishedVersion, publishedAccess) {
  if (!hasPublishedVersion) return firstPaidNeedsReview(priceTier, false) ? 'review' : 'normal';
  if (!['free', 'subscriber'].includes(publishedAccess)) return 'unknown';
  if (publishedAccess === 'free' && priceTier !== 'free') return 'protect-free';
  if (publishedAccess === 'subscriber' && priceTier === 'free') return 'protect-paid';
  return 'normal';
}
export function reviewPresentation(snapshot) {
  const op=snapshot.latestOperation,result=op?.result||{},queued=op?.state==='queued',apple=result.appleState;
  const needsAccess=snapshot.accessState==='revoked'||(snapshot.accessState==='active'&&!snapshot.activeCapability);
  if(snapshot.publishedAt)return {description:'Published.',actions:[],reviewerControls:false};
  if(needsAccess)return {description:'Action needed — reviewer access is unavailable. Restore access before continuing.',
    actions:queued&&['submit','repair'].includes(op.action)?['resume']:queued?[]:['repair'],reviewerControls:true};
  if(snapshot.accessState==='repairing')return {description:'Restoring reviewer access.',actions:[],reviewerControls:true};
  if(queued)return {description:op.action==='status'?'Checking Apple status.':op.action==='submit'?'Preparing review — waiting for the review screenshot and submission approval. Not sent to Apple yet.':op.action==='repair'?'Restoring reviewer access.':'Preparing review — checking the App Store product.',actions:[],reviewerControls:true};
  if(result.priceMatches===false)return {description:'Action needed — the App Store price does not match this review copy.',actions:['prepare'],reviewerControls:true};
  if(['REJECTED','DEVELOPER_REJECTED','DEVELOPER_ACTION_NEEDED'].includes(apple))return {description:'Rejected or action needed — check Apple’s review feedback.',actions:['prepare'],reviewerControls:true};
  if(apple==='APPROVED'&&op?.action==='status'&&result.priceMatches===true&&result.receiptID)
    return {description:'Apple product approved for this submission. Publish the frozen revision when ready.',actions:['publish','status'],reviewerControls:true};
  if(['WAITING_FOR_REVIEW','IN_REVIEW','APPROVED'].includes(apple)&&['submit','status','repair'].includes(op?.action))
    return {description:apple==='APPROVED'?'Apple product approved for this submission. Check its status before publishing.':'Awaiting Apple review.',actions:['status'],reviewerControls:true};
  if(op?.action==='prepare'&&op.state==='completed'&&result.priceMatches===true)
    return {description:'Preparing review — the screenshot and submission approval are needed before Apple receives it.',actions:['submit'],reviewerControls:true};
  if(op?.state==='failed')return {description:'Action needed — review preparation could not be completed.',actions:['prepare'],reviewerControls:true};
  return {description:'Draft review copy prepared. Not sent to Apple.',actions:['prepare'],reviewerControls:true};
}
