'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./flow.js');
const P = require('./wire.js');
const at = (r, key) => r.steps.find(x => x.key === key);
const end = r => r.steps.at(-1).snapshot;

test('default MM2S packet matches the actual 32-byte host driver layout', () => {
  const r = F.build();
  const expected = 'A5 00 0A 00 5A FF F5 FF 02 00 00 00 10 00 00 00 00 02 00 00 00 01 00 02 DC 05 00 00 00 00 00 00';
  assert.equal(r.txPacket.map(n => n.toString(16).toUpperCase().padStart(2,'0')).join(' '), expected);
  assert.equal(r.config.id, 0x200);
  assert.equal(r.config.bitrate, 500000);
  assert.equal(r.wire.timing.bitUs, 2);
  assert.equal(r.wire.timing.samplePercent, 80);
});

test('zero and maximum classic payloads preserve exact length/alignment and channel', () => {
  for (const data of [[], [0,1,2,3,4,5,6,7]]) {
    const r=F.build({id:0x7ff,channel:3,data});
    assert.equal(r.txPacket.length,32);
    assert.equal(r.txPacket[2],8+data.length);
    assert.deepEqual(r.txPacket.slice(16,20),[0xff,7,0,0]);
    assert.equal(r.txPacket[20],3);
    assert.equal(r.txPacket[23],data.length);
    assert.deepEqual(r.txPacket.slice(24,24+data.length),data);
    assert.deepEqual(end(r).rxBytes,data);
    assert.equal(end(r).txBytes,data.length);
  }
});

test('driver acceptance and DMA consumption do not prematurely complete TX', () => {
  const r=F.build();
  assert.equal(at(r,'echo-reserve').snapshot.echoPending,1);
  assert.equal(at(r,'ring-copy').snapshot.mm2sWr,0);
  assert.equal(at(r,'mm2s-publish').snapshot.mm2sWr,32);
  assert.equal(at(r,'mm2s-publish').snapshot.mm2sRd,0);
  assert.equal(at(r,'fpga-fetch').snapshot.mm2sRd,32);
  for (const key of ['mm2s-publish','fpga-fetch','build-report','s2mm-publish','poll-report']) {
    assert.equal(at(r,key).snapshot.txPackets,0,key);
    assert.equal(at(r,key).snapshot.hostDone,false,key);
    assert.equal(at(r,key).snapshot.echoPending,1,key);
  }
  assert.equal(end(r).txPackets,1);
  assert.equal(end(r).echoPending,0);
  assert.equal(end(r).s2mmWr,32);
  assert.equal(end(r).s2mmRd,32);
  assert.equal(end(r).hostDone,true);
});

test('streaming RX removes stuff bits and exposes bytes only after their eight bits arrive', () => {
  const r=F.build({data:'00 00 00 00 00 00 00 00'});
  let seen=0;
  for (const s of r.steps.filter(s=>s.key.startsWith('wire-'))) {
    const b=r.wire.bits[s.bitIndex];
    if (b.field==='DATA' && !b.stuffed)seen++;
    assert.equal(s.snapshot.rxBytes.length,Math.floor(seen/8));
    if (b.stuffed) {
      const prev=r.steps[r.steps.indexOf(s)-1];
      assert.equal(s.snapshot.parsedBits.length,prev.snapshot.parsedBits.length);
    }
  }
  const decoded=P.decodeCan(r.wire.bits);
  assert.equal(at(r,'peer-crc-check').snapshot.parsedBits,decoded.raw.join(''));
  assert.equal(at(r,'peer-crc-check').snapshot.peerCrc,true);
  assert.equal(end(r).decodedId,0x200);
  assert.equal(end(r).decodedDlc,8);
});

test('CRC precedes ACK; ACK precedes EOF, application delivery and host TxDone', () => {
  const r=F.build();
  const index=key=>r.steps.findIndex(s=>s.key===key);
  const ack=r.steps.findIndex(s=>s.bitIndex===r.wire.ackIndex&&s.key.startsWith('wire-'));
  assert.ok(index('peer-crc-check')<ack);
  assert.ok(ack<index('peer-accept-frame'));
  assert.ok(index('peer-accept-frame')<index('peer-deliver'));
  assert.ok(ack<index('complete-echo'));
  assert.equal(r.steps[ack].snapshot.ack,true);
  assert.equal(r.steps[ack].snapshot.peerDelivered,false);
  assert.equal(r.steps[ack].snapshot.hostDone,false);
});

test('filter rejects application delivery without suppressing ACK or TX completion', () => {
  const r=F.build({scenario:'filtered'}),last=end(r);
  assert.equal(last.ack,true);
  assert.equal(last.peerDelivered,false);
  assert.equal(last.txPackets,1);
  assert.equal(last.hostDone,true);
  assert.deepEqual(last.rxBytes,[0xdc,5]);
});

test('noack and listener stop the attempt at ACK and do not invent completion reports', () => {
  for(const scenario of ['noack','listen']) {
    const r=F.build({scenario}),last=end(r);
    assert.equal(last.ack,false);
    assert.equal(last.hostDone,false);
    assert.equal(last.echoPending,1);
    assert.equal(last.txPackets,0);
    assert.equal(last.txErrors,0);
    assert.equal(last.peerDelivered,false);
    assert.equal(r.reportPacket,null);
    assert.equal(at(r,'peer-accept-frame'),undefined);
    assert.equal(r.steps.filter(s=>s.key.startsWith('wire-')).at(-1).bitIndex,r.wire.ackIndex);
  }
  assert.deepEqual(end(F.build({scenario:'noack'})).rxBytes,[]);
  assert.equal(end(F.build({scenario:'noack'})).peerCrc,null);
  assert.deepEqual(end(F.build({scenario:'listen'})).rxBytes,[0xdc,5]);
  assert.equal(end(F.build({scenario:'listen'})).peerCrc,true);
});

test('a missing report leaves host echo pending despite peer ACK and data delivery', () => {
  const r=F.build({scenario:'lost-report'}),last=end(r);
  assert.equal(last.ack,true);
  assert.equal(last.peerDelivered,true);
  assert.equal(last.peerCrc,true);
  assert.equal(last.echoPending,1);
  assert.equal(last.hostDone,false);
  assert.equal(last.txPackets,0);
  assert.equal(last.s2mmWr,0);
  assert.equal(r.reportPacket,null);
});

test('explicit device TX failure uses status 0x81 and frees rather than returns echo', () => {
  const r=F.build({scenario:'txerror'}),last=end(r);
  assert.equal(r.reportPacket[30],0x81);
  assert.equal(F.decodeReport(r.reportPacket).isError,true);
  assert.equal(last.txErrors,1);
  assert.equal(last.txPackets,0);
  assert.equal(last.echoPending,0);
  assert.equal(last.hostDone,true);
  assert.equal(last.ack,null);
  assert.equal(r.steps.some(s=>s.key.startsWith('wire-')),false);
  assert.equal(at(r,'local-echo'),undefined);
});

test('full-ring backpressure changes no pointers or echo ownership for this request', () => {
  const r=F.build({scenario:'ringfull'}),first=r.steps[0].snapshot,last=end(r);
  assert.equal(first.mm2sWr,F.RING_SIZE);
  assert.equal(last.mm2sWr,first.mm2sWr);
  assert.equal(last.mm2sRd,0);
  assert.equal(last.echoPending,0);
  assert.equal(last.queueStopped,true);
  assert.equal(last.hostDone,false);
  assert.equal(last.ack,null);
  assert.equal(r.reportPacket,null);
  assert.equal(at(r,'fpga-fetch'),undefined);
});

test('minimal TX report decodes without payload data and validates the business header', () => {
  const r=F.build({id:0x765,channel:2,data:[1,2,3,4,5,6,7,8]});
  assert.equal(r.reportPacket.length,32);
  assert.equal(r.reportPacket[2],16);
  assert.equal(r.reportPacket[12],12);
  assert.deepEqual(F.decodeReport(r.reportPacket),{id:0x765,channel:2,dataLength:8,isTxReport:true,isError:false,status:1,timestampUs:1000});
  const corrupt=r.reportPacket.slice();corrupt[4]^=1;
  assert.throws(()=>F.decodeReport(corrupt),/反码/);
  assert.throws(()=>F.decodeReport(r.reportPacket.slice(0,31)),/长度/);
});

test('snapshots are immutable and parameter validation rejects unsupported requests', () => {
  const r=F.build();
  assert.notEqual(r.steps[0].snapshot,r.steps[1].snapshot);
  assert.throws(()=>{r.steps[0].snapshot.txPackets=10;},TypeError);
  assert.throws(()=>r.steps[0].snapshot.rxBytes.push(1),TypeError);
  assert.equal(new Set(r.steps.map(s=>s.key)).size,r.steps.length);
  for(const input of [{id:0x800},{id:1.5},{channel:4},{pollMs:0},{pollMs:1.2},{bitrate:12345},{scenario:'unknown'},{data:'00 '.repeat(9)}])assert.throws(()=>F.build(input));
  for(const bitrate of [125000,250000,500000,1000000])assert.equal(F.build({bitrate}).wire.timing.bitrate,bitrate);
});
