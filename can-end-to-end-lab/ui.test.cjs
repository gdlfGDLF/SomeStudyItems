const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const Flow=require('./flow.js');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1500,height:1100},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(__dirname,'CAN全链路实验室.html')).href);
 const text=id=>page.locator('#'+id).innerText();
 await page.waitForSelector('#event-detail h3');
 assert.equal(await text('status-ack'),'尚未到达');assert.equal(await text('rx-bytes'),'DATA —');
 async function seekKey(key,scenario='success') {const run=Flow.build({scenario}),i=run.steps.findIndex(s=>s.key===key);assert.ok(i>=0);await page.locator('#seek').fill(String(i));await page.locator('#seek').dispatchEvent('input');}
 await seekKey('fpga-fetch');assert.match(await text('status-dma'),/已取走/);assert.equal(await text('status-done'),'等待完成报告');assert.equal(await text('status-ack'),'尚未到达');
 const run=Flow.build();const lastData=run.steps.filter(s=>s.key.startsWith('wire-')&&run.wire.bits[s.bitIndex].field==='DATA').at(-1);await seekKey(lastData.key);assert.equal(await text('rx-bytes'),'DATA DC 05');assert.equal(await text('status-peer'),'尚未');
 await page.locator('#jump-ack').click();assert.match(await text('status-ack'),/已收到/);assert.equal(await text('status-done'),'等待完成报告');assert.equal(await text('status-peer'),'尚未');assert.match(await text('bit-info'),/发送端 TXD=1/);
 await page.screenshot({path:path.join(__dirname,'preview-ack.png'),fullPage:true});
 await page.locator('[data-jump="echo"]').click();assert.equal(await text('status-done'),'已处理成功报告');assert.match(await text('event-detail'),/can_get_echo_skb/);
 await page.locator('#finish').click();assert.match(await text('s2mm-pointers'),/WR 32 \/ RD 32/);assert.equal(await text('status-peer'),'已交付应用');
 await page.locator('#packet-rx').click();await page.locator('#packet-fields').getByRole('button',{name:'status_grp',exact:true}).click();assert.match(await text('byte-detail'),/0x01/);assert.match(await text('packet-parse'),/is_tx_report = true/);
 for(const [scenario,ack,done,peer] of [['lost-report','已收到','等待完成报告','已交付'],['noack','未收到','等待完成报告','尚未'],['listen','未收到','等待完成报告','尚未'],['filtered','已收到','已处理成功报告','过滤'],['txerror','尚未到达','失败报告已处理','尚未'],['ringfull','尚未到达','尚未','尚未']]){
  await page.locator('#scenario').selectOption(scenario);await page.locator('#config-form button[type="submit"]').click();await page.locator('#finish').click();assert.ok((await text('status-ack')).includes(ack),scenario+' ACK');assert.ok((await text('status-done')).includes(done),scenario+' TxDone');assert.ok((await text('status-peer')).includes(peer),scenario+' peer');
  if(scenario==='lost-report'){await page.locator('#packet-rx').click();assert.match(await text('packet-caption'),/没有设备完成报告/);}
 }
 await page.locator('#scenario').selectOption('success');await page.locator('#payload').fill('00 00 FF 55 A5 01 02 03');await page.locator('#bitrate').selectOption('125000');await page.locator('#config-form button[type="submit"]').click();await page.locator('#finish').click();assert.equal(await text('rx-bytes'),'DATA 00 00 FF 55 A5 01 02 03');assert.match(await text('wire-clock'),/8 μs/);
 await page.locator('#payload').fill('');await page.locator('#config-form button[type="submit"]').click();await page.locator('#finish').click();assert.equal(await text('status-done'),'已处理成功报告');
 await page.locator('#identifier').fill('800');await page.locator('#config-form button[type="submit"]').click();assert.equal(await page.locator('#validation').isVisible(),true);
 await page.locator('#identifier').fill('200');await page.locator('#payload').fill('DC 05');await page.locator('#bitrate').selectOption('500000');await page.locator('#config-form button[type="submit"]').click();
 await page.locator('#play').click();await page.waitForTimeout(850);await page.locator('#play').click();assert.notEqual(await text('position'),'1 / '+run.steps.length);
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const dl=await downloadPromise;const data=JSON.parse(fs.readFileSync(await dl.path(),'utf8'));assert.equal(data.simulation.config.id,512);assert.equal(data.simulation.txPacket.length,32);
 await page.setViewportSize({width:390,height:844});await page.locator('#jump-ack').click();await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(__dirname,'preview-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);await browser.close();console.log('UI checks passed: end-to-end state ordering, bit decoding, ACK vs TxDone, seven scenarios, hex inspection, input validation, playback, JSON export, mobile layout.');
})().catch(e=>{console.error(e);process.exit(1);});
