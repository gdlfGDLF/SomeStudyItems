#!/usr/bin/env python3
"""Linux 用户态检查：PTY 代替串口，127.0.0.1 代替网线，不需要 root。"""
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parent
SERIAL = str(ROOT / 'serial_echo')
UDP = str(ROOT / 'udp_echo')


class ExamplesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Path(SERIAL).is_file() or not Path(UDP).is_file():
            raise RuntimeError('先运行 make，再运行 python3 smoke.py。')

    def serial_case(self, response='echo', message='Hello\n串口'):
        master, slave = os.openpty()
        before = termios.tcgetattr(slave)
        process = None
        try:
            process = subprocess.Popen([
                SERIAL, '--device', os.ttyname(slave), '--baud', '115200',
                '--text', message, '--timeout-ms', '600'
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            payload = message.encode('utf-8')
            observed = bytearray()
            deadline = time.monotonic() + 3
            while len(observed) < len(payload):
                left = deadline - time.monotonic()
                self.assertGreater(left, 0, 'PTY 没有收到发送数据')
                ready, _, _ = select.select([master], [], [], left)
                self.assertTrue(ready, 'PTY 等待超时')
                observed.extend(os.read(master, 4096))
            self.assertEqual(bytes(observed), payload, 'raw 模式应保留换行和 UTF-8 字节')
            current = termios.tcgetattr(slave)
            self.assertFalse(current[3] & (termios.ICANON | termios.ECHO))
            if response == 'echo':
                os.write(master, payload[:1])
                time.sleep(0.02)
                os.write(master, payload[1:])
            elif response == 'wrong':
                os.write(master, b'X' * len(payload))
            elif response == 'interrupt':
                process.send_signal(signal.SIGINT)
            output, error = process.communicate(timeout=3)
            self.assertEqual(termios.tcgetattr(slave), before, '退出应恢复原有串口配置')
            return process.returncode, output.decode(), error.decode()
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=2)
            os.close(master)
            os.close(slave)

    def test_serial_fragmented_utf8_echo(self):
        code, output, error = self.serial_case()
        self.assertEqual(code, 0, error)
        self.assertIn('Echo matches', output)
        self.assertIn('not a UART ACK', output)

    def test_serial_timeout(self):
        code, _, error = self.serial_case('none')
        self.assertEqual(code, 3, error)
        self.assertIn('Timed out', error)

    def test_serial_wrong_bytes(self):
        code, _, error = self.serial_case('wrong')
        self.assertEqual(code, 4, error)

    def test_serial_sigint_restores_settings(self):
        code, _, _ = self.serial_case('interrupt')
        self.assertEqual(code, 130)

    def test_invalid_options_fail_before_open(self):
        result = subprocess.run([SERIAL, '--device', '/no/such/tty', '--baud',
                                 '12345', '--text', 'Hello'], capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 2)
        result = subprocess.run([UDP, '--client', 'bad-address', '9000', 'Hello'],
                                capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 2)
        result = subprocess.run([UDP, '--server', '65536'], capture_output=True, timeout=2)
        self.assertEqual(result.returncode, 2)

    def start_server(self, once=True):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        command = [UDP, '--server', str(port), '--timeout-ms', '3000']
        if once:
            command.append('--once')
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready, _, _ = select.select([process.stdout], [], [], 2)
            self.assertTrue(ready, 'UDP 服务端没有报告就绪')
            line = process.stdout.readline().decode()
            self.assertIn(f'Listening on 127.0.0.1:{port}', line)
            return process, port
        except BaseException:
            process.kill()
            process.communicate(timeout=2)
            raise

    def test_udp_real_loopback_echo(self):
        server, port = self.start_server()
        try:
            client = subprocess.run([UDP, '--client', '127.0.0.1', str(port), 'Hello 网口'],
                                    capture_output=True, timeout=3)
            self.assertEqual(client.returncode, 0, client.stderr)
            self.assertIn(b'Echo matches', client.stdout)
            output, error = server.communicate(timeout=3)
            self.assertEqual(server.returncode, 0, error)
            self.assertIn(b'UDP itself has no ACK', output)
        finally:
            if server.poll() is None:
                server.kill()
                server.communicate(timeout=2)

    def test_udp_ignores_wrong_source(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer, \
                socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as stranger:
            peer.bind(('127.0.0.1', 0))
            peer.settimeout(2)
            process = subprocess.Popen([UDP, '--client', '127.0.0.1',
                                        str(peer.getsockname()[1]), 'source-check'],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                data, sender = peer.recvfrom(4096)
                stranger.sendto(data, sender)
                time.sleep(0.08)
                self.assertIsNone(process.poll(), '不能接受不同端口发来的 echo')
                peer.sendto(data, sender)
                _, error = process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0, error)
                self.assertIn(b'different endpoint', error)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=2)

    def test_udp_timeout_and_mismatch(self):
        for mode, expected in [('timeout', 3), ('wrong', 4)]:
            with self.subTest(mode=mode), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
                peer.bind(('127.0.0.1', 0))
                peer.settimeout(2)
                process = subprocess.Popen([UDP, '--client', '127.0.0.1',
                                            str(peer.getsockname()[1]), 'test', '--timeout-ms', '250'],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    _, sender = peer.recvfrom(4096)
                    if mode == 'wrong':
                        peer.sendto(b'WRONG', sender)
                    _, error = process.communicate(timeout=3)
                    self.assertEqual(process.returncode, expected, error)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=2)

    def test_udp_oversized_datagram_is_not_truncated_echo(self):
        server, port = self.start_server()
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
                client.settimeout(0.15)
                client.sendto(b'x' * 2048, ('127.0.0.1', port))
                with self.assertRaises(socket.timeout):
                    client.recvfrom(4096)
                client.settimeout(2)
                client.sendto(b'valid', ('127.0.0.1', port))
                response, _ = client.recvfrom(4096)
                self.assertEqual(response, b'valid')
            _, error = server.communicate(timeout=3)
            self.assertEqual(server.returncode, 0, error)
            self.assertIn(b'oversized', error)
        finally:
            if server.poll() is None:
                server.kill()
                server.communicate(timeout=2)

    def test_udp_sigint(self):
        server, _ = self.start_server(once=False)
        server.send_signal(signal.SIGINT)
        server.communicate(timeout=2)
        self.assertEqual(server.returncode, 130)


if __name__ == '__main__':
    unittest.main(verbosity=2)
