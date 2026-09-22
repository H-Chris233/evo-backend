'use strict';

const path = require('node:path');
const { createBackendServer } = require('./server');

function loadConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const modelBaseUrl = env.BACKEND_MODEL_BASE_URL || '';
  const asrBaseUrl = env.BACKEND_ASR_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  for (const [name, value] of [['BACKEND_MODEL_BASE_URL', modelBaseUrl], ['BACKEND_ASR_BASE_URL', asrBaseUrl]]) {
    if (!value) continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`);
  }
  const deviceId = env.BACKEND_DEVICE_ID || 'typewriter';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Invalid BACKEND_DEVICE_ID');
  const heartbeatMs = number('BACKEND_HEARTBEAT_MS', 5000, 100, 60000);
  const offlineMs = number('BACKEND_OFFLINE_MS', 15000, 200, 300000);
  if (offlineMs <= heartbeatMs) throw new Error('BACKEND_OFFLINE_MS must exceed BACKEND_HEARTBEAT_MS');
  const origins = (env.BACKEND_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origins.some(origin => { try { return new URL(origin).origin !== origin || !/^https?:/.test(origin); } catch { return true; } })) throw new Error('Invalid BACKEND_ALLOWED_ORIGINS');
  return {
    host: env.BACKEND_HOST || '0.0.0.0', port: number('BACKEND_PORT', 3000, 1, 65535),
    modelBaseUrl, model: env.BACKEND_MODEL || '', modelApiKey: env.BACKEND_MODEL_API_KEY || '',
    webToken: env.BACKEND_WEB_TOKEN || '', deviceToken: env.BACKEND_DEVICE_TOKEN || '', deviceId,
    dataDir: path.resolve(env.BACKEND_DATA_DIR || '.backend-data'), origins,
    heartbeatMs, offlineMs, typingIdleMs: number('BACKEND_TYPING_IDLE_MS', 3000, 100, 60000),
    modelTimeoutMs: number('BACKEND_MODEL_TIMEOUT_MS', 120000, 100, 600000),
    asrBaseUrl, asrModel: env.BACKEND_ASR_MODEL || 'qwen3-asr-flash',
    asrApiKey: env.BACKEND_ASR_API_KEY || env.DASHSCOPE_API_KEY || '',
    asrLanguage: env.BACKEND_ASR_LANGUAGE || '',
    asrTimeoutMs: number('BACKEND_ASR_TIMEOUT_MS', 60000, 100, 120000),
  };
}

async function main() {
  require('dotenv').config();
  const config = loadConfig();
  const app = createBackendServer(config);
  try { await app.start(); } catch (error) { await app.close(); throw error; }
  console.log(`[backend] Listening on ${config.host}:${config.port}; device ID: ${config.deviceId}`);
  console.log(`[backend] Model ${app.backend.modelReady() ? 'configured' : 'not configured'}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) main().catch(() => {
  console.error('[backend] Startup failed. Check backend configuration, port and state file.');
  process.exitCode = 1;
});

module.exports = { loadConfig };
