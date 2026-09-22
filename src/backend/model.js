'use strict';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// Decode lines before frames: either UTF-8 characters or CRLF can cross chunks.
async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + size > 262144) throw failure('MODEL_PROTOCOL', 'Model event is too large');
      let match;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = []; size = 0;
        } else if (line === 'data' || line.startsWith('data:')) {
          const text = line.slice(5).replace(/^ /, '');
          data.push(text); size += text.length;
        }
      }
      if (done) {
        if (buffer.trim() || data.length) throw failure('MODEL_PROTOCOL', 'Incomplete model event');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const STATUS_TOOL = {
  type: 'function',
  function: {
    name: 'get_typewriter_status', description: 'Read the actual connection and printing status of the typewriter.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

async function readLimited(body, limit = 1048576) {
  const reader = body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw failure('MODEL_PROTOCOL', 'Model response is too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function modelTurn(config, messages, signal, onText) {
  let response;
  try {
    response = await fetch(config.modelBaseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.modelApiKey}` },
      body: JSON.stringify({ model: config.model, messages, stream: true, tools: [STATUS_TOOL] }),
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw failure('MODEL_UNAVAILABLE', 'Could not connect to the model');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw failure('MODEL_HTTP_ERROR', `Model service returned HTTP ${response.status}`);
  }
  let content = '', reason = null;
  const calls = new Map();
  function append(text, streaming) {
    if (typeof text !== 'string') throw failure('MODEL_PROTOCOL', 'Invalid model text');
    content += text;
    if (content.length > 32000) throw failure('MODEL_LIMIT', 'Model reply exceeds the output limit');
    if (text) onText(text, streaming);
  }
  if (/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
    let finished = false;
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') { finished = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { throw failure('MODEL_PROTOCOL', 'Invalid model event'); }
      if (chunk.error) throw failure('MODEL_ERROR', 'Model stream reported an error');
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (reason && (choice.delta?.content || choice.delta?.tool_calls)) throw failure('MODEL_PROTOCOL', 'Data after model completion');
      if (choice.delta?.content != null) append(choice.delta.content, true);
      for (const delta of choice.delta?.tool_calls || []) {
        if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 8) throw failure('TOOL_LIMIT', 'Too many tool calls');
        if (!calls.has(delta.index)) calls.set(delta.index, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const call = calls.get(delta.index);
        if (delta.type && delta.type !== 'function') throw failure('MODEL_PROTOCOL', 'Invalid tool call type');
        if (delta.id) call.id += delta.id;
        if (delta.function?.name) call.function.name += delta.function.name;
        if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
        if (call.id.length > 256 || call.function.name.length > 128 || call.function.arguments.length > 16384) throw failure('TOOL_LIMIT', 'Tool call is too large');
      }
      if (choice.finish_reason) reason = choice.finish_reason;
    }
    if (!finished || !reason) throw failure('MODEL_INCOMPLETE', 'Model reply was interrupted');
  } else {
    let payload;
    try { payload = JSON.parse(await readLimited(response.body)); } catch (error) {
      throw failure(error.code || 'MODEL_PROTOCOL', 'Invalid model response');
    }
    const choice = payload.choices?.[0];
    if (!choice) throw failure('MODEL_PROTOCOL', 'Model response has no result');
    if (choice.message?.content != null) append(choice.message.content, false);
    const list = choice.message?.tool_calls || [];
    if (!Array.isArray(list) || list.length > 8) throw failure('TOOL_LIMIT', 'Too many tool calls');
    list.forEach((call, i) => calls.set(i, call));
    reason = choice.finish_reason;
  }
  const toolCalls = [...calls.values()];
  if (!['stop', 'tool_calls'].includes(reason)) throw failure('MODEL_INCOMPLETE', 'Model reply did not finish normally');
  if ((reason === 'tool_calls') !== (toolCalls.length > 0)) throw failure('MODEL_PROTOCOL', 'Invalid tool completion');
  const ids = new Set();
  for (const call of toolCalls) {
    if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id)
      || typeof call.function?.name !== 'string' || call.function.name.length > 128
      || typeof call.function?.arguments !== 'string' || call.function.arguments.length > 16384) {
      throw failure('MODEL_PROTOCOL', 'Invalid tool call');
    }
    ids.add(call.id);
  }
  if (!toolCalls.length && !content.trim()) throw failure('MODEL_EMPTY', 'Model returned no reply');
  return { content, toolCalls };
}

async function runAgent({ config, history, text, source, printConstraints, signal, deviceStatus, onText, onTurn, onTool }) {
  const messages = [{
    role: 'system', content: source === 'typewriter'
      ? 'You are a helpful conversational agent. Reply briefly in English plain text using printable ASCII only. Do not use Markdown. Never invent personal memories. Use get_typewriter_status only when device information is relevant.'
        + (printConstraints?.max_chars ? ` Your entire final reply must fit within ${printConstraints.max_chars} characters.` : '')
        + (printConstraints?.supports_newline ? ' Line breaks are allowed.' : ' Do not include line breaks.')
      : 'You are a helpful conversational agent. Respond in the user\'s language. Never invent personal memories. Use get_typewriter_status only when device information is relevant.',
  }, ...history, { role: 'user', content: text }];
  for (let round = 0; round <= 4; round++) {
    const result = await modelTurn(config, messages, signal, (delta, streaming) => onText(round, delta, streaming));
    onTurn(round, result.toolCalls.length > 0);
    if (!result.toolCalls.length) return { text: result.content, round };
    if (round === 4) throw failure('TOOL_LIMIT', 'Maximum tool rounds reached');
    messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      if (signal.aborted) throw signal.reason;
      const activityId = onTool('started', call);
      let result;
      try {
        const args = JSON.parse(call.function.arguments);
        if (call.function.name !== 'get_typewriter_status') throw new Error('Unknown tool');
        if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) throw new Error('Invalid tool arguments');
        result = deviceStatus();
        onTool('completed', call, activityId, result);
      } catch {
        result = { error: 'Unsupported tool or invalid arguments' };
        onTool('failed', call, activityId, result);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

module.exports = { runAgent, sseData, failure, readLimited };
