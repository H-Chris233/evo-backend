'use strict';

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'state.json');
    this.failed = false;
    this.data = { version: 1, sessions: [], jobs: [] };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !Array.isArray(this.data.sessions) || !Array.isArray(this.data.jobs)
          || this.data.sessions.some(s => typeof s.id !== 'string' || !['web', 'typewriter'].includes(s.source)
            || !Array.isArray(s.messages) || !Array.isArray(s.requests))) {
        throw new Error('Invalid backend state file');
      }
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
      if (['pending', 'dispatched', 'printing', 'unknown'].includes(job.status)) {
        job.status = 'abandoned';
        job.error = { code: 'INTERRUPTED', message: 'Backend restarted; print will not resume' };
      }
    }
    this.save();
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
      throw error;
    }
  }
}

module.exports = { Store };
