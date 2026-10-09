'use strict';
// Porting in JavaScript di ClaudeStreamParser (Sources/Jarvis/Services/StreamParsers.swift).
// Eventi normalizzati: {kind:'sessionID'|'activity'|'text'|'needsInput'|'result', ...}

const VERBS = {
  Read: 'Legge', Write: 'Scrive', Edit: 'Modifica', MultiEdit: 'Modifica', NotebookEdit: 'Modifica',
  Grep: 'Cerca', Glob: 'Cerca', WebSearch: 'Cerca sul web', WebFetch: 'Apre',
  Task: 'Sotto-agente', Agent: 'Sotto-agente', TodoWrite: 'Aggiorna il piano', Bash: 'Esegue',
};

function shortPath(p) {
  return String(p).split('/').filter(Boolean).slice(-3).join('/');
}

function describeTool(name, input) {
  const verb = VERBS[name] || name;
  input = input || {};
  if (input.file_path) return `${verb} ${shortPath(input.file_path)}`;
  if (input.command) return `Esegue ${String(input.command).slice(0, 60)}`;
  if (input.pattern) return `${verb} ${String(input.pattern).slice(0, 40)}`;
  if (input.query) return `${verb} ${String(input.query).slice(0, 40)}`;
  if (input.description) return `${verb} ${String(input.description).slice(0, 50)}`;
  return verb;
}

function parseClaudeLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const events = [];
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init' && obj.session_id) events.push({ kind: 'sessionID', id: obj.session_id });
      if (obj.subtype === 'task_summary' && obj.detail) events.push({ kind: 'activity', text: String(obj.detail) });
      break;
    case 'assistant': {
      const content = obj.message && obj.message.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type === 'tool_use') events.push({ kind: 'activity', text: describeTool(block.name || 'Tool', block.input) });
        else if (block.type === 'text' && block.text) events.push({ kind: 'text', text: String(block.text) });
      }
      break;
    }
    case 'result': {
      const isError = !!obj.is_error;
      const text = typeof obj.result === 'string' ? obj.result : (obj.subtype || '');
      if (obj.session_id) events.push({ kind: 'sessionID', id: obj.session_id });
      if (Array.isArray(obj.permission_denials) && obj.permission_denials.length) events.push({ kind: 'needsInput' });
      events.push({ kind: 'result', text, isError });
      break;
    }
    default: break;
  }
  return events;
}

module.exports = { parseClaudeLine, describeTool };
