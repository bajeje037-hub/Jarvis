#!/usr/bin/env node
'use strict';
/**
 * Jarvis Remote: punto di ingresso di Jarvis.exe (funziona anche con `node launcher.js`).
 * Doppio clic sull'icona: avvia il server, prepara il link privato per il telefono (se c'è Tailscale)
 * e apre la finestra dell'app. Chiudere la finestra nera spegne Jarvis.
 *
 *   --no-window    non aprire la finestra dell'app
 *   --no-tunnel    non usare Tailscale anche se è installato
 *   --no-shortcut  non creare l'icona sul Desktop al primo avvio
 *   --shortcut     crea (di nuovo) le icone su Desktop e menu Start, poi esce
 *   --autostart    avvia Jarvis all'accesso a Windows (icona nella cartella Esecuzione automatica), poi esce
 *   --lan          ascolta anche sulla rete locale (solo http)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const WIN = process.platform === 'win32';
const DATA_DIR = process.env.JARVIS_REMOTE_HOME || path.join(os.homedir(), '.jarvis-remote');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const PORT = Number(process.env.PORT) || Number(readJSON(CONFIG_FILE, {}).port) || 8787;

// ───────── file incorporati (solo nell'.exe) ─────────
let sea = null;
try { const m = require('node:sea'); if (m.isSea()) sea = m; } catch { sea = null; }
if (sea) {
  // Il server legge la PWA da qui invece che dal disco.
  global.__jarvisAssets = (key) => { try { return Buffer.from(sea.getAsset(key)); } catch { return null; } };
}
function readAsset(key) {
  if (sea) return global.__jarvisAssets(key);
  for (const dir of [path.join(__dirname, 'build'), path.join(__dirname, '..', 'build')]) {
    try { return fs.readFileSync(path.join(dir, key)); } catch { /* prossimo */ }
  }
  return null;
}

// ───────── utilità ─────────
const say = (...a) => console.log(...a);
function setTitle(t) { if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${t}\x07`); }

function pauseAndExit(code) {
  // Con il doppio clic la finestra sparirebbe subito: si aspetta un tasto per poter leggere l'errore.
  if (WIN && process.stdin.isTTY) {
    say('\n  Premi Invio per chiudere…');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code));
  } else process.exit(code);
}
process.on('uncaughtException', (e) => { console.error('\n  Errore:', e && e.message ? e.message : e); pauseAndExit(1); });
process.on('SIGHUP', () => process.exit(0)); // chiusura della finestra su Windows

/** 'jarvis' = c'è già Jarvis su quella porta, 'free' = libera, 'other' = occupata da altro. */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/manifest.webmanifest', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body.includes('"short_name": "Jarvis"') ? 'jarvis' : 'other'));
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}
async function waitForJarvis(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await probe(port)) === 'jarvis') return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function which(name) {
  const exts = WIN ? ['.exe'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) {
      const p = path.join(dir, name + e);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* prossimo */ }
    }
  }
  return null;
}

// ───────── finestra dell'app ─────────
function findBrowser() {
  if (!WIN) return null;
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rels = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const rel of rels) {
    for (const b of bases) {
      const p = path.join(b, ...rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function openApp(url) {
  const detached = { detached: true, stdio: 'ignore', windowsHide: false };
  const browser = findBrowser();
  // Edge/Chrome in modalità «app»: finestra senza barra degli indirizzi, con il microfono e la dettatura del browser.
  if (browser) { spawn(browser, [`--app=${url}`, '--window-size=460,860'], detached).unref(); return; }
  if (WIN) spawn('rundll32', ['url.dll,FileProtocolHandler', url], detached).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], detached).on('error', () => {}).unref();
}

// ───────── Tailscale (link https privato per il telefono) ─────────
function findTailscale() {
  const p = which('tailscale');
  if (p) return p;
  if (WIN && process.env.ProgramFiles) {
    const f = path.join(process.env.ProgramFiles, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
let tailscaleBin = null;
function setupTailscale() {
  tailscaleBin = findTailscale();
  if (!tailscaleBin) return { missing: true };
  const serve = spawnSync(tailscaleBin, ['serve', '--bg', String(PORT)], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (serve.error || serve.status !== 0) {
    tailscaleBin = null;
    return { error: String((serve.stderr || serve.stdout || (serve.error && serve.error.message) || '')).trim().split('\n').slice(0, 3).join(' ') };
  }
  const st = spawnSync(tailscaleBin, ['status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  let dns = '';
  try { dns = String(JSON.parse(st.stdout).Self.DNSName || '').replace(/\.$/, ''); } catch { /* niente nome */ }
  if (!dns) return { error: 'Non riesco a leggere il nome Tailscale di questo PC.' };
  return { url: `https://${dns}` };
}
process.on('exit', () => {
  if (tailscaleBin) { try { spawnSync(tailscaleBin, ['serve', 'reset'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }); } catch { /* ignora */ } }
});

// ───────── icone su Desktop / menu Start / avvio automatico (Windows) ─────────
function createShortcuts(mode) {
  if (!WIN) { say('  Le icone si creano solo su Windows.'); return false; }
  if (!sea) { say('  Le icone si creano dal programma Jarvis.exe, non da «node launcher.js».'); return false; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ico = path.join(DATA_DIR, 'jarvis.ico');
  const data = readAsset('jarvis.ico');
  if (data) fs.writeFileSync(ico, data);
  const script = [
    "$ErrorActionPreference='Stop'",
    '$exe=$env:JR_EXE; $ico=$env:JR_ICO',
    "function Mk($dir,$a){ $l=Join-Path $dir 'Jarvis.lnk'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath=$exe; $s.Arguments=$a; $s.WorkingDirectory=(Split-Path $exe); if(Test-Path $ico){$s.IconLocation=$ico}; $s.Description='Jarvis Remote'; $s.Save() }",
    "if($env:JR_MODE -eq 'startup'){ Mk ([Environment]::GetFolderPath('Startup')) '--no-window' } else { Mk ([Environment]::GetFolderPath('Desktop')) ''; Mk ([Environment]::GetFolderPath('Programs')) '' }",
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, JR_EXE: process.execPath, JR_ICO: ico, JR_MODE: mode }, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (r.status !== 0) { say('  Non sono riuscito a creare l\'icona:', String(r.stderr || r.error || '').trim().split('\n')[0]); return false; }
  return true;
}

// ───────── avvio ─────────
const HELP = `
  Jarvis Remote

  --no-window    non aprire la finestra dell'app
  --no-tunnel    non usare Tailscale anche se è installato
  --no-shortcut  non creare l'icona sul Desktop al primo avvio
  --shortcut     crea (di nuovo) le icone su Desktop e menu Start, poi esce
  --autostart    avvia Jarvis all'accesso a Windows, poi esce
  --lan          ascolta anche sulla rete locale (solo http)
`;

function accessLink(base) {
  const token = readJSON(CONFIG_FILE, {}).token;
  return token ? `${base}/?t=${token}` : base;
}

async function main() {
  setTitle('Jarvis Remote');
  if (has('--help') || has('-h')) { say(HELP); return; }
  if (has('--shortcut')) { say(createShortcuts('desktop') ? '  Icone create su Desktop e menu Start.' : ''); return; }
  if (has('--autostart')) { say(createShortcuts('startup') ? '  Jarvis partirà da solo quando accedi a Windows.' : ''); return; }

  const local = `http://127.0.0.1:${PORT}`;
  const state = await probe(PORT);
  if (state === 'other') {
    console.error(`\n  La porta ${PORT} è occupata da un altro programma. Chiudilo oppure avvia con PORT=8788.`);
    return pauseAndExit(1);
  }
  if (state === 'jarvis') {
    say('\n  Jarvis è già acceso: apro la finestra.');
    if (!has('--no-window')) openApp(accessLink(local));
    return undefined;
  }

  // Prima volta: icona sul Desktop e nel menu Start.
  const marker = path.join(DATA_DIR, '.shortcut-done');
  if (WIN && sea && !has('--no-shortcut') && !fs.existsSync(marker)) {
    if (createShortcuts('desktop')) { say('\n  Ho creato l\'icona «Jarvis» sul Desktop e nel menu Start.'); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); }
  }

  process.env.PORT = String(PORT);
  let tailscaleNote = '';
  if (!has('--no-tunnel') && !has('--lan')) {
    const t = setupTailscale();
    if (t.url) process.env.JARVIS_PUBLIC_URL = t.url;
    else if (t.missing) tailscaleNote = 'Per usare Jarvis dal telefono installa Tailscale (https://tailscale.com/download), accedi e riavvia Jarvis.';
    else tailscaleNote = `Tailscale è installato ma non risponde: ${t.error}`;
  }

  require('./server'); // parte in ascolto e stampa il link di accesso

  if (!(await waitForJarvis(PORT))) { console.error('\n  Il server non è partito.'); return pauseAndExit(1); }
  if (tailscaleNote) say(`  ${tailscaleNote}\n`);
  say('  Chiudi questa finestra per spegnere Jarvis.\n');
  if (!has('--no-window')) openApp(accessLink(local));
  return undefined;
}

main().catch((e) => { console.error('\n  Errore:', e && e.message ? e.message : e); pauseAndExit(1); });
