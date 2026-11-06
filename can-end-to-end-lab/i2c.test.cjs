'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I2C = require('./i2c.js');

// Decode only physical rising SCL edges between START and STOP. This does not
// use the model's sample records, reconstructed byte arrays or field labels.
function wireDecode(run) {
  let active = false;
  let pending = [];
  const bytes = [];
  const acks = [];
  for (let index = 1; index < run.steps.length; index++) {
    const before = run.steps[index - 1].levels;
    const now = run.steps[index].levels;
    if (before.SCL === 1 && now.SCL === 1 && before.SDA === 1 && now.SDA === 0) {
      active = true;
      pending = [];
    } else if (before.SCL === 1 && now.SCL === 1 && before.SDA === 0 && now.SDA === 1) active = false;
    else if (active && before.SCL === 0 && now.SCL === 1) {
      pending.push(now.SDA);
      if (pending.length === 9) {
        bytes.push(pending.slice(0, 8).reduce((n, bit) => n * 2 + bit, 0));
        acks.push(pending[8]);
        pending = [];
      }
    }
  }
  return { bytes, acks };
}

test('7-bit write address and payload decode from physical edges, each byte acknowledged', () => {
  const run = I2C.build({ address: 0x50, data: 'DC05', direction: 'write' });
  assert.deepEqual(wireDecode(run), { bytes: [0xA0, 0xDC, 0x05], acks: [0, 0, 0] });
  assert.deepEqual(run.steps.at(-1).received, [0xDC, 5]);
  assert.deepEqual(run.steps.at(-1).returned, []);
  assert.equal(run.steps.at(-1).rxBits, '1101110000000101');
  assert.equal(run.outcome.ok, true);
  const ack = run.steps.filter(s => s.sample?.field === 'ACK');
  assert.equal(ack.length, 3);
  assert.ok(ack.every(s => s.sample.owner === 'target' && s.sample.receiver === 'controller'));
});

test('read reverses payload direction and ends with controller NACK without failure', () => {
  const run = I2C.build({ address: 0x3C, data: [0x00, 0xFF, 0xA5], direction: 'read' });
  assert.deepEqual(wireDecode(run), { bytes: [0x79, 0, 255, 0xA5], acks: [0, 0, 0, 1] });
  assert.deepEqual(run.sent, []);
  assert.deepEqual(run.expectedReply, [0, 255, 0xA5]);
  assert.deepEqual(run.steps.at(-1).received, []);
  assert.deepEqual(run.steps.at(-1).returned, [0, 255, 0xA5]);
  const ack = run.steps.filter(s => s.sample?.field === 'ACK');
  assert.equal(ack[0].sample.owner, 'target');
  assert.ok(ack.slice(1).every(s => s.sample.owner === 'controller'));
  assert.equal(ack.at(-1).sample.finalRead, true);
  assert.equal(ack.at(-1).sample.value, 1);
  assert.equal(ack.at(-1).drivers.controller.SDA, 'Z');
  assert.equal(ack.at(-1).drivers.target.SDA, 'Z');
  assert.equal(run.outcome.ok, true);
  assert.ok(run.steps.filter(s => s.sample?.field === 'DATA').every(s => s.sample.owner === 'target'));
});

test('address NACK prevents payload transfer, issues STOP and reports failure for both directions', () => {
  for (const direction of ['read', 'write']) {
    const run = I2C.build({ address: 0x20, data: '55 AA', direction, scenario: 'nack' });
    assert.deepEqual(wireDecode(run), { bytes: [0x40 + Number(direction === 'read')], acks: [1] });
    assert.equal(run.steps.filter(s => s.sample?.field === 'DATA').length, 0);
    assert.deepEqual(run.steps.at(-1).received, []);
    assert.deepEqual(run.steps.at(-1).returned, []);
    assert.equal(run.outcome.ok, false);
    assert.equal(run.steps.at(-1).stage, 'complete');
    assert.deepEqual(run.steps.find(s => s.key === 'stop').levels, { SCL: 1, SDA: 1 });
  }
});

test('clock stretching waits on actual low SCL before sampling and preserves bytes', () => {
  for (const direction of ['read', 'write']) {
    const config = { direction, hz: 400000, data: 'A5 5A' };
    const normal = I2C.build(config);
    const stretched = I2C.build({ ...config, scenario: 'stretch' });
    assert.deepEqual(wireDecode(stretched), wireDecode(normal));
    assert.equal(stretched.steps.at(-1).timeUs - normal.steps.at(-1).timeUs, 7.5);
    const index = stretched.steps.findIndex(s => s.key === 'clock-stretch');
    const held = stretched.steps[index];
    assert.equal(held.levels.SCL, 0);
    assert.equal(held.drivers.controller.SCL, 'Z');
    assert.equal(held.drivers.target.SCL, 0);
    assert.equal(held.sample, null);
    const released = stretched.steps[index + 1];
    assert.equal(released.timeUs - held.timeUs, 7.5);
    assert.equal(released.levels.SCL, 1);
    assert.equal(released.drivers.target.SCL, 'Z');
    assert.ok(stretched.steps[index + 2].sample);
  }
});

test('all 256 byte patterns survive physical decoding in each transfer direction', () => {
  for (const direction of ['read', 'write']) {
    for (let base = 0; base < 256; base += 8) {
      const data = Array.from({ length: 8 }, (_, i) => base + i);
      const run = I2C.build({ data, direction, address: 0x77 });
      assert.deepEqual(wireDecode(run).bytes.slice(1), data);
      assert.deepEqual(direction === 'read' ? run.steps.at(-1).returned : run.steps.at(-1).received, data);
    }
  }
});

test('SDA only changes while clock low except START/STOP; physical lines are wired-AND', () => {
  for (const scenario of ['success', 'nack', 'stretch']) {
    for (const direction of ['read', 'write']) {
      const run = I2C.build({ scenario, direction, data: '55 A3' });
      const highChanges = [];
      for (let i = 0; i < run.steps.length; i++) {
        const step = run.steps[i];
        for (const signal of ['SCL', 'SDA']) {
          const drivers = [step.drivers.controller[signal], step.drivers.target[signal]];
          assert.ok(drivers.every(d => d === 0 || d === 'Z'));
          assert.equal(step.levels[signal], drivers.includes(0) ? 0 : 1);
        }
        if (step.sample) assert.equal(step.levels.SCL, 1);
        if (i && step.levels.SCL === 1 && run.steps[i - 1].levels.SCL === 1 && step.levels.SDA !== run.steps[i - 1].levels.SDA) highChanges.push(step.key);
      }
      assert.deepEqual(highChanges, ['start', 'stop']);
      const timed = run.steps.filter(s => s.timeUs !== null);
      assert.ok(timed.every((s, i) => i === 0 || s.timeUs >= timed[i - 1].timeUs));
    }
  }
});

test('snapshots are immutable and earlier steps do not acquire later bytes', () => {
  const data = [0xA5, 0x5A];
  const run = I2C.build({ data });
  data[0] = 0;
  const samples = run.steps.filter(s => s.sample?.field === 'DATA');
  assert.deepEqual(samples[6].received, []);
  assert.deepEqual(samples[7].received, [0xA5]);
  assert.deepEqual(samples[15].received, [0xA5, 0x5A]);
  assert.equal(run.config.data[0], 0xA5);
  assert.throws(() => { samples[7].received.push(0); }, TypeError);
  assert.throws(() => { samples[7].levels.SCL = 0; }, TypeError);
});

test('invalid data, reserved addresses and unsupported settings are rejected', () => {
  for (const address of [0, 7, 120, 127, 128, NaN, 8.5]) assert.throws(() => I2C.build({ address }));
  for (const data of ['', 'F', 'GG', [], [256], [-1], [1.5], Array(9).fill(0)]) assert.throws(() => I2C.build({ data }));
  for (const hz of [0, 999, 1000001, NaN]) assert.throws(() => I2C.build({ hz }));
  assert.throws(() => I2C.build({ direction: 'both' }));
  assert.throws(() => I2C.build({ scenario: 'missing' }));
  assert.doesNotThrow(() => I2C.build({ address: 8, data: '00', hz: 1000 }));
  assert.doesNotThrow(() => I2C.build({ address: 119, data: 'FF', hz: 1000000 }));
});
