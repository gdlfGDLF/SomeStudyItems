const assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 const text=id=>page.locator('#'+id).innerText();
 async function seek(tick){await page.locator('#timing-seek').fill(String(tick));await page.locator('#timing-seek').dispatchEvent('input');}
 for(const entry of ['index.html','总线实验室.html']){
  await page.goto(pathToFileURL(path.join(__dirname,entry)).href);await page.waitForSelector('#timing-chart rect');
  assert.match(await text('timing-equations'),/500 kbit\/s/);assert.match(await text('timing-equations'),/80% · 1.6 μs/);
  await page.locator('#timing-clock-next').click();assert.match(await text('timing-counter'),/1\/16/);assert.match(await text('timing-received'),/第 1 位：等待采样/);
  await seek(255);assert.match(await text('timing-phase'),/TSEG1/);assert.match(await text('timing-received'),/第 1 位：等待采样/);
  await page.locator('#timing-clock-next').click();assert.match(await text('timing-phase'),/第 1 位 · TSEG2/);assert.match(await text('timing-event'),/同一个采样瞬间/);assert.match(await text('timing-received'),/第 1 位：0.*第 2 位：等待采样/);
  await page.locator('#timing-tq-next').click();assert.match(await text('timing-event'),/不会再次采样/);
  await page.locator('#timing-next-bit').click();assert.match(await text('timing-phase'),/第 2 位 · 同步段/);assert.match(await text('timing-received'),/第 2 位：等待采样/);
  await page.locator('#timing-sample-next').click();assert.match(await text('timing-received'),/第 1 位：0.*第 2 位：1/);
  await seek(100);assert.match(await text('timing-received'),/第 1 位：等待采样/);
  await page.locator('[data-timing-preset="quantized"]').click();assert.match(await text('timing-quantization'),/12.8 TQ/);assert.match(await text('timing-equations'),/81.25% · 1.625 μs/);
  await page.locator('[data-timing-preset="fast"]').click();assert.match(await text('timing-equations'),/2000 kbit\/s/);
  await page.locator('#timing-pattern').selectOption('00');await seek(160);assert.match(await text('timing-received'),/第 1 位：0.*第 2 位：0/);
  await page.locator('#timing-divider').fill('0');assert.equal(await page.locator('#timing-error').isVisible(),true);assert.equal(await page.locator('#timing-play').isDisabled(),true);
  await page.locator('[data-timing-preset="normal"]').click();await page.locator('#timing-pattern').selectOption('01');
  await page.locator('#timing-play').click();await page.waitForTimeout(300);await page.locator('[data-protocol="SPI"]').click();const pos=await text('timing-position');await page.waitForTimeout(300);assert.equal(await text('timing-position'),pos);await page.locator('[data-protocol="CAN"]').click();
  await page.locator('#family-type').selectOption('xl');assert.equal(await page.locator('#timing-lab').isVisible(),true);
 }
 await page.locator('#timing-reset').click();await page.locator('#timing-sample-next').click();await page.locator('#timing-lab').screenshot({path:path.join(__dirname,'preview-bit-timing.png')});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.evaluate(()=>{const c=document.querySelector('#timing-chart [data-cursor]').getBoundingClientRect(),h=document.querySelector('.timing-chart-scroll').getBoundingClientRect();return c.left>=h.left&&c.right<=h.right;}),true,'cursor remains visible after resizing');
 await page.locator('#timing-lab').screenshot({path:path.join(__dirname,'preview-bit-timing-mobile.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);console.log('Bit timing UI passed: clock/TQ distinction, one sample at shared boundary, two bits, backward seek, 81.25% quantization, presets, validation, pause on protocol switch, offline and mobile (source + bundle).');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
