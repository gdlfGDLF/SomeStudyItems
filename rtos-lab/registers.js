/* Virtual MMIO model: offsets and behavior are teaching contracts, not a real BSP.
 * Reference: https://docs.kernel.org/driver-api/device-io.html
 * The controller completion step abstracts GIC EOI; EOI is not peripheral W1C.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RegisterLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DONE = 1, ERROR = 2, ENABLE = 1;
  const definition = [
    { name: 'CONTROL', offset: '0x00', access: 'RW', description: 'bit 0：启用虚拟设备；其余位保留。' },
    { name: 'DEVICE_ID', offset: '0x04', access: 'RO', description: '固定器件标识 0x53545544；本虚拟设备忽略写入。' },
    { name: 'IRQ_STATUS', offset: '0x08', access: 'W1C', description: 'bit 0 DONE、bit 1 ERROR；事件锁存，写 1 清对应位，写 0 不变。' },
    { name: 'IRQ_ENABLE', offset: '0x0C', access: 'RW', description: 'bit 0、1 分别允许 DONE、ERROR 驱动电平中断线；不清除状态。' }
  ];
  function uint32(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('寄存器值必须是 0 到 0xFFFFFFFF 的整数');
    return value >>> 0;
  }
  class Device {
    constructor() {
      this.values = { CONTROL: 0, DEVICE_ID: 0x53545544, IRQ_STATUS: 0, IRQ_ENABLE: 0 };
      this.inIsr = false;
      this.controllerActive = false;
      this.taskState = 'blocked';
      this.notifications = 0;
      this.handled = 0;
      this.lostError = false;
      this.irqEntries = 0;
      this.recordedEvents = 0;
    }
    check(name) {
      if (!Object.prototype.hasOwnProperty.call(this.values, name)) throw new RangeError('未知寄存器：' + name);
    }
    read(name) {
      this.check(name);
      return this.values[name] >>> 0;
    }
    write(name, value) {
      this.check(name);
      value = uint32(value);
      if (name === 'DEVICE_ID') return this.read(name);
      if (name === 'IRQ_STATUS') {
        const cleared = this.values.IRQ_STATUS & value & 3;
        if ((cleared & ERROR) && !(this.recordedEvents & ERROR)) this.lostError = true;
        this.values.IRQ_STATUS &= ~(value & 3);
      } else {
        this.values[name] = value & (name === 'CONTROL' ? ENABLE : 3);
      }
      return this.read(name);
    }
    raise(bits) {
      bits = uint32(bits) & 3;
      if (!(this.values.CONTROL & ENABLE)) return false;
      this.values.IRQ_STATUS |= bits;
      // A new event is not yet recorded by software, even if an older one was.
      this.recordedEvents &= ~bits;
      return true;
    }
    record(bits) {
      this.recordedEvents |= uint32(bits) & this.values.IRQ_STATUS & 3;
    }
    get irqLine() {
      return (this.values.IRQ_STATUS & this.values.IRQ_ENABLE & 3) !== 0;
    }
    enterInterrupt() {
      if (!this.irqLine || this.inIsr || this.controllerActive) return false;
      this.inIsr = true;
      this.controllerActive = true;
      this.irqEntries++;
      return true;
    }
    controllerComplete() {
      if (!this.inIsr || !this.controllerActive) throw new Error('只有已进入的中断才能完成控制器确认');
      this.controllerActive = false;
    }
    exitInterrupt() {
      if (!this.inIsr || this.controllerActive) throw new Error('返回前需要完成控制器确认');
      this.inIsr = false;
    }
    notify() {
      if (!this.inIsr) throw new Error('此实验只从 ISR 发送任务通知');
      this.notifications++;
      this.taskState = 'ready';
    }
    takeNotification() {
      if (this.inIsr || this.notifications === 0) return false;
      this.notifications--;
      this.taskState = 'running';
      this.handled++;
      return true;
    }
    blockTask() {
      if (this.notifications !== 0) throw new Error('仍有通知时不能在此模型中阻塞');
      this.taskState = 'blocked';
    }
    snapshot(time) {
      return {
        time,
        registers: definition.map(item => Object.assign({}, item, { value: this.read(item.name) })),
        irqLine: this.irqLine,
        irqEnabled: this.values.IRQ_ENABLE !== 0,
        inIsr: this.inIsr,
        controllerActive: this.controllerActive,
        taskState: this.taskState,
        notifications: this.notifications,
        handled: this.handled,
        lostError: this.lostError,
        irqEntries: this.irqEntries,
        recordedEvents: this.recordedEvents
      };
    }
  }

  const scenarios = [
    { id: 'irq-normal', title: '正常中断 → 唤醒任务', description: '完成事件被锁存，ISR 记录并清源，再通知任务处理。' },
    { id: 'irq-uncleared', title: '忘记清源 → 反复进入 ISR', description: '比较外设状态清除与中断控制器 EOI；后者不会清掉前者。' },
    { id: 'irq-masked', title: '中断被屏蔽，事件还在吗？', description: '先屏蔽中断、产生事件，再解除屏蔽，观察锁存状态。' },
    { id: 'w1c-correct', title: 'W1C：只清 DONE', description: '写入 0x01，保留尚未处理的 ERROR。' },
    { id: 'w1c-rmw', title: 'W1C：读改写误清 ERROR', description: '状态为 0x03 时执行 status |= DONE，会写回什么？' },
    { id: 'ro-write', title: 'RO：写入不等于生效', description: '比较普通 RW 控制位与只读 DEVICE_ID。' }
  ];
  const limits = [
    '虚构外设与寄存器偏移，仅用于理解语义，不能用于真实板卡。RO 写入被忽略是本模型约定，实际器件也可能报错。',
    'IRQ_STATUS 采用锁存、写 1 清除，IRQ_ENABLE 只屏蔽输出；CONTROL 仅控制新事件的产生，不负责复位或清除旧事件。这些规则都须以实际手册为准。',
    '中断为电平触发，单核、无嵌套。控制器完成是 EOI 的抽象，不模拟 GIC 的全部 pending/active 状态、优先级、屏障或真实时延。',
    '清源、EOI、通知与 ISR 返回按一种教学顺序展示；真实 BSP/RTOS 可能由中断封装层处理 EOI，顺序与屏障要求依平台而定。',
    'lostError 表示清除了本示例软件尚未记录的 ERROR。真实硬件不提供这个“上帝视角”标志；读出状态也不自动代表业务已处理。',
    '每步是一项逻辑事件，不是 CPU 周期。volatile 不能替代访问器、内存屏障、缓存维护或多任务同步。'
  ];

  function run(options) {
    options = options || {};
    const id = options.scenario === undefined ? 'irq-normal' : options.scenario;
    const scenario = scenarios.find(item => item.id === id);
    if (!scenario) throw new RangeError('未知寄存器场景：' + id);
    const device = new Device(), steps = [];
    function step(title, detail, code, actor, action) {
      if (action) action();
      const tick = steps.length;
      steps.push({ title, detail, code: code || '', actor: actor || 'CPU', tick, snapshot: device.snapshot(tick) });
    }
    function configure(mask) {
      step('启用虚拟外设', 'CONTROL 为普通 RW：写入 bit 0 后，设备可以产生新事件。', 'mmio_write(CONTROL, ENABLE);', 'CPU', () => device.write('CONTROL', ENABLE));
      step(mask ? '打开事件中断' : '暂时屏蔽事件中断', 'IRQ_ENABLE 只决定锁存事件能否驱动中断线，不改变 IRQ_STATUS。', 'mmio_write(IRQ_ENABLE, ' + (mask ? 'DONE | ERROR' : '0') + ');', 'CPU', () => device.write('IRQ_ENABLE', mask));
    }
    function enter() {
      step('CPU 进入 ISR', '电平中断线有效且没有正在处理的 ISR，控制器交付中断。任务此刻仍未运行。', 'irq_handler(); // 由平台中断入口调用', 'ISR', () => {
        if (!device.enterInterrupt()) throw new Error('场景中的中断尚未满足进入条件');
      });
    }
    function eoi() {
      step('完成中断控制器确认', '平台封装层完成 EOI 的抽象操作。它结束控制器的 active 状态，不会替外设清除 IRQ_STATUS。', 'platform_irq_complete(); // 抽象 EOI', 'ISR', () => device.controllerComplete());
    }
    function exit() {
      step('从 ISR 返回', '退出中断上下文。随后才能调度普通任务；若源仍有效，仍可能再次进入 ISR。', 'return_from_irq();', 'ISR', () => device.exitInterrupt());
    }
    step('复位后的虚拟设备', '先预测结果，再单步观察。蓝图中的偏移是教学设定，不是 Zynq 实际地址。', '// 任务阻塞等待通知', 'idle');
    let result;

    if (id === 'irq-normal') {
      configure(3);
      step('设备产生 DONE', '设备把 DONE 锁存到 IRQ_STATUS。对应使能位为 1，中断线变为有效。', '// 硬件事件：IRQ_STATUS |= DONE', 'DEVICE', () => device.raise(DONE));
      enter();
      let status = 0;
      step('读取并记录原因', '读取不会清除状态。先把原因记录下来，之后清除才不会失去本次事件信息。', 'status = mmio_read(IRQ_STATUS);\nrecord_events(status);', 'ISR', () => { status = device.read('IRQ_STATUS'); device.record(status); });
      step('向 W1C 写入已确认的位', '写 1 清 DONE，写 0 保留其他位。外设中断线此时撤销，但 CPU 仍在 ISR 内。', 'mmio_write(IRQ_STATUS, status & DONE);', 'ISR', () => device.write('IRQ_STATUS', status & DONE));
      eoi();
      step('ISR 通知处理任务', '任务从阻塞变为就绪。通知成功不等于任务已经执行；CPU 还没有退出 ISR。', 'notify_task_from_isr(); // 对应平台允许的 ISR API', 'ISR', () => device.notify());
      exit();
      step('任务取得通知并处理', '本例没有其他更高优先级就绪任务，处理任务运行，消费一个通知并处理结果。', 'take_notification();\nprocess_result();', 'TASK', () => device.takeNotification());
      step('任务重新等待', '处理完成后阻塞，等待下一次事件，而不是占用 CPU 忙等。', 'wait_for_next_notification();', 'TASK', () => device.blockTask());
      result = { title: '一次事件，一次处理', detail: 'DONE 已清除，中断线撤销；通知被消费，任务处理 1 次后再次阻塞。', tone: 'good' };
    } else if (id === 'irq-uncleared') {
      configure(3);
      step('设备产生 DONE', '状态锁存并拉起电平中断线。', '// 硬件产生 DONE', 'DEVICE', () => device.raise(DONE));
      for (let i = 0; i < 3; i++) {
        enter();
        step('读取了状态，但没有清源', '这次 ISR 只读取状态。读取本模型的 W1C 寄存器没有清除副作用。', 'status = mmio_read(IRQ_STATUS);\n// 缺少 mmio_write(IRQ_STATUS, DONE);', 'ISR', () => device.read('IRQ_STATUS'));
        eoi();
        exit();
      }
      step('仍有待处理中断', '已演示三次 ISR 进入，DONE 和中断线仍有效。为便于观察，动画在此停止；问题没有自行消失。', '// IRQ_STATUS == DONE；IRQ line 仍有效', 'idle');
      result = { title: 'EOI 不能代替外设清源', detail: '仅完成控制器确认，电平源仍然有效，ISR 会反复进入。本例未通知任务。', tone: 'warn' };
    } else if (id === 'irq-masked') {
      configure(0);
      step('设备产生 DONE，但线没有拉起', 'IRQ_STATUS 已记录 DONE。使能掩码为 0，因此不向控制器提出中断请求。', '// 硬件产生 DONE；IRQ_ENABLE == 0', 'DEVICE', () => device.raise(DONE));
      step('CPU 暂时没有进入 ISR', '没有 ISR 不代表没有事件；可以看到状态位仍为 1，任务仍在等待。', '// 检查：暂不满足中断进入条件', 'CPU', () => {
        if (device.enterInterrupt()) throw new Error('屏蔽时不应进入中断');
      });
      step('解除 DONE 屏蔽', '不需要再产生一次事件；旧的锁存 DONE 与新掩码组合，使中断线立即有效。', 'mmio_write(IRQ_ENABLE, DONE);', 'CPU', () => device.write('IRQ_ENABLE', DONE));
      enter();
      step('记录并清除旧事件', '解除屏蔽后可处理先前的 DONE。屏蔽和清除是两件事。', 'record_events(mmio_read(IRQ_STATUS));\nmmio_write(IRQ_STATUS, DONE);', 'ISR', () => { device.record(device.read('IRQ_STATUS')); device.write('IRQ_STATUS', DONE); });
      eoi();
      step('发送任务通知', '处理任务变为就绪，等待 ISR 返回。', 'notify_task_from_isr();', 'ISR', () => device.notify());
      exit();
      step('任务处理先前的事件', '事件在被屏蔽期间没有丢失，但处理延迟了。', 'take_notification();\nprocess_result();', 'TASK', () => device.takeNotification());
      result = { title: '屏蔽中断不等于清除事件', detail: '本模型的状态会锁存；解除使能屏蔽后，旧事件仍可触发中断。', tone: 'good' };
    } else if (id === 'w1c-correct' || id === 'w1c-rmw') {
      configure(0);
      step('DONE 和 ERROR 同时置位', '当前 IRQ_STATUS = 0x03。本实验使用轮询，不启用中断。目标是只确认 DONE，保留 ERROR 供后续处理。', '// 硬件产生 DONE | ERROR', 'DEVICE', () => device.raise(DONE | ERROR));
      if (id === 'w1c-correct') {
        step('记录 DONE 并只写入 0x01', '写 DONE 对应的 1 清除 DONE；ERROR 对应写 0，因此 ERROR 保持为 1。', 'record_events(DONE);\nmmio_write(IRQ_STATUS, DONE);', 'CPU', () => { device.record(DONE); device.write('IRQ_STATUS', DONE); });
        step('读取剩余 ERROR', '现在 IRQ_STATUS = 0x02，未处理的 ERROR 仍可被软件发现。', 'pending = mmio_read(IRQ_STATUS); // 0x02', 'CPU', () => device.read('IRQ_STATUS'));
        result = { title: '只清除了指定事件', detail: 'DONE 清零，ERROR 保留；下一步应按业务要求记录并处理 ERROR。', tone: 'good' };
      } else {
        let readValue = 0;
        step('读改写：先读到 0x03', '程序打算确认 DONE，却把整个状态值读出来作为即将写回的基础。此例没有记录 ERROR。', 'temp = mmio_read(IRQ_STATUS); // 0x03', 'CPU', () => { readValue = device.read('IRQ_STATUS'); device.record(DONE); });
        step('与 DONE 做按位或，仍是 0x03', '0x03 | 0x01 = 0x03。普通变量中的“置位”，在这里将变成向两个状态位都写 1。', 'temp |= DONE; // 0x03', 'CPU', () => { readValue |= DONE; });
        step('写回 0x03，两个位都被清除', 'W1C 将 DONE 和 ERROR 同时清零，软件没有保留的 ERROR 信息因此丢失。', 'mmio_write(IRQ_STATUS, temp); // 写 0x03', 'CPU', () => device.write('IRQ_STATUS', readValue));
        result = { title: '读改写误清了 ERROR', detail: 'IRQ_STATUS 从 0x03 变成 0。不要默认对 W1C 寄存器使用 |=；应根据手册写入需要确认的位掩码。', tone: 'warn' };
      }
    } else {
      step('读取只读 ID', 'DEVICE_ID = 0x53545544。寄存器属性决定写入是否允许或有意义。', 'id = mmio_read(DEVICE_ID);', 'CPU', () => device.read('DEVICE_ID'));
      step('尝试写入 DEVICE_ID', '此虚拟器件忽略 RO 写入，ID 没有改变。真实硬件的处理方式必须查手册。', 'mmio_write(DEVICE_ID, 0); // 本模型忽略', 'CPU', () => device.write('DEVICE_ID', 0));
      step('写入普通 RW 控制位', 'CONTROL 的 bit 0 是可写位，写入 1 后保存为 1。', 'mmio_write(CONTROL, ENABLE);', 'CPU', () => device.write('CONTROL', ENABLE));
      step('清除普通 RW 控制位', 'CONTROL 与 W1C 状态寄存器不同：向 CONTROL 写 0 使 enable 变为 0。', 'mmio_write(CONTROL, 0);', 'CPU', () => device.write('CONTROL', 0));
      result = { title: '访问属性决定操作含义', detail: '同样是写 0，RW 可保存为 0、RO 可忽略、W1C 则保留原状态。此处采用明确的虚拟硬件约定。', tone: 'good' };
    }
    return { kind: 'registers', title: scenario.title, description: scenario.description, config: { scenario: id }, steps, result, limits: limits.slice() };
  }
  return { Device, DONE, ERROR, ENABLE, scenarios, run };
});
