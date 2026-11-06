/* I2C teaching model: a single controller and a single addressed target.
 * Logic levels and nominal timing only; no device I/O or board-specific driver. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.I2cLab = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const hex = value => value.toString(16).padStart(2, '0').toUpperCase();
  const roles = { controller: '主机', target: '对端' };

  function integer(value, min, max, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}必须是 ${min}～${max} 的整数。`);
    return n;
  }

  function parseData(input) {
    let bytes;
    if (Array.isArray(input)) bytes = input.map(n => integer(n, 0, 255, '每个数据字节'));
    else if (typeof input === 'string') {
      const clean = input.trim().replace(/\s+/g, '');
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(clean)) throw new Error('数据请填写完整的十六进制字节，例如 DC 05。');
      bytes = clean.match(/../g).map(n => parseInt(n, 16));
    } else throw new Error('数据请填写十六进制文本或字节数组。');
    if (bytes.length < 1 || bytes.length > 8) throw new Error('本实验支持 1～8 个数据字节。');
    return bytes;
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  function build(options = {}) {
    const data = parseData(options.data === undefined ? 'DC 05' : options.data);
    const address = integer(options.address === undefined ? 0x50 : options.address, 8, 119, '7 位地址（排除保留地址）');
    const hz = integer(options.hz === undefined ? 100000 : options.hz, 1000, 1000000, '时钟频率');
    const direction = options.direction === undefined ? 'write' : options.direction;
    const scenario = options.scenario === undefined ? 'success' : options.scenario;
    if (!['write', 'read'].includes(direction)) throw new Error('方向只能是 write 或 read。');
    if (!['success', 'nack', 'stretch'].includes(scenario)) throw new Error('请选择正常、地址无应答或时钟延展实验。');

    const isRead = direction === 'read';
    const period = 1000000 / hz;
    const addressByte = (address << 1) | Number(isRead);
    const config = { address, data: data.slice(), hz, direction, scenario, bitUs: period };
    const steps = [];
    const received = [];
    const returned = [];
    const driver = { controller: { SCL: 'Z', SDA: 'Z' }, target: { SCL: 'Z', SDA: 'Z' } };
    let time = 0;
    let txBits = '';
    let rxBits = '';
    let status = '等待提交';
    let stretchUsed = false;
    let currentByte = 0;
    let observedAddress = 0;

    function levels() {
      return {
        SCL: driver.controller.SCL === 0 || driver.target.SCL === 0 ? 0 : 1,
        SDA: driver.controller.SDA === 0 || driver.target.SDA === 0 ? 0 : 1
      };
    }

    function emit(key, stage, title, detail, sample = null, at = time) {
      steps.push({
        key, stage, title, detail, timeUs: at === null ? null : Number(at.toFixed(6)),
        levels: levels(),
        drivers: { controller: { ...driver.controller }, target: { ...driver.target } },
        sample: sample ? { ...sample } : null,
        txBits, rxBits, received: received.slice(), returned: returned.slice(), status
      });
    }

    function setData(owner, bit) {
      driver.controller.SDA = 'Z';
      driver.target.SDA = 'Z';
      driver[owner].SDA = bit === 0 ? 0 : 'Z';
    }

    // Each clock contains low setup, rising edge, high-period sampling, falling edge.
    // SDA changes only during SCL low except the intentional START/STOP transitions.
    function clockBit(bit, field, owner, byteIndex, bitIndex, metadata = {}) {
      const prefix = `${field.toLowerCase()}-${byteIndex}-${bitIndex}`;
      const start = time;
      const receiver = owner === 'controller' ? 'target' : 'controller';
      const label = field === 'ACK' ? (bit ? 'NACK' : 'ACK') : `${field === 'DATA' ? '数据' : '地址'}位 ${bitIndex}`;
      time = start + period * 0.25;
      setData(owner, bit);
      emit(`${prefix}-setup`, 'wire', `${roles[owner]}准备${label}`,
        `SCL 为低时调整 SDA。${roles[owner]}${bit ? '释放 SDA，由上拉形成逻辑 1' : '拉低 SDA，形成逻辑 0'}。`);

      time = start + period * 0.5;
      driver.controller.SCL = 'Z';
      let extra = 0;
      if (scenario === 'stretch' && field === 'DATA' && !stretchUsed) {
        stretchUsed = true;
        driver.target.SCL = 0;
        status = '等待对端释放时钟';
        emit('clock-stretch', 'receiver', '对端让时钟暂时停住',
          '主机已经释放 SCL，但对端继续拉低它；实际线上仍是 0，主机必须等待，此时不能采样。');
        extra = period * 3;
        time += extra;
        driver.target.SCL = 'Z';
        status = '继续传输';
      }
      emit(`${prefix}-rise`, 'wire', 'SCL 变高，保持数据稳定',
        '两端都释放 SCL 后，线上才成为逻辑 1。SDA 在这个高电平期间保持不变。');

      time = start + period * 0.75 + extra;
      const actual = levels().SDA;
      const sample = { signal: 'SDA', value: actual, field, owner, receiver, byteIndex, bitIndex, ...metadata };
      if (field === 'DATA') {
        txBits += String(bit);
        rxBits += String(actual);
        currentByte = (currentByte << 1) | actual;
        if (bitIndex === 0) {
          (isRead ? returned : received).push(currentByte);
          currentByte = 0;
        }
      } else if (field === 'ADDRESS' || field === 'RW') {
        observedAddress = (observedAddress << 1) | actual;
      }
      let detail = `${roles[receiver]}读取此时的 SDA=${actual}，保存这一位；先传最高位，再传最低位。`;
      if (field === 'RW') detail = `对端已还原地址 0x${hex(observedAddress >> 1)}，方向位 ${actual} 表示${actual ? '主机读取' : '主机写入'}。接下来是第 9 拍应答。`;
      if (field === 'ACK') {
        if (metadata.finalRead) detail = '主机已收齐最后一个字节，释放 SDA 送出 NACK=1，告诉对端停止继续发送。这是正常读取结束，不是错误。';
        else if (bit) detail = '第 9 拍 SDA 仍为 1：地址没有得到 ACK。主机终止本次传输，随后发出 STOP，不再发送数据。';
        else detail = `${roles[owner]}在第 9 拍把 SDA 拉低，${roles[receiver]}读到 ACK=0。它表示接收方接受了这个字节，不表示业务处理已经完成。`;
      }
      emit(`${prefix}-sample`, 'receiver', field === 'ACK'
        ? `${roles[receiver]}读到 ${bit ? 'NACK' : 'ACK'}${metadata.finalRead ? ' · 正常收尾' : ''}`
        : `${roles[receiver]}采到 ${actual}${field === 'DATA' && bitIndex === 0 ? `，拼成 0x${hex((isRead ? returned : received).at(-1))}` : ''}`, detail, sample);

      time = start + period + extra;
      driver.controller.SCL = 0;
      emit(`${prefix}-fall`, 'wire', '这一拍结束', '主机拉低 SCL，接下来才能安全地改变 SDA。');
    }

    emit('submit', 'software', isRead ? '软件请求读取数据' : '软件提交要写入的数据',
      isRead ? `软件请求从地址 0x${hex(address)} 读取 ${data.length} 个字节。输入框中的数据是对端预先准备的内容。`
        : `软件要求向地址 0x${hex(address)} 写入 ${data.map(hex).join(' ')}。此时还没有任何位出现在总线上。`, null, null);
    emit('kernel', 'software', 'Linux 把请求交给驱动',
      '示例路径：应用通过 /dev/i2c-N 发起一次传输，Linux I²C 子系统把地址、方向和缓冲区交给控制器驱动。', null, null);
    emit('controller', 'controller', '控制器安排时钟和位顺序',
      '驱动配置 I²C 控制器。控制器负责 START、地址、每个字节的 8 位与第 9 拍应答，以及 STOP；它可以集成在处理器或桥接芯片里。', null, null);
    status = '总线空闲';
    emit('idle', 'wire', '两根线都处于高电平', '双方释放 SDA 和 SCL；上拉电阻让两根线呈现逻辑 1。“释放”不是主动输出高电平。');
    time = period * 0.5;
    driver.controller.SDA = 0;
    status = '地址传输中';
    emit('start', 'wire', 'START：通知总线上所有设备', 'SCL 保持高电平时，SDA 从 1 变 0，表示一次传输开始。随后发送地址来选择对端。');
    time = period;
    driver.controller.SCL = 0;
    emit('start-hold', 'wire', '开始第一个时钟周期', '主机先拉低 SCL，再准备地址的最高位。');

    for (let bit = 7; bit >= 0; bit--) clockBit((addressByte >> bit) & 1, bit === 0 ? 'RW' : 'ADDRESS', 'controller', -1, bit);
    const addressAccepted = scenario !== 'nack';
    clockBit(addressAccepted ? 0 : 1, 'ACK', 'target', -1, 8, { ack: addressAccepted, addressAck: true });
    if (addressAccepted) {
      status = isRead ? '主机读取数据' : '对端接收数据';
      for (let byteIndex = 0; byteIndex < data.length; byteIndex++) {
        const owner = isRead ? 'target' : 'controller';
        for (let bit = 7; bit >= 0; bit--) clockBit((data[byteIndex] >> bit) & 1, 'DATA', owner, byteIndex, bit);
        const finalRead = isRead && byteIndex === data.length - 1;
        clockBit(finalRead ? 1 : 0, 'ACK', isRead ? 'controller' : 'target', byteIndex, 8,
          { ack: !finalRead, addressAck: false, finalRead });
      }
    } else status = '地址未获应答';

    time += period * 0.25;
    setData('controller', 0);
    emit('stop-setup', 'wire', '准备结束传输', 'SCL 为低时由主机把 SDA 拉低，对端释放 SDA，为 STOP 做准备。');
    time += period * 0.25;
    driver.controller.SCL = 'Z';
    emit('stop-clock', 'wire', '先释放时钟', '主机释放 SCL，等待线上变高，SDA 暂时保持为 0。');
    time += period * 0.5;
    driver.controller.SDA = 'Z';
    status = addressAccepted ? '总线传输完成' : '传输结束：地址无应答';
    emit('stop', 'wire', 'STOP：本次传输结束', 'SCL 为高电平时，SDA 从 0 变 1。两根线重新回到空闲状态。');
    emit('driver-complete', 'controller', '控制器把结果交回驱动',
      addressAccepted ? '控制器报告这次总线操作完成；驱动可以结束等待，并把结果交回 Linux。具体硬件可用中断或轮询，这里不假定某一块板卡的实现。'
        : '控制器报告地址未应答；驱动返回传输错误，而不是把它当成写入成功。');
    emit('complete', 'complete', addressAccepted ? '软件拿到完成结果' : '软件拿到失败结果',
      !addressAccepted ? '本次请求已经结束，但没有设备确认地址。模拟器不会生成任何有效载荷接收结果。'
        : isRead ? `主机已获得 ${returned.map(hex).join(' ')}。最后的 NACK 只是“读够了”，读取成功。`
          : `对端控制器已接收 ${received.map(hex).join(' ')}。ACK 和本次完成都不能证明对端应用已经执行这些数据。`);

    return freeze({
      protocol: 'I2C', config,
      signals: [{ key: 'SCL', label: 'SCL · 时钟', idle: 1 }, { key: 'SDA', label: 'SDA · 共用数据线', idle: 1 }],
      steps,
      sent: isRead ? [] : data.slice(), expectedReply: isRead ? data.slice() : [],
      outcome: {
        ok: addressAccepted,
        title: addressAccepted ? (isRead ? '读取成功，最后的 NACK 是正常收尾' : '写入完成，对端逐字节 ACK') : '地址无应答，本次传输失败',
        detail: addressAccepted ? (isRead ? '对端发送，主机采样；中间字节 ACK，最后一个字节 NACK，然后 STOP。' : '先寻址，再逐字节传输；每个字节之后由接收方应答。对端业务处理不在本实验中。') + (scenario === 'stretch' ? '本次对端曾拉低 SCL 延长等待；主机等时钟真正变高才继续。' : '') : '第 9 拍没有被拉低。主机发出 STOP，未传输数据字节。'
      },
      limits: [
        '这是通用 Linux I²C 路径与理想逻辑波形，不代表 Tosun CAN 板卡具有 I²C 功能，也不读取真实硬件。',
        '只模拟单控制器、7 位普通地址、单次读或写；未展开重复 START、10 位地址、多控制器仲裁、总线恢复和设备寄存器语义。',
        '数据按最高位先传。读模式的数据来自对端预置缓冲区，设备是否支持这种直接读取需要查看它自己的手册。',
        '逻辑 1 表示释放线路、由上拉形成高电平。使用理想 50% 占空比和高电平中点采样，不模拟上升时间、电容、噪声，也不验证具体速率下的电气时序合规。',
        '延展实验只在首个数据位前把 SCL 额外保持低电平 3 个周期；并非所有设备或控制器都支持时钟延展。',
        'I²C ACK 是每个字节的接收确认；最终读 NACK 是主机主动结束读取。完成回报时刻没有硬件实测依据。'
      ],
      sources: [
        { title: 'NXP UM10204 · I²C 总线规范，§3.1.3–3.1.10', url: 'https://www.nxp.com/docs/en/user-guide/UM10204.pdf' },
        { title: 'Linux 内核 · I²C 用户空间接口', url: 'https://docs.kernel.org/i2c/dev-interface.html' }
      ]
    });
  }

  return { build, parseData };
});
