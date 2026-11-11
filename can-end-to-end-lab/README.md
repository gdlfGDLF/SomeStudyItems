# 总线实验室：CAN / SPI / I²C / UART

独立离线 GUI。双击 **总线实验室.html** 即可使用；不需要连接板卡或安装依赖。原文件 **CAN全链路实验室.html** 保留为同内容的兼容入口。所有源码为可读文本，没有加密或混淆；单文件入口只将资源原样内嵌。

顶部选择协议，修改参数后点击“生成 / 重置”。新加入的 SPI、I²C、UART 用五步展示：**软件提交 → 控制器准备 → 线上传输 → 接收与还原 → 本地完成**。可逐步播放、拖动时间轴、点击波形、跳到首次采样或第一个字节，并导出当前协议的完整事件 JSON。波形中的浅色部分为未来时序预览；位和字节只随回放进度积累。

## 从哪个实验开始

### 新增：位时序放大镜

CAN 页面的帧类型说明下方可以展开“一位里面：时钟 → TQ → SEG1 → 采样 → SEG2”。这是独立的理想单采样实验，不改变帧生成器或板卡详细实验的参数。

1. 默认 160 MHz、实际分频 16、TSEG1=15、TSEG2=4：每位 20 TQ / 2 μs，经过 16 TQ / 1.6 μs 后采样。
2. 点击“走 1 个时钟”，看 16 个原始周期才组成一个 TQ；点击“到下个 TQ 边界”可按格前进。
3. 点击“到下个采样点”，观察 SEG1 结束和 SEG2 开始是同一个瞬间；接收结果仅在此时出现。
4. 继续走过 SEG2，仍是同一个数据位、不会再次采样；到下一位后，重新经历同步段、SEG1、采样、SEG2。
5. 选择“16 TQ / 位”，对比 80% 需要 12.8 TQ，而整数配置 13/16 实际为 81.25%。修改参数会立即重算并复位。

可用 00 / 01 / 10 / 11 对比：即使连续两位电平不变，每个位仍有自己的采样位置，TQ 网格本身不是电平跳变。FD 数据时序预设为 2 Mbit/s，用于对比另一套位时序，未模拟 BRS 位内切换。真实传播延迟、重同步、SJW、FD 延迟补偿和反射不在本放大镜范围内。

位时序依据：[AMD CAN 位时序逻辑](https://docs.amd.com/r/en-US/pg096-can/Bit-Timing-Logic)、[Microchip 位时序说明](https://ww1.microchip.com/downloads/en/Appnotes/00754.pdf)。

### 协议与帧实验

CAN 页面新增 **九种帧格式**：经典标准/扩展的数据帧与远程帧，FD 标准/扩展各含 BRS 开关，以及 CAN XL。可修改参数、点击字段、逐步播放到 ACK / TxDone、导出字段记录。SOF、ID、DATA、CRC 等均标明 bit 和字节换算，填充位另算。

经典 CAN 四种组合计算 CRC-15 与动态填充；FD / XL 当前为字段级教学回放，**未生成 CRC 数值和完整线上编码**。标准经典 CAN 的原板卡详细实验保留在下方；新增格式不代表实际板卡已经支持。具体字段表、DLC 映射和实现范围见 [CAN_FORMATS.md](CAN_FORMATS.md)。

| 协议 | 先观察什么 | 可以改变什么 |
|---|---|---|
| SPI | CS 选择对端；SCLK 每个有效边沿让双方同时采一位；MOSI/MISO 各自拼成字节 | 四种时钟模式、最高/最低位先发、时钟频率、未选中对端 |
| I²C | START → 7 位地址和读写位 → 第 9 位 ACK → 数据 → STOP | 读/写、地址无人确认、对端拉低时钟延长等待 |
| UART | 起始位 0 → 8 位数据（最低位先）→ 可选校验 → 停止位 1 | 收发波特率、无/奇/偶校验；不同时钟造成采样漂移 |
| CAN | 从 Linux 驱动发送到 FPGA，再到总线 ACK 与主机 TxDone | 保留原有七个板卡链路实验，详见下文 |

推荐先玩 SPI：点击“第一次采样”，看 MOSI 和 MISO 同时被读取；再点“拼出一个字节”。接着比较 I²C 第 9 个时钟的确认与 UART 的独立计时。UART 默认数据 `55 A3`、发送 115200 bit/s：把接收设为 100000 可观察帧错误，设为 90000 可观察硬件未必报告错误的静默误码（均为本模型中的示例）。

## 新协议中的几个区别

- **SPI 没有统一 ACK。** 对端预置的回传字节与主机字节同时移出，不代表即时执行主机命令后的结果。未选中场景假设 MISO 有上拉，因此主机采回 FF；这不保证实际未连接线路也为 FF。
- **I²C 的 ACK 按字节发生。** 地址无人确认就停止，不继续发送 payload。读取时由主机确认数据；最后一个字节发 NACK 表示正常结束。SCL/SDA 为开漏模型，1 表示释放并由上拉拉高。数据输入在读模式下代表对端预先准备的内容。
- **UART 本地发送完成没有远端确认。** 停止位传完后本地可完成，但对端可能读错。界面区分模拟器对照发现的数据错误与硬件可报告的帧/校验错误。波形是逻辑电平，不是 RS-232 或 RS-485 电压。
- 新协议均为通用 Linux 协议层/驱动/控制器教学路径，**不声称当前 TOSUN CAN 板卡实现了 SPI、I²C 或 UART**。不虚构这些协议的 PCIe 私有包、DMA 完成报告和具体寄存器。
- 模型使用理想电平，不模拟电压上升时间、布线反射、器件建立/保持时间；I²C 为单控制器、单次读写，没有多主仲裁或组合事务。UART 简化为每字节重新对齐起始边沿，未模拟实际过采样与起始位丢失。其余限制与官方参考资料在界面“想深入”中展开。

## CAN 全链路实验

从一次 CAN 发送请求开始，观察 **应用 → Linux SocketCAN → 内核驱动 → MM2S DMA → PCIe / FPGA → CAN 控制器 → 收发器 H/L → 对端采样与解析 → ACK → 设备 TX report → S2MM → 驱动轮询 → TxDone / 本地 echo**。

### CAN 使用方法

1. 输入标准 CAN ID、0–8 个十六进制数据字节，选择通道、位速率、场景，点击“生成 / 重置”。
2. 点击“播放”或“下一步”。全局时间轴可以回到任何一个事件；点击架构节点或右侧事件直接跳转。
3. 观察四个独立状态：DMA 数据已取走、总线 ACK、对端应用交付、主机 TxDone。
4. 到 CAN 位流阶段，观察 CAN_H / CAN_L、总线 RXD 和采样点。未播放的位以圆点隐藏，逐步采样后才展开；填充位被删除，ID/DLC/数据随有效位积累而出现。
5. 点“ACK 时刻”，观察发送端释放总线、对端驱动显性 0。此时主机完成报告尚未处理。
6. 点“设备报告”和“TxDone”，观察 S2MM 写/读指针、echo 待完成数、成功与错误计数。
7. 下方十六进制视图可切换 MM2S 请求和 S2MM TX report，点击字段或字节查看偏移、小端解释和标志位。尚未进入相应阶段时，包视图明确标为预览。
8. “导出事件记录”保存完整模型和当前游标到 JSON，便于对照或复盘。

### CAN 七个实验

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

板卡详细实验（`flow.js` / `app.js`）仍限定经典 CAN 的 11 位标准数据帧。新增 CAN 家族实验（`can-formats.js` / `can-family-app.js`）覆盖九种格式，支持扩展与远程帧的 CRC-15 / 填充，并提供 FD / XL 字段级回放；其实现范围见上文和 CAN_FORMATS.md。多个同时在途请求与真实板卡控制不在此项目范围内。

**驱动运行在 Linux 内核内；CAN ACK 在帧内产生，早于对端应用处理；TxDone 是设备上报触发的主机处理，不是对端回复帧。** 对端应用交付和本机完成上报是两个独立分支，本动画顺序是可阅读的一种编排，不保证真实系统的两边调度先后。默认 SocketCAN 本地回环可供独立监听 socket（如 candump）读取；发送 socket 读自己的帧取决于 CAN_RAW_RECV_OWN_MSGS 等配置。

没有 FPGA RTL，因此板卡内部模块分工、生成 TX report 的时机和时间戳均标为教学假设。动画没有编造 CPU/PCIe/工作队列的精确耗时。轮询参数是安排下一次工作的间隔，不是端到端延迟保证。电压是典型理想电平，不含噪声、反射、重同步或器件传播细节。

## 源文件和检查

- `wire.js`：来自前一个通信实验室的 CAN 位流计算模块，真实计算 CRC-15 与位填充。
- `flow.js`：独立事件模型、真实私有包布局、逐步解析和状态快照。
- `app.js` / `style.css` / `index.html`：交互、拓扑动画、波形与字节视图。
- `spi.js` / `i2c.js` / `uart.js`：三种新增协议的时序与逐步解码模型。
- `serial-app.js` / `serial.css`：协议切换、通用五步流程、多线波形与解码视图。
- `build.cjs`：把资源内嵌为单文件离线 GUI。
- `can-formats.js`：九种 CAN 帧组合、字段模型、经典 CRC / 填充、参数约束与通用流程。
- `can-family-app.js` / `can-family.css`：帧格式图、字段表、参数、逐字段回放与导出。
- `can-formats.test.cjs` / `can-family-ui.test.cjs`：格式边界和新增界面回归。
- `bit-timing.js` / `bit-timing-app.js` / `bit-timing.css`：原始时钟、TQ、两位分段与唯一采样边界的交互演示。
- `bit-timing.test.cjs` / `bit-timing-ui.test.cjs`：采样前后状态、整数 TQ 限制与位时序界面检查。
- `wire.test.cjs` / `flow.test.cjs`：协议与流程计算检查。
- `ui.test.cjs`：浏览器操作、状态、导出与窄屏布局检查。
- `spi.test.cjs` / `i2c.test.cjs` / `uart.test.cjs`：独立协议语义与时序检查。
- `serial-ui.test.cjs`：协议切换、异常场景、字节解码、播放、导出与移动布局检查。

Node.js 下执行：

```text
node --test wire.test.cjs flow.test.cjs spi.test.cjs i2c.test.cjs uart.test.cjs can-formats.test.cjs bit-timing.test.cjs
node build.cjs
node bit-timing-ui.test.cjs
node can-family-ui.test.cjs
node ui.test.cjs
node serial-ui.test.cjs
```

UI 检查需要 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定模块路径、`BROWSER_EXECUTABLE` 指定浏览器。运行程序本身无需 Node.js。

原理参考：[Linux 官方 SocketCAN 文档](https://docs.kernel.org/networking/can.html)。本项目不包含原板卡驱动源码、远程机器登录脚本或任何凭据。
