'use strict';

const http = require('node:http');
const { timingSafeEqual, randomUUID } = require('node:crypto');
const { Backend, httpError, requireId } = require('./service');
const { readAudio, transcribeAudio, asrError } = require('./asr');
const { BoardConnection } = require('./board');
const { log, errorInfo } = require('./log');

function sameToken(value, expected) {
  const a = Buffer.from(value || '');
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, 'JSON_REQUIRED', 'Use application/json');
  if (Number(req.headers['content-length']) > 65536) throw httpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65536) throw httpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw httpError(400, 'INVALID_JSON', 'Invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'INVALID_JSON', 'JSON body must be an object');
  return body;
}

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
}

function createBackendServer(config) {
  if (!config.webToken || !config.deviceToken || config.webToken === config.deviceToken) throw new Error('Distinct BACKEND_WEB_TOKEN and BACKEND_DEVICE_TOKEN are required');
  const backend = new Backend(config);
  if (config.boardHttpUrl) backend.board = new BoardConnection(backend, config);
  let asrController = null;
  let asrWork = null;
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const started = Date.now();
    req.traceId = randomUUID();
    res.setHeader('X-Request-ID', req.traceId);
    res.on('finish', () => {
      if (req.method === 'POST' || res.statusCode >= 400) log('http.completed', { trace_id: req.traceId, method: req.method, path: req.url.split('?')[0], status: res.statusCode, ms: Date.now() - started });
    });
    handle(req, res).catch(error => {
      log('http.failed', { trace_id: req.traceId, method: req.method, path: req.url.split('?')[0], status: error.status || 500, ...errorInfo(error) }, 'error');
      if (res.headersSent) return res.destroy();
      // Discard rejected upload bytes without buffering. A mid-upload socket close can hide the HTTP error.
      req.resume();
      send(res, error.status || 500, { error: { code: error.status ? error.code : 'INTERNAL_ERROR', message: error.status ? error.message : 'Backend request failed' } });
    });
  });

  async function handle(req, res) {
    let url, parts;
    try {
      url = new URL(req.url, 'http://backend.local');
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch { throw httpError(400, 'INVALID_URL', 'Invalid request URL'); }
    if (url.pathname === '/api/v1/health' && req.method === 'GET') return send(res, 200, { ok: true });
    const origin = req.headers.origin;
    if (origin) {
      if (!config.origins.includes(origin)) throw httpError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, X-Connection-ID');
    }
    if (req.method === 'OPTIONS') return send(res, 204);
    const role = sameToken(req.headers.authorization, config.webToken) ? 'web'
      : sameToken(req.headers.authorization, config.deviceToken) ? 'device' : null;
    if (!role) throw httpError(401, 'UNAUTHORIZED', 'A valid access token is required');
    backend.ready();
    if (parts[0] !== 'api' || parts[1] !== 'v1') throw httpError(404, 'NOT_FOUND', 'Not found');
    const route = parts.slice(2);
    const webOnly = () => { if (role !== 'web') throw httpError(403, 'FORBIDDEN', 'Web access token required'); };
    const deviceOnly = () => { if (role !== 'device') throw httpError(403, 'FORBIDDEN', 'Device access token required'); };
    if (route.length === 2 && route[0] === 'audio' && route[1] === 'transcriptions' && req.method === 'POST') {
      webOnly();
      if (!config.asrApiKey) throw asrError(503, 'ASR_NOT_CONFIGURED', 'Speech recognition is not configured');
      if (backend.active) throw asrError(409, 'AGENT_BUSY', 'Wait for the current reply before transcribing');
      if (asrController) throw asrError(409, 'ASR_BUSY', 'A transcription is already running');
      const controller = new AbortController();
      asrController = controller;
      const abort = () => controller.abort(asrError(499, 'ASR_CANCELLED', 'Transcription cancelled'));
      res.on('close', abort);
      const timer = setTimeout(() => controller.abort(asrError(504, 'ASR_TIMEOUT', 'Speech recognition timed out')), config.asrTimeoutMs);
      try {
        // Audio is kept only for this request; neither recordings nor drafts enter the conversation store.
        asrWork = (async () => transcribeAudio(config, await readAudio(req, controller.signal), controller.signal, { trace_id: req.traceId }))();
        return send(res, 200, await asrWork);
      } finally {
        clearTimeout(timer); res.removeListener('close', abort);
        asrController = null; asrWork = null;
      }
    }
    if (route.length === 1 && route[0] === 'status' && req.method === 'GET') {
      webOnly(); return send(res, 200, backend.status());
    }
    if (route[0] === 'sessions') {
      webOnly();
      if (route.length === 1 && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).length) throw httpError(400, 'INVALID_SESSION', 'Session creation expects an empty object');
        return send(res, 201, backend.createSession());
      }
      const session = backend.session(requireId(route[1], 'session_id'), 'web');
      if (route.length === 2 && req.method === 'GET') return send(res, 200, backend.sessionSnapshot(session));
      if (route.length === 3 && route[2] === 'messages' && req.method === 'POST') return send(res, 202, backend.submit(session, await readBody(req)));
      if (route.length === 3 && route[2] === 'events' && req.method === 'GET') {
        return backend.events.subscribe(`session:${session.id}`, res, req.headers['last-event-id'], backend.sessionSnapshot(session), { session_id: session.id });
      }
    }
    if (route[0] === 'devices') {
      const deviceId = requireId(route[1], 'device_id');
      if (deviceId !== config.deviceId) throw httpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
      if (route.length === 2 && req.method === 'GET') { webOnly(); return send(res, 200, backend.deviceSnapshot()); }
      if (route.length === 3 && route[2] === 'events' && req.method === 'GET') {
        webOnly(); return backend.events.subscribe(`device:${deviceId}`, res, req.headers['last-event-id'], backend.deviceSnapshot(), { device_id: deviceId });
      }
      if (route.length === 3 && route[2] === 'print-queue' && req.method === 'GET') {
        webOnly(); return send(res, 200, backend.printing.summary());
      }
      if (route.length === 3 && route[2] === 'recover' && req.method === 'POST') {
        webOnly();
        const body = await readBody(req);
        if (Object.keys(body).length) throw httpError(400, 'INVALID_RECOVERY', 'Recovery expects an empty object');
        if (!backend.board) throw httpError(503, 'BOARD_NOT_CONFIGURED', 'Board adapter is not configured');
        return send(res, 202, await backend.board.recover());
      }
      if (route.length === 5 && route[2] === 'print-jobs' && route[4] === 'resolve' && req.method === 'POST') {
        webOnly();
        const body = await readBody(req);
        if (Object.keys(body).some(key => key !== 'action')) throw httpError(400, 'INVALID_RESOLUTION', 'Only action is accepted');
        backend.printing.resolve(requireId(route[3], 'job_id'), body.action);
        return send(res, 200, backend.deviceSnapshot());
      }
      deviceOnly();
      if (req.method === 'POST' && route.length === 3) {
        const body = await readBody(req);
        if (route[2] === 'connect') return send(res, 200, backend.connect(body));
        if (route[2] === 'heartbeat') return send(res, 200, backend.heartbeat(body));
        if (route[2] === 'input') return send(res, body.type === 'submit' ? 202 : 200, backend.input(body));
      }
      if (req.method === 'GET' && route.length === 3 && route[2] === 'commands') {
        const raw = url.searchParams.get('wait_ms') ?? '25000';
        if (!/^\d+$/.test(raw) || Number(raw) > 25000) throw httpError(400, 'INVALID_WAIT', 'wait_ms must be between 0 and 25000');
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on('close', abort);
        try {
          const command = await backend.commands(req.headers['x-connection-id'], Number(raw), controller.signal);
          return send(res, command ? 200 : 204, command);
        } finally { res.removeListener('close', abort); }
      }
      if (req.method === 'POST' && route.length === 5 && route[2] === 'print-jobs' && route[4] === 'events') {
        return send(res, 200, backend.printEvent(requireId(route[3], 'job_id'), await readBody(req)));
      }
    }
    throw httpError(404, 'NOT_FOUND', 'Not found');
  }

  return {
    backend, server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
      });
      backend.board?.start();
      return server.address();
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      asrController?.abort(asrError(503, 'ASR_CANCELLED', 'Backend stopped'));
      await asrWork?.catch(() => {});
      await backend.board?.close();
      await backend.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

module.exports = { createBackendServer };
