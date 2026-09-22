'use strict';

const { randomUUID } = require('node:crypto');
const { Store } = require('./store');
const { Events } = require('./events');
const { runAgent, failure } = require('./model');

const ACTIVE_JOBS = new Set(['pending', 'dispatched', 'printing', 'unknown']);
const now = () => new Date().toISOString();
const id = () => randomUUID();
function httpError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function requireId(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw httpError(400, 'INVALID_ID', `Invalid ${name}`);
  return value;
}

class Backend {
  constructor(config) {
    this.config = config;
    this.store = new Store(config.dataDir);
    this.events = new Events();
    this.modelHealth = { configured: this.modelReady(), available: this.modelReady() ? null : false, last_error: null };
    this.device = { id: config.deviceId, connection: 'not_connected', business_state: 'idle', capabilities: null };
    this.active = null;
    this.worker = null;
    this.stopping = false;
    this.waiter = null;
    this.timer = setInterval(() => this.expireDevice(), Math.min(1000, config.offlineMs));
    this.timer.unref();
  }

  ready() {
    if (this.stopping || this.store.failed) throw httpError(503, 'BACKEND_UNAVAILABLE', 'Backend is unavailable');
  }

  modelReady() { return !!(this.config.model && this.config.modelBaseUrl && this.config.modelApiKey); }

  session(sessionId, source) {
    const session = this.store.data.sessions.find(s => s.id === sessionId && (!source || s.source === source));
    if (!session) throw httpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    return session;
  }

  createSession(source = 'web') {
    this.ready();
    const session = { id: id(), source, created_at: now(), messages: [], requests: [] };
    this.store.data.sessions.push(session);
    this.store.save();
    return session;
  }

  sessionSnapshot(session) {
    return { ...session, agent_state: this.active?.sessionId === session.id ? this.active.state : 'idle' };
  }

  job() { return this.store.data.jobs.find(j => ACTIVE_JOBS.has(j.status)); }

  deviceSnapshot() {
    const device = this.device;
    const job = this.job();
    const session = this.store.data.sessions.find(s => s.source === 'typewriter');
    const request = session?.requests.at(-1);
    let business = 'idle';
    if (device.connection === 'connected') {
      if (job?.status === 'printing') business = 'machine_typing';
      else if (device.humanTyping) business = 'human_typing';
      else if (this.active?.source === 'typewriter') business = 'thinking';
    }
    return {
      device_id: device.id, connection: device.connection, business_state: business,
      last_seen_at: device.lastSeen ? new Date(device.lastSeen).toISOString() : null,
      capabilities: device.capabilities, print_available: this.printAvailable(),
      latest_request: request ? {
        request_id: request.id, status: request.status, error: request.error || null,
        response_message_id: request.response_message_id || null, print_job_id: request.print_job_id || null,
      } : null,
      input_status_available: !!device.capabilities?.input_events,
      current_job: job || null, recent_jobs: this.store.data.jobs.slice(-6).reverse(),
    };
  }

  status() {
    return {
      model: { ...this.modelHealth },
      asr: { configured: !!this.config.asrApiKey, model: this.config.asrModel || 'qwen3-asr-flash' },
      active_request: this.active ? { session_id: this.active.sessionId, request_id: this.active.requestId, state: this.active.state } : null,
      device: this.deviceSnapshot(),
    };
  }

  publishSession(session, type, data, requestId, extra = {}) {
    this.events.publish(`session:${session.id}`, type, data, { session_id: session.id, ...(requestId ? { request_id: requestId } : {}), ...extra });
  }

  publishDevice(type = 'device.updated', job) {
    this.events.publish(`device:${this.device.id}`, type, job || this.deviceSnapshot(), {
      device_id: this.device.id, ...(job ? { job_id: job.id, request_id: job.request_id } : {}),
    });
  }

  connect(body) {
    this.ready();
    const caps = body.capabilities;
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw httpError(400, 'INVALID_CAPABILITIES', 'capabilities must be an object');
    const normalized = {};
    for (const key of ['input_events', 'supports_newline', 'print_started', 'print_completed']) {
      if (caps[key] !== undefined && typeof caps[key] !== 'boolean') throw httpError(400, 'INVALID_CAPABILITIES', `Invalid ${key}`);
      normalized[key] = caps[key] === true;
    }
    if (caps.charset !== undefined && caps.charset !== 'ascii') throw httpError(400, 'INVALID_CAPABILITIES', 'Only printable ASCII is supported');
    if (caps.max_chars !== undefined && (!Number.isInteger(caps.max_chars) || caps.max_chars < 1 || caps.max_chars > 32000)) throw httpError(400, 'INVALID_CAPABILITIES', 'max_chars must be between 1 and 32000');
    normalized.charset = caps.charset || null;
    normalized.max_chars = caps.max_chars || null;
    this.loseConnection();
    let session = this.store.data.sessions.find(s => s.source === 'typewriter');
    if (!session) session = this.createSession('typewriter');
    this.device = {
      id: this.config.deviceId, connection: 'connected', connectionId: id(), lastSeen: Date.now(),
      capabilities: normalized, sessionId: session.id, humanTyping: false,
    };
    this.publishDevice();
    return { connection_id: this.device.connectionId, session_id: session.id, heartbeat_interval_ms: this.config.heartbeatMs, device: this.deviceSnapshot() };
  }

  checkConnection(connectionId) {
    this.ready();
    this.expireDevice();
    if (this.device.connection !== 'connected' || connectionId !== this.device.connectionId) throw httpError(409, 'STALE_CONNECTION', 'Reconnect the device');
    this.device.lastSeen = Date.now();
  }

  heartbeat(body) {
    this.checkConnection(body.connection_id);
    if (body.job_id || body.print_status) {
      if (!body.job_id || !body.print_status) throw httpError(400, 'INVALID_PRINT_EVENT', 'job_id and print_status are required together');
      this.printEvent(body.job_id, { ...body, status: body.print_status });
    }
    return this.deviceSnapshot();
  }

  expireDevice() {
    if (this.device.connection === 'connected' && Date.now() - this.device.lastSeen > this.config.offlineMs) {
      try { this.loseConnection(); } catch { /* Storage failure disables further commands. */ }
    }
    if (this.device.humanTyping && Date.now() - this.device.lastInput > this.config.typingIdleMs) {
      this.device.humanTyping = false;
      this.publishDevice();
    }
  }

  loseConnection() {
    if (this.device.connection !== 'connected') return;
    this.device.connection = 'disconnected';
    this.device.humanTyping = false;
    const job = this.job();
    if (job) {
      job.status = 'unknown'; job.updated_at = now();
      job.error = { code: 'DEVICE_DISCONNECTED', message: 'Print result is unknown; automatic delivery is disabled' };
      this.store.save();
      this.publishDevice('print.updated', job);
    }
    if (this.waiter) this.waiter.finish();
    this.publishDevice();
  }

  input(body) {
    this.checkConnection(body.connection_id);
    if (body.type === 'submit') {
      const result = this.submit(this.session(this.device.sessionId), body);
      this.device.humanTyping = false;
      this.publishDevice();
      return result;
    }
    if (!['typing_started', 'typing_stopped'].includes(body.type)) throw httpError(400, 'INVALID_INPUT', 'Expected submit, typing_started or typing_stopped');
    if (!this.device.capabilities.input_events) throw httpError(409, 'INPUT_EVENTS_UNAVAILABLE', 'Device did not advertise input events');
    if (body.type === 'typing_started' && (this.job() || this.active?.source === 'typewriter')) throw httpError(409, 'DEVICE_BUSY', 'Device is waiting for a reply or printing');
    this.device.humanTyping = body.type === 'typing_started';
    this.device.lastInput = Date.now();
    this.publishDevice();
    return { accepted: true };
  }

  submit(session, body) {
    this.ready();
    if (body.source !== undefined || body.device_id !== undefined) throw httpError(400, 'INVALID_SOURCE', 'Message source is determined by the endpoint');
    requireId(body.client_message_id, 'client_message_id');
    if (typeof body.text !== 'string' || !body.text.trim()) throw httpError(400, 'EMPTY_MESSAGE', 'Message text is required');
    if ([...body.text].length > 8000) throw httpError(413, 'MESSAGE_TOO_LARGE', 'Message exceeds 8000 characters');
    const previous = session.requests.find(r => r.client_message_id === body.client_message_id);
    if (previous) {
      const input = session.messages.find(m => m.id === previous.user_message_id);
      if (input.text !== body.text) throw httpError(409, 'ID_CONFLICT', 'Message ID was already used for different text');
      return { request_id: previous.id, status: previous.status, duplicate: true };
    }
    // ponytail: one global generation slot; use per-session slots when concurrent chats are required.
    if (this.active) throw httpError(409, 'AGENT_BUSY', 'Current reply must finish before sending');
    if (session.source === 'typewriter' && this.job()) throw httpError(409, 'DEVICE_BUSY', 'Previous print task has not ended');
    if (!this.modelReady()) throw httpError(503, 'MODEL_NOT_CONFIGURED', 'Model service is not configured');
    const request = {
      id: id(), client_message_id: body.client_message_id, user_message_id: id(), status: 'running', created_at: now(), activities: [],
    };
    session.requests.push(request);
    session.messages.push({ id: request.user_message_id, request_id: request.id, role: 'user', source: session.source, text: body.text, status: 'completed', created_at: now() });
    this.store.save();
    const controller = new AbortController();
    this.active = { requestId: request.id, sessionId: session.id, source: session.source, state: 'thinking', controller };
    this.publishSession(session, 'request.accepted', { state: 'thinking', user_message: session.messages.at(-1) }, request.id);
    if (session.source === 'typewriter') this.publishDevice();
    // Run after the admission response has been constructed. The busy slot is already held.
    this.worker = Promise.resolve().then(() => this.execute(session, request, body.text, controller));
    return { request_id: request.id, status: 'running', duplicate: false };
  }

  history(session, request) {
    const pairs = [];
    let budget = 24000;
    for (const previous of session.requests.slice().reverse()) {
      if (previous.id === request.id || previous.status !== 'completed') continue;
      const user = session.messages.find(m => m.id === previous.user_message_id);
      const answer = session.messages.find(m => m.id === previous.response_message_id);
      if (!user || !answer) continue;
      const size = user.text.length + answer.text.length;
      if (size > budget || pairs.length >= 12) break;
      budget -= size;
      pairs.unshift([{ role: 'user', content: user.text }, { role: 'assistant', content: answer.text }]);
    }
    return pairs.flat();
  }

  async execute(session, request, text, controller) {
    const timer = setTimeout(() => controller.abort(failure('MODEL_TIMEOUT', 'Model request timed out')), this.config.modelTimeoutMs);
    let currentMessage = null;
    let generation = null;
    let lastSave = Date.now();
    const activity = (state, summary) => {
      const item = { id: id(), state, summary, activity_status: 'running', started_at: now() };
      request.activities.push(item);
      this.active.state = state;
      this.publishSession(session, 'activity.started', item, request.id, { activity_id: item.id });
      return item;
    };
    const finishActivity = (item, result, failed = false) => {
      if (!item || item.activity_status !== 'running') return;
      item.activity_status = failed ? 'failed' : 'completed'; item.ended_at = now();
      if (result) item.result = result;
      this.publishSession(session, failed ? 'activity.failed' : 'activity.completed', item, request.id, { activity_id: item.id });
    };
    try {
      generation = activity('thinking', '正在组织回答');
      const answer = await runAgent({
        config: this.config, history: this.history(session, request), text, source: session.source,
        printConstraints: this.device.capabilities, signal: controller.signal,
        deviceStatus: () => {
          const snapshot = this.deviceSnapshot();
          // Tool output must not bring device conversation text into web context.
          return {
            device_id: snapshot.device_id, connection: snapshot.connection, business_state: snapshot.business_state,
            print_available: snapshot.print_available,
            current_print_status: snapshot.current_job?.status || null,
          };
        },
        onText: (round, delta, streaming) => {
          if (!currentMessage) {
            currentMessage = { id: id(), request_id: request.id, role: 'assistant', text: '', status: 'streaming', created_at: now() };
            session.messages.push(currentMessage);
          }
          currentMessage.text += delta;
          if (streaming && this.active.state !== 'typing') {
            finishActivity(generation);
            generation = activity('typing', '正在生成文字回复');
          }
          if (streaming) this.publishSession(session, 'message.delta', { message_id: currentMessage.id, text: delta }, request.id);
          if (Date.now() - lastSave >= 250) { this.store.save(); lastSave = Date.now(); }
        },
        onTurn: (round, hasTools) => {
          finishActivity(generation);
          if (hasTools && currentMessage) {
            currentMessage.status = 'completed'; currentMessage.kind = 'tool_preamble';
            this.publishSession(session, 'message.completed', currentMessage, request.id);
            currentMessage = null;
          }
        },
        onTool: (phase, call, activityId, result) => {
          if (phase === 'started') {
            finishActivity(generation);
            return activity('tool_calling', call.function.name === 'get_typewriter_status' ? '正在查询打字机状态' : '正在验证工具请求').id;
          }
          finishActivity(request.activities.find(a => a.id === activityId), result, phase === 'failed');
          generation = activity('thinking', '正在根据工具结果组织回答');
        },
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!currentMessage) throw failure('MODEL_EMPTY', 'Model returned no reply');
      this.modelHealth.available = true; this.modelHealth.last_error = null;
      currentMessage.status = 'completed'; currentMessage.kind = 'answer';
      request.status = 'completed'; request.response_message_id = currentMessage.id; request.ended_at = now();
      finishActivity(generation);
      this.store.save();
      this.publishSession(session, 'message.completed', currentMessage, request.id);
      if (session.source === 'typewriter') this.createPrint(session, request, answer.text);
      this.publishSession(session, 'request.completed', { ...request, state: 'idle', sources: [] }, request.id);
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const safe = { code: reason?.code || 'MODEL_ERROR', message: reason?.code ? reason.message : 'The model request failed' };
      if (safe.code.startsWith('MODEL_')) {
        this.modelHealth.available = false; this.modelHealth.last_error = safe;
      }
      if (currentMessage?.status === 'streaming') currentMessage.status = 'incomplete';
      request.status = safe.code === 'INTERRUPTED' ? 'interrupted' : 'failed'; request.error = safe; request.ended_at = now();
      for (const item of request.activities) finishActivity(item, safe, true);
      try { this.store.save(); } catch { safe.code = 'STORAGE_ERROR'; safe.message = 'Backend storage is unavailable'; }
      this.publishSession(session, 'request.failed', { ...request, state: 'error', partial_message: currentMessage }, request.id);
    } finally {
      clearTimeout(timer);
      this.active = null;
      if (session.source === 'typewriter') this.publishDevice();
    }
  }

  printAvailable() {
    const caps = this.device.capabilities;
    return this.device.connection === 'connected' && !!(caps?.charset === 'ascii' && caps.max_chars);
  }

  createPrint(session, request, text) {
    const caps = this.device.capabilities;
    let error = null;
    if (!this.printAvailable()) error = { code: 'PRINT_UNAVAILABLE', message: 'Device is disconnected or print capabilities are missing' };
    else if (/[^\x20-\x7e\n]/.test(text) || (!caps.supports_newline && text.includes('\n'))) error = { code: 'UNSUPPORTED_TEXT', message: 'Reply contains characters the device cannot print' };
    else if (text.length > caps.max_chars) error = { code: 'PRINT_TOO_LONG', message: 'Reply exceeds the device character limit' };
    const job = {
      id: id(), device_id: this.device.id, session_id: session.id, request_id: request.id,
      response_message_id: request.response_message_id, text, status: error ? 'failed' : 'pending',
      error, created_at: now(), updated_at: now(),
    };
    this.store.data.jobs.push(job);
    request.print_job_id = job.id;
    this.store.save();
    this.publishDevice('print.updated', job);
    if (this.waiter) this.waiter.finish();
  }

  takeCommand(connectionId) {
    this.checkConnection(connectionId);
    const job = this.job();
    if (!job || job.status !== 'pending') return null;
    job.status = 'dispatched'; job.updated_at = now();
    this.store.save();
    this.publishDevice('print.updated', job);
    return { type: 'print', job_id: job.id, request_id: job.request_id, response_message_id: job.response_message_id, text: job.text };
  }

  async commands(connectionId, waitMs, signal) {
    this.checkConnection(connectionId);
    if (this.waiter) throw httpError(409, 'POLL_ALREADY_ACTIVE', 'Only one command poll is allowed');
    const command = this.takeCommand(connectionId);
    if (command || !waitMs) return command;
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener('abort', finish);
        this.waiter = null; resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.waiter = { finish };
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    if (signal.aborted || this.stopping) return null;
    return this.takeCommand(connectionId);
  }

  printEvent(jobId, body) {
    this.checkConnection(body.connection_id);
    const job = this.store.data.jobs.find(j => j.id === jobId && j.device_id === this.device.id);
    if (!job) throw httpError(404, 'JOB_NOT_FOUND', 'Print task not found');
    if (!['started', 'completed', 'failed'].includes(body.status)) throw httpError(400, 'INVALID_PRINT_EVENT', 'Invalid print status');
    if (body.status === 'started' && !this.device.capabilities.print_started) throw httpError(409, 'RECEIPT_UNAVAILABLE', 'Start receipts were not advertised');
    if (body.status === 'completed' && !this.device.capabilities.print_completed) throw httpError(409, 'RECEIPT_UNAVAILABLE', 'Completion receipts were not advertised');
    if (['completed', 'failed', 'abandoned'].includes(job.status)) return job;
    if (!['dispatched', 'printing', 'unknown'].includes(job.status)) throw httpError(409, 'JOB_NOT_DISPATCHED', 'Task has not been dispatched');
    if (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 300)) throw httpError(400, 'INVALID_PRINT_EVENT', 'Error must be a short string');
    job.status = body.status === 'started' ? 'printing' : body.status;
    job.error = body.status === 'failed' ? { code: 'DEVICE_PRINT_FAILED', message: body.error || 'Device reported a print failure' } : null;
    job.updated_at = now();
    this.store.save();
    this.publishDevice('print.updated', job);
    this.publishDevice();
    return job;
  }

  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    if (this.waiter) this.waiter.finish();
    this.active?.controller.abort(failure('INTERRUPTED', 'Backend stopped'));
    await this.worker;
    this.events.close();
  }
}

module.exports = { Backend, httpError, requireId };
