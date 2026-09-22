'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackendServer } = require('../src/backend/server');
const { loadConfig } = require('../src/backend');
const { MAX_AUDIO_BYTES } = require('../src/backend/asr');

const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
function result(res, text = '这是转写文字。') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
}
async function fixture(t, handler = (req, body, res) => result(res), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-asr-test-'));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ headers: req.headers, path: req.url, body });
    handler(req, body, res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = {
    ...loadConfig({ BACKEND_WEB_TOKEN: 'web-token', BACKEND_DEVICE_TOKEN: 'device-token' }),
    host: '127.0.0.1', port: 0, dataDir: directory, asrApiKey: 'private-asr-key',
    asrBaseUrl: `http://127.0.0.1:${upstream.address().port}/compatible-mode/v1`, ...overrides,
  };
  const app = createBackendServer(config);
  await app.start();
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  t.after(async () => {
    await app.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    app, calls, base,
    async upload(body = audio, mime = 'audio/webm;codecs=opus', token = 'web-token', signal) {
      const response = await fetch(base + '/audio/transcriptions', {
        method: 'POST', headers: { 'Content-Type': mime, Authorization: `Bearer ${token}` }, body, signal,
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('ASR uses Alibaba short-audio request schema and never creates chat or print records', async t => {
  const f = await fixture(t, undefined, { asrLanguage: 'zh' });
  assert.deepEqual(await f.upload(), { status: 200, body: { text: '这是转写文字。' } });
  assert.equal(f.calls[0].path, '/compatible-mode/v1/chat/completions');
  assert.equal(f.calls[0].headers.authorization, 'Bearer private-asr-key');
  assert.deepEqual(f.calls[0].body, {
    model: 'qwen3-asr-flash', stream: false, asr_options: { enable_itn: false, language: 'zh' },
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/webm;base64,${audio.toString('base64')}` } }] }],
  });
  assert.deepEqual(f.app.backend.store.data.sessions, []);
  assert.deepEqual(f.app.backend.store.data.jobs, []);
  assert.equal(f.app.backend.active, null);
});

test('ASR validates authentication, container format and upload size before calling Alibaba', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(audio, 'audio/webm', 'wrong')).status, 401);
  assert.equal((await f.upload(audio, 'audio/webm', 'device-token')).status, 403);
  assert.equal((await f.upload(audio, 'application/json')).status, 415);
  assert.equal((await f.upload(Buffer.alloc(0))).body.error.code, 'ASR_EMPTY_AUDIO');
  assert.equal((await f.upload(Buffer.alloc(30))).body.error.code, 'ASR_INVALID_AUDIO');
  assert.equal((await f.upload(Buffer.alloc(MAX_AUDIO_BYTES + 1))).status, 413);
  assert.equal(f.calls.length, 0);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/audio/transcriptions', {
      method: 'POST', headers: { 'Content-Type': 'audio/webm', Authorization: 'Bearer web-token', 'Transfer-Encoding': 'chunked' },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(Buffer.alloc(MAX_AUDIO_BYTES + 1));
  });
  assert.equal(status, 413);
  assert.equal(f.calls.length, 0);
});

test('ASR accepts browser Ogg and normalized WAV media types', async t => {
  const f = await fixture(t);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]);
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  assert.equal((await f.upload(ogg, 'audio/ogg;codecs=opus')).status, 200);
  assert.equal((await f.upload(wav, 'audio/x-wav')).status, 200);
  assert.match(f.calls[1].body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
  assert.deepEqual(f.calls[0].body.asr_options, { enable_itn: false });
});

test('ASR missing credentials is explicit and independent from chat-model configuration', async t => {
  const f = await fixture(t, undefined, { asrApiKey: '' });
  const response = await f.upload();
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'ASR_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
  const config = loadConfig({ DASHSCOPE_API_KEY: 'fallback' });
  assert.equal(config.asrApiKey, 'fallback');
  assert.equal(config.modelApiKey, '');
  assert.equal(config.asrBaseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(loadConfig({ BACKEND_ASR_API_KEY: 'specific', DASHSCOPE_API_KEY: 'fallback' }).asrApiKey, 'specific');
  assert.throws(() => loadConfig({ BACKEND_ASR_BASE_URL: 'file:///audio' }), /BACKEND_ASR_BASE_URL/);
});

test('ASR failures are bounded and never leak raw provider errors or credentials', async t => {
  for (const [mode, expected] of [
    [401, 'ASR_AUTH_FAILED'], [429, 'ASR_RATE_LIMITED'], [500, 'ASR_UPSTREAM_ERROR'],
    ['empty', 'ASR_NO_SPEECH'], ['invalid', 'ASR_INVALID_RESPONSE'], ['length', 'ASR_INVALID_RESPONSE'], ['timeout', 'ASR_TIMEOUT'],
  ]) await t.test(String(mode), async t => {
    const f = await fixture(t, (req, body, res) => {
      if (typeof mode === 'number') { res.writeHead(mode); return res.end('private-asr-key and private audio'); }
      if (mode === 'empty') return result(res, '  ');
      if (mode === 'invalid') return res.end('{broken');
      if (mode === 'length') return res.end(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
    }, { asrTimeoutMs: 100 });
    const response = await f.upload();
    assert.equal(response.body.error.code, expected);
    assert.doesNotMatch(JSON.stringify(response.body), /private-asr-key|private audio/);
    assert.equal(f.app.backend.active, null);
  });
});

test('ASR rejects parallel uploads and cancels the provider request on client disconnect', async t => {
  let contacted, closed;
  const started = new Promise(resolve => { contacted = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, body, res) => { res.on('close', closed); contacted(); });
  const controller = new AbortController();
  const pending = f.upload(audio, 'audio/webm', 'web-token', controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  assert.equal((await f.upload()).body.error.code, 'ASR_BUSY');
  controller.abort();
  await rejected;
  await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 2000); timer.unref(); })]);
  assert.equal(f.app.backend.store.data.sessions.length, 0);
});
