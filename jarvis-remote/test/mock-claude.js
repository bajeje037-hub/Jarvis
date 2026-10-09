#!/usr/bin/env node
const args = process.argv.slice(2);
const task = args[args.indexOf('-p') + 1];
const resumed = args.includes('--resume');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = resumed ? args[args.indexOf('--resume') + 1] : 'sess-' + Date.now();
if (task.includes('FAIL')) { process.stderr.write('boom\n'); process.exit(3); }
out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd() });
setTimeout(() => out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ora creo la pagina' }] } }), 100);
setTimeout(() => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x/site/index.html' } }] } }), 200);
if (task.includes('SLOW')) { process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000); }
else setTimeout(() => { out({ type: 'result', subtype: 'success', is_error: false, result: 'Fatto: ' + task + (resumed ? ' (ripresa)' : ''), session_id: sid }); }, 400);
