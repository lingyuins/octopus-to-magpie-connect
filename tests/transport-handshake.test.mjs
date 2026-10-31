import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const { WebSocketServer } = await import(pathToFileURL(join(dirname(require.resolve('ws/package.json')), 'wrapper.mjs')).href);
import { connectOnce } from '../src/transport.mjs';

const config = (cloudURL) => ({ cloudURL, nodeToken: 'node-secret', magpieKey: 'local-secret', models: ['allowed'], allowInsecureLoopback: true });

for (const status of [401, 403, 302, 500]) {
  test(`HTTP ${status} handshake has fixed classification and never follows redirects`, async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls++;
      res.writeHead(status, { Location: '/other', 'Content-Type': 'text/plain' });
      res.end('private URL and credentials');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const states = [];
    try {
      await assert.rejects(connectOnce(config(`ws://127.0.0.1:${server.address().port}/node/v1/connect`),
        { onState: (state) => states.push(state) }), { message: 'connector cloud handshake failed' });
      assert.equal(calls, 1);
      assert.deepEqual(states, ['connecting', status === 401 || status === 403 ? 'authentication_failed' : 'handshake_failed']);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
}

test('missing required subprotocol is rejected without opening session', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => false });
  await once(server, 'listening');
  const states = [];
  try {
    await assert.rejects(connectOnce(config(`ws://127.0.0.1:${server.address().port}/node/v1/connect`),
      { onState: (state) => states.push(state) }), { message: 'connector cloud handshake failed' });
    assert.equal(states.includes('connected'), false);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('untrusted WSS certificate is rejected even for literal loopback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'octopus-tls-test-'));
  let server;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')],
    { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    let upgrades = 0;
    server = https.createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) });
    server.on('upgrade', () => { upgrades++; });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const states = [];
    await assert.rejects(connectOnce(config(`wss://127.0.0.1:${server.address().port}/node/v1/connect`),
      { onState: (state) => states.push(state) }), { message: 'connector cloud handshake failed' });
    assert.equal(upgrades, 0);
    assert.deepEqual(states, ['connecting', 'handshake_failed']);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('aborted before dialing reports stopped and creates no connection', async () => {
  const states = [];
  await connectOnce(config('ws://127.0.0.1:1/node/v1/connect'), {
    signal: AbortSignal.abort(), onState: (state) => states.push(state),
  });
  assert.deepEqual(states, ['stopped']);
});
