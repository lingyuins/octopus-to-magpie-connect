import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const { WebSocketServer } = await import(pathToFileURL(join(dirname(require.resolve('ws/package.json')), 'wrapper.mjs')).href);
import { connectOnce, USER_AGENT } from '../src/transport.mjs';
import { FRAME, LIMITS, PROTOCOL, encodeFrame, decodeFrame, jsonFrame } from '../src/protocol.mjs';

async function bounded(promise, label, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`test timeout: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, handler, extra = {}, raw = false) {
  const sockets = new Set();
  const local = raw ? net.createServer(handler) : http.createServer(handler);
  local.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: (protocols) => protocols.has(PROTOCOL) ? PROTOCOL : false });
  await once(cloud, 'listening');
  const controller = new AbortController();
  const states = [];
  const config = { cloudURL: `ws://127.0.0.1:${cloud.address().port}/node/v1/connect`,
    nodeToken: 'node-secret', magpieURL: `http://127.0.0.1:${local.address().port}`,
    magpieKey: 'local-secret', models: ['allowed'], allowInsecureLoopback: true, ...extra };
  const connection = once(cloud, 'connection');
  const outcome = connectOnce(config, { signal: controller.signal, onState: (state) => states.push(state) })
    .then(() => null, (error) => error);
  const [ws, upgrade] = await connection;
  const frames = [];
  ws.on('message', (data, binary) => frames.push(decodeFrame(data, binary)));
  t.after(async () => {
    controller.abort();
    ws.terminate();
    try {
      await bounded(outcome, 'connector cleanup');
    } finally {
      for (const socket of sockets) socket.destroy();
      await bounded(Promise.all([new Promise((resolve) => cloud.close(resolve)),
        new Promise((resolve) => local.close(resolve))]), 'server cleanup');
    }
  });
  async function frame(kind, id = 1n) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = frames.find((item) => item.kind === kind && item.id === id);
      if (found) return found;
      const failure = await Promise.race([outcome, delay(5, undefined)]);
      if (failure) throw failure;
    }
    throw new Error(`test frame timeout ${kind}`);
  }
  function request(id, { method = 'POST', path = '/v1/chat/completions', header = { 'Content-Type': ['application/json'] }, deadline = Date.now() + 10_000, body = '{"model":"allowed","stream":true}' } = {}) {
    ws.send(jsonFrame(FRAME.REQUEST, id, { method, path, header, deadline }));
    if (body) ws.send(encodeFrame(FRAME.REQUEST_DATA, id, Buffer.from(body)));
    ws.send(encodeFrame(FRAME.REQUEST_END, id));
  }
  await frame(FRAME.HELLO, 0n);
  return { ws, config, frames, frame, request, outcome, controller, states, upgrade };
}

function bodyFor(f, id = 1n) {
  return Buffer.concat(f.frames.filter((frame) => frame.kind === FRAME.RESPONSE_DATA && frame.id === id).map((frame) => frame.data)).toString();
}

test('real WS authentication, raw hello and incremental SSE without fetch', { timeout: 10_000 }, async (t) => {
  let received;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { headers: req.headers, body: Buffer.concat(chunks).toString(), path: req.url };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Request-Id': 'public', 'Set-Cookie': 'secret', 'X-Internal': 'secret' });
    res.write('data: first\n\n');
    await barrier;
    res.end('data: [DONE]\n\n');
  });
  assert.equal(f.upgrade.headers.authorization, 'Bearer node-secret');
  assert.equal(f.upgrade.headers['sec-websocket-protocol'], PROTOCOL);
  assert.deepEqual(JSON.parse((await f.frame(FRAME.HELLO, 0n)).data), { version: 1, max_concurrency: 4 });
  f.request(9007199254740993n, { path: '/v1/messages', body: '{"model":"forbidden","model":"allowed","nested":{"x":1,"x":2}}', header: {
    'Content-Type': ['application/json'], Authorization: ['cloud-secret'], 'X-Api-Key': ['cloud-secret'],
    Cookie: ['secret'], Host: ['evil'], 'Accept-Encoding': ['gzip'], 'Anthropic-Version': ['2023-06-01'],
  } });
  await f.frame(FRAME.RESPONSE_DATA, 9007199254740993n);
  assert.equal(f.frames.some((item) => item.kind === FRAME.COMPLETE), false);
  assert.equal(received.headers.authorization, 'Bearer local-secret');
  assert.equal(received.headers['x-api-key'], 'local-secret');
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers['accept-encoding'], undefined);
  assert.equal(received.headers['anthropic-version'], '2023-06-01');
  // No User-Agent from the cloud: the connector's fallback identifies the
  // relay to the local gateway (USER_AGENT is exported for this assertion).
  assert.equal(received.headers['user-agent'], USER_AGENT);
  assert.equal(received.body, '{"model":"allowed","nested":{"x":2}}');
  assert.equal(received.path, '/v1/messages');
  const meta = JSON.parse((await f.frame(FRAME.RESPONSE, 9007199254740993n)).data);
  assert.equal(meta.header['set-cookie'], undefined);
  assert.equal(meta.header['x-internal'], undefined);
  release();
  await f.frame(FRAME.COMPLETE, 9007199254740993n);
  assert.equal(bodyFor(f, 9007199254740993n), 'data: first\n\ndata: [DONE]\n\n');
});

test('a client User-Agent relayed by the cloud wins over the fallback', async (t) => {
  let received;
  const f = await fixture(t, async (req, res) => {
    for await (const _ of req);
    received = { headers: req.headers };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"ok"}');
  });
  f.request(1n, { header: { 'Content-Type': ['application/json'], 'User-Agent': ['claude-cli/2.1.34 (external, cli)'] } });
  await f.frame(FRAME.COMPLETE, 1n);
  assert.equal(received.headers['user-agent'], 'claude-cli/2.1.34 (external, cli)');
});

test('models contain only allowed id/object and no upstream fields or headers', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('X-Request-ID', 'hidden');
    res.end(JSON.stringify({ internal: 'secret', data: [{ id: 'allowed', object: 'private', key: 'secret', owner: 'secret' }, { id: 'other' }, null] }));
  });
  f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
  await f.frame(FRAME.COMPLETE);
  assert.deepEqual(JSON.parse(bodyFor(f)), { object: 'list', data: [{ id: 'allowed', object: 'model' }] });
  assert.deepEqual(JSON.parse((await f.frame(FRAME.RESPONSE)).data).header, { 'content-type': ['application/json'] });
});

test('unauthorized models, invalid JSON, non-JSON and GET body never execute locally', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  const requests = [
    { body: '{"model":"allowed","model":"forbidden"}' }, { body: '{"model":' }, { body: '[]' },
    { header: { 'Content-Type': ['text/plain'] } }, { method: 'GET', path: '/v1/models', body: '{}' },
  ];
  for (let index = 0; index < requests.length; index++) {
    const id = BigInt(index + 1);
    f.request(id, requests[index]);
    assert.equal((await f.frame(FRAME.ERROR, id)).data.length, 0);
  }
  assert.equal(calls, 0);
});

test('oversized model list is bounded and rejected without forwarding metadata', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(' '.repeat(LIMITS.request + 1)));
  f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
  assert.equal((await f.frame(FRAME.ERROR)).data.toString(), 'invalid_models');
  assert.equal(f.frames.some((item) => item.kind === FRAME.RESPONSE), false);
});

test('model probes classify authentication failures without disclosing their body', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(401); res.end('local-secret must not escape'); });
  f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
  assert.equal((await f.frame(FRAME.ERROR)).data.toString(), 'local_authentication');
  assert.equal(bodyFor(f), '');
});

test('model probes classify unexpected HTTP and malformed models without disclosing local content', async (t) => {
  for (const status of [403, 404, 302, 500, 600, 999]) {
    await t.test(String(status), async (t) => {
      const f = await fixture(t, (_req, res) => { res.writeHead(status); res.end('local-secret'); });
      f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
      assert.equal((await f.frame(FRAME.ERROR)).data.toString(), status === 403 ? 'local_authentication' : 'local_http');
      assert.equal(bodyFor(f), '');
    });
  }
  const f = await fixture(t, (_req, res) => res.end('{private invalid JSON'));
  f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
  assert.equal((await f.frame(FRAME.ERROR)).data.toString(), 'invalid_models');
});

test('model probe reports a closed local port without exposing connection details', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('{}'), { magpieURL: 'http://127.0.0.1:1' });
  f.request(1n, { method: 'GET', path: '/v1/models', header: {}, body: '' });
  assert.equal((await f.frame(FRAME.ERROR)).data.toString(), 'local_unavailable');
});

test('oversized upstream response headers produce a fixed empty stream error', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('X-Large', 'x'.repeat(LIMITS.metadata));
    res.end('private');
  });
  f.request(1n);
  assert.equal((await f.frame(FRAME.ERROR)).data.length, 0);
  assert.equal(f.frames.some((item) => item.kind === FRAME.RESPONSE_DATA), false);
});

test('sensitive proxy environment cannot reroute explicit local HTTP requests', async (t) => {
  const previousHTTP = process.env.HTTP_PROXY;
  const previousHTTPS = process.env.HTTPS_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  try {
    const f = await fixture(t, (_req, res) => res.end('{"ok":true}'));
    f.request(1n);
    await f.frame(FRAME.COMPLETE);
    assert.equal(bodyFor(f), '{"ok":true}');
  } finally {
    if (previousHTTP === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousHTTP;
    if (previousHTTPS === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previousHTTPS;
  }
});

test('upstream redirect is not followed and error response body is never disclosed', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.writeHead(302, { Location: 'http://127.0.0.1/secret' }); res.end('local-secret'); });
  f.request(1n);
  const frame = await f.frame(FRAME.ERROR);
  assert.equal(frame.data.length, 0);
  assert.equal(calls, 1);
  assert.equal(f.frames.some((frame) => frame.kind === FRAME.RESPONSE_DATA), false);
});

test('local 101 rejects only its request, closes the upgraded socket and releases its slot', async (t) => {
  let calls = 0;
  let healthy;
  let upgradedClosed;
  const closure = new Promise((resolve) => { upgradedClosed = resolve; });
  const f = await fixture(t, (req, res) => {
    req.resume();
    calls++;
    if (calls === 1) {
      req.socket.on('close', upgradedClosed);
      res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'private-protocol' });
      res.flushHeaders();
      res.socket.write('local-secret upgraded bytes');
    } else if (calls === 2) {
      healthy = res;
      res.writeHead(200);
      res.write('healthy concurrent stream');
    } else res.end('healthy next request');
  }, { maxConcurrency: 2 });
  f.request(1n);
  f.request(2n);
  await bounded(f.frame(FRAME.RESPONSE_DATA, 2n), 'concurrent response');
  assert.equal((await bounded(f.frame(FRAME.ERROR, 1n), '101 rejection')).data.length, 0);
  await bounded(closure, 'upgraded socket destruction');
  assert.deepEqual(f.frames.filter((frame) => frame.id === 1n).map((frame) => frame.kind), [FRAME.ERROR]);
  f.request(3n);
  await bounded(f.frame(FRAME.COMPLETE, 3n), 'released upgrade slot');
  healthy.end();
  await bounded(f.frame(FRAME.COMPLETE, 2n), 'concurrent completion');
  assert.equal(bodyFor(f, 2n), 'healthy concurrent stream');
  assert.equal(bodyFor(f, 3n), 'healthy next request');
  assert.equal(calls, 3);
  assert.deepEqual(f.states, ['connecting', 'connected']);
});

test('session stop after local 101 joins workers promptly without replay', async (t) => {
  let sent;
  let calls = 0;
  const upgrade = new Promise((resolve) => { sent = resolve; });
  const f = await fixture(t, (req, res) => {
    calls++;
    req.resume();
    res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'private-protocol' });
    res.flushHeaders();
    sent();
  });
  f.request(1n);
  await bounded(upgrade, '101 sent');
  // Let the client consume the upgrade before stopping the session.
  await delay(50);
  f.controller.abort();
  assert.equal(await bounded(f.outcome, 'stop after upgrade'), null);
  assert.deepEqual(f.states, ['connecting', 'connected', 'stopped']);
  assert.equal(calls, 1);
});

test('local 101 cannot strand a worker past its deadline or keep the request slot', async (t) => {
  let calls = 0;
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const f = await fixture(t, (req, res) => {
    req.resume();
    calls++;
    if (calls === 1) {
      req.socket.on('close', closed);
      res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'private-protocol' });
      res.flushHeaders();
    } else res.end('next');
  }, { maxConcurrency: 1 });
  f.request(1n, { deadline: Date.now() + 250 });
  assert.equal((await bounded(f.frame(FRAME.ERROR), 'upgrade before deadline')).data.length, 0);
  await bounded(closure, 'deadline upgrade socket destruction');
  await delay(300);
  assert.deepEqual(f.frames.filter((frame) => frame.id === 1n).map((frame) => frame.kind), [FRAME.ERROR]);
  f.request(2n);
  await bounded(f.frame(FRAME.COMPLETE, 2n), 'slot after upgrade deadline');
  assert.equal(bodyFor(f, 2n), 'next');
  assert.equal(calls, 2);
  f.controller.abort();
  assert.equal(await bounded(f.outcome, 'stop after upgrade deadline'), null);
});

for (const action of ['cancel', 'deadline', 'stop']) {
  test(`response-pending ${action} destroys the local socket and settles workers`, async (t) => {
    let arrived;
    let closed;
    let calls = 0;
    const arrival = new Promise((resolve) => { arrived = resolve; });
    const closure = new Promise((resolve) => { closed = resolve; });
    const f = await fixture(t, (req, res) => {
      req.resume();
      calls++;
      if (calls === 1) {
        req.socket.on('close', closed);
        arrived();
      } else res.end('next');
    }, { maxConcurrency: 1 });
    f.request(1n, { deadline: Date.now() + (action === 'deadline' ? 250 : 10_000) });
    await bounded(arrival, 'local request arrival');
    if (action === 'stop') f.controller.abort();
    else if (action === 'cancel') f.ws.send(encodeFrame(FRAME.CANCEL, 1n));
    if (action === 'stop') {
      assert.equal(await bounded(f.outcome, 'stop before response'), null);
      assert.equal(f.states.at(-1), 'stopped');
    } else {
      assert.equal((await bounded(f.frame(FRAME.ERROR), 'pending request error')).data.toString(),
        action === 'deadline' ? 'deadline' : '');
      f.request(2n);
      await bounded(f.frame(FRAME.COMPLETE, 2n), 'released pending slot');
      assert.equal(bodyFor(f, 2n), 'next');
    }
    await bounded(closure, 'pending socket destruction');
    assert.equal(calls, action === 'stop' ? 1 : 2);
    assert.equal(f.frames.some((frame) => frame.id === 1n && frame.kind !== FRAME.ERROR), false);
  });
}

test('raw TCP close before response settles just that request and permits new work', async (t) => {
  let calls = 0;
  const f = await fixture(t, (socket) => {
    socket.once('data', () => {
      calls++;
      if (calls === 1) socket.end();
      else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnext');
    });
  }, { maxConcurrency: 1 }, true);
  f.request(1n);
  assert.equal((await bounded(f.frame(FRAME.ERROR), 'response-premature close')).data.length, 0);
  assert.deepEqual(f.frames.filter((frame) => frame.id === 1n).map((frame) => frame.kind), [FRAME.ERROR]);
  f.request(2n);
  await bounded(f.frame(FRAME.COMPLETE, 2n), 'new request after premature close');
  assert.equal(bodyFor(f, 2n), 'next');
  assert.equal(calls, 2);
  assert.deepEqual(f.states, ['connecting', 'connected']);
});

for (const status of [600, 999, 200, 299, 300, 302, 399, 400, 599]) {
  test(`local HTTP ${status} stays within the response protocol and request boundary`, async (t) => {
    let calls = 0;
    let concurrent;
    const rejected = status > 599 || status >= 300 && status <= 399;
    const f = await fixture(t, (req, res) => {
      req.resume();
      calls++;
      if (calls === 1) {
        res.writeHead(status, { Location: 'http://127.0.0.1/never-follow' });
        res.end('local-secret status body');
      } else if (calls === 2) {
        concurrent = res;
        res.write('concurrent');
      } else res.end('next');
    }, { maxConcurrency: 2 });
    f.request(1n);
    f.request(2n);
    await bounded(f.frame(FRAME.RESPONSE_DATA, 2n), 'other concurrent request');
    if (rejected) {
      assert.equal((await bounded(f.frame(FRAME.ERROR), `HTTP ${status} rejection`)).data.length, 0);
      assert.deepEqual(f.frames.filter((frame) => frame.id === 1n).map((frame) => frame.kind), [FRAME.ERROR]);
      assert.equal(bodyFor(f), '');
    } else {
      await bounded(f.frame(FRAME.COMPLETE), `HTTP ${status} completion`);
      assert.equal(JSON.parse((await f.frame(FRAME.RESPONSE)).data).status, status);
      assert.equal(bodyFor(f), 'local-secret status body');
    }
    f.request(3n);
    await bounded(f.frame(FRAME.COMPLETE, 3n), 'new work after status response');
    concurrent.end();
    await bounded(f.frame(FRAME.COMPLETE, 2n), 'concurrent status completion');
    assert.equal(calls, 3);
    assert.equal(bodyFor(f, 3n), 'next');
    assert.deepEqual(f.states, ['connecting', 'connected']);
    assert.ok(f.frames.filter((frame) => frame.kind === FRAME.RESPONSE).every((frame) => {
      const { status } = JSON.parse(frame.data);
      return Number.isInteger(status) && status >= 200 && status <= 599;
    }));
  });
}

test('concurrency and pending deadlines release bounded request slots', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('{}'); }, { maxConcurrency: 1 });
  f.ws.send(jsonFrame(FRAME.REQUEST, 1n, { method: 'POST', path: '/v1/messages', header: {}, deadline: Date.now() + 100 }));
  f.request(2n);
  await f.frame(FRAME.ERROR, 2n);
  assert.equal((await f.frame(FRAME.ERROR, 1n)).data.toString(), 'deadline');
  f.request(3n);
  await f.frame(FRAME.COMPLETE, 3n);
  assert.equal(calls, 1);
});

test('cancellation aborts in-flight local SSE and never replays', async (t) => {
  let calls = 0;
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: started\n\n');
    res.on('close', closed);
  });
  f.request(1n);
  await f.frame(FRAME.RESPONSE_DATA);
  f.ws.send(encodeFrame(FRAME.CANCEL, 1n));
  await closure;
  await f.frame(FRAME.ERROR);
  f.ws.terminate();
  await f.outcome;
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(f.frames.some((item) => item.kind === FRAME.COMPLETE), false);
});

test('timeout aborts local stream and reports only deadline', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('start'); });
  f.request(1n, { deadline: Date.now() + 100 });
  assert.equal((await f.frame(FRAME.ERROR)).data.toString(), 'deadline');
});

test('session abort destroys active workers and reports stopped', async (t) => {
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200); res.write('first'); res.on('close', closed);
  });
  f.request(1n);
  await f.frame(FRAME.RESPONSE_DATA);
  f.controller.abort();
  assert.equal(await f.outcome, null);
  await closure;
  assert.deepEqual(f.states, ['connecting', 'connected', 'stopped']);
});

test('strictly increasing uint64 request IDs prevent replay after completion', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  f.request(1n);
  await f.frame(FRAME.COMPLETE);
  f.request(1n);
  assert.equal((await f.outcome).message, 'connector protocol failed');
  assert.equal(calls, 1);
});

for (const [name, send] of [
  ['unknown kind', (ws) => ws.send(Buffer.from([42, 0, 0, 0, 0, 0, 0, 0, 1]))],
  ['zero ID', (ws) => ws.send(encodeFrame(FRAME.CANCEL, 0n))],
  ['unknown future ID', (ws) => ws.send(encodeFrame(FRAME.REQUEST_END, 1n))],
  ['text', (ws) => ws.send('secret malformed')],
  ['short frame', (ws) => ws.send(Buffer.alloc(8))],
  ['invalid path', (ws) => ws.send(jsonFrame(FRAME.REQUEST, 1n, { method: 'POST', path: '/v1/../secret', header: {} }))],
  ['nonempty cancel', (ws) => ws.send(encodeFrame(FRAME.CANCEL, 1n, Buffer.from('secret')))],
  ['oversized metadata', (ws) => ws.send(encodeFrame(FRAME.REQUEST, 1n, Buffer.alloc(LIMITS.metadata + 1)))],
]) {
  test(`malformed ${name} closes session with fixed diagnostics`, async (t) => {
    const f = await fixture(t, (_req, res) => res.end('{}'));
    send(f.ws);
    assert.equal((await f.outcome).message, 'connector protocol failed');
    assert.equal(f.states.at(-1), 'disconnected');
  });
}

test('duplicate request end while local request runs is a protocol failure', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('first'); });
  f.request(1n);
  await f.frame(FRAME.RESPONSE_DATA);
  f.ws.send(encodeFrame(FRAME.REQUEST_END, 1n));
  assert.equal((await f.outcome).message, 'connector protocol failed');
});

test('SSE response chunks never exceed 32KiB', async (t) => {
  const expected = 'x'.repeat(200_000);
  const f = await fixture(t, (_req, res) => res.end(expected));
  f.request(1n);
  await f.frame(FRAME.COMPLETE);
  assert.equal(bodyFor(f), expected);
  assert.ok(f.frames.filter((item) => item.kind === FRAME.RESPONSE_DATA).every((item) => item.data.length <= LIMITS.chunk));
});

test('WebSocket ping receives manual prioritized pong', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('{}'));
  const pong = once(f.ws, 'pong');
  f.ws.ping('test-ping');
  assert.equal((await pong)[0].toString(), 'test-ping');
});

test('4MiB upload limit disconnects before any local execution', async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('{}'); });
  f.ws.send(jsonFrame(FRAME.REQUEST, 1n, { method: 'POST', path: '/v1/messages', header: {}, deadline: Date.now() + 10_000 }));
  for (let index = 0; index < 129; index++) f.ws.send(encodeFrame(FRAME.REQUEST_DATA, 1n, Buffer.alloc(LIMITS.chunk)));
  assert.equal((await f.outcome).message, 'connector protocol failed');
  assert.equal(calls, 0);
});

test('tiny upload chunks preserve exact JSON body without unbounded chunk objects', async (t) => {
  let actual;
  const f = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    actual = Buffer.concat(chunks).toString();
    res.end('{}');
  });
  const body = JSON.stringify({ model: 'allowed', text: 'a'.repeat(35_000) });
  f.ws.send(jsonFrame(FRAME.REQUEST, 1n, { method: 'POST', path: '/v1/messages', header: { 'Content-Type': ['application/json; charset=utf-8'] }, deadline: Date.now() + 10_000 }));
  for (let index = 0; index < body.length; index++) f.ws.send(encodeFrame(FRAME.REQUEST_DATA, 1n, Buffer.from(body[index])));
  f.ws.send(encodeFrame(FRAME.REQUEST_END, 1n));
  await f.frame(FRAME.COMPLETE);
  assert.equal(actual, body);
});

test('disconnect during local execution aborts work with no automatic reconnect', async (t) => {
  let calls = 0;
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(200); res.write('first'); res.on('close', closed);
  });
  f.request(1n);
  await f.frame(FRAME.RESPONSE_DATA);
  f.ws.terminate();
  await f.outcome;
  await closure;
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(f.states.at(-1), 'disconnected');
});

test('blocked cloud socket hits fixed write timeout and releases local worker', { timeout: 20_000 }, async (t) => {
  let produced = 0;
  let closed;
  const closure = new Promise((resolve) => { closed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    let ended = false;
    const fill = () => {
      while (!ended && produced < 128 * 1024 * 1024) {
        produced += LIMITS.chunk;
        if (!res.write(Buffer.alloc(LIMITS.chunk))) return;
      }
      if (!ended) res.end();
    };
    res.on('drain', fill);
    res.on('close', () => { ended = true; closed(); });
    fill();
  });
  f.ws._socket.pause();
  f.request(1n, { deadline: Date.now() + 30_000 });
  const error = await f.outcome;
  assert.equal(error.message, 'connector write timeout');
  await closure;
  assert.ok(produced < 128 * 1024 * 1024);
});

test('slow cloud consumer bounds local read-ahead and session abort settles workers', { timeout: 10_000 }, async (t) => {
  let produced = 0;
  let localClosed;
  const closure = new Promise((resolve) => { localClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let ended = false;
    const fill = () => {
      while (!ended && produced < 128 * 1024 * 1024) {
        produced += LIMITS.chunk;
        if (!res.write(Buffer.alloc(LIMITS.chunk, 120))) return;
      }
      if (!ended) res.end();
    };
    res.on('drain', fill);
    res.on('close', () => { ended = true; localClosed(); });
    fill();
  });
  f.ws._socket.pause();
  f.request(1n);
  await delay(200);
  assert.ok(produced > 0);
  assert.ok(produced < 128 * 1024 * 1024, `local read-ahead remained bounded: ${produced}`);
  f.controller.abort();
  await f.outcome;
  await closure;
});
