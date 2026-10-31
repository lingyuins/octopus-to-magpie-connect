import test from 'node:test';
import assert from 'node:assert/strict';
import options from '../page/options.js';

const valid = (extra = {}) => ({ version: 1, connect: false, cloud_url: 'wss://cloud.example/octopus/node/v1/connect', models: ['Case/Sensitive', 'literal,*'], max_concurrency: 4, request_timeout_seconds: 300, node_token: '', magpie_key: '', magpie_url: '', ...extra });

test('defaults are disabled, clean, independent copies', () => {
  assert.equal(options.DEFAULT_OPTIONS.connect, false);
  assert.deepEqual(options.inspectStoredOptions({}).value, options.DEFAULT_OPTIONS);
  assert.equal(options.validateOptions(options.DEFAULT_OPTIONS).ok, true);
  const a = options.inspectStoredOptions({}).value;
  a.models.push('new');
  assert.deepEqual(options.inspectStoredOptions({}).value.models, []);
});

test('strict fields and types; unknown fields rejected, secrets kept without echo', () => {
  const input = { ...valid(), node_token: 'stored-token', magpie_key: 'secret', magpie_url: 'http://127.0.0.1:3425', unexpected: '<script>' };
  assert.equal(options.validateOptions(input).ok, false);
  const inspected = options.inspectStoredOptions(input);
  assert.deepEqual(inspected.value, valid({ node_token: 'stored-token', magpie_key: 'secret', magpie_url: 'http://127.0.0.1:3425' }));
  assert.deepEqual(inspected.warnings, ['unknown']);
  assert.equal(JSON.stringify(inspected).includes('<script>'), false);
  // Only the placeholder keeps a stored secret; clearing removes the override.
  const masked = options.maskSecrets(inspected.value);
  assert.equal(masked.node_token, options.SECRET_PLACEHOLDER);
  assert.equal(masked.magpie_key, options.SECRET_PLACEHOLDER);
  assert.equal(masked.magpie_url, 'http://127.0.0.1:3425');
  assert.equal(JSON.stringify(masked).includes('stored-token'), false);
  const merged = options.mergeSecrets(inspected.value, { node_token: options.SECRET_PLACEHOLDER, magpie_key: '', magpie_url: '' });
  assert.equal(merged.node_token, 'stored-token');
  assert.equal(merged.magpie_key, '');
  assert.equal(merged.magpie_url, '');
  const replaced = options.mergeSecrets(inspected.value, { node_token: 'new-token', magpie_key: 'new-key', magpie_url: 'http://127.0.0.1:9999' });
  assert.equal(replaced.node_token, 'new-token');
  assert.equal(replaced.magpie_key, 'new-key');
  assert.equal(replaced.magpie_url, 'http://127.0.0.1:9999');
  for (const extra of [{ version: 2 }, { version: '1' }, { connect: 'false' }, { max_concurrency: '4' }, { request_timeout_seconds: null }]) {
    assert.equal(options.validateOptions(valid(extra)).ok, false);
  }
  for (const raw of [null, [], 1, 'not-an-object', { connect: true }, { cloud_url: 'wss://user:secret@host/node/v1/connect' }]) {
    assert.deepEqual(options.inspectStoredOptions(raw).value, options.DEFAULT_OPTIONS);
    assert.deepEqual(options.inspectStoredOptions(raw).warnings, ['invalid']);
  }
});

test('secret and local-URL fields are bounded and never echo control or wide characters', () => {
  assert.equal(options.validateOptions(valid({ node_token: 'tok', magpie_key: 'key', magpie_url: 'http://127.0.0.1:3425' })).ok, true);
  assert.equal(options.validateOptions(valid({ node_token: 'x'.repeat(4096) })).ok, true);
  for (const extra of [
    { node_token: 1 }, { node_token: 'has\nnewline' }, { node_token: '中' }, { node_token: 'x'.repeat(4097) },
    { magpie_key: 'has\0nul' }, { magpie_key: '中' }, { magpie_key: '\u0080' }, { node_token: 'é'.repeat(2049) },
    { magpie_url: 'http://localhost:3425' }, { magpie_url: 'http://127.1:3425' }, { magpie_url: 'https://127.0.0.1:3425' },
    { magpie_url: 'http://127.0.0.1:3425/v1' }, { magpie_url: 'http://127.0.0.1:0' }, { magpie_url: 'http://[::ffff:127.0.0.1]:3425' },
    { magpie_url: 'http://127.0.0.1' },
  ]) {
    const expected = 'magpie_url' in extra && extra.magpie_url === 'http://127.0.0.1';
    assert.equal(options.validateOptions(valid(extra)).ok, expected, JSON.stringify(extra));
  }
});

test('port input constructs only fixed IPv4 loopback origins and preserves legacy configuration', () => {
  for (const port of ['1', '3425', '65535']) {
    const result = options.optionsFromForm({ cloud_url: valid().cloud_url, models: ['model'], max_concurrency: '4', request_timeout_seconds: '300', magpie_port: port });
    assert.equal(result.ok, true, port);
    assert.equal(result.value.magpie_url, `http://127.0.0.1:${port}`);
  }
  for (const port of ['0', '65536', '-1', '1.5', '3e3', ' 3425', '03425', 'http://192.168.10.2:3425']) {
    const result = options.optionsFromForm({ cloud_url: valid().cloud_url, models: ['model'], max_concurrency: '4', request_timeout_seconds: '300', magpie_port: port });
    assert.equal(result.ok, false, port);
    assert.ok(result.errors.includes('magpie_port'), port);
  }
  assert.equal(options.magpiePort(''), '');
  assert.equal(options.magpiePort('http://127.0.0.1:3425'), '3425');
  assert.equal(options.magpiePort('http://127.9.8.7:80/'), '80');
  assert.equal(options.magpiePort('http://[::1]:9000'), '9000');
  assert.equal(options.magpiePort('http://127.0.0.1'), '80');
  assert.equal(options.magpiePort('http://192.168.10.2:3425'), '');
  const cleared = options.optionsFromForm({ cloud_url: valid().cloud_url, models: ['model'], max_concurrency: '4', request_timeout_seconds: '300', magpie_port: '' });
  assert.equal(cleared.value.magpie_url, '');
});

test('safe WSS URLs support deployment prefix without URL normalization loopholes', () => {
  for (const url of ['wss://cloud.example/node/v1/connect', 'wss://cloud.example:443/a_b/c.d~e-/node/v1/connect', 'wss://[::1]:8443/node/v1/connect']) {
    assert.equal(options.validCloudURL(url), true, url);
  }
  for (const url of ['ws://127.0.0.1/node/v1/connect', 'https://cloud.example/node/v1/connect', 'wss://user:secret@cloud.example/node/v1/connect', 'wss://cloud.example/node/v1/connect?', 'wss://cloud.example/node/v1/connect#', 'wss://cloud.example/node/v1/connect?key=secret', 'wss://cloud.example/a/../node/v1/connect', 'wss://cloud.example/./node/v1/connect', 'wss://cloud.example/%61/node/v1/connect', 'wss://cloud.example//node/v1/connect', 'wss://cloud.example/node/v1/connect/', 'wss://cloud.example/其他/node/v1/connect', ' wss://cloud.example/node/v1/connect', 'wss://cloud.example\\evil/node/v1/connect', 'wss://cloud.example:99999/node/v1/connect', 'wss:///node/v1/connect']) {
    assert.equal(options.validCloudURL(url), false, url);
  }
});

test('model allowlist is exact, unique, bounded; no silent trimming or wildcard expansion', () => {
  assert.equal(options.validModels(['Model', 'model', '*', 'a,b']), true);
  assert.equal(options.validModels(Array.from({ length: 1024 }, (_, i) => `model-${i}`)), true);
  for (const models of [[], [''], [' model'], ['model '], ['model', 'model'], ['a\nb'], ['a\0b'], [1], ['中'.repeat(171)], ['x'.repeat(513)], Array.from({ length: 1025 }, (_, i) => String(i))]) {
    assert.equal(options.validModels(models), false);
  }
  assert.equal(options.validModels(['x'.repeat(512)]), true);
  const form = { cloud_url: valid().cloud_url, models: 'Model\r\nmodel,a', max_concurrency: '4', request_timeout_seconds: '300' };
  assert.deepEqual(options.optionsFromForm(form).value.models, ['Model', 'model,a']);
  assert.equal(options.optionsFromForm({ ...form, models: 'Model\n' }).ok, false);
});

test('bulk import accepts exact lines and JSON, skips duplicates and preserves order', () => {
  const lines = options.importModels(['existing'], 'existing\r\nCase/ID\r\nCase/ID\r\nliteral,*\r\nmodel\n\n');
  assert.deepEqual(lines, { ok: true, reason: null, models: ['existing', 'Case/ID', 'literal,*', 'model'], added: 3, skipped: 2 });
  const json = options.importModels(['existing'], JSON.stringify({ data: [{ id: 'existing' }, { id: '<img src=x onerror=alert(1)>' }, { id: '*' }, { id: '*' }] }));
  assert.deepEqual(json.models, ['existing', '<img src=x onerror=alert(1)>', '*']);
  assert.equal(json.added, 2);
  assert.equal(json.skipped, 2);
  assert.deepEqual(options.importModels(['a'], 'a\na').models, ['a']);
  assert.equal(options.importModels([], 'x'.repeat(512)).ok, true);
});

test('bulk import rejects every invalid item and malformed JSON atomically', () => {
  const draft = ['original'];
  for (const [input, reason] of [
    ['', 'empty'], ['\r\n\n', 'empty'], ['good\n\nbad', 'empty'], [' good', 'space'], ['good ', 'space'],
    ['good\nbad\tID', 'control'], ['good\nbad\0ID', 'control'], ['good\nbad\rID', 'control'], ['good\nbad\x7fID', 'control'],
    ['中'.repeat(171), 'toolong'], ['x'.repeat(513), 'toolong'],
    ['{bad json', 'json'], ['  {"data":[{"id":"valid"}],}', 'json'], ['["valid"]', 'json'],
    ['{"data":null}', 'json'], ['{"models":["id"]}', 'json'], ['{"data":[]}', 'empty'],
    ['{"data":[{"id":"good"},{}]}', 'empty'], ['{"data":[{"id":"good"},{"id":1}]}', 'empty'],
    ['{"data":[{"id":"good"},{"id":" bad"}]}', 'space'],
    ['{"data":[{"id":"good"},{"id":"bad\\nID"}]}', 'control'],
  ]) {
    const result = options.importModels(draft, input);
    assert.equal(result.ok, false, input);
    assert.equal(result.reason, reason, input);
    assert.deepEqual(result.models, draft);
    assert.equal(result.added, 0);
  }
  assert.deepEqual(draft, ['original']);
});

test('bulk import enforces UTF-8 payload bytes and final unique count limits', () => {
  assert.equal(options.MODEL_IMPORT_MAX_BYTES, 4 * 1024 * 1024);
  const limit = options.MODEL_IMPORT_MAX_BYTES;
  const atLimit = 'a\n' + '\n'.repeat(limit - 2);
  assert.equal(options.importModels([], atLimit).ok, true);
  assert.equal(options.importModels([], atLimit + '\n').reason, 'payload');
  // This string has fewer UTF-16 code units than the limit but more UTF-8 bytes.
  assert.equal(options.importModels([], '中'.repeat(Math.floor(limit / 3) + 1)).reason, 'payload');
  const full = Array.from({ length: 1024 }, (_, i) => `model-${i}`);
  assert.equal(options.importModels([], full.join('\n')).ok, true);
  assert.equal(options.importModels(full, 'model-0\nmodel-1').skipped, 2);
  assert.equal(options.importModels(full, 'extra').reason, 'toomany');
  const failed = options.importModels(['original'], full.join('\n'));
  assert.equal(failed.reason, 'toomany');
  assert.deepEqual(failed.models, ['original']);
});

test('numeric limits and minimal disabled shape are fail closed', () => {
  for (const n of [1, 32]) assert.equal(options.validateOptions(valid({ max_concurrency: n })).ok, true);
  for (const n of [1, 3600]) assert.equal(options.validateOptions(valid({ request_timeout_seconds: n })).ok, true);
  for (const n of [0, 33, 1.5, Infinity, NaN]) assert.equal(options.validateOptions(valid({ max_concurrency: n })).ok, false);
  for (const n of [0, 3601, 1.5]) assert.equal(options.validateOptions(valid({ request_timeout_seconds: n })).ok, false);
  assert.equal(options.validateOptions({ ...options.DEFAULT_OPTIONS, connect: true }).ok, false);
  assert.equal(options.validateOptions({ ...options.DEFAULT_OPTIONS, cloud_url: valid().cloud_url }).ok, false);
  for (const extra of [{ max_concurrency: 1 }, { max_concurrency: 32 }, { request_timeout_seconds: 1 }, { request_timeout_seconds: 3600 }, { max_concurrency: 8, request_timeout_seconds: 600 }]) {
    const empty = { ...options.DEFAULT_OPTIONS, ...extra };
    assert.equal(options.validateOptions(empty).ok, false, JSON.stringify(extra));
    assert.deepEqual(options.inspectStoredOptions(empty).value, options.DEFAULT_OPTIONS);
    assert.deepEqual(options.inspectStoredOptions(empty).warnings, ['invalid']);
    assert.equal(options.validateOptions(valid(extra)).ok, true);
  }
  const form = { cloud_url: valid().cloud_url, models: 'Model', max_concurrency: '4e0', request_timeout_seconds: '300' };
  assert.equal(options.optionsFromForm(form).ok, false);
});
