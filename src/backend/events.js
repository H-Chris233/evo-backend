'use strict';

const { randomUUID } = require('node:crypto');
const { log } = require('./log');

class Events {
  constructor() {
    this.channels = new Map();
  }

  channel(key) {
    if (!this.channels.has(key)) this.channels.set(key, { sequence: 0, history: [], clients: new Set() });
    return this.channels.get(key);
  }

  publish(key, type, data, ids = {}) {
    const channel = this.channel(key);
    const event = {
      event_id: randomUUID(), sequence: ++channel.sequence, type,
      ...ids, timestamp: new Date().toISOString(), data,
    };
    const wire = this.wire(event);
    channel.history.push({ event, wire });
    // ponytail: bounded in-memory replay; snapshots cover older events and restarts.
    if (channel.history.length > 256) channel.history.shift();
    for (const client of channel.clients) this.write(client, wire);
    return event;
  }

  wire(event) {
    return `id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  write(res, wire) {
    if (res.destroyed) return;
    if (res.writableLength > 1024 * 1024) return res.destroy();
    res.write(wire);
  }

  subscribe(key, res, lastId, snapshot, ids) {
    const channel = this.channel(key);
    if (channel.clients.size >= 8) throw Object.assign(new Error('Too many event connections'), { status: 429, code: 'TOO_MANY_CONNECTIONS' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const index = lastId ? channel.history.findIndex(x => x.event.event_id === lastId) : -1;
    log('sse.connected', { channel: key, replay: index >= 0 });
    if (index >= 0) {
      for (const item of channel.history.slice(index + 1)) this.write(res, item.wire);
    } else {
      this.write(res, this.wire({
        event_id: randomUUID(), sequence: channel.sequence, type: 'snapshot',
        ...ids, timestamp: new Date().toISOString(), data: snapshot,
      }));
    }
    channel.clients.add(res);
    const timer = setInterval(() => this.write(res, ': heartbeat\n\n'), 15000);
    timer.unref();
    res.on('close', () => { clearInterval(timer); channel.clients.delete(res); log('sse.disconnected', { channel: key }); });
  }

  close() {
    for (const channel of this.channels.values()) for (const client of channel.clients) client.end();
  }
}

module.exports = { Events };
