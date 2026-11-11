# CAN 帧类型与字段长度

入口：`总线实验室.html` → **CAN / FD / XL**。也可用兼容入口 `CAN全链路实验室.html`。源码、样式和模型均为可读文本，构建过程只合并文件，不加密。

## 先分清位、字节和填充

1 B = 8 bit。SOF 是 **1 位**；11 位 ID 等价于 **1 B + 3 bit**，29 位 ID 等价于 **3 B + 5 bit**。这只是长度换算，不要求把字段补到完整字节。

线上协议字段、线上插入的填充位、主机内存里的结构体，是三种不同的长度。字段表展示去填充后的协议字段；帧间最少 3 位 Intermission 另列，不计入 SOF 到 EOF 的帧长度。

## 本次加入的九种组合

| 类型 | ID | RTR / RRS | DATA | CRC 校验序列 | 速率 |
|---|---:|---|---|---|---|
| 经典标准数据帧 | 11 bit | RTR=0 | 0–8 B | 15 bit | 单速率 |
| 经典标准远程帧 | 11 bit | RTR=1 | **0 B** | 15 bit | 单速率 |
| 经典扩展数据帧 | 29 bit | RTR=0 | 0–8 B | 15 bit | 单速率 |
| 经典扩展远程帧 | 29 bit | RTR=1 | **0 B** | 15 bit | 单速率 |
| FD 标准，BRS=0 | 11 bit | RRS=0 | 0–64 B，见 DLC 映射 | 17 / 21 bit | 单速率 |
| FD 扩展，BRS=0 | 29 bit | RRS=0 | 同上 | 17 / 21 bit | 单速率 |
| FD 标准，BRS=1 | 11 bit | RRS=0 | 同上 | 17 / 21 bit | 分阶段速率 |
| FD 扩展，BRS=1 | 29 bit | RRS=0 | 同上 | 17 / 21 bit | 分阶段速率 |
| XL | Priority ID 11 bit，另有 AF 32 bit | RRS=0 | 1–2048 B | PCRC 13 bit + FCRC 32 bit | ADS / DAS 转换 |

FD 使用 ISO 格式，未加入早期不兼容的 non-ISO FD。FD 和 XL 没有远程帧；BRS 也不是独立协议。FD 不超过 16 B 用 CRC-17，20 B 及以上用 CRC-21。[CiA：CRC 与 ISO / non-ISO 区别](https://www.can-cia.org/can-knowledge/cyclic-redundancy-check-crc-in-can-frames)

## 字段顺序（数字均为 bit）

`N` 是本帧实际 DATA 字节数。远程帧 N=0，DLC 表示期望响应长度；响应必须是另一帧，ACK 不携带响应数据。

### 经典标准

```text
SOF 1 → ID 11 → RTR 1 → IDE 1 → r0 1 → DLC 4
→ DATA 8N → CRC 15 → CRC delimiter 1
→ ACK 1 → ACK delimiter 1 → EOF 7
```

SOF=0，IDE=0；数据帧 RTR=0，远程帧 RTR=1。不含填充的帧长度为 `44 + 8N` bit。

### 经典扩展

```text
SOF 1 → ID-A 11 → SRR 1 → IDE 1 → ID-B 18 → RTR 1
→ r1 1 → r0 1 → DLC 4 → DATA 8N → CRC 15
→ CRC delimiter 1 → ACK 1 → ACK delimiter 1 → EOF 7
```

IDE=1。29 位 ID 拆为高 11 位和低 18 位，中间隔着 SRR / IDE；它不是 29 个字节。不含填充的帧长度为 `64 + 8N` bit。经典格式参考 [CiA：CAN CC](https://www.can-cia.org/can-knowledge/can-cc)。

### ISO CAN FD

```text
标准头：SOF 1 → ID 11 → RRS 1 → IDE 1
扩展头：SOF 1 → ID-A 11 → SRR 1 → IDE 1 → ID-B 18 → RRS 1

公共后段：FDF 1 → res 1 → BRS 1 → ESI 1 → DLC 4 → DATA 8N
→ SBC 3 → SBC parity 1 → CRC 17 或 21
→ CRC delimiter 1 → ACK 1 → ACK delimiter 1 → EOF 7
```

FDF=1、RRS=0。BRS=1 时在 BRS 的采样点切换到数据速率，在 CRC delimiter 的采样点切回；ACK 使用仲裁速率。BRS=0 时全帧单速率。ESI 描述发送节点的错误状态。[CiA：FD 字段与切换](https://www.can-cia.org/can-knowledge/can-fd-the-basic-idea)

| DLC 编码 | 0–8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|
| DATA 字节数 | 同数字节 | 12 | 16 | 20 | 24 | 32 | 48 | 64 |

例如输入 9 个字节时，本实验提示长度不合法，不自动补成 12 B；这样不会把应用补零与协议位填充混在一起。[Bosch：FD 的可变长度与位速率](https://www.bosch-semiconductors.com/products/ip-modules/can-protocols/can-fd/)

标准 FD 的未填充字段总长：CRC-17 时 `53 + 8N` bit，CRC-21 时 `57 + 8N` bit；扩展 FD 分别为 `72 + 8N` 和 `76 + 8N`。此外还要加入动态填充，以及 CRC 区的 6 / 7 个固定填充位。

### CAN XL

```text
SOF 1 → Priority ID 11 → RRS 1 → IDE 1 → FDF 1 → XLF 1
→ resXL 1 → ADS 4 → SDT 8 → SEC 1 → DLC 11 → SBC 3 → PCRC 13
→ VCID 8 → AF 32 → DATA 8N → FCRC 32 → FCP 4
→ DAS 4 → ACK 1 → ACK delimiter 1 → EOF 7
```

这里按 CiA 字段图把 FCP 的 4 位单列、DAS 的 4 位单列；有些资料把 FCP(0) 归入 DAS，物理顺序并未因此改变。未填充字段总长为 `146 + 8N` bit。

Priority ID 参与优先级竞争，AF 用于接收筛选；XL 不是“29 位扩展 CAN 的再扩展”。DLC 为 `N−1`，0 表示 1 B，2047 表示 2048 B。ADS 中 ADH / DH1 的边界切到数据速率，FCP(0) / DAH 的边界切回。模型固定 SEC=0，提供 SDT、VCID、AF 输入。[CiA：XL 字段图与切换边界](https://www.can-cia.org/can-knowledge/can-xl)，[Bosch：XL 总览](https://www.bosch-semiconductors.com/media/ip_modules/pdf_2/can_xl_1/20230717_can_xl_overview.pdf)

## 填充位与 CRC 字段分开统计

- **经典 CAN**：SOF 到 CRC 序列末尾连续计数；五个相同位后插入相反位。插入位置受内容影响，不固定在 ID 的第五位，也不会每到新字段就清零。
- **ISO FD**：动态填充到 DATA 末尾。CRC 区先插入固定填充位，之后每四个内容位再插入一位；SBC 3 位加 parity 1 位是内容字段，不是四个填充位。CRC-17 / CRC-21 对应 6 / 7 个固定填充位。参考 [Vector：FD 填充规则](https://certification.vector.com/mod/page/view.php?id=370)、[Bosch：ISO FD 改进](https://www.bosch-semiconductors.com/media/ip_modules/pdf_2/papers/icc_2015_mutter_1.pdf)。
- **XL**：仲裁阶段动态填充，数据阶段从 ADS 的 DL1 起至 FCRC 按十个内容位固定填充；不使用整帧五连位规则。参考 [iCC 2024：CAN XL 网络验证](https://can-cia.org/fileadmin/cia/documents/proceedings/2024_taleb_walkhoff.pdf)。

## 实现范围

| 功能 | 实现情况 |
|---|---|
| 九种组合的参数校验、字段宽度、顺序、内容与流程回放 | 已实现 |
| 经典标准 / 扩展、数据 / 远程的 CRC-15 与线上填充位 | 已计算；可逐字段检查插入的位 |
| 标准经典 CAN 的板卡 DMA、H/L、电平采样、ACK / TxDone 与异常场景 | 原详细实验保留；与新增回放独立操作 |
| FD / XL 的 CRC 数值、完整线上编码、模拟收发解码校验 | **未实现**；用 null 表示，不伪造位值或线上总时长 |
| FD / XL 正常接收与 TxDone | 字段级正常场景假设，不是执行 CRC 校验得到的结论 |
| 真板卡 FD / XL 驱动支持、FPGA RTL | 不在此 GUI 改动范围，没有改动实际驱动 |

新增流程不冒用标准经典 CAN 的 32 字节私有包布局。设备完成状态可经中断、轮询或 DMA 交付，取决于实际设备；字段回放不编造这些实现。FD / XL 不画成沿用经典 CAN 电压的真实波形。

错误帧、过载帧的基础格式在界面参考区另列；不是九种可选择的消息格式之一，也没有实现错误恢复仿真。

## 检查

```text
node --test can-formats.test.cjs wire.test.cjs flow.test.cjs spi.test.cjs i2c.test.cjs uart.test.cjs
node build.cjs
node can-family-ui.test.cjs
node ui.test.cjs
node serial-ui.test.cjs
```

UI 检查需要 Playwright。覆盖源码入口和离线合并入口、九种类型、XL 2048 B、FD 非法长度、逐字段解码展示、导出、经典详细实验同步和窄屏布局。CRC-15 与旧模型位流交叉检查；FD / XL 的字段宽度检查不等于协议编码一致性认证。
