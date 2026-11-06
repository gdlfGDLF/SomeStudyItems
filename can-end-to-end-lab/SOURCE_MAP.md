# 驱动路径与教学模型的对应关系

核对日期：2026-11-06。核对对象是当前工作区的未提交源码快照，不代表已经加载到某块板卡上的驱动或 FPGA 固件版本。文中驱动文件名用于标识核对时的本地工程；独立分发的实验不包含这些板卡驱动文件。

本实验以正常模式下的经典 CAN 标准数据帧为演示对象。SocketCAN 软件路径、私有包布局、寄存器和完成回收逻辑依据本工作区；CAN 线上行为和 FPGA 内部阶段是教学模型。没有在当前工作区找到 FPGA HDL，不能据此声称模拟了真实 RTL、内部 FIFO 深度或硬件周期延迟。

## 先分清四种“完成”

1. 应用调用 `send()` / `write()` 返回：表示请求交给了发送路径，不保证 CAN 线上已经成功发送。
2. MM2S 消费指针前进：表示 FPGA 消费了主机内存中的私有包，不等于对端已收到 CAN 帧。
3. 总线 ACK：在 CAN 帧 ACK 槽，由正常接收节点驱动显性位；不是 PCIe 消息，也不是对端应用返回的响应帧。
4. TxDone / TX report：本驱动识别的 FPGA→主机完成事件。驱动读到成功报告后才回收待发送 echo、增加发送统计。它不能证明对端应用已经处理业务数据。

“驱动”属于 Linux 内核。正确层次是 **用户应用 → Linux SocketCAN / 网络栈 → 内核设备驱动 → 主机 DMA 内存 / PCIe → FPGA CAN 控制器 → 收发器 → 总线**，而不是驱动先经过一个外置“Linux 内核盒子”。

## 当前实际编译的实现

本地驱动工程的 `Makefile` 第 3–4 行链接 `tosun_pcie_protocol.o`，不链接 `tosun_pcie_protocol_classic.o`。

因此当前活动符号是 `tosun_tsdev_encode_tx`、`tosun_tsdev_decode_header` 和 `tosun_tsdev_decode_rx`。`tosun_pcie_protocol_classic.c` 是未被当前 Makefile 链接的另一个实现；其文件开头“当前不链接 protocol.c”的注释与当前 Makefile 不一致，不应据该注释选择动画路径。

## 发送路径

| 阶段 | 当前源码位置 | 可在实验中展示的状态变化 |
|---|---|---|
| SocketCAN 提交到驱动 | `tosun_pcie_core.c:1302`，`tosun_pcie_netdev_ops` 在 1384 | `ndo_start_xmit = tosun_pcie_can_start_xmit`；校验 skb，restricted 模式拒绝发送 |
| 编码私有包 | `tosun_pcie_protocol.c:67`；经典帧分支 129–145 | `can_frame` 的 ID、通道和数据变成 tsdev 私有包；这里不计算 CAN CRC 或在线位填充 |
| 检查资源 | `tosun_pcie_core.c:1349` | 读取 MM2S consumer，检查环空间和 echo 槽；满时停止队列并返回 `NETDEV_TX_BUSY` |
| 保存待完成帧 | `tosun_pcie_core.c:1360` | `can_put_echo_skb` 保存 skb，等待硬件完成报告 |
| 发布主机发送环 | `tosun_pcie_core.c:1364` | 复制私有包到 MM2S → `dma_wmb()` → producer 增长 → echo 索引提交 → 更新 BAR producer |
| 通知设备 | `tosun_m2044.c:145`；64 位写函数在 30 | 写 BAR0 MM2S_WR；高 32 位先写，低 32 位后写，再回读低位以处理 posted write |
| FPGA 消费并发送 | 当前工作区无 HDL | 仅做“读取私有包、按通道分发、控制器组帧、收发器输出电平”的教学示意 |

MM2S/S2MM 环通过 `dma_alloc_coherent` 分配在主机内存中（`tosun_pcie_core.c:1760`、1766）。DMA 地址由板卡适配层写入 BAR（`tosun_m2044.c:107`）。BAR 用于寄存器和指针，不应把整个 CAN 私有包画成“直接写进 BAR 数据寄存器”。

## 当前 M2044 环与寄存器

依据 `tosun_m2044.h:17` 和 `tosun_pcie.h:30`：4 通道、每个 DMA 环 8 MiB、160 MHz CAN 时钟、16 字节包对齐。每通道分配 32 个 echo 槽，但 `next != echo_get` 的环判空逻辑保留一个空槽，最多 31 个待完成项。

| 寄存器 | BAR0 低 / 高偏移 | 更新者 | 含义 |
|---|---|---|---|
| MM2S_BASE | `0x08 / 0x0C` | 驱动 | 主机发送环 DMA 地址 |
| S2MM_BASE | `0x10 / 0x14` | 驱动 | 主机接收/报告环 DMA 地址 |
| MM2S_WR | `0x18 / 0x1C` | 驱动 | 主机已经发布的发送字节位置 |
| MM2S_RD | `0x20 / 0x24` | FPGA | FPGA 已消费的发送字节位置 |
| S2MM_WR | `0x28 / 0x2C` | FPGA | FPGA 已发布的接收/报告字节位置 |
| S2MM_RD | `0x30 / 0x34` | 驱动 | 主机已消费的接收/报告字节位置 |

这些位置是软件维护的 64 位累计指针，环内访问按 ring size 回绕；动画可以缩小环的显示槽数，但应明确它是示意，不是实际 8 MiB 的逐字节缩放。

## 主机→FPGA 的私有包

布局定义位于 `tosun_pcie_protocol.h:109`、123；填充与构造位于 `tosun_pcie_protocol.c:39`、129。

所有多字节私有协议字段采用小端。16 字节固定头的 `length` 仅计 payload，不包括对齐填充；整包长度是 `16 + ALIGN16(payload_length)`。

| 头内偏移 | 字段 | 本例值 / 语义 |
|---|---|---|
| 0 | const_id | `A5` |
| 1 | cnt | 私有消息计数，示例取 0；不能当作 echo cookie |
| 2–3 | length | `8 + N`，经典帧 N 为 0–8 |
| 4–7 | inv_val | 前四字节分别按位取反，非 CAN CRC |
| 8 | type | 主机发送编码器写 `02` |
| 9–11 | config / server_id | 数据发送编码器清零 |
| 12–13 | fdid | TX 请求为十进制 16，即 `10 00` |
| 14–15 | device_id / fsize | 数据发送编码器清零 |

TX payload 为：`identifier:u32`、`channel:u8`、`ctrl_grp:u8`、`fd_props:u8`、`dlc:u8`，之后是 N 个数据字节。经典标准数据帧 `ctrl_grp=01`，`fd_props=00`。这个 TX 方向位是私有协议标志，与总线上的 ACK 位不同。

示例：ID `0x200`、通道 0、数据 `DC 05`、消息计数 0，共 32 字节：

```text
私有头  A5 00 0A 00 5A FF F5 FF 02 00 00 00 10 00 00 00
负载    00 02 00 00 00 01 00 02 DC 05
对齐    00 00 00 00 00 00
```

对齐字节只服务于 DMA 私有包；不会变成额外 CAN 数据字节。线上 CRC、仲裁、位填充等由 CAN 控制器负责，驱动发送的这个包并不是线上 CAN 比特流。

## FPGA→主机报告与 TxDone

`tosun_tsdev_decode_header`（`tosun_pcie_protocol.c:266`）识别 FDID=12 为 CAN 事件。`tosun_tsdev_decode_rx`（288）解释统一 RX payload；成功 TX 报告、普通 RX 和错误报告共用这个入口。

| RX payload 内偏移 | 字段 | 长度 |
|---|---|---|
| 0 | 硬件时间戳，单位 μs | 8 字节 |
| 8 | CAN identifier | 4 字节 |
| 12 | 硬件通道号 | 1 字节 |
| 13 | DLC | 1 字节 |
| 14 | status_grp | 1 字节 |
| 15 | fd_props | 1 字节 |
| 16 | 可选数据 | 视报告类型而定 |

`status_grp` 的 bit0 是 TX report、bit7 是 error；标准经典 CAN 成功 TxDone 的状态可以表示为 `01`，TX 错误为 `81`。这些位在 `tosun_pcie_protocol.h:86` 定义、`tosun_pcie_protocol.c:345` 解析。最短 TX report 只需 16 字节 payload（整个私有包 32 字节），解析器不会强制要求原数据区；普通 RX `DC 05` 的 payload 是 18 字节，整包 48 字节。

**S2MM 包头的 type 等具体固件填充值不是此驱动编码器生成的。** 驱动的接收校验只检查 `A5`、四个反码、长度和 FDID。实验如果构造一份返回包，其未由源码确定的字段值应标为示意，不能声称是实际固件抓包。

本实现没有对照报告内的 ID 去搜索 echo，也没有把 header cnt 当作回传 cookie。`tosun_pcie_complete_echo`（core:458）按通道 FIFO 消费最老 echo；这依赖同通道 TX 报告按发送顺序返回。驱动的 S2MM 丢失保护（core:520）会清掉未完成 echo，以防后续报告错位。

## 返回主机是轮询，不是中断

当前活动实现没有 IRQ/MSI/NAPI 接收路径。`tosun_pcie_poll_work`（core:986）使用 delayed work，默认间隔 1 ms（`tosun_pcie.h:32`），每轮执行：

```text
读取 S2MM_WR 快照
→ 指针变化时默认等待 100 μs settle
→ dma_rmb()
→ 取完整私有包并校验头
→ decode_rx
→ handle_rx_event
→ dma_wmb()
→ 写回 S2MM_RD
→ 尝试唤醒被停止的 TX 队列
→ 安排下一轮 delayed work
```

对应位置：core:760、785、792、917、968、976、986。100 μs 是驱动的默认 DMA 稳定等待参数，不是 CAN 位时间、固定硬件传输时间或 ACK 延迟。工作队列还受系统调度影响，因此“1 ms 轮询”不是精确固定周期。

成功 TX report 在 core:594 调用 `tosun_pcie_complete_echo`；该函数调用 `can_get_echo_skb`，随后增加 `tx_packets` / `tx_bytes`。错误 TX report 在 core:583 调用 `can_free_echo_skb` 并增加 `tx_errors`，不能把失败帧回送成成功 echo。代码目前对详细 CAN 错误帧有 TODO，不能画成已经完整支持错误帧上报和 Bus Off 状态机。

普通 RX 走 core:603 的格式分支，分配 `alloc_can_skb`、填写 ID / DLC / 数据、设置时间戳，最后通过 `netif_receive_skb`（662）进入 Linux 接收路径。对端的实际驱动未在本工作区提供；若动画展示对端 Linux，则接收路径是以同类 SocketCAN 节点为例。

## SocketCAN echo 的显示约定

本驱动设置 `IFF_ECHO`（core:1590）。SocketCAN 默认开启本地 loopback；同一发送 socket 默认不接收自己的帧，需要 `CAN_RAW_RECV_OWN_MSGS` 才可打开。实验展示“本机监听程序收到 echo”时，可以理解为另一个订阅匹配 ID 的 `candump` 类 socket，不能把它解释为远端再次发送了原始报文。[Linux SocketCAN 文档](https://docs.kernel.org/networking/can.html#raw-socket-option-can-raw-recv-own-msgs)

一致性 DMA 内存仍需正确的内存屏障来保证数据与发布标志的顺序；CPU 虚拟地址与供设备使用的 DMA 地址也不应混为一谈。[Linux DMA API 指南](https://docs.kernel.org/core-api/dma-api-howto.html)

## 源码快照 SHA-256

```text
Makefile
B96BC049BBFF72629D600CBB7AD7B879B9D1575D5BBBA1DF54961F6F84424F3E
tosun_pcie_core.c
753A1A7F4DB122A9F3E2D5DCFFF40B3D47E2DF209272AD6E82605683A9244A44
tosun_pcie_protocol.c
197AE8003ED677740C067E0511CEEE59034C7C5EFC634B4BF121DFA03C9FF56E
tosun_pcie_protocol_classic.c
9912DC861A3350D4079F74BB5CCC6A34B507094E2BEE9C06D0AD7A4DC2E810C1
tosun_pcie_protocol.h
B3FBEC15367B608FFD77134B436FD6A462B4BA58D8D37F00F06EE542967B7A96
tosun_m2044.c
1E230BD8033098BE3B288DA4FBF62CBE01AD0722C89B5DFDB45D4B36EA74ECB9
tosun_m2044.h
DE191B7FFCE40883429594700AA4A5E735669F6944430E223DFC86D85FEC2061
tosun_pcie.h
6D95087BE0556E76687F2E75A9C14F4BD24F2C5AA5C5F97D1AF4EB77423BA438
```
