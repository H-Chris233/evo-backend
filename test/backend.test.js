'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createBackendServer } = require('../src/backend/server');
const { loadConfig } = require('../src/backend');
const { sseData } = require('../src/backend/model');

const capabilities = { charset: 'ascii', max_chars: 4000, supports_newline: true, input_events: true, print_started: true, print_completed: true };

async function eventually(check) {
  for (let i = 0; i < 300; i++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Condition did not become true');
}

function completion(res, text = 'Hello from the agent.') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\r\n\r\n`);
  res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}

async function fixture(t, handler = (body, res) => completion(res), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-test-'));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    handler(body, res, requests.length);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = {
    ...loadConfig({ BACKEND_WEB_TOKEN: 'web-secret', BACKEND_DEVICE_TOKEN: 'device-secret' }),
    host: '127.0.0.1', port: 0, dataDir: directory,
    modelBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'test-model', modelApiKey: 'model-secret',
    origins: ['http://localhost:5173'], ...overrides,
  };
  let app = createBackendServer(config);
  await app.start();
  let base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  t.after(async () => {
    await app.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const f = {
    config, directory, requests,
    get app() { return app; }, get base() { return base; },
    async restart() {
      await app.close(); app = createBackendServer(config); await app.start();
      base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
    },
    async api(route, body, role = 'web', extra = {}) {
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${role === 'web' ? 'web-secret' : role === 'device' ? 'device-secret' : role}`, 'Content-Type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = response.status === 204 ? null : await response.json();
      return { status: response.status, data };
    },
    async session() { return (await f.api('/sessions', {})).data.id; },
    async connect(caps = capabilities) { return (await f.api('/devices/typewriter/connect', { capabilities: caps }, 'device')).data; },
    async submit(session, text, messageId = randomUUID()) {
      return f.api(`/sessions/${session}/messages`, { text, client_message_id: messageId });
    },
    async input(connection, text, messageId = randomUUID()) {
      return f.api('/devices/typewriter/input', { connection_id: connection, type: 'submit', text, client_message_id: messageId }, 'device');
    },
    async done(session) {
      return eventually(() => {
        const s = app.backend.session(session);
        return !app.backend.active && s.requests.length && s.requests.at(-1).status !== 'running' ? s : null;
      });
    },
    async command(connection, wait = 0) { return f.api(`/devices/typewriter/commands?wait_ms=${wait}`, undefined, 'device', { 'X-Connection-ID': connection }); },
    async receipt(connection, job, status) {
      return f.api(`/devices/typewriter/print-jobs/${job}/events`, { connection_id: connection, status }, 'device');
    },
  };
  return f;
}

test('web and typewriter have isolated history, and only device input prints once', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/status')).data.model.available, null);
  const web = await f.session();
  const device = await f.connect();
  assert.notEqual(web, device.session_id);
  await f.submit(web, 'web-only-secret'); await f.done(web);
  assert.equal((await f.api('/status')).data.model.available, true);
  assert.equal(f.app.backend.store.data.jobs.length, 0);
  const messageId = randomUUID();
  const accepted = await f.input(device.connection_id, 'device-only-secret', messageId);
  assert.equal(accepted.status, 202);
  const state = await f.done(device.session_id);
  assert.equal(state.requests[0].status, 'completed');
  assert.equal(JSON.stringify(f.requests[1]).includes('web-only-secret'), false);
  const command = await f.command(device.connection_id);
  assert.equal(command.status, 200);
  assert.equal(command.data.text, 'Hello from the agent.');
  assert.equal(f.app.backend.deviceSnapshot().business_state, 'idle');
  assert.equal((await f.command(device.connection_id)).status, 204);
  await f.receipt(device.connection_id, command.data.job_id, 'started');
  assert.equal(f.app.backend.deviceSnapshot().business_state, 'machine_typing');
  assert.equal((await f.input(device.connection_id, 'another')).data.error.code, 'DEVICE_BUSY');
  await f.submit(web, 'web-second'); await f.done(web);
  assert.equal(JSON.stringify(f.requests[2]).includes('device-only-secret'), false);
  await f.receipt(device.connection_id, command.data.job_id, 'completed');
  await f.receipt(device.connection_id, command.data.job_id, 'started');
  assert.equal(f.app.backend.store.data.jobs[0].status, 'completed');
  const duplicate = await f.input(device.connection_id, 'device-only-secret', messageId);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(f.requests.length, 3);
  assert.equal(f.app.backend.store.data.jobs.length, 1);
  assert.equal((await f.input(device.connection_id, 'changed', messageId)).status, 409);
});

test('real tool execution emits ordered activities and returns status without device conversation text', async t => {
  const f = await fixture(t, (body, res) => {
    if (body.messages.some(m => m.role === 'tool')) return completion(res, 'The device is connected.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_typewriter_', arguments: '{' } }] },
      { tool_calls: [{ index: 0, function: { name: 'status', arguments: '}' } }] },
    ];
    for (const delta of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });
  await f.connect();
  f.app.backend.store.data.jobs.push({ id: 'old', status: 'completed', text: 'private-device-answer' });
  const session = await f.session();
  await f.submit(session, 'Is the typewriter connected?');
  const state = await f.done(session);
  assert.equal(state.requests[0].status, 'completed');
  const activities = state.requests[0].activities;
  assert.equal(activities.filter(a => a.state === 'tool_calling').length, 1);
  assert.ok(activities.every(a => a.activity_status === 'completed'));
  assert.equal(JSON.stringify(f.requests[1]).includes('private-device-answer'), false);
  assert.equal(JSON.parse(f.requests[1].messages.find(m => m.role === 'tool').content).connection, 'connected');
  const events = f.app.backend.events.channel(`session:${session}`).history.map(x => x.event);
  assert.ok(events.every((e, i) => !i || events[i - 1].sequence < e.sequence));
  assert.ok(!events.some(e => e.data.state === 'searching'));
});

test('SSE parser handles UTF-8, CRLF, CR, comments, and multiline data across byte chunks', async () => {
  const bytes = Buffer.from(': comment\r\ndata: 你\r\ndata: 好\r\n\r\ndata: done\r\r');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const data = [];
  for await (const value of sseData(stream)) data.push(value);
  assert.deepEqual(data, ['你\n好', 'done']);
});

test('partial, truncated, invalid and timed out model replies never print', async t => {
  for (const mode of ['partial', 'length', 'invalid', 'timeout', 'http', 'empty']) {
    await t.test(mode, async t => {
      const f = await fixture(t, (body, res) => {
        if (mode === 'timeout') return;
        if (mode === 'http') { res.writeHead(401); return res.end('model-secret'); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mode === 'invalid') return res.end('data: not json\n\n');
        if (mode !== 'empty') res.write('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n');
        if (mode === 'partial') return res.end();
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === 'length' ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }, { modelTimeoutMs: 100 });
      const device = await f.connect();
      await f.input(device.connection_id, 'hello');
      const session = await f.done(device.session_id);
      assert.equal(session.requests[0].status, 'failed');
      assert.ok(session.requests[0].activities.every(a => a.activity_status !== 'running'));
      assert.equal(f.app.backend.store.data.jobs.length, 0);
      const heartbeat = await f.api('/devices/typewriter/heartbeat', { connection_id: device.connection_id }, 'device');
      assert.equal(heartbeat.data.latest_request.status, 'failed');
      assert.equal(heartbeat.data.latest_request.error.code, session.requests[0].error.code);
      assert.equal(JSON.stringify(session).includes('model-secret'), false);
      if (['partial', 'length'].includes(mode)) assert.equal(session.messages.at(-1).status, 'incomplete');
    });
  }
});

test('non-streaming response skips typing state; unsupported or oversized print text is not altered', async t => {
  for (const text of ['Valid reply.', '中文', 'too long', 'line\nbreak']) {
    await t.test(text, async t => {
      const f = await fixture(t, (body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
      });
      const device = await f.connect({ ...capabilities, max_chars: text === 'too long' ? 3 : 100, supports_newline: false });
      await f.input(device.connection_id, 'hello');
      const session = await f.done(device.session_id);
      assert.equal(session.requests[0].status, 'completed');
      assert.equal(session.messages.at(-1).text, text);
      assert.ok(!session.requests[0].activities.some(a => a.state === 'typing'));
      assert.equal(f.app.backend.store.data.jobs[0].status, text === 'Valid reply.' ? 'pending' : 'failed');
    });
  }
});

test('global busy slot rejects concurrent input and preserves request idempotency', async t => {
  let finish;
  const f = await fixture(t, (body, res) => { finish = () => completion(res); });
  const a = await f.session(); const b = await f.session(); const clientId = randomUUID();
  const accepted = await f.submit(a, 'first', clientId);
  assert.equal((await f.submit(b, 'second')).data.error.code, 'AGENT_BUSY');
  assert.equal((await f.submit(a, 'first', clientId)).data.request_id, accepted.data.request_id);
  assert.equal((await f.submit(a, 'different', clientId)).data.error.code, 'ID_CONFLICT');
  await eventually(() => finish); finish(); await f.done(a);
  assert.equal(f.requests.length, 1);
});

test('device disconnect prevents redelivery, rejects stale connections, and accepts real late receipts', async t => {
  const f = await fixture(t);
  const device = await f.connect();
  await f.input(device.connection_id, 'hello'); await f.done(device.session_id);
  const command = (await f.command(device.connection_id)).data;
  await f.receipt(device.connection_id, command.job_id, 'started');
  f.app.backend.device.lastSeen = Date.now() - 20000;
  f.app.backend.expireDevice();
  assert.equal(f.app.backend.deviceSnapshot().connection, 'disconnected');
  assert.equal(f.app.backend.deviceSnapshot().business_state, 'idle');
  assert.equal(f.app.backend.store.data.jobs[0].status, 'unknown');
  const reconnect = await f.connect();
  assert.equal(reconnect.session_id, device.session_id);
  assert.equal((await f.command(device.connection_id)).data.error.code, 'STALE_CONNECTION');
  assert.equal((await f.command(reconnect.connection_id)).status, 204);
  await f.receipt(reconnect.connection_id, command.job_id, 'completed');
  assert.equal(f.app.backend.store.data.jobs[0].status, 'completed');
});

test('long polling wakes on a new job; input activity and missing completion capability stay honest', async t => {
  const f = await fixture(t);
  const device = await f.connect({ ...capabilities, print_completed: false });
  await f.api('/devices/typewriter/input', { connection_id: device.connection_id, type: 'typing_started' }, 'device');
  assert.equal(f.app.backend.deviceSnapshot().business_state, 'human_typing');
  const poll = f.command(device.connection_id, 1000);
  await eventually(() => f.app.backend.waiter);
  assert.equal((await f.command(device.connection_id)).data.error.code, 'POLL_ALREADY_ACTIVE');
  await f.input(device.connection_id, 'hello');
  const command = (await poll).data;
  assert.ok(command.job_id);
  await f.receipt(device.connection_id, command.job_id, 'started');
  assert.equal((await f.receipt(device.connection_id, command.job_id, 'completed')).data.error.code, 'RECEIPT_UNAVAILABLE');
  assert.equal(f.app.backend.store.data.jobs[0].status, 'printing');
});

test('restart preserves history and IDs but clears unfinished physical tasks', async t => {
  const f = await fixture(t);
  const device = await f.connect(); const clientId = randomUUID();
  await f.input(device.connection_id, 'remember this', clientId); await f.done(device.session_id);
  const job = (await f.command(device.connection_id)).data;
  await f.restart();
  assert.equal(f.app.backend.store.data.jobs[0].status, 'abandoned');
  assert.equal(f.app.backend.session(device.session_id).messages[0].text, 'remember this');
  const reconnect = await f.connect();
  assert.equal((await f.command(reconnect.connection_id)).status, 204);
  assert.equal((await f.input(reconnect.connection_id, 'remember this', clientId)).data.duplicate, true);
  await f.receipt(reconnect.connection_id, job.job_id, 'completed');
  assert.equal(f.app.backend.store.data.jobs[0].status, 'abandoned');
  await f.input(reconnect.connection_id, 'new request'); await f.done(device.session_id);
  assert.equal(f.app.backend.store.data.jobs.length, 2);
});

test('crash recovery marks persisted active requests interrupted and does not fabricate completion', async t => {
  const f = await fixture(t);
  const sessionId = await f.session();
  const state = f.app.backend.store.data;
  state.sessions[0].requests.push({ id: 'crashed', status: 'running', activities: [{ activity_status: 'running' }] });
  state.sessions[0].messages.push({ id: 'partial', status: 'streaming', text: 'Partial' });
  f.app.backend.store.save();
  await f.restart();
  const session = f.app.backend.session(sessionId);
  assert.equal(session.requests[0].status, 'interrupted');
  assert.equal(session.requests[0].activities[0].activity_status, 'failed');
  assert.equal(session.messages[0].status, 'incomplete');
});

test('auth, origins, input limits and source spoofing are enforced before model access', async t => {
  const f = await fixture(t);
  const session = await f.session(); const device = await f.connect();
  assert.equal((await f.api('/status', undefined, 'wrong')).status, 401);
  assert.equal((await f.api('/status', undefined, 'device')).status, 403);
  assert.equal((await f.api('/devices/typewriter/input', {}, 'web')).status, 403);
  assert.equal((await f.api(`/sessions/${device.session_id}`)).status, 404);
  assert.equal((await f.api('/devices/another/connect', {}, 'device')).status, 404);
  assert.equal((await f.api('/status', undefined, 'web', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.api('/status', undefined, 'web', { Origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await f.submit(session, ' '.repeat(10))).status, 400);
  assert.equal((await f.submit(session, 'a'.repeat(8001))).status, 413);
  assert.equal((await f.submit(session, 'a'.repeat(70000))).status, 413);
  assert.equal((await f.api(`/sessions/${session}/messages`, { text: 'hello', client_message_id: 'm', source: 'typewriter' })).status, 400);
  const malformed = await fetch(f.base + `/sessions/${session}/messages`, { method: 'POST', headers: { Authorization: 'Bearer web-secret', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400); await malformed.text();
  assert.equal(f.requests.length, 0);
});

test('missing model and missing device capabilities are explicit, not simulated', async t => {
  const f = await fixture(t, undefined, { modelApiKey: '' });
  const session = await f.session();
  assert.equal((await f.submit(session, 'hello')).data.error.code, 'MODEL_NOT_CONFIGURED');
  const device = await f.connect({});
  assert.equal(device.device.print_available, false);
  assert.equal(device.device.input_status_available, false);
  assert.equal(f.requests.length, 0);
});

test('oversized chunked JSON receives 413 rather than a reset connection', async t => {
  const f = await fixture(t);
  const session = await f.session();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/sessions/${session}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer web-secret', 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject);
    req.write('{"text":"'); req.write('a'.repeat(70000)); req.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(f.requests.length, 0);
});

test('disconnecting a browser event stream does not cancel an accepted reply', async t => {
  let finish;
  const f = await fixture(t, (body, res) => { finish = () => completion(res); });
  const session = await f.session();
  const controller = new AbortController();
  const stream = await fetch(`${f.base}/sessions/${session}/events`, { signal: controller.signal, headers: { Authorization: 'Bearer web-secret' } });
  await f.submit(session, 'hello');
  await eventually(() => finish);
  controller.abort(); await stream.body.cancel().catch(() => {});
  finish();
  const state = await f.done(session);
  assert.equal(state.requests[0].status, 'completed');
  assert.equal(f.requests.length, 1);
});

test('shutdown aborts a stalled upstream and closes event streams and pending device polls', async t => {
  const f = await fixture(t, () => {});
  const session = await f.session();
  const device = await f.connect();
  const controller = new AbortController();
  const stream = await fetch(`${f.base}/sessions/${session}/events`, { signal: controller.signal, headers: { Authorization: 'Bearer web-secret' } });
  const poll = f.command(device.connection_id, 25000);
  await eventually(() => f.app.backend.waiter);
  await f.submit(session, 'hello');
  await eventually(() => f.requests.length === 1);
  await f.app.close();
  assert.equal((await poll).status, 204);
  controller.abort(); await stream.body.cancel().catch(() => {});
  assert.equal(f.app.backend.session(session).requests[0].status, 'interrupted');
});

test('SSE snapshot, replay and expired cursor work without restarting the model', async t => {
  const f = await fixture(t);
  const session = await f.session();
  async function readEvent(lastId) {
    const controller = new AbortController();
    const response = await fetch(f.base + `/sessions/${session}/events`, {
      signal: controller.signal, headers: { Authorization: 'Bearer web-secret', ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
    });
    const reader = response.body.getReader();
    let text = '';
    try {
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
      return JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  }
  assert.equal((await readEvent()).type, 'snapshot');
  await f.submit(session, 'hello'); await f.done(session);
  const events = f.app.backend.events.channel(`session:${session}`).history;
  assert.equal((await readEvent(events[0].event.event_id)).event_id, events[1].event.event_id);
  const snapshot = await readEvent('expired-cursor');
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.data.messages.at(-1).text, 'Hello from the agent.');
  assert.equal(f.requests.length, 1);
});

test('unknown tools and invalid arguments produce controlled results, with bounded tool loops', async t => {
  const f = await fixture(t, (body, res, count) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
      id: `call_${count}`, type: 'function', function: { name: count % 2 ? 'shell_exec' : 'get_typewriter_status', arguments: count % 2 ? '{}' : '{"extra":1}' },
    }] }, finish_reason: 'tool_calls' }] }));
  });
  const session = await f.session();
  await f.submit(session, 'hello');
  const state = await f.done(session);
  assert.equal(state.requests[0].error.code, 'TOOL_LIMIT');
  assert.equal(f.requests.length, 5);
  assert.equal(state.requests[0].activities.filter(a => a.state === 'tool_calling' && a.activity_status === 'failed').length, 4);
  assert.ok(f.requests[1].messages.find(m => m.role === 'tool').content.includes('Unsupported tool'));
});

test('configuration and corrupted storage fail closed', () => {
  assert.throws(() => loadConfig({ BACKEND_PORT: 'abc' }), /BACKEND_PORT/);
  assert.throws(() => loadConfig({ BACKEND_MODEL_BASE_URL: 'file:///tmp/model' }), /BACKEND_MODEL_BASE_URL/);
  assert.throws(() => loadConfig({ BACKEND_ALLOWED_ORIGINS: '*' }), /BACKEND_ALLOWED_ORIGINS/);
  assert.throws(() => createBackendServer({ webToken: 'same', deviceToken: 'same' }), /Distinct/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-corrupt-'));
  try {
    fs.writeFileSync(path.join(directory, 'state.json'), '{broken');
    assert.throws(() => createBackendServer({ ...loadConfig({ BACKEND_WEB_TOKEN: 'w', BACKEND_DEVICE_TOKEN: 'd' }), dataDir: directory }));
    assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), '{broken');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('device simulator completes three conversations over the real HTTP interface', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/backend-device.js')], {
    env: { ...process.env, BACKEND_URL: f.base.replace(/\/api\/v1$/, ''), BACKEND_DEVICE_TOKEN: 'device-secret', BACKEND_DEVICE_ID: 'typewriter' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '', sent = 0;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Simulator timed out: ${errors}\n${output}`)); }, 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  await eventually(() => output.includes('[simulator] Connected.'));
  for (sent = 0; sent < 3; sent++) {
    child.stdin.write(`Message ${sent + 1}\n`);
    await eventually(() => f.app.backend.store.data.jobs.filter(job => job.status === 'completed').length === sent + 1);
  }
  child.stdin.write('/quit\n');
  assert.equal(await exited, 0, errors);
  assert.equal(f.requests.length, 3);
  assert.equal((output.match(/\[simulated print /g) || []).length, 3);
  assert.ok(f.requests[2].messages.some(message => message.content === 'Message 1'));
});
