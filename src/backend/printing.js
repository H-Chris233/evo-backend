'use strict';

const { randomUUID } = require('node:crypto');
const { translateText, failure } = require('./model');
const { log, errorInfo } = require('./log');
const now = () => new Date().toISOString();
const badRequest = (status, code, message) => Object.assign(new Error(message), { status, code });
const retryDelay = attempts => Math.min(60000, 2000 * 2 ** Math.min(5, attempts - 1));

class PrintQueue {
  constructor(config, store, device, notify) {
    this.config = config; this.store = store; this.device = device; this.notify = notify;
    this.worker = null; this.timer = null; this.controller = null; this.stopping = false; this.fault = false;
  }

  reserve(session, request) {
    request.turn_number = this.store.data.next_turn++;
    request.print_job_ids = [];
    for (const role of ['you', 'them']) this.store.data.print_segments.push({
      id: randomUUID(), session_id: session.id, request_id: request.id, turn_number: request.turn_number, role,
      source_message_id: role === 'you' ? request.user_message_id : null,
      status: role === 'you' ? request.local_echo ? 'completed' : 'pending' : 'waiting_reply', translation: null,
      local_echo: role === 'you' && !!request.local_echo,
      attempts: 0, next_retry_at: null, error: null, job_ids: [], created_at: now(),
    });
    log('print.reserved', { request_id: request.id, turn: request.turn_number, local_echo: !!request.local_echo });
  }

  reply(request, message) {
    const segment = this.store.data.print_segments.find(s => s.request_id === request.id && s.role === 'them');
    if (!segment || segment.status !== 'waiting_reply') return;
    segment.source_message_id = message?.id || null;
    segment.status = message ? 'pending' : 'ready';
    if (!message) segment.translation = '[Reply unavailable.]';
  }

  head() { return this.store.data.print_segments.find(s => s.status !== 'completed'); }
  currentJob() {
    const segment = this.head();
    if (!segment) return null;
    return this.store.data.jobs.reduce((first, job) => job.segment_id === segment.id
      && !['completed', 'delivered', 'superseded'].includes(job.status) && (!first || job.part_index < first.part_index) ? job : first, null);
  }
  available() {
    const device = this.device(), caps = device.capabilities;
    return !this.fault && !this.store.failed && device.connection === 'connected' && !!(caps?.charset === 'ascii' && caps.max_chars && (caps.print_completed || caps.print_delivered));
  }
  fits(job) {
    const caps = this.device().capabilities;
    return job.text.length <= caps.max_chars && (caps.supports_newline || !job.text.includes('\n'));
  }
  summary() {
    const pending = this.store.data.print_segments.filter(s => s.status !== 'completed');
    const head = pending[0], job = this.currentJob();
    const translation = pending.find(s => ['pending', 'translating', 'retrying'].includes(s.status));
    let state = 'idle';
    if (head) {
      if (job?.status === 'unknown') state = 'needs_confirmation';
      else if (job?.status === 'printing') state = 'printing';
      else if (job?.status === 'dispatched') state = 'waiting_receipt';
      else if (head.status !== 'ready') state = head.status === 'pending' ? 'translating' : head.status;
      else if (this.device().connection !== 'connected') state = 'waiting_device';
      else if (!this.available() || (job && !this.fits(job))) state = 'waiting_capabilities';
      else state = 'queued';
    }
    const reference = item => item ? { turn_number: item.turn_number, role: item.role } : null;
    return {
      state: this.fault || this.store.failed ? 'error' : state, pending_turns: new Set(pending.map(s => s.turn_number)).size, pending_segments: pending.length,
      head: reference(head),
      translation: translation ? { ...reference(translation), state: translation.status, attempts: translation.attempts, next_retry_at: translation.next_retry_at, error: translation.error } : null,
      current_job: job ? { ...reference(job), id: job.id, status: job.status, part_index: job.part_index, part_count: job.part_count, error: job.error } : null,
      confirmation: this.device().capabilities?.print_delivered && !this.device().capabilities?.print_completed ? 'software_drain' : 'print_completed',
    };
  }
  changed(job) { this.store.save(); this.notify(job); }

  wake() {
    if (this.stopping || this.store.failed || this.fault || this.worker) return;
    clearTimeout(this.timer); this.timer = null;
    this.worker = Promise.resolve().then(() => this.translate()).catch(error => {
      // Unexpected worker failures must stop delivery rather than spin or silently skip content.
      this.fault = true;
      log('print.worker_failed', errorInfo(error), 'error');
      this.notify();
    }).finally(() => {
      this.worker = null;
      const next = this.store.data.print_segments.find(s => !['ready', 'completed'].includes(s.status));
      if (!this.timer && next && next.status !== 'waiting_reply') this.wake();
    });
  }
  async translate() {
    while (!this.stopping && !this.store.failed) {
      const segment = this.store.data.print_segments.find(s => !['ready', 'completed'].includes(s.status));
      if (!segment || segment.status === 'waiting_reply') return;
      const delay = Date.parse(segment.next_retry_at || '') - Date.now();
      if (delay > 0) {
        this.timer = setTimeout(() => { this.timer = null; this.wake(); }, delay); this.timer.unref(); return;
      }
      segment.status = 'translating'; segment.attempts++; segment.next_retry_at = null;
      const started = Date.now();
      const context = { request_id: segment.request_id, segment_id: segment.id, turn: segment.turn_number, role: segment.role, attempt: segment.attempts };
      log('translation.started', context);
      this.changed();
      const controller = new AbortController(); this.controller = controller;
      const timer = setTimeout(() => controller.abort(failure('TRANSLATION_TIMEOUT', 'Translation timed out')), this.config.modelTimeoutMs);
      try {
        const session = this.store.data.sessions.find(s => s.id === segment.session_id);
        const source = session?.messages.find(m => m.id === segment.source_message_id);
        if (!source) throw failure('TRANSLATION_SOURCE_MISSING', 'Original message is unavailable');
        const text = await translateText(this.config, source.text, controller.signal, context);
        if (controller.signal.aborted) throw controller.signal.reason;
        segment.translation = text; segment.status = 'ready'; segment.error = null;
        log('translation.completed', { ...context, chars: text.length, ms: Date.now() - started });
      } catch (error) {
        segment.status = this.stopping ? 'pending' : 'retrying';
        if (!this.stopping) {
          segment.error = { code: error.code || 'TRANSLATION_UNAVAILABLE', message: error.code?.startsWith('TRANSLATION_') ? error.message : 'Translation is temporarily unavailable' };
          segment.next_retry_at = new Date(Date.now() + retryDelay(segment.attempts)).toISOString();
          log('translation.retry', { ...context, ...errorInfo(error), next_retry_at: segment.next_retry_at, ms: Date.now() - started }, 'warn');
        }
      } finally { clearTimeout(timer); this.controller = null; }
      this.changed();
    }
  }

  take() {
    if (!this.available()) return null;
    const segment = this.head();
    if (!segment || segment.status !== 'ready') return null;
    const request = this.store.data.sessions.find(s => s.id === segment.session_id).requests.find(r => r.id === segment.request_id);
    if (!segment.job_ids.length) {
      const turn = `TURN ${String(segment.turn_number).padStart(4, '0')}\n`;
      const prefix = segment.role === 'you' ? turn + 'YOU:\n' : (request.local_echo ? turn : '') + 'THEM:\n';
      let text = prefix + segment.translation + '\n\n';
      const caps = this.device().capabilities;
      if (!caps.supports_newline) text = text.replace(/\n/g, ' ');
      const count = Math.ceil(text.length / caps.max_chars);
      for (let part = 0; part < count; part++) {
        const job = {
          id: randomUUID(), segment_id: segment.id, device_id: this.config.deviceId,
          session_id: segment.session_id, request_id: segment.request_id, turn_number: segment.turn_number, role: segment.role,
          source_message_id: segment.source_message_id, response_message_id: segment.role === 'them' ? segment.source_message_id : null,
          part_index: part + 1, part_count: count, text: text.slice(part * caps.max_chars, (part + 1) * caps.max_chars),
          status: 'pending', error: null, created_at: now(), updated_at: now(),
        };
        this.store.data.jobs.push(job); segment.job_ids.push(job.id); request.print_job_ids.push(job.id);
        if (segment.role === 'them' && part === 0) request.print_job_id = job.id;
      }
    }
    const job = this.currentJob();
    if (!job || job.status !== 'pending' || !this.fits(job)) return null;
    job.status = 'dispatched'; job.updated_at = now();
    log('print.dispatched', { job_id: job.id, request_id: job.request_id, turn: job.turn_number, role: job.role, part: job.part_index, parts: job.part_count, chars: job.text.length });
    this.changed(job);
    return { type: 'print', job_id: job.id, request_id: job.request_id, response_message_id: job.response_message_id,
      source_message_id: job.source_message_id, turn_number: job.turn_number, role: job.role,
      part_index: job.part_index, part_count: job.part_count, text: job.text };
  }
  completeSegment(job) {
    const segment = this.store.data.print_segments.find(s => s.id === job.segment_id);
    if (segment && !this.store.data.jobs.some(j => j.segment_id === segment.id && !['completed', 'delivered', 'superseded'].includes(j.status))) segment.status = 'completed';
  }
  disconnect() {
    const job = this.currentJob();
    if (!job || !['dispatched', 'printing'].includes(job.status)) return;
    job.status = 'unknown'; job.updated_at = now();
    job.error = { code: 'DEVICE_DISCONNECTED', message: 'Verify the physical print result before continuing' };
    log('print.uncertain', { job_id: job.id, request_id: job.request_id, reason: 'DEVICE_DISCONNECTED' }, 'warn');
    this.changed(job);
  }
  receipt(jobId, body) {
    const job = this.store.data.jobs.find(j => j.id === jobId && j.device_id === this.config.deviceId);
    if (!job) throw badRequest(404, 'JOB_NOT_FOUND', 'Print task not found');
    if (!['started', 'completed', 'delivered', 'failed'].includes(body.status)) throw badRequest(400, 'INVALID_PRINT_EVENT', 'Invalid print status');
    const caps = this.device().capabilities;
    if (body.status === 'started' && !caps.print_started || body.status === 'completed' && !caps.print_completed) throw badRequest(409, 'RECEIPT_UNAVAILABLE', 'Receipt capability was not advertised');
    if (body.status === 'delivered' && !caps.print_delivered) throw badRequest(409, 'RECEIPT_UNAVAILABLE', 'Delivery receipts were not advertised');
    if (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 300)) throw badRequest(400, 'INVALID_PRINT_EVENT', 'Error must be a short string');
    if (['completed', 'delivered', 'failed', 'abandoned', 'superseded'].includes(job.status)) return job;
    if (!['dispatched', 'printing', 'unknown'].includes(job.status)) throw badRequest(409, 'JOB_NOT_DISPATCHED', 'Task has not been dispatched');
    // A failure may have printed a prefix. A late start cannot resolve an uncertain result.
    if (body.status === 'started' && job.status === 'unknown') return job;
    job.status = body.status === 'started' ? 'printing' : body.status === 'failed' ? 'unknown' : body.status;
    job.error = body.status === 'failed' ? { code: 'DEVICE_PRINT_FAILED', message: body.error || 'Verify how much was physically printed' } : null;
    job.updated_at = now();
    log('print.receipt', { job_id: job.id, request_id: job.request_id, receipt: body.status, state: job.status });
    if (['completed', 'delivered'].includes(job.status)) this.completeSegment(job);
    this.changed(job);
    return job;
  }
  resolve(jobId, action) {
    if (!['confirm_completed', 'retry'].includes(action)) throw badRequest(400, 'INVALID_RESOLUTION', 'Expected confirm_completed or retry');
    const job = this.store.data.jobs.find(j => j.id === jobId && j.device_id === this.config.deviceId);
    if (!job) throw badRequest(404, 'JOB_NOT_FOUND', 'Print task not found');
    if (job.resolution === action) return job.replacement_id ? this.store.data.jobs.find(j => j.id === job.replacement_id) : job;
    if (job.status !== 'unknown' || this.currentJob()?.id !== job.id) throw badRequest(409, 'PRINT_STATE_CHANGED', 'Print task no longer requires confirmation');
    log('print.resolve', { job_id: job.id, request_id: job.request_id, action }, 'warn');
    job.resolution = action; job.updated_at = now();
    if (action === 'confirm_completed') {
      job.status = 'completed'; job.error = null; this.completeSegment(job); this.changed(job); return job;
    }
    // A new ID prevents a late receipt (or the device's deduplication cache) from consuming the retry.
    const replacement = { ...job, id: randomUUID(), status: 'pending', error: null, resolution: null, created_at: now() };
    job.status = 'superseded'; job.replacement_id = replacement.id;
    const segment = this.head();
    segment.job_ids[segment.job_ids.indexOf(job.id)] = replacement.id;
    const request = this.store.data.sessions.find(s => s.id === segment.session_id).requests.find(r => r.id === segment.request_id);
    request.print_job_ids.push(replacement.id);
    if (request.print_job_id === job.id) request.print_job_id = replacement.id;
    this.store.data.jobs.push(replacement); this.changed(replacement); return replacement;
  }
  async close() {
    this.stopping = true; clearTimeout(this.timer);
    this.controller?.abort(failure('INTERRUPTED', 'Backend stopped'));
    await this.worker;
  }
}

module.exports = { PrintQueue, retryDelay };
