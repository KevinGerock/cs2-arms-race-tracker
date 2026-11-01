'use strict';
const fs = require('node:fs');

// Only connection state lines are interpreted. Chat and other console text
// are neither exported nor copied into the counter's files.
function connectionFromLine(line) {
  line = line.replace(/^\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, '');
  // CS2 retains the remote connection across a server map rotation. This
  // client job is also sufficient when the original connect is outside the
  // startup log window. Ordinary P2P/Steam messages are not game connections.
  if (/^\s*\[Client\]\s+CL:\s+CCreateGameClientJob creating client connection to 'HSR_GAME_REMOTE_CHANGELEVEL_RECONNECT'\s*$/.test(line)) {
    return { type: 'online', signal: 'client_remote_changelevel' };
  }
  const connected = line.match(/^\s*\[Client\]\s+CL:\s+Connected to '([^']+)'/);
  if (connected) {
    const local = /^(?:loopback|localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(connected[1]);
    return { type: local ? 'local_practice' : 'online', signal: local ? 'client_connected_loopback' : 'client_connected_remote' };
  }
  if (/^\s*\[Client\]\s+Disconnecting from server:/.test(line) &&
      !/Disconnecting from server:\s*(?:changelevel|NETWORK_DISCONNECT_LOOPDEACTIVATE)\s*$/.test(line)) {
    return { type: 'unknown', signal: 'client_disconnected' };
  }
  if (/^\s*(?:\[[\d:. -]+\]\s*)?\[HostStateManager\]\s+HostStateRequest::Start\(HSR_IDLE\):/.test(line)) {
    return { type: 'unknown', signal: 'host_idle' };
  }
  if (!/^\s*(?:\[[\d:. -]+\]\s*)?\[HostStateManager\]\s+HostStateRequest::Start\(HSR_GAME\):/.test(line)) return null;
  if (/loop\(remoteconnect\)/.test(line)) {
    return { type: 'online', signal: 'host_remoteconnect' };
  }
  if (/loop\(levelload\)/.test(line)) {
    if (/desc\(Server Changelevel\)\s*$/.test(line)) {
      return { type: 'inherit', signal: 'host_server_changelevel' };
    }
    // "levelload" describes loading, not whether the server is local.
    // Only an actual loopback connection proves a local practice game.
    return { type: 'unknown', signal: 'host_level_load' };
  }
  return { type: 'unknown', signal: 'unrecognized_host_connection' };
}

class ConnectionLog {
  constructor(filename) {
    this.filename = filename;
    this.position = 0;
    this.partial = '';
    this.sequence = 0;
    this.context = { type: 'unknown', signal: 'waiting_for_connection_log', sequence: 0 };
  }

  feed(text) {
    const lines = (this.partial + text).split(/\r?\n/);
    this.partial = lines.pop();
    if (this.partial.length > 65536) this.partial = '';
    for (const line of lines) {
      let connection = connectionFromLine(line);
      if (connection) {
        if (connection.type === 'inherit') connection = { ...connection, type: this.context.type };
        if (connection.type !== this.context.type || connection.signal.startsWith('host_')) this.sequence++;
        this.context = { ...connection, sequence: this.sequence };
      }
    }
    return this.context;
  }

  read() {
    if (!this.filename || !fs.existsSync(this.filename)) {
      this.context = { type: 'unknown', signal: 'connection_log_missing', sequence: this.sequence };
      return this.context;
    }
    try {
      const stat = fs.statSync(this.filename);
      if (stat.size < this.position) {
        this.position = 0;
        this.partial = '';
        this.context = { type: 'unknown', signal: 'connection_log_restarted', sequence: ++this.sequence };
      }
      // On initial startup reconstruct the most recent connection from at
      // most 2 MiB, then read only new bytes on subsequent calls.
      if (this.position === 0 && stat.size > 2 * 1024 * 1024) {
        this.position = stat.size - 2 * 1024 * 1024;
      }
      const size = Math.min(stat.size - this.position, 2 * 1024 * 1024);
      if (size > 0) {
        const descriptor = fs.openSync(this.filename, 'r');
        try {
          const buffer = Buffer.alloc(size);
          const bytes = fs.readSync(descriptor, buffer, 0, size, this.position);
          this.position += bytes;
          this.feed(buffer.subarray(0, bytes).toString('utf8'));
        } finally { fs.closeSync(descriptor); }
      }
      if (this.position < stat.size) return { type: 'unknown', signal: 'reading_connection_log', sequence: this.sequence };
      return this.context;
    } catch {
      return { type: 'unknown', signal: 'connection_log_unreadable', sequence: this.sequence };
    }
  }
}

module.exports = { ConnectionLog, connectionFromLine };
