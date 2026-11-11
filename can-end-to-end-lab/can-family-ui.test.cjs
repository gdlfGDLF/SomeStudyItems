const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const C=require('./can-formats.js');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],network=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  const text=id=>page.locator('#'+id).innerText();
  for(const entry of ['index.html','总线实验室.html']){
   await page.goto(pathToFileURL(path.join(__dirname,entry)).href);
   await page.waitForSelector('#family-fields tr');assert.equal(await page.locator('#family-type option').count(),9);
   for(const t of C.TYPES){
    await page.locator('#family-type').selectOption(t.key);assert.equal(await page.locator('#family-error').isVisible(),false);
    assert.equal(await page.locator('#classic-can-detail').isVisible(),t.key==='cc-base');
    assert.match(await text('family-status'),/尚未 ACK/);
    await page.locator('#family-fields button').getByText(t.extended?'ID-B':t.family==='XL'?'Priority ID':'ID',{exact:true}).click();
    assert.match(await text('family-decoded-id'),/^0x/);assert.equal(await text('family-decoded-data'),'等待 DATA');
    await page.locator('#family-fields button').getByText('DATA',{exact:true}).click();assert.match(await text('family-decoded-data'),t.remote?/无 DATA/:/DC 05/);
    await page.locator('#family-fields button').getByText('ACK',{exact:true}).click();assert.match(await text('family-status'),/已 ACK.*尚未 TxDone/);
    await page.locator('#family-finish').click();assert.match(await text('family-status'),/本地 TxDone/);
   }
   await page.locator('[data-family-bytes="2048"]').click();assert.match(await text('family-summary'),/2048 B/);assert.match(await text('family-fields'),/2047/); // DLC binary contains decimal in meaning
   await page.locator('#family-finish').click();assert.match(await text('family-decoded-data'),/2048 B/);
   const promise=page.waitForEvent('download');await page.locator('#export').click();const download=await promise;
   const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(exported.simulation.config.data.length,2048);assert.equal(exported.simulation.wireBits,null);
   await page.locator('#family-type').selectOption('fd-brs');await page.locator('[data-family-bytes="64"]').click();assert.match(await text('family-fields'),/CRC-21/);
   await page.locator('#family-data').fill('00 01 02 03 04 05 06 07 08');await page.locator('#family-form button[type=submit]').click();assert.equal(await page.locator('#family-error').isVisible(),true);assert.match(await text('family-error'),/不偷偷补零/);
   await page.locator('#family-play').click();assert.equal(await text('family-play'),'▶ 播放');
   await page.locator('[data-family-bytes="64"]').click();await page.locator('#family-play').click();await page.waitForTimeout(750);await page.locator('#family-play').click();assert.notEqual(await text('family-position'),'1 / 26');
   await page.locator('[data-protocol="SPI"]').click();assert.equal(await page.locator('#can-family').isVisible(),false);await page.locator('[data-protocol="CAN"]').click();assert.equal(await page.locator('#can-family').isVisible(),true);
   await page.locator('#family-type').selectOption('cc-base');await page.locator('#family-id').fill('1');await page.locator('#family-form button[type=submit]').click();assert.equal(await page.locator('#identifier').inputValue(),'1');
   await page.locator('#family-fields button').getByText('ID',{exact:true}).click();assert.ok(await page.locator('#family-wire-bits .stuffed').count()>0);
  }
  await page.locator('#family-type').selectOption('fd-extended-brs');await page.locator('[data-family-bytes="64"]').click();
  await page.locator('#family-fields button').getByText('BRS',{exact:true}).click();await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:path.join(__dirname,'preview-can-family.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  for(const t of ['cc-base','cc-extended-remote','fd-extended-brs','xl']){
   await page.locator('#family-type').selectOption(t);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,t+' mobile overflow');
  }
  await page.screenshot({path:path.join(__dirname,'preview-can-family-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  console.log('CAN family UI passed: nine formats, progressive decode, ACK vs TxDone, 2048 B XL, invalid FD length, export, old CAN sync, offline operation and mobile layout (source + bundle).');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
