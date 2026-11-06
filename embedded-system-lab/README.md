# 嵌入式系统实验室

从开机、设备树、驱动，到串口和网口通信的独立学习项目。包含 **离线交互 GUI** 与 **真实 Linux C 示例**，无需现有 CAN 实验室即可使用。

双击 **嵌入式系统实验室.html** 打开界面。不需要安装服务、不访问网络，也不操作板卡。HTML、CSS、JavaScript、C、Python 都是明文源码；单文件程序仅把界面资源原样内嵌，没有加密或混淆。

## 推荐体验顺序

1. **开机与 U-Boot**：点“下一步”，观察 BootROM → SPL → U-Boot → Linux → 驱动 → 用户空间。点“跳到 U-Boot”，输入 `help`、`printenv bootargs`、`printenv bootcmd` 或 `boot`。这是有限命令的本地演示，不是真实终端。
2. **设备树与驱动**：关闭 UART，点“应用配置并重新启动”。Linux 仍可启动，但串口实验会被阻止；网口依然可用。再比较 compatible 写错与内核没有对应驱动的差异。
3. **串口通信**：恢复 UART 配置并启动，发送 `Hello`，点“第一个字节”，观察起始位、最低位先发、采样与解码。分别查看对端收到的字节和本端读到的 echo。
4. **网口通信**：使用默认同子网地址，逐步观察路由、ARP、UDP/IP/Ethernet 封装、驱动、MAC、PHY、对端应用和回传。点击报文字段或字节看每层放了什么。
5. 在 `examples` 目录编译真实 Linux 程序；先跑无需板卡的 PTY 和 UDP 回环测试，再根据自己的硬件配置使用。

修改通信参数后要点“生成 / 重置”；设备树草稿只在“应用配置并重新启动”后生效。顶部快捷按钮跳到**当前启动配置**的结果，不会自动修复已选择的故障。切换页面会暂停播放；通信实验使用启动回放所处的状态。导出按钮保存当前模型、进度与板卡状态到 JSON；设备树页面可下载草稿 DTS。

## 可以实验什么

| 实验 | 正常过程 | 可以制造的故障 |
|---|---|---|
| 启动 | 加载内核与 DTB，交出执行权，挂载根文件系统，启动 init | 找不到 Image、DTB 格式损坏、根文件系统缺失 |
| 设备树 | status 启用、compatible 匹配、驱动可用后初始化设备 | 关闭节点、改错 compatible、未编译驱动；UART 与网口独立配置 |
| UART | UTF-8 → 8N1 → 对端采样 → 对端应用 echo → 本端 read | TX 错接、波特率不同、对端收到但不回复、设备未就绪 |
| Ethernet / UDP | 路由 → ARP → 封装 → MAC/PHY → 对端应用 → 新的回复报文 | 网线断开、ARP 无应答、跨子网无网关、端口无人监听、应用不回复 |

## 三个重要区别

- **U-Boot 与 Linux 是不同软件。** U-Boot 的串口可用，不代表 Linux 的设备树与串口驱动正确。所有启动日志由观察器合成，即使物理串口可能静默，也能看见教学状态。
- **设备树描述硬件，驱动实现操作。** DTS 经真实工具 dtc 编译为 DTB，再由启动程序传给内核；本 GUI 没有调用 dtc。“是否编译驱动”属于内核构建选项，不是 DTS 属性。
- **发送完成、对端接收、业务回复分别发生。** UART 和 UDP 都没有这里所说的内建 ACK。echo 是例程规定的业务：接收方另发送一条包含原数据的消息。没有回复不能直接推出没有收到。

## 模型范围

启动以 ARM64 风格的虚拟板为例，使用 `Image` 与 `booti`，从存储挂载根文件系统。SPL 不是所有平台必需；TF-A、OP-TEE、initramfs、安全启动、模块加载等未展开。设备初始化只检查启用、匹配与驱动是否存在，不模拟真实时钟、中断、复位、引脚与 probe 资源依赖。`linuxRunning` 表示内核已执行，`userspaceReady` 才表示可以运行通信应用；根文件系统缺失时二者会不同。

`study,*` compatible、内存/寄存器地址与设备名都是教学设定，没有配套真实硬件驱动。`examples/study-virtual-board.dts` 和界面下载的 DTS 不能直接用于实体板启动。真实板级开发需使用对应芯片手册、原理图、内核 bindings 和 BSP。

串口只演示逻辑电平 8N1。发送与采样时间根据双方波特率计算，且每字节理想识别起始沿；未模拟噪声、过采样与大失配导致的起始位漏检。反向 echo 用相同编码/采样方法计算，但合并为一段回放。上下两行波形按各自位序展示，第二行在第一方向传输之后发生，不代表同时开始。UART 与 RS-232 / RS-485 的电气接口不同。

网口只演示同一局域网静态 IPv4/UDP，无网关、VLAN、IP 分片、TCP 或可靠重发。每次 ARP 缓存为空。IPv4 与 UDP 校验和真实计算；预览字节不含前导码、SFD、最小以太网帧填充、FCS 或帧间隙。PHY 编码与模拟电压未展开。故障先后和软件等待为教学编排，不是实际 Linux 调度或超时保证。`sendto` 返回并不等于 MAC 已发完，模型另列本地完成时刻。

## 真实 Linux 示例

在 Linux 项目目录执行：

```sh
make -C examples
python3 examples/smoke.py
```

UDP 使用两个终端：

```sh
# 终端一：默认只监听本机，成功回显一次后退出
./examples/udp_echo --server 9000 --once

# 终端二：在服务端超时前执行
./examples/udp_echo --client 127.0.0.1 9000 'Hello Linux'
```

串口真实设备用法及电平、权限、回显程序要求见 [examples/README.md](examples/README.md)。示例使用有限等待与错误返回，支持 Ctrl+C 恢复串口设置。测试用 PTY 代替串口、127.0.0.1 代替远端，不验证实体电气链路或网卡 MAC/PHY。

## 源码与验证

- `boot.js`：启动阶段、设备树生成与驱动条件模型。
- `comms.js`：UART 编码/采样、UDP/IP/Ethernet 报文与校验和、故障路径。
- `app.js`、`index.html`、`style.css`：交互界面、共享板卡状态、波形和报文视图。
- `build.cjs`：生成单文件入口和默认虚拟 DTS。
- `boot.test.cjs`、`comms.test.cjs`：21 项模型语义检查，包含全部 64 组设备树/驱动布尔组合。
- `ui.test.cjs`：实际浏览器操作、启动前置条件、U-Boot 命令、重启生效、字节解码、异常输入、下载与窄屏检查。
- `examples/`：真实 Linux C 程序、编译入口、10 项 PTY/UDP 自动检查与中文阅读练习。

```sh
node --test boot.test.cjs comms.test.cjs
node build.cjs
node ui.test.cjs
```

GUI 运行本身无需 Node.js。浏览器检查需要 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定模块，`BROWSER_EXECUTABLE` 指定浏览器。

已在 Linux 上用 `-Wall -Wextra -Wpedantic -Werror` 编译两个 C 程序并通过 10 项实际 I/O 检查。模型与浏览器检查使用 Node.js / Chrome 完成。

官方参考：[U-Boot booti](https://docs.u-boot.org/en/latest/usage/cmd/booti.html)、[Linux 设备树](https://docs.kernel.org/devicetree/usage-model.html)、[Linux 串口驱动](https://docs.kernel.org/driver-api/serial/driver.html)、[Linux PHY](https://docs.kernel.org/networking/phy.html)、[RFC 768 UDP](https://www.rfc-editor.org/rfc/rfc768.html)、[RFC 826 ARP](https://www.rfc-editor.org/rfc/rfc826.html)。界面“模型范围与官方资料”中有各实验的对应引用。
