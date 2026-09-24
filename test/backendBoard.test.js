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
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const translate = body.stream === false;
    if (translate) translations++; else chats++;
    const text = translate ? (JSON.parse(body.messages[1].content).text === '网页输入' ? 'Web input.' : 'Agent reply.') : '模型回复';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-board-'));
  const app = createBackendServer({ ...loadConfig({ BACKEND_WEB_TOKEN: 'web', BACKEND_DEVICE_TOKEN: 'device', BACKEND_BOARD_HTTP_URL: `http://127.0.0.1:${port}` }), host: '127.0.0.1', port: 0, dataDir: directory, model: 'test', modelApiKey: 'test-key', modelBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  t.after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await app.start();
  await eventually(() => app.backend.device.connection === 'connected');
  assert.equal(app.backend.device.capabilities.print_completed, false);
  assert.equal(app.backend.device.capabilities.print_delivered, true);
  const session = app.backend.createSession();
  app.backend.submit(session, { client_message_id: 'web-1', text: '网页输入' });
  await eventually(() => app.backend.store.data.jobs.length === 2 && app.backend.store.data.jobs.every(job => job.status === 'delivered'));
  const state = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal(state.test_output, 'TURN 0001\n\rYOU:\n\rWeb input.\n\r\n\rTHEM:\n\rAgent reply.\n\r\n\r');
  const rid = '615fe93a-bf05-a74e-515c-4c2a828c723e';
  child.stdin.write(JSON.stringify({ request_id: rid, text: 'Keyboard input.' }) + '\n');
  await eventually(() => app.backend.store.data.jobs.length === 3 && app.backend.store.data.jobs[2].status === 'delivered');
  const printed = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
  assert.equal((printed.test_output.match(/Keyboard input\./g) || []).length, 1);
  assert.ok(printed.test_output.endsWith('Keyboard input.TURN 0002\n\rTHEM:\n\rAgent reply.\n\r\n\r'));
  child.stdin.write(JSON.stringify({ type: 'replay', request_id: rid, text: 'Keyboard input.' }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(chats, 2); assert.equal(translations, 3);
  assert.equal(app.backend.printing.summary().confirmation, 'software_drain');
  assert.equal(app.backend.printing.summary().pending_turns, 0);
  assert.equal(app.backend.store.data.board_inputs.length, 1);
  child.stdin.write(JSON.stringify({ type: 'fault' }) + '\n');
  await eventually(() => app.backend.board.remote?.state === 'fault');
  assert.equal(app.backend.deviceSnapshot().board.error, 'BOARD_DEVICE_FAULT');
  assert.equal(app.backend.deviceSnapshot().board.serial_connected, true);
  const recoveryUrl = `http://127.0.0.1:${app.server.address().port}/api/v1/devices/typewriter/recover`;
  const recover = authorization => fetch(recoveryUrl, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await recover('Bearer device')).status, 403);
  assert.equal((await recover('Bearer web')).status, 202);
  await eventually(() => app.backend.device.connection === 'connected' && app.backend.board.remote?.state === 'editing');
  assert.equal((await recover('Bearer web')).status, 409);
  assert.equal(errors.split('\n').filter(line => line.trim() && !line.includes('[board.device.recover]')).join('\n'), '');
});
