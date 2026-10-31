import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

export function leasePort(identity) {
  return 32000 + createHash('sha256').update(identity).digest().readUInt32BE(0) % 28000;
}

// The OS owns the exclusive listener, not a stale lock file. A collision fails
// closed; no PID probing, timestamps, lock stealing, or HTTP management surface.
export async function acquireLease(identity, settings = {}) {
  if (Array.isArray(identity)) {
    const leases = [];
    const lost = new AbortController();
    try {
      for (const port of [...new Set(identity.map(leasePort))].sort((a, b) => a - b)) {
        const lease = await acquireLease('', { port });
        if (!lease) { await Promise.all(leases.map((held) => held.release())); return null; }
        leases.push(lease);
        lease.signal.addEventListener('abort', () => lost.abort(), { once: true });
      }
    } catch (error) { await Promise.all(leases.map((held) => held.release())); throw error; }
    return Object.freeze({
      signal: lost.signal,
      owns: () => !lost.signal.aborted && leases.every((lease) => lease.owns()),
      release: () => Promise.all(leases.map((lease) => lease.release())),
    });
  }
  const { port = leasePort(identity) } = settings;
  const lost = new AbortController();
  const server = createServer((socket) => socket.destroy());
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let releasing = false;
  server.on('close', () => { if (!releasing) lost.abort(); });
  const acquired = await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(new Error('lease_failed'));
    };
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', onError);
      resolve(true);
    });
  });
  if (!acquired) return null;
  server.on('error', () => lost.abort());
  let closing;
  return Object.freeze({
    signal: lost.signal,
    port: server.address().port,
    owns: () => !releasing && !lost.signal.aborted && server.listening,
    release() {
      if (!closing) {
        releasing = true;
        for (const socket of sockets) socket.destroy();
        closing = new Promise((resolve) => server.close(resolve));
      }
      return closing;
    },
  });
}
