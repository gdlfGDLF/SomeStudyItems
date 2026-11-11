/* Ordinary, single-sample CAN bits: clock counts -> TQ -> sample boundary.
 * An ideal timing microscope, not a resynchronization/FD-switch/PHY simulator. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BitTimingLab=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function integer(v,min,max,name){const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw Error(`${name}应为 ${min}–${max} 的整数。`);return n;}
 function build(input={}){
  const clockMHz=Number(input.clockMHz??160);if(!Number.isFinite(clockMHz)||clockMHz<1||clockMHz>400)throw Error('CAN 时钟应为 1–400 MHz。');
  const divider=integer(input.divider??16,1,256,'实际分频系数'),seg1=integer(input.seg1??15,1,64,'TSEG1'),seg2=integer(input.seg2??4,1,32,'TSEG2');
  const pattern=String(input.pattern??'01');if(!/^[01]{2}$/.test(pattern))throw Error('请选择两个 0/1 数据位。');
  const totalTq=1+seg1+seg2,sampleTq=1+seg1,clockNs=1000/clockMHz,tqNs=clockNs*divider,clocksPerBit=divider*totalTq;
  return {config:{clockMHz,divider,seg1,seg2,pattern},clockNs,tqNs,totalTq,sampleTq,clocksPerBit,
   sampleClock:sampleTq*divider,bitUs:clocksPerBit/clockMHz,sampleUs:sampleTq*divider/clockMHz,
   samplePercent:sampleTq/totalTq*100,bitrate:clockMHz*1e6/clocksPerBit,totalClocks:clocksPerBit*2};
 }
 function snapshot(run,cursor){
  const tick=integer(cursor,0,run.totalClocks,'时钟位置'),finished=tick===run.totalClocks;
  const bitIndex=finished?1:Math.floor(tick/run.clocksPerBit),localClock=finished?run.clocksPerBit:tick%run.clocksPerBit;
  const phase=finished?'完成':localClock<run.config.divider?'同步段':localClock<run.sampleClock?'TSEG1':'TSEG2';
  const samples=[];for(let i=0;i<2;i++){const at=i*run.clocksPerBit+run.sampleClock;if(tick>=at)samples.push({bitIndex:i,value:Number(run.config.pattern[i]),tick:at,timeUs:at/run.config.clockMHz});}
  return {tick,finished,bitIndex,localClock,phase,timeUs:tick/run.config.clockMHz,
   elapsedTq:Math.floor(localClock/run.config.divider),subClock:localClock%run.config.divider,
   level:Number(run.config.pattern[bitIndex]),samples,atSample:!finished&&localClock===run.sampleClock};
 }
 function nextTq(run,tick){return Math.min(run.totalClocks,(Math.floor(tick/run.config.divider)+1)*run.config.divider);}
 function nextSample(run,tick){for(let i=0;i<2;i++){const at=i*run.clocksPerBit+run.sampleClock;if(at>tick)return at;}return run.totalClocks;}
 return {build,snapshot,nextTq,nextSample};
});
