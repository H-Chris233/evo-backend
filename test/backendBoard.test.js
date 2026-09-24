'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { createBackendServer } = require('../src/backend/server');
const { loadConfig } = require('../src/backend');
const { formatBoardText } = require('../src/backend/board');

test('board layout wraps at the configured margin, preserves content and uses LF-CR', () => {
  const source = 'TURN 0001\nYOU:\n' + 'a familiar memory '.repeat(12) + '\n' + 'x'.repeat(93);
  const formatted = formatBoardText(source, 40);
  assert.ok(formatted.split('\n\r').every(line => line.length <= 40));
  assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''));
  assert.throws(() => formatBoardText('中文'), /Unprintable/);
});

async function eventually(check) {
  for (let n = 0; n < 200; n++) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Board integration did not settle');
}

test('actual Python host protocol prints web rounds, receives keyboard input once and reports software delivery honestly', async t => {
  const board = path.resolve(__dirname, '../../board');
  const python = process.env.BOARD_TEST_PYTHON || path.join(board, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) return t.skip('Create board/.venv and install pyserial + websockets to run the real host protocol test');
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(python, ['-m', 'host.test_backend_fixture', String(port)], { cwd: board, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  t.after(() => { child.stdin.end(); if (child.exitCode === null) child.kill(); });
  await eventually(() => output.includes('READY'));
  let chats = 0, translations = 0;
  const chatMessages = [];
  let finishSlow;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const translate = body.stream === false;
    if (translate) translations++; else { chats++; chatMessages.push(body.messages); }
    if (!translate && body.messages.at(-1).content === 'Slow reply') {
      finishSlow = () => res.end(JSON.stringify({ choices: [{ message: { content: 'Too late.' }, finish_reason: 'stop' }] }));
      return;
    }
    const text = translate ? (JSON.parse(body.messages[1].content).text === '网页输入' ? 'Web input.' : 'Agent reply.') : '模型回复';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-board-'));
  const config = { ...loadConfig({ BACKEND_WEB_TOKEN: 'web', BACKEND_DEVICE_TOKEN: 'device', BACKEND_BOARD_HTTP_URL: `http://127.0.0.1:${port}` }), host: '127.0.0.1', port: 0, dataDir: directory, model: 'test', modelApiKey: 'test-key', modelBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
  let app = createBackendServer(config);
  t.after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await app.start();
  await eventually(() => app.backend.device.connection === 'connected');
  assert.equal(app.backend.device.capabilities.print_completed, false);
  assert.equal(app.backend.device.capabilities.print_delivered, true);
  const session = app.backend.createSession();
  app.backend.submit(session, { client_message_id: 'web-1', text: '网页输入' });
  await eventually(() => app.backend.store.data.jobs.length === 2 && app.backend.store.data.jobs.every(job => job.status === 'delivered'));
  const state = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal(state.test_output, 'TURN 0001\n\rYOU:\n\rWeb input.\n\r\n\rTHEY:\n\rAgent reply.\n\r\n\r');
  const rid = '615fe93a-bf05-a74e-515c-4c2a828c723e';
  child.stdin.write(JSON.stringify({ request_id: rid, text: 'Keyboard input.' }) + '\n');
  await eventually(() => app.backend.store.data.jobs.length === 3 && app.backend.store.data.jobs[2].status === 'delivered');
  const printed = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal((printed.test_output.match(/Keyboard input\./g) || []).length, 1);
  assert.ok(printed.test_output.endsWith('Keyboard input.TURN 0002\n\rTHEY:\n\rAgent reply.\n\r\n\r'));
  child.stdin.write(JSON.stringify({ type: 'replay', request_id: rid, text: 'Keyboard input.' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(chats, 2); assert.equal(translations, 3);
  assert.equal(app.backend.printing.summary().confirmation, 'software_drain');
  assert.equal(app.backend.printing.summary().pending_turns, 0);
  assert.equal(app.backend.store.data.board_inputs.length, 1);
  // Reproduce a prior print left uncertain by a backend restart or delivery timeout.
  const blockedJob = app.backend.store.data.jobs.at(-1);
  blockedJob.status = 'unknown';
  app.backend.store.data.print_segments.find(segment => segment.id === blockedJob.segment_id).status = 'ready';
  app.backend.store.save();
  assert.equal(app.backend.printing.summary().state, 'needs_confirmation');
  const oldSession = app.backend.device.sessionId;
  const resetId = '615fe93a-bf05-a74e-515c-4c2a828c723f';
  child.stdin.write(JSON.stringify({ request_id: resetId, text: '/new' }) + '\n');
  await eventually(async () => {
    const state = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
    return state.state === 'editing' && state.last_delivery?.request_id === resetId;
  });
  const newSession = app.backend.device.sessionId;
  assert.notEqual(newSession, oldSession);
  assert.deepEqual(app.backend.session(newSession).messages, []);
  assert.equal(app.backend.session(oldSession).messages[0].text, 'Keyboard input.');
  assert.equal(app.backend.deviceSnapshot().latest_request, null);
  assert.equal(blockedJob.status, 'abandoned');
  assert.equal(app.backend.printing.summary().pending_turns, 0);
  assert.equal(chats, 2); assert.equal(translations, 3);
  assert.equal(app.backend.store.data.next_turn, 1);
  assert.equal(app.backend.session(session.id).messages[0].text, '网页输入');
  child.stdin.write(JSON.stringify({ type: 'replay', request_id: resetId, text: '/new' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(app.backend.store.data.sessions.length, 3);
  const resetPrint = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal((resetPrint.test_output.match(/NEW CONVERSATION\./g) || []).length, 1);
  const socketClosed = new Promise(resolve => app.backend.board.ws.addEventListener('close', resolve, { once: true }));
  await app.close(); await socketClosed;
  app = createBackendServer(config); await app.start();
  await eventually(() => app.backend.device.connection === 'connected');
  assert.equal(app.backend.device.sessionId, newSession);
  child.stdin.write(JSON.stringify({ request_id: '615fe93a-bf05-a74e-515c-4c2a828c7240', text: 'Hello' }) + '\n');
  await eventually(() => app.backend.store.data.jobs.length === 4 && app.backend.store.data.jobs[3].status === 'delivered');
  assert.deepEqual(chatMessages.at(-1).filter(message => message.role !== 'system'), [{ role: 'user', content: 'Hello' }]);
  assert.ok(app.backend.store.data.jobs[3].text.startsWith('TURN 0001\n'));
  assert.equal(app.backend.store.data.jobs[3].turn_number, 1);
  child.stdin.write(JSON.stringify({ request_id: '615fe93a-bf05-a74e-515c-4c2a828c7241', text: 'Slow reply' }) + '\n');
  await eventually(() => finishSlow && app.backend.active);
  child.stdin.write(JSON.stringify({ type: 'escape' }) + '\n');
  await eventually(() => !app.backend.active && app.backend.store.data.board_stop_id);
  finishSlow();
  assert.equal(app.backend.printing.summary().pending_turns, 0);
  assert.equal(app.backend.session(newSession).requests.at(-1).error.code, 'CANCELLED');
  const stopped = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal(stopped.state, 'editing'); assert.equal(stopped.active_request, null);
  assert.equal(app.backend.device.sessionId, newSession);
  child.stdin.write(JSON.stringify({ request_id: '615fe93a-bf05-a74e-515c-4c2a828c7242', text: 'Continue' }) + '\n');
  await eventually(() => app.backend.store.data.jobs.length === 5 && app.backend.store.data.jobs[4].status === 'delivered');
  assert.equal(app.backend.printing.summary().pending_turns, 0);
  child.stdin.write(JSON.stringify({ type: 'fault' }) + '\n');
  await eventually(() => app.backend.board.remote?.state === 'fault');
  assert.equal(app.backend.deviceSnapshot().board.error, 'BOARD_DEVICE_FAULT');
  assert.equal(errors.split('\n').filter(line => line.trim() && !/\[board\.(device.recover|escape|request.cancel)\]/.test(line)).join('\n'), '');
});
