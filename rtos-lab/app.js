(() => {
'use strict';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states = {running:'运行',ready:'就绪',blocked:'阻塞',done:'完成'};
const pairs = {'irq-normal':'irq-uncleared','irq-uncleared':'irq-normal','irq-masked':'irq-normal','w1c-correct':'w1c-rmw','w1c-rmw':'w1c-correct','ro-write':'w1c-correct',blocking:'busy-wait','busy-wait':'blocking',inversion:'inheritance',inheritance:'inversion','periodic-relative':'periodic-absolute','periodic-absolute':'periodic-relative'};
const questions = {
 'irq-normal':['外设完成以后，通知任务就等于任务已经执行了吗？',['是，通知就是直接调用任务','不是，任务还需要被调度'],1,'通知改变等待条件；能否立即运行还受 ISR 退出、优先级和调度条件影响。'],
 'irq-uncleared':['电平中断中，只完成控制器 EOI，会清掉外设状态吗？',['会，两者是同一个动作','不会，外设可能继续拉高中断线'],1,'本模型的 IRQ 来源是未清除的锁存状态。EOI 完成控制器处理，不替代外设清源。'],
 'irq-masked':['屏蔽中断后，设备完成状态还可能存在吗？',['可能，状态与屏蔽分别保存','不可能，屏蔽会清除状态'],0,'本模型只屏蔽信号输出，不清除状态；重新使能可能立即产生中断。'],
 'w1c-correct':['STATUS = 0b11，写入 0b01 后剩下什么？',['0b10，只清除 DONE','0b01，直接保存写入值'],0,'W1C 是写 1 清除，不是普通赋值。ERROR 位写入 0，因此保留。'],
 'w1c-rmw':['STATUS 为 3，读出后 OR 1 再写回，会发生什么？',['只清除 DONE','DONE 和 ERROR 都被清除'],1,'读出的 ERROR=1 也被写了回去，W1C 因而清掉它；本场景没有先记录该错误。'],
 'ro-write':['向本实验只读 ID 寄存器写入 0，会怎样？',['改变设备 ID','写入被忽略，ID 不变'],1,'这是本虚拟器件的约定。真实只读寄存器的非法写入效果必须查器件手册。'],
 blocking:['高优先级任务阻塞等待通知时，低优先级任务能运行吗？',['能，如果它就绪且没有更高就绪任务','不能，高优先级永远占用 CPU'],0,'调度器在就绪任务中选择。阻塞任务不会因为优先级高就继续占用 CPU。'],
 'busy-wait':['高优先级任务不断轮询但不阻塞，会发生什么？',['低优先级任务自动轮流执行','在它保持就绪期间，低优先级任务可能无法运行'],1,'本模型是单核固定优先级抢占；外部 IRQ 仍能到来，但低优先级任务的进度受影响。'],
 inversion:['高优先级 H 等低优先级 L 的锁，M 就绪，谁可能先执行？',['M，进一步推迟 L 释放锁','H，因为它优先级最高'],0,'H 已阻塞，不能执行。M 抢占 L，延长 H 的等待，就是这里的优先级反转。'],
 inheritance:['优先级继承暂时提高谁的优先级？',['持锁的低优先级任务','等待锁的高优先级任务'],0,'提高持锁者，让它尽快完成临界区并释放锁；不代表等待者已经获得锁。'],
 'periodic-relative':['每轮执行 2 单位再延时 5 单位，下次开始距本次多远？',['5 单位','7 单位'],1,'相对延时从本轮工作结束时开始，因此工作时间也计入两次开始之间的间隔。'],
 'periodic-absolute':['周期 5、工作 2，按绝对周期释放时，理想开始时刻是什么？',['0、5、10……','0、7、14……'],0,'本模型无更高优先级干扰且工作短于周期。真实系统仍需分析抢占、抖动和超期。']
};
let kind='registers', scenario='irq-normal', run, cursor=0, timer=null;
function model() { return kind==='rtos' ? SchedulerLab : RegisterLab; }
function stop() { clearInterval(timer); timer=null; $('play').textContent='播放'; }
function quiz() {
 const q=questions[scenario];
 $('quiz-question').textContent=q[0]; $('quiz-answer').hidden=true;
 $('quiz-options').innerHTML=q[1].map((a,i)=>'<button type="button" data-answer="'+i+'" aria-pressed="false">'+escape(a)+'</button>').join('');
 $('quiz-options').querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{
   $('quiz-options').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
   $('quiz-answer').textContent=(Number(button.dataset.answer)===q[2]?'判断正确。':'再想一步：')+q[3]; $('quiz-answer').hidden=false;
 }));
 $('takeaway').textContent=q[3];
}
function build() {
 stop();
 try {
   const next=model().run({scenario,...(kind==='rtos'?{workTicks:Number($('work').value),horizon:Number($('horizon').value)}:{})});
   if (!next.steps.length) throw new Error('实验没有生成事件。');
   run=next; cursor=0; $('validation').hidden=true; $('dirty').textContent='';
 } catch(error) { $('validation').textContent=error.message; $('validation').hidden=false; return; }
 $('title').textContent=run.title; $('description').textContent=run.description;
 $('kind-label').textContent=kind==='rtos'?'调度实验 / 单核固定优先级':'寄存器实验 / 虚拟外设';
 $('rtos-options').hidden=kind!=='rtos'; $('register-view').hidden=kind!=='registers'; $('scheduler-view').hidden=kind!=='rtos';
 $('seek').max=run.steps.length-1;
 $('limits').innerHTML=(run.limits||[]).map(x=>'<li>'+escape(x)+'</li>').join('');
 document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));
 $('scenarios').innerHTML=model().scenarios.map(s=>'<button type="button" data-scenario="'+escape(s.id)+'" aria-pressed="'+(s.id===scenario)+'">'+escape(s.title)+'</button>').join('');
 $('scenarios').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{scenario=b.dataset.scenario;build();}));
 $('compare').textContent='切换对照场景 →';
 quiz(); render();
}
function signal(label,value,active=false) {return '<div class="signal'+(active?' active':'')+'"><span>'+escape(label)+'</span><b>'+escape(value)+'</b></div>';}
function render() {
 const step=run.steps[cursor], s=step.snapshot;
 $('position').textContent=(cursor+1)+' / '+run.steps.length; $('seek').value=cursor;
 $('previous').disabled=cursor===0; $('next').disabled=cursor===run.steps.length-1;
 $('event-label').textContent=kind==='rtos'?'t = '+step.tick+' · '+(step.actor||'—'):'事件 '+cursor+' · '+(step.actor||'—');
 $('event-title').textContent=step.title; $('event-detail').textContent=step.detail; $('code').textContent=step.code||'// 此步骤没有软件操作';
 $('result').hidden=cursor!==run.steps.length-1;
 $('result').className=run.result.tone==='warn'?'warn':'';
 $('result').innerHTML='<strong>'+escape(run.result.title)+'</strong><p>'+escape(run.result.detail)+'</p>';
 $('log').innerHTML=run.steps.slice(0,cursor+1).map((e,i)=>'<li>'+escape((kind==='rtos'?'t='+e.tick:'步骤 '+i)+' · '+e.title)+'</li>').join('');
 $('log').scrollTop=$('log').scrollHeight;
 if(kind==='registers'){
   $('registers').innerHTML=s.registers.map(r=>{
     const bits=Array.from({length:8},(_,i)=>7-i).map(b=>'<div class="bit'+((r.value>>>b)&1?' on':'')+'"><small>'+b+'</small>'+((r.value>>>b)&1)+'</div>').join('');
     return '<div class="register"><div><b>'+escape(r.name)+'</b><small>偏移 '+escape(r.offset)+' · '+escape(r.access)+'</small></div><div class="bits" aria-label="'+escape(r.name)+' 的低八位">'+bits+'</div><code class="value">0x'+(r.value>>>0).toString(16).toUpperCase().padStart(8,'0')+'</code><p class="reg-desc">'+escape(r.description)+'</p></div>';
   }).join('');
   $('signals').innerHTML=signal('外设 IRQ 线',s.irqLine?'有效':'无效',s.irqLine)+signal('中断使能',s.irqEnabled?'已使能':'已屏蔽')+signal('处理上下文',s.inIsr?'正在 ISR':'非 ISR',s.inIsr)+signal('任务状态',states[s.taskState]||s.taskState)+signal('通知 / 已处理',s.notifications+' / '+s.handled)+signal('进入 ISR 次数',s.irqEntries);
 } else {
   $('timeline').innerHTML=run.steps.map((e,i)=>'<button class="'+(i>cursor?'future':'actor-'+e.actor)+'" data-step="'+i+'" aria-label="'+escape('步骤 '+i+'，t='+e.tick+'，'+(i>cursor?'尚未回放':e.title))+'" aria-current="'+(i===cursor)+'" '+(i>cursor?'disabled':'')+'><small>'+e.tick+'</small>'+(i>cursor?'·':escape(e.actor==='idle'?'—':e.actor))+'</button>').join('');
   $('timeline').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{stop();cursor=Number(b.dataset.step);render();}));
   $('tasks').innerHTML=s.tasks.map(t=>'<tr><td><b>'+escape(t.name)+'</b></td><td>'+t.basePriority+' → '+t.effectivePriority+'</td><td><span class="state '+escape(t.state)+'">'+escape(states[t.state]||t.state)+'</span></td><td>'+escape(t.note)+'</td></tr>').join('');
   $('scheduler-status').innerHTML=signal('当前任务 / 上下文',s.running||'—')+signal('互斥锁持有者',s.mutex.owner||'无')+signal('待消费通知',s.notifications)+signal('逻辑时间',s.time);
 }
}
$('config-form').addEventListener('submit',e=>{e.preventDefault();build();});
for(const id of ['work','horizon']) $(id).addEventListener('change',()=>{$('dirty').textContent='参数已修改，点击生成后生效。';});
document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.kind;scenario=kind==='rtos'?'blocking':'irq-normal';build();}));
$('compare').addEventListener('click',()=>{scenario=pairs[scenario];build();});
$('previous').addEventListener('click',()=>{stop();cursor=Math.max(0,cursor-1);render();});
$('next').addEventListener('click',()=>{stop();cursor=Math.min(run.steps.length-1,cursor+1);render();});
$('finish').addEventListener('click',()=>{stop();cursor=run.steps.length-1;render();});
$('seek').addEventListener('input',()=>{stop();cursor=Number($('seek').value);render();});
function play() {
 if(timer){stop();return;}
 if(cursor===run.steps.length-1){cursor=0;render();}
 $('play').textContent='暂停';
 timer=setInterval(()=>{cursor=Math.min(cursor+1,run.steps.length-1);render();if(cursor===run.steps.length-1)stop();},Number($('speed').value));
}
$('play').addEventListener('click',play);
$('speed').addEventListener('change',()=>{if(timer){stop();play();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
$('export').addEventListener('click',()=>{
 const data={format:'embedded-rtos-lab-v1',cursor,simulation:run};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=kind+'-'+scenario+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
build();
})();
