const fs=require('node:fs');
const path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
let html=read('index.html').replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+read('style.css')+'</style>');
for(const name of ['wire.js','flow.js','app.js']) html=html.replace('<script src="'+name+'"></script>',()=>'<script>'+read(name)+'</script>');
fs.writeFileSync(path.join(__dirname,'CAN全链路实验室.html'),html);
console.log('Built standalone CAN全链路实验室.html');
