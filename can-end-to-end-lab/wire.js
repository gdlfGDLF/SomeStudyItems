(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProtocolLab = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function integer(value, min, max, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}必须是 ${min}～${max} 的整数。`);
    return n;
  }
  function positive(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}必须是大于 0 的有限数。`);
    return n;
  }
  function parseData(input, maxBytes = 8) {
    let bytes;
    if (Array.isArray(input) || ArrayBuffer.isView(input)) bytes = Array.from(input);
    else {
      const text = String(input == null ? '' : input).trim();
      if (!text) bytes = [];
      else {
        let tokens = text.split(/[\s,:_-]+/).filter(Boolean);
        if (tokens.length === 1 && !/^0x/i.test(tokens[0]) && tokens[0].length > 2 && tokens[0].length % 2 === 0) tokens = tokens[0].match(/.{2}/g);
        if (tokens.some(t => !/^(?:0x)?[\da-f]{1,2}$/i.test(t))) throw new Error('数据请输入十六进制字节，例如 DC 05 00 FF。');
        bytes = tokens.map(t => parseInt(t.replace(/^0x/i, ''), 16));
      }
    }
    if (bytes.length > maxBytes) throw new Error(`数据最多 ${maxBytes} 字节。`);
    return bytes.map(n => integer(n, 0, 255, '数据字节'));
  }
  function canId(value) {
    if (typeof value === 'string') {
      if (!/^(?:0x)?[\da-f]{1,3}$/i.test(value.trim())) throw new Error('CAN ID 请输入 000～7FF 的十六进制数。');
      value = parseInt(value.replace(/^0x/i, ''), 16);
    }
    return integer(value, 0, 0x7ff, '标准 CAN ID');
  }
  function timing(config = {}) {
    const clockMHz = positive(config.clockMHz == null ? 160 : config.clockMHz, 'CAN 时钟 MHz');
    if (clockMHz > 1000) throw new Error('本实验 CAN 时钟范围为大于 0 且不超过 1000 MHz。');
    const brp = integer(config.brp == null ? 16 : config.brp, 1, 1024, '实际分频系数');
    const tseg1 = integer(config.tseg1 == null ? 15 : config.tseg1, 1, 256, 'TSEG1');
    const tseg2 = integer(config.tseg2 == null ? 4 : config.tseg2, 1, 128, 'TSEG2');
    const totalTq = 1 + tseg1 + tseg2;
    const tqNs = 1000 * brp / clockMHz;
    const bitNs = totalTq * tqNs;
    return { clockMHz, brp, tseg1, tseg2, totalTq, tqNs, bitNs, bitUs: bitNs / 1000,
      bitrate: 1e9 / bitNs, samplePercent: (1 + tseg1) / totalTq * 100, sampleNs: (1 + tseg1) * tqNs };
  }
  function suggestTiming(clockMHz, bitrate, samplePercent = 80) {
    const hz = positive(clockMHz, 'CAN 时钟 MHz') * 1e6;
    bitrate = positive(bitrate, '目标位速率');
    samplePercent = positive(samplePercent, '目标采样点');
    if (samplePercent >= 100 || clockMHz > 1000) throw new Error('采样点应小于 100%，时钟不超过 1000 MHz。');
    let best = null;
    for (let totalTq = 3; totalTq <= 385; totalTq++) {
      const idealBrp = hz / bitrate / totalTq;
      for (const brp of new Set([Math.floor(idealBrp), Math.ceil(idealBrp)])) {
      if (brp < 1 || brp > 1024) continue;
      const tseg1 = Math.max(1, Math.min(256, totalTq - 2, Math.round(totalTq * samplePercent / 100) - 1));
      const tseg2 = totalTq - 1 - tseg1;
      if (tseg2 < 1 || tseg2 > 128) continue;
      const t = timing({ clockMHz, brp, tseg1, tseg2 });
      const errorPercent = (t.bitrate / bitrate - 1) * 100;
      const score = Math.abs(errorPercent) * 1e6 + Math.abs(t.samplePercent - samplePercent) * 100 + Math.abs(totalTq - 20) * 0.001;
      if (!best || score < best.score) best = { ...t, targetBitrate: bitrate, targetSamplePercent: samplePercent, errorPercent, score };
      }
    }
    if (!best) throw new Error('在本实验的分频与 TQ 范围内无法找到配置。');
    delete best.score;
    return best;
  }
  function binary(value, width) {
    return Array.from({ length: width }, (_, i) => (value >>> (width - i - 1)) & 1);
  }
  function bitsNumber(bits) { return bits.reduce((n, b) => (n << 1) | (typeof b === 'number' ? b : b.value), 0); }
  function crc15(values) {
    let crc = 0;
    for (const v of values) {
      const feedback = ((crc >>> 14) & 1) ^ (typeof v === 'number' ? v : v.value);
      crc = (crc << 1) & 0x7fff;
      if (feedback) crc ^= 0x4599;
    }
    return crc;
  }
  function fieldSegments(bits) {
    const result = [];
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      const last = result[result.length - 1];
      if (last && last.name === b.field && last.byteIndex === b.byteIndex) { last.end++; last.length++; }
      else result.push({ name: b.field, start: i, end: i + 1, length: 1, byteIndex: b.byteIndex });
    }
    return result;
  }
  function stuffBits(raw) {
    const bits = [];
    let last = -1, run = 0;
    raw.forEach((b, rawIndex) => {
      bits.push({ ...b, rawIndex, stuffed: false, index: bits.length });
      run = b.value === last ? run + 1 : 1;
      last = b.value;
      if (run === 5) {
        last = 1 - last;
        bits.push({ value: last, field: b.field, rawIndex: null, stuffed: true, index: bits.length });
        run = 1;
      }
    });
    return bits;
  }
  function decodeCan(bits) {
    const raw = [];
    let cursor = 0, last = -1, run = 0, target = 34, dlc = 0;
    function fail(code, detail) { return { ok: false, code, detail, raw, cursor, data: [], crc: null }; }
    while (raw.length < target) {
      if (cursor >= bits.length) return fail('format', '报文提前结束。');
      const value = bits[cursor++].value;
      raw.push(value);
      run = value === last ? run + 1 : 1;
      last = value;
      if (raw.length === 19) {
        dlc = bitsNumber(raw.slice(15, 19));
        if (dlc > 8) return fail('format', '本实验只支持 DLC 0～8。');
        target = 19 + dlc * 8 + 15;
      }
      if (run === 5) {
        if (cursor >= bits.length || bits[cursor].value === last) return fail('stuff', `线上第 ${cursor + 1} 位违反位填充规则。`);
        last = bits[cursor++].value;
        run = 1;
      }
    }
    if (raw[0] !== 0 || raw[12] !== 0 || raw[13] !== 0 || raw[14] !== 0) return fail('format', '起始位或标准数据帧格式不正确。');
    const receivedCrc = bitsNumber(raw.slice(-15));
    const calculatedCrc = crc15(raw.slice(0, -15));
    const data = Array.from({ length: dlc }, (_, i) => bitsNumber(raw.slice(19 + i * 8, 27 + i * 8)));
    const formatOffsets = [0, 2, 3, 4, 5, 6, 7, 8, 9];
    if (formatOffsets.some(i => !bits[cursor + i] || bits[cursor + i].value !== 1)) return { ...fail('format', 'CRC 分隔符、ACK 分隔符或 EOF 的格式错误。'), crc: receivedCrc, calculatedCrc };
    if (receivedCrc !== calculatedCrc) return { ...fail('crc', '接收端重新计算的 CRC 与帧内 CRC 不一致，丢弃这帧。'), crc: receivedCrc, calculatedCrc };
    return { ok: true, code: 'valid', detail: '位填充、帧格式和 CRC 检查通过。', raw, cursor, id: bitsNumber(raw.slice(1, 12)), data, crc: receivedCrc, calculatedCrc };
  }
  function buildCan(config = {}) {
    const id = canId(config.id == null ? 0x200 : config.id);
    const data = parseData(config.data == null ? [0xdc, 0x05] : config.data);
    const t = timing(config);
    const receiver = config.receiver || 'normal';
    if (!['normal', 'listen', 'missing'].includes(receiver)) throw new Error('接收节点模式无效。');
    const fault = config.fault || 'none';
    if (!['none', 'bitflip'].includes(fault)) throw new Error('故障类型无效。');
    const filterId = config.filterId == null || config.filterId === '' ? null : canId(config.filterId);
    const delayNs = Number(config.delayNs || 0);
    if (!Number.isFinite(delayNs) || delayNs < 0 || delayNs > 1e8) throw new Error('边沿迟到时间应为 0～100000000 ns。');
    const raw = [];
    function add(field, values) { for (const value of values) raw.push({ value, field }); }
    add('SOF', [0]); add('ID', binary(id, 11)); add('RTR', [0]); add('IDE', [0]); add('r0', [0]);
    add('DLC', binary(data.length, 4));
    data.forEach(byte => add('DATA', binary(byte, 8)));
    const crc = crc15(raw);
    add('CRC', binary(crc, 15));
    const bits = stuffBits(raw);
    const stuffCount = bits.filter(b => b.stuffed).length;
    function tail(field, values) { values.forEach(value => bits.push({ value, field, rawIndex: null, stuffed: false, index: bits.length })); }
    tail('CRC delimiter', [1]); tail('ACK', [1]); tail('ACK delimiter', [1]); tail('EOF', Array(7).fill(1)); tail('IFS', Array(3).fill(1));
    const intendedBits = bits.map(b => ({ ...b }));
    let faultIndex = null;
    if (fault === 'bitflip') {
      faultIndex = bits.findIndex(b => b.field === (data.length ? 'DATA' : 'CRC') && !b.stuffed);
      bits[faultIndex].value ^= 1;
      bits[faultIndex].fault = true;
    }
    const decoded = decodeCan(bits);
    const timingOk = delayNs < t.sampleNs;
    const valid = decoded.ok && timingOk;
    const ack = receiver === 'normal' && valid;
    const ackIndex = bits.findIndex(b => b.field === 'ACK');
    bits[ackIndex].value = ack ? 0 : 1;
    intendedBits[ackIndex].value = receiver === 'normal' ? 0 : 1;
    const filterAccepted = filterId == null || decoded.id === filterId;
    const delivered = receiver !== 'missing' && valid && filterAccepted;
    let outcome;
    if (receiver === 'missing') outcome = { ok: false, code: 'noack', title: 'ACK 错误：没有接收节点', detail: 'ACK 槽保持隐性 1，发送端未得到确认；自动重发取决于控制器配置。' };
    else if (!timingOk) outcome = { ok: false, code: 'timing', title: '采样时序不足（简化模型）', detail: '相对本地位边界的边沿迟到/稳定时间已到达采样点，本实验判为不可可靠读取。它不是电缆单程延迟的直接判据。' };
    else if (!decoded.ok) outcome = { ok: false, code: decoded.code, title: decoded.code === 'crc' ? '接收 CRC 校验失败' : decoded.code === 'stuff' ? '接收位填充检查失败' : '接收帧格式检查失败', detail: decoded.detail };
    else if (receiver === 'listen') outcome = { ok: false, code: 'noack', title: '监听端可解码，发送端未获 ACK', detail: filterAccepted ? '监听端已正确解码，但监听模式不驱动 ACK；发送端认为本次发送失败。' : '监听端校验通过但被过滤，且监听模式不驱动 ACK；发送端认为本次发送失败。' };
    else if (!filterAccepted) outcome = { ok: true, code: 'filtered', title: '总线发送成功，应用未收到', detail: '正常节点对有效帧发送 ACK；验收过滤器只决定是否交给应用，不决定是否 ACK。' };
    else outcome = { ok: true, code: 'success', title: '发送成功，接收应用获得数据', detail: '接收端去填充并通过 CRC、格式检查，驱动 ACK，过滤通过后将数据交给应用。' };
    const logs = [
      `应用提交标准帧 ID 0x${id.toString(16).toUpperCase().padStart(3, '0')}，${data.length} 字节。`,
      `控制器按 SOF、ID、控制字段、数据构造帧，CRC-15 为 0x${crc.toString(16).toUpperCase().padStart(4, '0')}。`,
      `SOF 至 CRC 序列之间插入 ${stuffCount} 个填充位；线上共 ${bits.length - 3} 位，随后有 3 位 IFS。`,
      `收发器用差分状态表示位：显性 0 约 2 V 差分；隐性 1 约 0 V 差分。`,
      `每位 ${t.bitUs.toFixed(3)} μs，本地位起点后 ${(t.sampleNs / 1000).toFixed(3)} μs 采样（${t.samplePercent.toFixed(2)}%）。`
    ];
    if (faultIndex != null) logs.push(`接收端误读实验：把线上第 ${faultIndex + 1} 位翻转，保留后续帧用于检查。`);
    logs.push(receiver === 'missing' ? '没有接收节点参与。' : timingOk ? decoded.detail : '边沿迟到超过简化时序预算。');
    logs.push(ack ? '正常接收节点把 ACK 槽驱动为显性 0。' : 'ACK 槽保持隐性 1，发送端未获得确认。');
    logs.push(outcome.detail);
    return { protocol: 'CAN', id, data, bits, intendedBits, fields: fieldSegments(bits), timing: t, crc,
      crcReceived: decoded.crc, crcCalculated: decoded.calculatedCrc, stuffCount, faultIndex, ack, ackIndex,
      filterAccepted, receiver, delayNs, outcome, rxData: delivered ? decoded.data : [], rxBits: decoded.raw,
      samples: bits.map((b, i) => ({ index: i, timeUs: (i * t.bitNs + t.sampleNs) / 1000, expected: intendedBits[i].value, actual: b.value, field: b.field, ok: timingOk && b.value === intendedBits[i].value })),
      frameBitCount: bits.length - 3, durationUs: bits.length * t.bitUs, logs,
      limits: [
        '经典 CAN、11 位标准数据帧、0～8 字节；不包含 CAN FD/XL 或远程帧。',
        '电压为高速 CAN 典型示意值；没有模拟模拟电路、反射、噪声及收发器电气门限。',
        '边沿迟到指相对接收端本地位边界的稳定时间；固定传播延迟可由 SOF 同步吸收，真实仲裁还需往返传播预算。',
        '位翻转用于接收解码实验；真实节点可能通过位监测更早中止。波形保留名义帧尾，不模拟错误标志、自动重发、错误计数和 Bus Off。',
        '未实现完整振荡器漂移、重同步、SJW 和多节点传播；时序参数范围为实验范围，不代表某款芯片。'
      ] };
  }
  function arbitrate(idA, idB) {
    idA = canId(idA); idB = canId(idB);
    const a = binary(idA, 11), b = binary(idB, 11), steps = [];
    let activeA = true, activeB = true, lossIndex = null, winner = 'tie', loser = null;
    for (let i = 0; i < 11; i++) {
      const txA = activeA ? a[i] : 1, txB = activeB ? b[i] : 1;
      const bus = txA & txB;
      let lost = null;
      if (activeA && txA === 1 && bus === 0) { activeA = false; lost = 'A'; winner = 'B'; loser = 'A'; lossIndex = i; }
      if (activeB && txB === 1 && bus === 0) { activeB = false; lost = 'B'; winner = 'A'; loser = 'B'; lossIndex = i; }
      steps.push({ index: i, a: a[i], b: b[i], txA, txB, bus, activeA, activeB, lost });
    }
    return { idA, idB, winner, loser, lossIndex, steps, detail: winner === 'tie' ? 'ID 相同，ID 字段未决出胜负；相同标准数据帧仲裁字段可以同时通过，数据不同可能导致位错误。' : `${winner} 获胜；${loser} 在 ID 的第 ${lossIndex + 1} 位发 1 却读到 0，退出仲裁并转为接收。此表仅展示 ID 位，省略共同填充位。` };
  }
  function buildUart(config = {}) {
    const data = parseData(config.data == null ? [0x55, 0xa5] : config.data, 32);
    if (!data.length) throw new Error('UART 实验至少输入一个数据字节。');
    const baud = positive(config.baud == null ? 115200 : config.baud, '发送波特率');
    const receiverBaud = positive(config.receiverBaud == null ? baud : config.receiverBaud, '接收波特率');
    if (baud > 1e8 || receiverBaud > 1e8) throw new Error('UART 波特率应不超过 100000000。');
    const parity = config.parity || 'none';
    if (!['none', 'even', 'odd'].includes(parity)) throw new Error('请选择无校验、偶校验或奇校验。');
    const delayNs = Number(config.delayNs || 0);
    if (!Number.isFinite(delayNs) || delayNs < 0) throw new Error('传播延迟应为非负有限数。');
    const bits = [], frames = [];
    const bitUs = 1e6 / baud, rxBitUs = 1e6 / receiverBaud, delayUs = delayNs / 1000;
    data.forEach((byte, byteIndex) => {
      const start = bits.length;
      function push(value, field) { bits.push({ value, field, byteIndex, stuffed: false, rawIndex: bits.length, index: bits.length }); }
      push(0, 'START');
      const values = Array.from({ length: 8 }, (_, i) => (byte >>> i) & 1);
      values.forEach(v => push(v, 'DATA'));
      if (parity !== 'none') push((values.reduce((a, b) => a + b, 0) % 2) ^ (parity === 'odd' ? 1 : 0), 'PARITY');
      push(1, 'STOP');
      frames.push({ byteIndex, byte, start, end: bits.length, startUs: start * bitUs + delayUs });
    });
    const samples = [], rxData = [];
    let observedMismatch = false, framingError = false, parityError = false, sampleOutside = false;
    function lineAt(timeUs) {
      const i = Math.floor((timeUs - delayUs) / bitUs + 1e-10);
      return i >= 0 && i < bits.length ? bits[i].value : 1;
    }
    for (const frame of frames) {
      const values = [];
      for (let j = 0; j < frame.end - frame.start; j++) {
        const timeUs = frame.startUs + (j + 0.5) * rxBitUs;
        const bit = bits[frame.start + j], actual = lineAt(timeUs);
        const inWindow = timeUs >= frame.startUs + j * bitUs && timeUs < frame.startUs + (j + 1) * bitUs;
        samples.push({ index: frame.start + j, timeUs, expected: bit.value, actual, field: bit.field, byteIndex: frame.byteIndex, ok: actual === bit.value, inWindow });
        values.push(actual);
        if (!inWindow) sampleOutside = true;
        if (actual !== bit.value) observedMismatch = true;
      }
      const received = values.slice(1, 9).reduce((n, v, i) => n | (v << i), 0);
      const frameOk = values[0] === 0 && values[values.length - 1] === 1;
      const parityOk = parity === 'none' || ((values.slice(1, 10).reduce((a, b) => a + b, 0) % 2) === (parity === 'odd' ? 1 : 0));
      framingError = framingError || !frameOk;
      parityError = parityError || !parityOk;
      Object.assign(frame, { received, framingOk: frameOk, parityOk, samples: samples.slice(-values.length) });
      if (frameOk && parityOk) rxData.push(received);
    }
    let outcome;
    if (framingError) outcome = { ok: false, code: 'framing', title: 'UART 帧错误', detail: '接收时钟偏差使起始位或停止位采样不符合格式，部分字节无法正确接收。' };
    else if (parityError) outcome = { ok: false, code: 'parity', title: 'UART 奇偶校验失败', detail: '采样后的数据和校验位不满足所选奇偶规则。' };
    else if (observedMismatch) outcome = { ok: false, code: 'corrupted', title: '数据被误读，UART 未必能察觉', detail: '采样值与发送值不同，但起始/停止位与所选校验仍通过；UART 没有 CAN 的 CRC 和 ACK。' };
    else if (sampleOutside) outcome = { ok: true, code: 'margin', title: '此数据碰巧读对，时序裕量不足', detail: '至少一个采样点已偏出对应位区间；相邻位电平相同使本次读值仍一致，不能保证其他数据可靠。' };
    else outcome = { ok: true, code: 'success', title: 'UART 接收完成', detail: '每个字节由起始位重新建立采样时序；按最低有效位优先还原字节，停止位及所选校验通过。' };
    const logs = [
      `应用提交 ${data.length} 字节，格式为 8${parity === 'none' ? 'N' : parity === 'even' ? 'E' : 'O'}1。`,
      '发送器为每个字节加入起始位 0、8 位数据（LSB 优先）、可选校验位及停止位 1。',
      `发送 ${baud} baud，每位 ${bitUs.toFixed(3)} μs；接收 ${receiverBaud} baud。`,
      '接收端从每字节起始下降沿计时，半个位检查起始位，随后每个位中心采样。',
      outcome.detail
    ];
    return { protocol: 'UART', data, baud, receiverBaud, parity, delayNs, bits, intendedBits: bits.map(b => ({ ...b })), fields: fieldSegments(bits),
      timing: { bitrate: baud, bitNs: bitUs * 1000, bitUs, samplePercent: 50, sampleNs: bitUs * 500 }, samples, frames, rxData, outcome,
      durationUs: bits.length * bitUs + delayUs, logs, limits: [
        'UART 使用理想单端逻辑电平示意；不代表 RS-232 或 RS-485 的电气电压。',
        '每个发送字节的起始沿都能被理想接收器重新捕获；严重失配时真实 UART 还可能漏掉起始沿，本模型不模拟该状态机。',
        '采用理想中心单点采样；未模拟过采样、多数表决、抖动或噪声。固定传播延迟整体平移接收时间，不直接产生时钟失配。',
        'UART 本身没有 CRC、仲裁和 ACK；应用层需要自行定义消息边界与可靠性机制。'
      ] };
  }
  return { parseData, timing, suggestTiming, buildCan, buildUart, arbitrate, crc15, stuffBits, decodeCan };
});
