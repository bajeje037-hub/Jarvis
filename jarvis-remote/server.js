#!/usr/bin/env node
'use strict';
/**
 * Jarvis Remote: server companion + PWA.
 * Gira sul Mac (o su qualsiasi PC con Claude Code), lancia `claude -p` come fa Jarvis
 * e manda gli aggiornamenti a telefono/PC via Server-Sent Events. Nessuna dipendenza npm.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { parseClaudeLine } = require('./lib/parser');

// ───────────────────────── configurazione ─────────────────────────
const DATA_DIR = process.env.JARVIS_REMOTE_HOME || path.join(os.homedir(), '.jarvis-remote');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Nell'.exe i file della PWA sono incorporati: il launcher imposta questa funzione (chiave → Buffer | null).
const ASSETS = typeof global.__jarvisAssets === 'function' ? global.__jarvisAssets : null;

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',          // 0.0.0.0 solo se sai cosa stai facendo (--lan)
  projectsRoot: os.homedir(), // le sottocartelle di questa cartella sono i "progetti"
  defaultCwd: os.homedir(),   // dove partono le richieste che non riguardano un progetto
  allowBypass: false,         // true = le sessioni possono saltare i permessi (pericoloso)
  model: '',                  // vuoto = modello predefinito di Claude Code
  maxRunning: 6,
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSONAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

const config = { ...DEFAULTS, ...readJSON(CONFIG_FILE, {}) };
if (!config.token || String(config.token).length < 24) config.token = crypto.randomBytes(24).toString('base64url');
writeJSONAtomic(CONFIG_FILE, config);
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.JARVIS_HOST) config.host = process.env.JARVIS_HOST;
if (process.argv.includes('--lan')) config.host = '0.0.0.0';
if (process.env.JARVIS_PROJECTS_ROOT) config.projectsRoot = process.env.JARVIS_PROJECTS_ROOT;

// ───────────────────────── autenticazione ─────────────────────────
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const tokenOk = (candidate) => !!candidate && crypto.timingSafeEqual(sha(candidate), sha(config.token));

const failures = new Map(); // ip -> [timestamp...]
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || '?';
}
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  failures.set(ip, list);
  return list.length >= 10;
}
function noteFailure(ip) {
  const list = failures.get(ip) || [];
  list.push(Date.now());
  failures.set(ip, list);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isAuthed(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ') && tokenOk(h.slice(7))) return true;
  return tokenOk(parseCookies(req).jr_token);
}
function cookieHeader(req, value, maxAge) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `jr_token=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

// ───────────────────────── memoria ─────────────────────────
let memory = readJSON(MEMORY_FILE, []);
if (!Array.isArray(memory)) memory = [];
const MEMORY_RE = /^\s*(ricordati( che)?|ricorda( che)?|d['’]ora in poi|da ora in poi)\b/i;
function saveMemory(text) {
  memory.push({ text: text.trim().slice(0, 500), ts: Date.now() });
  memory = memory.slice(-50);
  writeJSONAtomic(MEMORY_FILE, memory);
}

// ───────────────────────── sessioni ─────────────────────────
/** @type {Map<string, any>} */
const sessions = new Map();
const procs = new Map(); // id -> {child, stopPresses}

for (const s of readJSON(SESSIONS_FILE, [])) {
  if (s.status === 'running') { s.status = 'stopped'; s.activity = 'Interrotta dal riavvio del server'; s.endedAt = Date.now(); }
  sessions.set(s.id, s);
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { writeJSONAtomic(SESSIONS_FILE, [...sessions.values()]); } catch (e) { console.error('persist:', e.message); }
  }, 400);
}

function summary(s) {
  const { timeline, ...rest } = s; // eslint-disable-line no-unused-vars
  return rest;
}

const clients = new Set();
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(obj) { for (const c of clients) { try { sse(c, obj); } catch { clients.delete(c); } } }
function snapshot() {
  return { type: 'snapshot', sessions: [...sessions.values()].map(summary).sort((a, b) => b.startedAt - a.startedAt) };
}

function trimSessions() {
  const all = [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  for (const s of all.slice(100)) if (s.status !== 'running') removeSession(s.id);
}
function removeSession(id) {
  sessions.delete(id);
  try { fs.unlinkSync(path.join(LOG_DIR, `${id}.ndjson`)); } catch { /* niente log */ }
}

// ───────────────────────── CLI ─────────────────────────
const EXTRA_DIRS = [
  '~/.npm-global/bin', '~/.local/bin', '~/.claude/local', '~/.bun/bin', '~/.volta/bin',
  '~/.local/share/fnm/aliases/default/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
].map((d) => d.replace(/^~/, os.homedir()));
if (process.platform === 'win32') {
  // Installer nativo: %USERPROFILE%\.local\bin\claude.exe (già in lista); WinGet e npm mettono i link qui.
  if (process.env.LOCALAPPDATA) EXTRA_DIRS.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  if (process.env.APPDATA) EXTRA_DIRS.push(path.join(process.env.APPDATA, 'npm'));
}

function searchPath() {
  const seen = new Set();
  const out = [];
  for (const d of [...String(process.env.PATH || '').split(path.delimiter), ...EXTRA_DIRS]) {
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // Su Windows serve il vero eseguibile: Node non può avviare gli script .cmd senza una shell.
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of searchPath()) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* prossimo */ }
    }
  }
  return null;
}
function childEnv() {
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH'; // su Windows è "Path"
  env[pathKey] = searchPath().join(path.delimiter);
  delete env.ANTHROPIC_API_KEY; // usa l'abbonamento Claude Code, mai il consumo a pagamento
  delete env.OPENAI_API_KEY;
  return env;
}

const GUIDANCE = `You are run headlessly by a voice assistant that the user controls remotely from a phone or another computer; nobody can answer questions, so make sensible decisions and finish the job.
You have the user's connected tools (MCP servers: calendar, email, task managers, browsers…); use them for any "check / look up / find / send" request and report the answer in your final sentence(s) — that text is read aloud.
If asked to run, serve or preview something: start servers DETACHED so they outlive this session (e.g. \`nohup python3 -m http.server 6000 > /tmp/jarvis-serve.log 2>&1 &\`), confirm the port is listening and state the URL in your final sentence. The user is NOT in front of this computer, so never rely on opening a browser window.
While you work, before each major step write one short sentence (max 15 words) in the same language as the task saying what you are about to do, the way a colleague would say it out loud ("Ora controllo i test della home"). These lines are read aloud as progress updates, so no code, paths longer than a file name, or markdown in them.
End with one short sentence stating what changed and any URL, written in the same language as the task (it is read aloud).`;

function guidance() {
  if (!memory.length) return GUIDANCE;
  return `${GUIDANCE}\n\nUser preferences (always follow):\n${memory.map((m) => `- ${m.text}`).join('\n')}`;
}

function push(s, entry) {
  s.timeline.push({ ...entry, ts: Date.now() });
  if (s.timeline.length > 300) s.timeline.splice(0, s.timeline.length - 300);
}

function handleAgentEvent(s, e) {
  switch (e.kind) {
    case 'sessionID': s.agentSessionId = e.id; break;
    case 'activity': s.activity = e.text; push(s, { k: 'activity', t: e.text }); break;
    case 'text': s.lastText = e.text; push(s, { k: 'text', t: e.text }); break;
    case 'needsInput': s.needsInput = true; break;
    case 'result':
      s.result = e.text || s.lastText || '';
      s.isError = e.isError;
      if (s.result) push(s, { k: 'result', t: s.result });
      break;
    default: break;
  }
  if (e.kind !== 'sessionID') broadcast({ type: 'event', id: s.id, event: e });
  broadcast({ type: 'update', session: summary(s) });
  persist();
}

function runAgent(s, task, resume) {
  const bin = findClaude();
  if (!bin) throw httpError(500, 'Claude Code non trovato. Installalo (su Windows: irm https://claude.ai/install.ps1 | iex), fai il login, oppure imposta CLAUDE_BIN.');
  const bypass = s.mode === 'bypass' && config.allowBypass;
  const args = ['-p', task, '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', guidance(),
    '--permission-mode', bypass ? 'bypassPermissions' : 'acceptEdits'];
  if (resume) args.push('--resume', resume);
  if (config.model) args.push('--model', config.model);

  s.status = 'running';
  s.activity = 'Parte…';
  s.needsInput = false;
  s.isError = false;
  s.result = '';
  s.lastText = '';
  s.endedAt = null;
  s.turns = (s.turns || 0) + 1;
  push(s, { k: 'user', t: task });

  const child = spawn(bin, args, { cwd: s.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  procs.set(s.id, { child, stopPresses: 0 });
  const log = fs.createWriteStream(path.join(LOG_DIR, `${s.id}.ndjson`), { flags: 'a', mode: 0o600 });
  let stderrTail = '';
  let finished = false;

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(line + '\n');
    for (const e of parseClaudeLine(line)) handleAgentEvent(s, e);
  });
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    log.write(`[stderr] ${line}\n`);
    stderrTail = (stderrTail + '\n' + line).slice(-400);
  });

  const finish = (code, spawnError) => {
    if (finished) return;
    finished = true;
    procs.delete(s.id);
    log.end();
    const stopped = s.stopRequested;
    s.stopRequested = false;
    if (stopped) s.status = 'stopped';
    else if (spawnError) { s.status = 'error'; s.result = `Impossibile avviare Claude Code: ${spawnError.message}`; }
    else if (code === 0 && !s.isError) s.status = s.needsInput ? 'needs_input' : 'done';
    else s.status = s.needsInput ? 'needs_input' : 'error';
    if (s.status === 'error' && !s.result) s.result = stderrTail.trim() || `Claude Code è terminato con codice ${code}`;
    s.activity = '';
    s.endedAt = Date.now();
    broadcast({ type: 'event', id: s.id, event: { kind: 'finish', status: s.status, text: s.result || s.lastText || '' } });
    broadcast({ type: 'update', session: summary(s) });
    persist();
  };
  child.on('error', (err) => finish(-1, err));
  child.on('close', (code) => finish(code));
  broadcast({ type: 'update', session: summary(s) });
  persist();
}

function killTree(child, signal) {
  if (process.platform === 'win32' && child.pid) {
    // Windows non ha SIGINT per i processi figli: si chiude l'intero albero (claude + shell + comandi).
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else child.kill(signal);
}

function stopSession(id) {
  const p = procs.get(id);
  const s = sessions.get(id);
  if (!p || !s) return false;
  s.stopRequested = true;
  p.stopPresses += 1;
  if (p.stopPresses >= 2) killTree(p.child, 'SIGKILL');
  else {
    killTree(p.child, 'SIGINT');
    setTimeout(() => { if (procs.get(id) === p) killTree(p.child, 'SIGKILL'); }, 3000).unref();
  }
  return true;
}

// ───────────────────────── progetti ─────────────────────────
function listProjects() {
  try {
    return fs.readdirSync(config.projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 200);
  } catch { return []; }
}
function resolveProject(name) {
  if (!name) return { project: '', cwd: config.defaultCwd };
  const root = path.resolve(config.projectsRoot);
  const full = path.resolve(root, String(name));
  if (path.dirname(full) !== root) throw httpError(400, 'Progetto non valido');
  let ok = false;
  try { ok = fs.statSync(full).isDirectory(); } catch { /* non esiste */ }
  if (!ok) throw httpError(404, `La cartella "${name}" non esiste`);
  return { project: path.basename(full), cwd: full };
}

// ───────────────────────── HTTP ─────────────────────────
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function sendJSON(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(httpError(413, 'Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'JSON non valido')); }
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  const route = url.pathname;

  if (req.method === 'POST' && route === '/api/login') {
    if (tooManyFailures(ip)) throw httpError(429, 'Troppi tentativi: riprova tra qualche minuto');
    if (req.headers['x-jarvis'] !== '1') throw httpError(403, 'Richiesta non valida');
    const { token } = await readBody(req);
    if (!tokenOk(token)) { noteFailure(ip); throw httpError(401, 'Codice non valido'); }
    return sendJSON(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, config.token, 31536000) });
  }

  if (!isAuthed(req)) {
    if (tooManyFailures(ip)) throw httpError(429, 'Troppi tentativi: riprova tra qualche minuto');
    noteFailure(ip);
    throw httpError(401, 'Non autenticato');
  }
  // Protezione CSRF: le richieste che modificano qualcosa devono portare un header che un altro sito non può inviare.
  if (req.method !== 'GET' && req.headers['x-jarvis'] !== '1') throw httpError(403, 'Richiesta non valida');

  if (req.method === 'POST' && route === '/api/logout') {
    return sendJSON(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, '', 0) });
  }
  if (req.method === 'GET' && route === '/api/me') {
    return sendJSON(res, 200, {
      ok: true, allowBypass: config.allowBypass, claude: !!findClaude(),
      host: os.hostname(), memory,
      link: process.env.JARVIS_PUBLIC_URL ? `${process.env.JARVIS_PUBLIC_URL.replace(/\/$/, '')}/?t=${config.token}` : null,
    });
  }
  if (req.method === 'GET' && route === '/api/projects') return sendJSON(res, 200, { projects: listProjects() });

  if (req.method === 'GET' && route === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sse(res, snapshot());
    clients.add(res);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* chiuso */ } }, 20000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return undefined;
  }

  if (req.method === 'GET' && route === '/api/sessions') return sendJSON(res, 200, snapshot());

  if (req.method === 'DELETE' && route === '/api/memory') {
    memory = [];
    writeJSONAtomic(MEMORY_FILE, memory);
    return sendJSON(res, 200, { ok: true, memory });
  }
  const mem = route.match(/^\/api\/memory\/(\d+)$/);
  if (req.method === 'DELETE' && mem) {
    memory.splice(Number(mem[1]), 1);
    writeJSONAtomic(MEMORY_FILE, memory);
    return sendJSON(res, 200, { ok: true, memory });
  }

  if (req.method === 'POST' && route === '/api/sessions') {
    const body = await readBody(req);
    const task = String(body.task || '').trim().slice(0, 4000);
    if (!task) throw httpError(400, 'Dimmi cosa vuoi fare');
    if (MEMORY_RE.test(task)) { saveMemory(task); return sendJSON(res, 200, { memory: true, text: task, items: memory }); }
    if ([...sessions.values()].filter((x) => x.status === 'running').length >= config.maxRunning) {
      throw httpError(429, `Ci sono già ${config.maxRunning} sessioni in corso`);
    }
    const { project, cwd } = resolveProject(body.project);
    const s = {
      id: crypto.randomUUID(), title: task.slice(0, 140), project, cwd, mode: body.mode === 'bypass' ? 'bypass' : 'safe',
      status: 'running', activity: '', lastText: '', result: '', isError: false, needsInput: false,
      agentSessionId: null, startedAt: Date.now(), endedAt: null, turns: 0, timeline: [],
    };
    sessions.set(s.id, s);
    try { runAgent(s, task, null); } catch (e) { sessions.delete(s.id); throw e; }
    trimSessions();
    return sendJSON(res, 201, { session: summary(s) });
  }

  const m = route.match(/^\/api\/sessions\/([0-9a-f-]{36})(\/(continue|stop))?$/);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) throw httpError(404, 'Sessione non trovata');
    const action = m[3];
    if (req.method === 'GET' && !action) return sendJSON(res, 200, { session: s });
    if (req.method === 'POST' && action === 'stop') {
      if (!stopSession(s.id)) throw httpError(409, 'La sessione non è in corso');
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'continue') {
      const body = await readBody(req);
      const task = String(body.task || '').trim().slice(0, 4000);
      if (!task) throw httpError(400, 'Dimmi cosa vuoi aggiungere');
      if (s.status === 'running') throw httpError(409, 'La sessione sta ancora lavorando');
      if (!s.agentSessionId) throw httpError(409, 'Questa sessione non si può riprendere: aprine una nuova');
      runAgent(s, task, s.agentSessionId);
      return sendJSON(res, 200, { session: summary(s) });
    }
    if (req.method === 'DELETE' && !action) {
      if (s.status === 'running') stopSession(s.id);
      removeSession(s.id);
      broadcast({ type: 'removed', id: s.id });
      persist();
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (req.method === 'DELETE' && route === '/api/sessions') {
    for (const s of [...sessions.values()]) if (s.status !== 'running') removeSession(s.id);
    broadcast(snapshot());
    persist();
    return sendJSON(res, 200, { ok: true });
  }

  throw httpError(404, 'Non trovato');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Metodo non consentito');
  // Link di accesso: /?t=CODICE imposta il cookie e ripulisce l'indirizzo.
  if (url.pathname === '/' && url.searchParams.has('t')) {
    if (tokenOk(url.searchParams.get('t'))) {
      res.writeHead(302, { location: '/', 'set-cookie': cookieHeader(req, config.token, 31536000), 'cache-control': 'no-store' });
    } else {
      noteFailure(clientIp(req));
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
    }
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'Indirizzo non valido'); }
  if (rel === '/') rel = '/index.html';
  let data;
  let ext;
  if (ASSETS) {
    const key = path.posix.normalize(rel).replace(/^\/+/, '');
    if (key.startsWith('..')) throw httpError(403, 'Vietato');
    data = ASSETS(key);
    if (!data) throw httpError(404, 'Non trovato');
    ext = path.posix.extname(key).toLowerCase();
  } else {
    const full = path.resolve(PUBLIC_DIR, '.' + rel);
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) throw httpError(403, 'Vietato');
    try { data = fs.readFileSync(full); } catch { throw httpError(404, 'Non trovato'); }
    ext = path.extname(full).toLowerCase();
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  return res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    const wantsJSON = String(req.url).startsWith('/api/');
    if (wantsJSON) sendJSON(res, status, { error: e.status ? e.message : 'Errore interno' });
    else { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.status ? e.message : 'Errore interno'); }
  }
  return undefined;
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`La porta ${config.port} è già in uso. Cambia porta con PORT=8788 node server.js`);
  else console.error(e);
  process.exit(1);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

server.listen(config.port, config.host, () => {
  const base = (process.env.JARVIS_PUBLIC_URL || `http://localhost:${config.port}`).replace(/\/$/, '');
  const claude = findClaude();
  console.log('\n  Jarvis Remote è acceso\n');
  console.log(`  Claude Code: ${claude || 'NON TROVATO (installalo e fai il login)'}`);
  console.log(`  Progetti:    ${config.projectsRoot}`);
  console.log(`  In ascolto:  ${config.host}:${config.port}`);
  if (config.allowBypass) console.log('  ATTENZIONE:  allowBypass è attivo, le sessioni possono saltare i permessi');
  console.log(`\n  Link di accesso (apri sul telefono o sul PC):\n  ${base}/?t=${config.token}\n`);
  if (config.host === '0.0.0.0') {
    for (const ip of lanAddresses()) console.log(`  Rete locale: http://${ip}:${config.port}/?t=${config.token}`);
    console.log('  (in HTTP il microfono e l\'installazione non funzionano: usa un indirizzo https)\n');
  }
  console.log('  Il codice di accesso è in', CONFIG_FILE, '\n');
});

function shutdown() {
  for (const [id, p] of procs) {
    const s = sessions.get(id);
    if (s) { s.stopRequested = true; }
    killTree(p.child, 'SIGINT');
  }
  try { writeJSONAtomic(SESSIONS_FILE, [...sessions.values()]); } catch { /* ignora */ }
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, config };
