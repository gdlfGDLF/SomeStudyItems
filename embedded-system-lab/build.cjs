const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
let html=read('index.html').replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+read('style.css')+'</style>');
for(const name of ['boot.js','comms.js','app.js']) html=html.replace('<script src="'+name+'"></script>',()=>'<script>'+read(name)+'</script>');
fs.writeFileSync(path.join(__dirname,'嵌入式系统实验室.html'),html);
fs.writeFileSync(path.join(__dirname,'examples','study-virtual-board.dts'),require('./boot.js').deviceTree());
console.log('Built offline 嵌入式系统实验室.html');
