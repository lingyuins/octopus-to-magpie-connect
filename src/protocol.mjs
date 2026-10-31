export const PROTOCOL = 'octopus-node-v1';
export const FRAME = Object.freeze({
  HELLO: 1, REQUEST: 2, REQUEST_DATA: 3, REQUEST_END: 4,
  RESPONSE: 5, RESPONSE_DATA: 6, COMPLETE: 7, ERROR: 8, CANCEL: 9,
});
export const LIMITS = Object.freeze({
  chunk: 32 * 1024, metadata: 16 * 1024, request: 4 * 1024 * 1024,
  streams: 32, queue: 64, writeTimeout: 10_000, handshakeTimeout: 15_000,
  pingInterval: 20_000, pongTimeout: 10_000,
});
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const protocolError = () => new Error('connector protocol failed');

export function encodeFrame(kind, id, data = Buffer.alloc(0)) {
  if (!Number.isInteger(kind) || kind < 1 || kind > 9 || typeof id !== 'bigint' ||
      id < 0n || id > 0xffffffffffffffffn || !(data instanceof Uint8Array) || data.length > LIMITS.chunk) {
    throw protocolError();
  }
  const frame = Buffer.allocUnsafe(9 + data.length);
  frame[0] = kind;
  frame.writeBigUInt64BE(id, 1);
  frame.set(data, 9);
  return frame;
}

export function decodeFrame(data, isBinary = true) {
  if (!isBinary || !(data instanceof Uint8Array) || data.length < 9 || data.length > LIMITS.chunk + 9) {
    throw protocolError();
  }
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const kind = buffer[0];
  if (kind < 1 || kind > 9) throw protocolError();
  return { kind, id: buffer.readBigUInt64BE(1), data: buffer.subarray(9) };
}

export function jsonFrame(kind, id, value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > LIMITS.metadata) throw protocolError();
  return encodeFrame(kind, id, data);
}

export function parseJSON(data) {
  try { return JSON.parse(utf8.decode(data)); } catch { throw protocolError(); }
}

export function allowedTarget(method, path) {
  return (method === 'GET' && path === '/v1/models') ||
    (method === 'POST' && ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/embeddings'].includes(path));
}

export function boundedHeaders(header) {
  if (header === null || header === undefined) return true;
  if (typeof header !== 'object' || Array.isArray(header)) return false;
  if (Buffer.byteLength(JSON.stringify(header)) > LIMITS.metadata) return false;
  return Object.entries(header).every(([name, values]) =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && Array.isArray(values) &&
    values.every((value) => typeof value === 'string' && !/[\r\n\u0000]/u.test(value)));
}

export function filterHeaders(header, response = false) {
  const allowed = new Set(response
    ? ['content-type', 'cache-control', 'retry-after', 'request-id', 'x-request-id']
    // user-agent passes through so the gateway can attribute the request to
    // the real client; the transport fills a fallback when the cloud drops it.
    : ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent']);
  const result = Object.create(null);
  for (const [key, values] of Object.entries(header ?? {})) {
    const name = key.toLowerCase();
    if (allowed.has(name)) result[name] = [...(result[name] ?? []), ...values];
  }
  return result;
}

export function requestMetadata(data) {
  if (data.length > LIMITS.metadata) throw protocolError();
  const meta = parseJSON(data);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) ||
      !allowedTarget(meta.method, meta.path) || !boundedHeaders(meta.header) ||
      (meta.deadline !== undefined && !Number.isSafeInteger(meta.deadline))) throw protocolError();
  return { ...meta, header: meta.header ?? {}, deadline: meta.deadline ?? 0 };
}
