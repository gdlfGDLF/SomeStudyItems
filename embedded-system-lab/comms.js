(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmbeddedComms = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const hex = values => values.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function textBytes(value) {
    if (typeof value !== 'string') throw new Error('数据请输入文本。');
    const data = Array.from(new TextEncoder().encode(value));
    if (!data.length || data.length > 32) throw new Error('请输入 1～32 个 UTF-8 字节；一个中文字符通常占 3 字节。');
    return data;
  }
  function number(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + '应为 ' + min + '～' + max + ' 的整数。');
    return value;
  }
  function readyValue(value) {
    if (typeof value !== 'boolean') throw new Error('设备就绪状态必须是布尔值。');
    return value;
  }
  function recorder() {
    const steps = [], logs = [], state = {localDone: false, peerReceived: false, replyReceived: false};
    function add(key, stage, title, detail, body = '', label = '这一层的数据', extra = {}) {
      logs.push('[' + stage + '] ' + title);
      const item = {key, stage, title, detail, logs: logs.slice(), data: {label, body}, state: {...state}, ...extra};
      steps.push(item);
      return item;
    }
    return {steps, state, add};
  }

  const serialSources = [
    {title: 'Linux：串口底层驱动接口', url: 'https://docs.kernel.org/driver-api/serial/driver.html'},
    {title: 'Microchip：UART 异步帧、最低位先发', url: 'https://onlinedocs.microchip.com/oxy/GUID-61202E6F-BC03-4D81-AAB9-269E87F9B49C-en-US-22/GUID-F37FDF72-1D87-438A-A2F1-D70FD2AC07AC.html'}
  ];
  const serialLimits = [
    '教学模型采用逻辑电平串口、8N1、共同参考地。RS-232 / RS-485 另需相应电气接口；这里不模拟其电压。',
    '每个发送字节的起始边沿都被理想识别，再按接收波特率做中心采样。大失配时实际硬件还可能漏检起始位；未模拟过采样、噪声或 FIFO 溢出。',
    '驱动采用通用 TTY / 串口层路径。中断、DMA 与轮询因具体控制器和驱动而不同，动画没有规定其中某一种实现。',
    '对端程序在本次观察窗口结束后回显已通过格式检查的字节。这个 echo 是双方自定义业务，不是 UART 协议的 ACK，也不证明其他业务已经执行。',
    '错接 TX–TX 场景仅示意数据没有到达 RX。真实两个输出相连可能产生电气冲突，不能按此模型接线。',
    '模拟日志由实验观察器产生，不是从实际串口收集的输出。所有时序为理想协议时间。回显从正向收发观察结束计时，不计应用处理与内核调度的耗时。'
  ];

  function uartEncode(data) {
    return data.map(byte => '0' + Array.from({length: 8}, (_, bit) => (byte >> bit) & 1).join('') + '1').join('');
  }
  function uartDecode(data, txBaud, rxBaud) {
    const wire = uartEncode(data), txBitUs = 1e6 / txBaud, rxBitUs = 1e6 / rxBaud;
    const frames = data.map((byte, byteIndex) => {
      const startUs = byteIndex * 10 * txBitUs;
      const samples = Array.from({length: 10}, (_, offset) => {
        const timeUs = startUs + (offset + 0.5) * rxBitUs;
        const wireIndex = Math.floor(timeUs / txBitUs + 1e-10);
        return {timeUs, value: wireIndex >= wire.length ? 1 : Number(wire[wireIndex]),
          expected: Number(wire[byteIndex * 10 + offset]),
          field: offset === 0 ? 'START' : offset === 9 ? 'STOP' : 'DATA', bitIndex: offset - 1};
      });
      const received = samples.slice(1, 9).reduce((value, sample, i) => value | (sample.value << i), 0);
      return {byteIndex, byte, bits: wire.slice(byteIndex * 10, byteIndex * 10 + 10), startUs,
        samples, received, framingOk: samples[0].value === 0 && samples[9].value === 1};
    });
    return {wire, frames, durationUs: data.length * 10 * txBitUs,
      received: frames.filter(frame => frame.framingOk).map(frame => frame.received)};
  }

  function serial(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('串口参数应为对象。');
    const text = options.text === undefined ? 'Hello' : options.text;
    const sent = textBytes(text);
    const baud = number(options.baud === undefined ? 115200 : options.baud, 1200, 2000000, '发送波特率');
    const peerBaud = number(options.peerBaud === undefined ? baud : options.peerBaud, 1200, 2000000, '对端波特率');
    const ready = readyValue(options.ready === undefined ? true : options.ready);
    const scenario = options.scenario === undefined ? 'success' : options.scenario;
    if (!['success', 'crossed-wrong', 'no-reply'].includes(scenario)) throw new Error('未知串口实验场景。');
    const config = {text, baud, peerBaud, ready, scenario, disabledReason: String(options.disabledReason || '设备树或驱动尚未让串口就绪')};
    const r = recorder(), rx = [], received = [], model = uartDecode(sent, baud, peerBaud);
    let visibleBits = '1', replyBits = '', outcome, echoFrames = [], echoStartUs = null;
    const emit = (key, stage, title, detail, body, label, extra = {}) => r.add(key, stage, title, detail, body, label, {
      signals: [{name: scenario === 'crossed-wrong' ? '本机 TX（未接到对端 RX）' : 'TX → 对端 RX', bits: visibleBits}, ...(replyBits ? [{name: '对端 TX → 本机 RX', bits: replyBits}] : [])],
      bytes: {tx: sent.slice(), peer: received.slice(), rx: rx.slice()}, ...extra
    });
    const finish = () => {
      emit('complete', 'complete', outcome.title, outcome.detail, '本地已发完：' + r.state.localDone + '\n对端应用收到完整字节：' + r.state.peerReceived + '\n本端读到业务回显：' + r.state.replyReceived, '分别观察三个结果');
      return freeze({kind: 'serial', config, steps: r.steps, outcome, sent: sent.slice(), received: received.slice(), returned: rx.slice(),
        frames: ready && scenario !== 'crossed-wrong' ? model.frames : [], wireBits: ready ? model.wire : '', echoFrames, echoStartUs,
        limits: serialLimits.slice(), sources: serialSources.map(source => ({...source}))});
    };
    emit('open', 'software', '应用打开串口并准备文字', '示例程序以原始模式打开串口设备，再通过 termios 设置 8N1 和波特率。文字先编码成 UTF-8 字节。',
      '文本：' + text + '\nUTF-8：' + hex(sent) + '\n格式：8N1\n发送 ' + baud + ' baud；对端 ' + peerBaud + ' baud', '应用缓冲区');
    if (!ready) {
      emit('device-unavailable', 'driver', '串口设备还不能使用', config.disabledReason + '。先检查开机和设备树/驱动页面；本次不会产生线上数据。', '未提交发送字节。', '打开设备未完成');
      outcome = {ok: false, code: 'unavailable', title: '串口未就绪，发送没有开始', detail: config.disabledReason};
      return finish();
    }
    emit('write', 'kernel', 'write 把字节交给 TTY 层', '原始模式下不做换行转换。write 返回表示数据被接受进入软件发送路径，还不表示最后一位已离开发送引脚。', hex(sent), 'TTY 中等待发送的字节');
    emit('driver-fill', 'driver', '串口驱动填入发送缓冲区', '驱动把字节交给 UART 控制器。实际可以用中断、DMA 或轮询搬运，本实验不绑定具体硬件。', hex(sent), 'UART 发送缓冲区');
    emit('configure', 'controller', 'UART 给每个字节加上边界', '空闲为 1，起始位为 0，8 个数据位最低位先发，停止位为 1。收发双方各自计时，没有时钟线。',
      model.frames.map(frame => '0x' + hex([frame.byte]) + ' → ' + frame.bits[0] + ' | ' + frame.bits.slice(1, 9) + ' | ' + frame.bits[9]).join('\n'), '8N1 帧预览：起始 | 数据 b0…b7 | 停止');
    const events = [];
    for (let i = 0; i < model.wire.length; i++) events.push({kind: 'wire', at: i * 1e6 / baud, order: 0, index: i});
    if (scenario !== 'crossed-wrong') for (const frame of model.frames) {
      for (const sample of frame.samples) events.push({kind: 'sample', at: sample.timeUs, order: 1, frame, sample});
      events.push({kind: 'decode', at: frame.samples[9].timeUs, order: 2, frame});
    }
    events.push({kind: 'txdone', at: model.durationUs, order: 3});
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    let sampledBits = '';
    for (const event of events) {
      if (event.kind === 'wire') {
        const index = event.index, frameIndex = Math.floor(index / 10), offset = index % 10;
        visibleBits += model.wire[index];
        const field = offset === 0 ? '起始位' : offset === 9 ? '停止位' : '数据位 b' + (offset - 1);
        emit('wire-' + index, 'wire', '第 ' + (frameIndex + 1) + ' 字节 · ' + field + ' = ' + model.wire[index],
          scenario === 'crossed-wrong' ? '本机 TX 仍在输出，但它被错接到对端 TX，数据没有进入对端 RX。' : '本机把这一位保持在线上。对端按自己的时钟，在预定采样点读取电平。',
          'TX 已输出：' + visibleBits + '\n对端已采的数据位：' + (sampledBits || '尚无'), '电平不是一次读完的字符串', {timeUs: event.at});
      } else if (event.kind === 'sample') {
        const sample = event.sample;
        if (sample.field === 'DATA') sampledBits += sample.value;
        emit('sample-' + event.frame.byteIndex + '-' + sample.field + '-' + sample.bitIndex, 'peer', '对端采样：' + (sample.field === 'DATA' ? 'b' + sample.bitIndex : sample.field === 'START' ? '起始位' : '停止位') + ' → ' + sample.value,
          '对端采样时刻由自己的 ' + peerBaud + ' baud 时钟产生。' + (sample.value !== sample.expected ? '观察器发现这一位与发送端不同；硬件是否报错还要看起始/停止位检查。' : ''),
          '累计数据位：' + (sampledBits || '尚无') + '\n已通过格式检查的字节：' + (hex(received) || '尚无'), '从电平累积数据位', {timeUs: event.at, sample: {...sample}});
      } else if (event.kind === 'decode') {
        const frame = event.frame;
        if (frame.framingOk) received.push(frame.received);
        emit('decode-' + frame.byteIndex, 'peer', frame.framingOk ? '对端拼出字节 0x' + hex([frame.received]) : '对端发现字节边界不正确',
          frame.framingOk ? '将 8 次数据采样依次放到 b0…b7；通过起始位和停止位检查后进入接收缓冲区。' : '起始位或停止位不符合 8N1。本实验丢弃这个字节；实际驱动也可能附错误标记交给应用。',
          hex(received) || '没有可交付字节', '对端接收缓冲区', {timeUs: event.at});
      } else {
        r.state.localDone = true;
        emit('txdone', 'controller', '本机 UART 已把最后一个停止位发完', '此时本地发送完成。它没有收到任何 UART 协议 ACK，不能由此断定对端收到，更不能断定对端应用已处理。',
          '本地发送完成；尚未收到业务回显。', '发送完成与收到回复是两件事', {timeUs: event.at});
      }
    }
    if (scenario === 'crossed-wrong') {
      outcome = {ok: false, code: 'wiring', title: '本机发完了，对端没有收到', detail: '本实验模拟 TX–TX 错接。逻辑电平串口应使本机 TX 接对端 RX、对端 TX 接本机 RX，并共地。真实错接可能产生输出冲突。'};
      return finish();
    }
    r.state.peerReceived = received.length === sent.length;
    emit('peer-app', 'peer', '对端驱动把可接收的字节交给程序', '这里观察的是应用收到的字节，尚不是本机收到回复。硬件可能没有检测出某些数据位错误。', hex(received) || '没有有效字节', '对端应用读取的字节');
    if (scenario === 'no-reply' || !received.length) {
      outcome = {ok: false, code: scenario === 'no-reply' ? 'no-reply' : 'framing', title: scenario === 'no-reply' ? '对端没有发送业务回显' : '格式错误，没有有效字节可回显',
        detail: '本机发送已经完成。UART 没有内建确认；本次演示等待窗口内没有收到业务回复。' + (!same(received, sent) ? '观察器还发现接收结果与发送内容不一致。' : '')};
      return finish();
    }
    const echo = uartDecode(received, peerBaud, baud);
    echoStartUs = Math.max(model.durationUs, ...model.frames.map(frame => frame.samples[9].timeUs));
    echoFrames = echo.frames;
    const echoEndUs = echoStartUs + Math.max(echo.durationUs, ...echo.frames.map(frame => frame.samples[9].timeUs));
    replyBits = '1';
    emit('echo-submit', 'return', '对端程序选择回显收到的字节', '双方约定：接收程序把可用字节原样发回来。这个行为来自应用代码，不是 UART 控制器自动 ACK。这里以正向收发观察结束作为回显起点，省略软件处理耗时。', hex(received), '业务 echo 内容', {timeUs: echoStartUs});
    replyBits += echo.wire;
    emit('echo-wire', 'return', '业务回显经过反向 TX → RX', '这一步合并展示整段回显。对端 UART 用自己的波特率组帧，本机 UART 用本机波特率采样。反向链路也可能因波特率失配出错。',
      echo.frames.map(frame => '发出 ' + hex([frame.byte]) + ' → 本机采到 ' + hex([frame.received]) + (frame.framingOk ? '（格式通过）' : '（格式错误）')).join('\n'), '反向串口传输', {timeUs: echoEndUs});
    rx.push(...echo.received);
    r.state.replyReceived = rx.length > 0;
    emit('read', 'software', '本机应用通过 read 取回字节', '串口驱动把反向链路的接收字节交给 TTY，再由应用读取。应用可比较业务内容来决定是否成功。', hex(rx) || '没有有效回复字节', '应用读到的业务回复', {timeUs: echoEndUs});
    const matched = same(received, sent) && same(rx, sent);
    outcome = {ok: matched, code: matched ? 'success' : model.frames.some(frame => !frame.framingOk) || echo.frames.some(frame => !frame.framingOk) ? 'framing' : 'corrupted',
      title: matched ? '本机读到了相同的业务回显' : '发送完成，但收发字节不一致',
      detail: matched ? '本次程序约定的 echo 往返成功。它是应用层回复；UART 本身没有 ACK。' : '观察器比较出收发内容不一致。起始/停止位异常会形成格式错误；仅数据位误读时 UART 硬件可能不报错。'};
    return finish();
  }

  const networkSources = [
    {title: 'RFC 768：UDP 头、校验和与不保证交付', url: 'https://www.rfc-editor.org/rfc/rfc768.html'},
    {title: 'RFC 791：IPv4 头与头部校验和', url: 'https://www.rfc-editor.org/rfc/rfc791.html'},
    {title: 'RFC 826：用 ARP 将 IPv4 地址解析为以太网地址', url: 'https://www.rfc-editor.org/rfc/rfc826.html'},
    {title: 'RFC 792：ICMP 端口不可达', url: 'https://www.rfc-editor.org/rfc/rfc792.html'},
    {title: 'Linux：MAC 与 PHY 的分工', url: 'https://docs.kernel.org/networking/phy.html'}
  ];
  const networkLimits = [
    '模型是单局域网、静态 IPv4、UDP、无网关、无 VLAN、无 IP 分片。发送前 ARP 缓存为空；每次实验重新解析地址。',
    '展示的 Ethernet 字节从目标 MAC 开始，只含 14 字节 Ethernet II 头、IPv4、UDP 与数据；不含前导码、SFD、最小帧补齐、FCS、帧间隙。它不是完整的线缆位流。',
    'IPv4 和 UDP 校验和由本模型计算。UDP 伪首部仅参与计算，不会额外插入 UDP 报文。Ethernet FCS 未计算或展示；PHY 的编码与模拟电压也未展开。',
    '采用通用 Linux socket / 网络栈 / 驱动 / DMA / MAC / PHY 路径，DMA 与完成处理仅示意，不绑定当前 CAN 板卡。真实网络栈可先组 IP 包再排队等待邻居解析。',
    '正常场景中的回复是对端应用定义的 UDP echo。UDP 没有内建 ACK、重发或交付保证；本机发送完成不证明对端应用收到。',
    '端口无人监听场景假定无防火墙过滤，观察到 ICMP Port Unreachable；真实系统可能限速或丢弃 ICMP，应用获得异步错误的方式取决于 socket 配置。',
    '地址无人确认、断线和无回复只展示原因与结果，不把实验播放时间当作操作系统真实超时时间。日志由观察器合成。'
  ];
  const localMac = [2, 0, 0, 0, 0, 16], remoteMac = [2, 0, 0, 0, 0, 32];
  const word = value => [value >> 8 & 255, value & 255];
  const readWord = (data, start) => (data[start] << 8) | data[start + 1];
  function checksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum += (data[i] << 8) | (data[i + 1] || 0);
    while (sum > 65535) sum = (sum & 65535) + (sum >>> 16);
    return (~sum) & 65535;
  }
  function ipv4(value, label) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) throw new Error(label + '请填写标准 IPv4 地址，例如 192.168.1.10。');
    const parts = value.split('.').map(Number);
    if (parts.some(v => v > 255) || parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) throw new Error(label + '请使用普通单播 IPv4 地址。');
    return parts;
  }
  const ipNumber = parts => parts.reduce((value, part) => (value * 256 + part) >>> 0, 0);
  function buildPacket(payload, sourceIp, targetIp, sourcePort, targetPort, sourceMac, targetMac) {
    const udpLength = payload.length + 8, ipLength = udpLength + 20;
    const udp = [...word(sourcePort), ...word(targetPort), ...word(udpLength), 0, 0, ...payload];
    const pseudo = [...sourceIp, ...targetIp, 0, 17, ...word(udpLength)];
    const udpCheck = checksum([...pseudo, ...udp]) || 65535;
    udp.splice(6, 2, ...word(udpCheck));
    const ip = [0x45, 0, ...word(ipLength), 0, 1, 0x40, 0, 64, 17, 0, 0, ...sourceIp, ...targetIp];
    ip.splice(10, 2, ...word(checksum(ip)));
    const ethernet = [...targetMac, ...sourceMac, 0x08, 0x00];
    return {bytes: [...ethernet, ...ip, ...udp], ethernet, ip, udp: udp.slice(0, 8), payload: payload.slice(),
      udpDatagram: udp, pseudoHeader: pseudo, sourceMac: sourceMac.slice(), peerMac: targetMac.slice(),
      fields: [{name: '目标 MAC', start: 0, end: 6, detail: '当前局域网中的接收网卡地址'},
        {name: '源 MAC', start: 6, end: 12, detail: '发出这一以太网帧的网卡地址'},
        {name: 'EtherType', start: 12, end: 14, detail: '0x0800 表示 IPv4'},
        {name: 'IPv4 头', start: 14, end: 34, detail: '20 字节，含源/目的 IP、协议 17 与头校验和'},
        {name: 'UDP 头', start: 34, end: 42, detail: '源/目的端口、UDP 长度与 UDP 校验和'},
        {name: '业务数据', start: 42, end: 42 + payload.length, detail: '应用的 UTF-8 字节'}]};
  }
  function arpPacket(reply, sourceIp, targetIp) {
    const source = reply ? remoteMac : localMac, target = reply ? localMac : [255, 255, 255, 255, 255, 255];
    return [...target, ...source, 0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, reply ? 2 : 1,
      ...source, ...(reply ? targetIp : sourceIp), ...(reply ? localMac : [0, 0, 0, 0, 0, 0]), ...(reply ? sourceIp : targetIp)];
  }
  function packetText(packet) {
    return packet.fields.map(field => field.name + ' [' + field.start + '..' + (field.end - 1) + ']\n' + hex(packet.bytes.slice(field.start, field.end))).join('\n\n');
  }

  function network(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('网口参数应为对象。');
    const text = options.text === undefined ? 'Hello' : options.text, sent = textBytes(text);
    const sourceIp = options.sourceIp === undefined ? '192.168.1.10' : options.sourceIp;
    const peerIp = options.peerIp === undefined ? '192.168.1.20' : options.peerIp;
    const source = ipv4(sourceIp, '本机地址'), peer = ipv4(peerIp, '对端地址');
    const prefix = number(options.prefix === undefined ? 24 : options.prefix, 8, 30, '本实验前缀长度');
    const sourcePort = number(options.sourcePort === undefined ? 40000 : options.sourcePort, 1, 65535, '本机端口');
    const peerPort = number(options.peerPort === undefined ? 9000 : options.peerPort, 1, 65535, '对端端口');
    const ready = readyValue(options.ready === undefined ? true : options.ready);
    const scenario = options.scenario === undefined ? 'success' : options.scenario;
    if (!['success', 'cable', 'arp', 'port', 'no-reply'].includes(scenario)) throw new Error('未知网口实验场景。');
    const sourceNumber = ipNumber(source), peerNumber = ipNumber(peer), hostMask = (2 ** (32 - prefix) - 1) >>> 0;
    if (sourceNumber === peerNumber) throw new Error('本实验的本机和对端 IP 需要不同。');
    for (const address of [sourceNumber, peerNumber]) {
      const host = address & hostMask;
      if (host === 0 || host === hostMask) throw new Error('请填写此子网内可用的主机地址，不能使用网络地址或广播地址。');
    }
    const config = {text, sourceIp, peerIp, prefix, sourcePort, peerPort, ready, scenario,
      disabledReason: String(options.disabledReason || '设备树或驱动尚未让网口就绪')};
    const r = recorder(), rx = [], packet = buildPacket(sent, source, peer, sourcePort, peerPort, localMac, remoteMac);
    const arpRequest = arpPacket(false, source, peer), arpReply = arpPacket(true, source, peer);
    let replyPacket = null, outcome;
    const emit = (key, stage, title, detail, body, label) => r.add(key, stage, title, detail, body, label, {bytes: {tx: sent.slice(), rx: rx.slice()}});
    function finish() {
      emit('complete', 'complete', outcome.title, outcome.detail,
        '本地已发完：' + r.state.localDone + '\n对端应用收到：' + r.state.peerReceived + '\n本端收到业务回显：' + r.state.replyReceived, '这三件事各有自己的时刻');
      return freeze({kind: 'network', config, steps: r.steps, outcome, sent: sent.slice(), returned: rx.slice(), packet, replyPacket, arpRequest, arpReply,
        limits: networkLimits.slice(), sources: networkSources.map(source => ({...source}))});
    }
    emit('socket', 'software', '应用准备一次 UDP 发送', '程序创建 UDP socket 并绑定本地端口，调用 sendto。IP 用来找到主机，端口用来找到那台主机上的应用。',
      sourceIp + ':' + sourcePort + ' → ' + peerIp + ':' + peerPort + '\n文本：' + text + '\nUTF-8：' + hex(sent), '应用消息');
    if (!ready) {
      emit('device-unavailable', 'driver', '网卡尚未注册或系统尚未运行', config.disabledReason + '。先解决开机、设备树和驱动，再设置网口地址。', '本次没有产生网络帧。', '设备未就绪');
      outcome = {ok: false, code: 'unavailable', title: '网口未就绪，发送没有开始', detail: config.disabledReason};
      return finish();
    }
    emit('route', 'kernel', '内核按目的 IP 选择路由', '本实验只配置一个直连子网，没有默认网关。相同子网才直接解析对端 MAC。',
      '本机 ' + sourceIp + '/' + prefix + '\n目的 ' + peerIp + '\n默认网关：未配置', '路由判断');
    if (((sourceNumber & ~hostMask) >>> 0) !== ((peerNumber & ~hostMask) >>> 0)) {
      outcome = {ok: false, code: 'route', title: '目的地址不在直连子网，且没有网关', detail: '路由阶段停止；没有发 ARP 请求，也没有业务数据离开网口。修改地址/前缀，或在真实系统配置正确网关。'};
      return finish();
    }
    emit('carrier', 'driver', scenario === 'cable' ? 'PHY 报告链路未建立' : '驱动确认网口链路已经建立', 'MAC 处理以太网帧；PHY 负责实际物理连接、链路协商和线路信号。两者分工不同。',
      scenario === 'cable' ? 'carrier = 0\n本实验没有可用链路。' : 'carrier = 1\n以太网物理链路已建立。', '链路状态');
    if (scenario === 'cable') {
      outcome = {ok: false, code: 'cable', title: '链路未建立，帧没有到达对端', detail: '本实验在链路检查处停止。真实系统可能先排队，再因邻居解析或超时失败；sendto 返回不代表对端收到。'};
      return finish();
    }
    emit('arp-request', 'wire', 'ARP 广播：这个 IP 的 MAC 是多少', 'ARP 缓存为空。内核发广播询问目的 IP 对应的局域网硬件地址；ARP 本身直接装在以太网帧中，不是 UDP 数据。',
      'Who has ' + peerIp + '? Tell ' + sourceIp + '\n\n' + hex(arpRequest), 'ARP 请求：EtherType 0x0806');
    if (scenario === 'arp') {
      emit('arp-missing', 'kernel', '没有收到 ARP 回答', '不知道目标 MAC 时，本次业务 UDP 数据留在等待邻居解析的路径中。这里不模拟真实重试次数和超时长度。', '邻居未解析；业务 UDP 帧尚未发送。', '地址解析失败');
      outcome = {ok: false, code: 'arp', title: '找不到对端 MAC，业务数据还没发出', detail: '检查对端 IP、链路和设备是否在线。不能仅凭 ARP 无回答判断究竟是哪一项出错。'};
      return finish();
    }
    emit('arp-reply', 'return', '对端回答自己的 MAC 地址', '本机把 IP→MAC 对应关系记入邻居表。这个 ARP 回答只解决寻址，不表示 UDP 应用收到数据。',
      peerIp + ' → 02:00:00:00:00:20\n\n' + hex(arpReply), 'ARP 回答');
    emit('encapsulate', 'kernel', '套上 UDP、IPv4、以太网头', 'UDP 加端口，IPv4 加主机地址，Ethernet 加局域网 MAC。IP 校验和只保护 IP 头；UDP 校验和覆盖伪首部、UDP 头和数据。', packetText(packet), '即将交给网卡的字节（无填充/FCS）');
    emit('driver', 'driver', '网卡驱动提交发送缓冲区', '网络栈把包交给设备驱动；驱动准备发送描述符，让 DMA/MAC 可以取得数据。此时还不能保证线上发送或远端接收。',
      '发送缓冲区 ' + packet.bytes.length + ' 字节\n' + hex(packet.bytes), '示例驱动发送描述符');
    emit('mac', 'controller', 'DMA/MAC 取得包并准备以太网帧', 'MAC 负责帧边界等链路层工作；实际发送还会补齐最小帧并附 FCS。此视图未显示补齐、前导码或 FCS。',
      'Ethernet II + IPv4 + UDP + DATA\n' + hex(packet.bytes), 'MAC 输入字节');
    emit('phy', 'wire', 'PHY 把帧送上物理链路', 'MAC 的数字接口交给 PHY，PHY 进行线路编码和物理信号发送。网线上的波形不是直接显示的 0x45 等十六进制字节。',
      '本机 MAC → PHY → 网线 → 对端 PHY → MAC', '物理传输路径');
    r.state.localDone = true;
    emit('txdone', 'driver', '驱动处理本地发送完成', '网卡报告本地发送完成，驱动回收发送资源。这不依赖 UDP 对端 ACK；UDP 没有这种内建确认。', '本地发送缓冲区可回收；业务回复尚未到达。', '本地完成');
    emit('peer-ethernet', 'peer', '对端 MAC 接收帧并交给驱动', '假定本次线路无错误，MAC 校验和接收通过，再由驱动交给网络栈。EtherType 0x0800 使接收路径进入 IPv4。',
      hex(packet.ethernet) + '\n目的 MAC 匹配；EtherType=0x0800', '去掉 Ethernet 头');
    const actualIp = packet.bytes.slice(14, 34), actualUdp = packet.bytes.slice(34), actualPayload = actualUdp.slice(8, readWord(actualUdp, 4));
    const actualPseudo = [...actualIp.slice(12, 20), 0, actualIp[9], ...word(actualUdp.length)];
    if (checksum(actualIp) !== 0 || checksum([...actualPseudo, ...actualUdp]) !== 0) throw new Error('内部报文校验错误。');
    emit('peer-ip', 'peer', 'IPv4 核对目的地址与头部校验', '接收路径检查 IPv4 头并按 Protocol=17 交给 UDP；UDP 核对长度、校验和，再按目的端口寻找 socket。',
      'IPv4 checksum：通过\nProtocol：17（UDP）\nUDP checksum：通过\n目的端口：' + readWord(actualUdp, 2), '接收端实际解析结果');
    if (scenario === 'port') {
      emit('port-unreachable', 'peer', '目的端口没有应用监听', '数据已经到达对端网络栈，但没有匹配的 UDP 接收 socket。对端应用没有收到这些字节。', 'UDP dst=' + peerPort + '\n无监听 socket', '端口分发失败');
      emit('icmp', 'return', '对端返回 ICMP：端口不可达', '本场景假定 ICMP 未被过滤。ICMP Type=3、Code=3 是网络错误通知，不是 UDP 业务 echo，也不是成功确认。', 'ICMP Type 3 / Code 3\nPort Unreachable\n未展开此错误报文的全部字节。', '错误反馈');
      outcome = {ok: false, code: 'port', title: '数据到达对端，但端口无人接收', detail: '本地已发送；对端没有相应 UDP 应用。本实验观察到 ICMP 端口不可达，实际是否向应用报告及何时报告取决于 socket 与系统配置。'};
      return finish();
    }
    r.state.peerReceived = true;
    emit('peer-app', 'peer', '对端 recvfrom 拿到业务数据', '目的端口对应的应用取到了 UDP payload。各层协议头已经由网络栈处理，不会一起作为普通业务内容交给应用。',
      '源地址 ' + sourceIp + ':' + sourcePort + '\n数据 ' + hex(actualPayload), '对端应用收到的 payload');
    if (scenario === 'no-reply') {
      outcome = {ok: false, code: 'no-reply', title: '对端收到了，但没有业务回复', detail: 'UDP 不会自动回 ACK。对端程序没有执行 echo，本端等待窗口内没有回复；不能把“未回复”直接解释为“未收到”。'};
      return finish();
    }
    replyPacket = buildPacket(actualPayload, peer, source, peerPort, sourcePort, remoteMac, localMac);
    emit('echo', 'return', '对端应用发回一份 UDP echo', '这是对端应用主动调用 sendto 的新报文。源/目的 IP、端口和 MAC 对调；校验和按这份新报文重新计算。', packetText(replyPacket), '业务回复包（无填充/FCS）');
    emit('receive', 'kernel', '本机驱动和网络栈解析回复', '反向帧经过 PHY/MAC、驱动、IPv4、UDP 后，到达本地端口的接收队列。为方便阅读，这里把反向硬件流程合并成一步。',
      peerIp + ':' + peerPort + ' → ' + sourceIp + ':' + sourcePort, '本机 UDP 接收队列');
    rx.push(...replyPacket.bytes.slice(42));
    r.state.replyReceived = true;
    emit('recvfrom', 'software', '本机 recvfrom 读到业务回显', '应用比较回显内容，判断本次约定的往返是否成功。UDP 层本身仍不提供可靠交付保证。', hex(rx), '应用取回的 payload');
    outcome = {ok: same(rx, sent), code: 'success', title: 'UDP 业务回显往返成功', detail: '本地发送完成、对端应用接收、本端收到 echo 是三个独立事件。成功来自本次业务交互，不是 UDP 内建 ACK。'};
    return finish();
  }
  return {serial, network};
});
