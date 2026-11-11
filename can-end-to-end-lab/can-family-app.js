/* UI for the independent CAN family model; board-specific classic trace stays separate. */
(()=>{
 'use strict';
 const C=window.CanFormats,$=id=>document.getElementById(id);
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const root=el('section');root.id='can-family';root.className='panel family-panel';
 root.innerHTML=`
 <div class="family-heading"><div><p class="eyebrow">CAN / 从帧类型到每一个字段</p><h1>同一条消息，不同的帧格式。</h1><p>先选帧，再看 SOF、ID、DATA、CRC 各占多少位。<b>1 字节 = 8 位；线上字段不需要凑整字节。</b></p></div><span class="family-badge">9 种组合<br>经典 CAN · FD · XL</span></div>
 <form id="family-form">
 <label class="family-type">帧类型<select id="family-type"></select></label>
 <label><span id="family-id-label">ID / HEX</span><input id="family-id" value="200" autocomplete="off"></label>
 <label id="family-request-box" hidden>请求的字节数 / DLC<select id="family-request"></select></label>
 <label>仲裁位速率<select id="family-nominal"><option value="125000">125 kbit/s</option><option value="250000">250 kbit/s</option><option value="500000" selected>500 kbit/s</option><option value="1000000">1 Mbit/s</option></select></label>
 <label id="family-rate-box" hidden>数据位速率<select id="family-rate"><option value="1000000">1 Mbit/s</option><option value="2000000" selected>2 Mbit/s</option><option value="5000000">5 Mbit/s</option><option value="10000000">10 Mbit/s</option><option value="20000000">20 Mbit/s</option></select></label>
 <label id="family-esi-box" hidden>发送端错误状态<select id="family-esi"><option value="0">ESI=0 · 错误主动</option><option value="1">ESI=1 · 错误被动</option></select></label>
 <div id="family-xl-options" hidden><label>SDT / HEX<input id="family-sdt" value="00" maxlength="2"></label><label>VCID / HEX<input id="family-vcid" value="00" maxlength="2"></label><label>AF / HEX，32 位<input id="family-af" value="00000001" maxlength="8"></label></div>
 <label id="family-data-box">DATA / HEX <span id="family-data-hint"></span><textarea id="family-data" rows="2" spellcheck="false">DC 05</textarea></label>
 <div class="family-form-actions"><button type="submit" class="primary">生成帧 / 重置</button><span>快捷填入示例：</span><button type="button" data-family-bytes="8">8 B</button><button type="button" data-family-bytes="64">64 B</button><button type="button" data-family-bytes="256">256 B</button><button type="button" data-family-bytes="2048">2048 B</button></div>
 </form>
 <p id="family-error" role="alert" hidden></p><p id="family-edit-note" class="fine-print"></p>
 <div id="family-summary" class="family-summary"></div><p id="family-rule" class="family-callout"></p>
 <div class="heading family-section-heading"><div><span class="eyebrow">01 / 格式预览 · 点击字段跳转</span><h2>字段按这个顺序发送</h2></div><span class="muted">色块宽度不按位数比例；不含插入的填充位</span></div>
 <div id="family-ribbon" aria-label="CAN 帧字段顺序"></div>
 <div class="family-playback"><div class="heading"><h2>应用 → 内核 / 驱动 → 控制器 → 总线 → ACK → TxDone</h2><div class="controls"><button id="family-reset" aria-label="帧回放回到起点">↶</button><button id="family-prev">上一步</button><button id="family-play" class="primary">▶ 播放</button><button id="family-next">下一步</button><button id="family-finish">到结果</button></div></div><div id="family-path"></div><div class="scrubber"><span id="family-position"></span><input id="family-seek" type="range" min="0" value="0" aria-label="CAN 帧字段回放位置"></div><div id="family-event" aria-live="polite"></div><div class="family-received"><div><label>对端还原出的 ID</label><strong id="family-decoded-id">等待 ID</strong></div><div><label>对端看到的 DATA</label><code id="family-decoded-data">等待 DATA</code></div><div><label>确认与完成</label><strong id="family-status">尚未 ACK</strong></div></div></div>
 <div class="heading family-section-heading"><div><span class="eyebrow">02 / 长度与含义</span><h2>每个字段到底占多少</h2></div><button id="family-export">导出这次帧回放</button></div>
 <p class="fine-print">“字节等价”只是换算，不代表补零或内存占用。偏移按去填充后的协议位计算，不能直接当作线上第几位。</p>
 <div class="family-table-scroll"><table class="family-table"><thead><tr><th>字段</th><th>位数</th><th>字节等价</th><th>本帧内容</th><th>速率阶段</th><th>用途</th></tr></thead><tbody id="family-fields"></tbody></table></div>
 <div class="family-bottom"><section><h2>填充位另算，不能塞进 ID 的长度</h2><p id="family-stuffing"></p><div id="family-wire-box"><p class="fine-print">经典 CAN 当前字段的线上位；橙色为控制器插入、接收端丢弃的填充位。</p><div id="family-wire-bits"></div></div></section><section><h2>这张图模拟到哪里</h2><p id="family-fidelity"></p><p>回放表示字段和流程顺序，不按真实时间比例。ACK 成功是假设的正常场景；远程请求的响应数据需要另发一帧。</p><p>CAN FD / XL 没有远程帧。错误帧、过载帧属于协议事件，不是带 ID / DATA 的另一种数据帧。</p></section></div>
 <details class="family-reference"><summary>展开对照：所有类型、DLC、错误帧与资料来源</summary><div class="family-table-scroll"><table class="family-table"><thead><tr><th>类型</th><th>ID</th><th>DATA</th><th>CRC 序列</th><th>速率</th></tr></thead><tbody id="family-comparison"></tbody></table></div><p>FD 的 DLC 对照：0–8 → 同数字节；9 → 12 B；10 → 16 B；11 → 20 B；12 → 24 B；13 → 32 B；14 → 48 B；15 → 64 B。XL 的 11 位 DLC 编码为字节数减 1。</p><p>经典 CAN / FD 的主动错误标志：单节点发 6 个显性位；多个节点叠加可形成 6–12 个显性位，之后为 8 位错误界定符。被动错误标志为 6 个隐性位。过载标志为 6 个显性位，过载界定符为 8 位；叠加会延长标志。这里不回放错误恢复，也不把这些规则直接套用到 XL。</p><div id="family-sources"></div></details>
 <p id="family-classic-link" class="family-callout">下方保留标准经典 CAN 的板卡详细实验：电压、逐位采样、DMA 包和七种失败场景。它有独立参数；此处的“生成帧”会同步 ID / DATA / 位速率。</p>`;
 $('can-lab').prepend(root);
 const state={run:null,index:0,timer:null,dirty:false,protocol:'CAN'};
 C.TYPES.forEach(t=>{const o=el('option',t.name);o.value=t.key;$('family-type').append(o);});
 for(let i=0;i<=8;i++){const o=el('option',String(i));o.value=i;$('family-request').append(o);}$('family-request').value='8';
 const path=[['app','应用'],['kernel','Linux 内核'],['driver','驱动'],['mac','控制器 / MAC'],['wire','收发器 / 总线'],['ack','ACK'],['peer','对端'],['report','设备报告'],['done','TxDone']];
 path.forEach(([key,name])=>{const b=el('button',name);b.dataset.familyStage=key;b.onclick=()=>jump(state.run.steps.findIndex(s=>s.stage===key));$('family-path').append(b);});
 for(const t of C.TYPES){const tr=el('tr');const values=[t.name,t.family==='XL'?'Priority 11 bit + AF 32 bit':t.extended?'29 bit = 11 + 18':'11 bit',t.remote?'0 B；DLC 请求 0–8 B':t.family==='XL'?'1–2048 B':t.family==='FD'?'0–64 B（离散长度）':'0–8 B',t.family==='XL'?'PCRC 13 bit + FCRC 32 bit':t.family==='FD'?'17 bit（≤16 B）/ 21 bit（≥20 B）':'15 bit',t.family==='XL'?'ADS / DAS 切换':t.brs?'BRS=1，分阶段':'单速率'];values.forEach(v=>tr.append(el('td',v)));$('family-comparison').append(tr);}
 C.sources.forEach(s=>{const a=el('a',s.title);a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';$('family-sources').append(a);});
 function stop(){if(state.timer)clearInterval(state.timer);state.timer=null;$('family-play').textContent='▶ 播放';}
 const type=()=>C.TYPES.find(t=>t.key===$('family-type').value);
 function configure(){
  const t=type(),xl=t.family==='XL',fd=t.family==='FD';
  $('family-request-box').hidden=!t.remote;$('family-data-box').hidden=t.remote;$('family-rate-box').hidden=!(t.brs||xl);$('family-esi-box').hidden=!fd;$('family-xl-options').hidden=!xl;
  $('family-id-label').textContent=(xl?'优先级 ID':t.extended?'29 位 ID':'11 位 ID')+' / HEX';
  $('family-id').maxLength=t.extended?10:5;
  $('family-data-hint').textContent=xl?'· 1–2048 字节':fd?'· 0–8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 字节':'· 0–8 字节';
  root.querySelectorAll('[data-family-bytes]').forEach(b=>b.hidden=t.remote||Number(b.dataset.familyBytes)>(xl?2048:fd?64:8));
  $('classic-can-detail').hidden=t.key!=='cc-base';$('family-classic-link').hidden=t.key!=='cc-base';
 }
 function rawConfig(){return {type:type().key,id:$('family-id').value,data:type().remote?'':$('family-data').value,requestDlc:$('family-request').value,nominalRate:$('family-nominal').value,dataRate:$('family-rate').value,esi:$('family-esi').value,sdt:$('family-sdt').value,vcid:$('family-vcid').value,af:$('family-af').value};}
 function build(sync=true){
  stop();try{
   const run=C.build(rawConfig());state.run=run;state.index=0;state.dirty=false;$('family-error').hidden=true;
   $('family-edit-note').textContent='已生成。点击色块查看字段，或播放整段发送流程。';$('family-seek').max=run.steps.length-1;
   renderFormat();render();
   if(sync&&run.type.key==='cc-base'){$('identifier').value=run.config.id.toString(16);$('payload').value=run.hexData;$('bitrate').value=String(run.config.nominalRate);$('config-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
  }catch(e){state.dirty=true;$('family-error').textContent=e.message;$('family-error').hidden=false;$('family-edit-note').textContent='生成失败：下方仍是上一帧的结果。修正参数后重新生成。';}
 }
 function valueText(f){if(f.bits===0)return '无此线上字段';if(f.bitString===null)return ['ADS','DAS','FCP'].includes(f.key)?'阶段转换 / 检查模式':'未计算 · 字段示意';if(f.key==='DATA')return state.run.hexData.length>110?state.run.hexData.slice(0,110)+'…':state.run.hexData;if(f.bits>8)return '0x'+f.value.toString(16).toUpperCase()+' · '+f.bitString;return f.bitString;}
 function renderFormat(){
  const r=state.run,c=r.config;
  $('family-summary').replaceChildren();
  for(const [label,value] of [['ID 长度',r.type.extended?'29 bit = 3 B + 5 bit':'11 bit = 1 B + 3 bit'],['实际 DATA',c.data.length+' B'],['协议字段合计',r.frameBits+' bit'],['线上填充',r.wireFrameBits===null?'另加 · 未生成完整位流':r.stuffing.dynamic+' bit']]){const box=el('div');box.append(el('span',label),el('strong',value));$('family-summary').append(box);}
  $('family-rule').textContent=r.type.remote?`远程帧 = 发起请求，不带数据。本帧 RTR=1、DLC=${c.dlc}，仍然 DATA=0 B。`:r.type.family==='XL'?'XL 的“XL”不代表扩展 ID：它使用 11 位优先级 ID 和独立的 32 位 AF；数据最长 2048 B。':r.type.family==='FD'?`ISO CAN FD：${r.type.extended?'29':'11'} 位 ID，BRS=${Number(r.type.brs)}。${r.type.brs?'数据阶段使用 '+(c.dataRate/1e6)+' Mbit/s，ACK 回到仲裁速率。':'关闭 BRS 时，DATA 也使用 '+(c.nominalRate/1000)+' kbit/s。'}`:'经典标准帧：SOF=1 位，ID=11 位。它们拼接发送，没有为 ID 补到 16 位的操作。';
  $('family-ribbon').replaceChildren();$('family-fields').replaceChildren();
  r.fields.forEach((f,i)=>{
   const b=el('button');b.className='family-field '+f.group;b.dataset.fieldIndex=i;b.append(el('b',f.key),el('span',f.bits+' bit · '+f.byteSize));b.onclick=()=>jump(i+4);$('family-ribbon').append(b);
   const tr=el('tr');tr.dataset.fieldIndex=i;const first=el('td'),link=el('button',f.key);link.onclick=()=>jump(i+4);first.append(link);tr.append(first);
   [String(f.bits),f.byteSize,valueText(f),f.phase==='data'?c.dataRate/1000+' kbit/s':f.phase==='switch'?'速率切换边界':c.nominalRate/1000+' kbit/s',f.meaning].forEach(v=>tr.append(el('td',v)));$('family-fields').append(tr);
  });
  $('family-stuffing').textContent=r.stuffing.rule+' '+(r.wireFrameBits===null?(r.type.family==='FD'?`本长度的 CRC 区固定填充 ${r.stuffing.fixed} 位；动态数量未计算。`:'此处不计算 XL 线上总位数。'):`本帧实际插入 ${r.stuffing.dynamic} 位；SOF 到 EOF 共 ${r.wireFrameBits} 位，之后另有最少 3 位间歇段。`);
  $('family-fidelity').textContent=r.fidelity+'。协议字段合计不含填充、不含帧间隔；内存结构大小与此不同。';
  $('family-wire-box').hidden=!r.wireBits;
 }
 function render(){
  const r=state.run,s=r.steps[state.index],fi=s.fieldIndex;
  $('family-seek').value=state.index;$('family-position').textContent=`${state.index+1} / ${r.steps.length}`;
  $('family-event').replaceChildren(el('h3',s.title),el('p',s.detail));
  if(fi!==null){const f=r.fields[fi],code=el('code',f.bitString===null?'本字段没有伪造的 0/1；请在表格中查看宽度和作用。':f.bitString.length>128?f.bitString.slice(0,128)+'…（仅预览前 128 位）':f.bitString||'DATA 为空');$('family-event').append(code);}
  const completeField=state.index>=4?Math.min(state.index-4,r.fields.length-1):-1;
  root.querySelectorAll('[data-field-index]').forEach(n=>{n.classList.toggle('active',Number(n.dataset.fieldIndex)===fi);n.classList.toggle('past',Number(n.dataset.fieldIndex)<completeField);});
  root.querySelectorAll('[data-family-stage]').forEach(n=>n.classList.toggle('active',n.dataset.familyStage===(s.stage==='gap'?'wire':s.stage)));
  const has=key=>r.fields.findIndex(f=>f.key===key)<=completeField&&r.fields.some(f=>f.key===key);
  $('family-decoded-id').textContent=has(r.type.extended?'ID-B':r.type.family==='XL'?'Priority ID':'ID')?'0x'+r.config.id.toString(16).toUpperCase()+(r.type.extended?' · 11 + 18 位合并':''):'等待 ID';
  $('family-decoded-data').textContent=has('DATA')?(r.type.remote?'无 DATA · 这是请求帧':r.hexData.length>140?r.hexData.slice(0,140)+'…（'+r.config.data.length+' B）':r.hexData||'0 B'):'等待 DATA';
  $('family-status').textContent=s.stage==='done'?'本地 TxDone（正常场景）':has('ACK')?'总线已 ACK（场景假设）；尚未 TxDone':'尚未 ACK';
  $('family-wire-bits').replaceChildren();
  if(r.wireBits){const f=fi===null?null:r.fields[fi],filtered=f?r.wireBits.filter(b=>b.field===f.key):[];if(!filtered.length)$('family-wire-bits').append(el('span','选择一个字段，查看它的线上位。'));else filtered.forEach(b=>{const bit=el('span',String(b.value));bit.className=b.stuffed?'stuffed':'';bit.title=`线上位 #${b.index+1} · ${b.stuffed?'填充位，不参与字段解析':b.field}`;$('family-wire-bits').append(bit);});}
 }
 function jump(n){stop();if(state.dirty){$('family-edit-note').textContent='参数已修改；当前仍在回放上一帧，请生成后再比较。';}state.index=Math.max(0,Math.min(Number(n),state.run.steps.length-1));render();}
 function play(){if(state.timer){stop();return;}if(state.dirty){build();if(state.dirty)return;}if(state.index===state.run.steps.length-1)state.index=0;$('family-play').textContent='Ⅱ 暂停';state.timer=setInterval(()=>{state.index=Math.min(state.index+1,state.run.steps.length-1);render();if(state.index===state.run.steps.length-1)stop();},650);}
 function exportRun(){const blob=new Blob([JSON.stringify({description:state.run.fidelity,currentStep:state.index,simulation:state.run},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='can-'+state.run.type.key+'-frame.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 $('family-form').onsubmit=e=>{e.preventDefault();build();};
 $('family-form').oninput=()=>{stop();state.dirty=true;$('family-edit-note').textContent='参数已修改。下方保留上一次结果，点击“生成帧 / 重置”应用。';};
 $('family-type').onchange=()=>{stop();window.dispatchEvent(new CustomEvent('lab-protocol-change',{detail:'CAN'}));const t=type();$('family-id').value=t.extended?'1ABCDE':'200';$('family-data').value='DC 05';configure();build();};
 root.querySelectorAll('[data-family-bytes]').forEach(b=>b.onclick=()=>{$('family-data').value=C.hexBytes(Array.from({length:Number(b.dataset.familyBytes)},(_,i)=>i%256));build();});
 $('family-prev').onclick=()=>jump(state.index-1);$('family-next').onclick=()=>jump(state.index+1);$('family-reset').onclick=()=>jump(0);$('family-finish').onclick=()=>jump(state.run.steps.length-1);$('family-seek').oninput=()=>jump($('family-seek').value);$('family-play').onclick=play;$('family-export').onclick=exportRun;
 const exportExisting=$('export').onclick;$('export').onclick=()=>{if(state.protocol==='CAN'&&state.run.type.key!=='cc-base')exportRun();else exportExisting();};
 window.addEventListener('lab-protocol-change',e=>{stop();state.protocol=e.detail;});
 configure();build(false);
})();
