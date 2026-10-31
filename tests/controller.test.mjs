import test from 'node:test';
import assert from 'node:assert/strict';
import controllerAPI from '../page/controller.js';
import optionsAPI from '../page/options.js';
const { createController } = controllerAPI;
const { DEFAULT_OPTIONS } = optionsAPI;

const configured = { version: 1, connect: false, cloud_url: 'wss://cloud.example/prefix/node/v1/connect', models: ['Model'], max_concurrency: 4, request_timeout_seconds: 300, node_token: '', magpie_key: '', magpie_url: '' };
const fields = { cloud_url: configured.cloud_url, models: 'Model', max_concurrency: '4', request_timeout_seconds: '300', node_token: '', magpie_key: '', magpie_url: '' };
function fixture(raw = configured) {
  let clock = 0;
  let saved = structuredClone(raw);
  const calls = [];
  let failSet = false;
  let response;
  const bridge = { ready: Promise.resolve({ lang: 'en' }), options: {
    get: async () => structuredClone(saved),
    set: async (value) => {
      calls.push(structuredClone(value));
      if (failSet) throw new Error('private-peer-error-must-not-leak');
      saved = structuredClone(value);
      return response === undefined ? structuredClone(value) : response;
    },
  } };
  const states = [];
  const controller = createController({ bridge, now: () => clock, onChange: (s) => states.push(s) });
  return { controller, bridge, calls, states, advance: (n) => { clock += n; }, fail: () => { failSet = true; }, response: (r) => { response = r; } };
}

test('load waits for official ready and never writes or connects automatically', async () => {
  const f = fixture({});
  let ready;
  f.bridge.ready = new Promise((resolve) => { ready = resolve; });
  const loading = f.controller.load();
  assert.equal(f.controller.getState().busy, true);
  assert.equal(f.controller.request('connect', fields), false);
  assert.equal(await f.controller.load(), false);
  ready({ lang: 'zh' });
  assert.equal(await loading, true);
  assert.deepEqual(f.controller.getState().saved, DEFAULT_OPTIONS);
  assert.equal(f.calls.length, 0);
});

test('all actions require explicit confirmation; cancellation does not write', async () => {
  for (const action of ['save', 'connect', 'disconnect']) {
    const f = fixture();
    await f.controller.load();
    assert.equal(f.controller.request(action, fields), true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.controller.request(action, fields), false);
    assert.equal(f.controller.cancel(), true);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.controller.confirm(), false);
    assert.equal(f.controller.request(action, fields), true);
    assert.equal(await f.controller.confirm(), true);
    assert.equal(f.calls[0].connect, action === 'connect');
    assert.equal(f.controller.getState().message, action === 'disconnect' ? 'savedDisconnected' : 'savedRestart');
    assert.equal(f.controller.getState().needsRestart, action !== 'disconnect');
  }
});

test('saving preserves saved desired connection without claiming online', async () => {
  const f = fixture({ ...configured, connect: true });
  await f.controller.load();
  // Chip flow: remove the loaded model, add a replacement, then save.
  assert.equal(f.controller.removeModel('Model'), true);
  assert.equal(f.controller.addModel('Changed'), true);
  f.controller.request('save', fields);
  await f.controller.confirm();
  assert.equal(f.calls[0].connect, true);
  assert.deepEqual(f.calls[0].models, ['Changed']);
  assert.equal(Object.hasOwn(f.controller.getState(), 'online'), false);
});

test('disconnect ignores invalid edits and uses last valid clean config, secrets kept', async () => {
  const f = fixture({ ...configured, connect: true, node_token: 'private-token', unknown: 'not-for-page' });
  await f.controller.load();
  assert.deepEqual(f.controller.getState().warnings, ['unknown']);
  assert.equal(f.controller.request('save', { ...fields, cloud_url: 'invalid' }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.request('disconnect', { cloud_url: 'invalid', models: '', max_concurrency: '0' }), true);
  assert.equal(await f.controller.confirm(), true);
  assert.deepEqual(f.calls[0], { ...configured, node_token: 'private-token' });
  assert.equal(JSON.stringify(f.states).includes('not-for-page'), false);
});

test('disconnect after invalid storage writes the coordinated minimal disabled shape', async () => {
  const f = fixture({ version: 9, connect: true, node_token: 'secret' });
  await f.controller.load();
  assert.equal(f.controller.request('connect', { ...fields, models: '' }), false);
  assert.equal(f.controller.request('disconnect', {}), true);
  assert.equal(await f.controller.confirm(), true);
  assert.deepEqual(f.calls[0], DEFAULT_OPTIONS);
});

test('empty configuration can save only exact watcher-compatible defaults', async () => {
  const f = fixture({});
  await f.controller.load();
  const empty = { cloud_url: '', models: '', max_concurrency: '4', request_timeout_seconds: '300' };
  assert.equal(f.controller.request('save', { ...empty, max_concurrency: '8' }), false);
  assert.equal(f.controller.request('save', { ...empty, request_timeout_seconds: '600' }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.request('save', empty), true);
  assert.equal(await f.controller.confirm(), true);
  assert.deepEqual(f.calls[0], DEFAULT_OPTIONS);
});

test('rate limit is one set per second, busy prevents duplicate writes', async () => {
  const f = fixture();
  await f.controller.load();
  let resolve;
  f.bridge.options.set = (value) => {
    f.calls.push(structuredClone(value));
    return new Promise((r) => { resolve = () => r(value); });
  };
  f.controller.request('connect', fields);
  const saving = f.controller.confirm();
  assert.equal(await f.controller.confirm(), false);
  assert.equal(f.controller.request('disconnect', {}), false);
  assert.equal(f.controller.cancel(), false);
  resolve();
  await saving;
  f.controller.request('disconnect', {});
  f.advance(999);
  assert.equal(await f.controller.confirm(), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getState().message, 'rateLimited');
  f.advance(1);
  const second = f.controller.confirm();
  resolve();
  assert.equal(await second, true);
  assert.equal(f.calls.length, 2);
});

test('load failure exposes no raw errors and is retryable', async () => {
  const f = fixture();
  f.bridge.options.get = async () => { throw new Error('secret-in-error'); };
  assert.equal(await f.controller.load(), false);
  assert.equal(f.controller.getState().message, 'loadError');
  assert.equal(f.controller.request('disconnect', {}), false);
  assert.equal(JSON.stringify(f.states).includes('secret-in-error'), false);
  f.bridge.options.get = async () => configured;
  assert.equal(await f.controller.load(), true);
});

test('save failure is unverified, stops stale writes and can reload safely', async () => {
  const f = fixture();
  await f.controller.load();
  f.fail();
  f.controller.request('connect', fields);
  assert.equal(await f.controller.confirm(), false);
  assert.equal(f.controller.getState().message, 'saveError');
  assert.equal(f.controller.getState().loaded, false);
  assert.equal(f.controller.request('disconnect', {}), false);
  assert.equal(JSON.stringify(f.states).includes('private-peer-error'), false);
  assert.equal(await f.controller.load(), true);
});

test('bulk import is one atomic draft update with no write until confirmed save/connect', async () => {
  for (const action of ['save', 'connect']) {
    const f = fixture();
    assert.equal(f.controller.importModels('early'), false);
    await f.controller.load();
    const before = f.states.length;
    assert.equal(f.controller.importModels('Model\r\nnew,exact\r\nnew,exact\r\n'), true);
    assert.equal(f.states.length, before + 1);
    assert.deepEqual(f.controller.getState().draft, ['Model', 'new,exact']);
    assert.deepEqual(f.controller.getState().importResult, { ok: true, reason: null, added: 1, skipped: 2 });
    assert.deepEqual(f.controller.getState().saved.models, ['Model']);
    assert.equal(f.calls.length, 0);
    const beforeInvalid = f.states.length;
    assert.equal(f.controller.importModels('valid\n bad'), false);
    assert.equal(f.states.length, beforeInvalid + 1);
    assert.deepEqual(f.controller.getState().draft, ['Model', 'new,exact']);
    assert.equal(f.controller.removeModel('Model'), true);
    assert.equal(f.controller.request(action, fields), true);
    const pendingStates = f.states.length;
    assert.equal(f.controller.importModels('while-pending'), false);
    assert.equal(f.states.length, pendingStates);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.controller.confirm(), true);
    assert.deepEqual(f.calls[0].models, ['new,exact']);
    assert.equal(f.calls[0].connect, action === 'connect');
  }
});

test('bulk import cannot edit during loading or saving or after failed load', async () => {
  const f = fixture();
  let resolveReady;
  f.bridge.ready = new Promise((resolve) => { resolveReady = resolve; });
  const loading = f.controller.load();
  assert.equal(f.controller.importModels('during-load'), false);
  resolveReady({ lang: 'en' });
  await loading;
  let finishSave;
  f.bridge.options.set = (value) => new Promise((resolve) => { finishSave = () => resolve(value); });
  f.controller.request('save', fields);
  const saving = f.controller.confirm();
  const before = f.states.length;
  assert.equal(f.controller.importModels('during-save'), false);
  assert.equal(f.states.length, before);
  finishSave();
  assert.equal(await saving, true);
  f.bridge.options.get = async () => { throw new Error('fixture failure'); };
  await f.controller.load();
  assert.equal(f.controller.importModels('after-error'), false);
});

test('only a strict matching bridge acknowledgement updates saved preference', async () => {
  for (const reply of [{ ...configured, connect: true, node_token: 'tampered' }, { ...configured, connect: false }, null]) {
    const f = fixture();
    await f.controller.load();
    f.response(reply);
    f.controller.request('connect', fields);
    assert.equal(await f.controller.confirm(), false);
    assert.equal(f.controller.getState().message, 'saveUnverified');
    assert.equal(f.controller.getState().saved, null);
    assert.equal(JSON.stringify(f.states).includes('tampered'), false);
  }
});

test('placeholder secrets keep stored values; typed secrets are written once and masked after', async () => {
  const stored = { ...configured, connect: true, node_token: 'real-token', magpie_key: 'real-key', magpie_url: 'http://127.0.0.1:3425' };
  const f = fixture(stored);
  await f.controller.load();
  // The form shows placeholders, so saving back untouched fields keeps secrets.
  f.controller.request('save', { ...fields, node_token: optionsAPI.SECRET_PLACEHOLDER, magpie_key: optionsAPI.SECRET_PLACEHOLDER, magpie_url: 'http://127.0.0.1:3425' });
  assert.equal(await f.controller.confirm(), true);
  assert.equal(f.calls[0].node_token, 'real-token');
  assert.equal(f.calls[0].magpie_key, 'real-key');
  // A typed value replaces the stored one (advance past the one-second rate limit).
  f.advance(1001);
  f.controller.request('save', { ...fields, node_token: 'new-token', magpie_key: optionsAPI.SECRET_PLACEHOLDER, magpie_url: '' });
  assert.equal(await f.controller.confirm(), true);
  assert.equal(f.calls[1].node_token, 'new-token');
  assert.equal(f.calls[1].magpie_key, 'real-key');
  assert.equal(f.calls[1].magpie_url, '');
  // The freshly saved state masks again on the way back to the form.
  assert.equal(optionsAPI.maskSecrets(f.controller.getState().saved).node_token, optionsAPI.SECRET_PLACEHOLDER);
});
