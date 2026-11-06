(function (root, factory) {
  'use strict';
  const wire = typeof module === 'object' && module.exports ? require('./wire.js') : root.ProtocolLab;
  const api = factory(wire);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UartLab = api;
})(typeof window !== 'undefined' ? window : globalThis, function (wire) {
  'use strict';

  const hex = value => value.toString(16).toUpperCase().padStart(2, '0');
  function baudValue(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1200 || number > 2000000) {
      throw new Error(`${label}应在 1200～2000000 baud 之间。`);
    }
    return number;
  }
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function build(input = {}) {
    if (!wire) throw new Error('请先加载 wire.js。');
    const data = wire.parseData(input.data == null ? '55 A3' : input.data, 8);
    if (!data.length) throw new Error('请输入 1～8 个十六进制数据字节。');
    const baud = baudValue(input.baud == null ? 115200 : input.baud, '发送波特率');
    const receiverBaud = baudValue(input.receiverBaud == null ? baud : input.receiverBaud, '接收波特率');
    const parity = input.parity == null ? 'none' : input.parity;
    if (!['none', 'even', 'odd'].includes(parity)) throw new Error('校验方式应为 none、even 或 odd。');
    const frameFormat = `8${parity === 'none' ? 'N' : parity === 'even' ? 'E' : 'O'}1`;
    const model = wire.buildUart({ data, baud, receiverBaud, parity });
    const bitUs = model.timing.bitUs;
    const rxBitUs = 1e6 / receiverBaud;
    const events = [];
    const steps = [];
    let txBits = '', rxBits = '', txDone = false;
    const received = [];
    let framingErrors = 0, parityErrors = 0;
    const lineAt = timeUs => {
      const bit = model.bits[Math.floor(timeUs / bitUs + 1e-10)];
      return bit ? bit.value : 1;
    };
    function step(key, stage, title, detail, timeUs, sample = null, status = '进行中') {
      steps.push({
        key, stage, title, detail, timeUs,
        levels: { TX: timeUs == null ? 1 : lineAt(timeUs) },
        sample: sample ? { ...sample } : null,
        txBits, rxBits, received: received.slice(), returned: [], status,
        txDone, framingErrors, parityErrors
      });
    }
    step('submit', 'software', '软件提交字节',
      `应用交给 Linux 串口接口 ${data.length} 字节：${data.map(hex).join(' ')}。UART 没有消息边界；本次把这些字节连续发出。`, null);
    step('driver', 'software', '内核与驱动准备发送',
      'Linux TTY / 串口层将数据交给串口驱动，驱动把数据送入 UART 控制器的发送缓冲区。write 返回不等于线上的最后一位已经发完。', null);
    step('configure', 'controller', '控制器逐字节加上边界',
      `本次使用 ${frameFormat}：起始位 0、8 个数据位（最低位先发）${parity === 'none' ? '' : `、${parity === 'even' ? '偶' : '奇'}校验位`}、停止位 1。发送和接收各自计时，没有随数据传送的时钟线。`, null);
    step('idle', 'wire', '空闲时线路为高电平',
      '发送 TX 接对端 RX，并连接共同参考地。这里显示数字逻辑电平，不是 RS-232 或 RS-485 接口电压。', null);

    model.bits.forEach(bit => events.push({
      kind: 'wire', timeUs: bit.index * bitUs, order: 0, bit
    }));
    model.samples.forEach(sample => events.push({ kind: 'sample', timeUs: sample.timeUs, order: 1, sample }));
    model.frames.forEach(frame => events.push({
      kind: 'decode', timeUs: frame.samples.at(-1).timeUs, order: 2, frame
    }));
    events.push({ kind: 'txdone', timeUs: model.durationUs, order: 3 });
    // A receiver with a slower clock can still be sampling after TX becomes idle.
    // Keep the two devices' events on one timeline instead of delaying TX completion.
    events.sort((a, b) => a.timeUs - b.timeUs || a.order - b.order);
    for (const event of events) {
      if (event.kind === 'wire') {
        const bit = event.bit;
        const frame = model.frames[bit.byteIndex];
        const offset = bit.index - frame.start;
        let title, detail;
        if (bit.field === 'START') {
          title = `第 ${bit.byteIndex + 1} 字节：起始位 0`;
          detail = '线路从空闲高电平进入低电平。对端检测起始下降沿，以自己的波特率开始计时。';
        } else if (bit.field === 'DATA') {
          txBits += bit.value;
          title = `发送数据位 b${offset - 1} = ${bit.value}`;
          detail = `字节 0x${hex(frame.byte)} 的第 ${offset} 个数据位放到 TX。b0 最先发；本位持续 ${bitUs.toFixed(3)} μs，接收端稍后在自己的采样点读取。`;
        } else if (bit.field === 'PARITY') {
          title = `${parity === 'even' ? '偶' : '奇'}校验位 = ${bit.value}`;
          detail = `发送器使 8 个数据位与校验位中的 1 的总数为${parity === 'even' ? '偶数' : '奇数'}。校验位不属于用户数据。`;
        } else {
          title = '停止位 1';
          detail = '本字节以一个高电平停止位结束。接收器检查停止位；它不是对端发回的 ACK。';
        }
        step(`wire-${bit.index}`, 'wire', title, detail, event.timeUs);
      } else if (event.kind === 'sample') {
        const s = event.sample;
        const frame = model.frames[s.byteIndex];
        const bitIndex = s.index - frame.start - 1;
        if (s.field === 'DATA') rxBits += s.actual;
        const label = s.field === 'DATA' ? `数据位 b${bitIndex}` : s.field === 'START' ? '起始位' : s.field === 'STOP' ? '停止位' : '校验位';
        const detail = `对端读取${label}，电平是 ${s.actual}。` +
          (s.field === 'START' ? `本模型在起始沿后半个接收位时间检查起始位，随后每 ${rxBitUs.toFixed(3)} μs 读取一次。` : `采样时刻来自接收端自己的 ${receiverBaud} baud 时钟。`) +
          (!s.inWindow ? '此采样点已偏离发送端对应位的时间区间。' : '') +
          (!s.ok ? '实验器对照发现读值与发送值不同；硬件是否能发现错误还要看格式与校验。' : '');
        step(`sample-${s.index}`, 'receiver', `对端采样：${label} → ${s.actual}`, detail, event.timeUs,
          { signal: 'TX', value: s.actual, expected: s.expected, field: s.field, byteIndex: s.byteIndex, bitIndex: s.field === 'DATA' ? bitIndex : null, ok: s.ok, inWindow: s.inWindow });
      } else if (event.kind === 'decode') {
        const frame = event.frame;
        const valid = frame.framingOk && frame.parityOk;
        if (!frame.framingOk) framingErrors++;
        if (!frame.parityOk) parityErrors++;
        if (valid) received.push(frame.received);
        const mismatched = frame.received !== frame.byte;
        step(`decode-${frame.byteIndex}`, 'receiver',
          valid ? `对端还原出 0x${hex(frame.received)}` : `第 ${frame.byteIndex + 1} 字节检查未通过`,
          !frame.framingOk ? '起始位或停止位的读值不符合本模型的格式检查，此字节不计入有效接收数据。' :
            !frame.parityOk ? '数据位与校验位不满足奇偶规则。实验把此字节排除；真实驱动也可能连同错误标记交给上层。' :
              mismatched ? '格式和校验通过，但还原结果与发送值不同：这是实验器对照发现的静默误码，UART 硬件不一定会报错。' :
                '按 b0 到 b7 将采样位放回字节。格式与所选校验通过，可进入接收缓冲区，再由对端驱动交给应用。',
          event.timeUs, null, valid ? '接收字节已还原' : '接收检查失败');
      } else {
        txDone = true;
        step('txdone', 'controller', '发送器已经把所有位移出',
          '最后一个停止位已经发完，发送移位器回到空闲状态。这里只完成了本地发送；UART 没有内建 ACK，不能由此判断对端是否收到或应用是否处理。',
          event.timeUs, null, '本地发送完成');
      }
    }
    const outcome = { ...model.outcome };
    if (outcome.code === 'success') {
      outcome.title = '发送完毕，对端还原出相同字节';
      outcome.detail = '实验器观察到本次收发数据一致。UART 本身没有 ACK；真实发送端仍需要应用层响应才能确认对端已收到或处理。';
    }
    step('complete', 'complete', outcome.title, outcome.detail,
      Math.max(model.durationUs, ...model.samples.map(s => s.timeUs)), null,
      outcome.ok ? '实验结束' : '发送已结束，接收存在问题');
    return freeze({
      protocol: 'UART',
      config: { data: data.slice(), baud, receiverBaud, parity, frameFormat },
      signals: [{ key: 'TX', label: 'TX → 对端 RX', idle: 1 }],
      steps, sent: data.slice(), expectedReply: [], outcome,
      txDurationUs: model.durationUs,
      durationUs: steps.at(-1).timeUs,
      frameResults: model.frames.map(frame => ({
        byteIndex: frame.byteIndex, sent: frame.byte, received: frame.received,
        framingOk: frame.framingOk, parityOk: frame.parityOk
      })),
      limits: [
        '这是通用 Linux TTY → 串口驱动 → UART 控制器的教学路径，未使用 Tosun CAN 驱动或声称此板卡提供 UART。控制器可以位于 SoC 或 FPGA。',
        'UART 展示单方向、8 数据位、1 停止位、可选奇偶校验；反向通信需要另一条 TX → RX 线。本次不模拟应用层应答。',
        ...model.limits,
        '波特率范围 1200～2000000 是实验界面范围，不是 UART 协议的统一硬件限制。软件阶段未赋予真实执行耗时。'
      ],
      sources: [
        { title: 'Microchip：UART 起始检测与数据采样', url: 'https://onlinedocs.microchip.com/oxy/GUID-EDB1839B-8CB3-4792-92DA-B3964E0885C3-en-US-4/GUID-B7E95CAB-3E52-4AFF-83E3-B9072066347E.html' },
        { title: 'Linux：串口底层驱动接口', url: 'https://docs.kernel.org/driver-api/serial/driver.html' }
      ]
    });
  }
  return { build };
});
