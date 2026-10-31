import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeConfig } from './config.mjs';
import {
  PROTOCOL, FRAME, LIMITS, encodeFrame, decodeFrame, jsonFrame, parseJSON,
  requestMetadata, boundedHeaders, filterHeaders, protocolError,
} from './protocol.mjs';

// Bun aliases the bare "ws" specifier to a different implementation. Resolve
// the installed package metadata, then load its real entry for identical wire,
// TLS, authentication and backpressure behavior under both runtimes.
const require = createRequire(import.meta.url);
const { default: WebSocket } = await import(pathToFileURL(join(dirname(require.resolve('ws/package.json')), 'wrapper.mjs')).href);

// Identify ourselves to the magpie gateway when a request carries no
// User-Agent: the gateway attributes each request to the first word of the
// User-Agent, so its usage pages show the connector's name and version
// instead of a generic label.
export const USER_AGENT = `octopus-ly-connector:v${require('../package.json').version}`;

const stoppedError = () => new Error('connector stopped');
const localError = () => new Error('connector local request failed');
const diagnosticError = (code) => Object.assign(localError(), { diagnosticCode: code });
const diagnosticCodes = new Set(['local_unavailable', 'local_authentication', 'local_http', 'invalid_models']);

// Only one socket write is in flight. Each producer awaits its write, bounding
// retained response data independently of how fast the local model produces it.
class Writer {
  constructor(ws, fail) {
    this.ws = ws;
    this.fail = fail;
    this.data = [];
    this.control = [];
    this.current = null;
    this.closed = false;
  }
  send(buffer, { control = false, signal, opcode = 'binary' } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(stoppedError());
    const queue = control ? this.control : this.data;
    if (queue.length >= LIMITS.queue) {
      this.fail(new Error('connector writer saturated'));
      return Promise.reject(stoppedError());
    }
    return new Promise((resolve, reject) => {
      queue.push({ buffer, signal, opcode, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.current || this.closed) return;
    const item = this.control.shift() ?? this.data.shift();
    if (!item) return;
    if (item.signal?.aborted) {
      item.reject(stoppedError());
      this.pump();
      return;
    }
    this.current = item;
    item.timer = setTimeout(() => this.fail(new Error('connector write timeout')), LIMITS.writeTimeout);
    const done = (error) => {
      if (this.current !== item) return;
      if (!error && this.ws.bufferedAmount > 0) {
        // Bun's ws compatibility callback can acknowledge enqueueing before
        // the socket drains; do not let it bypass the bounded writer.
        item.drain = setTimeout(() => done(), 5);
        return;
      }
      clearTimeout(item.timer);
      clearTimeout(item.drain);
      this.current = null;
      if (error) {
        item.reject(stoppedError());
        this.fail(new Error('connector write failed'));
      } else {
        item.resolve();
        this.pump();
      }
    };
    try {
      if (item.opcode === 'pong') this.ws.pong(item.buffer, true, done);
      else if (item.opcode === 'ping') this.ws.ping(item.buffer, true, done);
      else this.ws.send(item.buffer, { binary: true, compress: false }, done);
    } catch { done(stoppedError()); }
  }
  close() {
    this.closed = true;
    const items = [...this.control, ...this.data];
    if (this.current) items.push(this.current);
    this.control.length = this.data.length = 0;
    this.current = null;
    for (const item of items) {
      clearTimeout(item.timer);
      clearTimeout(item.drain);
      item.reject(stoppedError());
    }
  }
}

function responseHeaders(response) {
  const headers = Object.create(null);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index].toLowerCase();
    (headers[name] ??= []).push(response.rawHeaders[index + 1]);
  }
  if (!boundedHeaders(headers)) throw localError();
  return headers;
}

function localRequest(config, agent, meta, body, signal) {
  const headers = filterHeaders(meta.header);
  headers.authorization = `Bearer ${config.magpieKey}`;
  // The real client's User-Agent wins when the cloud relayed it; otherwise the
  // gateway would see no UA and attribute the request to a generic label.
  if (!headers['user-agent']) headers['user-agent'] = USER_AGENT;
  if (meta.path === '/v1/messages') headers['x-api-key'] = config.magpieKey;
  if (meta.method === 'POST') headers['content-length'] = String(body.length);
  const local = new URL(config.magpieURL);
  return new Promise((resolve, reject) => {
    // Use a fixed literal address, never fetch, proxy discovery, redirects, or
    // hooks installed by the host's external model providers.
    const request = http.request({
      protocol: 'http:', hostname: local.hostname.replace(/^\[|\]$/g, ''),
      port: local.port || 80, path: meta.path, method: meta.method,
      agent, headers, signal, maxHeaderSize: LIMITS.metadata,
      insecureHTTPParser: false,
    });
    let settled = false;
    const settle = (error, response) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      request.removeListener('response', onResponse);
      request.removeListener('upgrade', onUpgrade);
      if (error) reject(error);
      else resolve(response);
    };
    const onResponse = (response) => {
      // Keep a listener until destruction even if cancellation follows headers.
      response.on('error', () => {});
      settle(null, response);
    };
    const onError = () => settle(diagnosticError('local_unavailable'));
    const onAbort = () => {
      request.destroy();
      settle(stoppedError());
    };
    const onUpgrade = (response, socket) => {
      // An upgraded socket no longer belongs to the HTTP agent or its signal.
      socket.destroy();
      response.destroy();
      request.destroy();
      settle(localError());
    };
    request.on('response', onResponse);
    request.on('upgrade', onUpgrade);
    // Retain the error guard after settlement: destroy/abort may emit it later.
    request.on('error', onError);
    request.once('close', () => {
      settle(diagnosticError('local_unavailable'));
      request.removeListener('error', onError);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else request.end(body);
  });
}

async function readModels(response, models) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > LIMITS.request) throw diagnosticError('invalid_models');
    chunks.push(chunk);
  }
  let list;
  try { list = parseJSON(Buffer.concat(chunks, size)); } catch { throw diagnosticError('invalid_models'); }
  if (!list || typeof list !== 'object' || Array.isArray(list) || !Array.isArray(list.data) ||
      list.data.some((item) => item && typeof item.id !== 'string')) throw diagnosticError('invalid_models');
  const data = (list.data ?? []).filter((item) => item && typeof item === 'object' &&
    typeof item.id === 'string' && models.has(item.id)).map((item) => ({ id: item.id, object: 'model' }));
  return Buffer.from(JSON.stringify({ object: 'list', data }));
}

async function execute(session, id, pending) {
  const { config, writer, agent, models } = session;
  const { meta, controller } = pending;
  let response;
  try {
    let body = Buffer.concat(pending.chunks, pending.size);
    pending.chunks = [];
    if (meta.method === 'GET') {
      if (body.length) throw localError();
    } else {
      const headers = filterHeaders(meta.header);
      const contentType = headers['content-type']?.[0] ?? '';
      if (!/^application\/json(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\\r\n]|\\[^\r\n])*"))*\s*$/i.test(contentType)) throw localError();
      const object = parseJSON(body);
      if (!object || typeof object !== 'object' || Array.isArray(object) ||
          typeof object.model !== 'string' || !models.has(object.model)) throw localError();
      // Canonicalize all duplicate JSON keys, including nested objects, before
      // the local decoder can choose a different model or payload interpretation.
      body = Buffer.from(JSON.stringify(object));
    }
    if (controller.signal.aborted) throw stoppedError();
    response = await localRequest(config, agent, meta, body, controller.signal);
    if (meta.method === 'GET' && response.statusCode !== 200) {
      throw diagnosticError([401, 403].includes(response.statusCode) ? 'local_authentication' : 'local_http');
    }
    if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode > 599 ||
        response.statusCode >= 300 && response.statusCode <= 399) throw localError();
    let headers = responseHeaders(response);
    let modelBody;
    if (meta.method === 'GET') {
      modelBody = await readModels(response, models);
      headers = { 'content-type': ['application/json'] };
    }
    await writer.send(jsonFrame(FRAME.RESPONSE, id, {
      status: response.statusCode, header: filterHeaders(headers, true),
    }), { signal: controller.signal });
    const source = modelBody ? [modelBody] : response;
    for await (const chunk of source) {
      for (let offset = 0; offset < chunk.length; offset += LIMITS.chunk) {
        await writer.send(encodeFrame(FRAME.RESPONSE_DATA, id, chunk.subarray(offset, offset + LIMITS.chunk)),
          { signal: controller.signal });
      }
    }
    await writer.send(encodeFrame(FRAME.COMPLETE, id), { signal: controller.signal });
  } catch (error) {
    const code = meta.method === 'GET' && diagnosticCodes.has(error?.diagnosticCode) ? error.diagnosticCode : '';
    if (!session.closed) await session.error(id, pending.expired, code).catch(() => {});
  } finally {
    clearTimeout(pending.timer);
    controller.abort();
    response?.destroy();
    if (session.requests.get(id) === pending) session.requests.delete(id);
  }
}

class Session {
  constructor(config, ws, fail) {
    this.config = config;
    this.writer = new Writer(ws, fail);
    this.models = new Set(config.models);
    this.requests = new Map();
    this.workers = new Set();
    this.lastID = 0n;
    this.closed = false;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: config.maxConcurrency,
      maxFreeSockets: config.maxConcurrency, maxTotalSockets: config.maxConcurrency });
    this.fail = fail;
  }
  error(id, deadline = false, code = '') {
    return this.writer.send(encodeFrame(FRAME.ERROR, id, Buffer.from(deadline ? 'deadline' : code)),
      { control: true });
  }
  reject(id) {
    this.error(id).catch(() => { if (!this.closed) this.fail(new Error('connector write failed')); });
  }
  receive(data, isBinary) {
    const frame = decodeFrame(data, isBinary);
    const { kind, id } = frame;
    if (id === 0n) throw protocolError();
    const pending = this.requests.get(id);
    if (kind === FRAME.REQUEST) {
      if (id <= this.lastID) throw protocolError();
      this.lastID = id;
      const meta = requestMetadata(frame.data);
      if (this.requests.size >= this.config.maxConcurrency) { this.reject(id); return; }
      const deadline = Math.min(Date.now() + this.config.requestTimeoutSeconds * 1000, meta.deadline);
      if (deadline <= Date.now()) { this.reject(id); return; }
      const request = { meta, chunks: [], size: 0, started: false, expired: false, controller: new AbortController() };
      request.timer = setTimeout(() => {
        request.expired = true;
        request.controller.abort();
        if (!request.started && this.requests.get(id) === request) {
          this.requests.delete(id);
          this.error(id, true).catch(() => {});
        }
      }, Math.max(1, deadline - Date.now()));
      this.requests.set(id, request);
      return;
    }
    if (![FRAME.REQUEST_DATA, FRAME.REQUEST_END, FRAME.CANCEL].includes(kind) || id > this.lastID) throw protocolError();
    if (kind === FRAME.CANCEL) {
      if (frame.data.length) throw protocolError();
      if (pending) {
        pending.controller.abort();
        if (!pending.started) {
          clearTimeout(pending.timer);
          this.requests.delete(id);
        }
      }
      return;
    }
    // Late upload frames can already be in flight after a rejection/cancel.
    if (!pending) return;
    if (pending.started) throw protocolError();
    if (kind === FRAME.REQUEST_DATA) {
      if (pending.size + frame.data.length > LIMITS.request) throw protocolError();
      // Fixed slabs bound object overhead even for millions of one-byte frames,
      // without repeatedly copying the already accumulated request body.
      let offset = 0;
      while (offset < frame.data.length) {
        const position = pending.size % LIMITS.chunk;
        if (position === 0) pending.chunks.push(Buffer.allocUnsafe(LIMITS.chunk));
        const count = Math.min(LIMITS.chunk - position, frame.data.length - offset);
        frame.data.copy(pending.chunks.at(-1), position, offset, offset + count);
        pending.size += count;
        offset += count;
      }
    } else {
      if (frame.data.length) throw protocolError();
      pending.started = true;
      const worker = execute(this, id, pending);
      this.workers.add(worker);
      worker.finally(() => this.workers.delete(worker));
    }
  }
  async close() {
    this.closed = true;
    this.writer.close();
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    this.agent.destroy();
    await Promise.allSettled([...this.workers]);
    this.requests.clear();
  }
}

/** One authenticated session only. The caller owns reconnect policy, never work replay. */
export async function connectOnce(input, { signal, onState } = {}) {
  const config = normalizeConfig(input);
  const state = (value) => { try { onState?.(value); } catch { /* Diagnostics cannot own session lifetime. */ } };
  if (signal?.aborted) { state('stopped'); return; }
  state('connecting');
  const cloud = new URL(config.cloudURL);
  const agent = cloud.protocol === 'wss:'
    ? new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: true, maxSockets: 1 })
    : new http.Agent({ maxSockets: 1 });
  let ws, session, heartbeat, pongTimer, nonce, failure;
  let opened = false;
  let ended = false;
  let endState = 'handshake_failed';
  let finish;
  const endedPromise = new Promise((resolve) => { finish = resolve; });
  const stop = (error) => {
    if (ended) return;
    ended = true;
    failure = error;
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    ws?.terminate();
    finish();
  };
  const abort = () => stop();
  try {
    ws = new WebSocket(config.cloudURL, PROTOCOL, {
      headers: { Authorization: `Bearer ${config.nodeToken}` }, agent,
      followRedirects: false, handshakeTimeout: LIMITS.handshakeTimeout,
      maxPayload: LIMITS.chunk + 9, maxHeaderSize: LIMITS.metadata,
      perMessageDeflate: false, autoPong: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    });
    ws.on('error', () => stop(new Error(opened ? 'connector connection failed' : 'connector cloud handshake failed')));
    ws.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) endState = 'authentication_failed';
      response.destroy();
      stop(new Error('connector cloud handshake failed'));
    });
    ws.on('close', () => stop());
    ws.on('open', () => {
      if (ended) return;
      if (ws.protocol !== PROTOCOL) { stop(protocolError()); return; }
      opened = true;
      endState = 'disconnected';
      session = new Session(config, ws, stop);
      session.writer.send(jsonFrame(FRAME.HELLO, 0n, { version: 1, max_concurrency: config.maxConcurrency }),
        { control: true }).catch(() => stop(new Error('connector write failed')));
      state('connected');
      heartbeat = setInterval(() => {
        nonce = randomBytes(8);
        pongTimer = setTimeout(() => stop(new Error('connector heartbeat failed')), LIMITS.pongTimeout);
        session.writer.send(nonce, { control: true, opcode: 'ping' })
          .catch(() => stop(new Error('connector heartbeat failed')));
      }, LIMITS.pingInterval);
    });
    ws.on('ping', (data) => {
      session?.writer.send(data, { control: true, opcode: 'pong' }).catch(() => stop(new Error('connector write failed')));
    });
    ws.on('pong', (data) => {
      if (nonce?.equals(data)) { clearTimeout(pongTimer); nonce = undefined; }
    });
    ws.on('message', (data, binary) => {
      if (ended) return;
      try { if (!session) throw protocolError(); session.receive(data, binary); }
      catch { stop(protocolError()); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) stop();
    await endedPromise;
  } catch {
    stop(new Error('connector cloud handshake failed'));
  } finally {
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    signal?.removeEventListener('abort', abort);
    ws?.terminate();
    await session?.close();
    agent.destroy();
    state(signal?.aborted ? 'stopped' : endState);
  }
  if (failure && !signal?.aborted) throw failure;
}
