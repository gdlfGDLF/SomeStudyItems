/* CAN frame-format teaching model. This is not a hardware packet encoder.
 * CC: real CRC-15 and dynamic stuffing. FD/XL: field-level playback only;
 * unknown CRC/encoding values remain null, never fabricated as wire bits.
 * Sources and limits: CAN_FORMATS.md. */
(function(root,factory){
  const wire=typeof module==='object'&&module.exports?require('./wire.js'):root.ProtocolLab;
  const api=factory(wire);if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.CanFormats=api;
})(typeof window!=='undefined'?window:globalThis,function(W){
 'use strict';
 const TYPES=[
  {key:'cc-base',name:'经典 CAN · 标准数据帧',family:'CC',extended:false,remote:false,brs:false},
  {key:'cc-remote',name:'经典 CAN · 标准远程帧',family:'CC',extended:false,remote:true,brs:false},
  {key:'cc-extended',name:'经典 CAN · 扩展数据帧',family:'CC',extended:true,remote:false,brs:false},
  {key:'cc-extended-remote',name:'经典 CAN · 扩展远程帧',family:'CC',extended:true,remote:true,brs:false},
  {key:'fd-base',name:'CAN FD · 标准 · BRS 关闭',family:'FD',extended:false,remote:false,brs:false},
  {key:'fd-extended',name:'CAN FD · 扩展 · BRS 关闭',family:'FD',extended:true,remote:false,brs:false},
  {key:'fd-brs',name:'CAN FD · 标准 + BRS',family:'FD',extended:false,remote:false,brs:true},
  {key:'fd-extended-brs',name:'CAN FD · 扩展 + BRS',family:'FD',extended:true,remote:false,brs:true},
  {key:'xl',name:'CAN XL · 11 位优先级 ID',family:'XL',extended:false,remote:false,brs:false}
 ];
 const FD_LENGTHS=[0,1,2,3,4,5,6,7,8,12,16,20,24,32,48,64];
 const sources=[
  {title:'CiA：CAN FD 字段与速率切换',url:'https://www.can-cia.org/can-knowledge/can-fd-the-basic-idea'},
  {title:'CiA：CAN XL 字段图',url:'https://www.can-cia.org/can-knowledge/can-xl'},
  {title:'CiA：三代 CAN 的 CRC',url:'https://www.can-cia.org/can-knowledge/cyclic-redundancy-check-crc-in-can-frames'},
  {title:'Vector：动态与固定填充',url:'https://certification.vector.com/mod/page/view.php?id=370'},
  {title:'Bosch：CAN XL 总览',url:'https://www.bosch-semiconductors.com/media/ip_modules/pdf_2/can_xl_1/20230717_can_xl_overview.pdf'}
 ];
 function integer(v,min,max,label){const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw Error(`${label}必须是 ${min}–${max} 的整数。`);return n;}
 function hexNumber(v,max,label){if(typeof v==='string'){if(!/^(?:0x)?[0-9a-f]+$/i.test(v.trim()))throw Error(`${label}请输入十六进制整数。`);v=parseInt(v.trim(),16);}return integer(v,0,max,label);}
 const bitString=(v,n)=>Number(v).toString(2).padStart(n,'0');
 const hex=v=>'0x'+v.toString(16).toUpperCase();
 const hexBytes=b=>b.map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' ');
 function size(n){if(n===0)return '0 B';if(n%8===0)return `${n/8} B`;return n<8?`${n}/8 B`:`${Math.floor(n/8)} B + ${n%8} bit`;}
 function build(input={}){
  const type=TYPES.find(t=>t.key===(input.type||'cc-base'));if(!type)throw Error('未知 CAN 帧类型。');
  if(input.remote===true&&!type.remote)throw Error('远程帧只能通过经典 CAN 的远程类型选择；CAN FD / XL 没有远程帧。');
  const xl=type.family==='XL',fd=type.family==='FD',cc=type.family==='CC';
  const id=hexNumber(input.id??'200',type.extended?0x1fffffff:0x7ff,xl?'优先级 ID':'CAN ID');
  const data=W.parseData(input.data??(type.remote?'':'DC 05'),xl?2048:fd?64:8);
  if(type.remote&&data.length)throw Error('远程帧 DATA 为 0 字节；请清空数据，用请求 DLC 指定期望长度。');
  if(xl&&!data.length)throw Error('CAN XL 的 DATA 至少 1 字节，最多 2048 字节。');
  if(fd&&!FD_LENGTHS.includes(data.length))throw Error('CAN FD 长度只能是 0–8、12、16、20、24、32、48、64 字节。本实验不偷偷补零。');
  const dlc=type.remote?integer(input.requestDlc??8,0,8,'请求 DLC'):xl?data.length-1:fd?FD_LENGTHS.indexOf(data.length):data.length;
  const nominalRate=integer(input.nominalRate??500000,10000,1000000,'仲裁位速率');
  const requestedRate=integer(input.dataRate??2000000,10000,20000000,'数据位速率');
  const config={...type,id,data,dlc,nominalRate,dataRate:(type.brs||xl)?requestedRate:nominalRate,esi:fd?integer(input.esi??0,0,1,'ESI'):0};
  if(xl){config.sdt=hexNumber(input.sdt??'00',255,'SDT');config.vcid=hexNumber(input.vcid??'00',255,'VCID');config.af=hexNumber(input.af??'00000001',0xffffffff,'AF');}
  const fields=[];
  function field(key,n,value,meaning,phase='nominal',group='control'){
   const bits=typeof value==='number'?bitString(value,n):typeof value==='string'&&/^[01]*$/.test(value)?value:null;
   if(bits!==null&&bits.length!==n)throw Error('字段位宽错误：'+key);
   const f={key,bits:n,value:typeof value==='number'?value:null,bitString:bits,meaning,phase,group,byteSize:size(n),offset:fields.reduce((a,f)=>a+f.bits,0)};
   fields.push(f);return f;
  }
  field('SOF',1,0,'帧起始：显性 0；不是预热帧。','nominal','start');
  field(type.extended?'ID-A':xl?'Priority ID':'ID',11,type.extended?Math.floor(id/2**18):id,type.extended?'29 位 ID 的高 11 位；并非独立的 ID。':xl?'只决定总线竞争优先级；地址/内容筛选另看 AF。':'标识符，最高位先发。','nominal','id');
  if(type.extended){
   field('SRR',1,1,'替代标准帧 RTR 位置的隐性位。','nominal','id');field('IDE',1,1,'1 表示扩展格式。','nominal','id');
   field('ID-B',18,id%2**18,'29 位 ID 的低 18 位；ID = (ID-A << 18) | ID-B。','nominal','id');
   field(cc?'RTR':'RRS',1,cc?Number(type.remote):0,cc?'RTR=1 请求数据；RTR=0 携带数据。':'固定为 0，不提供远程请求。','nominal','id');
  }else{
   field(cc?'RTR':'RRS',1,cc?Number(type.remote):0,cc?'RTR=1 为远程帧；RTR=0 为数据帧。':'固定为 0；FD / XL 不支持远程帧。','nominal','id');
   field('IDE',1,0,'0 表示这里使用 11 位标识符。');
  }
  let dataPhase='nominal';
  if(cc){if(type.extended)field('r1',1,0,'经典扩展帧的保留位。');field('r0',1,0,'经典 CAN 保留位。');}
  if(fd){
   field('FDF',1,1,'1 表示 FD 格式。');field('res',1,0,'FD 的保留位。');
   field('BRS',1,Number(type.brs),type.brs?'在本位采样点切换到数据速率；不是整个帧一起加速。':'0：全帧使用仲裁速率，即使配置了更高的数据速率。',type.brs?'switch':'nominal');
   dataPhase=type.brs?'data':'nominal';field('ESI',1,config.esi,'0：错误主动；1：错误被动。它不是数据错误标志。',dataPhase);
  }
  if(xl){
   field('FDF',1,1,'与 XLF 一起区分 XL 格式。');field('XLF',1,1,'1 表示 XL 格式，不是 29 位扩展 ID。');
   field('resXL',1,0,'XL 保留位。');field('ADS',4,null,'ADH、DH1、DH2、DL1：从仲裁阶段转入数据阶段；ADH / DH1 边界切换速率。','switch');
   dataPhase='data';field('SDT',8,config.sdt,'服务数据类型：解释 DATA 的上层格式。',dataPhase);
   field('SEC',1,0,'本实验只演示基础 XL 帧，SEC=0；不生成 CANsec 内容。',dataPhase);
  }
  field('DLC',xl?11:4,dlc,type.remote?`请求 DLC=${dlc}，期望响应携带 ${dlc} 字节；本帧不携带 DATA。`:xl?`DLC = DATA 字节数 − 1；${dlc} 表示 ${data.length} 字节。`:fd?`编码 ${dlc} 表示 ${data.length} 字节，不能直接把 DLC 当字节数。`:`DATA 长度为 ${data.length} 字节。`,dataPhase);
  if(xl){
   field('SBC',3,null,'仲裁阶段的填充计数信息；本字段模型不生成其编码。',dataPhase,'crc');
   field('PCRC',13,null,'前缀 CRC，保护前段控制信息；13 位，不是 13 字节。',dataPhase,'crc');
   field('VCID',8,config.vcid,'虚拟 CAN 网络标识。',dataPhase);
   field('AF',32,config.af,'32 位接收筛选字段，与 11 位 Priority ID 分开。',dataPhase,'id');
  }
  field('DATA',data.length*8,data.map(v=>bitString(v,8)).join(''),type.remote?'远程帧没有 DATA；0 位这一项仅便于比较，不在线上传输。':`${data.length} 字节实际数据；这里的字节数不包含任何位填充。`,dataPhase,'data');
  let classicWire=null,stuffing;
  if(cc){
   const raw=fields.flatMap(f=>[...f.bitString].map(v=>({value:Number(v),field:f.key})));
   const crc=W.crc15(raw.map(b=>b.value));field('CRC',15,crc,'CRC-15；计算不含动态填充位。','nominal','crc');
   raw.push(...bitString(crc,15).split('').map(v=>({value:Number(v),field:'CRC'})));
   classicWire=W.stuffBits(raw);stuffing={dynamic:classicWire.filter(b=>b.stuffed).length,fixed:0,rule:'SOF 到 CRC 序列末尾，连续 5 个相同位后插入 1 个相反位。计数跨字段继续，填充位不属于 ID / DATA。'};
  }else if(fd){
   field('SBC',3,null,'动态填充位数量模 8 的 Gray 编码；本模型不计算数值。',dataPhase,'crc');
   field('SBC parity',1,null,'保护 SBC 的奇偶校验位。',dataPhase,'crc');
   const width=data.length<=16?17:21;field('CRC',width,null,`CRC-${width}；字段回放不计算 CRC 数值，也不声称已做接收校验。`,dataPhase,'crc');
   stuffing={dynamic:null,fixed:width===17?6:7,rule:'SOF 到 DATA 末尾使用动态填充；CRC 区改用固定填充：SBC 前 1 位，随后每 4 个内容位插 1 位。SBC、校验位、CRC 序列与填充位分别统计。'};
  }else{
   field('FCRC',32,null,'整帧 CRC，与 PCRC 形成级联保护；本模型不计算 CRC 数值。',dataPhase,'crc');
   field('FCP',4,null,'格式检查模式；末位 FCP(0) 后切回仲裁速率。',dataPhase,'crc');
   field('DAS',4,null,'DAH、AH1、AL1、AH2：由数据阶段返回仲裁阶段。','switch','tail');
   stuffing={dynamic:null,fixed:null,rule:'仲裁阶段用动态填充；数据阶段从 ADS 中的 DL1 起至 FCRC，按每 10 个内容位固定填充。不能把经典 CAN 的五连位规则套到 XL 整帧。'};
  }
  if(!xl)field('CRC delimiter',1,1,'CRC 界定符；与 CRC 校验序列分开计数。',type.brs?'switch':'nominal','tail');
  field('ACK',1,0,'正常接收场景：发送端释放为 1，接收端在 ACK 槽驱动 0。本回放假设接收成功；ACK 不是回复数据帧。','nominal','tail');
  field('ACK delimiter',1,1,'ACK 界定符，隐性 1。','nominal','tail');field('EOF',7,127,'帧结束，7 个隐性位；不是 7 字节。','nominal','tail');
  const frameBits=fields.reduce((n,f)=>n+f.bits,0);
  field('Intermission',3,7,'帧间隔的最小间歇段，3 位；不属于这帧。总线还可以继续空闲。','nominal','gap');
  if(classicWire){
   for(const f of fields.filter(f=>['CRC delimiter','ACK','ACK delimiter','EOF','Intermission'].includes(f.key))){
    for(const v of f.bitString)classicWire.push({value:Number(v),field:f.key,stuffed:false,index:classicWire.length});
   }
  }
  const steps=[
   {stage:'app',title:'应用准备消息',detail:`${type.name}，ID=${hex(id)}；${type.remote?`请求 ${dlc} 字节，DATA 为空`:`DATA=${data.length} 字节`}。`,fieldIndex:null},
   {stage:'kernel',title:'Linux 接收发送请求',detail:`${xl?'canxl_frame':fd?'canfd_frame':'can_frame'} 描述消息；内存结构中的对齐和标志位不等于线上字段。`,fieldIndex:null},
   {stage:'driver',title:'驱动交给控制器',detail:'控制器必须支持选中的格式；可能在 SoC 或 FPGA 内。此处不虚构板卡私有 DMA 包。',fieldIndex:null},
   {stage:'mac',title:'CAN 控制器组帧',detail:'控制器 / MAC 负责字段顺序、CRC、填充与仲裁；收发器负责逻辑信号和物理信号的转换。',fieldIndex:null}
  ];
  fields.forEach((f,i)=>steps.push({stage:f.key==='ACK'?'ack':f.key==='Intermission'?'gap':'wire',title:`${f.key} · ${f.bits} bit · ${f.byteSize}`,detail:f.meaning,fieldIndex:i}));
  steps.push({stage:'peer',title:type.remote?'对端收到远程请求':'对端交付消息',detail:type.remote?'请求帧接收成功不代表数据已经返回。是否发送同 ID 的数据帧取决于对端配置；回复是另一帧。':'本场景假设接收检查通过后交付上层；线上 ACK 不证明对端应用已经处理。',fieldIndex:null},
   {stage:'report',title:'设备产生发送完成状态',detail:'正常场景下，ACK 和帧结束之后由控制器报告本地发送结果。具体是中断、轮询还是 DMA 报告由设备实现决定。',fieldIndex:null},
   {stage:'done',title:'驱动处理 TxDone',detail:'本地发送完成，驱动回收发送资源；不等于对端应用回复。本回放没有连接板卡。',fieldIndex:null});
  return {type,config,fields,steps,frameBits,intermissionBits:3,stuffing,wireBits:classicWire,
   wireFrameBits:classicWire?classicWire.length-3:null,
   fidelity:cc?'经典 CAN：字段回放 + CRC-15 / 线上填充位计算':'字段级回放：未生成 CRC 数值及完整线上编码；接收成功为场景假设',
   sources,hexData:hexBytes(data),limits:['不模拟多节点仲裁、错误恢复、传播延迟或时钟重同步。','ISO CAN FD；不包含不兼容的早期 non-ISO FD。','XL 采用基础字段示意，不实现 CANsec、分片、PWM 或收发器模式切换电路。']};
 }
 return {TYPES,FD_LENGTHS,build,size,hexBytes,sources};
});
