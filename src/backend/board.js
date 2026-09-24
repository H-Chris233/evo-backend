'use strict';

const { readLimited } = require('./model');
const { log, errorInfo } = require('./log');
const validId = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);

function formatBoardText(text, columns = 60) {
  if (/[^\x20-\x7e\n]/.test(text)) throw new Error('Unprintable board text');
  const lines = [];
  for (let line of text.split('\n')) {
    while (line.length > columns) {
      const space = line.lastIndexOf(' ', columns);
      const end = space > 0 ? space : columns;
      lines.push(line.slice(0, end)); line = line.slice(end + (space > 0 ? 1 : 0));
    }
    lines.push(line);
  }
  return lines.join('\n\r');
}

class BoardConnection {
  constructor(backend, config) {
    this.backend = backend; this.config = config; this.ws = null; this.remote = null;
    this.inflight = null; this.connectionId = null; this.stopping = false; this.worker = null;
    this.lastError = null; this.nextConnect = 0; this.timer = null; this.controller = new AbortController();
    this.lastStateLog = '';
    this.stopVersion = 0;
    backend.store.data.board_inputs ||= [];
  }
  snapshot() {
    return { configured: true, websocket_connected: this.ws?.readyState === WebSocket.OPEN,
      host_state: this.remote?.state || 'disconnected', error: this.remote?.state === 'fault' ? 'BOARD_DEVICE_FAULT' : this.lastError,
      confirmation: 'software_drain' };
  }
  start() {
    log('board.started', { http_host: new URL(this.config.boardHttpUrl).host, ws_host: new URL(this.config.boardWsUrl).host, columns: this.config.boardColumns });
    this.timer = setInterval(() => this.tick(), 500); this.timer.unref(); this.tick();
  }
  fail(code, detail = {}) {
    if (this.lastError !== code || this.inflight) log('board.failed', { ...detail, error_type: detail.error_code, error_code: code, job_id: this.inflight?.jobId, board_request_id: detail.board_request_id || this.inflight?.remoteId }, 'error');
    this.lastError = code;
    const job = this.inflight && this.backend.store.data.jobs.find(j => j.id === this.inflight.jobId);
    this.inflight = null;
    if (job && ['dispatched', 'printing'].includes(job.status)) {
      job.status = 'unknown'; job.error = { code, message: 'Board delivery is uncertain; verify before retrying' };
      this.backend.printing.changed(job);
    }
    this.backend.publishDevice();
  }
  socket() {
    if (this.stopping || this.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.ws.readyState) || Date.now() < this.nextConnect) return;
    this.nextConnect = Date.now() + 2000;
    const ws = new WebSocket(this.config.boardWsUrl); this.ws = ws;
    log('board.ws_connecting', { host: new URL(this.config.boardWsUrl).host });
    ws.addEventListener('open', () => log('board.ws_connected'));
    ws.addEventListener('message', event => {
      if (this.ws !== ws || this.stopping) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1048576) throw new Error('Invalid message');
        const message = JSON.parse(event.data);
        if (message.v !== 1) throw new Error('Invalid version');
        if (message.type === 'state') { this.remote = message.state; this.stopped(message.state.last_stop_id); }
        else if (message.type === 'input.cancelled') this.stopped(message.stop_id);
        else if (message.type === 'input.submitted') this.input(message);
        else if (message.type === 'response.drained') this.delivered(message.request_id);
        else if (['error', 'device.error'].includes(message.type)) this.fail('BOARD_DEVICE_ERROR', { board_request_id: message.request_id, device_error: message.error });
      } catch (error) { this.fail('BOARD_PROTOCOL_ERROR', errorInfo(error)); }
    });
    ws.addEventListener('error', () => log('board.ws_error', {}, 'warn'));
    ws.addEventListener('close', event => {
      if (this.ws !== ws || this.stopping) return;
      this.fail('BOARD_DISCONNECTED', { close_code: event.code }); this.backend.loseConnection(); this.connectionId = null;
    });
  }
  input(message) {
    if (!validId(message.request_id) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 8000) {
      log('board.input_rejected', { valid_id: validId(message.request_id), chars: typeof message.text === 'string' ? message.text.length : null }, 'warn');
      if (validId(message.request_id)) this.end(message.request_id);
      this.lastError = 'BOARD_INVALID_INPUT'; return;
    }
    const data = this.backend.store.data;
    // Direct-print requests must never be replayed as user input when a socket reconnects.
    if (data.jobs.some(j => j.id === message.request_id || j.board_request_id === message.request_id)) { log('board.print_replay_ignored', { board_request_id: message.request_id }); return; }
    const previous = data.board_inputs.find(input => input.id === message.request_id);
    if (previous) {
      log('board.input_replay', { board_request_id: message.request_id, state: previous.status });
      if (previous.text !== message.text) this.fail('BOARD_INPUT_CONFLICT');
      return;
    }
    data.board_inputs.push({ id: message.request_id, text: message.text, created_at: Date.now(), status: 'pending', response_ended: false });
    this.backend.store.save();
    log('board.input_received', { board_request_id: message.request_id, chars: message.text.length });
  }
  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Board WebSocket is unavailable');
    this.ws.send(JSON.stringify({ v: 1, ...message }));
  }
  stopped(stopId) {
    if (!validId(stopId)) return;
    if (this.backend.store.data.board_stop_id !== stopId) {
      this.stopVersion++; this.inflight = null;
      this.backend.store.data.board_stop_id = stopId;
      this.backend.stop();
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'stop.ack', stop_id: stopId });
  }
  end(requestId) {
    const input = this.backend.store.data.board_inputs.find(item => item.id === requestId);
    if (input?.response_ended) return;
    if (input) { input.response_ended = true; this.backend.store.save(); }
    this.send({ type: 'response.end', request_id: requestId });
    log('board.response_end', { board_request_id: requestId });
  }
  delivered(requestId) {
    if (!this.inflight || this.inflight.remoteId !== requestId) return;
    const job = this.backend.store.data.jobs.find(j => j.id === this.inflight.jobId);
    log('board.software_drained', { board_request_id: requestId, job_id: job?.id, ms: Date.now() - this.inflight.started });
    this.inflight = null;
    // A replayed cached state cannot resolve a task that became uncertain after a disconnect.
    if (job?.status === 'dispatched' && this.connectionId) this.backend.printEvent(job.id, { connection_id: this.connectionId, status: 'delivered' });
  }
  async http(path, body) {
    const started = Date.now();
    const response = await fetch(this.config.boardHttpUrl.replace(/\/$/, '') + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
    });
    const result = JSON.parse(await readLimited(response.body));
    if (body !== undefined || !response.ok) log('board.http', { path, status: response.status, board_request_id: body?.request_id, ms: Date.now() - started });
    if (!response.ok) throw Object.assign(new Error('Board HTTP request failed'), { boardError: result.error });
    return result;
  }
  tick() {
    if (this.worker || this.stopping || this.backend.store.failed) return;
    this.worker = this.run().catch(error => {
      if (!this.stopping) { this.fail('BOARD_UNAVAILABLE', errorInfo(error)); this.backend.loseConnection(); this.connectionId = null; }
    }).finally(() => { this.worker = null; });
  }
  async run() {
    this.socket();
    const stopVersion = this.stopVersion;
    const state = await this.http('/state');
    if (stopVersion !== this.stopVersion) return;
    this.remote = state;
    this.stopped(state.last_stop_id);
    if (stopVersion !== this.stopVersion) return;
    const stateKey = JSON.stringify([state.connected, state.state, state.active_request, state.last_error]);
    if (stateKey !== this.lastStateLog) {
      this.lastStateLog = stateKey;
      log('board.state', { connected: state.connected, state: state.state, board_request_id: state.active_request, queued_bytes: state.queued_bytes, printed_bytes: state.printed_bytes, last_tx_byte: state.last_tx_byte, device_error: state.last_error });
    }
    if (state.host_protocol !== 2) { this.fail('BOARD_HOST_UPDATE_REQUIRED'); this.backend.loseConnection(); this.connectionId = null; return; }
    const fresh = Number.isFinite(state.last_device_seen_at) && Date.now() - state.last_device_seen_at < 10000;
    if (this.ws?.readyState !== WebSocket.OPEN || !state.connected || !fresh || state.device !== 'kxr530-esp32s3' || ['fault', 'disconnected', 'connecting'].includes(state.state)) {
      if (this.inflight) this.fail('BOARD_DEVICE_UNAVAILABLE', { fresh, state: state.state, last_tx_byte: state.last_tx_byte });
      this.backend.loseConnection(); this.connectionId = null; return;
    }
    if (!this.connectionId || this.backend.device.connection !== 'connected') {
      this.connectionId = this.backend.connect({ capabilities: { charset: 'ascii', max_chars: 131072, supports_newline: true, print_started: false, print_completed: false, print_delivered: true, input_events: false } }, true).connection_id;
    }
    this.backend.device.lastSeen = Date.now(); this.lastError = null;
    if (state.last_delivery?.status === 'drained') this.delivered(state.last_delivery.request_id);
    const data = this.backend.store.data;
    if (!this.backend.active) {
      const input = data.board_inputs.find(item => item.status === 'pending');
      if (input?.text.trim() === '/new') {
        this.inflight = null;
        this.backend.stop('Started a new conversation');
        const session = this.backend.createSession('typewriter');
        input.status = 'session_reset'; input.session_id = session.id; input.response_ended = false; this.backend.store.save();
        this.backend.publishDevice();
        log('board.session_reset', { board_request_id: input.id, session_id: session.id });
      } else if (input && this.backend.modelReady()) {
        const session = this.backend.session(this.backend.device.sessionId);
        const accepted = this.backend.submit(session, { text: input.text, client_message_id: input.id }, { requestId: input.id, localEcho: true });
        input.status = 'submitted'; input.request_id = accepted.request_id; this.backend.store.save();
        log('board.input_admitted', { board_request_id: input.id, request_id: accepted.request_id });
      }
    }
    const head = this.backend.printing.head();
    const input = data.board_inputs.find(item => item.id === state.active_request);
    if (input?.status === 'session_reset') {
      // Replaying this fixed sequence/end is safe until the host reports drain, including after reconnect.
      this.send({ type: 'response.delta', request_id: input.id, seq: 0, text: 'NEW CONVERSATION.\n\r' });
      this.send({ type: 'response.end', request_id: input.id });
      return;
    }
    const request = head && data.sessions.find(s => s.id === head.session_id)?.requests.find(r => r.id === head.request_id);
    // Release a keyboard lock while an earlier round or a prolonged model retry is ahead of it.
    if (input && !input.response_ended && !this.inflight &&
      (head && head.request_id !== input.request_id || Date.now() - input.created_at > this.config.modelTimeoutMs + 30000)) {
      this.end(input.id); return;
    }
    if (this.inflight) {
      if (Date.now() - this.inflight.started > 600000) this.fail('BOARD_DELIVERY_TIMEOUT');
      return;
    }
    if (!head) return;
    if (head.status !== 'ready') {
      if (head.role === 'them' && !state.active_request && state.state === 'editing' && !request?.board_request_id && !request?.board_thinking_id) {
        request.board_thinking_id = request.id; this.backend.store.save();
        log('board.thinking_started', { request_id: request.id, board_request_id: request.id });
        try { await this.http('/thinking', { request_id: request.id }); }
        catch (error) { if (error.boardError === 'busy') { delete request.board_thinking_id; this.backend.store.save(); } else this.fail('BOARD_THINKING_UNCERTAIN'); }
      }
      return;
    }
    const useSocket = input && !input.response_ended && input.request_id === head.request_id || request?.board_thinking_id === state.active_request;
    if (state.active_request && !useSocket || !state.active_request && state.state !== 'editing') return;
    const command = this.backend.takeCommand(this.connectionId);
    if (!command) return;
    const job = data.jobs.find(item => item.id === command.job_id);
    const remoteId = useSocket ? state.active_request : job.id;
    job.board_request_id = remoteId; job.delivery_basis = 'software_drain'; this.backend.store.save();
    this.inflight = { jobId: job.id, remoteId, started: Date.now() };
    const text = formatBoardText(command.text, this.config.boardColumns);
    log('board.output_started', { job_id: job.id, request_id: job.request_id, board_request_id: remoteId, transport: useSocket ? 'ws' : 'http', bytes: text.length, columns: this.config.boardColumns });
    try {
      if (useSocket) {
        for (let offset = 0, seq = 0; offset < text.length; offset += 128, seq++) {
          if (!this.inflight || this.stopping) throw new Error('Board output stopped');
          this.send({ type: 'response.delta', request_id: remoteId, seq, text: text.slice(offset, offset + 128) });
          while (this.ws.bufferedAmount > 16384 && this.ws.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.end(remoteId);
      } else {
        const accepted = await this.http('/print', { request_id: remoteId, text });
        if (accepted.request_id !== remoteId) throw new Error('Board request ID mismatch');
      }
      log('board.output_sent', { job_id: job.id, board_request_id: remoteId, bytes: text.length, awaiting: 'software_drain' });
    } catch (error) {
      if (job.status === 'abandoned') return;
      if (error.boardError === 'busy') {
        log('board.busy', { job_id: job.id, board_request_id: remoteId }, 'warn');
        this.inflight = null; job.status = 'pending'; this.backend.printing.changed(job);
      } else this.fail('BOARD_SEND_UNCERTAIN', errorInfo(error));
    }
  }
  async close() {
    log('board.stopping', { job_id: this.inflight?.jobId });
    this.stopping = true; clearInterval(this.timer); this.controller.abort(); this.ws?.close();
    await this.worker; this.backend.loseConnection();
  }
}

module.exports = { BoardConnection, formatBoardText };
