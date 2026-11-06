// Produces a dependency-free HTML deliverable; source files remain editable.
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname,name),'utf8');
const html = read('index.html')
 .replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+read('style.css')+'</style>')
 .replace('<script src="engine.js"></script>',()=>'<script>'+read('engine.js')+'</script>')
 .replace('<script src="app.js"></script>',()=>'<script>'+read('app.js')+'</script>');
fs.writeFileSync(path.join(__dirname,'通信实验室.html'),html);
console.log('Built standalone 通信实验室.html ('+Buffer.byteLength(html)+' bytes)');
