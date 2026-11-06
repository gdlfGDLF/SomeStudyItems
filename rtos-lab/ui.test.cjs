const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}}), errors=[],network=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  const open=async name=>page.goto(pathToFileURL(path.join(__dirname,name)).href);
  const choose=async id=>page.locator('[data-scenario="'+id+'"]').click();
  const finish=()=>page.locator('#finish').click();
  const kind=async name=>page.locator('[data-kind="'+name+'"]').click();
  await open('RTOS与寄存器实验室.html');
  assert.equal(await page.locator('#result').isVisible(),false);
  assert.equal(await page.locator('#previous').isDisabled(),true);
  await page.locator('[data-answer="1"]').click();
  assert.match(await page.locator('#quiz-answer').innerText(),/正确/);
  await page.locator('#next').click();
  assert.equal(await page.locator('#previous').isEnabled(),true);
  await finish();assert.match(await page.locator('#signals').innerText(),/通知/);
  await page.locator('#previous').click();assert.equal(await page.locator('#result').isVisible(),false);
  await choose('w1c-correct');await finish();
  assert.match(await page.locator('#registers').innerText(),/0x00000002/);
  await page.locator('#compare').click();await finish();
  assert.equal(await page.locator('[data-scenario="w1c-rmw"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#result').innerText(),/ERROR|错误/);
  for(const id of ['irq-normal','irq-uncleared','irq-masked','w1c-correct','w1c-rmw','ro-write']){
    await choose(id);assert.equal(await page.locator('#quiz-answer').isVisible(),false);await finish();
    assert.equal(await page.locator('#result').isVisible(),true);
    assert.ok((await page.locator('#code').innerText()).trim().length>0);
  }
  await choose('irq-normal');await page.locator('#seek').fill('5');await page.locator('#seek').dispatchEvent('input');
  await page.screenshot({path:path.join(__dirname,'preview-registers.png'),fullPage:true});
  await kind('rtos');
  assert.equal(await page.locator('#scheduler-view').isVisible(),true);
  assert.equal(await page.locator('#register-view').isVisible(),false);
  assert.ok(await page.locator('#timeline .future').count()>0);
  for(const id of ['blocking','busy-wait','inversion','inheritance','periodic-relative','periodic-absolute']){
    await choose(id);await finish();
    assert.equal(await page.locator('#result').isVisible(),true);
    assert.equal(await page.locator('#tasks tr').count()>0,true);
    assert.equal(await page.locator('#timeline .future').count(),0);
    await page.locator('#timeline button').first().click();
    assert.equal(await page.locator('#result').isVisible(),false);
  }
  await choose('periodic-relative');
  const before=await page.locator('#position').innerText();
  await page.locator('#horizon').selectOption('30');
  await page.locator('#work').selectOption('4');
  assert.equal(await page.locator('#position').innerText(),before,'draft must not mutate trace');
  assert.match(await page.locator('#dirty').innerText(),/修改/);
  await page.locator('#config-form button').click();
  assert.equal(await page.locator('#dirty').innerText(),'');
  await finish();
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();
  const download=await downloadPromise;const data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(data.format,'embedded-rtos-lab-v1');
  assert.equal(data.simulation.config.workTicks,4);
  assert.equal(data.simulation.config.horizon,30);
  assert.equal(data.cursor,data.simulation.steps.length-1);
  await choose('inheritance');
  await page.locator('#speed').selectOption('150');await page.locator('#play').click();
  await page.waitForTimeout(350);await page.locator('#play').click();
  assert.equal(await page.locator('#play').innerText(),'播放');
  assert.notEqual(await page.locator('#seek').inputValue(),'0');
  await finish();await page.screenshot({path:path.join(__dirname,'preview-rtos.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  for(const name of ['registers','rtos']){
    await kind(name);await finish();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' mobile overflow');
  }
  await page.screenshot({path:path.join(__dirname,'preview-mobile.png'),fullPage:true});
  await open('index.html');assert.equal(await page.locator('#title').innerText().then(Boolean),true);
  await page.goto(pathToFileURL(path.join(__dirname,'../学习导航.html')).href);
  const links=await page.locator('nav a').evaluateAll(xs=>xs.map(x=>x.getAttribute('href')));
  assert.equal(links.length,4);
  for(const href of links)assert.ok(fs.existsSync(path.resolve(__dirname,'..',href)),href+' missing');
  await page.locator('nav a').last().click();assert.equal(await page.locator('#register-view').isVisible(),true);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  console.log('PASS: 12 scenarios, quiz, replay, compare, draft/apply, JSON download, playback, offline, navigation and mobile layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
