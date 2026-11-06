/* Single-core teaching scheduler, not FreeRTOS execution or measured hardware timing.
 * References: https://www.freertos.org/Documentation/02-Kernel/02-Kernel-features/01-Tasks-and-co-routines/04-Task-scheduling
 * https://www.freertos.org/Real-time-embedded-RTOS-mutexes.html
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SchedulerLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const scenarios = [
    {id:'blocking',title:'等待通知：让出 CPU',description:'采集任务阻塞等待；外部事件在第 6 拍触发中断，唤醒采集任务。'},
    {id:'busy-wait',title:'忙等：占住 CPU',description:'同样等待第 6 拍的外部事件，但采集任务始终保持就绪，持续查询。'},
    {id:'inversion',title:'优先级反转',description:'用无继承的二值信号量充当锁：低优先级任务持锁，高优先级任务等锁，中优先级任务延迟释放锁。'},
    {id:'inheritance',title:'优先级继承',description:'改用具备优先级继承的互斥锁，对比低优先级持锁任务的临时提权与恢复。'},
    {id:'periodic-relative',title:'相对延时：周期逐渐偏移',description:'每轮工作结束后再等待 5 拍；执行时间也会计入相邻两轮的间隔。'},
    {id:'periodic-absolute',title:'固定周期：按计划唤醒',description:'按 0、5、10… 的计划释放采集任务；本模型每轮工作少于 5 拍。'}
  ].map(Object.freeze);
  Object.freeze(scenarios);
  const limits = [
    '单核、固定优先级、抢占式教学模型：数字越大，优先级越高；不模拟 SMP、相同优先级时间片和调度开销。',
    '“拍”是逻辑时间单位。浏览器播放速度只影响观看速度，不代表 RTOS tick 时长、CPU 频率或真实中断延迟。',
    '同一拍可以有多个瞬时边界事件。标为运行区间的步骤才消耗 1 拍；状态是该步骤执行时可观察的快照。',
    '通知场景只有一次外部 IRQ（t=6），使用计数式通知并在任务取得通知时消耗一次；不是完整 FreeRTOS 移植。',
    '无继承组模拟用二值信号量承担互斥；继承组模拟 FreeRTOS mutex。不是关闭 FreeRTOS mutex 的继承开关。只有一把锁和一个等待者，无嵌套锁、超时或链式继承。',
    '周期场景每轮执行 1–4 拍、周期 5 拍且没有更高优先级任务，因此绝对周期实验不包含过载或截止时间错失。'
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  function configuration(options) {
    if (options === undefined) options = {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('参数必须是对象');
    const config = {
      scenario:options.scenario === undefined ? 'blocking' : options.scenario,
      workTicks:options.workTicks === undefined ? 2 : options.workTicks,
      horizon:options.horizon === undefined ? 18 : options.horizon
    };
    if (!scenarios.some(item=>item.id===config.scenario)) throw new RangeError('未知调度场景');
    if (!Number.isInteger(config.workTicks)||config.workTicks<1||config.workTicks>4) throw new RangeError('采集任务每轮工作量必须是 1–4 拍的整数');
    if (!Number.isInteger(config.horizon)||config.horizon<12||config.horizon>36) throw new RangeError('观察窗口必须是 12–36 拍的整数');
    return config;
  }
  function task(id,name,priority,remaining,state,note) {
    return {id,name,basePriority:priority,effectivePriority:priority,remaining,state:state||'ready',note:note||'',phase:'work'};
  }
  function simulate(config) {
    const isWait = ['blocking','busy-wait'].includes(config.scenario);
    const isMutex = ['inversion','inheritance'].includes(config.scenario);
    const isPeriodic = config.scenario.startsWith('periodic-');
    const inherit = config.scenario === 'inheritance';
    const tasks = [
      task('H','采集任务',3,config.workTicks),
      task('M','通信任务',2,isPeriodic?4:8),
      task('L','日志任务',1,isMutex?4:(isPeriodic?config.horizon:4))
    ];
    const H=tasks[0],M=tasks[1],L=tasks[2];
    const state={tasks,time:0,owner:null,notifications:0,steps:[],metrics:{
      work:{H:0,M:0,L:0},busyTicks:0,irqCount:0,highBlockedAt:null,highAcquiredAt:null,
      highWaitTicks:0,periodicStarts:[],period:5
    }};
    if(isWait){H.phase='wait';H.note='等待 t=6 的外部完成事件';}
    if(isMutex){
      state.owner='L';
      L.note='开始观察前已持有互斥锁，临界区还需 4 拍';
      H.state='blocked';H.note='尚未到任务释放时刻 t=1';H.phase='acquire';
      M.state='blocked';M.note='尚未到任务释放时刻 t=2';
    }
    if(isPeriodic){H.phase='periodic';H.nextRelease=0;H.cycleStarted=false;}
    function emit(actor,event,title,detail,code,duration) {
      const running = duration ? actor : (actor==='ISR'?'ISR':'');
      const observed = tasks.map(t=>({
        id:t.id,name:t.name,basePriority:t.basePriority,effectivePriority:t.effectivePriority,
        state:running===t.id?'running':t.state,note:t.note
      }));
      state.steps.push({actor,tick:state.time,event,duration:duration||0,title,detail,code:code||'',
        snapshot:{time:state.time,running,tasks:observed,mutex:{owner:state.owner},
          notifications:state.notifications,metrics:clone(state.metrics)}});
    }
    function pick() {
      return tasks.filter(t=>t.state==='ready').sort((a,b)=>b.effectivePriority-a.effectivePriority||a.id.localeCompare(b.id))[0];
    }
    function advanceWork(t) {
      t.remaining--;
      state.metrics.work[t.id]++;
      state.time++;
      if(t.remaining>0) return;
      if(isPeriodic&&t===H){
        H.state='blocked';H.cycleStarted=false;
        H.nextRelease=config.scenario==='periodic-relative'?state.time+5:H.nextRelease+5;
        H.note='本轮结束；等待计划时刻 t='+H.nextRelease;
        emit('H','delay','采集任务进入延时',
          (config.scenario==='periodic-relative'?'从本轮结束时刻起再等待 5 拍。':'下一次唤醒沿用固定 5 拍周期的时间基准。')+
          ' 下一次就绪时刻为 t='+H.nextRelease+'；进入阻塞态后其他任务可运行。',
          config.scenario==='periodic-relative'?'vTaskDelay(period);':'vTaskDelayUntil(&lastWake, period);',0);
      }else{
        t.state='done';t.note='本次示例工作已完成';
        if(isMutex&&state.owner===t.id){
          state.owner=null;t.effectivePriority=t.basePriority;
          if(t===L&&H.phase==='acquire'){H.state='ready';H.note='锁已释放，等待调度后重新取得锁';}
          emit(t.id,'unlock',t.name+'释放互斥锁',
            '互斥锁变为空闲；等待者可以变为就绪，但只有取得 CPU 后才继续。持锁任务恢复基础优先级。',
            inherit?'xSemaphoreGive(mutex);':'xSemaphoreGive(binaryGate);',0);
        }
        emit(t.id,'complete',t.name+'完成',
          '本次有限实验中的工作已结束。done 表示结束本次示例，不是 FreeRTOS 的标准任务状态名称。',
          '/* 本次工作结束 */',0);
      }
    }
    emit('idle','initial','观察初始状态',
      isMutex?'低优先级任务已持锁。H 在 t=1 就绪，M 在 t=2 就绪；只比较这一个锁的调度结果。':
      isWait?'H 优先级 3，M 为 2，L 为 1；外部 IRQ 固定在 t=6 到达。':
      'H 每轮工作 '+config.workTicks+' 拍，目标周期为 5 拍；M、L 在空闲期间处理后台工作。',
      '/* 先看任务优先级与状态，再单步 */',0);
    while(state.time<config.horizon){
      const now=state.time;
      if(isWait&&now===6&&state.metrics.irqCount===0){
        state.notifications++;state.metrics.irqCount++;
        if(H.state==='blocked'){H.state='ready';H.note='IRQ 已到达，等待运行并取得通知';}
        emit('ISR','irq','外部完成中断到达',
          'ISR 增加通知计数，并使等待通知的任务就绪。中断退出后按最高就绪优先级调度；不是等到下一个时间片才允许切换。',
          'vTaskNotifyGiveFromISR(task, &higherPriorityWoken);\nportYIELD_FROM_ISR(higherPriorityWoken);',0);
      }
      if(isMutex&&now===1&&H.state==='blocked'&&H.note.includes('释放')){
        H.state='ready';H.note='开始工作，首先需要取得互斥锁';
        emit('H','release','高优先级采集任务就绪','H 在 t=1 被释放，优先级 3，先尝试获取 L 持有的锁。','/* 任务释放 */',0);
      }
      if(isMutex&&now===2&&M.state==='blocked'){
        M.state='ready';M.note='通信工作需要 8 拍，不使用这把锁';
        emit('M','release','中优先级通信任务就绪','M 不依赖这把锁，因此可以正常参与优先级调度。','/* 任务释放 */',0);
      }
      if(isPeriodic&&H.state==='blocked'&&now>=H.nextRelease){
        H.state='ready';H.remaining=config.workTicks;H.note='延时到期，等待调度';
        emit('H','release','采集任务延时到期','达到 t='+H.nextRelease+'，采集任务从阻塞变为就绪。','/* 延时到期 */',0);
      }
      let selected=pick();
      // Blocking calls and successful lock/notification acquisition are boundary events.
      // Re-pick after each such operation so a blocked task can never consume a work quantum.
      let boundaryCount=0;
      while(selected&&boundaryCount++<4){
        if(isWait&&selected===H&&H.phase==='wait'){
          if(state.notifications>0){
            state.notifications--;H.phase='work';H.note='已取得一次通知，开始处理数据';
            emit('H','notify-take','采集任务取得通知','通知计数减少一次；随后执行数据处理。通知到达与处理完成是不同事件。',
              config.scenario==='blocking'?'ulTaskNotifyTake(pdFALSE, portMAX_DELAY);':'ulTaskNotifyTake(pdFALSE, 0);',0);
          }else if(config.scenario==='blocking'){
            H.state='blocked';H.note='阻塞等待通知，不参与就绪任务竞争';
            emit('H','block','采集任务阻塞等待','没有通知，H 让出 CPU。M 和 L 有机会在等待期间运行。',
              'ulTaskNotifyTake(pdFALSE, portMAX_DELAY);',0);
            selected=pick();continue;
          }
        }
        if(isMutex&&selected===H&&H.phase==='acquire'){
          if(state.owner===null){
            state.owner='H';H.phase='work';H.note='已取得互斥锁，执行临界区';
            state.metrics.highAcquiredAt=now;
            state.metrics.highWaitTicks=now-state.metrics.highBlockedAt;
            emit('H','lock','采集任务取得互斥锁','从 t='+state.metrics.highBlockedAt+' 等到 t='+now+
              '，共等待 '+state.metrics.highWaitTicks+' 拍。',
              inherit?'xSemaphoreTake(mutex, portMAX_DELAY);':'xSemaphoreTake(binaryGate, portMAX_DELAY);',0);
          }else{
            H.state='blocked';H.note='等待 L 释放互斥锁';state.metrics.highBlockedAt=now;
            if(inherit){L.effectivePriority=H.effectivePriority;L.note='持锁期间继承 H 的优先级 3';}
            emit('H','block','采集任务因互斥锁阻塞',
              inherit?'L 的有效优先级临时升到 3，帮助它尽快运行并释放锁；H 本身仍然阻塞。':
                'H 优先级很高，但锁仍归 L。H 阻塞后不能直接越过临界区。',
              inherit?'xSemaphoreTake(mutex, portMAX_DELAY);':'xSemaphoreTake(binaryGate, portMAX_DELAY);',0);
            selected=pick();continue;
          }
        }
        break;
      }
      if(!selected){
        emit('idle','idle','CPU 进入空闲','没有就绪的示例任务；本拍运行空闲任务。','/* idle task */',1);
        state.time++;continue;
      }
      if(isWait&&selected===H&&H.phase==='wait'){
        H.note='查询未完成，仍保持就绪';
        emit('H','busy','采集任务忙等',
          '运行区间 ['+now+', '+(now+1)+')：没有通知仍继续查询。M、L 虽然就绪，但优先级较低，无法运行。',
          'while (ulTaskNotifyTake(pdFALSE, 0) == 0) { /* 不阻塞 */ }',1);
        state.metrics.busyTicks++;state.time++;continue;
      }
      if(isPeriodic&&selected===H&&!H.cycleStarted){
        H.cycleStarted=true;state.metrics.periodicStarts.push(now);
      }
      selected.note='本拍开始时剩余工作 '+selected.remaining+' 拍';
      emit(selected.id,'work',selected.name+'运行',
        '运行区间 ['+now+', '+(now+1)+')：'+selected.name+' 是当前最高优先级的就绪任务。'+
        (selected.effectivePriority!==selected.basePriority?' 当前优先级 '+selected.effectivePriority+' 来自互斥锁继承。':''),
        selected===H?'process_data_one_quantum();':selected===M?'service_communication_one_quantum();':'write_log_one_quantum();',1);
      advanceWork(selected);
    }
    if(state.metrics.highBlockedAt!==null&&state.metrics.highAcquiredAt===null)
      state.metrics.highWaitTicks=config.horizon-state.metrics.highBlockedAt;
    emit('idle','end','到达观察窗口末尾',
      '观察到 t='+config.horizon+'。尚未完成的任务继续保留真实模型状态；窗口结束不等于它们已完成。',
      '/* 结束本次观察 */',0);
    let result;
    if(isWait){
      const earlyWork=state.steps.filter(s=>s.event==='work'&&s.tick<6&&s.actor!=='H').length;
      result={tone:config.scenario==='blocking'?'good':'warn',
        title:config.scenario==='blocking'?'等待期间，其他任务可以运行':'忙等占用了等待期间的 CPU',
        detail:'外部事件都在 t=6 到达。事件前，其他任务完成 '+earlyWork+' 拍工作；H 忙等 '+state.metrics.busyTicks+
          ' 拍。通知已消耗 '+(state.metrics.irqCount-state.notifications)+' 次。忙等不会让外部事件提前。'};
    }else if(isMutex){
      const acquired=state.metrics.highAcquiredAt;
      result={tone:inherit?'good':'warn',title:inherit?'继承帮助持锁者尽快释放锁':'中优先级任务延长了高优先级任务的等待',
        detail:acquired===null?'窗口结束时 H 仍未取得锁；已等待 '+state.metrics.highWaitTicks+' 拍。':
          'H 在 t='+state.metrics.highBlockedAt+' 等锁，在 t='+acquired+' 取得锁，共等待 '+state.metrics.highWaitTicks+
          ' 拍。解锁后持锁任务恢复基础优先级。'};
    }else{
      const starts=state.metrics.periodicStarts;
      const gaps=starts.slice(1).map((t,i)=>t-starts[i]);
      result={tone:config.scenario==='periodic-absolute'?'good':'warn',
        title:config.scenario==='periodic-absolute'?'按固定时间基准释放任务':'工作时间叠加进了相邻两轮间隔',
        detail:'已开始的轮次：t='+starts.join('、')+'；相邻开始间隔：'+(gaps.length?gaps.join('、'):'尚无完整间隔')+
          ' 拍。目标周期 5 拍，每轮执行 '+config.workTicks+' 拍。这里只比较无过载的情况。'};
    }
    return {kind:'rtos',title:scenarios.find(s=>s.id===config.scenario).title,
      description:scenarios.find(s=>s.id===config.scenario).description,config,
      steps:state.steps,result,limits:limits.slice()};
  }
  function run(options){return simulate(configuration(options));}
  return Object.freeze({scenarios,run});
});
