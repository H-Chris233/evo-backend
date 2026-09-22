'use strict';

// Protocol simulator only: stdout is not evidence of physical printing.
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

async function main() {
  require('dotenv').config();
  const base = (process.env.BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const deviceId = process.env.BACKEND_DEVICE_ID || 'typewriter';
  const token = process.env.BACKEND_DEVICE_TOKEN;
  if (!token) throw new Error('BACKEND_DEVICE_TOKEN is required');
  const path = `/api/v1/devices/${encodeURIComponent(deviceId)}`;
  const controller = new AbortController();
  let connectionId, stopped = false, heartbeatPending = false, busy = false, draft = null, lastFailure = null;
  const seen = new Set();
  async function api(suffix, body, method = 'POST') {
    const response = await fetch(base + path + suffix, {
      method, signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Connection-ID': connectionId || '' },
      ...(method === 'POST' ? { body: JSON.stringify({ ...body, connection_id: connectionId }) } : {}),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error?.code || `HTTP ${response.status}`);
    return data;
  }
  const connected = await api('/connect', { capabilities: {
    charset: 'ascii', max_chars: 4000, supports_newline: true,
    input_events: false, print_started: true, print_completed: true,
  } });
  connectionId = connected.connection_id;
  console.log('[simulator] Connected. Type a message and press Enter; /retry resends a retained draft; /quit exits.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat); controller.abort(); rl.close(); process.stdin.destroy();
  }
  const heartbeat = setInterval(async () => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    try {
      const snapshot = await api('/heartbeat', {});
      const request = snapshot.latest_request;
      const failedJob = snapshot.recent_jobs.find(job => job.id === request?.print_job_id && job.status === 'failed');
      if (request && (request.error || failedJob) && request.request_id !== lastFailure) {
        lastFailure = request.request_id;
        console.error('[simulator] Request ended without printing:', request.error?.code || failedJob.error?.code);
      }
    }
    catch (error) { if (!stopped) { console.error('[simulator] Connection lost:', error.message); stop(); } }
    finally { heartbeatPending = false; }
  }, connected.heartbeat_interval_ms);
  process.once('SIGINT', stop);
  rl.once('close', stop);
  rl.on('line', async line => {
    if (line === '/quit') return stop();
    if (busy) return console.log('[simulator] Submission in progress.');
    if (line !== '/retry') {
      if (draft) return console.log('[simulator] Draft retained; use /retry before entering another message.');
      if (!line.trim()) return;
      draft = { type: 'submit', text: line, client_message_id: randomUUID() };
    }
    if (!draft) return;
    busy = true;
    try {
      const result = await api('/input', draft);
      console.log('[simulator] Accepted:', result.request_id); draft = null;
    } catch (error) { if (!stopped) console.error('[simulator] Draft retained:', error.message); }
    finally { busy = false; }
  });
  try {
    while (!stopped) {
      const command = await api('/commands?wait_ms=25000', null, 'GET');
      if (!command || seen.has(command.job_id)) continue;
      seen.add(command.job_id);
      await api(`/print-jobs/${command.job_id}/events`, { status: 'started' });
      console.log(`\n[simulated print ${command.job_id}]\n${command.text}\n[/simulated print]\n`);
      await api(`/print-jobs/${command.job_id}/events`, { status: 'completed' });
    }
  } finally { stop(); }
}

if (require.main === module) main().catch(error => {
  if (error.name !== 'AbortError') console.error('[simulator]', error.message);
  process.exitCode = error.name === 'AbortError' ? 0 : 1;
});

module.exports = { main };
