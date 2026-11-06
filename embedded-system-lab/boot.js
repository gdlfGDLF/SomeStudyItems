(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EmbeddedBoot = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const stages = ['rom', 'spl', 'uboot', 'kernel', 'drivers', 'userspace'];
  const defaults = {
    scenario: 'success', uartEnabled: true, uartDriver: true, uartCompatible: true,
    ethEnabled: true, ethDriver: true, ethCompatible: true
  };
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function configFor(input) {
    if (input == null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) throw Error('启动参数需要使用对象。');
    const config = {...defaults};
    for (const key of Object.keys(defaults)) if (input[key] !== undefined) config[key] = input[key];
    if (!['success', 'kernel-missing', 'dtb-invalid', 'rootfs-missing'].includes(config.scenario)) {
      throw Error('请选择支持的启动场景。');
    }
    for (const key of Object.keys(defaults).filter(key => key !== 'scenario')) {
      if (typeof config[key] !== 'boolean') throw Error(key + ' 必须是布尔值。');
    }
    return config;
  }
  function deviceTree(input) {
    const c = configFor(input);
    return `/dts-v1/;

/* 虚拟教学硬件：study,*、地址与引脚均不对应真实板卡。
 * 此片段只解释硬件描述；不是可在实体板启动的完整设备树。
 * 实际项目必须使用板级 DTS、真实 bindings、时钟/中断/引脚等资源。
 */
/ {
    model = "Study virtual board";
    compatible = "study,virtual-board";
    #address-cells = <2>;
    #size-cells = <2>;

    aliases { serial0 = &uart0; ethernet0 = &eth0; };
    chosen {
        stdout-path = "serial0:115200n8";
        bootargs = "console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait rw";
    };
    memory@80000000 {
        device_type = "memory";
        reg = <0x0 0x80000000 0x0 0x20000000>;
    };

    soc {
        compatible = "simple-bus";
        #address-cells = <2>;
        #size-cells = <2>;
        ranges;

        uart0: serial@10000000 {
            compatible = "${c.uartCompatible ? 'study,uart' : 'study,unknown-uart'}";
            reg = <0x0 0x10000000 0x0 0x1000>;
            status = "${c.uartEnabled ? 'okay' : 'disabled'}";
        };

        eth0: ethernet@10010000 {
            compatible = "${c.ethCompatible ? 'study,ethernet' : 'study,unknown-ethernet'}";
            reg = <0x0 0x10010000 0x0 0x1000>;
            status = "${c.ethEnabled ? 'okay' : 'disabled'}";
        };
    };
};
`;
  }
  function deviceResult(config, kind) {
    const name = kind === 'uart' ? '串口' : '网口';
    if (!config[kind + 'Enabled']) return {ready: false, reason: name + '节点 status="disabled"，本模型不为它创建设备。', code: 'disabled'};
    if (!config[kind + 'Compatible']) return {ready: false, reason: name + ' compatible 与教学驱动的匹配表不符，设备未绑定驱动。', code: 'no-match'};
    if (!config[kind + 'Driver']) return {ready: false, reason: name + '硬件描述存在，但对应驱动未提供；设备树不会生成驱动代码。', code: 'no-driver'};
    return {ready: true, reason: name + '描述启用、compatible 匹配且驱动可用；本模型初始化成功。', code: 'ready'};
  }
  function build(input) {
    const config = configFor(input);
    const steps = [], logs = [];
    const state = {
      bootStage: 'rom', linuxRunning: false, userspaceReady: false, halted: false,
      uartReady: false, ethReady: false,
      uartReason: 'Linux 尚未初始化串口驱动。', ethReason: 'Linux 尚未初始化网口驱动。'
    };
    const dts = deviceTree(config);
    const bootargs = 'console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait rw';
    function add(key, stage, title, detail, message, label, body) {
      if (!stages.includes(stage)) throw Error('Unknown boot stage');
      state.bootStage = stage;
      if (message) logs.push('[观察器 / 模拟] ' + message);
      steps.push({key, stage, title, detail, logs: logs.slice(), state: {...state}, data: {label: label || '这一刻的数据', body: body || ''}});
    }
    function result(ok, title, detail) {
      return freeze({
        kind: 'boot', config, steps, outcome: {ok, title, detail},
        limits: [
          '这是 ARM64 风格虚拟板卡的教学流程；没有执行 BootROM、U-Boot、Linux 或 dtc，也不启动虚拟机。',
          '所有日志均由观察器合成，包含真实串口未必能输出的早期步骤。串口节点禁用或驱动缺失时，真实 Linux 控制台可能静默；界面仍可观察模拟状态。',
          'SPL 和这里的阶段顺序是示例。实际启动可包含 TPL、TF-A、OP-TEE 等，部分平台没有单独 SPL。',
          'study,* compatible、内存与寄存器地址是虚拟教学设定；所生成 DTS 缺少完整平台资源，不是实体板可用的启动配置。',
          '设备初始化只检查 status、compatible 和驱动是否可用；真实 probe 还依赖时钟、中断、复位、引脚、PHY 等，可能延迟或失败。',
          '本例从存储设备加载未压缩 Image，使用 booti 并直接挂载磁盘根文件系统，未展开 initramfs、签名验证、地址重定位与文件系统驱动。',
          '驱动都按内建或已经可用处理，未模拟模块加载。网口就绪只表示控制器驱动注册完成，链路状态和 IP 配置仍需另行确认。',
          '内核已取得执行权与用户空间已启动是两个状态；rootfs 失败时内核可已运行，但通信应用无法启动。'
        ],
        sources: [
          {title: 'U-Boot 官方：booti、Image 与 DTB 参数', url: 'https://docs.u-boot.org/en/latest/usage/cmd/booti.html'},
          {title: 'Linux 官方：设备树的硬件描述与设备创建', url: 'https://docs.kernel.org/devicetree/usage-model.html'},
          {title: 'U-Boot 官方：SPL / TPL 启动阶段', url: 'https://docs.u-boot.org/en/latest/develop/spl.html'}
        ]
      });
    }
    add('power-on', 'rom', '上电：CPU 先执行芯片里的 BootROM',
      'BootROM 是芯片固化的启动代码。它按启动配置寻找下一段程序；此时 Linux 还没有运行，通常也不能假定串口已能打印。',
      '上电复位 → BootROM（本行来自观察器，不是实际串口输出）', '此时在哪里执行',
      '芯片内部 ROM → 读取启动介质 → 将下一阶段载入片内 SRAM');
    add('rom-load', 'rom', 'BootROM 找到并装入第一段可变程序',
      '本例假设芯片从存储器加载 SPL 到片内 SRAM。BootROM 是否会校验签名、可读取哪些介质，由具体芯片决定。',
      'BootROM: 教学路径选中存储介质，装入 SPL', '先装入的小程序',
      'BootROM → SRAM 中的 SPL\n此时尚不依赖已经初始化的大容量 DDR。');
    add('spl-ddr', 'spl', 'SPL：先把大内存准备好',
      '这块虚拟板使用 SPL 初始化必要的时钟和 DDR，再为后续大程序提供运行空间。SPL 是一种常见安排，不是所有板卡必须有的阶段。',
      'SPL: 初始化所需时钟与 DDR（教学假设）', '内存角色',
      'SRAM：片内、较小，早期代码可使用\nDDR：容量较大，初始化后供 U-Boot / Linux 使用');
    add('spl-load', 'spl', 'SPL 把完整 U-Boot 装入 DDR',
      '准备好内存后，SPL 加载完整 U-Boot 并交出执行权。本实验省略平台固件和安全世界初始化。',
      'SPL: 加载 U-Boot proper → 跳转', '控制权变化',
      'CPU 当前执行 SPL → CPU 改为执行 U-Boot\n这两者都不是 Linux 内核。');
    add('uboot-prompt', 'uboot', 'U-Boot：选择要启动的系统',
      'U-Boot 可以访问它支持的存储器并提供命令行。本例假设它自己的串口驱动可用；这不能证明 Linux 的设备树或串口驱动配置也正确。',
      'U-Boot: 教学命令行准备好（使用自身串口实现）', '只读查看示例',
      'printenv bootcmd bootargs kernel_addr_r fdt_addr_r\n# 本界面展示含义，不在实体设备执行命令。');
    if (config.scenario === 'kernel-missing') {
      state.halted = true;
      add('kernel-load-failed', 'uboot', '找不到 Image：停在 U-Boot',
        '本次内核文件加载失败，没有可执行的 Linux 镜像，因此不会跳进内核。检查启动介质、分区、路径与镜像是否存在。',
        'load Image: 文件不存在；保留 U-Boot 命令行', '失败边界',
        'load mmc 0:1 ${kernel_addr_r} Image\n→ 模拟失败：未找到文件\nLinux 尚未执行。');
      return result(false, '停在 U-Boot：内核文件缺失', 'Image 没有成功装入内存，Linux 尚未启动。这个问题发生在设备驱动初始化之前。');
    }
    add('load-image', 'uboot', '把 Linux Image 读到 DDR',
      'Image 是内核镜像。加载只是把文件内容放入内存；CPU 仍在运行 U-Boot，还没有执行 Linux。加载地址必须遵循真实板卡的内存布局。',
      'load Image: 模拟装入内存完成', '读文件到内存（示意）',
      'load mmc 0:1 ${kernel_addr_r} Image\n# 变量由真实板卡环境定义，示例不指定可用于烧录的物理地址。');
    add('load-dtb', 'uboot', '再装入这块板的硬件描述 DTB',
      '设备树描述有哪些硬件及其资源。DTS 是文本，通常由构建工具编译成 DTB；U-Boot 把 DTB 提供给内核。它不是驱动程序。',
      'load board.dtb: 模拟读取 DTB', '文本与二进制的关系',
      'board.dts --dtc（真实构建工具）--> board.dtb\nU-Boot 将 board.dtb 装入 ${fdt_addr_r}\n本程序仅根据表单生成教学描述，不真正调用 dtc。');
    if (config.scenario === 'dtb-invalid') {
      state.halted = true;
      add('dtb-check-failed', 'uboot', 'DTB 格式损坏：无法按本路径启动',
        '本次故意让设备树二进制格式校验失败，U-Boot 在交接前停止。它和节点 status="disabled" 不同：后者是合法设备树中的配置。',
        'FDT: 模拟格式检查失败；未跳转到内核', '故障类型',
        'DTB 格式无效 ≠ 串口节点 disabled\n前者破坏启动输入；后者只表示本模型不启用该设备。');
      return result(false, '停在 U-Boot：DTB 格式无效', '内核所需的设备树输入没有通过本次启动检查。Linux 尚未执行，不应归因于串口或网口驱动。');
    }
    add('bootargs', 'uboot', '告诉内核控制台和根文件系统在哪里',
      '本例把启动参数放入交给内核的 /chosen/bootargs。console 指定期望的控制台；root 指定根文件系统来源。名字和分区号必须与真实板卡一致。',
      'bootargs: ' + bootargs, '启动参数（教学设备名）',
      bootargs + '\n\nconsole：期望的日志输出设备\nroot：/sbin/init 等系统文件所在的根文件系统\nrootwait：等待根设备出现，不会自动修复缺失设备');
    add('handoff', 'uboot', 'booti：把执行权交给 Linux',
      'booti 使用内核地址和 DTB 地址启动 Image；中间的 - 表示本例不传入 initrd。该命令正常启动后不会继续停留在 U-Boot 命令行。',
      'booti: 参数检查完成 → 准备进入内核', 'U-Boot 的交接命令',
      'booti ${kernel_addr_r} - ${fdt_addr_r}\n    内核镜像地址       设备树地址\n# 本例不使用 initrd。');
    state.linuxRunning = true;
    add('kernel-enter', 'kernel', 'Linux 开始执行，接管系统',
      '内核现在获得执行权并完成自己的早期初始化。它将使用自己的驱动体系；不能把 U-Boot 的驱动初始化当成 Linux 设备已经可用。',
      'Linux: 已进入内核（观察器记录，不保证串口已能输出）', '两套软件的边界',
      'U-Boot 驱动：启动阶段读取存储、输出命令行\nLinux 驱动：运行阶段管理设备、向应用提供接口');
    add('parse-dt', 'kernel', '内核读取 DTB：认识这块板的硬件',
      '内核解析内存、启动参数和设备节点。本模型接下来逐项检查 status、compatible 与可用驱动；真实内核还需处理更多平台资源。',
      'Linux: 解析硬件描述、启动参数与设备节点', '本次表单生成的 DTS 教学视图', dts);
    for (const kind of ['uart', 'eth']) {
      const device = deviceResult(config, kind);
      state[kind + 'Ready'] = device.ready;
      state[kind + 'Reason'] = device.reason;
      const name = kind === 'uart' ? '串口' : '网口';
      const compatible = kind === 'uart' ? 'study,uart' : 'study,ethernet';
      const deviceName = kind === 'uart' ? '/dev/ttyS0（教学名称）' : 'eth0（教学名称）';
      add(kind + '-probe', 'drivers', name + (device.ready ? '驱动初始化完成' : '没有进入可用状态'),
        device.reason + (kind === 'uart' ? '如果它是唯一控制台，真实串口在 Linux 阶段可能没有输出；此处日志由观察器展示。' : '驱动就绪不等于网线已连接，也不等于配置好了 IP 地址。'),
        name + ': ' + device.code + ' — ' + (device.ready ? deviceName : device.reason),
        '设备描述与驱动的关系',
        '节点启用：' + (config[kind + 'Enabled'] ? '是' : '否') + '\ncompatible 匹配 ' + compatible + '：' + (config[kind + 'Compatible'] ? '是' : '否') +
        '\n对应 Linux 驱动可用：' + (config[kind + 'Driver'] ? '是' : '否') + '\n结果：' + (device.ready ? '在教学模型中注册 ' + deviceName : device.reason));
    }
    if (config.scenario === 'rootfs-missing') {
      state.halted = true;
      add('rootfs-failed', 'kernel', '根文件系统没有挂载成功',
        '内核已经执行，但找不到本例指定的根文件系统，无法运行 /sbin/init。真实 rootwait 可能持续等待；本实验把这一阶段汇总为启动受阻，不编造等待时间。',
        'rootfs: 模拟根设备不可用，用户空间尚未启动', '当前能与不能做的事',
        'Linux 内核：已取得执行权\n根文件系统：尚未挂载\n/sbin/init：未运行\n用户的串口 / 网口应用：无法启动');
      return result(false, '内核已启动，卡在根文件系统', '检查 root 参数、存储驱动、分区和文件系统。即使某个通信驱动已初始化，也没有进入可运行用户程序的系统。');
    }
    add('rootfs-mounted', 'kernel', '挂载根文件系统，找到系统程序',
      '根文件系统提供 /sbin/init、库和配置文件。它与内核 Image 是不同的东西。本例假定存储与文件系统驱动可用。',
      'rootfs: 模拟挂载成功；找到 /sbin/init', '三个文件各做什么',
      'Image：内核程序\nboard.dtb：硬件描述\n根文件系统：用户空间程序、库、配置与数据');
    state.userspaceReady = true;
    add('init', 'userspace', '启动 init：进入用户空间',
      '内核启动第一个用户空间进程。本例假设它完成基本初始化；后续服务、登录入口和网络配置由用户空间安排。',
      'init: 基本用户空间准备就绪（观察器视角）', '下一步由谁完成',
      '/sbin/init → 启动服务 / 提供登录入口 → 运行串口或网口应用');
    add('ready', 'userspace', '系统已启动，再看每个接口是否可用',
      '操作系统启动成功与所有外设可用是两件事。你可以禁用一个设备节点、移除驱动或改错 compatible，观察系统仍启动而该接口不可用。',
      '系统就绪：串口 ' + (state.uartReady ? '可用' : '不可用') + '；网口驱动 ' + (state.ethReady ? '可用' : '不可用'),
      '实验状态',
      '用户空间：已就绪\n串口：' + state.uartReason + '\n网口：' + state.ethReason + '\n注意：以上不是来自真实硬件的探测结果。');
    const unavailable = [!state.uartReady && '串口', !state.ethReady && '网口'].filter(Boolean);
    return result(true, unavailable.length ? '系统已启动，部分接口不可用' : '系统已启动，可以开始通信实验',
      unavailable.length ? '用户空间已运行；' + unavailable.join('和') + '需检查设备树启用状态、compatible 与对应驱动。设备树不会自动生成驱动。'
        : '用户空间与两个教学接口已准备好。串口还要约定通信参数；网口还要确认链路、地址和对端程序。');
  }
  return freeze({build, deviceTree});
});
