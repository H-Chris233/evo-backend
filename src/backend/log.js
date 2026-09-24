'use strict';

// Log identifiers and measurements, never credentials, prompts or conversation bodies.
function log(event, fields = {}, level = 'info') {
  const json = JSON.stringify(fields, (key, value) => /token|password|secret|api.?key|authorization|^(text|content|reasoning_content|body|audio|messages|prompt)$/i.test(key) ? '[redacted]' : value);
  console[level](`${new Date().toISOString()} [backend.${event}] ${json}`);
}

function errorInfo(error) {
  return { error_code: error?.code || error?.name || 'Error', cause_code: error?.cause?.code,
    location: error?.stack?.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 3).join(' | ') };
}

module.exports = { log, errorInfo };
