// Сборка HLTV-Score-Widget.exe: node build.js  (нужен bun)
const fs = require('fs');
const { execSync } = require('child_process');
const pages = {};
for (const f of ['control.html', 'widget.html', 'home.html']) pages[f] = fs.readFileSync('public/' + f, 'utf8');
fs.writeFileSync('assets.js', 'module.exports = ' + JSON.stringify(pages) + ';\n');
const target = process.argv[2] || 'bun-windows-x64';
const out = process.argv[3] || 'dist/HLTV-Score-Widget.exe';
const win = target.includes('windows') ? ' --windows-hide-console' : '';
execSync(`bun build server.js --compile --minify --target=${target} --outfile "${out}"${win}`, { stdio: 'inherit' });
