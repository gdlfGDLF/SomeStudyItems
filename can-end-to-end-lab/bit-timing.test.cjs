const {test}=require('node:test'),assert=require('node:assert/strict'),M=require('./bit-timing.js');
test('160 MHz / 16 / 20 yields 500k and a single 1.6 us sampling boundary',()=>{
 const r=M.build();assert.equal(r.clockNs,6.25);assert.equal(r.tqNs,100);assert.equal(r.bitUs,2);assert.equal(r.bitrate,500000);assert.equal(r.samplePercent,80);assert.equal(r.sampleUs,1.6);
 assert.equal(M.snapshot(r,255).phase,'TSEG1');assert.equal(M.snapshot(r,255).samples.length,0);
 const boundary=M.snapshot(r,256);assert.equal(boundary.phase,'TSEG2');assert.equal(boundary.atSample,true);assert.equal(boundary.samples.length,1);assert.equal(boundary.samples[0].value,0);
 for(let i=257;i<320;i++){const s=M.snapshot(r,i);assert.equal(s.phase,'TSEG2');assert.equal(s.atSample,false);assert.equal(s.samples.length,1);}
});
test('second bit starts only at its own boundary and has its own single sample',()=>{
 const r=M.build(),s=M.snapshot(r,320);assert.equal(s.bitIndex,1);assert.equal(s.localClock,0);assert.equal(s.phase,'同步段');assert.equal(s.samples.length,1);
 assert.equal(M.snapshot(r,575).samples.length,1);assert.equal(M.snapshot(r,576).samples.length,2);assert.deepEqual(M.snapshot(r,640).samples.map(s=>s.value),[0,1]);assert.equal(M.snapshot(r,640).finished,true);
});
test('a clock is not a TQ, and a TQ is not a bit',()=>{
 const r=M.build();assert.equal(M.snapshot(r,1).subClock,1);assert.equal(M.snapshot(r,1).elapsedTq,0);assert.equal(M.snapshot(r,15).phase,'同步段');assert.equal(M.snapshot(r,16).phase,'TSEG1');assert.equal(M.snapshot(r,16).samples.length,0);
 assert.equal(M.nextTq(r,1),16);assert.equal(M.nextSample(r,256),576);assert.equal(M.nextTq(r,640),640);assert.equal(M.nextSample(r,640),640);
});
test('integer-TQ sampling and FD data preset retain independent complete bits',()=>{
 const quant=M.build({divider:20,seg1:12,seg2:3});assert.equal(quant.bitUs,2);assert.equal(quant.totalTq,16);assert.equal(quant.samplePercent,81.25);assert.equal(quant.sampleUs,1.625);
 const fast=M.build({divider:4});assert.equal(fast.bitrate,2000000);assert.equal(fast.bitUs,.5);assert.equal(fast.sampleUs,.4);assert.equal(fast.samplePercent,80);
});
test('all four level patterns sample twice, and seeking backward never retains future data',()=>{
 for(const pattern of ['00','01','10','11']){const r=M.build({pattern});assert.deepEqual(M.snapshot(r,r.totalClocks).samples.map(s=>s.value).join(''),pattern);assert.deepEqual(M.snapshot(r,0).samples,[]);assert.equal(M.snapshot(r,r.clocksPerBit).level,Number(pattern[1]));}
});
test('invalid timing input and cursors are rejected',()=>{
 for(const input of [{clockMHz:0},{clockMHz:NaN},{divider:0},{divider:1.5},{seg1:0},{seg2:33},{pattern:'010'}])assert.throws(()=>M.build(input));
 const r=M.build();for(const cursor of [-1,.5,641,NaN])assert.throws(()=>M.snapshot(r,cursor));
});
