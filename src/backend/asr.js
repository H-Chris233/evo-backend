'use strict';

const { readLimited } = require('./model');

// Qwen-ASR's compatible API accepts a Data URL, not /audio/transcriptions multipart.
// https://help.aliyun.com/zh/model-studio/recording-file-recognition-qwen
const MAX_AUDIO_BYTES = 6 * 1024 * 1024; // Base64 stays below the provider's 10 MB limit.
const MIME_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg']);
function asrError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

async function readAudio(req, signal) {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.has(mime)) throw asrError(415, 'ASR_UNSUPPORTED_FORMAT', 'Use WebM, Ogg, WAV or MP3 audio');
  if (Number(req.headers['content-length']) > MAX_AUDIO_BYTES) throw asrError(413, 'ASR_AUDIO_TOO_LARGE', 'Audio exceeds 6 MiB');
  const chunks = [];
  let size = 0;
  const abort = () => { if (!req.complete) req.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) throw asrError(413, 'ASR_AUDIO_TOO_LARGE', 'Audio exceeds 6 MiB');
      chunks.push(chunk);
    }
  } finally { signal.removeEventListener('abort', abort); }
  const audio = Buffer.concat(chunks);
  if (audio.length < 12) throw asrError(400, 'ASR_EMPTY_AUDIO', 'Audio is empty or incomplete');
  const valid = mime === 'audio/webm' ? audio.readUInt32BE(0) === 0x1a45dfa3
    : mime === 'audio/ogg' ? audio.toString('ascii', 0, 4) === 'OggS'
      : mime === 'audio/mpeg' ? audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
        : audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
  if (!valid) throw asrError(400, 'ASR_INVALID_AUDIO', 'Audio does not match its media type');
  return { audio, mime: mime === 'audio/x-wav' ? 'audio/wav' : mime };
}

async function transcribeAudio(config, { audio, mime }, signal) {
  let response;
  try {
    response = await fetch(config.asrBaseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.asrApiKey}` },
      body: JSON.stringify({
        model: config.asrModel,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audio.toString('base64')}` } }] }],
        stream: false,
        asr_options: { enable_itn: false, ...(config.asrLanguage ? { language: config.asrLanguage } : {}) },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = [401, 403].includes(response.status) ? 'ASR_AUTH_FAILED'
        : response.status === 429 ? 'ASR_RATE_LIMITED' : 'ASR_UPSTREAM_ERROR';
      throw asrError(502, code, 'Speech recognition service rejected the request');
    }
    let result;
    try { result = JSON.parse(await readLimited(response.body, 262144)); }
    catch { throw asrError(502, 'ASR_INVALID_RESPONSE', 'Invalid speech recognition response'); }
    const choice = result?.choices?.[0];
    const text = choice?.message?.content;
    if (result?.error || typeof text !== 'string' || text.length > 8000 || (choice.finish_reason && choice.finish_reason !== 'stop')) {
      throw asrError(502, 'ASR_INVALID_RESPONSE', 'Incomplete speech recognition result');
    }
    if (!text.trim()) throw asrError(422, 'ASR_NO_SPEECH', 'No speech was recognized');
    return { text: text.trim() };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error.status) throw error;
    throw asrError(502, 'ASR_UNAVAILABLE', 'Could not reach the speech recognition service');
  }
}

module.exports = { MAX_AUDIO_BYTES, readAudio, transcribeAudio, asrError };
