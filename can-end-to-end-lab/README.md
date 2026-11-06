# CAN 全链路实验室

独立离线 GUI。双击 **CAN全链路实验室.html** 即可使用；不需要连接板卡或安装依赖。

从一次 CAN 发送请求开始，观察 **应用 → Linux SocketCAN → 内核驱动 → MM2S DMA → PCIe / FPGA → CAN 控制器 → 收发器 H/L → 对端采样与解析 → ACK → 设备 TX report → S2MM → 驱动轮询 → TxDone / 本地 echo**。

## 使用方法

1. 输入标准 CAN ID、0–8 个十六进制数据字节，选择通道、位速率、场景，点击“生成 / 重置”。
2. 点击“播放”或“下一步”。全局时间轴可以回到任何一个事件；点击架构节点或右侧事件直接跳转。
3. 观察四个独立状态：DMA 数据已取走、总线 ACK、对端应用交付、主机 TxDone。
4. 到 CAN 位流阶段，观察 CAN_H / CAN_L、总线 RXD 和采样点。未播放的位以圆点隐藏，逐步采样后才展开；填充位被删除，ID/DLC/数据随有效位积累而出现。
5. 点“ACK 时刻”，观察发送端释放总线、对端驱动显性 0。此时主机完成报告尚未处理。
6. 点“设备报告”和“TxDone”，观察 S2MM 写/读指针、echo 待完成数、成功与错误计数。
7. 下方十六进制视图可切换 MM2S 请求和 S2MM TX report，点击字段或字节查看偏移、小端解释和标志位。尚未进入相应阶段时，包视图明确标为预览。
8. “导出事件记录”保存完整模型和当前游标到 JSON，便于对照或复盘。

## 七个实验

| 场景 | 观察重点 |
|---|---|
| 正常 | 先提交、再上总线 ACK、再处理主机报告；成功后 echoPending=0、tx_packets=1 |
| 无对端 | ACK 槽为 1，停在本次 ACK 错误；不虚构重试次数或 TxDone |
| 对端只听 | 可采样、去填充与 CRC 检查，但不发送 ACK；不宣称本次发送成功 |
| 对端过滤 | 协议 ACK 仍成立，但对端应用不交付；主机可以正常完成发送 |
| 完成报告缺失 | 总线成功、对端收到，但主机仍有待完成 echo；不能凭 MM2S RD 计成功 |
| 设备发送失败 | 假定设备在驱动总线前拒绝发送，注入 status=0x81；释放 echo、计 tx_errors，不产生成功 echo |
| 发送环满 | 预置背景流量占满8 MiB；本次请求返回 NETDEV_TX_BUSY，不写新数据、不占 echo |

## 与实际工程的对应

当前驱动使用 `tosun_pcie_protocol.c`，通过 delayed work 默认每1 ms轮询 S2MM；不是 IRQ/MSI/NAPI 完成路径。收到成功 TX report 后调用 `can_get_echo_skb`，按同通道 FIFO 完成待发送项。源码位置、快照哈希、包布局和 BAR 表见 [SOURCE_MAP.md](SOURCE_MAP.md)。

本实验只支持经典 CAN 的11位标准数据帧。CAN FD、CAN XL、扩展帧、远程帧、多个同时在途请求与真实板卡控制不在此项目范围内。

**驱动运行在 Linux 内核内；CAN ACK 在帧内产生，早于对端应用处理；TxDone 是设备上报触发的主机处理，不是对端回复帧。** 对端应用交付和本机完成上报是两个独立分支，本动画顺序是可阅读的一种编排，不保证真实系统的两边调度先后。默认 SocketCAN 本地回环可供独立监听 socket（如 candump）读取；发送 socket 读自己的帧取决于 CAN_RAW_RECV_OWN_MSGS 等配置。

没有 FPGA RTL，因此板卡内部模块分工、生成 TX report 的时机和时间戳均标为教学假设。动画没有编造 CPU/PCIe/工作队列的精确耗时。轮询参数是安排下一次工作的间隔，不是端到端延迟保证。电压是典型理想电平，不含噪声、反射、重同步或器件传播细节。

## 源文件和检查

- `wire.js`：来自前一个通信实验室的 CAN 位流计算模块，真实计算 CRC-15 与位填充。
- `flow.js`：独立事件模型、真实私有包布局、逐步解析和状态快照。
- `app.js` / `style.css` / `index.html`：交互、拓扑动画、波形与字节视图。
- `build.cjs`：把资源内嵌为单文件离线 GUI。
- `wire.test.cjs` / `flow.test.cjs`：协议与流程计算检查。
- `ui.test.cjs`：浏览器操作、状态、导出与窄屏布局检查。

Node.js 下执行：

```text
node --test wire.test.cjs flow.test.cjs
node build.cjs
node ui.test.cjs
```

UI 检查需要 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定模块路径、`BROWSER_EXECUTABLE` 指定浏览器。运行程序本身无需 Node.js。

原理参考：[Linux 官方 SocketCAN 文档](https://docs.kernel.org/networking/can.html)。本项目不包含原板卡驱动源码、远程机器登录脚本或任何凭据。
