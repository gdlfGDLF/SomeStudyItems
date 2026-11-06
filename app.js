/* Offline teaching UI. All strings from form inputs are rendered as text. */
(() => {
'use strict';
const $ = id => document.getElementById(id), P = window.ProtocolLab;
const state = {protocol:'CAN', result:null, cursor:0, stage:0, timer:null, config:null, arbitration:null, dirty:false};
const fieldNames = {SOF:'帧起始',ID:'标识符',RTR:'数据帧标志',IDE:'标准帧标志',r0:'保留位',DLC:'数据长度',DATA:'数据',CRC:'CRC 校验','CRC delimiter':'CRC 界定符',ACK:'接收确认','ACK delimiter':'ACK 界定符',EOF:'帧结束',IFS:'帧间隔',START:'起始位',PARITY:'校验位',STOP:'停止位'};
const stages = [['应用数据','选择要发送的字节'],['协议组帧','字段、校验与编码'],['线上传输','电平与逐位采样'],['接收检查','还原、校验、过滤'],['应用读取','字节与数值解释']];
const colors = {green:'#087c69',blue:'#3171b4',orange:'#b66b1c',red:'#b63e47',muted:'#61716f',grid:'#e6ece8',ink:'#182e2b'};
const ns = 'http://www.w3.org/2000/svg';
const fmt = (n,d=3) => Number(n).toLocaleString('en-US',{maximumFractionDigits:d});
const hex = n => Number(n).toString(16).toUpperCase().padStart(2,'0');
const hx = n => '0x'+Number(n).toString(16).toUpperCase();
function el(tag,text,cls) {const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function svg(tag,attrs,text) {const e=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));if(text!==undefined)e.textContent=text;return e;}
function line(root,x1,y1,x2,y2,color=colors.grid,width=1,dash='') {root.append(svg('line',{x1,y1,x2,y2,stroke:color,'stroke-width':width,'stroke-dasharray':dash}));}
function label(root,x,y,text,fill=colors.muted,size=10,anchor='start') {root.append(svg('text',{x,y,fill,'font-size':size,'font-family':'Segoe UI, Microsoft YaHei, sans-serif','text-anchor':anchor},text));}
function stop() {clearInterval(state.timer);state.timer=null;$('play').textContent='▶ 播放';}
function showError(error) {$('validation').hidden=false;$('validation').textContent=error.message||String(error);}
function number(id) {const v=Number($(id).value);if(!$(id).value.trim()||!Number.isFinite(v))throw new Error('请输入有效数字：'+id);return v;}
function idValue(id,nullable=false) {let v=$(id).value.trim().replace(/^0x/i,'');if(!v&&nullable)return null;if(!/^[0-9a-f]{1,3}$/i.test(v)||parseInt(v,16)>0x7ff)throw new Error('标准帧 ID 必须是 000–7FF 的十六进制数。');return parseInt(v,16);}
function getTiming() {return {clockMHz:number('clock'),brp:number('brp'),tseg1:number('seg1'),tseg2:number('seg2')};}
function applyTiming() {try {const t=P.suggestTiming(number('clock'),number('target'),number('sample-target'));$('brp').value=t.brp;$('seg1').value=t.tseg1;$('seg2').value=t.tseg2;previewTiming();markDirty();}catch(e){showError(e);}}
function previewTiming() {try {const c=getTiming(),t=P.timing(c);$('timing-formula').textContent=`${fmt(c.clockMHz)} MHz ÷ ${c.brp} ÷ ${t.totalTq} TQ = ${fmt(t.bitrate/1000)} kbit/s\n1 TQ = ${fmt(t.tqNs)} ns · 采样点 ${fmt(t.samplePercent)}%`;$('timing-formula').style.whiteSpace='pre-line';}catch(e){$('timing-formula').textContent=e.message;}}
function markDirty(){stop();state.dirty=true;$('dirty').textContent='配置已更改，请点击“生成实验”应用。';$('dirty').classList.add('bad');}
function build() {
 stop();try {
  const data=P.parseData($('payload').value,state.protocol==='CAN'?8:32);let c;
  state.arbitration=null;
  if(state.protocol==='CAN') {
   c={...getTiming(),id:idValue('can-id'),data,receiver:$('receiver').value,filterId:idValue('filter-id',true),fault:$('fault').value,delayNs:number('delay')};
   if($('preset').value==='arbitration') {state.arbitration=P.arbitrate(c.id,idValue('other-id'));if(state.arbitration.winner==='B')c.id=idValue('other-id');}
   state.result=P.buildCan(c);
  } else {c={data,baud:number('baud'),receiverBaud:number('rx-baud'),parity:$('parity').value};state.result=P.buildUart(c);}
  state.config=c;state.cursor=0;state.stage=0;state.dirty=false;$('dirty').classList.remove('bad');$('dirty').textContent='配置已应用。点击播放或选择任意一位。';$('validation').hidden=true;
  renderAll();
 } catch(e){state.dirty=true;$('dirty').textContent='配置尚未应用；右侧保留上次有效实验。';$('dirty').classList.add('bad');showError(e);}
}
function renderAll(){renderPipeline();renderFrame();renderMetrics();renderResult();renderArbitration();renderCursor();}
function renderPipeline(){
 const root=$('pipeline');root.replaceChildren();stages.forEach(([title,sub],i)=>{const b=el('button');b.classList.toggle('active',state.stage===i);b.setAttribute('aria-pressed',state.stage===i);b.append(el('span','0'+(i+1),'step-number'),el('b',title),el('small',sub));b.onclick=()=>{state.stage=i;renderPipeline();};root.append(b);});
 const r=state.result,can=state.protocol==='CAN',data=r.data.map(hex).join(' ')||'（空数据）';
 const detail=can?[
  `应用提交 ID ${hx(r.id)}、${r.data.length} 字节：${data}。ID 描述消息类型与优先级，字节含义由上层约定。`,
  `控制器按字段组帧，计算 CRC-15 = ${hx(r.crc)}，从 SOF 到 CRC 末尾进行位填充。本实验插入 ${r.stuffCount} 个填充位。数据字节高位先发。`,
  `收发器将 0 变成显性差分电压、1 变成隐性。控制器每个位在 ${fmt(r.timing.samplePercent)}% 处采样。下方播放速度已放慢，时间标签仍是真实协议时间。`,
  `接收端去填充并检查帧与 CRC。正常接收节点确认有效帧，与接收过滤器是否匹配无关。ACK 表示至少一个节点正确接收。`,
  `通过过滤后，数据才交给应用。本例把前两个字节按小端无符号数解释；CAN 本身并不规定这些数据必须代表转速。`
 ]:[
  `应用提交 ${r.data.length} 字节：${data}。每个字节分别装入一个 UART 帧。`,
  `每个字节添加起始位 0、8 个数据位${r.parity==='none'?'':'、一个校验位'}及停止位 1。UART 数据低位先发。`,
  `发送端按 ${fmt(r.baud)} baud 输出 0 / 3.3 V。接收端检测起始下降沿，并用自己的 ${fmt(r.receiverBaud)} baud 时钟，在各位中心附近采样。`,
  `每个字节重新起始同步。发送与接收波特率相差过大，会导致采样位置漂移，出现数据、校验或停止位错误。`,
  `UART 没有 CAN 那样的 ACK。无校验格式下，数据位变化可能不被硬件发现；应用协议可以另加校验与响应。`
 ];$('stage-detail').textContent=detail[state.stage];
}
function renderMetrics(){const r=state.result,t=r.timing,can=state.protocol==='CAN';$('metric-rate').textContent=fmt((can?t.bitrate:r.baud)/1000)+' k'+(can?'bit/s':'baud');$('metric-bit').textContent=fmt(t.bitUs)+' μs';$('sample-caption').textContent=can?'采样点':'接收位时间';$('metric-sample').textContent=can?fmt(t.samplePercent)+'%':fmt(1e6/r.receiverBaud)+' μs';$('metric-length').textContent=r.bits.length+' bit';$('frame-meta').textContent=can?`${r.stuffCount} 个填充位 · 含 3 bit 帧间隔`:`${r.data.length} 个字节帧 · LSB 优先`;$('cursor').max=r.bits.length-1;
 $('scope-description').textContent=can?'差分电压 → 收发器 RX → 控制器采样':'TX 逻辑电压 → RX 起始同步 → 中心采样';
 $('model-note').textContent=can?'波形为发送端典型理想电压，不包含反射、噪声或共模变化。下方放大图单独表示同步后的相对边沿迟到；此条件只做采样裕量演示，不替代往返延迟与线长计算。错误实验保留名义后续位，未展开真实错误帧与重发。':'波形为 3.3 V 逻辑电平示意。接收采样以每字节收到的起始沿对齐；固定传播延迟只平移整帧。假定每个字节起始沿都能重新捕获；严重失配时真实接收器可能漏掉起始沿。未模拟过采样或多数表决。';
 const legend=$('wave-legend');legend.replaceChildren();const entries=can?[['CAN_H',colors.green],['CAN_L',colors.blue],['RX 逻辑（0 / 1）',colors.ink],['● 采样位置',colors.orange]]:[['TX（0 / 3.3 V）',colors.green],['● 接收端采样位置',colors.orange]];entries.forEach(([s,c])=>{const span=el('span');const i=el('i');i.style.background=c;span.append(i,document.createTextNode(s));legend.append(span);});
}
function renderFrame(){const root=$('frame-map');root.replaceChildren();state.result.fields.forEach(f=>{const b=el('button',f.name);b.style.flexGrow=Math.max(1,f.length);b.dataset.field=f.name;b.title=`${fieldNames[f.name]||f.name}：${f.length} 个线上位`;b.onclick=()=>{stop();selectBit(f.start);};b.dataset.start=f.start;b.dataset.end=f.end;root.append(b);});}
function selectBit(i){state.cursor=Math.min(state.result.bits.length-1,Math.max(0,i));renderCursor();}
function windowRange(){const count=Math.max(8,Math.min(24,Math.floor(($('wave').clientWidth-65)/25)));const start=Math.max(0,Math.min(state.result.bits.length-count,state.cursor-Math.floor(count/3)));return {start,end:Math.min(state.result.bits.length,start+count)};}
function renderCursor(){const r=state.result,b=r.bits[state.cursor];$('cursor').value=state.cursor;$('bit-position').textContent=`位 ${state.cursor+1} / ${r.bits.length}`;$('current-time').textContent=fmt(state.cursor*r.timing.bitUs)+' μs';$('previous').disabled=state.cursor===0;$('next').disabled=state.cursor===r.bits.length-1;
 document.querySelectorAll('#frame-map button').forEach(e=>e.classList.toggle('active',state.cursor>=+e.dataset.start&&state.cursor<+e.dataset.end));
 const changed=r.faultIndex===state.cursor;
 $('selected-bit').textContent=`第 ${state.cursor+1} 个线上位 · ${fieldNames[b.field]||b.field} (${b.field}) · 值 ${b.value}${b.stuffed?' · 填充位：接收时删除，不属于原始数据':''}${changed?' · 故障注入：这一位被翻转':''}${state.protocol==='CAN'?' · '+(b.value===0?'显性，典型差分电压 2 V':'隐性，典型差分电压 0 V'):''}`;
 const strip=$('bit-strip');strip.replaceChildren();const {start,end}=windowRange();for(let i=start;i<end;i++){const bit=r.bits[i],bt=el('button',String(bit.value));bt.classList.toggle('stuffed',bit.stuffed);bt.classList.toggle('selected',i===state.cursor);bt.setAttribute('aria-label',`第${i+1}位 ${bit.field} ${bit.value}${bit.stuffed?' 填充位':''}`);bt.setAttribute('aria-pressed',i===state.cursor);bt.onclick=()=>{stop();selectBit(i);};strip.append(bt);}
 drawWave(start,end);drawZoom();
}
function drawWave(start,end){const root=$('wave'),r=state.result,can=state.protocol==='CAN';root.replaceChildren();const w=root.clientWidth||800,h=220,left=53,right=8,dx=(w-left-right)/(end-start);root.setAttribute('viewBox',`0 0 ${w} ${h}`);const x=i=>left+(i-start)*dx;const currentX=x(state.cursor);root.append(svg('rect',{x:currentX,y:7,width:dx,height:184,fill:'#e5f4ed'}));
 const levels=can?[[3.5,32],[2.5,62],[1.5,92]]:[[3.3,38],[0,116]];levels.forEach(([v,y])=>{line(root,left,y,w-right,y);label(root,0,y+4,v+' V');});
 for(let i=start;i<=end;i++){line(root,x(i),10,x(i),190,colors.grid,1);if((i-start)%Math.ceil((end-start)/7)===0)label(root,x(i),210,fmt(i*r.timing.bitUs,1),colors.muted,9,'middle');}
 label(root,w-right,219,'时间 / μs',colors.muted,9,'end');
 const trace=(yFn,color,stroke=2)=>{let d=start===0?`M${left-10} ${yFn(1)} L${left} ${yFn(1)} `:'';for(let i=start;i<end;i++){const y=yFn(r.bits[i].value);d+=(i===start&&start!==0?'M':'L')+x(i)+' '+y+' L'+x(i+1)+' '+y;}root.append(svg('path',{d,fill:'none',stroke:color,'stroke-width':stroke,'stroke-linejoin':'round'}));};
 if(can){trace(v=>v?62:32,colors.green);trace(v=>v?62:92,colors.blue);trace(v=>v?143:172,colors.ink,1.6);label(root,0,147,'RX 1');label(root,0,176,'RX 0');for(let i=start;i<end;i++){const sx=x(i)+dx*r.timing.samplePercent/100,late=state.config.delayNs>=r.timing.sampleNs;root.append(svg('circle',{cx:sx,cy:r.bits[i].value?143:172,r:2.7,fill:late?colors.red:colors.orange}));}}
 else{trace(v=>v?38:116,colors.green);label(root,0,160,'采样');(r.samples||[]).forEach(s=>{const bit=s.timeUs/r.timing.bitUs;if(bit>=start&&bit<end){const xx=x(bit);line(root,xx,130,xx,154,s.ok?colors.orange:colors.red,1);root.append(svg('circle',{cx:xx,cy:s.actual?38:116,r:3,fill:s.ok?colors.orange:colors.red}));label(root,xx,169,String(s.actual),s.ok?colors.orange:colors.red,10,'middle');}});}
 root.onclick=e=>{const rect=root.getBoundingClientRect(),at=(e.clientX-rect.left)/rect.width*w;stop();selectBit(Math.floor((at-left)/dx)+start);};
}
function drawZoom(){const root=$('bit-zoom'),r=state.result,can=state.protocol==='CAN';root.replaceChildren();const w=root.clientWidth||800,left=9,right=w-9,span=right-left;root.setAttribute('viewBox',`0 0 ${w} 104`);
 if(can){const t=r.timing,n=t.totalTq,sp=t.samplePercent/100;const parts=[[0,1,'同步','#dce8e0'],[1,1+t.tseg1,'TSEG1','#d9eee5'],[1+t.tseg1,n,'TSEG2','#e7edf4']];parts.forEach(([a,b,name,fill])=>{root.append(svg('rect',{x:left+a/n*span,y:34,width:(b-a)/n*span,height:25,fill}));if((b-a)/n*span>45)label(root,left+(a+b)/2/n*span,51,name,colors.ink,10,'middle');});if(n<=80)for(let i=0;i<=n;i++)line(root,left+i/n*span,34,left+i/n*span,59,'#ffffff',1);
 const sx=left+sp*span;line(root,sx,24,sx,68,colors.orange,2);label(root,sx,17,'采样 '+fmt(t.sampleNs/1000)+' μs',colors.orange,11,'middle');label(root,left,81,'0 μs');label(root,right,81,fmt(t.bitUs)+' μs',colors.muted,10,'end');
 const delay=state.config.delayNs,dx=left+Math.min(1,delay/t.bitNs)*span;line(root,dx,30,dx,63,delay>=t.sampleNs?colors.red:colors.blue,1.5,'3 3');label(root,left,100,`相对迟到 ${fmt(delay)} ns · ${delay<t.sampleNs?'采样前余量 '+fmt(t.sampleNs-delay)+' ns':'已超过采样点（简化失效条件）'}`,delay<t.sampleNs?colors.muted:colors.red,10);
 $('zoom-caption').textContent=`1 TQ = ${fmt(t.tqNs)} ns · 共 ${n} TQ`;
 }else{const frameBits=r.parity==='none'?10:11;const chosen=r.samples.filter(s=>s.byteIndex===Math.floor(state.cursor/frameBits));const byteIndex=Math.floor(state.cursor/frameBits),base=byteIndex*frameBits*r.timing.bitUs;for(let i=0;i<frameBits;i++){root.append(svg('rect',{x:left+i/frameBits*span,y:30,width:span/frameBits-2,height:27,fill:i===0?'#d9eee5':i===frameBits-1?'#e7edf4':'#f0f4f1'}));label(root,left+(i+.5)/frameBits*span,48,i===0?'起始':i===frameBits-1?'停止':i<=8?'D'+(i-1):'校验',colors.ink,9,'middle');}chosen.forEach(s=>{const frac=(s.timeUs-base)/(frameBits*r.timing.bitUs);if(frac>=0&&frac<=1){const x=left+frac*span;line(root,x,61,x,73,s.ok?colors.orange:colors.red,2);}});label(root,left,96,'橙色短线：接收采样位置；红色：与发送期望不一致',colors.muted,10);$('zoom-caption').textContent='当前字节：起始位 → 数据低位先发 → 停止位';}
 $('zoom-title').textContent=can?'把当前这一位放大':'把当前字节帧放大';
}
function renderResult(){const r=state.result,o=r.outcome,root=$('result');root.replaceChildren();$('result-badge').textContent=o.code;$('result-badge').className='badge '+(o.ok?'good':'bad');root.append(el('div',o.title,'result-title '+(o.ok?'good':'bad')),el('p',o.detail,'result-detail'));
 const rx=r.rxData||[];if(rx.length){const bytes=el('div',undefined,'rx-bytes');rx.forEach(v=>bytes.append(el('span',hex(v))));root.append(bytes);if(rx.length>=2)root.append(el('p',`前两字节，小端 uint16：${rx[0]+rx[1]*256}；大端 uint16：${rx[0]*256+rx[1]}。`,'decode'));}else root.append(el('p',r.data.length===0&&o.ok?'零字节数据帧：没有数据负载。':'应用未获得数据字节。','decode'));
 if(state.protocol==='CAN')root.append(el('p',`总线 ACK：${r.ack?'显性 0':'隐性 1'} · 发送 CRC：${hx(r.crc)}${r.crcReceived!=null?' · 帧内 CRC：'+hx(r.crcReceived):''}${r.crcCalculated!=null?' · 接收重算：'+hx(r.crcCalculated):''}`,'decode'));
 root.append(el('p','显示完整实验的最终预测结果；播放用于回看逐位过程。','hint'));
 const log=$('log');log.replaceChildren();if(state.arbitration)log.append(el('li',state.arbitration.detail));r.logs.forEach(t=>log.append(el('li',t)));
}
function renderArbitration(){const a=state.arbitration;$('arbitration-panel').hidden=!a;if(!a)return;const root=$('arbitration');root.replaceChildren();const grid=el('div',undefined,'arb-grid');[['A','节点 A '+hx(a.idA),'a'],['B','节点 B '+hx(a.idB),'b'],['bus','总线','bus']].forEach(([who,name,key])=>{const row=el('div',undefined,'arb-row');row.append(el('b',name));a.steps.forEach((s,i)=>{const cell=el('span',String(s[key]),'arb-cell');cell.classList.toggle('loss',i===a.lossIndex);if(who!=='bus'&&a.loser===who&&i>a.lossIndex)cell.classList.add('inactive');row.append(cell);});grid.append(row);});root.append(grid,el('p',a.detail,'arb-caption'),el('p','仲裁比较 ID 的 11 位，从高位到低位。退出节点后续不再驱动；表中的浅色值是原计划位。上方波形展示获胜节点的完整帧；两节点使用相同负载。','hint'));}
function preset(){stop();const val=$('preset').value;if(state.protocol==='CAN'){$('receiver').value='normal';$('fault').value='none';$('filter-id').value='';$('delay').value=200;$('payload').value='DC 05';$('can-id').value='200';$('other-id').value='300';$('other-id').disabled=val!=='arbitration';if(val==='stuff')$('payload').value='00 00 00 00 00 00 00 00';if(val==='noack')$('receiver').value='missing';if(val==='filter')$('filter-id').value='123';if(val==='flip')$('fault').value='bitflip';if(val==='delay')$('delay').value=1900;if(val==='arbitration'){$('can-id').value='130';$('other-id').value='120';}}else{$('payload').value='55 A3';$('baud').value=115200;$('rx-baud').value=val==='drift'?85000:115200;$('parity').value=val==='parity'?'even':'none';}build();}
function switchProtocol(protocol){stop();state.protocol=protocol;const can=protocol==='CAN';$('tab-can').classList.toggle('active',can);$('tab-uart').classList.toggle('active',!can);$('tab-can').setAttribute('aria-pressed',can);$('tab-uart').setAttribute('aria-pressed',!can);$('can-fields').hidden=!can;$('can-timing').hidden=!can;$('uart-fields').hidden=can;$('format-label').textContent=can?'经典 CAN · 标准帧':'UART · 异步串行';$('payload-hint').textContent=can?'0–8 字节；DC 05 按小端无符号数解释为 1500。':'1–32 字节；观察 UART 低位先发与 CAN 高位先发的区别。';const options=can?[['normal','01 / 正常收发'],['stuff','02 / 连续 0 与位填充'],['noack','03 / 没有接收节点'],['filter','04 / ACK 成功，但过滤掉'],['flip','05 / 数据位受干扰'],['delay','06 / 信号晚于采样点'],['arbitration','07 / 两个节点同时发送']]:[['normal','01 / 正常收发'],['drift','02 / 接收波特率不匹配'],['parity','03 / 偶校验帧']];$('preset').replaceChildren();options.forEach(([v,t])=>{const o=el('option',t);o.value=v;$('preset').append(o);});preset();}
$('tab-can').onclick=()=>switchProtocol('CAN');$('tab-uart').onclick=()=>switchProtocol('UART');$('preset').onchange=preset;$('build').onclick=build;$('calculate').onclick=applyTiming;
document.querySelectorAll('.settings input,.settings select,.settings textarea').forEach(e=>{if(e.id!=='preset')e.addEventListener('input',()=>{markDirty();if(['clock','brp','seg1','seg2'].includes(e.id))previewTiming();});});
$('cursor').oninput=()=>{stop();selectBit(Number($('cursor').value));};$('next').onclick=()=>{stop();selectBit(state.cursor+1);};$('previous').onclick=()=>{stop();selectBit(state.cursor-1);};$('restart').onclick=()=>{stop();selectBit(0);state.stage=0;renderPipeline();};
function play(){if(state.timer){stop();return;}if(state.dirty){build();if(state.dirty)return;}if(state.cursor>=state.result.bits.length-1)selectBit(0);state.stage=2;renderPipeline();$('play').textContent='Ⅱ 暂停';state.timer=setInterval(()=>{if(state.cursor>=state.result.bits.length-1){stop();state.stage=4;renderPipeline();return;}selectBit(state.cursor+1);},Number($('speed').value));}
$('play').onclick=play;$('speed').onchange=()=>{if(state.timer){stop();play();}};
$('export').onclick=()=>{if(!state.result)return;const blob=new Blob([JSON.stringify({version:1,description:'通信实验室教学模型，非实测',protocol:state.protocol,config:state.config,result:state.result,arbitration:state.arbitration},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='protocol-lab-'+state.protocol.toLowerCase()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
new ResizeObserver(()=>{if(state.result)renderCursor();}).observe($('wave'));
previewTiming();build();
})();
