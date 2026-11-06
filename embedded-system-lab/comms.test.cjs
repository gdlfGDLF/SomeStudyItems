const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {serial, network} = require('./comms.js');
const key = (run, value) => run.steps.find(step => step.key === value);
const last = run => run.steps.at(-1);
const read16 = (data, offset) => data[offset] * 256 + data[offset + 1];

// Independent one's-complement addition using carry after every word, not the
// model's whole-buffer accumulation. A valid included checksum sums to 0xffff.
function foldedSum(bytes) {
  let sum = 0n;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += BigInt(bytes[i] * 256 + (bytes[i + 1] ?? 0));
    sum = (sum & 65535n) + (sum >> 16n);
  }
  return Number((sum & 65535n) + (sum >> 16n));
}
function verifyPacket(packet, data, source, peer, sourcePort, peerPort) {
  const bytes = packet.bytes;
  assert.equal(bytes.length, 42 + data.length);
  assert.equal(read16(bytes, 12), 0x0800);
  const ip = bytes.slice(14, 34), udp = bytes.slice(34);
  assert.equal(ip[0], 0x45);
  assert.equal(ip[9], 17);
  assert.equal(read16(ip, 2), 28 + data.length);
  assert.deepEqual(ip.slice(12, 16), source);
  assert.deepEqual(ip.slice(16, 20), peer);
  assert.equal(foldedSum(ip), 65535);
  assert.equal(read16(udp, 0), sourcePort);
  assert.equal(read16(udp, 2), peerPort);
  assert.equal(read16(udp, 4), 8 + data.length);
  assert.notEqual(read16(udp, 6), 0);
  assert.deepEqual(udp.slice(8), data);
  const pseudo = [...source, ...peer, 0, 17, Math.floor(udp.length / 256), udp.length % 256];
  assert.equal(foldedSum([...pseudo, ...udp]), 65535);
  const corrupt = [...pseudo, ...udp];
  corrupt[corrupt.length - 1] ^= 1;
  assert.notEqual(foldedSum(corrupt), 65535);
}

test('serial builds actual 8N1 LSB-first frames and samples them into UTF-8 bytes', () => {
  const run = serial({text: 'A中'});
  assert.deepEqual(run.sent, [0x41, 0xe4, 0xb8, 0xad]);
  assert.equal(run.frames[0].bits, '0100000101');
  assert.equal(run.wireBits.length, 40);
  for (const frame of run.frames) {
    const dataBits = frame.samples.filter(sample => sample.field === 'DATA');
    const reconstructed = dataBits.reduce((value, sample, bit) => value + sample.value * 2 ** bit, 0);
    assert.equal(reconstructed, frame.received);
    assert.equal(frame.samples[0].value, 0);
    assert.equal(frame.samples[9].value, 1);
    assert.equal(frame.framingOk, true);
  }
  assert.deepEqual(run.received, run.sent);
  assert.deepEqual(run.returned, run.sent);
  assert.equal(run.outcome.ok, true);
  assert.equal(key(run, 'open').signals[0].bits, '1');
  assert.equal(key(run, 'wire-0').signals[0].bits, '10');
  assert.equal(key(run, 'wire-39').signals[0].bits, '1' + run.wireBits);
});

test('serial separately marks software acceptance, shift completion, application receipt and echo', () => {
  const run = serial({text: 'Hi'});
  assert.equal(key(run, 'write').state.localDone, false);
  assert.equal(key(run, 'txdone').state.localDone, true);
  assert.equal(key(run, 'txdone').state.replyReceived, false);
  assert.equal(key(run, 'peer-app').state.peerReceived, true);
  assert.equal(key(run, 'peer-app').state.replyReceived, false);
  assert.equal(key(run, 'read').state.replyReceived, true);
  assert.deepEqual(key(run, 'peer-app').bytes.peer, [72, 105]);
  assert.deepEqual(key(run, 'peer-app').bytes.rx, []);
  assert.deepEqual(key(run, 'read').bytes.rx, [72, 105]);
  assert.match(key(run, 'echo-submit').detail, /不是.*ACK/);
  assert.match(run.outcome.detail, /UART.*没有 ACK/);
  assert.equal(key(run, 'txdone').timeUs, 20e6 / 115200);
});

test('serial timing uses the receiver clock and remains chronological across drift and TX completion', () => {
  const run = serial({text: 'UU', peerBaud: 90000});
  assert.equal(run.outcome.ok, false);
  assert.notDeepEqual(run.received, run.sent);
  let previous = -1;
  for (const step of run.steps.filter(step => step.timeUs !== undefined)) {
    assert.ok(step.timeUs >= previous);
    previous = step.timeUs;
    if (step.sample) {
      const actualIndex = Math.floor(step.sample.timeUs * 115200 / 1e6 + 1e-10);
      const line = actualIndex >= run.wireBits.length ? 1 : Number(run.wireBits[actualIndex]);
      assert.equal(step.sample.value, line);
    }
  }
  assert.equal(key(run, 'txdone').timeUs, 20e6 / 115200);
  assert.ok(run.steps.some(step => step.sample && step.timeUs > key(run, 'txdone').timeUs));
  assert.ok(run.echoStartUs >= Math.max(...run.frames.flatMap(frame => frame.samples.map(sample => sample.timeUs))));
  const reverseLastSample = Math.max(...run.echoFrames.flatMap(frame => frame.samples.map(sample => sample.timeUs)));
  assert.ok(key(run, 'echo-wire').timeUs >= run.echoStartUs + reverseLastSample);
  assert.ok(key(run, 'echo-wire').timeUs >= run.echoStartUs + run.received.length * 10e6 / 90000);
  assert.match(run.outcome.detail, /硬件可能不报错/);
});

test('serial correctly handles missing hardware, wrong wiring and a peer that does not reply', () => {
  const unavailable = serial({ready: false, disabledReason: 'status disabled'});
  assert.equal(unavailable.outcome.code, 'unavailable');
  assert.equal(unavailable.wireBits, '');
  assert.equal(unavailable.steps.some(step => step.stage === 'wire'), false);
  const wrong = serial({scenario: 'crossed-wrong'});
  assert.deepEqual(last(wrong).state, {localDone: true, peerReceived: false, replyReceived: false});
  assert.equal(wrong.steps.some(step => step.sample), false);
  const noReply = serial({scenario: 'no-reply'});
  assert.deepEqual(last(noReply).state, {localDone: true, peerReceived: true, replyReceived: false});
  assert.deepEqual(noReply.received, noReply.sent);
  assert.deepEqual(noReply.returned, []);
  assert.equal(noReply.steps.some(step => step.key === 'echo-submit'), false);
});

test('network constructs exact Ethernet II, IPv4 and UDP headers, lengths, payload and checksums', () => {
  const run = network();
  assert.deepEqual(run.packet.bytes.slice(0, 14), [2, 0, 0, 0, 0, 32, 2, 0, 0, 0, 0, 16, 8, 0]);
  assert.deepEqual(run.sent, [72, 101, 108, 108, 111]);
  verifyPacket(run.packet, run.sent, [192, 168, 1, 10], [192, 168, 1, 20], 40000, 9000);
  assert.equal(read16(run.packet.ip, 10), 0xb75c);
  assert.equal(read16(run.packet.udp, 6), 0x992a);
  verifyPacket(run.replyPacket, run.sent, [192, 168, 1, 20], [192, 168, 1, 10], 9000, 40000);
  assert.deepEqual(run.replyPacket.bytes.slice(0, 6), run.packet.bytes.slice(6, 12));
  assert.deepEqual(run.returned, run.sent);
  assert.equal(run.outcome.ok, true);
});

test('network checksums cover odd/even lengths and UTF-8 including minimum and maximum payloads', () => {
  for (const text of ['x', 'xy', '中文', '0'.repeat(31), 'F'.repeat(32)]) {
    const run = network({text, sourceIp: '10.0.0.2', peerIp: '10.0.0.3', sourcePort: 65535, peerPort: 1});
    verifyPacket(run.packet, run.sent, [10, 0, 0, 2], [10, 0, 0, 3], 65535, 1);
    verifyPacket(run.replyPacket, run.sent, [10, 0, 0, 3], [10, 0, 0, 2], 1, 65535);
  }
  // This port makes the computed UDP checksum zero; RFC 768 sends 0xffff,
  // because a transmitted 0x0000 would instead mean checksum disabled.
  const zero = network({sourcePort: 13675});
  assert.equal(read16(zero.packet.udp, 6), 65535);
  verifyPacket(zero.packet, zero.sent, [192, 168, 1, 10], [192, 168, 1, 20], 13675, 9000);
});

test('ARP is its own Ethernet protocol with broadcast request and directed reply', () => {
  const run = network(), request = run.arpRequest, reply = run.arpReply;
  assert.equal(request.length, 42);
  assert.deepEqual(request.slice(0, 6), [255, 255, 255, 255, 255, 255]);
  assert.equal(read16(request, 12), 0x0806);
  assert.equal(read16(request, 14), 1);
  assert.equal(read16(request, 16), 0x0800);
  assert.deepEqual(request.slice(18, 20), [6, 4]);
  assert.equal(read16(request, 20), 1);
  assert.deepEqual(request.slice(28, 32), [192, 168, 1, 10]);
  assert.deepEqual(request.slice(32, 38), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(request.slice(38), [192, 168, 1, 20]);
  assert.equal(read16(reply, 20), 2);
  assert.deepEqual(reply.slice(0, 6), [2, 0, 0, 0, 0, 16]);
  assert.deepEqual(reply.slice(28, 32), [192, 168, 1, 20]);
  assert.deepEqual(reply.slice(38), [192, 168, 1, 10]);
  assert.equal(key(run, 'arp-reply').state.replyReceived, false);
});

test('network failures stop at the right layer without fabricating receipt or UDP ACK', () => {
  for (const scenario of ['cable', 'arp']) {
    const run = network({scenario});
    assert.equal(run.outcome.ok, false);
    assert.equal(key(run, 'txdone'), undefined);
    assert.deepEqual(last(run).state, {localDone: false, peerReceived: false, replyReceived: false});
  }
  const unavailable = network({ready: false});
  assert.equal(unavailable.steps.some(step => step.stage === 'wire'), false);
  const route = network({peerIp: '192.168.2.20'});
  assert.equal(route.outcome.code, 'route');
  assert.equal(key(route, 'arp-request'), undefined);
  const port = network({scenario: 'port'});
  assert.deepEqual(last(port).state, {localDone: true, peerReceived: false, replyReceived: false});
  assert.match(key(port, 'icmp').data.body, /Type 3 \/ Code 3/);
  assert.equal(port.replyPacket, null);
  const noReply = network({scenario: 'no-reply'});
  assert.deepEqual(last(noReply).state, {localDone: true, peerReceived: true, replyReceived: false});
  assert.equal(noReply.replyPacket, null);
});

test('network local completion precedes peer application and business reply', () => {
  const run = network();
  assert.equal(key(run, 'driver').state.localDone, false);
  assert.equal(key(run, 'txdone').state.localDone, true);
  assert.equal(key(run, 'txdone').state.peerReceived, false);
  assert.equal(key(run, 'peer-app').state.peerReceived, true);
  assert.equal(key(run, 'peer-app').state.replyReceived, false);
  assert.equal(key(run, 'recvfrom').state.replyReceived, true);
  assert.match(key(run, 'txdone').detail, /没有这种内建确认/);
  assert.match(run.limits.join(' '), /不含前导码/);
});

test('models reject malformed bytes, addresses, rates, state and ports before producing traces', () => {
  for (const builder of [serial, network]) {
    for (const text of ['', '中'.repeat(11), 'a'.repeat(33), null, 42]) assert.throws(() => builder({text}));
    assert.throws(() => builder({ready: 'false'}));
    assert.throws(() => builder({scenario: 'invented'}));
  }
  for (const baud of [0, 1199, 2000001, 1.2, NaN, '115200']) assert.throws(() => serial({baud}));
  for (const sourceIp of ['192.168.1.256', '192.168.01.1', '127.0.0.1', '224.0.0.1', '0.0.0.0', '192.168.1.0', '192.168.1.255']) assert.throws(() => network({sourceIp}));
  for (const sourcePort of [0, -1, 65536, 9.5, NaN]) assert.throws(() => network({sourcePort}));
  for (const prefix of [0, 7, 31, 33, 24.1]) assert.throws(() => network({prefix}));
  assert.throws(() => network({peerIp: '192.168.1.10'}));
});

test('snapshots, packet buffers and configuration are immutable and builds are isolated', () => {
  const config = {text: 'Hi'};
  const s = serial(config), n = network(config);
  config.text = 'Changed';
  assert.equal(s.config.text, 'Hi');
  assert.equal(n.config.text, 'Hi');
  assert.throws(() => s.steps[0].logs.push('future'));
  assert.throws(() => s.steps[0].bytes.rx.push(1));
  assert.equal(s.steps[0].state.localDone, false);
  assert.equal(s.steps[0].signals[0].bits, '1');
  assert.throws(() => n.packet.bytes.push(1));
  assert.throws(() => n.steps[0].bytes.rx.push(1));
  assert.equal(n.steps[0].logs.length, 1);
  assert.equal(n.steps.at(-1).logs.length, n.steps.length);
  assert.deepEqual(network(), network());
});

test('standalone browser UMD exports both models with no external dependencies', () => {
  const sandbox = {window: {}, TextEncoder};
  vm.runInNewContext(fs.readFileSync(require.resolve('./comms.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.EmbeddedComms.serial, 'function');
  assert.equal(typeof sandbox.window.EmbeddedComms.network, 'function');
  assert.equal(sandbox.window.EmbeddedComms.serial().outcome.ok, true);
  assert.equal(sandbox.window.EmbeddedComms.network().outcome.ok, true);
});
