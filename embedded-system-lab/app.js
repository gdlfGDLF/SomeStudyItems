/* The GUI observes models; it never executes shell commands or accesses hardware. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
 const hex=values=>(values||[]).map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' ')||'—';
 const defaults={scenario:'success',uartEnabled:true,uartDriver:true,uartCompatible:true,ethEnabled:true,ethDriver:true,ethCompatible:true};
 const state={tab:'boot',run:null,index:0,timer:null,bootRun:null,bootIndex:0,bootConfig:{...defaults},configs:{},dirty:false,field:0,console:[]};
 const treeFields={uartEnabled:'dt-uart-enabled',uartCompatible:'dt-uart-compatible',uartDriver:'dt-uart-driver',ethEnabled:'dt-eth-enabled',ethCompatible:'dt-eth-compatible',ethDriver:'dt-eth-driver'};
 const stageNames={rom:['BootROM','芯片里的第一段代码'],spl:['SPL','准备大内存'],uboot:['U-Boot','装入系统并交接'],kernel:['Linux 内核','接管与初始化'],drivers:['设备驱动','把硬件变成接口'],userspace:['用户空间','运行应用'],software:['应用','准备要发的消息'],driver:['设备驱动','交给具体硬件'],controller:['控制器','组织实际传输'],wire:['连线','信号到达对端'],peer:['对端','还原并交给应用'],return:['业务回复','对端另发一条消息'],complete:['本次结果','分别判断收发状态']};
 const guides={
  boot:{title:'先记住这三句话',items:[['U-Boot 先运行','把内核和硬件描述装入内存，再把执行权交出去。'],['Linux 自己管理硬件','它使用自己的设备树与驱动；U-Boot 能用串口，不代表 Linux 也能用。'],['根文件系统提供程序','内核起来之后，还要找到 init、库和应用，才能运行你的通信程序。']]},
  tree:{title:'分清三个角色',items:[['设备树 = 硬件说明','有哪些设备、地址在哪里、设备是否启用。'],['驱动 = 操作方法','按硬件规则配置寄存器、收发数据、报告状态。'],['设备节点 = 应用入口','例如串口 /dev/ttyS0；eth0 是网络接口，通过 socket 使用。']]},
  serial:{title:'串口最容易混淆的事',items:[['接线','发送端 TX 接对端 RX，逻辑电平串口通常还需要共地。'],['约定','双方约好波特率与帧格式；本实验使用 8N1。'],['完成和回复','本地发送完不证明对方收到了。这里另约定对端应用把数据发回来，称为 echo。']]},
  network:{title:'一条消息穿过四层',items:[['UDP 端口','把数据交给对端正在监听的应用。'],['IP 地址','判断要送到哪台主机；本实验只演示同一局域网。'],['MAC 与 PHY','MAC 处理以太网帧，PHY 处理适合网线传输的信号。它们各有分工。']]}
 };
 function boardState(){return state.bootRun.steps[state.bootIndex].state;}
 function stop(){if(state.timer)clearInterval(state.timer);state.timer=null;$('play').textContent='▶ 播放';}
 function raw(){return Object.fromEntries(new FormData($('config-form')).entries());}
 function field(name,label,value,options,kind='text'){
  const wrap=node('label',label),input=node(options?'select':'input');input.name=name;input.id='config-'+name;
  if(options)for(const [v,text] of options){const option=node('option',text);option.value=v;input.append(option);}
  else {input.type=kind;input.autocomplete='off';if(name==='text')input.maxLength=128;}
  input.value=value;wrap.append(input);if(name==='text')wrap.className='message-input';$('config-form').append(wrap);
 }
 function configure(){
  $('config-form').replaceChildren();
  if(state.tab==='boot'){
   $('experiment-title').textContent='模拟一次上电启动';$('experiment-kicker').textContent='BOOT / 从芯片到应用';$('experiment-tag').textContent='ARM64 风格教学板';
   field('scenario','这次想观察什么',state.bootConfig.scenario,[['success','正常启动（使用已应用的设备树）'],['kernel-missing','找不到内核 Image'],['dtb-invalid','DTB 二进制格式损坏'],['rootfs-missing','内核起来，但找不到根文件系统']]);
   $('config-note').textContent='选择场景后重新上电。设备树与驱动选项在“设备树与驱动”页面修改。';
  }else if(state.tab==='serial'){
   $('experiment-title').textContent='向对端发送一条串口消息';$('experiment-kicker').textContent='UART / 从 write 到对端 read';$('experiment-tag').textContent='逻辑电平 · 8N1';
   field('text','发送文本（UTF-8，最多 32 字节）','Hello');
   const rates=[['9600','9,600'],['90000','90,000'],['100000','100,000'],['115200','115,200']];
   field('baud','本端波特率','115200',rates);field('peerBaud','对端波特率','115200',rates);
   field('scenario','实验场景','success',[['success','对端收到后原样回复'],['crossed-wrong','接错线：TX 没有接到对端 RX'],['no-reply','对端收到，但应用没有回复']]);
   $('config-note').textContent='先启动 Linux 并启用串口驱动。write 入队、本地发送结束、对端接收和应用回复是不同的时刻。';
  }else{
   $('experiment-title').textContent='通过网口发送一条 UDP 消息';$('experiment-kicker').textContent='ETHERNET / 应用 → 内核 → MAC → PHY';$('experiment-tag').textContent='静态 IPv4 · 同一局域网';
   field('text','发送文本（UTF-8，最多 32 字节）','Hello');field('sourceIp','本机 IP /24','192.168.1.10');field('peerIp','对端 IP /24','192.168.1.20');field('peerPort','对端 UDP 端口','9000',null,'number');
   field('scenario','实验场景','success',[['success','对端监听并原样回复'],['cable','网线未连接'],['arp','对端没有应答 ARP'],['port','对端端口没有程序监听'],['no-reply','对端收到，但应用没有回复']]);
   $('config-note').textContent='本实验不配置网关；两个地址须在同一个 /24 子网。本机端口 40000。UDP 自身没有接收确认，这里约定应用 echo。';
  }
  if(state.tab!=='boot')for(const [key,value] of Object.entries(state.configs[state.tab]||{})){const input=$('config-'+key);if(input)input.value=value;}
  const button=node('button',state.tab==='boot'?'模拟上电 / 重置':'生成 / 重置');button.type='submit';button.className='primary';$('config-form').append(button);
 }
 function build(){
  stop();const config=raw();
  try{
   if(state.tab==='boot'){
    state.bootConfig={...state.bootConfig,scenario:config.scenario};state.bootRun=EmbeddedBoot.build(state.bootConfig);state.bootIndex=0;state.run=state.bootRun;state.console=[];
   }else{
    const b=boardState(),device=state.tab==='serial'?'uart':'eth';
    const ready=b.userspaceReady&&b[device+'Ready'];
    const disabledReason=!b.userspaceReady?'Linux 用户空间尚未就绪，无法运行通信应用；请先完成启动。':b[device+'Reason'];
    state.run=state.tab==='serial'?EmbeddedComms.serial({...config,baud:Number(config.baud),peerBaud:Number(config.peerBaud),ready,disabledReason}):EmbeddedComms.network({...config,peerPort:Number(config.peerPort),sourcePort:40000,prefix:24,ready,disabledReason});
    state.configs[state.tab]=config;
   }
   state.index=0;state.field=0;state.dirty=false;$('validation').hidden=true;
   setupRun();select(0);
  }catch(error){state.dirty=true;$('validation').textContent=error.message;$('validation').hidden=false;}
 }
 function setupRun(){
  $('seek').max=state.run.steps.length-1;$('flow-title').textContent=state.tab==='boot'?'一次启动经过哪些地方':'一条消息经过哪些地方';
  const order=state.tab==='boot'?['rom','spl','uboot','kernel','drivers','userspace']:['software','kernel','driver','controller','wire','peer','return','complete'];
  const stages=order.filter(stage=>state.run.steps.some(step=>step.stage===stage));$('stages').replaceChildren();
  for(const stage of stages){let entry=stageNames[stage]||[stage,''];if(stage==='kernel'&&state.tab!=='boot')entry=['Linux 协议层',state.tab==='serial'?'TTY 管理字节流':'网络栈处理报文'];if(stage==='return'&&state.tab==='network')entry=['返回路径','ARP / ICMP / 业务回显'];const button=node('button');button.dataset.stage=stage;button.append(node('b',entry[0]),node('small',entry[1]));button.onclick=()=>{stop();select(state.run.steps.findIndex(step=>step.stage===stage));};$('stages').append(button);}
  $('uboot-panel').hidden=state.tab!=='boot';$('serial-panel').hidden=state.tab!=='serial';$('packet-panel').hidden=state.tab!=='network';$('transfer-status').hidden=state.tab==='boot';
  $('first-byte').hidden=state.tab!=='serial';$('first-byte').disabled=!state.run.steps.some(step=>step.bytes?.peer?.length);
  $('boot-required').hidden=state.tab==='boot'||boardState().userspaceReady;
  renderGuide();renderPacket();
 }
 function renderGuide(){
  const guide=guides[state.tab];$('learn-title').textContent=guide.title;
  $('learn-content').replaceChildren(...guide.items.map(([title,text])=>{const p=node('p');p.append(node('b',title),document.createTextNode(text));return p;}));
  const source=state.tab==='tree'?state.bootRun:state.run;
  const list=node('ul');for(const limit of source.limits||[])list.append(node('li',limit));$('limitations').replaceChildren(list);
  $('sources').replaceChildren(...(source.sources||[]).map(item=>{const a=node('a',item.title);a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';return a;}));
 }
 function select(index){
  state.index=Math.max(0,Math.min(state.run.steps.length-1,Number(index)));
  if(state.tab==='boot')state.bootIndex=state.index;
  const step=state.run.steps[state.index],last=state.index===state.run.steps.length-1;
  $('position').textContent=`${state.index+1} / ${state.run.steps.length}`;$('seek').value=state.index;$('previous').disabled=state.index===0;$('next').disabled=last;
  $('event').replaceChildren(node('h3',step.title),node('p',step.detail));
  $('logs').textContent=(step.logs||[]).join('\n')||'等待本次实验开始…';$('logs').scrollTop=$('logs').scrollHeight;
  $('data-label').textContent=step.data?.label||'此刻交接的数据';$('data-body').textContent=step.data?.body||'尚未交接数据。';
  document.querySelectorAll('[data-stage]').forEach(button=>{button.classList.toggle('active',button.dataset.stage===step.stage);button.classList.toggle('past',state.run.steps.slice(0,state.index).some(s=>s.stage===button.dataset.stage));});
  $('result').hidden=!last;$('result').classList.toggle('bad',!state.run.outcome.ok);
  if(last)$('result').replaceChildren(node('strong',state.run.outcome.title),node('p',state.run.outcome.detail));
  if(state.tab!=='boot')for(const [key,id] of [['localDone','local-done'],['peerReceived','peer-received'],['replyReceived','reply-received']]){$(id).textContent=step.state[key]?'已完成':'尚未';$(id).classList.toggle('good',!!step.state[key]);}
  renderBoard();if(state.tab==='boot')renderConsole();if(state.tab==='serial')renderSerial(step);
 }
 function renderBoard(){
  const s=boardState();$('board-system').textContent=s.halted?(s.linuxRunning?'内核启动受阻':'停在启动程序'):s.userspaceReady?'Linux 应用可运行':s.linuxRunning?'内核初始化中':state.bootIndex===0?'上电 / BootROM':stageNames[s.bootStage][0];
  for(const [kind,id] of [['uart','serial'],['eth','network']]){
   const ready=s[kind+'Ready'],text=ready?'驱动就绪':s[kind+'Reason'].includes('尚未')?'尚未初始化':'不可用';
   $('board-'+id+'-status').textContent=text;$('board-'+id+'-status').title=s[kind+'Reason'];
   $('board-'+kind).classList.toggle('ready',ready);$('board-'+kind).classList.toggle('failed',!ready&&text==='不可用');
  }
 }
 function play(){if(state.timer){stop();return;}if(state.dirty){build();if(state.dirty)return;}if(state.index===state.run.steps.length-1)select(0);$('play').textContent='Ⅱ 暂停';state.timer=setInterval(()=>{select(state.index+1);if(state.index===state.run.steps.length-1)stop();},Number($('speed').value));}
 function switchTab(tab){
  stop();state.tab=tab;state.dirty=false;$('validation').hidden=true;
  document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tab===tab)));
  $('tree-view').hidden=tab!=='tree';$('experiment-view').hidden=tab==='tree';
  if(tab==='tree'){renderTree();renderGuide();return;}
  configure();if(tab==='boot'){state.run=state.bootRun;setupRun();select(state.bootIndex);}else build();
 }
 function treeDraft(){const config={...state.bootConfig};for(const [key,id] of Object.entries(treeFields))config[key]=$(id).value==='true';return config;}
 function renderTree(){const config=treeDraft();$('dts-preview').textContent=EmbeddedBoot.deviceTree(config);$('tree-dirty').textContent=Object.keys(treeFields).some(key=>config[key]!==state.bootConfig[key])?'草稿有变化，重新启动后生效':'草稿与启动配置一致';}
 function renderConsole(){
  const step=state.run.steps[state.index],available=step.stage==='uboot'&&!step.state.linuxRunning;
  $('uboot-command').disabled=!available;document.querySelector('#uboot-form button').disabled=!available;
  $('uboot-output').textContent=state.console.length?state.console.join('\n'):available?'U-Boot 教学控制台已就绪。输入 help 查看演示命令。':'等待进入 U-Boot；Linux 启动后需要重新进入启动阶段。';
  $('uboot-output').scrollTop=$('uboot-output').scrollHeight;
 }
 function executeConsole(event){
  event.preventDefault();if($('uboot-command').disabled)return;
  const cmd=$('uboot-command').value.trim();$('uboot-command').value='';if(!cmd)return;state.console.push('=> '+cmd);
  if(cmd==='help')state.console.push('help                 查看本地演示命令\nprintenv             查看启动参数\nprintenv bootargs     查看传给 Linux 的参数\nprintenv bootcmd      查看交接命令\nboot                 继续当前启动场景');
  else if(cmd==='printenv'||cmd==='printenv bootargs'||cmd==='printenv bootcmd'){
   if(cmd!=='printenv bootcmd')state.console.push('bootargs=console=ttyS0,115200 root=/dev/mmcblk0p2 rootwait rw');
   if(cmd!=='printenv bootargs')state.console.push('bootcmd=load mmc 0:1 ${kernel_addr_r} Image && load mmc 0:1 ${fdt_addr_r} board.dtb && booti ${kernel_addr_r} - ${fdt_addr_r}\n（启动脚本预览：执行时先加载 Image 与 DTB，再交出执行权；地址来自板级配置）');
  }else if(cmd==='boot'){
   state.console.push('继续当前教学启动路径…');
   if(state.index===state.run.steps.length-1)state.console.push('当前场景仍存在加载故障。需要修正启动配置，再重新上电。');else if(!state.timer)play();
  }else state.console.push('本演示没有实现该命令。输入 help 查看支持的命令；不会执行真实 shell。');
  state.console=state.console.slice(-40);renderConsole();
 }
 function renderSerial(step){
  $('serial-tx').textContent=hex(step.bytes?.tx);$('serial-rx').textContent=hex(step.bytes?.peer);$('serial-reply').textContent=hex(step.bytes?.rx);
  const root=$('serial-wave');root.replaceChildren();const signals=step.signals?.length?step.signals:[{name:'TX → 对端 RX',bits:'1'}];
  const count=Math.max(...signals.map(s=>s.bits.length),16),width=Math.max(650,count*19+110),height=signals.length*130,left=70,dx=(width-left-20)/count;
  root.setAttribute('viewBox',`0 0 ${width} ${height}`);root.style.width=width+'px';root.style.height=height+'px';
  const svg=(tag,attrs,text)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))e.setAttribute(key,value);if(text!=null)e.textContent=text;return e;};
  signals.forEach((signal,row)=>{
   const bits=signal.bits||'1',top=row*130,y=value=>top+(String(value)==='1'?40:80);
   root.append(svg('text',{x:10,y:top+17,fill:'#537783','font-size':10},signal.name),svg('text',{x:20,y:top+44,fill:'#71899b','font-size':10},'1'),svg('text',{x:20,y:top+84,fill:'#71899b','font-size':10},'0'));
   let d=`M ${left} ${y(bits[0])}`;for(let i=0;i<bits.length;i++){d+=` H ${left+i*dx} V ${y(bits[i])} H ${left+(i+1)*dx}`;if(i%10===1)root.append(svg('line',{x1:left+i*dx,x2:left+i*dx,y1:top+25,y2:top+90,stroke:'#cddce4','stroke-dasharray':'3 4'}));if(dx>13)root.append(svg('text',{x:left+(i+.5)*dx,y:top+110,'text-anchor':'middle',fill:'#71899b','font-size':9},bits[i]));}
   root.append(svg('path',{d,fill:'none',stroke:row?'#3774ab':'#087e83','stroke-width':2}));
   if(row===0)for(const event of state.run.steps.slice(0,state.index+1)){if(event.sample&&Number.isFinite(event.timeUs)){const x=left+(1+event.timeUs*state.run.config.baud/1e6)*dx;if(x<=width-20)root.append(svg('circle',{cx:x,cy:y(event.sample.value),r:2.8,fill:'#bd8627'}));}}
  });
  root.parentElement.scrollLeft=Math.max(0,width-root.parentElement.clientWidth);
 }
 function renderPacket(){
  if(state.tab!=='network')return;const packet=state.run.packet;$('packet-fields').replaceChildren();$('packet-bytes').replaceChildren();
  if(!packet){$('packet-detail').textContent='当前实验未构造请求报文。';return;}
  const fields=packet.fields||[];state.field=Math.min(state.field,Math.max(0,fields.length-1));
  fields.forEach((field,index)=>{const button=node('button',field.name);button.classList.toggle('active',index===state.field);button.onclick=()=>{state.field=index;renderPacket();};$('packet-fields').append(button);});
  const selected=fields[state.field];(packet.bytes||[]).forEach((value,index)=>{const button=node('button');button.append(node('small',index.toString(16).toUpperCase().padStart(2,'0')),document.createTextNode(hex([value])));button.classList.toggle('highlight',!!selected&&index>=selected.start&&index<selected.end);button.setAttribute('aria-label',`偏移 ${index}，值 ${hex([value])}`);button.onclick=()=>{const match=fields.findIndex(f=>index>=f.start&&index<f.end);if(match>=0){state.field=match;renderPacket();}$('packet-detail').textContent=`偏移 ${index} · 0x${hex([value])} · ${fields[match]?.name||'原始字节'}：${fields[match]?.detail||''}`;};$('packet-bytes').append(button);});
  $('packet-detail').textContent=selected?`${selected.name} · 字节偏移 ${selected.start}–${selected.end-1}：${selected.detail}`:'尚无字段信息。';
 }
 function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>switchTab(button.dataset.tab));
 $('config-form').onsubmit=e=>{e.preventDefault();build();};$('config-form').oninput=()=>{stop();state.dirty=true;$('config-note').textContent='参数已修改；当前画面仍是上一次实验。点击生成或模拟上电，应用这次修改。';};
 $('play').onclick=play;$('previous').onclick=()=>{stop();select(state.index-1);};$('next').onclick=()=>{stop();select(state.index+1);};$('reset').onclick=()=>{stop();select(0);};$('finish').onclick=()=>{stop();select(state.run.steps.length-1);};$('seek').oninput=()=>{stop();select($('seek').value);};$('speed').onchange=()=>{if(state.timer){stop();play();}};
 $('first-byte').onclick=()=>{stop();const index=state.run.steps.findIndex(step=>step.bytes?.peer?.length);if(index>=0)select(index);};
 $('go-boot').onclick=()=>switchTab('boot');$('quick-boot').onclick=()=>{if(state.tab==='boot')build();else switchTab('boot');select(state.run.steps.length-1);};
 $('tree-form').oninput=renderTree;$('tree-form').onsubmit=e=>{e.preventDefault();stop();state.bootConfig=treeDraft();state.bootRun=EmbeddedBoot.build(state.bootConfig);state.bootIndex=0;state.console=[];switchTab('boot');play();};
 $('dt-restore').onclick=()=>{for(const id of Object.values(treeFields))$(id).value='true';renderTree();};
 $('download-dts').onclick=()=>download('study-virtual-board.dts',EmbeddedBoot.deviceTree(treeDraft()),'text/plain;charset=utf-8');
 $('enter-uboot').onclick=()=>{stop();select(state.run.steps.findIndex(step=>step.stage==='uboot'));$('uboot-command').focus();};$('uboot-form').onsubmit=executeConsole;
 $('export').onclick=()=>download('embedded-'+state.tab+'-trace.json',JSON.stringify({description:'离线教学模型，非硬件运行记录',tab:state.tab,currentStep:state.tab==='tree'?state.bootIndex:state.index,board:boardState(),draft:state.tab==='tree'?treeDraft():undefined,simulation:state.tab==='tree'?state.bootRun:state.run},null,2),'application/json');
 state.bootRun=EmbeddedBoot.build(defaults);state.run=state.bootRun;configure();setupRun();select(0);
})();
