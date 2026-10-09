#!/usr/bin/env node
'use strict';
/**
 * Crea dist/Jarvis.exe: un unico file con dentro Node.js, il server e l'app.
 * Da lanciare su Windows con Node.js 22:   node build/build-exe.js
 * (serve internet: scarica `postject` e, per l'icona, `rcedit`)
 *
 * Opzioni avanzate:
 *   NODE_EXE_PATH=C:\percorso\node.exe   usa questo node.exe come base (per costruire l'.exe da un altro sistema)
 */
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { bundle } = require('./bundle');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const WIN_TARGET = process.platform === 'win32' || !!process.env.NODE_EXE_PATH;
const exeName = WIN_TARGET ? 'Jarvis.exe' : 'jarvis';
const exe = path.join(dist, exeName);
const ico = path.join(root, 'build', 'jarvis.ico');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e013b8ee2f4a7f4c';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Serve Node.js 20.12 o più recente (meglio la 22). Hai la ${process.versions.node}.`);
  process.exit(1);
}

function walk(dir, base = '') {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, walk(path.join(dir, e.name), rel));
    else out[rel] = path.join(dir, e.name).replace(/\\/g, '/');
  }
  return out;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

console.log('1/5  Unisco i file…');
const main = bundle(path.join(dist, 'exe-main.js'));

console.log('2/5  Preparo il pacchetto (app incorporata)…');
const assets = { ...walk(path.join(root, 'public')), 'jarvis.ico': ico.replace(/\\/g, '/') };
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: main.replace(/\\/g, '/'),
  output: path.join(dist, 'sea-prep.blob').replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log(`3/5  Copio Node.js in dist/${exeName}…`);
fs.copyFileSync(process.env.NODE_EXE_PATH || process.execPath, exe);

console.log('4/5  Imposto l\'icona…');
if (process.platform === 'win32') {
  try {
    let rcedit = process.env.RCEDIT_PATH || path.join(dist, 'rcedit-x64.exe');
    if (!fs.existsSync(rcedit)) {
      execSync(`curl -fsSL -o "${rcedit}" https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe`, { stdio: 'inherit' });
    }
    execFileSync(rcedit, [exe, '--set-icon', ico, '--set-version-string', 'ProductName', 'Jarvis Remote',
      '--set-version-string', 'FileDescription', 'Jarvis Remote', '--set-version-string', 'OriginalFilename', 'Jarvis.exe']);
  } catch (e) {
    console.warn('     Icona non impostata (non è grave: l\'icona sul Desktop la mette comunque il programma):', e.message);
  }
} else console.log('     (solo su Windows)');

console.log('5/5  Incorporo il programma…');
const mac = process.platform === 'darwin' ? ' --macho-segment-name NODE_SEA' : '';
execSync(`npx --yes postject "${exe}" NODE_SEA_BLOB "${path.join(dist, 'sea-prep.blob')}" --sentinel-fuse ${FUSE}${mac}`, { stdio: 'inherit' });

for (const f of ['exe-main.js', 'sea-config.json', 'sea-prep.blob', 'rcedit-x64.exe']) fs.rmSync(path.join(dist, f), { force: true });
console.log(`\nFatto: dist/${exeName} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);
