const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  await page.goto(pathToFileURL(path.join(__dirname,'总线实验室.html')).href);
  const text=id=>page.locator('#'+id).innerText();
  const tab=protocol=>page.locator(`[data-protocol="${protocol}"]`).click();
  const build=()=>page.locator('#serial-form button[type=submit]').click();
  const finish=()=>page.locator('#serial-finish').click();
  assert.equal(await page.locator('#can-lab').isVisible(),true);
  await tab('SPI');assert.equal(await page.locator('#can-lab').isVisible(),false);
  assert.match(await text('serial-title'),/SPI/);assert.equal(await text('serial-received'),'—');
  await page.locator('#serial-first-sample').click();assert.equal(await text('serial-tx-bits'),'1');assert.equal(await text('serial-rx-bits'),'0');assert.equal(await text('serial-received'),'—');
  await page.locator('#serial-first-byte').click();assert.equal(await text('serial-received'),'A5');assert.equal(await text('serial-returned'),'5A');
  await page.screenshot({path:path.join(__dirname,'preview-spi.png'),fullPage:true});
  for(const mode of ['0','1','2','3']){await page.locator('#serial-mode').selectOption(mode);await build();await finish();assert.equal(await text('serial-received'),'A5 3C');assert.equal(await text('serial-returned'),'5A C3');}
  await page.locator('#serial-selected').selectOption('false');await build();await finish();assert.equal(await text('serial-received'),'—');assert.equal(await text('serial-returned'),'FF FF');assert.match(await text('serial-result-detail'),/不能当作/);
  assert.equal(await page.locator('#serial-wave circle').count(),16,'No peripheral sample dots when CS is not asserted');
  await page.locator('#serial-data').fill('GG');await build();assert.equal(await page.locator('#serial-validation').isVisible(),true);
  await tab('I2C');await tab('SPI');assert.match(await text('serial-title'),/SPI/);assert.equal(await page.locator('#serial-data').inputValue(),'A5 3C','Switch restores last valid configuration');
  await tab('I2C');await finish();assert.equal(await text('serial-received'),'A5 3C');assert.match(await text('serial-result-title'),/写入完成/);
  await page.locator('#serial-direction').selectOption('read');await build();await finish();assert.equal(await text('serial-received'),'A5 3C');assert.match(await text('serial-received-label'),/主机/);assert.match(await text('serial-result-detail'),/NACK/);
  await page.screenshot({path:path.join(__dirname,'preview-i2c.png'),fullPage:true});
  await page.locator('#serial-scenario').selectOption('nack');await build();await finish();assert.equal(await text('serial-received'),'—');assert.match(await text('serial-result-title'),/确认|NACK|应答/);
  await page.locator('#serial-scenario').selectOption('stretch');await build();await finish();assert.match(await text('serial-result-detail'),/延展|等待|拉低/);
  await page.locator('#serial-address').fill('00');await build();assert.equal(await page.locator('#serial-validation').isVisible(),true);
  await tab('UART');await finish();assert.equal(await text('serial-received'),'55 A3');assert.match(await text('serial-result-detail'),/没有 ACK/);
  await page.locator('#serial-receiverBaud').selectOption('90000');await build();await finish();assert.equal(await text('serial-received'),'5B E1');assert.match(await text('serial-result-title'),/数据被误读/);assert.match(await text('serial-result-detail'),/所选校验仍通过/);
  await page.screenshot({path:path.join(__dirname,'preview-uart.png'),fullPage:true});
  await page.locator('#serial-receiverBaud').selectOption('100000');await build();await finish();assert.match(await text('serial-result-title'),/帧错误|停止位/);
  await page.locator('#serial-receiverBaud').selectOption('115200');await page.locator('#serial-parity').selectOption('even');await build();await finish();assert.equal(await text('serial-received'),'55 A3');
  await page.locator('#serial-reset').click();await page.locator('#serial-speed').selectOption('65');await page.locator('#serial-play').click();await page.waitForTimeout(230);await tab('CAN');await page.waitForTimeout(120);assert.equal(await page.locator('#can-lab').isVisible(),true);assert.equal(await text('serial-play'),'▶ 播放');
  await tab('UART');const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;const trace=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(trace.simulation.protocol,'UART');assert.equal(trace.simulation.config.parity,'even');
  for(const protocol of ['SPI','I2C','UART']){await tab(protocol);await page.setViewportSize({width:390,height:844});await finish();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,protocol+' mobile overflow');}
  await page.screenshot({path:path.join(__dirname,'preview-serial-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'Runs completely offline');
  console.log('Protocol UI checks passed: SPI modes / CS, I2C read / write / NACK / stretch, UART drift / parity, invalid inputs, switching, playback, export, offline and mobile.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
