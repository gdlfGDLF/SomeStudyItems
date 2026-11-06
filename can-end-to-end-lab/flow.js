/* A deterministic teaching trace, based on the current host driver contract.
 * No FPGA RTL, interrupt emulation, board access or wall-clock claims. */
(function (root, factory) {
  const wire = typeof module === 'object' && module.exports ? require('./wire.js') : root.ProtocolLab;
  const api = factory(wire);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlowLab = api;
})(typeof window !== 'undefined' ? window : globalThis, function (P) {
  'use strict';
  const RING_SIZE = 8 * 1024 * 1024;
  const SCENARIOS = ['success', 'noack', 'listen', 'filtered', 'lost-report', 'txerror', 'ringfull'];
  const SOURCE = {
    xmit: 'tosun_pcie_core.c:1302 · tosun_pcie_can_start_xmit',
    encode: 'tosun_pcie_protocol.c:67 · tosun_tsdev_encode_tx（标准 CAN 分支）',
    echoPut: 'tosun_pcie_core.c:1360 · can_put_echo_skb',
    publish: 'tosun_pcie_core.c:1364–1369 · ring_copy_to / dma_wmb / write_mm2s_producer',
    poll: 'tosun_pcie_core.c:986 · tosun_pcie_poll_work（delayed_work）',
    rx: 'tosun_pcie_protocol.c:288 · tosun_tsdev_decode_rx',
    dispatch: 'tosun_pcie_core.c:564 · tosun_pcie_handle_rx_event',
    complete: 'tosun_pcie_core.c:458 · tosun_pcie_complete_echo / can_get_echo_skb',
    abort: 'tosun_pcie_core.c:480 · tosun_pcie_abort_echo / can_free_echo_skb',
    consumer: 'tosun_pcie_core.c:950–971 · s2mm_rd / write_s2mm_consumer',
    socket: 'Linux SocketCAN · PF_CAN / CAN_RAW / skb / ndo_start_xmit',
    protocol: '经典 CAN · 标准数据帧 / CRC-15 / 位填充 / ACK',
    model: '教学模型：未提供 FPGA RTL，内部模块与耗时不作实测结论'
  };
  function integer(n, min, max, name) {
    n = Number(n);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}必须是 ${min}～${max} 的整数。`);
    return n;
  }
  function hex(n) { return '0x' + n.toString(16).toUpperCase(); }
  function le(value, width) {
    let n = BigInt(value);
    const bytes = [];
    for (let i = 0; i < width; i++) { bytes.push(Number(n & 255n)); n >>= 8n; }
    return bytes;
  }
  function readLe(bytes, offset, width) {
    let n = 0n;
    for (let i = width - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[offset + i]);
    return Number(n);
  }
  function header(payloadLength, fdid, count = 0, type = 2) {
    const a = [0xa5, count, ...le(payloadLength, 2)];
    return [...a, ...a.map(b => (~b) & 255), type, 0, 0, 0, ...le(fdid, 2), 0, 0];
  }
  function packet(headerBytes, payload) {
    return headerBytes.concat(payload, Array((16 - payload.length % 16) % 16).fill(0));
  }
  function txPacket(id, data, channel = 0) {
    const payload = [...le(id, 4), channel, 1, 0, data.length, ...data];
    return packet(header(payload.length, 16), payload);
  }
  function reportPacket(id, dataLength, channel = 0, error = false, timestampUs = 1000) {
    const payload = [...le(timestampUs, 8), ...le(id, 4), channel, dataLength, error ? 0x81 : 0x01, 0];
    // type=1 and timestamp are illustrative; host decoder does not enforce type.
    return packet(header(payload.length, 12, 0, 1), payload);
  }
  function decodeReport(bytes) {
    if (!Array.isArray(bytes) || bytes.length < 32 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('上报包长度或字节无效。');
    if (bytes[0] !== 0xa5 || [0, 1, 2, 3].some(i => ((~bytes[i]) & 255) !== bytes[4 + i])) throw new Error('业务头或反码校验失败。');
    const payloadLength = readLe(bytes, 2, 2);
    if (readLe(bytes, 12, 2) !== 12 || payloadLength < 16 || bytes.length < 16 + Math.ceil(payloadLength / 16) * 16) throw new Error('FDID 或负载长度不符合 CAN 上报格式。');
    const status = bytes[30];
    return { id: readLe(bytes, 24, 4), channel: bytes[28], dataLength: Math.min(bytes[29], 8), isTxReport: !!(status & 1), isError: !!(status & 0x80), status, timestampUs: readLe(bytes, 16, 8) };
  }
  function field(name, start, end, detail) { return { name, start, end, detail }; }
  function commonFields(length, fdid, report = false) {
    return [
      field('业务头', 0, 16, `0xA5 头；length=${length}（不含补齐），FDID=${fdid}。与 CAN 线上帧不同。`),
      field('标记 / 计数', 0, 2, 'A5 / 示例计数 0；真实驱动逐包递增 cnt。'),
      field('length', 2, 4, '小端 16 位，只记录有效 payload 字节数。'),
      field('反码', 4, 8, '前四个头字节的逐字节按位取反，用于校验业务包头。'),
      field('type', 8, 9, report ? '本实验取 1 仅作示意；驱动接收解析未限定该字段。' : '2：主机编码的发送业务包。'),
      field('FDID', 12, 14, `${fdid}：${report ? 'CAN RX / TX 完成共用上报类型' : 'CAN 发送请求'}，小端。`)
    ];
  }
  function configOf(input) {
    const id = integer(input.id == null ? 0x200 : input.id, 0, 0x7ff, '标准帧 ID');
    const data = P.parseData(input.data == null ? [0xdc, 0x05] : input.data, 8);
    const channel = integer(input.channel == null ? 0 : input.channel, 0, 3, '通道');
    const bitrate = Number(input.bitrate == null ? 500000 : input.bitrate);
    if (![125000, 250000, 500000, 1000000].includes(bitrate)) throw new Error('位速率请选择 125k、250k、500k 或 1M bit/s。');
    const pollMs = integer(input.pollMs == null ? 1 : input.pollMs, 1, 1000, '轮询间隔 ms');
    const scenario = input.scenario || 'success';
    if (!SCENARIOS.includes(scenario)) throw new Error('未知实验场景。');
    return { id, data, channel, bitrate, pollMs, scenario };
  }
  function build(input = {}) {
    const config = configOf(input), { id, data, channel, bitrate, scenario, pollMs } = config;
    const wire = P.buildCan({ id, data, receiver: scenario === 'noack' ? 'missing' : scenario === 'listen' ? 'listen' : 'normal', ...P.suggestTiming(160, bitrate, 80), delayNs: 0 });
    const tx = txPacket(id, data, channel);
    const txFields = commonFields(8 + data.length, 16).concat([
      field('identifier', 16, 20, `${hex(id)}，小端 32 位；线上只发送标准 ID 的 11 位。`),
      field('channel', 20, 21, `硬件通道 ${channel}。`),
      field('ctrl_grp', 21, 22, '0x01：发送方向；本例非扩展、非 RTR。'),
      field('fd_props', 22, 23, '0x00：经典 CAN，无 FD 属性。'),
      field('DLC', 23, 24, `${data.length} 字节。`),
      field('data', 24, 24 + data.length, '应用负载原样复制；不把整个 PCIe 包发送到 CAN 总线。'),
      field('padding', 24 + data.length, 32, '环内按 16 字节补齐；补齐字节不是 CAN 数据。')
    ]);
    const reportFields = commonFields(16, 12, true).concat([
      field('timestamp', 16, 24, '微秒时间戳，64 位小端；本实验取示例值，不是硬件实测。'),
      field('identifier', 24, 28, '上报 ID；驱动使用每通道 FIFO echo 槽匹配，不按 ID 配对。'),
      field('channel', 28, 29, '决定处理哪个硬件通道的 echo 队列。'),
      field('DLC', 29, 30, '本请求的字节数。TX 完成上报可不携带 data 字段。'),
      field('status_grp', 30, 31, 'bit0=TX report；bit7=error。0x01 成功路径，0x81 错误路径。'),
      field('fd_props', 31, 32, '本例为 0，表示经典 CAN。')
    ]);
    let report = null;
    const steps = [];
    let state = { mm2sWr: scenario === 'ringfull' ? RING_SIZE : 0, mm2sRd: 0, s2mmWr: 0, s2mmRd: 0, echoPending: 0, txPackets: 0, txBytes: 0, txErrors: 0, queueStopped: false, ack: null, peerDelivered: false, hostDone: false, parsedBits: '', rxBytes: [], peerCrc: null, decodedId: null, decodedDlc: null, busTimeUs: 0 };
    function add(key, lane, title, detail, source, evidence, patch = {}, bitIndex = null) {
      state = { ...state, ...patch };
      const snapshot = Object.freeze({ ...state, rxBytes: Object.freeze([...state.rxBytes]) });
      steps.push(Object.freeze({ key, lane, title, detail, source, evidence, bitIndex, snapshot }));
    }
    add('app-send', 'app', '应用提交 CAN 报文', `write/send 提交 can_frame：ID=${hex(id)}，数据 ${data.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '（零字节）'}。经典 can_frame 是 16 字节内存对象，不等于线上帧长度。`, SOURCE.socket, 'protocol');
    add('socketcan', 'kernel', 'Linux SocketCAN 接收请求', 'PF_CAN/CAN_RAW 将消息交给 CAN 网络设备发送路径，数据由 skb 承载。驱动本身也运行在 Linux 内核中，并不是先经过驱动再进入内核。', SOURCE.socket, 'protocol');
    add('start-xmit', 'driver', '进入驱动 ndo_start_xmit', `tosun_pcie_can_start_xmit 检查 skb 和通道状态，再调用当前 Makefile 链接的 tosun_tsdev_encode_tx。通道 ${channel}，正常发送模式。`, SOURCE.xmit, 'driver');
    add('encode', 'driver', '把 skb 编成 PCIe 业务包', `16 字节业务头 + ${8 + data.length} 字节有效负载 + ${8 - data.length} 字节补齐，共 ${tx.length} 字节。FDID=16，ctrl_grp=0x01；这里还没有生成 CAN CRC 或位填充。`, SOURCE.encode, 'driver');
    if (scenario === 'ringfull') {
      add('ring-busy', 'mm2s', 'MM2S 容量不足，停止发送队列', '预置背景流量已占满 8 MiB 环。本次请求不写入环、不占 echo 槽；netif_stop_queue 后返回 NETDEV_TX_BUSY，由内核保留 skb 以便重试。此处还没有发生 CAN 发送。', SOURCE.xmit, 'driver', { queueStopped: true });
    } else {
      add('echo-reserve', 'echo', '保存待完成的本地 echo', 'can_put_echo_skb 保存当前 skb。驱动暂时不能增加 tx_packets，也不能把 NETDEV_TX_OK 当成对端已经收到。每通道 echo 环用 FIFO，32 槽布局最多保留 31 个在途请求。', SOURCE.echoPut, 'driver', { echoPending: 1 });
      add('ring-copy', 'mm2s', '写入 DMA 一致性发送环', 'ring_copy_to 把 32 字节业务包复制到 MM2S 内存。数据已写内存，但生产者位置尚未公布给 FPGA。', SOURCE.publish, 'driver');
      add('mm2s-publish', 'mm2s', '公布 MM2S 生产者位置', 'dma_wmb 保证数据写入顺序；mm2s_wr += 32，提交 echo 索引，再更新 BAR0 MM2S_WR（0x18/0x1c）。返回 NETDEV_TX_OK 仅表示请求已被驱动接受。', SOURCE.publish, 'driver', { mm2sWr: tx.length });
      add('fpga-fetch', 'fpga-dma', 'FPGA DMA 取走业务包', 'FPGA 读取主机 DMA 环中的包，并推进 MM2S 消费者位置。这里的“DMA 已取走”与“CAN 已发送完成”是两个事件；echo 仍然在途。具体 DMA 内部实现以固件为准。', SOURCE.model, 'model', { mm2sRd: tx.length });
      add('fpga-unpack', 'fpga-parser', 'FPGA 解析 0xA5 业务包', '示意解析头、FDID、通道、ID 和 DLC，丢弃环对齐填充。0xA5 头与补齐字节不会作为 CAN 数据上总线。', SOURCE.model, 'model');
      add('mac-prepare', 'mac', 'CAN MAC 准备发送帧', `控制器准备 SOF、11 位 ID、控制字段和 ${data.length} 个数据字节，计算 CRC-15 并进行位填充。此帧共有 ${wire.frameBitCount} 个线上位（另有 3 位帧间隔）。`, SOURCE.protocol, 'protocol');
      if (scenario === 'txerror') {
        add('device-reject', 'mac', '注入设备拒绝发送事件', '本场景假定设备在真正驱动总线之前拒绝了发送请求，并明确生成带错误标志的 TX report。它不表示“只要没有 ACK 就一定会上报 0x81”。', SOURCE.model, 'model');
      } else {
        add('transceiver-ready', 'txphy', '发送收发器驱动 CAN_H / CAN_L', 'CAN MAC 输出 TXD。收发器将逻辑 0 转为显性差分电压（典型 H≈3.5 V、L≈1.5 V），将逻辑 1 转为隐性（两线约 2.5 V）。', SOURCE.protocol, 'protocol');
        add('peer-synchronize', 'rxphy', scenario === 'noack' ? '对端未连接' : '对端等待 SOF 下降沿', scenario === 'noack' ? '发送端仍能观察总线，但没有对端接收器可以去填充、校验或发送 ACK。' : '对端收发器比较差分电压并输出 RXD；CAN 控制器利用 SOF 边沿同步，随后在每个位的采样点读取 RXD。', SOURCE.protocol, 'protocol');
        const lastCrcIndex = wire.bits.reduce((last, b, i) => b.field === 'CRC' ? i : last, -1);
        const eofLast = wire.bits.reduce((last, b, i) => b.field === 'EOF' ? i : last, -1);
        const hasPeer = scenario !== 'noack';
        let last = -1, run = 0, raw = [], dataBits = [];
        for (let i = 0; i < wire.bits.length; i++) {
          const b = wire.bits[i], patch = { busTimeUs: (i + wire.timing.samplePercent / 100) * wire.timing.bitUs };
          let removed = false;
          if (hasPeer && i <= lastCrcIndex) {
            if (run === 5) {
              if (b.value === last) throw new Error('内部错误：示意帧位填充无效。');
              last = b.value; run = 1; removed = true;
            } else {
              raw.push(b.value); run = b.value === last ? run + 1 : 1; last = b.value;
              if (b.field === 'DATA') dataBits.push(b.value);
            }
            patch.parsedBits = raw.join('');
            if (raw.length >= 12) patch.decodedId = parseInt(raw.slice(1, 12).join(''), 2);
            if (raw.length >= 19) patch.decodedDlc = parseInt(raw.slice(15, 19).join(''), 2);
            patch.rxBytes = Array.from({ length: Math.floor(dataBits.length / 8) }, (_, j) => parseInt(dataBits.slice(j * 8, j * 8 + 8).join(''), 2));
          }
          let lane = 'bus';
          let detail = `线上第 ${i + 1} 位，${b.field}=${b.value}。${b.value === 0 ? '显性：CAN_H≈3.5 V，CAN_L≈1.5 V，RXD=0。' : '隐性：CAN_H≈CAN_L≈2.5 V，RXD=1。'}${removed ? '对端识别为填充位并删除，不加入有效字段。' : hasPeer && i <= lastCrcIndex ? '对端在采样点读入并逐位组装字段。' : ''}`;
          if (b.field === 'ACK') {
            lane = 'peer-crc'; patch.ack = b.value === 0;
            detail = b.value === 0 ? 'ACK 槽中发送节点 TXD=1，正常接收节点把总线拉成显性 0。发送端在自己的 RXD 上读到 0，获得总线确认；此时主机尚未收到 TxDone。ACK 不依赖应用过滤结果。' : 'ACK 槽保持隐性 1：没有正常接收节点驱动 ACK。发送端检测 ACK 错误。模型在这里停止本次尝试，不虚构固定重试次数、正常 EOF 或必然返回的失败报告。';
          }
          add('wire-' + i, lane, b.field === 'ACK' ? b.value === 0 ? '对端驱动 ACK，发送端读回 0' : 'ACK 槽未被确认' : `${b.field} · 线上位 ${i + 1} = ${b.value}`, detail, SOURCE.protocol, 'protocol', patch, i);
          if (i === lastCrcIndex && hasPeer) {
            const computed = P.crc15(raw.slice(0, -15));
            const received = parseInt(raw.slice(-15).join(''), 2);
            add('peer-crc-check', 'peer-crc', '对端重算 CRC 并比对', `去填充后计算 CRC=${hex(computed)}，帧内 CRC=${hex(received)}。CRC 检查通过不等于整个帧已经结束；后面还要检查界定符和 EOF。${scenario === 'listen' ? '该节点为只听模式，即使校验通过也不驱动 ACK。' : '正常节点准备在 ACK 槽确认。'}`, SOURCE.protocol, 'protocol', { peerCrc: computed === received }, i);
          }
          if (b.field === 'ACK' && b.value === 1) break;
          if (i === eofLast) {
            add('peer-accept-frame', 'peer-parser', '对端确认完整帧并还原报文', `EOF 格式有效，去填充后得到 ID=${hex(state.decodedId)}、DLC=${state.decodedDlc}，数据字节由采样结果还原。现在可以交给对端接收过滤与应用队列。`, SOURCE.protocol, 'protocol');
          }
        }
        if (scenario === 'noack' || scenario === 'listen') {
          add('await-confirmation', 'echo', '主机仍在等待完成上报', `echoPending=1，tx_packets=0。${scenario === 'listen' ? '只听节点可读出候选字段并通过 CRC，但本次发送未获 ACK；不把这次尝试宣称为有效应用交付。' : '没有对端接收和 ACK。'}真实控制器可能重试或随后上报错误，取决于固件与配置；当前源码无法决定这一过程的次数和耗时。`, SOURCE.model, 'model');
        } else {
          add('peer-deliver', 'peer-app', scenario === 'filtered' ? '对端过滤器拒绝交给应用' : '对端应用读取已还原数据', scenario === 'filtered' ? 'CAN 协议层已成功接收并 ACK，但本实验设置的对端应用过滤条件不匹配，所以对端应用不读取这帧。这不撤销已发生的 ACK。' : `对端应用取得 ${state.rxBytes.length} 个字节。应用层解释与 CAN 传输分开，例如前两字节可按小端 uint16 解码。对端读取与主机完成通知是独立路径，此顺序仅为演示编排。`, SOURCE.model, 'model', { peerDelivered: scenario !== 'filtered' });
        }
      }
      if (scenario === 'lost-report') {
        add('report-lost', 'report', '注入完成上报缺失', '总线上已有 ACK，对端已收帧，但设备完成上报未进入主机 S2MM。驱动不能仅凭 MM2S 消费指针增长就完成 echo；因此主机仍显示在途。', SOURCE.model, 'model');
        add('poll-empty', 'poll', '轮询未发现新的 S2MM 上报', `delayed_work 以配置的 ${pollMs} ms 间隔安排检查。当前 S2MM_WR=RD=0，echoPending 仍为 1。实际调度延迟、重试与故障恢复未建模。`, SOURCE.poll, 'driver');
      } else if (!['noack', 'listen'].includes(scenario)) {
        const error = scenario === 'txerror';
        report = reportPacket(id, data.length, channel, error, 1000);
        const event = decodeReport(report);
        add('build-report', 'report', error ? '设备生成错误 TX report' : '设备生成完成 TX report（TxDone）', `示意 32 字节上报：FDID=12，status_grp=${hex(event.status)}。${error ? 'bit0=1、bit7=1，表示发送方向错误事件。' : 'bit0=1、bit7=0，进入主机发送完成路径。'}这是一条 PCIe 内存业务消息，不是 CAN ACK 位。固件生成时机、type 和时间戳取值是模型假设。`, SOURCE.model, 'model');
        add('s2mm-publish', 's2mm', 'DMA 写入 S2MM 并公布生产者', '示意设备先把上报内容写入接收环，再推进 S2MM_WR 32 字节。此时 echo 尚未释放，主机必须读到并处理上报。', SOURCE.model, 'model', { s2mmWr: report.length });
        add('poll-report', 'poll', '驱动工作队列轮询到上报', `tosun_pcie_poll_work 调用 process_s2mm；当前驱动使用 delayed_work（配置间隔 ${pollMs} ms），不是中断或 NAPI。检测到生产者变化后，源码默认另有 100 μs 稳定等待，再 dma_rmb 读取；这些不是本实验的实测耗时。`, SOURCE.poll, 'driver');
        add('decode-report', 'driver', '解析业务头与上报状态', `tosun_tsdev_decode_header 校验 0xA5、反码、长度，FDID=12 交给 decode_rx。解析得到 channel=${event.channel}、ID=${hex(event.id)}、is_tx_report=true、is_error=${event.isError}。TX report 可只带 16 字节固定负载，不强制携带 data。`, SOURCE.rx, 'driver');
        if (error) {
          add('abort-echo', 'echo', '失败完成：释放 echo 并计错误', 'handle_rx_event 先处理 is_error。TX 错误调用 tosun_pcie_abort_echo → can_free_echo_skb，释放最早的 echo 槽并增加 tx_errors。不会生成成功本地 echo，也不会增加 tx_packets。', SOURCE.abort, 'driver', { echoPending: 0, txErrors: 1, hostDone: true });
        } else {
          add('complete-echo', 'echo', '成功完成：消费最早的 echo 槽', 'handle_rx_event 识别 TX report，调用 tosun_pcie_complete_echo → can_get_echo_skb，推进 echo_get，增加 tx_packets 和 tx_bytes。关联依据是该通道的 FIFO 顺序，不是 ID 或请求 cookie。', SOURCE.complete, 'driver', { echoPending: 0, txPackets: 1, txBytes: data.length, hostDone: true });
        }
        add('s2mm-consume', 's2mm', '公布已消费的 S2MM 位置', '驱动处理事件后推进 s2mm_rd，dma_wmb 后写 BAR S2MM_RD（0x30/0x34），通知设备这些上报字节已经消费。随后轮询工作会检查并唤醒已停止的发送队列。', SOURCE.consumer, 'driver', { s2mmRd: report.length });
        if (!error) add('local-echo', 'app', '本地 SocketCAN echo 可供接收', '配置允许本地回环的 CAN socket 可接收本地 echo；发送 socket 是否接收自身帧还取决于 CAN_RAW_RECV_OWN_MSGS 等选项。它来自主机保存的 skb，不是对端新发回的 CAN 报文。', SOURCE.socket, 'protocol');
      }
    }
    return {
      config, wire, txPacket: tx, txFields, reportPacket: report, reportFields, steps,
      ringSize: RING_SIZE, echoCapacity: 31,
      limits: [
        '这是经典 CAN 标准数据帧的教学事件序列，不驱动板卡，不执行内核，不是 FPGA RTL 仿真或逻辑分析仪实测。',
        '当前 Makefile 链接 tosun_pcie_protocol.c，未使用旧 tosun_pcie_protocol_classic.c；展示的主机包布局、echo、统计和轮询路径取自当前源码。',
        '没有 FPGA RTL；内部 DMA、解析器、CAN MAC 分块与 ACK 后产生 TX report 的时序是教学假设。设备上报 type=1、cnt=0、timestamp=1000 μs 为示例。',
        '仅总线各位按位速率计算协议时间；CPU、PCIe、FPGA 和工作队列事件没有人为编造的精确耗时。pollMs 是配置间隔，不是延迟保证。',
        '对端应用交付与主机 TX 完成通知是独立路径；动画为了阅读按顺序展开，不代表两者存在因果或固定先后。',
        'ACK 只是总线上的一个确认位；MM2S 消费、对端应用读取、S2MM TX report 和本地 echo 是不同事件。',
        '无 ACK/只听场景停在本次 ACK 错误处；不展开真实错误标志、自动重发、错误计数、Bus Off 或后续固件报告。',
        '“完成上报缺失”只模拟未到达 S2MM，不模拟 S2MM 覆盖与重新同步丢弃；真实源码在明确丢失边界会清空在途 echo 以防错配。',
        '环容量不足场景用预置背景流量占满 8 MiB 环，本次请求没有入队；其他场景从空环和零统计开始。'
      ]
    };
  }
  return { build, txPacket, reportPacket, decodeReport, SCENARIOS, RING_SIZE };
});
