/* Offline protocol UI. Each model owns its timing and immutable event snapshots. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const hex=bytes=>(bytes||[]).map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' ')||'—';
 const bits=s=>(s||'').replace(/(.{8})/g,'$1 ').trim()||'等待数据位';
 const state={protocol:'CAN',run:null,index:0,timer:null,dirty:false,configs:{}};
 const guides={
  SPI:{title:'SPI：一边打节拍，一边交换数据。',intro:'主机拉低选择线，再输出时钟。每一个采样边沿，双方各读入一位。',rule:'有时钟、有选择线；没有协议 ACK。',
   stages:['应用准备两组字节','驱动设置模式与时钟','时钟带着数据传输','双方各自拼出字节','主机完成本次传输'],
   lines:[['CS','选择线：低电平选中这个对端。'],['SCLK','时钟线：主机给出传输节拍。'],['MOSI','主机发给对端的数据。'],['MISO','对端同时发给主机的数据。']],
   remember:'SPI 没有地址和 ACK。对端即使没有选中，主机也可能正常打完时钟。',
   linux:'Linux 示例路径：应用通过 spidev → SPI 子系统 → 控制器驱动 → SPI 控制器。控制器可以位于 SoC 或 FPGA 中；这里不模拟具体 DMA、寄存器或中断。',
   note:'理想逻辑电平。MOSI 和 MISO 同时传输；对端字节是预先装入的移位数据，不是临时计算的命令响应。采样圆点表示指定模式的采样边沿。'},
  I2C:{title:'I²C：先叫地址，再逐字节交接。',intro:'主机用地址选设备，每传完 8 位，第 9 个时钟让接收方确认。',rule:'ACK 是一个字节的确认；读完后的 NACK 可表示正常结束。',
   stages:['应用指定地址与数据','驱动组织一次读写','发起始、地址与数据','接收方逐字节确认','停止条件结束传输'],
   lines:[['SCL','时钟线：主机给节拍，对端可拉低延长等待。'],['SDA','双向数据线：地址、数据与确认共用它。']],
   remember:'线上 0 表示拉低，1 表示释放后由上拉形成高电平。ACK=0；读最后一个字节时，主机发 NACK=1 结束读取。',
   linux:'Linux 示例路径：应用通过 i2c-dev → I²C 子系统 → 适配器驱动 → I²C 控制器。这里只演示一次读或写；真实器件的寄存器命令可能需要组合事务。',
   note:'理想开漏信号：高电平表示释放总线，并由上拉电阻拉高。第 9 位是确认，不属于数据字节。时钟延展时，以实际 SCL 为准。'},
  UART:{title:'UART：没有时钟线，也能读出字节。',intro:'双方约定速度，接收方从起始位重新计时，在各位的中间附近采样。',rule:'只有各自的时钟；发送完成不等于对方收到。',
   stages:['应用准备字节','驱动配置串口参数','起始位带出数据位','对端独立计时采样','发送完毕，检查接收'],
   lines:[['TX → RX','发送端 TX 接对端 RX；图中展示这一条单向链路。'],['GND','逻辑电平串口通常还需共地，图中省略地线。']],
   remember:'UART 的数据位先低位后高位。空闲是 1，起始位是 0；没有协议 ACK，需要应用自己约定回复。',
   linux:'Linux 示例路径：应用读写串口设备 → TTY / 串口核心 → 串口驱动 → UART 控制器。应用 write 返回可能只表示进入队列；控制器发送完停止位才是线上发送结束。',
   note:'理想逻辑电平串口，不是 RS-232 或 RS-485 的电压。圆点跟随接收方时钟，调整接收波特率可看到采样位置漂移。每字节起始检测采用简化模型。'}
 };
 const stages=['software','controller','wire','receiver','complete'];
 const stageNames=['软件提交','控制器准备','线上传输','接收与还原','本地完成'];
 function stop(){if(state.timer)clearInterval(state.timer);state.timer=null;$('serial-play').textContent='▶ 播放';}
 function field(name,title,value,options){
  const label=el('label',title),input=el(options?'select':'input');input.id='serial-'+name;input.name=name;
  if(options)for(const [v,t] of options){const option=el('option',t);option.value=v;input.append(option);}
  else{input.type='text';input.autocomplete='off';}
  input.value=value;label.append(input);if(name==='data'||name==='reply')label.className='serial-data';$('serial-form').append(label);
 }
 function rawConfig(){return Object.fromEntries(new FormData($('serial-form')).entries());}
 function createForm(){
  $('serial-form').replaceChildren();
  field('data',state.protocol==='I2C'?'数据 / HEX（读模式：对端预置）':'发送数据 / HEX，1–8 字节',state.protocol==='UART'?'55 A3':'A5 3C');
  if(state.protocol==='SPI'){
   field('reply','对端预置数据 / HEX','5A C3');
   field('hz','时钟频率','1000000',[['100000','100 kHz'],['1000000','1 MHz'],['5000000','5 MHz']]);
   field('mode','时钟模式','0',[['0','模式 0：空闲低，上升沿读'],['1','模式 1：空闲低，下降沿读'],['2','模式 2：空闲高，下降沿读'],['3','模式 3：空闲高，上升沿读']]);
   field('bitOrder','字节内的顺序','msb',[['msb','先最高位'],['lsb','先最低位']]);
   field('selected','实验场景','true',[['true','正常：选择对端'],['false','未选择对端（MISO 示例上拉）']]);
  }else if(state.protocol==='I2C'){
   field('address','设备地址 / HEX，08–77','50');
   field('hz','时钟频率','100000',[['100000','100 kHz'],['400000','400 kHz'],['1000000','1 MHz']]);
   field('direction','操作方向','write',[['write','主机写 → 对端'],['read','主机读 ← 对端']]);
   field('scenario','实验场景','success',[['success','正常确认'],['nack','地址无人确认'],['stretch','对端拉低时钟，稍等一下']]);
  }else{
   const rates=[['9600','9,600 bit/s'],['90000','90,000 bit/s'],['100000','100,000 bit/s'],['115200','115,200 bit/s'],['128000','128,000 bit/s'],['230400','230,400 bit/s']];
   field('baud','发送波特率','115200',rates);field('receiverBaud','接收波特率','115200',rates);
   field('parity','校验方式','none',[['none','无校验（8N1）'],['even','偶校验（8E1）'],['odd','奇校验（8O1）']]);
  }
  for(const [name,value] of Object.entries(state.configs[state.protocol]||{})){const input=$('serial-'+name);if(input)input.value=value;}
  const submit=el('button','生成 / 重置');submit.className='primary';submit.type='submit';$('serial-form').append(submit);
 }
 function build(){
  stop();const raw=rawConfig();
  try{
   let model,config={...raw};
   if(state.protocol==='SPI'){model=window.SpiLab;config={...raw,hz:Number(raw.hz),mode:Number(raw.mode),selected:raw.selected==='true'};}
   if(state.protocol==='I2C'){if(!/^(?:0x)?[\da-f]{1,2}$/i.test(raw.address.trim()))throw Error('设备地址请填写 08–77 范围的十六进制数。');model=window.I2cLab;config={...raw,address:parseInt(raw.address,16),hz:Number(raw.hz)};}
   if(state.protocol==='UART'){model=window.UartLab;config={...raw,baud:Number(raw.baud),receiverBaud:Number(raw.receiverBaud)};}
   state.run=model.build(config);state.configs[state.protocol]=raw;state.index=0;state.dirty=false;
   $('serial-validation').hidden=true;$('serial-config-note').textContent='参数已生成。先点“第一次采样”，再点“拼出一个字节”，观察数据如何还原。';
   $('serial-seek').max=state.run.steps.length-1;renderGuide();render();
  }catch(error){$('serial-validation').textContent=error.message;$('serial-validation').hidden=false;state.dirty=true;}
 }
 function renderGuide(){
  const guide=guides[state.protocol];
  $('serial-eyebrow').textContent=state.protocol==='I2C'?'I²C / 按地址通信':state.protocol+' / 从字节到信号';
  $('serial-title').textContent=guide.title;$('serial-intro').textContent=guide.intro;$('serial-rule').textContent=guide.rule;
  $('serial-wave-note').textContent=guide.note;$('serial-remember').textContent=guide.remember;$('serial-linux').textContent=guide.linux;
  $('serial-architecture').textContent='应用 → Linux 内核中的协议层与驱动 → 控制器 → 连线 → 对端控制器。这里的控制器可在芯片或 FPGA 内，不要求单独的 CAN 收发器。';
  const lines=el('dl');for(const [name,desc] of guide.lines){lines.append(el('dt',name),el('dd',desc));}$('serial-lines').replaceChildren(lines);
  $('serial-stages').replaceChildren();stages.forEach((stage,i)=>{const button=el('button');button.dataset.stage=stage;button.append(el('small','0'+(i+1)),el('b',stageNames[i]),el('span',guide.stages[i]));button.onclick=()=>jump(step=>step.stage===stage);button.disabled=!state.run.steps.some(step=>step.stage===stage);$('serial-stages').append(button);});
  $('serial-limits').replaceChildren(...(state.run.limits||[]).map(limit=>el('li',limit)));
  $('serial-sources').replaceChildren(...(state.run.sources||[]).map(source=>{const a=el('a',source.title||source.url||source);a.href=source.url||source;a.target='_blank';a.rel='noopener noreferrer';return a;}));
  const read=state.protocol==='I2C'&&state.run.config.direction==='read';
  $('serial-message-label').textContent=read?'对端预置，等待主机读出':'准备发送';
  $('serial-message').textContent=hex(read?state.run.expectedReply:state.run.sent);
  $('serial-returned-box').hidden=state.protocol!=='SPI';
  $('serial-received-label').textContent=read?'主机拼出的字节':'对端拼出的字节';
  $('serial-tx-bits').previousElementSibling.textContent=state.protocol==='SPI'?'MOSI：主机发出的数据位':read?'对端发出的数据位':'已经发出的数据位';
  $('serial-rx-bits').previousElementSibling.textContent=state.protocol==='SPI'?'MISO：主机采回的数据位':'已经采到的数据位';
 }
 function select(index){state.index=Math.max(0,Math.min(state.run.steps.length-1,Number(index)));render();}
 function jump(predicate){stop();const index=state.run.steps.findIndex(predicate);if(index>=0)select(index);}
 function render(){
  const step=state.run.steps[state.index],done=state.index===state.run.steps.length-1;
  $('serial-position').textContent=`${state.index+1} / ${state.run.steps.length}`;$('serial-seek').value=state.index;
  $('serial-prev').disabled=state.index===0;$('serial-next').disabled=done;
  $('serial-time').textContent=Number.isFinite(step.timeUs)?`线上时间 ${Number(step.timeUs.toFixed(3))} μs`:'软件阶段 · 不计线上时间';
  $('serial-event').replaceChildren(el('h3',step.title),el('p',step.detail));
  $('serial-levels').replaceChildren(...state.run.signals.map(signal=>{const tag=el('span',signal.key);tag.append(el('b',step.levels[signal.key]??signal.idle));return tag;}));
  $('serial-tx-bits').textContent=bits(step.txBits);$('serial-rx-bits').textContent=bits(step.rxBits);
  $('serial-received').textContent=hex(state.protocol==='I2C'&&state.run.config.direction==='read'?step.returned:step.received);
  $('serial-returned').textContent=hex(step.returned);
  const outcome=state.run.outcome;
  $('serial-result-title').textContent=done?outcome.title:'正在观察：'+stageNames[Math.max(0,stages.indexOf(step.stage))];
  $('serial-result-detail').textContent=done?outcome.detail:'结果会在最后一步展开。发送方完成本地动作，与接收方是否得到正确数据，需要分别观察。';
  const panel=$('serial-result-title').closest('section');if(done)panel.dataset.ok=String(outcome.ok);else delete panel.dataset.ok;
  document.querySelectorAll('[data-stage]').forEach(button=>{button.classList.toggle('active',button.dataset.stage===step.stage);button.classList.toggle('visited',state.run.steps.slice(0,state.index).some(s=>s.stage===button.dataset.stage));});
  drawWave();
 }
 const svg=(name,attrs,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs||{}))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
 function drawWave(){
  const root=$('serial-wave'),run=state.run,step=run.steps[state.index];root.replaceChildren();
  const timed=run.steps.map((s,i)=>({...s,i})).filter(s=>Number.isFinite(s.timeUs));
  const end=Math.max(...timed.map(s=>s.timeUs),1),sampleCount=timed.filter(s=>s.sample).length;
  const width=Math.max(850,Math.min(2600,150+sampleCount*28)),height=run.signals.length*66+48;
  root.setAttribute('viewBox',`0 0 ${width} ${height}`);root.style.width=width+'px';root.style.height=height+'px';
  const left=65,right=width-25,x=t=>left+(right-left)*t/end;
  const cursor=Number.isFinite(step.timeUs)?step.timeUs:0,colors=['#3766b0','#087d73','#8b64a8','#b47718'];
  for(let i=0;i<=8;i++){const t=end*i/8;root.append(svg('line',{x1:x(t),x2:x(t),y1:8,y2:height-30,stroke:'#e4eaf1'}),svg('text',{x:x(t),y:height-12,'text-anchor':'middle',fill:'#75859a','font-size':10},Number(t.toFixed(2))));}
  root.append(svg('text',{x:right,y:height-1,'text-anchor':'end',fill:'#75859a','font-size':9},'μs'));
  run.signals.forEach((signal,row)=>{
   const high=16+row*66,low=high+30,y=value=>value?high:low;
   root.append(svg('text',{x:4,y:high+16,fill:colors[row%4],'font-size':11},signal.key),svg('text',{x:45,y:high+3,fill:'#98a5b4','font-size':9},'1'),svg('text',{x:45,y:low+3,fill:'#98a5b4','font-size':9},'0'));
   let previous=signal.idle,d=`M ${left} ${y(previous)}`;
   for(const event of timed){const value=event.levels[signal.key]??previous;d+=` H ${x(event.timeUs)} V ${y(value)}`;previous=value;}
   d+=` H ${right}`;root.append(svg('path',{d,fill:'none',stroke:colors[row%4],'stroke-width':1.8}));
   for(const event of timed){if(!event.sample)continue;const isSpi=run.protocol==='SPI'&&(signal.key==='MOSI'||signal.key==='MISO');if(event.sample.signal!==signal.key&&!isSpi)continue;if(run.protocol==='SPI'&&signal.key==='MOSI'&&event.sample.accepted===false)continue;const dot=svg('circle',{cx:x(event.timeUs),cy:y(event.levels[signal.key]),r:3.4,fill:event.i<=state.index?'#d68b20':'#b9c5d4','data-step':event.i});dot.append(svg('title',{},event.title));root.append(dot);}
  });
  if(state.index<run.steps.length-1)root.append(svg('rect',{x:x(cursor),y:0,width:Math.max(0,right-x(cursor)),height:height-30,fill:'#fafbfd',opacity:.62,'pointer-events':'none'}));
  root.append(svg('line',{x1:x(cursor),x2:x(cursor),y1:5,y2:height-30,stroke:'#cf7825','stroke-width':1.5,'stroke-dasharray':'4 3','pointer-events':'none'}));
  root.onclick=event=>{if(event.target.dataset.step){stop();select(Number(event.target.dataset.step));return;}const rect=root.getBoundingClientRect(),time=((event.clientX-rect.left)*width/rect.width-left)/(right-left)*end;let nearest=timed[0];for(const candidate of timed){if(Math.abs(candidate.timeUs-time)<Math.abs(nearest.timeUs-time))nearest=candidate;}stop();select(nearest.i);};
  const scroll=root.parentElement;scroll.scrollLeft=Math.max(0,x(cursor)-scroll.clientWidth*.7);
 }
 function play(){if(state.timer){stop();return;}if(state.dirty){build();if(state.dirty)return;}if(state.index===state.run.steps.length-1)select(0);$('serial-play').textContent='Ⅱ 暂停';state.timer=setInterval(()=>{select(state.index+1);if(state.index===state.run.steps.length-1)stop();},Number($('serial-speed').value));}
 function switchProtocol(protocol){
  stop();state.protocol=protocol;
  window.dispatchEvent(new CustomEvent('lab-protocol-change',{detail:protocol}));
  $('can-lab').hidden=protocol!=='CAN';$('serial-lab').hidden=protocol==='CAN';
  document.querySelectorAll('[data-protocol]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.protocol===protocol)));
  if(protocol!=='CAN'){createForm();build();}
 }
 document.querySelectorAll('[data-protocol]').forEach(button=>button.onclick=()=>switchProtocol(button.dataset.protocol));
 $('serial-form').onsubmit=event=>{event.preventDefault();build();};
 $('serial-form').oninput=()=>{state.dirty=true;stop();$('serial-config-note').textContent='参数已修改。当前画面仍是上一次实验；点击“生成 / 重置”应用新参数。';};
 $('serial-play').onclick=play;$('serial-prev').onclick=()=>{stop();select(state.index-1);};$('serial-next').onclick=()=>{stop();select(state.index+1);};
 $('serial-reset').onclick=()=>{stop();select(0);};$('serial-finish').onclick=()=>{stop();select(state.run.steps.length-1);};$('serial-seek').oninput=()=>{stop();select($('serial-seek').value);};
 $('serial-speed').onchange=()=>{if(state.timer){stop();play();}};
 $('serial-first-sample').onclick=()=>jump(step=>!!step.sample);$('serial-first-byte').onclick=()=>jump(step=>(step.received?.length||step.returned?.length)>0);
 const exportCan=$('export').onclick;
 $('export').onclick=()=>{if(state.protocol==='CAN'){exportCan();return;}const blob=new Blob([JSON.stringify({description:'离线教学模型，非硬件测量',currentStep:state.index,simulation:state.run},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=state.protocol.toLowerCase()+'-trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
})();
