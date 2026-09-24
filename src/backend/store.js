'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { log, errorInfo } = require('./log');

class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'state.json');
    this.failed = false;
    this.data = { version: 2, sessions: [], jobs: [], print_segments: [], next_turn: 1 };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (![1, 2].includes(this.data.version) || !Array.isArray(this.data.sessions) || !Array.isArray(this.data.jobs)
          || this.data.sessions.some(s => typeof s.id !== 'string' || !['web', 'typewriter'].includes(s.source)
            || !Array.isArray(s.messages) || !Array.isArray(s.requests))) {
        throw new Error('Invalid backend state file');
      }
    }
    const legacy = this.data.version === 1;
    if (legacy) {
      this.data.version = 2;
      this.data.print_segments = [];
      this.data.next_turn = 1;
    }
    if (!Array.isArray(this.data.print_segments) || !Number.isSafeInteger(this.data.next_turn) || this.data.next_turn < 1
      || this.data.print_segments.some(segment => !Array.isArray(segment.job_ids)
        || !['waiting_reply', 'pending', 'translating', 'retrying', 'ready', 'completed'].includes(segment.status)
        || !['you', 'them'].includes(segment.role) || !Number.isSafeInteger(segment.turn_number)
        || segment.turn_number < 1
        || !Number.isSafeInteger(segment.attempts) || segment.attempts < 0
        || (segment.next_retry_at !== null && !Number.isFinite(Date.parse(segment.next_retry_at)))
        || (['ready', 'completed'].includes(segment.status) && !segment.local_echo && (typeof segment.translation !== 'string'
          || !segment.translation.trim() || segment.translation.length > 128000 || /[^\x20-\x7e\n]/.test(segment.translation))))) {
      throw new Error('Invalid print queue state');
    }
    for (const session of this.data.sessions) {
      for (const request of session.requests) {
        if (request.status === 'running') {
          request.status = 'interrupted';
          request.error = { code: 'INTERRUPTED', message: 'Backend restarted' };
          for (const activity of request.activities || []) {
            if (activity.activity_status === 'running') activity.activity_status = 'failed';
          }
        }
      }
      for (const message of session.messages) if (message.status === 'streaming') message.status = 'incomplete';
    }
    for (const job of this.data.jobs) {
      if (legacy && ['pending', 'dispatched', 'printing', 'unknown'].includes(job.status)) {
        job.status = 'abandoned';
        job.error = { code: 'INTERRUPTED', message: 'Legacy print task will not resume' };
      } else if (['dispatched', 'printing'].includes(job.status)) {
        job.status = 'unknown';
        job.error = { code: 'INTERRUPTED', message: 'Backend restarted; verify the physical print result' };
      }
    }
    for (const segment of this.data.print_segments) {
      if (segment.status === 'translating') segment.status = 'pending';
      if (segment.status === 'waiting_reply') {
        const session = this.data.sessions.find(s => s.id === segment.session_id);
        const request = session?.requests.find(r => r.id === segment.request_id);
        const answer = session?.messages.find(m => m.id === request?.response_message_id && m.status === 'completed');
        segment.source_message_id = answer?.id || null;
        segment.status = answer ? 'pending' : 'ready';
        if (!answer) segment.translation = '[Reply unavailable.]';
      }
    }
    this.save();
    log('store.loaded', { version: this.data.version, migrated: legacy, sessions: this.data.sessions.length, jobs: this.data.jobs.length,
      pending_segments: this.data.print_segments.filter(s => s.status !== 'completed').length,
      uncertain_jobs: this.data.jobs.filter(j => j.status === 'unknown').length });
  }

  save() {
    // ponytail: single-process snapshots; use SQLite if history size makes these writes expensive.
    if (this.failed) throw new Error('Backend storage is unavailable');
    const temporary = this.file + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.data));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
    } catch (error) {
      this.failed = true;
      log('store.write_failed', errorInfo(error), 'error');
      throw error;
    }
  }
}

module.exports = { Store };
