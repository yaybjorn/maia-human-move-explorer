import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('app/review-assets/beyond-basics/review.js','utf8');
const start=source.indexOf('const PAGE_QUOTES=');
const end=source.indexOf('\nfunction quoteBubble',start);
assert(start>=0 && end>start);
const box={};vm.runInNewContext(source.slice(start,end)+';globalThis.quotes=PAGE_QUOTES',box);
const entries=Object.entries(box.quotes);
assert.equal(entries.length,100);
assert.equal(new Set(entries.map(([,q])=>q.id)).size,100);
assert.equal(new Set(entries.map(([,q])=>q.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,''))).size,100);
for(const [id,q] of entries){assert.match(id,/^[a-f0-9]{24}$/);assert(q.text&&q.attribution&&q.verification_note);assert.equal(new URL(q.source_url).protocol,'https:')}
console.log('PASS 100 unique stable page assignments with source attribution');
