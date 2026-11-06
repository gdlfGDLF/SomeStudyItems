'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const S = require('./spi.js');
const sampleSteps = result => result.steps.filter(step => step.sample);
const final = result => result.steps.at(-1);
const edges = result => result.steps.filter((step, index) => index && step.timeUs !== null &&
  step.levels.SCLK !== result.steps[index - 1].levels.SCLK);

test('defaults perform a full duplex exchange through sampled levels', () => {
  const result = S.build();
  assert.equal(result.protocol, 'SPI');
  assert.deepEqual(result.sent, [0xA5, 0x3C]);
  assert.deepEqual(result.expectedReply, [0x5A, 0xC3]);
  assert.deepEqual(final(result).received, [0xA5, 0x3C]);
  assert.deepEqual(final(result).returned, [0x5A, 0xC3]);
  assert.equal(final(result).txBits, '1010010100111100');
  assert.equal(final(result).rxBits, '0101101011000011');
  assert.equal(sampleSteps(result).length, 16);
  assert.equal(edges(result).length, 32);
  assert.equal(result.outcome.ok, true);
  assert.match(final(result).detail, /完成不证明对端存在/);
});

// Independent known edge table: CPOL=0/1 sets idle; CPHA=0/1 chooses first/second edge.
for (const [mode, idle, sampleEdge, sampleClock, sampleIsFirst] of [
  [0, 0, 'rising', 1, true], [1, 0, 'falling', 0, false],
  [2, 1, 'falling', 0, true], [3, 1, 'rising', 1, false]
]) {
  test('mode ' + mode + ' has correct idle, sample edges, setup and full clock periods', () => {
    const result = S.build({data: '96', reply: '69', mode, hz: 1000000});
    assert.equal(result.steps[0].levels.SCLK, idle);
    const transitions = edges(result);
    assert.equal(transitions.length, 16);
    assert.deepEqual(transitions.map(step => step.levels.SCLK), Array.from({length: 16}, (_, i) => i % 2 ? idle : 1 - idle));
    assert.deepEqual(transitions.map(step => step.timeUs), Array.from({length: 16}, (_, i) => 1 + i * 0.5));
    for (let index = 0; index < transitions.length; index++) {
      assert.equal(!!transitions[index].sample, sampleIsFirst ? index % 2 === 0 : index % 2 === 1);
    }
    const samples = sampleSteps(result);
    assert.equal(samples.map(step => step.sample.mosi).join(''), '10010110');
    assert.equal(samples.map(step => step.sample.miso).join(''), '01101001');
    for (const step of samples) {
      assert.equal(step.sample.edge, sampleEdge);
      assert.equal(step.levels.SCLK, sampleClock);
      assert.equal(step.levels.CS, 0);
      const previous = result.steps[result.steps.indexOf(step) - 1];
      assert.equal(step.levels.MOSI, previous.levels.MOSI, 'MOSI stable before sampling');
      assert.equal(step.levels.MISO, previous.levels.MISO, 'MISO stable before sampling');
      assert.equal(step.timeUs - previous.timeUs, 0.5, 'half-cycle setup');
    }
    assert.deepEqual(final(result).received, [0x96]);
    assert.deepEqual(final(result).returned, [0x69]);
    assert.equal(final(result).levels.CS, 1);
    assert.equal(final(result).levels.SCLK, idle);
    assert.equal(result.steps.find(step => step.key === 'release').timeUs, 9);
  });
}

test('LSB order changes wire order while reconstructing the same bytes', () => {
  for (const mode of [0, 1, 2, 3]) {
    const result = S.build({data: '96 01', reply: '53 80', bitOrder: 'lsb', mode});
    const samples = sampleSteps(result);
    assert.equal(samples.map(step => step.sample.mosi).join(''), '0110100110000000');
    assert.equal(samples.map(step => step.sample.miso).join(''), '1100101000000001');
    assert.deepEqual(samples.slice(0, 8).map(step => step.sample.bitIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(final(result).received, [0x96, 1]);
    assert.deepEqual(final(result).returned, [0x53, 0x80]);
  }
});

test('each byte becomes available only on its eighth sample and CS spans both bytes', () => {
  const result = S.build();
  const samples = sampleSteps(result);
  for (let index = 0; index < samples.length; index++) {
    assert.equal(samples[index].received.length, Math.floor((index + 1) / 8));
    assert.equal(samples[index].returned.length, Math.floor((index + 1) / 8));
  }
  const selected = result.steps.findIndex(step => step.key === 'select');
  const released = result.steps.findIndex(step => step.key === 'release');
  assert.ok(result.steps.slice(selected, released).every(step => step.levels.CS === 0));
  assert.ok(result.steps.slice(released).every(step => step.levels.CS === 1));
});

test('no selection still finishes clocks but does not fabricate a peer or valid response', () => {
  for (const mode of [0, 1, 2, 3]) {
    const result = S.build({selected: false, mode});
    assert.ok(result.steps.every(step => step.levels.CS === 1));
    assert.ok(result.steps.every(step => step.levels.MISO === 1));
    assert.ok(sampleSteps(result).every(step => step.sample.accepted === false));
    assert.equal(edges(result).length, 32);
    assert.deepEqual(final(result).received, []);
    assert.deepEqual(final(result).returned, [255, 255]);
    assert.equal(result.outcome.ok, false);
    assert.equal(result.outcome.validReply, false);
    assert.match(result.outcome.detail, /上拉假设/);
    assert.match(final(result).status, /本端完成/);
  }
});

test('MISO preload is independent from the command and clock rate scales physical time', () => {
  const first = S.build({data: '00 FF', reply: '01 FE', hz: 1000});
  const second = S.build({data: '55 AA', reply: '01 FE', hz: 10000000});
  assert.equal(final(first).rxBits, final(second).rxBits);
  assert.ok(Math.abs(final(first).timeUs / final(second).timeUs - 10000) < 1e-8);
  for (const result of [first, second]) {
    const times = result.steps.filter(step => step.timeUs !== null).map(step => step.timeUs);
    assert.ok(times.every((time, index) => !index || time >= times[index - 1]));
  }
});

test('snapshots are immutable, input mutations cannot change them, and builds are deterministic', () => {
  const data = [0x96, 0x01];
  const reply = [0x69, 0x80];
  const result = S.build({data, reply});
  data[0] = 0;
  reply[0] = 0;
  assert.deepEqual(result.sent, [0x96, 1]);
  assert.deepEqual(result.expectedReply, [0x69, 0x80]);
  assert.deepEqual(result, S.build({data: '96 01', reply: '69 80'}));
  const samples = sampleSteps(result);
  assert.deepEqual(samples[0].received, []);
  assert.notEqual(samples[0].received, samples[1].received);
  assert.notEqual(samples[0].levels, samples[1].levels);
  assert.throws(() => { samples[0].levels.CS = 1; }, TypeError);
  assert.throws(() => { samples[0].received.push(1); }, TypeError);
  assert.throws(() => { samples[0].sample.value = 0; }, TypeError);
});

test('byte limits and invalid configuration are rejected before simulation', () => {
  for (const data of ['', 'A', 'GG', '0xA5', 'A5 Z0', [], [1.5], [-1], [256], ['1'], new Array(9).fill(0), null, 2]) {
    assert.throws(() => S.build({data}), undefined, JSON.stringify(data));
  }
  assert.throws(() => S.build({data: 'AA', reply: 'BB CC'}), /相同字节数/);
  assert.throws(() => S.build({reply: 'QQ'}));
  for (const hz of [0, -1, 999, 10000001, NaN, Infinity, '1000000', null]) assert.throws(() => S.build({hz}));
  for (const mode of [-1, 4, 0.5, '0', null]) assert.throws(() => S.build({mode}));
  for (const bitOrder of ['MSB', 'other', 0, null]) assert.throws(() => S.build({bitOrder}));
  for (const selected of [0, 1, 'false', null]) assert.throws(() => S.build({selected}));
  for (const options of [null, [], 2, 'SPI']) assert.throws(() => S.build(options));
  assert.equal(S.build({data: new Array(8).fill(255), reply: new Array(8).fill(0)}).sent.length, 8);
  assert.deepEqual(S.build({data: 'a53c', reply: '5a\nC3'}).sent, [0xA5, 0x3C]);
});

test('standalone script exports the same browser-facing API without dependencies', () => {
  const context = {window: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./spi.js'), 'utf8'), context);
  assert.equal(typeof context.window.SpiLab.build, 'function');
  assert.equal(context.window.SpiLab.build().protocol, 'SPI');
});
