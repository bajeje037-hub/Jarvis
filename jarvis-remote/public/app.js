'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const sessions = new Map();
  const mine = new Set();            // sessioni avviate da questo dispositivo: solo queste vengono lette a voce
  let projects = [];
  let es = null;
  let openId = null;                 // sessione aperta nel pannello dettaglio
  let detailData = null;

  // ───────── preferenze ─────────
  const prefs = { speak: true, wake: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('jarvis-prefs') || '{}')); } catch { /* ignora */ }
  const savePrefs = () => { try { localStorage.setItem('jarvis-prefs', JSON.stringify(prefs)); } catch { /* ignora */ } };

  // ───────── rete ─────────
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-jarvis': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Non autenticato'); }
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  // ───────── schermate ─────────
  function showLogin() {
    if (es) { es.close(); es = null; }
    $('#home').hidden = true; $('#login').hidden = false;
  }
  async function showHome() {
    $('#login').hidden = true; $('#home').hidden = false;
    const me = await api('/api/me');
    $('#host').textContent = me.host;
    renderMemory(me.memory || []);
    $('#share').hidden = !me.link;
    if (me.link) $('#share-link').value = me.link;
    if (!me.claude) toast('Claude Code non è stato trovato sul Mac: installalo e fai il login.');
    const p = await api('/api/projects').catch(() => ({ projects: [] }));
    projects = p.projects;
    const sel = $('#project');
    sel.innerHTML = '';
    sel.append(new Option('Cartella predefinita', ''));
    for (const name of projects) sel.append(new Option(name, name));
    connect();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error'); err.hidden = true;
    try {
      await api('/api/login', { method: 'POST', body: { token: $('#token').value.trim() } });
      $('#token').value = '';
      await showHome();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  // ───────── aggiornamenti in tempo reale ─────────
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onopen = () => { $('#conn').className = 'conn on'; };
    es.onerror = () => {
      $('#conn').className = 'conn off';
      api('/api/me').catch(() => { /* se è 401 mostra il login */ });
    };
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'snapshot') { sessions.clear(); for (const s of msg.sessions) sessions.set(s.id, s); renderList(); }
      else if (msg.type === 'update') { sessions.set(msg.session.id, msg.session); renderList(); if (msg.session.id === openId) refreshDetail(); }
      else if (msg.type === 'removed') { sessions.delete(msg.id); renderList(); if (msg.id === openId) $('#detail').close(); }
      else if (msg.type === 'event') onAgentEvent(msg.id, msg.event);
    };
  }

  // ───────── elenco ─────────
  const STATUS = { running: 'In corso', done: 'Finita', error: 'Errore', stopped: 'Fermata', needs_input: 'Serve il tuo ok' };
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'ora';
    if (s < 3600) return `${Math.floor(s / 60)} min fa`;
    if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
    return `${Math.floor(s / 86400)} g fa`;
  }
  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    const items = [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const s of items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'row'; b.dataset.status = s.status;
      const sub = s.status === 'running' ? (s.activity || 'Sta lavorando…') : (s.result || STATUS[s.status]);
      b.innerHTML = '<span class="rail"></span><span><div class="row-title"></div><div class="row-sub"></div></span><span class="row-side"></span>';
      $('.row-title', b).textContent = s.title;
      $('.row-sub', b).textContent = (s.project ? `${s.project} · ` : '') + sub.replace(/\s+/g, ' ');
      $('.row-side', b).textContent = `${STATUS[s.status] || ''}\n${ago(s.startedAt)}`.replace('\n', ' · ');
      b.addEventListener('click', () => openDetail(s.id));
      li.append(b); list.append(li);
    }
  }
  setInterval(() => { if (!$('#home').hidden) renderList(); }, 30000);

  $('#clear').addEventListener('click', () => api('/api/sessions', { method: 'DELETE' }).catch((e) => toast(e.message)));

  // ───────── dettaglio ─────────
  async function openDetail(id) {
    openId = id;
    await refreshDetail();
    if (!$('#detail').open) $('#detail').showModal();
  }
  async function refreshDetail() {
    try { detailData = (await api(`/api/sessions/${openId}`)).session; } catch (e) { toast(e.message); return; }
    const s = detailData;
    $('#d-title').textContent = s.title;
    $('#d-meta').textContent = `${STATUS[s.status]} · ${s.project || 'cartella predefinita'}${s.turns > 1 ? ` · ${s.turns} richieste` : ''}`;
    const tl = $('#d-timeline'); tl.innerHTML = '';
    for (const e of s.timeline) {
      const li = document.createElement('li');
      li.className = e.k === 'result' ? `result${s.isError ? ' err' : ''}` : e.k;
      li.textContent = e.t;
      tl.append(li);
    }
    $('#d-stop').hidden = s.status !== 'running';
    $('#d-continue').hidden = s.status === 'running' || !s.agentSessionId;
    tl.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }
  $('#d-close').addEventListener('click', () => $('#detail').close());
  $('#detail').addEventListener('close', () => { openId = null; });
  $('#d-stop').addEventListener('click', () => api(`/api/sessions/${openId}/stop`, { method: 'POST' }).catch((e) => toast(e.message)));
  $('#d-delete').addEventListener('click', () => api(`/api/sessions/${openId}`, { method: 'DELETE' }).then(() => $('#detail').close()).catch((e) => toast(e.message)));
  $('#d-read').addEventListener('click', () => {
    const s = detailData; if (!s) return;
    speak(cleanForSpeech(s.result || s.lastText || s.activity || 'Non c\'è ancora niente da leggere.'), true);
  });
  $('#d-continue').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#d-task').value.trim(); if (!text) return;
    try {
      await api(`/api/sessions/${openId}/continue`, { method: 'POST', body: { task: text } });
      mine.add(openId); $('#d-task').value = '';
    } catch (ex) { toast(ex.message); }
  });

  // ───────── impostazioni ─────────
  function renderMemory(items) {
    const ul = $('#memory'); ul.innerHTML = '';
    items.forEach((m, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.textContent = m.text;
      const btn = document.createElement('button'); btn.textContent = 'Dimentica';
      btn.addEventListener('click', () => api(`/api/memory/${i}`, { method: 'DELETE' }).then((r) => renderMemory(r.memory)).catch((e) => toast(e.message)));
      li.append(span, btn); ul.append(li);
    });
    $('#memory-empty').hidden = items.length > 0;
  }
  $('#open-settings').addEventListener('click', () => {
    $('#opt-speak').checked = prefs.speak; $('#opt-wake').checked = prefs.wake;
    $('#settings').showModal();
  });
  $('#s-close').addEventListener('click', () => $('#settings').close());
  $('#opt-speak').addEventListener('change', (e) => { prefs.speak = e.target.checked; savePrefs(); if (!prefs.speak) speechSynthesis.cancel(); });
  $('#opt-wake').addEventListener('change', (e) => {
    prefs.wake = e.target.checked; savePrefs();
    if (prefs.wake) beginRec('wake'); else if (mode === 'wake') beginRec('idle');
  });
  $('#share-copy').addEventListener('click', async () => {
    const input = $('#share-link');
    try { await navigator.clipboard.writeText(input.value); toast('Link copiato.'); } catch { input.select(); toast('Seleziona e copia il link.'); }
  });
  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    $('#settings').close(); beginRec('idle'); showLogin();
  });

  // ───────── sintesi vocale ─────────
  let lastProgress = 0;
  let voiceUnlocked = false;
  function unlockSpeech() {
    if (voiceUnlocked || !('speechSynthesis' in window)) return;
    voiceUnlocked = true;
    const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
  }
  document.addEventListener('pointerdown', unlockSpeech, { once: true });

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang.toLowerCase().startsWith('it') && /premium|enhanced|natural/i.test(v.name))
        || voices.find((v) => v.lang.toLowerCase().startsWith('it'));
  }
  function speak(text, interrupt = false) {
    if (!('speechSynthesis' in window) || !text) return;
    if (!prefs.speak && !interrupt) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT';
    const v = pickVoice(); if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  function cleanForSpeech(t) {
    return String(t).replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, '').replace(/https?:\/\/\S+/g, 'il link che trovi nella sessione').replace(/\s+/g, ' ').trim().slice(0, 450);
  }
  // Stesse regole di ProgressSpeech nell'app per Mac: si dice solo prosa breve, mai comandi o percorsi.
  function narration(text) {
    const t = text.trim();
    if (!t || t.length > 160 || t.includes('```') || t.includes('\n') || /^[-#|]/.test(t)) return null;
    return t.replace(/`/g, '').replace(/\*\*/g, '');
  }
  function activityPhrase(a) {
    const table = [['Modifica', 'sto modificando'], ['Scrive', 'sto scrivendo'], ['Legge', 'sto leggendo'],
      ['Cerca sul web', 'sto cercando sul web'], ['Cerca', 'sto cercando nel codice'], ['Apre', 'sto leggendo una pagina web'],
      ['Esegue', 'sto lanciando un comando'], ['Sotto-agente', 'ho passato un pezzo a un sotto-agente'], ['Aggiorna il piano', 'sto aggiornando il piano']];
    for (const [verb, spoken] of table) {
      if (!a.startsWith(verb)) continue;
      if (['Esegue', 'Cerca', 'Cerca sul web', 'Apre', 'Sotto-agente', 'Aggiorna il piano'].includes(verb)) return spoken;
      const file = a.slice(verb.length).trim().split('/').pop();
      return file && file.length <= 40 && !file.includes(' ') ? `${spoken} ${file}` : `${spoken} un file`;
    }
    return 'ci sto lavorando';
  }

  function onAgentEvent(id, e) {
    if (id === openId) refreshDetail();
    if (!mine.has(id)) return;
    const now = Date.now();
    if (e.kind === 'finish') {
      const s = sessions.get(id);
      const text = e.status === 'done' || e.status === 'needs_input' || e.status === 'error' ? cleanForSpeech(e.text) : '';
      if (e.status === 'stopped') speak('Fermata.', true);
      else if (text) speak(text, true);
      else speak(e.status === 'done' ? 'Ho finito.' : 'Qualcosa è andato storto.', true);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready.then((r) => r.showNotification('Jarvis', { body: (s && s.title) || 'Sessione terminata', icon: '/icons/icon-192.png' })).catch(() => {});
      }
      return;
    }
    if (now - lastProgress < 9000) return;
    let line = null;
    if (e.kind === 'text') line = narration(e.text);
    else if (e.kind === 'activity') line = activityPhrase(e.text);
    if (line) { lastProgress = now; speak(line); }
  }

  // ───────── dettatura ─────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let mode = 'idle';                 // 'idle' | 'ptt' | 'wake'
  let armedUntil = 0;
  let finalText = '';

  function setCaption(text) { $('#caption').textContent = text; }
  function renderOrb() {
    const orb = $('#orb');
    orb.setAttribute('aria-pressed', String(mode === 'ptt'));
    orb.dataset.wake = String(mode === 'wake');
    if (mode === 'ptt') setCaption('Ti ascolto…');
    else if (mode === 'wake') setCaption(Date.now() < armedUntil ? 'Dimmi' : 'Dì «Jarvis» o tocca per parlare');
    else setCaption('Tocca per parlare');
  }

  function stopRec() {
    if (!rec) return;
    rec.onend = null; rec.onerror = null; rec.onresult = null;
    try { rec.abort(); } catch { /* già fermo */ }
    rec = null;
  }

  function beginRec(next) {
    stopRec();
    mode = next; finalText = ''; $('#heard').textContent = '';
    renderOrb();
    if (mode === 'idle') return;
    if (!SR) { mode = 'idle'; renderOrb(); toast('Questo browser non sa trascrivere la voce: scrivi nel campo di testo (su iPhone usa Safari, su PC Chrome o Edge).'); return; }
    speechSynthesis?.cancel();
    rec = new SR();
    rec.lang = 'it-IT';
    rec.interimResults = true;
    rec.continuous = mode === 'wake';
    rec.onresult = (ev) => {
      let heard = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        heard += r[0].transcript;
        if (!r.isFinal) continue;
        const text = r[0].transcript.trim();
        if (mode === 'ptt') finalText = text;
        else if (mode === 'wake') {
          if (Date.now() < armedUntil) { armedUntil = 0; submitTask(text); renderOrb(); }
          else {
            const m = text.match(/\bjarvis\b[\s,.!?:;-]*(.*)$/i);
            if (m) {
              if (m[1].trim().length > 1) submitTask(m[1].trim());
              else { armedUntil = Date.now() + 8000; renderOrb(); }
            }
          }
        }
      }
      $('#heard').textContent = heard;
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        prefs.wake = false; savePrefs(); stopRec(); mode = 'idle'; renderOrb();
        toast('Microfono non consentito. Serve una connessione https e il permesso del browser.');
      }
    };
    rec.onend = () => {
      rec = null;
      if (mode === 'ptt') {
        const text = finalText;
        mode = prefs.wake ? 'wake' : 'idle';
        if (text) submitTask(text);
        if (mode === 'wake') beginRec('wake'); else renderOrb();
      } else if (mode === 'wake') {
        setTimeout(() => { if (mode === 'wake' && !rec && !document.hidden) beginRec('wake'); }, 300);
      }
    };
    try { rec.start(); } catch { /* già avviato */ }
  }

  $('#orb').addEventListener('click', () => {
    if (mode === 'ptt') { try { rec.stop(); } catch { beginRec(prefs.wake ? 'wake' : 'idle'); } }
    else beginRec('ptt');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && prefs.wake && mode === 'idle' && !$('#home').hidden) beginRec('wake');
  });

  // ───────── invio richieste ─────────
  const FOLLOW_UP = /^(aggiungi|anche|poi|inoltre|e poi|ora|adesso|cambia|modifica|correggi|sistema|rendilo|rendila|togli|metti)\b/i;
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  function extractProject(text) {
    const m = text.match(/^\s*(?:nel|sul|per il|per la)\s+progetto\s+(.+)$/i);
    if (!m) return { project: '', task: text };
    const rest = norm(m[1]);
    const byLen = [...projects].sort((a, b) => b.length - a.length);
    for (const name of byLen) {
      const n = norm(name);
      if (n && (rest === n || rest.startsWith(n + ' '))) {
        const words = n.split(' ').length;
        const task = m[1].trim().split(/\s+/).slice(words).join(' ').replace(/^[,:;.\s-]+/, '');
        return { project: name, task: task || text };
      }
    }
    return { project: '', task: text };
  }

  async function submitTask(raw) {
    const text = raw.trim(); if (!text) return;
    $('#heard').textContent = '';
    try {
      if (/^(fermati|stop|basta)\b/i.test(text)) {
        const running = [...sessions.values()].filter((s) => s.status === 'running');
        await Promise.all(running.map((s) => api(`/api/sessions/${s.id}/stop`, { method: 'POST' }).catch(() => {})));
        toast(running.length ? 'Fermo tutto.' : 'Non c\'è niente in corso.');
        speak(running.length ? 'Fermo tutto.' : 'Non sto lavorando a niente.', true);
        return;
      }
      if (/^pulisci\b/i.test(text)) { await api('/api/sessions', { method: 'DELETE' }); speak('Fatto.', true); return; }
      if (/^a che punto (sei|siamo)/i.test(text)) {
        const run = [...sessions.values()].filter((s) => s.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
        speak(run ? (run.activity ? `Sto lavorando a: ${run.title}. ${activityPhrase(run.activity)}.` : `Sto lavorando a: ${run.title}.`) : 'Non sto lavorando a niente.', true);
        return;
      }
      // Frase di continuazione: riprende la sessione conclusa da meno di 10 minuti.
      if (FOLLOW_UP.test(text)) {
        const recent = [...sessions.values()].filter((s) => s.agentSessionId && s.status !== 'running' && s.endedAt && Date.now() - s.endedAt < 600000)
          .sort((a, b) => b.endedAt - a.endedAt)[0];
        if (recent) {
          await api(`/api/sessions/${recent.id}/continue`, { method: 'POST', body: { task: text } });
          mine.add(recent.id); toast(`Continuo: ${recent.title.slice(0, 50)}`); speak('Va bene, continuo.', true);
          return;
        }
      }
      const { project, task } = extractProject(text);
      const chosen = project || $('#project').value;
      const r = await api('/api/sessions', { method: 'POST', body: { task, project: chosen } });
      if (r.memory) { speak('Va bene, me lo ricordo.', true); toast('Preferenza salvata.'); api('/api/me').then((m) => renderMemory(m.memory)); return; }
      mine.add(r.session.id);
      speak('Ci penso io.', true);
    } catch (e) { toast(e.message); speak(e.message, true); }
  }

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#task').value; $('#task').value = '';
    submitTask(v);
  });

  // ───────── avvio ─────────
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('pointerdown', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
  api('/api/me').then(showHome).catch(showLogin);
  if (prefs.wake) document.addEventListener('pointerdown', () => { if (mode === 'idle' && prefs.wake) beginRec('wake'); }, { once: true });
})();
