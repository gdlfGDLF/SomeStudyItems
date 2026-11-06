'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const P = require('./engine.js');

function longDivisionCrc(input) {
  // Independent polynomial long division over GF(2), with 15 appended zeros.
  const work = [...input, ...Array(15).fill(0)];
  const polynomial = Array.from({ length: 16 }, (_, i) => (0xc599 >>> (15 - i)) & 1);
  for (let i = 0; i < input.length; i++) {
    if (work[i]) for (let j = 0; j < polynomial.length; j++) work[i + j] ^= polynomial[j];
  }
  return work.slice(-15).reduce((a, b) => (a << 1) | b, 0);
}
function byteBits(bytes) { return bytes.flatMap(b => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1)); }

test('CRC-15/CAN published check value and independent polynomial calculation', () => {
  const values = byteBits([...Buffer.from('123456789')]);
  assert.equal(P.crc15(values), 0x059e);
  assert.equal(P.crc15(values), longDivisionCrc(values));
});
test('160 MHz supports 500k and 1M via divider; achievable sample point is quantized', () => {
  const a = P.timing({ clockMHz: 160, brp: 20, tseg1: 12, tseg2: 3 });
  assert.equal(a.bitrate, 500000);
  assert.equal(a.bitNs, 2000);
  assert.equal(a.samplePercent, 81.25);
  assert.equal(a.sampleNs, 1625);
  const b = P.timing({ clockMHz: 160, brp: 10, tseg1: 12, tseg2: 3 });
  assert.equal(b.bitrate, 1000000);
  const proposal = P.suggestTiming(160, 500000, 80);
  assert.equal(proposal.bitrate, 500000);
  assert.equal(proposal.samplePercent, 80);
  assert.equal(proposal.brp, 16);
  assert.equal(proposal.totalTq, 20);
  assert.throws(() => P.timing({ tseg2: 0 }));
  assert.throws(() => P.suggestTiming(160, 500000, 100));
});
test('input parsing accepts hex bytes and rejects invalid values without coercion loss', () => {
  assert.deepEqual(P.parseData('DC 05 0xFF'), [0xdc, 5, 255]);
  assert.deepEqual(P.parseData('DC05FF'), [0xdc, 5, 255]);
  assert.deepEqual(P.parseData(''), []);
  assert.throws(() => P.parseData('100'));
  assert.throws(() => P.parseData('GG'));
  assert.throws(() => P.parseData([256]));
  assert.throws(() => P.buildCan({ id: 0x800 }));
  assert.throws(() => P.buildCan({ data: Array(9).fill(0) }));
});
test('CAN standard frame boundaries, data order, ACK and wire length include three IFS bits', () => {
  for (const data of [[], [0xdc, 5], Array(8).fill(0xff)]) {
    const f = P.buildCan({ id: 0x200, data });
    assert.equal(f.bits.length - f.stuffCount, 47 + 8 * data.length);
    assert.equal(f.frameBitCount, 44 + 8 * data.length + f.stuffCount);
    assert.equal(f.bits[0].field, 'SOF');
    assert.equal(f.bits[0].value, 0);
    assert.equal(f.bits[f.ackIndex].value, 0);
    assert.equal(f.fields.at(-1).name, 'IFS');
    assert.equal(f.fields.find(x => x.name === 'EOF').length, 7);
    assert.equal(f.fields.at(-1).length, 3);
    assert.deepEqual(f.rxData, data);
    assert.equal(f.outcome.code, 'success');
    assert.equal(P.decodeCan(f.bits).ok, true);
    const rawData = f.bits.filter(b => b.field === 'DATA' && !b.stuffed).map(b => b.value);
    assert.deepEqual(rawData, byteBits(data));
  }
});
test('CRC and decoder agree for 512 diverse independent frame inputs', () => {
  for (let seed = 0; seed < 512; seed++) {
    const data = Array.from({ length: seed % 9 }, (_, i) => (seed * 73 + i * 157) & 255);
    const id = (seed * 97) & 0x7ff;
    const f = P.buildCan({ id, data });
    const rawPayload = f.bits.filter(b => !b.stuffed && !['CRC', 'CRC delimiter', 'ACK', 'ACK delimiter', 'EOF', 'IFS'].includes(b.field)).map(b => b.value);
    assert.equal(f.crc, longDivisionCrc(rawPayload));
    const decoded = P.decodeCan(f.bits.map(b => ({ value: b.value })));
    assert.equal(decoded.id, id);
    assert.deepEqual(decoded.data, data);
    assert.equal(decoded.ok, true);
  }
});
test('bit stuffing resets run to inserted bit and covers final CRC bit boundary', () => {
  const stuffed = P.stuffBits(Array(10).fill(null).map(() => ({ value: 0, field: 'DATA' })));
  assert.equal(stuffed.map(b => b.value).join(''), '000001000001');
  assert.equal(stuffed.filter(b => b.stuffed).length, 2);
  let found = false;
  for (let id = 0; id <= 0x7ff && !found; id++) {
    const f = P.buildCan({ id, data: [0] });
    const delimiter = f.bits.findIndex(b => b.field === 'CRC delimiter');
    if (f.bits[delimiter - 1].stuffed) {
      found = true;
      assert.equal(f.bits[delimiter - 1].field, 'CRC');
      assert.equal(P.decodeCan(f.bits).ok, true);
    }
  }
  assert.ok(found, 'A CRC terminating at a fifth consecutive bit requires a final stuff bit.');
});
test('filtering does not suppress ACK; listener can decode without ACK; missing has no data', () => {
  const filtered = P.buildCan({ filterId: 0x123 });
  assert.equal(filtered.ack, true);
  assert.equal(filtered.outcome.code, 'filtered');
  assert.deepEqual(filtered.rxData, []);
  const listening = P.buildCan({ receiver: 'listen' });
  assert.equal(listening.ack, false);
  assert.equal(listening.outcome.code, 'noack');
  assert.deepEqual(listening.rxData, [0xdc, 5]);
  const missing = P.buildCan({ receiver: 'missing' });
  assert.equal(missing.ack, false);
  assert.deepEqual(missing.rxData, []);
});
test('injected receiving bit flip is detected by destuff/CRC and prevents ACK/application delivery', () => {
  for (const data of [[], [0xdc, 5], Array(8).fill(0)]) {
    const f = P.buildCan({ data, fault: 'bitflip' });
    assert.equal(f.outcome.ok, false);
    assert.ok(['crc', 'stuff', 'format'].includes(f.outcome.code));
    assert.equal(f.ack, false);
    assert.deepEqual(f.rxData, []);
    assert.notEqual(f.bits[f.faultIndex].value, f.intendedBits[f.faultIndex].value);
  }
});
test('residual edge-lateness boundary uses sampling time and is explicitly a simplified model', () => {
  assert.equal(P.buildCan({ delayNs: 1599 }).outcome.code, 'success');
  assert.equal(P.buildCan({ delayNs: 1600 }).outcome.code, 'timing');
  assert.equal(P.buildCan({ delayNs: 2000 }).ack, false);
});
test('arbitration is wired AND; loser stops driving, equal identifiers remain tied', () => {
  const a = P.arbitrate(0x120, 0x130);
  assert.equal(a.winner, 'A');
  assert.equal(a.steps[a.lossIndex].a, 0);
  assert.equal(a.steps[a.lossIndex].b, 1);
  assert.equal(a.steps[a.lossIndex].bus, 0);
  assert.equal(a.steps[a.lossIndex].lost, 'B');
  assert.ok(a.steps.slice(a.lossIndex + 1).every(s => s.txB === 1));
  assert.equal(P.arbitrate(0x7ff, 0).winner, 'B');
  assert.equal(P.arbitrate(0x200, 0x200).winner, 'tie');
});
test('UART emits LSB-first byte frames and samples independently of fixed propagation delay', () => {
  const u = P.buildUart({ data: [0x96, 0xa5], baud: 100000, receiverBaud: 100000 });
  assert.equal(u.bits.slice(0, 10).map(b => b.value).join(''), '0011010011');
  assert.deepEqual(u.rxData, [0x96, 0xa5]);
  assert.equal(u.samples[0].timeUs, 5);
  assert.equal(u.samples[1].timeUs, 15);
  const delayed = P.buildUart({ data: [0x96], baud: 100000, delayNs: 100000 });
  assert.equal(delayed.samples[0].timeUs, 105);
  assert.deepEqual(delayed.rxData, [0x96]);
});
test('UART even/odd parity and stop bit checks', () => {
  const even = P.buildUart({ data: [1], parity: 'even' });
  const odd = P.buildUart({ data: [1], parity: 'odd' });
  assert.equal(even.bits[9].value, 1);
  assert.equal(odd.bits[9].value, 0);
  assert.equal(even.bits.length, 11);
  assert.equal(even.outcome.code, 'success');
  assert.equal(odd.outcome.code, 'success');
});
test('UART timing drift distinguishes framing errors, silent corruption and lucky same-level samples', () => {
  const outcomes = new Set();
  for (const byte of [0, 0x55, 0xff, 0x96]) {
    for (const receiverBaud of [80000, 90000, 95000, 100000, 105000, 110000, 120000]) {
      outcomes.add(P.buildUart({ data: [byte], baud: 100000, receiverBaud }).outcome.code);
    }
  }
  assert.ok(outcomes.has('framing'));
  assert.ok(outcomes.has('corrupted'));
  assert.ok(outcomes.has('margin'));
  assert.ok(outcomes.has('success'));
});
