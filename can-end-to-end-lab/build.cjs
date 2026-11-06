const fs=require('node:fs');
const path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,n),'utf8');
let html=read('index.html');
for(const name of ['style.css','serial.css']) html=html.replace('<link rel="stylesheet" href="'+name+'">',()=>'<style>'+read(name)+'</style>');
for(const name of ['wire.js','flow.js','app.js','spi.js','i2c.js','uart.js','serial-app.js']) html=html.replace('<script src="'+name+'"></script>',()=>'<script>'+read(name)+'</script>');
for(const name of ['总线实验室.html','CAN全链路实验室.html']) fs.writeFileSync(path.join(__dirname,name),html);
console.log('Built 总线实验室.html and compatible CAN全链路实验室.html');
