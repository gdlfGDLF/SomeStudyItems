const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Lab = require('./scheduler.js');
const last = run=>run.steps.at(-1).snapshot;
const intervals = run=>run.steps.filter(s=>s.duration===1);
const taskAt = (step,id)=>step.snapshot.tasks.find(t=>t.id===id);

test('all scenarios expose immutable metadata and browser/CommonJS API',()=>{
  assert.equal(Lab.scenarios.length,6);
  assert.equal(new Set(Lab.scenarios.map(s=>s.id)).size,6);
  const context={};vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'scheduler.js'),'utf8'),context);
  assert.equal(typeof context.SchedulerLab.run,'function');
  assert.equal(context.SchedulerLab.run().kind,'rtos');
  assert.ok(Object.isFrozen(Lab.scenarios));
});

test('blocked wait permits background work, busy wait does not accelerate IRQ',()=>{
  const block=Lab.run({scenario:'blocking'});
  const busy=Lab.run({scenario:'busy-wait'});
  assert.equal(block.steps.filter(s=>s.event==='work'&&s.tick<6&&s.actor==='M').length,6);
  assert.equal(busy.steps.filter(s=>s.event==='work'&&s.tick<6&&s.actor!=='H').length,0);
  assert.equal(busy.steps.filter(s=>s.event==='busy').length,6);
  for(const run of [block,busy]){
    assert.equal(run.steps.find(s=>s.event==='irq').tick,6);
    assert.equal(run.steps.find(s=>s.event==='notify-take').tick,6);
    assert.equal(run.steps.find(s=>s.event==='work'&&s.actor==='H').tick,6);
    assert.equal(last(run).metrics.work.H,2);
    assert.equal(last(run).metrics.irqCount,1);
    assert.equal(last(run).notifications,0);
  }
  const before=block.steps.find(s=>s.event==='work'&&s.tick===5);
  assert.equal(taskAt(before,'H').state,'blocked');
  const irq=block.steps.find(s=>s.event==='irq');
  assert.equal(taskAt(irq,'H').state,'ready');
  assert.equal(irq.snapshot.notifications,1);
  assert.equal(block.steps.find(s=>s.event==='notify-take').snapshot.notifications,0);
});

test('one-mutex inheritance shortens H wait and restores holder base priority',()=>{
  const ordinary=Lab.run({scenario:'inversion'});
  const inherited=Lab.run({scenario:'inheritance'});
  assert.equal(last(ordinary).metrics.highBlockedAt,1);
  assert.equal(last(ordinary).metrics.highAcquiredAt,12);
  assert.equal(last(ordinary).metrics.highWaitTicks,11);
  assert.equal(last(inherited).metrics.highAcquiredAt,4);
  assert.equal(last(inherited).metrics.highWaitTicks,3);
  assert.equal(ordinary.steps.find(s=>s.event==='work'&&s.tick===2).actor,'M');
  const boosted=inherited.steps.find(s=>s.event==='work'&&s.tick===2);
  assert.equal(boosted.actor,'L');
  assert.equal(taskAt(boosted,'L').effectivePriority,3);
  assert.equal(taskAt(boosted,'H').state,'blocked');
  const release=inherited.steps.find(s=>s.event==='unlock'&&s.actor==='L');
  assert.equal(taskAt(release,'L').effectivePriority,1);
  assert.equal(release.snapshot.mutex.owner,null);
  assert.equal(taskAt(release,'H').state,'ready');
  assert.equal(inherited.steps.find(s=>s.event==='lock').snapshot.mutex.owner,'H');
  assert.equal(last(inherited).mutex.owner,null);
});

test('truncated observation reports incomplete acquisition honestly',()=>{
  const short=Lab.run({scenario:'inversion',horizon:12});
  assert.equal(last(short).metrics.highAcquiredAt,null);
  assert.equal(last(short).metrics.highWaitTicks,11);
  assert.equal(taskAt(short.steps.at(-1),'H').state,'ready');
  assert.match(short.result.detail,/仍未取得锁/);
  assert.equal(short.steps.filter(s=>s.event==='work'&&s.actor==='H').length,0);
});

test('relative delay accumulates execution time; absolute delay preserves period',()=>{
  for(let workTicks=1;workTicks<=4;workTicks++){
    const relative=Lab.run({scenario:'periodic-relative',workTicks,horizon:36});
    const absolute=Lab.run({scenario:'periodic-absolute',workTicks,horizon:36});
    const rel=last(relative).metrics.periodicStarts;
    const abs=last(absolute).metrics.periodicStarts;
    assert.equal(rel[0],0);
    assert.equal(abs[0],0);
    for(let i=1;i<rel.length;i++)assert.equal(rel[i]-rel[i-1],5+workTicks);
    for(let i=1;i<abs.length;i++)assert.equal(abs[i]-abs[i-1],5);
    assert.ok(absolute.steps.some(s=>s.event==='work'&&s.actor!=='H'));
    const delay=absolute.steps.find(s=>s.event==='delay');
    assert.equal(taskAt(delay,'H').state,'blocked');
    assert.equal(delay.tick,workTicks);
  }
});

test('every logical quantum obeys highest-ready-priority dispatch and task exclusion',()=>{
  for(const scenario of Lab.scenarios){
    for(let workTicks=1;workTicks<=4;workTicks++){
      for(const horizon of [12,18,36]){
        const run=Lab.run({scenario:scenario.id,workTicks,horizon});
        const quanta=intervals(run);
        assert.equal(quanta.length,horizon);
        assert.deepEqual(quanta.map(s=>s.tick),Array.from({length:horizon},(_,i)=>i));
        let previous=-1;
        for(const step of run.steps){
          assert.ok(step.tick>=previous&&step.tick<=horizon);
          previous=step.tick;
          assert.ok(step.snapshot.notifications>=0);
          const running=step.snapshot.tasks.filter(t=>t.state==='running');
          if(step.duration===1&&step.actor!=='idle'){
            assert.equal(running.length,1);
            assert.equal(running[0].id,step.actor);
            for(const ready of step.snapshot.tasks.filter(t=>t.state==='ready'))
              assert.ok(running[0].effectivePriority>=ready.effectivePriority);
          }else assert.equal(running.length,0);
          if(step.snapshot.mutex.owner){
            assert.ok(['H','L'].includes(step.snapshot.mutex.owner));
            const owner=taskAt(step,step.snapshot.mutex.owner);
            assert.notEqual(owner.state,'done');
          }
        }
      }
    }
  }
});

test('snapshots and successive runs do not share mutable state',()=>{
  const a=Lab.run();
  const b=Lab.run();
  a.steps[0].snapshot.tasks[0].note='changed';
  a.steps[0].snapshot.metrics.work.H=999;
  a.limits.push('changed');
  assert.notEqual(a.steps[1].snapshot.tasks[0].note,'changed');
  assert.notEqual(a.steps[1].snapshot.metrics.work.H,999);
  assert.notEqual(b.steps[0].snapshot.tasks[0].note,'changed');
  assert.equal(b.limits.includes('changed'),false);
});

test('invalid controls fail rather than silently changing experiment',()=>{
  for(const workTicks of [0,5,1.5,NaN,'2',null])assert.throws(()=>Lab.run({workTicks}),RangeError);
  for(const horizon of [11,37,12.5,Infinity,'18',null])assert.throws(()=>Lab.run({horizon}),RangeError);
  assert.throws(()=>Lab.run({scenario:'unknown'}),RangeError);
  assert.throws(()=>Lab.run(null),TypeError);
  assert.throws(()=>Lab.run([]),TypeError);
  assert.throws(()=>Lab.run('blocking'),TypeError);
});
