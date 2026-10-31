import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, validateConfig } from '../src/config.mjs';

const valid = { cloudURL: 'wss://cloud.example/base/node/v1/connect', nodeToken: 'node-secret', magpieKey: 'local-secret', models: ['allowed'] };

test('configuration has bounded defaults and defensive model copy', () => {
  const result = normalizeConfig(valid);
  assert.equal(result.magpieURL, 'http://127.0.0.1:3425');
  assert.equal(result.maxConcurrency, 4);
  assert.equal(result.requestTimeoutSeconds, 300);
  assert.notEqual(result.models, valid.models);
  assert.equal(validateConfig(valid), undefined);
  assert.equal(normalizeConfig({ ...valid, maxConcurrency: 0 }).maxConcurrency, 4);
});

test('only explicit HTTP literal loopback local origins are accepted', () => {
  for (const magpieURL of [
    'http://localhost:3425', 'http://127.1:3425', 'http://2130706433:3425', 'http://0x7f000001:3425',
    'http://0177.0.0.1:3425', 'http://127.0.0.1.evil:3425', 'http://127.0.0.1:3425/v1',
    'http://127.0.0.1:3425/?', 'http://127.0.0.1:3425/#', 'http://127.0.0.1:3425/%2e',
    'http://user@127.0.0.1:3425', 'http://127.0.0.1:3425\\@evil', 'http://[::ffff:127.0.0.1]:3425',
    'https://127.0.0.1:3425', 'http://0.0.0.0:3425', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://127.0.0.1:03425', 'http://127.0.0.1:',
  ]) assert.throws(() => normalizeConfig({ ...valid, magpieURL }), undefined, magpieURL);
  for (const magpieURL of ['http://127.0.0.1', 'http://127.9.8.7:3425/', 'http://[::1]:3425', 'http://[0:0:0:0:0:0:0:1]']) {
    assert.doesNotThrow(() => normalizeConfig({ ...valid, magpieURL }));
  }
});

test('cloud TLS, raw path, credentials, ports and insecure flag are strict', () => {
  for (const cloudURL of [
    'ws://cloud.example/node/v1/connect', 'ws://localhost/node/v1/connect', 'ws://127.1/node/v1/connect',
    'wss://user:pass@cloud.example/node/v1/connect', 'wss://cloud.example/node/v1/connect?',
    'wss://cloud.example/node/v1/connect#', 'wss://cloud.example/a/../node/v1/connect',
    'wss://cloud.example/a//node/v1/connect', 'wss://cloud.example/%61/node/v1/connect',
    'wss://cloud.example:0/node/v1/connect', 'wss://cloud.example:65536/node/v1/connect',
    'wss://cloud.example/node/v1/connect/', 'wss://cloud.example/other', 'file:///node/v1/connect',
  ]) assert.throws(() => normalizeConfig({ ...valid, cloudURL, allowInsecureLoopback: true }), undefined, cloudURL);
  assert.throws(() => normalizeConfig({ ...valid, cloudURL: 'ws://127.0.0.1/node/v1/connect' }));
  assert.doesNotThrow(() => normalizeConfig({ ...valid, cloudURL: 'ws://[::1]/node/v1/connect', allowInsecureLoopback: true }));
});

test('model IDs reject every ASCII control character including embedded controls', () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assert.throws(() => normalizeConfig({ ...valid, models: [`allowed${String.fromCharCode(code)}model`] }),
      { message: 'invalid model allowlist' });
  }
  assert.doesNotThrow(() => normalizeConfig({ ...valid, models: ['allowed-model_1.0/variant'] }));
});

test('credentials, model allowlist and limits reject invalid input without echoing secrets', () => {
  for (const extra of [
    { nodeToken: '' }, { magpieKey: 'secret\r\nheader: evil' }, { nodeToken: 'x'.repeat(4097) },
    { magpieKey: 'secret\u0000' }, { magpieKey: '秘密' }, { models: [] }, { models: ['allowed', 'allowed'] },
    { models: [' allowed'] }, { models: ['x'.repeat(513)] }, { models: Array(1025).fill('a') },
    { maxConcurrency: 33 }, { maxConcurrency: -1 }, { maxConcurrency: 1.5 },
    { requestTimeoutSeconds: 3601 }, { requestTimeoutSeconds: -1 }, { allowInsecureLoopback: 'true' },
  ]) assert.throws(() => normalizeConfig({ ...valid, ...extra }));
  assert.throws(() => normalizeConfig({ ...valid, nodeToken: 'sensitive\n' }), { message: 'invalid connector credentials' });
});
