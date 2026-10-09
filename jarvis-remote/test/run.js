'use strict';
// Test end-to-end con un finto `claude`: node test/run.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { parseClaudeLine } = require('../lib/parser');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-home-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-proj-'));
fs.mkdirSync(path.join(root, 'sito'));
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const call = async (p, { method = 'GET', body, headers = {}, auth = true } = {}) => {
  const res = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-jarvis': '1' } : {}), ...(auth && cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non json */ }
  return { status: res.status, json, text, res };
};
let passed = 0;
const ok = (name) => { passed += 1; console.log('  ✓', name); };

(async () => {
  // parser
  const evs = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b/c/d/Hero.tsx' } }] } }));
  assert.deepStrictEqual(evs, [{ kind: 'activity', text: 'Modifica c/d/Hero.tsx' }]);
  assert.deepStrictEqual(parseClaudeLine('non json'), []);
  ok('parser');

  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), JARVIS_REMOTE_HOME: home, CLAUDE_BIN: path.join(__dirname, 'mock-claude.js'), JARVIS_PROJECTS_ROOT: root },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let banner = '';
  srv.stdout.on('data', (d) => { banner += d; });
  try {
    for (let i = 0; i < 50 && !banner.includes('/?t='); i += 1) await sleep(100);
    const token = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).token;
    assert.ok(banner.includes(`/?t=${token}`)); ok('avvio e link con codice');
    assert.strictEqual((fs.statSync(path.join(home, 'config.json')).mode & 0o777), 0o600); ok('config.json è privato (600)');

    assert.strictEqual((await call('/api/sessions', { auth: false })).status, 401); ok('API senza codice → 401');
    assert.strictEqual((await call('/api/login', { method: 'POST', body: { token: 'sbagliato' }, auth: false })).status, 401); ok('codice errato → 401');
    assert.strictEqual((await call('/api/login', { method: 'POST', body: { token }, auth: false, headers: { 'x-jarvis': '' } })).status, 403); ok('login senza header anti-CSRF → 403');

    const login = await call('/api/login', { method: 'POST', body: { token }, auth: false });
    assert.strictEqual(login.status, 200);
    cookie = login.res.headers.get('set-cookie').split(';')[0];
    assert.ok(/HttpOnly/.test(login.res.headers.get('set-cookie')) && /SameSite=Strict/.test(login.res.headers.get('set-cookie'))); ok('login imposta cookie HttpOnly + SameSite=Strict');

    const link = await call(`/?t=${token}`, { auth: false });
    assert.strictEqual(link.status, 302); assert.strictEqual(link.res.headers.get('location'), '/'); assert.ok(link.res.headers.get('set-cookie')); ok('link /?t= imposta il cookie e ripulisce l\'indirizzo');

    const page = await call('/', { auth: false });
    assert.strictEqual(page.status, 200); assert.ok(page.text.includes('<title>Jarvis</title>')); ok('la PWA è servita');
    assert.strictEqual((await call('/manifest.webmanifest', { auth: false })).status, 200); ok('manifest');
    assert.strictEqual((await call('/..%2F..%2Fetc%2Fpasswd', { auth: false })).status >= 400, true); ok('path traversal bloccato');

    assert.strictEqual((await call('/api/sessions', { method: 'POST', body: { task: 'x' }, headers: { 'x-jarvis': '' } })).status, 403); ok('POST senza header anti-CSRF → 403');
    assert.deepStrictEqual((await call('/api/projects')).json.projects, ['sito']); ok('elenco progetti');
    assert.strictEqual((await call('/api/sessions', { method: 'POST', body: { task: 'ciao', project: '../..' } })).status, 400); ok('progetto fuori dalla root rifiutato');

    // flusso completo
    const created = await call('/api/sessions', { method: 'POST', body: { task: 'fai il sito', project: 'sito' } });
    assert.strictEqual(created.status, 201);
    const id = created.json.session.id;
    let s;
    for (let i = 0; i < 40; i += 1) { await sleep(100); s = (await call(`/api/sessions/${id}`)).json.session; if (s.status !== 'running') break; }
    assert.strictEqual(s.status, 'done'); assert.strictEqual(s.result, 'Fatto: fai il sito'); assert.ok(s.agentSessionId);
    assert.ok(s.timeline.some((e) => e.k === 'activity' && e.t.startsWith('Scrive'))); assert.strictEqual(s.cwd, path.join(root, 'sito')); ok('sessione completa: avvio, attività, risultato, cartella progetto');

    // continuazione
    const cont = await call(`/api/sessions/${id}/continue`, { method: 'POST', body: { task: 'aggiungi il footer' } });
    assert.strictEqual(cont.status, 200);
    for (let i = 0; i < 40; i += 1) { await sleep(100); s = (await call(`/api/sessions/${id}`)).json.session; if (s.status !== 'running') break; }
    assert.ok(s.result.includes('(ripresa)')); assert.strictEqual(s.turns, 2); ok('continua con --resume');

    // errore
    const bad = await call('/api/sessions', { method: 'POST', body: { task: 'FAIL' } });
    let b;
    for (let i = 0; i < 40; i += 1) { await sleep(100); b = (await call(`/api/sessions/${bad.json.session.id}`)).json.session; if (b.status !== 'running') break; }
    assert.strictEqual(b.status, 'error'); assert.ok(b.result.includes('boom')); ok('errore del processo riportato');

    // stop
    const slow = await call('/api/sessions', { method: 'POST', body: { task: 'SLOW' } });
    await sleep(400);
    assert.strictEqual((await call(`/api/sessions/${slow.json.session.id}/stop`, { method: 'POST' })).status, 200);
    let sl;
    for (let i = 0; i < 40; i += 1) { await sleep(100); sl = (await call(`/api/sessions/${slow.json.session.id}`)).json.session; if (sl.status !== 'running') break; }
    assert.strictEqual(sl.status, 'stopped'); ok('stop (SIGINT) ferma la sessione');

    // memoria
    const mem = await call('/api/sessions', { method: 'POST', body: { task: 'ricordati che preferisco TypeScript' } });
    assert.strictEqual(mem.json.memory, true); assert.strictEqual((await call('/api/me')).json.memory.length, 1); ok('memoria: «ricordati che…»');
    assert.strictEqual((await call('/api/memory/0', { method: 'DELETE' })).json.memory.length, 0); ok('memoria: dimentica');

    // SSE
    const ctl = new AbortController();
    const sseRes = await fetch(base + '/api/events', { headers: { cookie }, signal: ctl.signal });
    const reader = sseRes.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value) + new TextDecoder().decode((await reader.read()).value);
    assert.ok(first.includes('"type":"snapshot"')); ctl.abort(); ok('SSE: snapshot iniziale');

    // pulizia
    await call('/api/sessions', { method: 'DELETE' });
    assert.strictEqual((await call('/api/sessions')).json.sessions.length, 0); ok('pulisci sessioni');

    // blocco dopo troppi tentativi
    let last;
    for (let i = 0; i < 12; i += 1) last = await call('/api/login', { method: 'POST', body: { token: 'x' + i }, auth: false });
    assert.strictEqual(last.status, 429); ok('troppi tentativi → 429');

    console.log(`\n${passed} controlli superati`);
  } finally {
    srv.kill('SIGINT');
  }
})().catch((e) => { console.error('\nFALLITO:', e.message); process.exit(1); });
