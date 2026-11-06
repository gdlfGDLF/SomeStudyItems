const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
let html = read('index.html').replace('<link rel="stylesheet" href="style.css">', () => '<style>' + read('style.css') + '</style>');
for (const file of ['registers.js', 'scheduler.js', 'app.js']) {
  html = html.replace('<script src="' + file + '"></script>', () => '<script>' + read(file) + '</script>');
}
fs.writeFileSync(path.join(__dirname, 'RTOS与寄存器实验室.html'), html);
console.log('Built RTOS与寄存器实验室.html');
