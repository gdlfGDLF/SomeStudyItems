(()=>{
 'use strict';
 const M=window.BitTimingLab,$=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const fmt=n=>Number(n.toFixed(4)).toString();
 const root=el('details');root.id='timing-lab';root.open=true;
 root.innerHTML=`<summary><span class="eyebrow">位时序放大镜</span><b>一位里面：时钟 → TQ → SEG1 → 采样 → SEG2</b><span>展开 / 收起</span></summary>
 <div class="timing-content"><p class="timing-lead">采样点是 <b>SEG1 结束、SEG2 开始的同一个边界</b>。这一瞬间只读取一次；SEG2 仍属于当前位。</p>
 <div class="timing-presets"><span>试一组参数：</span><button data-timing-preset="normal">500K · 80%</button><button data-timing-preset="fast">FD 数据时序示例 · 2M</button><button data-timing-preset="quantized">16 TQ / 位 · 81.25%</button></div>
 <form id="timing-form"><label>CAN 时钟 / MHz<input id="timing-clock" type="number" min="1" max="400" step="any" value="160" required></label><label>实际分频系数<input id="timing-divider" type="number" min="1" max="256" value="16" required></label><label>TSEG1 / TQ<input id="timing-seg1" type="number" min="1" max="64" value="15" required></label><label>TSEG2 / TQ<input id="timing-seg2" type="number" min="1" max="32" value="4" required></label><label>连续两个数据位<select id="timing-pattern"><option>01</option><option>00</option><option>10</option><option>11</option></select></label></form>
 <p id="timing-error" role="alert" hidden></p><div id="timing-equations"></div>
 <div class="timing-controls"><button id="timing-reset">回到起点</button><button id="timing-clock-next">走 1 个时钟</button><button id="timing-tq-next">到下个 TQ 边界</button><button id="timing-sample-next" class="primary">到下个采样点</button><button id="timing-next-bit">到下一位</button><button id="timing-play">▶ 按 TQ 播放</button></div>
 <div class="timing-scrubber"><input id="timing-seek" type="range" min="0" value="0" step="1" aria-label="位时序原始时钟位置"><output id="timing-position"></output></div>
 <div class="timing-live"><div><span>当前数据位 / 时间段</span><strong id="timing-phase"></strong></div><div><span>当前位已经过</span><strong id="timing-counter"></strong></div><div><span>接收结果 · 只在采样后出现</span><strong id="timing-received"></strong></div></div>
 <p id="timing-event" aria-live="polite"></p>
 <div class="timing-chart-scroll" tabindex="0" aria-label="两个数据位的 TQ 时间轴，可横向滚动"><svg id="timing-chart" role="img" aria-label="同步段、SEG1、SEG2 和唯一采样边界"></svg></div>
 <p class="timing-chart-note">每一小格 = 1 TQ；● = 采样边界；橙色竖线 = 当前计时位置。下面的 RXD 是理想逻辑电平，TQ 刻度本身不会让总线跳变。</p>
 <p id="timing-boundary-note"></p><p id="timing-quantization"></p>
 <details class="timing-scope"><summary>它与仲裁 / 数据阶段、真实电路的关系</summary><p>仲裁时序和 FD 数据时序各有自己的一套分频、TSEG1、TSEG2。这里的预设只切换观察哪一套，不模拟 BRS 位内的速率切换。分频决定一格多长；SEG1 / SEG2 决定每个位内采样前后有多少格。</p><p>这是独立的理想单采样实验，不改变上方帧参数或下方板卡回放。未模拟传播延迟、重同步、SJW、FD 延迟补偿或电压反射；也不是完整 CAN 帧。参数范围为教学范围，实际芯片另有约束；寄存器原始值可能还需要加 1。</p></details>
 </div>`;
 $('family-rule').after(root);
 const state={run:null,tick:0,timer:null,valid:true};
 const presets={normal:{clock:160,divider:16,seg1:15,seg2:4},fast:{clock:160,divider:4,seg1:15,seg2:4},quantized:{clock:160,divider:20,seg1:12,seg2:3}};
 function stop(){if(state.timer)clearInterval(state.timer);state.timer=null;$('timing-play').textContent='▶ 按 TQ 播放';}
 function build(){
  stop();try{state.run=M.build({clockMHz:$('timing-clock').value,divider:$('timing-divider').value,seg1:$('timing-seg1').value,seg2:$('timing-seg2').value,pattern:$('timing-pattern').value});
   state.tick=0;state.valid=true;$('timing-error').hidden=true;$('timing-seek').max=state.run.totalClocks;
   root.querySelectorAll('.timing-controls button').forEach(b=>b.disabled=false);$('timing-seek').disabled=false;
   renderEquations();render();
  }catch(e){state.valid=false;$('timing-error').textContent=e.message+' 下方仍保留上一组结果，修正后自动更新。';$('timing-error').hidden=false;root.querySelectorAll('.timing-controls button').forEach(b=>b.disabled=true);$('timing-seek').disabled=true;}
 }
 function renderEquations(){const r=state.run,c=r.config;$('timing-equations').replaceChildren();
  for(const [label,value,detail] of [
   ['① 原始时钟',fmt(r.clockNs)+' ns / 周期','1000 ÷ '+c.clockMHz],
   ['② 分频形成 TQ',fmt(r.tqNs)+' ns / TQ',c.divider+' 个原始周期 = 1 TQ'],
   ['③ 拼成一个数据位',fmt(r.bitUs)+' μs · '+fmt(r.bitrate/1000)+' kbit/s','1 + '+c.seg1+' + '+c.seg2+' = '+r.totalTq+' TQ / 位'],
   ['④ 到边界采样',fmt(r.samplePercent)+'% · '+fmt(r.sampleUs)+' μs','1 + '+c.seg1+' = '+r.sampleTq+' TQ 后采样']
  ]){const box=el('div');box.append(el('span',label),el('strong',value),el('small',detail));$('timing-equations').append(box);}
  $('timing-boundary-note').textContent=`SEG1 结束与 SEG2 开始，都指当前位起点之后的第 ${r.sampleTq} 个 TQ 边界。不是采两次，也不是进入第二个数据位；再经过 ${c.seg2} TQ，当前位才结束。`;
  const desired=r.totalTq*.8,exact=Math.abs(desired-Math.round(desired))<1e-9;
  $('timing-quantization').textContent=exact?`这组总 TQ 数可以精确配置 80%：${Math.round(desired)} / ${r.totalTq}。当前实际采样比例为 ${fmt(r.samplePercent)}%。`:`若想要 80%，需要 ${fmt(desired)} TQ；常规配置只能用整数 TQ，因此无法精确得到 80%。当前是 ${r.sampleTq} / ${r.totalTq} = ${fmt(r.samplePercent)}%。`;
 }
 function svg(tag,attrs={},text){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));if(text!=null)n.textContent=text;return n;}
 function draw(s){
  const r=state.run,c=r.config,chart=$('timing-chart'),unit=Math.max(30,Math.ceil(360/r.totalTq)),left=24,width=2*r.totalTq*unit+48,height=254,x=q=>left+q*unit;
  chart.replaceChildren();chart.setAttribute('viewBox',`0 0 ${width} ${height}`);chart.style.width=width+'px';chart.style.height=height+'px';
  const text=(xx,y,t,color='#53677d',size=12)=>svg('text',{x:xx,y,fill:color,'font-size':size},t);
  for(let b=0;b<2;b++){
   const start=b*r.totalTq,sample=start+r.sampleTq;
   chart.append(text(x(start),22,`第 ${b+1} 个数据位 · 值 ${c.pattern[b]} · ${fmt(r.bitUs)} μs`,'#1b2c40',13));
   for(let q=0;q<r.totalTq;q++){
    const phase=q===0?'sync':q<r.sampleTq?'seg1':'seg2';
    chart.append(svg('rect',{x:x(start+q),y:46,width:unit,height:42,fill:phase==='sync'?'#dce3ef':phase==='seg1'?'#deecff':'#dbefe8',stroke:'white','data-phase':phase}));
    chart.append(text(x(start+q)+8,73,String(q+1),'#48627b',10));
   }
   chart.append(text(x(start)+7,105,'同步 1 TQ','#53677d',10));
   chart.append(text(x(start+1)+8,38,`SEG1 · ${c.seg1} TQ`,'#3766b0',11));
   chart.append(text(x(sample)+6,105,`SEG2 · ${c.seg2} TQ`,'#087d73',11));
   const done=s.tick>=b*r.clocksPerBit+r.sampleClock;
   chart.append(svg('line',{x1:x(sample),x2:x(sample),y1:42,y2:208,stroke:'#ad7318','stroke-dasharray':'4 3','data-sample-bit':b}));
   chart.append(svg('circle',{cx:x(sample),cy:46,r:5,fill:done?'#b47718':'white',stroke:'#b47718'}));
   chart.append(text(Math.min(x(sample)-8,x(start+r.totalTq)-190),126,`${fmt(r.samplePercent)}% · ${fmt(r.sampleUs)} μs 后采样`,'#986718',10));
   chart.append(svg('line',{x1:x(start),x2:x(start),y1:30,y2:222,stroke:'#aab7c7'}));
   chart.append(text(x(start),242,fmt(b*r.bitUs)+' μs'));
   const level=Number(c.pattern[b]),y=level?155:195;
   chart.append(svg('path',{d:`M ${x(start)} ${y} H ${x(start+r.totalTq)}`,fill:'none',stroke:'#1b4b62','stroke-width':2}));
   if(b&&c.pattern[0]!==c.pattern[1])chart.append(svg('line',{x1:x(start),x2:x(start),y1:155,y2:195,stroke:'#1b4b62','stroke-width':2}));
   chart.append(text(x(start)+6,y-7,`RXD = ${level}`,'#1b4b62',11));
   chart.append(svg('circle',{cx:x(sample),cy:y,r:5,fill:done?'#b47718':'white',stroke:'#b47718'}));
  }
  chart.append(text(x(r.totalTq*2)-30,242,fmt(2*r.bitUs)+' μs'));
  const cursor=x(s.tick/c.divider);chart.append(svg('line',{x1:cursor,x2:cursor,y1:30,y2:221,stroke:'#cf6824','stroke-width':2,'data-cursor':s.tick}));
  // Follow the clock cursor only horizontally; never pull the whole page away from the controls.
  const holder=chart.parentElement;if(cursor<holder.scrollLeft+20||cursor>holder.scrollLeft+holder.clientWidth-30)holder.scrollLeft=Math.max(0,cursor-holder.clientWidth*.6);
 }
 function render(){const r=state.run,s=M.snapshot(r,state.tick);
  $('timing-seek').value=state.tick;$('timing-position').textContent=`${state.tick} / ${r.totalClocks} 时钟 · ${fmt(s.timeUs)} μs`;
  $('timing-phase').textContent=s.finished?'两个数据位已结束':`第 ${s.bitIndex+1} 位 · ${s.phase}`;
  $('timing-counter').textContent=`${s.elapsedTq} 个完整 TQ`+(s.subClock?` + ${s.subClock}/${r.config.divider} 个 TQ`:'');
  $('timing-received').textContent=[0,1].map(i=>{const v=s.samples.find(v=>v.bitIndex===i);return `第 ${i+1} 位：${v?v.value:'等待采样'}`;}).join('　');
  $('timing-event').classList.toggle('sample-now',s.atSample);
  $('timing-event').textContent=s.finished?'本次已采样 2 次。每个数据位各采一次，采样结果不会因为进入 SEG2 再增加一次。':s.atSample?`就在这个边界！SEG1 刚结束，SEG2 刚开始；读取当前第 ${s.bitIndex+1} 位为 ${s.level}。这是同一个采样瞬间。`:s.phase==='TSEG2'?`第 ${s.bitIndex+1} 位已经采样。现在经过 SEG2 的剩余时间；仍属于这一位，不会再次采样。`:`正在第 ${s.bitIndex+1} 位的${s.phase}计时。RXD 当前为 ${s.level}，但还没到本位的采样点，因此不把它记入接收结果。`;
  draw(s);
 }
 function jump(tick){stop();if(!state.valid)return;state.tick=Math.max(0,Math.min(tick,state.run.totalClocks));render();}
 $('timing-form').oninput=build;$('timing-form').onsubmit=e=>{e.preventDefault();build();};
 root.querySelectorAll('[data-timing-preset]').forEach(b=>b.onclick=()=>{Object.entries(presets[b.dataset.timingPreset]).forEach(([key,value])=>$('timing-'+key).value=value);build();});
 $('timing-reset').onclick=()=>jump(0);$('timing-clock-next').onclick=()=>jump(state.tick+1);$('timing-tq-next').onclick=()=>jump(M.nextTq(state.run,state.tick));$('timing-sample-next').onclick=()=>jump(M.nextSample(state.run,state.tick));
 $('timing-next-bit').onclick=()=>jump((Math.floor(state.tick/state.run.clocksPerBit)+1)*state.run.clocksPerBit);
 $('timing-seek').oninput=()=>jump(Number($('timing-seek').value));
 $('timing-play').onclick=()=>{if(state.timer){stop();return;}if(!state.valid)return;if(state.tick===state.run.totalClocks){state.tick=0;render();}$('timing-play').textContent='Ⅱ 暂停';state.timer=setInterval(()=>{state.tick=M.nextTq(state.run,state.tick);render();if(state.tick===state.run.totalClocks)stop();},220);};
 root.addEventListener('toggle',()=>{if(!root.open)stop();else if(state.run)draw(M.snapshot(state.run,state.tick));});window.addEventListener('lab-protocol-change',stop);
 window.addEventListener('resize',()=>{if(state.run&&root.open&&!$('can-lab').hidden)draw(M.snapshot(state.run,state.tick));});
 build();
})();
