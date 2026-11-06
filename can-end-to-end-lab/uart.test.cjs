'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('./uart.js');
const at = (run, key) => run.steps.find(step => step.key === key);
const last = run => run.steps.at(-1);
const samples = run => run.steps.filter(step => step.sample);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('8N1 places one start, eight LSB-first data bits and one stop on the wire', () => {
  const run = U.build({ data: 'A3', baud: 100000 });
  const wave = run.steps.filter(step => step.key.startsWith('wire-'));
  assert.deepEqual(wave.map(step => step.levels.TX), [0, 1, 1, 0, 0, 0, 1, 0, 1, 1]);
  assert.deepEqual(wave.map(step => step.timeUs), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.deepEqual(samples(run).map(step => step.timeUs), [5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
  assert.equal(last(run).rxBits, '11000101');
  assert.equal(last(run).txBits, '11000101');
  assert.deepEqual(last(run).received, [0xa3]);
  assert.deepEqual(last(run).returned, []);
  assert.equal(run.txDurationUs, 100);
  assert.equal(run.outcome.code, 'success');
});

test('each byte establishes a new receive sampling reference', () => {
  const run = U.build({ data: '55 A3', baud: 100000, receiverBaud: 102000 });
  const starts = samples(run).filter(step => step.sample.field === 'START');
  assert.equal(starts.length, 2);
  close(starts[0].timeUs, 0.5e6 / 102000);
  close(starts[1].timeUs, 100 + 0.5e6 / 102000);
  assert.deepEqual(last(run).received, [0x55, 0xa3]);
  assert.equal(samples(run).filter(step => step.sample.field === 'DATA').length, 16);
});

test('even and odd parity contribute one wire bit but no payload bit', () => {
  for (const [parity, expected] of [['even', 1], ['odd', 0]]) {
    const run = U.build({ data: '01', baud: 100000, parity });
    const paritySample = samples(run).find(step => step.sample.field === 'PARITY');
    assert.equal(paritySample.sample.value, expected);
    assert.equal(paritySample.timeUs, 95);
    assert.equal(run.txDurationUs, 110);
    assert.equal(last(run).txBits, '10000000');
    assert.equal(last(run).rxBits, '10000000');
    assert.deepEqual(last(run).received, [1]);
  }
});

test('slow receiver events remain chronological and can occur after local TX completion', () => {
  const run = U.build({ data: '55 A3', baud: 115200, receiverBaud: 90000 });
  const times = run.steps.map(step => step.timeUs).filter(t => t != null);
  assert.ok(times.every((time, index) => index === 0 || time >= times[index - 1]));
  const txdone = at(run, 'txdone');
  assert.equal(txdone.txDone, true);
  close(txdone.timeUs, 20e6 / 115200);
  assert.ok(run.steps.findIndex(step => step.key === 'txdone') < run.steps.findIndex(step => step.key === 'sample-19'));
  assert.ok(run.durationUs > run.txDurationUs);
  assert.equal(samples(run).at(-1).txDone, true);
});

test('silent corruption is accepted data with no format flag, and separately identified by simulator', () => {
  const run = U.build({ data: '55 A3', baud: 115200, receiverBaud: 90000 });
  assert.equal(run.outcome.code, 'corrupted');
  assert.equal(run.outcome.ok, false);
  assert.deepEqual(last(run).received, [0x5b, 0xe1]);
  assert.equal(last(run).framingErrors, 0);
  assert.equal(last(run).parityErrors, 0);
  assert.ok(run.frameResults.every(frame => frame.framingOk && frame.parityOk));
  assert.match(at(run, 'decode-0').detail, /静默误码/);
  assert.equal(at(run, 'txdone').txDone, true);
});

test('frame and parity failures exclude only rejected bytes, while TX still finishes', () => {
  const framing = U.build({ data: '55 A3', baud: 115200, receiverBaud: 100000 });
  assert.equal(framing.outcome.code, 'framing');
  assert.equal(last(framing).framingErrors, 1);
  assert.deepEqual(last(framing).received, [0xd3]);
  const parity = U.build({ data: '55 A3', baud: 115200, receiverBaud: 100000, parity: 'even' });
  assert.equal(parity.outcome.code, 'parity');
  assert.equal(last(parity).parityErrors, 1);
  assert.deepEqual(last(parity).received, [0x29]);
  assert.equal(last(parity).txDone, true);
});

test('accumulation snapshots are immutable and caller input is not retained', () => {
  const bytes = [0xa3];
  const run = U.build({ data: bytes });
  bytes[0] = 0;
  assert.deepEqual(run.sent, [0xa3]);
  assert.deepEqual(at(run, 'sample-1').received, []);
  assert.deepEqual(at(run, 'decode-0').received, [0xa3]);
  assert.equal(at(run, 'sample-1').rxBits, '1');
  assert.throws(() => last(run).received.push(0));
  assert.throws(() => { at(run, 'sample-1').sample.value = 0; });
  assert.throws(() => { run.config.data[0] = 0; });
});

test('input validation rejects invalid bytes, lengths, rates and parity', () => {
  for (const config of [
    { data: '' }, { data: 'GG' }, { data: Array(9).fill(0) }, { data: [256] },
    { baud: 1199 }, { receiverBaud: 2000001 }, { baud: Infinity }, { baud: NaN },
    { parity: 'mark' }, { parity: '' }
  ]) assert.throws(() => U.build(config), JSON.stringify(config));
  for (const baud of [1200, 2000000]) assert.equal(U.build({ baud }).outcome.ok, true);
});

test('browser UMD works with offline ProtocolLab and no CommonJS', () => {
  const context = vm.createContext({ window: {} });
  for (const name of ['wire.js', 'uart.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), context);
  const run = context.window.UartLab.build({ data: 'A3' });
  assert.equal(run.protocol, 'UART');
  assert.equal(run.steps.at(-1).received[0], 0xa3);
});
