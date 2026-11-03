import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { reviewButtonVisible, reviewPresentation } from '../app/static/studio-review-state.mjs';
test('free courses do not show Apple review',()=>{assert.equal(reviewButtonVisible('free'),false);assert.equal(reviewButtonVisible('usd-9.99'),true);});
test('draft, preparing and submitted expose only the valid next action',()=>{
 assert.deepEqual(reviewPresentation({}).actions,['prepare']);
 assert.deepEqual(reviewPresentation({latestOperation:{state:'queued',action:'prepare'}}).actions,[]);
 assert.deepEqual(reviewPresentation({latestOperation:{state:'completed',action:'prepare',result:{priceMatches:true}}}).actions,['submit']);
 assert.deepEqual(reviewPresentation({latestOperation:{state:'completed',action:'submit',result:{appleState:'WAITING_FOR_REVIEW'}}}).actions,['status']);
});
test('approved, published, rejected, price mismatch and revoked remain distinct',()=>{
 const approved={accessState:'active',activeCapability:1,latestOperation:{state:'completed',action:'status',result:{appleState:'APPROVED',priceMatches:true,receiptID:'r'}}};
 assert.deepEqual(reviewPresentation(approved).actions,['publish','status']);
 assert.deepEqual(reviewPresentation({...approved,publishedAt:'2026-11-03'}),{description:'Published.',actions:[],reviewerControls:false});
 assert.deepEqual(reviewPresentation({latestOperation:{state:'completed',action:'status',result:{appleState:'REJECTED'}}}).actions,['prepare']);
 assert.deepEqual(reviewPresentation({latestOperation:{state:'completed',action:'prepare',result:{priceMatches:false}}}).actions,['prepare']);
 assert.deepEqual(reviewPresentation({...approved,accessState:'revoked'}).actions,['repair']);
 assert.deepEqual(reviewPresentation({...approved,accessState:'revoked',latestOperation:{state:'queued',action:'submit'}}).actions,['resume']);
});
