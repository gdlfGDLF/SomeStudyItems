const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { Device, DONE, ERROR, scenarios, run } = require('./registers.js');
function reg(step, name) {
  return step.snapshot.registers.find(item => item.name === name).value;
}
function enabled(mask = 3) {
  const device = new Device();
  device.write('CONTROL', 1);
  device.write('IRQ_ENABLE', mask);
  return device;
}

test('W1C truth table: only existing bits written as 1 are cleared', () => {
  for (let pending = 0; pending < 4; pending++) {
    for (let write = 0; write < 4; write++) {
      const device = enabled();
      device.raise(pending);
      device.write('IRQ_STATUS', write);
      assert.equal(device.read('IRQ_STATUS'), pending & ~write, 'pending=' + pending + ', write=' + write);
    }
  }
});

test('read is non-destructive, reserved bits are masked, and RO write is ignored', () => {
  const device = enabled();
  device.raise(DONE | ERROR);
  assert.equal(device.read('IRQ_STATUS'), 3);
  assert.equal(device.read('IRQ_STATUS'), 3);
  device.write('IRQ_STATUS', 0xfffffffc);
  assert.equal(device.read('IRQ_STATUS'), 3);
  device.write('IRQ_ENABLE', 0xffffffff);
  assert.equal(device.read('IRQ_ENABLE'), 3);
  device.write('CONTROL', 0xffffffff);
  assert.equal(device.read('CONTROL'), 1);
  const id = device.read('DEVICE_ID');
  device.write('DEVICE_ID', 0);
  assert.equal(device.read('DEVICE_ID'), id);
});

test('disabled device generates no new events; CONTROL does not clear old state', () => {
  const device = new Device();
  assert.equal(device.raise(DONE), false);
  assert.equal(device.read('IRQ_STATUS'), 0);
  device.write('CONTROL', 1);
  assert.equal(device.raise(ERROR), true);
  device.write('CONTROL', 0);
  assert.equal(device.read('IRQ_STATUS'), ERROR);
});

test('masked events remain latched and reassert IRQ when enabled', () => {
  const device = enabled(0);
  device.raise(DONE);
  assert.equal(device.irqLine, false);
  assert.equal(device.enterInterrupt(), false);
  assert.equal(device.read('IRQ_STATUS'), DONE);
  device.write('IRQ_ENABLE', ERROR);
  assert.equal(device.irqLine, false);
  device.write('IRQ_ENABLE', DONE);
  assert.equal(device.irqLine, true);
  assert.equal(device.enterInterrupt(), true);
});

test('EOI does not clear peripheral source; re-entry occurs only after return', () => {
  const device = enabled();
  device.raise(DONE);
  assert.equal(device.enterInterrupt(), true);
  assert.equal(device.enterInterrupt(), false);
  device.controllerComplete();
  assert.equal(device.irqLine, true);
  assert.equal(device.inIsr, true);
  assert.equal(device.enterInterrupt(), false);
  device.exitInterrupt();
  assert.equal(device.enterInterrupt(), true);
  assert.equal(device.irqEntries, 2);
});

test('clearing source does not itself finish ISR or notify the task', () => {
  const device = enabled();
  device.raise(DONE);
  device.enterInterrupt();
  device.record(DONE);
  device.write('IRQ_STATUS', DONE);
  assert.equal(device.irqLine, false);
  assert.equal(device.inIsr, true);
  assert.equal(device.controllerActive, true);
  assert.equal(device.taskState, 'blocked');
  assert.equal(device.notifications, 0);
  assert.throws(() => device.exitInterrupt());
  device.controllerComplete();
  device.notify();
  assert.equal(device.taskState, 'ready');
  assert.equal(device.takeNotification(), false, 'A task cannot run inside ISR');
  device.exitInterrupt();
  assert.equal(device.takeNotification(), true);
  assert.equal(device.notifications, 0);
  assert.equal(device.handled, 1);
  assert.equal(device.takeNotification(), false);
  device.blockTask();
  assert.equal(device.taskState, 'blocked');
});

test('normal trace separates source ack, controller completion, task readiness and execution', () => {
  const trace = run();
  const sourceAck = trace.steps.find(s => s.title === '向 W1C 写入已确认的位');
  assert.equal(sourceAck.snapshot.irqLine, false);
  assert.equal(sourceAck.snapshot.inIsr, true);
  assert.equal(sourceAck.snapshot.controllerActive, true);
  const notified = trace.steps.find(s => s.title === 'ISR 通知处理任务');
  assert.equal(notified.snapshot.taskState, 'ready');
  assert.equal(notified.snapshot.inIsr, true);
  assert.equal(notified.snapshot.handled, 0);
  const final = trace.steps.at(-1).snapshot;
  assert.equal(final.irqEntries, 1);
  assert.equal(final.handled, 1);
  assert.equal(final.notifications, 0);
  assert.equal(final.taskState, 'blocked');
  assert.equal(final.inIsr, false);
});

test('uncleared IRQ trace shows three re-entries without inventing task completion', () => {
  const trace = run({ scenario: 'irq-uncleared' });
  const last = trace.steps.at(-1);
  assert.equal(last.snapshot.irqEntries, 3);
  assert.equal(last.snapshot.irqLine, true);
  assert.equal(reg(last, 'IRQ_STATUS'), DONE);
  assert.equal(last.snapshot.handled, 0);
  assert.equal(trace.result.tone, 'warn');
});

test('masked trace preserves event before unmask and ultimately handles it once', () => {
  const trace = run({ scenario: 'irq-masked' });
  const pending = trace.steps.find(s => s.title === 'CPU 暂时没有进入 ISR');
  assert.equal(reg(pending, 'IRQ_STATUS'), DONE);
  assert.equal(pending.snapshot.irqLine, false);
  assert.equal(pending.snapshot.irqEntries, 0);
  const last = trace.steps.at(-1);
  assert.equal(last.snapshot.handled, 1);
  assert.equal(last.snapshot.irqEntries, 1);
});

test('direct W1C mask preserves ERROR, while read-modify-write loses unrecorded ERROR', () => {
  const correct = run({ scenario: 'w1c-correct' }).steps.at(-1);
  const wrong = run({ scenario: 'w1c-rmw' }).steps.at(-1);
  assert.equal(reg(correct, 'IRQ_STATUS'), ERROR);
  assert.equal(correct.snapshot.lostError, false);
  assert.equal(reg(wrong, 'IRQ_STATUS'), 0);
  assert.equal(wrong.snapshot.lostError, true);
});

test('lostError is a software-observation teaching flag, not a property of every clear', () => {
  const device = enabled();
  device.raise(ERROR);
  device.record(ERROR);
  device.write('IRQ_STATUS', ERROR);
  assert.equal(device.lostError, false);
  device.raise(ERROR);
  device.write('IRQ_STATUS', ERROR);
  assert.equal(device.lostError, true, 'new event needs to be recorded again');
});

test('RO scenario keeps ID and demonstrates writable CONTROL', () => {
  const trace = run({ scenario: 'ro-write' });
  for (const step of trace.steps) assert.equal(reg(step, 'DEVICE_ID'), 0x53545544);
  assert.equal(reg(trace.steps.at(-2), 'CONTROL'), 1);
  assert.equal(reg(trace.steps.at(-1), 'CONTROL'), 0);
});

test('all traces are deterministic, serializable, independent snapshots and have complete schema', () => {
  for (const scenario of scenarios) {
    const trace = run({ scenario: scenario.id });
    assert.deepEqual(trace, run({ scenario: scenario.id }));
    assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace);
    assert.equal(trace.kind, 'registers');
    trace.steps.forEach((step, index) => {
      assert.equal(step.tick, index);
      assert.equal(step.snapshot.time, index);
      assert.equal(typeof step.title, 'string');
      assert.equal(typeof step.detail, 'string');
      assert.equal(typeof step.code, 'string');
      assert.equal(step.snapshot.registers.length, 4);
    });
    const last = trace.steps.at(-1);
    last.snapshot.registers[0].value = 255;
    assert.equal(trace.steps[0].snapshot.registers[0].value, 0);
  }
});

test('invalid addresses, values, scenarios and impossible context transitions are rejected', () => {
  const device = new Device();
  for (const value of [-1, NaN, Infinity, 1.5, 0x100000000, '1']) {
    assert.throws(() => device.write('CONTROL', value), RangeError);
  }
  assert.throws(() => device.read('MISSING'), RangeError);
  assert.throws(() => device.write('MISSING', 1), RangeError);
  assert.throws(() => run({ scenario: 'missing' }), RangeError);
  assert.throws(() => device.controllerComplete());
  assert.throws(() => device.exitInterrupt());
  assert.throws(() => device.notify());
});

test('browser global exposes the same model without Node dependencies', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'registers.js'), 'utf8'), sandbox);
  assert.equal(sandbox.RegisterLab.run().kind, 'registers');
  assert.equal(sandbox.RegisterLab.scenarios.length, scenarios.length);
});
