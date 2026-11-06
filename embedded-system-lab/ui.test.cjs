const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const Boot=require('./boot.js'),Comms=require('./comms.js');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  await page.goto(pathToFileURL(path.join(__dirname,'嵌入式系统实验室.html')).href);
  const text=id=>page.locator('#'+id).innerText(),tab=name=>page.locator(`[data-tab="${name}"]`).click();
  const build=()=>page.locator('#config-form button[type=submit]').click(),finish=()=>page.locator('#finish').click();
  const seek=async(run,key)=>{const i=run.steps.findIndex(step=>step.key===key);assert.ok(i>=0,key);await page.locator('#seek').fill(String(i));await page.locator('#seek').dispatchEvent('input');};
  assert.equal(await page.locator('#uboot-command').isDisabled(),true);
  await tab('serial');await finish();assert.equal(await text('local-done'),'尚未');assert.match(await text('result'),/未就绪/);assert.equal(await page.locator('#boot-required').isVisible(),true);
  await tab('boot');await page.locator('#enter-uboot').click();assert.equal(await page.locator('#uboot-command').isEnabled(),true);
  await page.locator('#uboot-command').fill('printenv bootcmd');await page.locator('#uboot-form button').click();assert.match(await text('uboot-output'),/先加载 Image 与 DTB/);assert.match(await text('board-system'),/U-Boot/);
  await page.locator('#uboot-command').fill('help');await page.locator('#uboot-form button').click();assert.match(await text('uboot-output'),/printenv bootargs/);
  await page.screenshot({path:path.join(__dirname,'preview-boot.png'),fullPage:true});
  await page.locator('#speed').selectOption('170');await page.locator('#uboot-command').fill('boot');await page.locator('#uboot-form button').click();await page.waitForTimeout(450);await finish();assert.match(await text('board-system'),/应用可运行/);assert.equal(await page.locator('#uboot-command').isDisabled(),true);
  await tab('serial');await page.locator('#first-byte').click();assert.equal(await text('serial-rx'),'48');assert.equal(await text('serial-reply'),'—');
  await seek(Comms.serial(),'txdone');assert.equal(await text('local-done'),'已完成');assert.equal(await text('reply-received'),'尚未');
  await finish();assert.equal(await text('serial-rx'),'48 65 6C 6C 6F');assert.equal(await text('serial-reply'),'48 65 6C 6C 6F');assert.equal(await page.locator('#serial-wave path').count(),2);
  await page.screenshot({path:path.join(__dirname,'preview-serial.png'),fullPage:true});
  for(const [scenario,peer] of [['no-reply','已完成'],['crossed-wrong','尚未']]){await page.locator('#config-scenario').selectOption(scenario);await build();await finish();assert.equal(await text('local-done'),'已完成');assert.equal(await text('peer-received'),peer);assert.equal(await text('reply-received'),'尚未');}
  await page.locator('#config-scenario').selectOption('success');await page.locator('#config-text').fill('你好');await build();await finish();assert.equal(await text('serial-rx'),'E4 BD A0 E5 A5 BD');
  await page.locator('#config-peerBaud').selectOption('90000');await build();await finish();assert.match(await text('result'),/不一致|错误|没有/);
  await tab('tree');await page.locator('#dt-uart-enabled').selectOption('false');assert.match(await text('dts-preview'),/status = "disabled"/);
  await tab('serial');assert.equal(await text('board-serial-status'),'驱动就绪','Draft is not applied until reboot');
  await tab('tree');await page.locator('#tree-form button[type=submit]').click();await finish();assert.equal(await text('board-serial-status'),'不可用');assert.equal(await text('board-network-status'),'驱动就绪');assert.match(await text('board-system'),/应用可运行/);
  await tab('serial');await finish();assert.match(await text('result'),/disabled/);assert.equal(await text('local-done'),'尚未');
  await tab('network');await finish();assert.equal(await text('reply-received'),'已完成');assert.equal(await page.locator('#packet-bytes button').count(),47);
  await page.locator('#packet-fields').getByRole('button',{name:'UDP 头',exact:true}).click();assert.match(await text('packet-detail'),/UDP/);
  await page.screenshot({path:path.join(__dirname,'preview-network.png'),fullPage:true});
  for(const [scenario,local,peer] of [['cable','尚未','尚未'],['arp','尚未','尚未'],['port','已完成','尚未'],['no-reply','已完成','已完成']]){
   await page.locator('#config-scenario').selectOption(scenario);await build();await finish();assert.equal(await text('local-done'),local,scenario);assert.equal(await text('peer-received'),peer,scenario);assert.equal(await text('reply-received'),'尚未',scenario);
  }
  await page.locator('#config-scenario').selectOption('success');await page.locator('#config-peerIp').fill('192.168.2.20');await build();await finish();assert.match(await text('result'),/没有网关/);assert.equal(await text('local-done'),'尚未');
  await page.locator('#config-peerIp').fill('999.0.0.1');await build();assert.equal(await page.locator('#validation').isVisible(),true);
  await page.locator('#config-peerIp').fill('192.168.1.20');await build();
  await tab('tree');await page.locator('#dt-restore').click();await page.locator('#dt-eth-compatible').selectOption('false');await page.locator('#tree-form button[type=submit]').click();await finish();assert.equal(await text('board-network-status'),'不可用');
  await tab('network');await finish();assert.match(await text('result'),/compatible/);
  await tab('tree');await page.locator('#dt-restore').click();await page.locator('#tree-form button[type=submit]').click();await finish();
  for(const scenario of ['kernel-missing','dtb-invalid','rootfs-missing']){
   await page.locator('#config-scenario').selectOption(scenario);await build();await finish();assert.equal(await page.locator('#result.bad').isVisible(),true);
   if(scenario==='rootfs-missing')assert.equal(await text('board-serial-status'),'驱动就绪');
   await tab('network');await finish();assert.equal(await text('local-done'),'尚未');assert.match(await text('result'),/用户空间尚未就绪/);await tab('boot');
  }
  await page.locator('#config-scenario').selectOption('success');await build();await finish();
  await tab('tree');const dtsPromise=page.waitForEvent('download');await page.locator('#download-dts').click();const dts=await dtsPromise;assert.match(fs.readFileSync(await dts.path(),'utf8'),/虚拟教学硬件/);
  await page.screenshot({path:path.join(__dirname,'preview-tree.png'),fullPage:true});
  await tab('network');const tracePromise=page.waitForEvent('download');await page.locator('#export').click();const trace=await tracePromise;const exported=JSON.parse(fs.readFileSync(await trace.path(),'utf8'));assert.equal(exported.simulation.kind,'network');assert.equal(exported.board.userspaceReady,true);
  await page.setViewportSize({width:390,height:844});for(const name of ['boot','tree','serial','network']){await tab(name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' mobile overflow');}
  await finish();await page.screenshot({path:path.join(__dirname,'preview-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('GUI passed: shared boot prerequisites, U-Boot commands, staged serial decode/echo, device tree reboot semantics, all boot/network faults, UTF-8, input checks, downloads, offline and mobile layout.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
