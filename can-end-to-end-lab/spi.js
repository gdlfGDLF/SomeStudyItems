(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SpiLab = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function bytes(value, name) {
    let result;
    if (Array.isArray(value)) result = value.slice();
    else if (typeof value === 'string') {
      const clean = value.trim();
      if (!/^(?:[0-9a-fA-F]{2}\s*)+$/.test(clean)) {
        throw new Error(name + '请填写完整的十六进制字节，例如 A5 3C。');
      }
      result = clean.replace(/\s/g, '').match(/../g).map(part => parseInt(part, 16));
    } else throw new Error(name + '必须是十六进制文本或字节数组。');
    if (result.length < 1 || result.length > 8 ||
        result.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new Error(name + '需要 1～8 个字节，每个字节为 0～255 的整数。');
    }
    return result;
  }

  const hex = values => values.map(value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const frozenCopy = values => Object.freeze(values.slice());
  const sources = Object.freeze([
    Object.freeze({title: 'Analog Devices：SPI 四种模式与双向传输', url: 'https://www.analog.com/en/resources/analog-dialogue/articles/introduction-to-spi-interface.html'}),
    Object.freeze({title: 'Linux：SPI 用户接口、完成与无底层 ACK', url: 'https://docs.kernel.org/spi/spidev.html'})
  ]);

  function build(options) {
    if (options === undefined) options = {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('SPI 参数必须是对象。');
    const sent = bytes(options.data === undefined ? 'A5 3C' : options.data, '发送数据');
    const reply = bytes(options.reply === undefined ? '5A C3' : options.reply, '对端预装数据');
    if (reply.length !== sent.length) throw new Error('对端预装数据与发送数据需要相同字节数。');
    const hz = options.hz === undefined ? 1000000 : options.hz;
    const mode = options.mode === undefined ? 0 : options.mode;
    const bitOrder = options.bitOrder === undefined ? 'msb' : options.bitOrder;
    const selected = options.selected === undefined ? true : options.selected;
    if (typeof hz !== 'number' || !Number.isFinite(hz) || hz < 1000 || hz > 10000000) {
      throw new Error('本实验时钟频率支持 1 kHz～10 MHz。');
    }
    if (!Number.isInteger(mode) || mode < 0 || mode > 3) throw new Error('SPI 模式必须是 0、1、2、3。');
    if (bitOrder !== 'msb' && bitOrder !== 'lsb') throw new Error('位顺序必须是 msb 或 lsb。');
    if (typeof selected !== 'boolean') throw new Error('是否选中对端必须是布尔值。');

    const cpol = mode >> 1;
    const cpha = mode & 1;
    const halfPeriodUs = 500000 / hz;
    const bitPosition = index => bitOrder === 'msb' ? 7 - index % 8 : index % 8;
    const bit = (values, index) => (values[Math.floor(index / 8)] >> bitPosition(index)) & 1;
    const config = Object.freeze({hz, mode, bitOrder, selected, cpol, cpha, halfPeriodUs, byteCount: sent.length});
    const levels = {CS: 1, SCLK: cpol, MOSI: 0, MISO: 1};
    const received = [];
    const returned = [];
    const steps = [];
    let txBits = '';
    let rxBits = '';
    let peerByte = 0;
    let hostByte = 0;
    function add(key, stage, title, detail, timeUs, sample, status) {
      steps.push(Object.freeze({
        key, stage, title, detail, timeUs,
        levels: Object.freeze({...levels}), sample: sample ? Object.freeze({...sample}) : null,
        txBits, rxBits, received: frozenCopy(received), returned: frozenCopy(returned),
        status: status || '进行中'
      }));
    }
    function drive(index) {
      levels.MOSI = bit(sent, index);
      levels.MISO = selected ? bit(reply, index) : 1;
    }
    function capture(index, edge, timeUs) {
      const mosi = levels.MOSI;
      const miso = levels.MISO;
      // Build both bytes only from observed levels, never by copying the input buffers.
      txBits += String(mosi);
      rxBits += String(miso);
      if (selected) peerByte |= mosi << bitPosition(index);
      hostByte |= miso << bitPosition(index);
      const byteComplete = index % 8 === 7;
      if (byteComplete) {
        if (selected) received.push(peerByte);
        returned.push(hostByte);
        peerByte = 0;
        hostByte = 0;
      }
      const ordinal = Math.floor(index / 8) + 1;
      const detail = selected
        ? '这一瞬间：对端读取 MOSI=' + mosi + '，控制器同时读取 MISO=' + miso + '。' +
          (byteComplete ? '第 ' + ordinal + ' 个字节已由 8 次采样拼成：对端 ' + hex(received.slice(-1)) + '，本端 ' + hex(returned.slice(-1)) + '。' : '先保存这一位；满 8 位才组成一个字节。')
        : '控制器读取 MISO=1（本实验假设线路有上拉）。CS 始终为 1，对端没有采样 MOSI；这些读数不是有效回复。';
      add('sample-' + index, 'wire', '采样第 ' + ordinal + ' 字节 · 位 ' + bitPosition(index), detail,
        timeUs, {signal: 'MOSI', value: mosi, mosi, miso, returnValue: miso,
          edge, byteIndex: Math.floor(index / 8), bitIndex: bitPosition(index),
          bitOrdinal: index, accepted: selected, byteComplete}, selected ? '双方采样' : '仅本端采样，无有效回复');
    }

    add('app-submit', 'software', '应用交给 Linux 一组字节',
      '发送 ' + hex(sent) + '；申请一次同时发送和接收的 SPI 操作。这里用 spidev 的 SPI_IOC_MESSAGE 作为示例入口。', null);
    add('kernel-dispatch', 'software', '内核把操作交给控制器驱动',
      'SPI 核心安排传输，控制器驱动设置时钟、位顺序和片选。控制器可以在 SoC 或 FPGA 中；本实验不假定具体板卡。', null);
    add('controller-config', 'controller', '控制器准备移位',
      '模式 ' + mode + '：时钟空闲为 ' + cpol + '，每一位在' + (cpha ? '第二' : '第一') +
      '个时钟边沿采样。对端预先装入 ' + hex(reply) + '；这不是根据本次命令即时算出的应答。', null);
    add('idle', 'wire', '开始前：对端未选中',
      'CS=1，SCLK 保持空闲电平。MISO 的空闲读数在这里按上拉为 1 演示，实际由电路决定。', 0);
    levels.CS = selected ? 0 : 1;
    const selectedAt = halfPeriodUs;
    add('select', 'controller', selected ? 'CS 拉低：选择对端' : 'CS 保持高：没有选中对端',
      selected ? '本次所有字节共用一次片选，期间 CS 一直为 0。' : '控制器仍会输出时钟和数据，但对端不参与本次传输。', selectedAt);
    if (!cpha) {
      drive(0);
      add('preload', 'wire', '先放好第一位，再等采样边沿',
        '第一条时钟边沿就要采样，因此 MOSI 与 MISO 要提前稳定。这里留出半个时钟周期作为示例。', selectedAt);
    }
    for (let index = 0; index < sent.length * 8; index++) {
      const leadingAt = (2 + index * 2) * halfPeriodUs;
      const trailingAt = (3 + index * 2) * halfPeriodUs;
      const leadingEdge = cpol ? 'falling' : 'rising';
      const trailingEdge = cpol ? 'rising' : 'falling';
      levels.SCLK = 1 - cpol;
      if (cpha) {
        drive(index);
        add('shift-leading-' + index, 'wire', '先更新这一位的电平',
          '第一个边沿用于移出数据；再等半个周期，到第二个边沿读取稳定的电平。', leadingAt);
      } else capture(index, leadingEdge, leadingAt);
      levels.SCLK = cpol;
      if (cpha) capture(index, trailingEdge, trailingAt);
      else {
        const hasNext = index + 1 < sent.length * 8;
        if (hasNext) drive(index + 1);
        add('shift-trailing-' + index, 'wire', hasNext ? '更新下一位，等待下次采样' : '最后一个时钟回到空闲电平',
          hasNext ? '第二个边沿用于移出下一位；刚才采到的那一位已保存在接收移位寄存器。' : '最后一位已采样完成，保持片选和数据一小段时间。', trailingAt);
      }
    }
    const releasedAt = (sent.length * 16 + 2) * halfPeriodUs;
    levels.CS = 1;
    levels.MISO = 1;
    add('release', 'controller', '时钟停止，结束片选',
      '控制器已经发出全部时钟。片选释放后，对端通常不再驱动 MISO；本实验用上拉电平 1 表示空闲。', releasedAt);
    add('decode', 'receiver', selected ? '两端把采到的位拼成字节' : '只有本端得到线路读数',
      selected ? '对端得到 ' + hex(received) + '，本端得到 ' + hex(returned) + '。两个方向同时交换，双方如何理解字节由设备自己的协议规定。'
        : '对端未收到字节；本端采到 ' + hex(returned) + '，只表示示例电路的上拉读数。', releasedAt,
      null, selected ? '字节已交换' : '没有有效回复');
    add('complete', 'complete', '驱动通知应用：本次操作完成',
      '控制器结束传输后，驱动完成请求，应用得到接收缓冲区。SPI 没有像 CAN 那样的底层 ACK；完成不证明对端存在或执行了命令。', releasedAt,
      null, selected ? '传输完成，无链路 ACK' : '本端完成，无有效回复');

    return Object.freeze({
      protocol: 'SPI', config,
      signals: Object.freeze([
        Object.freeze({key: 'CS', label: 'CS · 选择对端', idle: 1}),
        Object.freeze({key: 'SCLK', label: 'SCLK · 控制器提供时钟', idle: cpol}),
        Object.freeze({key: 'MOSI', label: 'MOSI · 本端发给对端', idle: 0}),
        Object.freeze({key: 'MISO', label: 'MISO · 对端发给本端', idle: 1})
      ]),
      steps: Object.freeze(steps), sent: frozenCopy(sent), expectedReply: frozenCopy(reply),
      outcome: Object.freeze({ok: selected, validReply: selected, title: selected ? '两端字节交换完成' : '本端完成，但没有有效回复',
        detail: selected ? '对端收到 ' + hex(received) + '；本端采回预装的 ' + hex(returned) + '。SPI 本身没有链路 ACK，传输完成不等于对端业务处理成功。'
          : 'CS 未选中对端。采回的 ' + hex(returned) + ' 来自本实验的上拉假设，不能当作设备应答。'}),
      limits: Object.freeze([
        '这是四线、低电平片选、每字节 8 位、单次全双工传输的教学模型，不连接真实硬件。',
        '两端使用相同模式和位顺序。电平切换按理想时序显示；建立时间、保持时间、片选延时和最大频率应按器件手册检查。',
        '这里让片选前后各留半周期。实际驱动和器件可能使用不同延时；显示的时钟是理想目标频率。',
        '预装回传数据与本次命令同时移出。真实设备可能先接收命令，再在后续时钟或下一次传输中返回结果。',
        '未选中时 MISO=1 仅是本实验的上拉假设；真实线路也可能下拉或悬空，不能凭 FF 判断对端存在。',
        'SPI 没有统一的底层 ACK、地址字节、CRC 或重发机制；是否增加这些功能由具体设备协议决定。'
      ]), sources
    });
  }
  return Object.freeze({build});
});
