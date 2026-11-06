# 把动画里的流程换成真实 Linux 调用

这个目录是可编译的 Linux 用户态 C 示例。浏览器实验室只做仿真；这里的程序会调用真实 `termios`、`read/write` 和 `socket/sendto/recvfrom`。先用本机回环和虚拟串口练习，再根据自己的板卡接线与系统配置使用。

## 编译与不接板卡的检查

需要 Linux、C 编译器、make、Python 3。进入本目录：

```sh
make
python3 smoke.py
```

也可以运行 `make check`。测试用 PTY 虚拟串口验证 8N1/raw 配置、分段接收、超时、不同回包和退出恢复；用 `127.0.0.1` 验证 UDP 回显、来源检查、超大包处理和中止。不需要 root 或真实硬件。PTY 不模拟实际波特率、电压或线缆，loopback 不经过实体网卡的 MAC/PHY，因此这些测试不能证明板卡电气链路正确。

默认使用 `cc`，编译选项包含 `-Wall -Wextra -Wpedantic -Werror`。交叉编译时应使用板卡配套工具链，例如 `make CC=aarch64-linux-gnu-gcc`；生成的程序只能在匹配的目标架构及 C 库环境运行。本机 Python 测试应使用本机编译结果。

## 网口：两个终端做 UDP 回显

终端一：

```sh
./udp_echo --server 9000 --once
```

终端二在 30 秒内运行：

```sh
./udp_echo --client 127.0.0.1 9000 'Hello Linux'
```

服务端默认只监听本机 `127.0.0.1`，`--once` 表示回显一次就退出。省略 `--once` 可继续接收，空闲 30 秒退出；按 Ctrl+C 也可退出。可用 `--timeout-ms` 修改等待时间，范围 1–60000 毫秒。

两台机器通信时，把服务端绑定地址替换成该机器实际已配置的网卡 IP：

```sh
./udp_echo --server 9000 --bind 192.168.1.20
./udp_echo --client 192.168.1.20 9000 'Hello board'
```

第二条应在另一台机器执行。两个 IP 只是示例，程序不会替你配置网卡、路由或防火墙。客户端会检查回复的 IP、端口、长度与内容，但这不是身份认证，不能抵御源地址伪造。

观察调用顺序：`socket → sendto → poll → recvfrom`。`sendto` 成功通常只说明数据进入本地网络栈，**UDP 没有内建 ACK**。收到的 echo 是对端这个 C 程序主动回发的新 UDP 数据报。示例不实现重发、消息编号或可靠传输协议。

## 串口：指定设备与参数

```sh
./serial_echo --device /dev/ttyUSB0 --baud 115200 --text 'Hello board' --timeout-ms 2000
```

先确定设备路径和访问权限。对端应运行一个“收到什么字节，就原样回什么字节”的程序；单纯接上设备并不保证它会 echo。为了在没有对端程序时验证本地 USB 转串口，也可以按模块说明在同一适当逻辑电平接口上连接 TX 与 RX 做硬件回环。

两个逻辑电平串口通信时，通常发送端 TX 接对端 RX、发送端 RX 接对端 TX，且共地。确认双方电平匹配，例如 3.3V；逻辑电平 UART 不能直接接到 RS-232 电压接口。不要同时让其他串口终端或登录服务占用同一端口。

本例固定 8 个数据位、无校验、1 个停止位（8N1），关闭软硬件流控，支持 9600/19200/38400/57600/115200/230400 波特率。其他数值直接报错，不会静默替换。文本以命令行实际字节发送，通常是 UTF-8，最多 1024 字节，不会自动添加换行。

`write` 可能只接收部分字节，且成功表示进入发送队列，不是对端确认；程序循环提交并用 `poll` 限制总等待时间。UART 是字节流，这个示例用“回复与请求字节数相同且内容相同”作为应用约定。它不实现消息头、长度字段或 CRC。读取到相同内容的 echo 是应用回复，**不是 UART 硬件 ACK**。

程序开始前清除旧接收数据，正常结束、超时或 Ctrl+C 时恢复之前的串口设置。返回码：0 成功、1 系统错误、2 参数错误、3 超时、4 回包不匹配、130 用户中止。

## 开机与设备树

- [uboot-notes.txt](uboot-notes.txt)：从只读环境检查理解镜像、DTB 和启动参数，再看启动命令示意。
- [device-tree-notes.txt](device-tree-notes.txt)：解释 DTS/DTB、`status`、`compatible` 与驱动绑定。

浏览器中的 `study,*` 节点和地址是虚拟教学配置，没有对应的真实 Linux 硬件驱动；不要拿它覆盖板卡原设备树。真正上板需要板卡原理图、SoC 手册、内核 binding 和厂商 BSP。

## 源文件与参考

- `serial_echo.c`：真实串口设置、提交、等待与接收。
- `udp_echo.c`：真实 UDP 服务端与客户端。
- `common.h`：单调时钟、有限等待、信号处理及输入检查。
- `smoke.py`：无需板卡的语义测试；`Makefile`：编译入口。

参考：[Linux man-pages：termios](https://man7.org/linux/man-pages/man3/termios.3.html)、[Linux man-pages：UDP](https://man7.org/linux/man-pages/man7/udp.7.html)、[U-Boot booti](https://docs.u-boot.org/en/latest/usage/cmd/booti.html)、[Linux 设备树模型](https://docs.kernel.org/devicetree/usage-model.html)。
