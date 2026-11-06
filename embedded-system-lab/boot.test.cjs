const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Boot = require('./boot.js');
const at = (run, key) => run.steps.find(step => step.key === key);

test('normal boot separates ROM, SPL, U-Boot, kernel and userspace handoffs', () => {
  const run = Boot.build();
  assert.deepEqual([...new Set(run.steps.map(step => step.stage))], ['rom', 'spl', 'uboot', 'kernel', 'drivers', 'userspace']);
  for (const key of ['load-image', 'load-dtb', 'bootargs', 'handoff']) {
    assert.equal(at(run, key).state.linuxRunning, false, key);
    assert.equal(at(run, key).state.userspaceReady, false, key);
  }
  assert.equal(at(run, 'kernel-enter').state.linuxRunning, true);
  assert.equal(at(run, 'kernel-enter').state.uartReady, false);
  assert.equal(at(run, 'uart-probe').state.uartReady, true);
  assert.equal(at(run, 'uart-probe').state.ethReady, false);
  assert.equal(at(run, 'eth-probe').state.ethReady, true);
  assert.equal(at(run, 'rootfs-mounted').state.userspaceReady, false);
  assert.equal(at(run, 'init').state.userspaceReady, true);
  assert.equal(run.outcome.ok, true);
  assert.equal(run.steps.at(-1).state.halted, false);
});

test('kernel or DTB load failure stops before any Linux execution or driver initialization', () => {
  for (const scenario of ['kernel-missing', 'dtb-invalid']) {
    const run = Boot.build({scenario});
    assert.equal(run.outcome.ok, false);
    assert.equal(run.steps.at(-1).stage, 'uboot');
    assert.equal(run.steps.at(-1).state.halted, true);
    assert.ok(run.steps.every(step => !step.state.linuxRunning && !step.state.userspaceReady));
    assert.ok(run.steps.every(step => !step.state.uartReady && !step.state.ethReady));
    assert.equal(at(run, 'kernel-enter'), undefined);
  }
  assert.equal(at(Boot.build({scenario: 'kernel-missing'}), 'load-dtb'), undefined);
  assert.ok(at(Boot.build({scenario: 'dtb-invalid'}), 'load-image'));
});

test('missing root filesystem leaves a running kernel without applications', () => {
  const run = Boot.build({scenario: 'rootfs-missing'});
  const state = run.steps.at(-1).state;
  assert.equal(state.linuxRunning, true);
  assert.equal(state.userspaceReady, false);
  assert.equal(state.halted, true);
  assert.equal(state.uartReady, true);
  assert.equal(state.ethReady, true);
  assert.equal(run.outcome.ok, false);
  assert.equal(at(run, 'init'), undefined);
  assert.equal(at(run, 'ready'), undefined);
  assert.match(at(run, 'rootfs-failed').detail, /rootwait.*等待/);
});

test('each peripheral independently requires enabled node, matching compatible and available driver', () => {
  for (const uartEnabled of [false, true]) for (const uartDriver of [false, true]) for (const uartCompatible of [false, true]) {
    for (const ethEnabled of [false, true]) for (const ethDriver of [false, true]) for (const ethCompatible of [false, true]) {
      const run = Boot.build({uartEnabled, uartDriver, uartCompatible, ethEnabled, ethDriver, ethCompatible});
      const state = run.steps.at(-1).state;
      assert.equal(state.uartReady, uartEnabled && uartDriver && uartCompatible);
      assert.equal(state.ethReady, ethEnabled && ethDriver && ethCompatible);
      assert.equal(state.userspaceReady, true);
      assert.equal(run.outcome.ok, true, 'disabled peripheral does not prevent this board booting');
    }
  }
});

test('device-tree controls affect hardware descriptions but do not manufacture driver code', () => {
  assert.equal(Boot.deviceTree(), Boot.deviceTree({uartDriver: false, ethDriver: false}));
  const dts = Boot.deviceTree({uartEnabled: false, ethCompatible: false});
  assert.match(dts, /serial@10000000[\s\S]*?status = "disabled"/);
  assert.match(dts, /ethernet@10010000[\s\S]*?compatible = "study,unknown-ethernet"/);
  assert.match(dts, /虚拟教学硬件/);
  const disabled = Boot.build({uartEnabled: false});
  assert.match(disabled.steps.at(-1).state.uartReason, /disabled/);
  const absent = Boot.build({uartDriver: false});
  assert.match(absent.steps.at(-1).state.uartReason, /不会生成驱动/);
  const unmatched = Boot.build({uartCompatible: false});
  assert.match(unmatched.steps.at(-1).state.uartReason, /未绑定驱动/);
});

test('observer log survives a disabled console without claiming physical serial output', () => {
  const run = Boot.build({uartEnabled: false});
  assert.ok(at(run, 'uboot-prompt'));
  assert.match(at(run, 'uboot-prompt').detail, /不能证明 Linux/);
  assert.ok(run.steps.at(-1).logs.every(line => line.startsWith('[观察器 / 模拟]')));
  assert.match(at(run, 'uart-probe').detail, /真实串口.*可能没有输出/);
  assert.match(run.limits.join('\n'), /串口节点禁用.*静默/);
});

test('event state and accumulated logs are immutable independent snapshots', () => {
  const input = {uartEnabled: true};
  const run = Boot.build(input);
  input.uartEnabled = false;
  assert.equal(run.config.uartEnabled, true);
  assert.equal(run.steps[0].state.linuxRunning, false);
  assert.equal(run.steps[0].logs.length, 1);
  assert.equal(run.steps.at(-1).logs.length, run.steps.length);
  assert.notEqual(run.steps[0].state, run.steps[1].state);
  assert.notEqual(run.steps[0].logs, run.steps[1].logs);
  assert.throws(() => run.steps[0].logs.push('future'), TypeError);
  assert.ok(Object.isFrozen(run.steps[0].state));
  assert.ok(Object.isFrozen(run.steps[0].data));
  assert.deepEqual(run, Boot.build());
});

test('validation rejects unsupported scenarios and truthy strings', () => {
  assert.throws(() => Boot.build({scenario: 'mystery'}));
  assert.throws(() => Boot.build({uartEnabled: 'false'}));
  assert.throws(() => Boot.build({ethDriver: 1}));
  assert.throws(() => Boot.build([]));
  assert.throws(() => Boot.deviceTree({uartCompatible: 'yes'}));
});

test('standalone browser script exposes build and deviceTree without external code', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'boot.js'), 'utf8'), {window});
  assert.equal(typeof window.EmbeddedBoot.build, 'function');
  assert.equal(typeof window.EmbeddedBoot.deviceTree, 'function');
  assert.equal(window.EmbeddedBoot.build().outcome.ok, true);
  assert.equal(window.EmbeddedBoot.build({ethEnabled: false}).steps.at(-1).state.ethReady, false);
});
