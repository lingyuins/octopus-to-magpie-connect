import test from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime, retryDelay } from '../src/runtime.mjs';
import { publicOptions, pluginRoot } from '../src/control.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const configured = { version: 1, connect: true, cloud_url: 'wss://cloud.example/node/v1/connect', models: ['Model'], max_concurrency: 4, request_timeout_seconds: 300, node_token: '', magpie_key: '', magpie_url: '' };
const secrets = { nodeToken: 'fixture-node', magpieKey: 'fixture-key', magpieURL: 'http://127.0.0.1:3425', allowInsecureLoopback: false };
const control = (options = configured, off = false) => ({ options: publicOptions(options), fingerprint: JSON.stringify(publicOptions(options)), off });
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('condition not observed');
}
function fixture(t) {
  let current = control();
  let privateValue = { ...secrets };
  let owner;
  let active = 0;
  let peak = 0;
  const calls = [];
  const states = [];
  const deps = {
    env: {}, root: pluginRoot, pollMilliseconds: 5, retryMilliseconds: 5,
    read: async () => { if (current instanceof Error) throw current; return current; },
    privateConfig: async () => ({ ...privateValue }),
    lease: async () => {
      if (owner) return null;
      const lost = new AbortController();
      owner = { signal: lost.signal, owns: () => !lost.signal.aborted, release: async () => { owner = null; }, lose: () => lost.abort() };
      return owner;
    },
    connect: async (config, { signal }) => {
      calls.push(config); active++; peak = Math.max(peak, active);
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      await delay(10); active--;
    },
    onState: (state) => states.push(state),
  };
  const runtimes = [];
  t.after(async () => { for (const r of runtimes) r.stop(); await Promise.all(runtimes.map((r) => r.done)); });
  return { start: (value = configured) => { const r = startRuntime({ directory: pluginRoot }, value, deps); runtimes.push(r); return r; }, calls, states,
    set: (value) => { current = value; }, private: (value) => { privateValue = value; },
    owner: () => owner, active: () => active, peak: () => peak,
  };
}

test('old host stops and never adopts changed options; successor joins after old session cleanup', async (t) => {
  const f = fixture(t);
  const old = f.start();
  await until(() => f.calls.length === 1);
  const next = { ...configured, models: ['NewModel'] };
  f.set(control(next));
  const successor = f.start(next);
  await old.done;
  await until(() => f.calls.length === 2);
  assert.equal(f.peak(), 1);
  assert.deepEqual(f.calls[0].models, ['Model']);
  assert.deepEqual(f.calls[1].models, ['NewModel']);
  f.set(control(configured));
  await successor.done;
  await delay(25);
  assert.equal(f.calls.length, 2);
});

test('off, remove, invalid read and disconnect cancel and join current session', async (t) => {
  for (const changed of [control(configured, true), new Error('missing'), new Error('invalid'), control({ ...configured, connect: false })]) {
    const f = fixture(t);
    const runtime = f.start();
    await until(() => f.calls.length === 1);
    f.set(changed);
    await runtime.done;
    assert.equal(f.active(), 0);
    assert.equal(f.owner(), null);
  }
});

test('private token changes retire old host; it does not steal replacement credentials', async (t) => {
  const f = fixture(t);
  const old = f.start();
  await until(() => f.calls.length === 1);
  f.private({ ...secrets, nodeToken: 'replacement-node' });
  await old.done;
  assert.equal(f.calls.length, 1);
  const next = f.start();
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].nodeToken, 'replacement-node');
  next.stop(); await next.done;
});

test('ownership loss disconnects; active owner is never stolen', async (t) => {
  const f = fixture(t);
  const first = f.start();
  await until(() => f.calls.length === 1);
  const second = f.start();
  await until(() => f.states.includes('waiting_for_owner'));
  assert.equal(f.calls.length, 1);
  f.owner().lose();
  await first.done;
  await until(() => f.calls.length === 2);
  assert.equal(f.peak(), 1);
  second.stop(); await second.done;
});

test('real plugins.json and OS lease hand off to successor without overlap', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octopus-runtime-'));
  const root = join(directory, 'plugin');
  await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (value) => writeFile(join(directory, 'plugins.json'), JSON.stringify({ plugins: [{ spec: root, options: value }] }));
  await save(configured);
  const calls = [];
  let active = 0;
  let peak = 0;
  const deps = {
    root, env: { OCTOPUS_NODE_TOKEN: randomUUID(), OCTOPUS_MAGPIE_KEY: 'synthetic-key' },
    pollMilliseconds: 5, retryMilliseconds: 5,
    connect: async (config, { signal }) => {
      calls.push(config); active++; peak = Math.max(peak, active);
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      await delay(10); active--;
    },
  };
  const first = startRuntime({ directory }, configured, deps);
  let second;
  t.after(async () => { first.stop(); second?.stop(); await first.done; await second?.done; });
  await until(() => calls.length === 1);
  const next = { ...configured, models: ['Replacement'] };
  await save(next);
  second = startRuntime({ directory }, next, deps);
  await first.done;
  await until(() => calls.length === 2);
  assert.equal(peak, 1);
  assert.deepEqual(calls[1].models, ['Replacement']);
  await save({ ...next, connect: false });
  await second.done;
  assert.equal(active, 0);
});

test('real npm-form installation starts without a spec override and stops when its entry is disabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octopus-runtime-npm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = '@fixture/octopus-connector';
  const root = join(directory, 'plugins', 'node_modules', ...name.split('/'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
  const save = (off) => writeFile(join(directory, 'plugins.json'), JSON.stringify({ plugins: [{ spec: `${name}@next`, options: configured, off }] }));
  await save(false);
  const calls = [];
  const states = [];
  let active = false;
  const runtime = startRuntime({ directory }, configured, {
    root, env: { OCTOPUS_NODE_TOKEN: randomUUID(), OCTOPUS_MAGPIE_KEY: 'synthetic-key' },
    pollMilliseconds: 5,
    onState: (state) => states.push(state),
    connect: async (config, { signal }) => {
      calls.push(config); active = true;
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      active = false;
    },
  });
  t.after(async () => { runtime.stop(); await runtime.done; });
  await until(() => calls.length === 1 || states.includes('control_invalid'));
  assert.equal(calls.length, 1);
  assert.equal(active, true);
  await save(true);
  await runtime.done;
  assert.equal(active, false);
  assert.equal(states.includes('control_invalid'), false);
});

test('runtime passes the explicit environment spec as a full-equality override', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octopus-runtime-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'plugin');
  await mkdir(root);
  const spec = 'github:fixture/exact-repository#ref';
  const save = (entries) => writeFile(join(directory, 'plugins.json'), JSON.stringify({ plugins: entries }));
  await save([{ spec: root, off: true }, { spec, options: configured }]);
  let calls = 0;
  const runtime = startRuntime({ directory }, configured, {
    root, env: { OCTOPUS_MAGPIE_PLUGIN_SPEC: spec, OCTOPUS_NODE_TOKEN: randomUUID(), OCTOPUS_MAGPIE_KEY: 'synthetic-key' },
    pollMilliseconds: 5,
    connect: async (_config, { signal }) => {
      calls++;
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    },
  });
  t.after(async () => { runtime.stop(); await runtime.done; });
  await until(() => calls === 1);
  await save([{ spec: `${spec}-different`, options: configured }]);
  await runtime.done;
  assert.equal(calls, 1);
});

test('exponential retry has deterministic jitter, 500ms floor and 30s cap', () => {
  assert.equal(retryDelay(0, 500, () => 0), 500);
  assert.equal(retryDelay(0, 500, () => 1), 1000);
  assert.equal(retryDelay(1, 500, () => 0.5), 1500);
  assert.equal(retryDelay(2, 500, () => 0.5), 3000);
  assert.equal(retryDelay(30, 500, () => 1), 30000);
  assert.equal(retryDelay(30, 500, () => 0), 15000);
  assert.equal(retryDelay(0, 5, () => 0), 5);
});

test('stable connection over 60 seconds resets retries and invalid controls interrupt backoff', async (t) => {
  const delays = [];
  let current = control();
  let clock = 0;
  let attempts = 0;
  let waiting = false;
  let backoffAborted = false;
  const runtime = startRuntime({ directory: pluginRoot }, configured, {
    env: {}, pollMilliseconds: 5, random: () => 0, now: () => clock,
    read: async () => current, privateConfig: async () => secrets,
    lease: async () => ({ signal: new AbortController().signal, owns: () => true, release: async () => {} }),
    connect: async (_config, { onState }) => {
      attempts++;
      if (attempts === 3) { onState('connected'); clock += 60001; }
    },
    wait: async (milliseconds, signal) => {
      delays.push(milliseconds);
      if (delays.length < 4) return;
      waiting = true;
      await new Promise((resolve) => signal.addEventListener('abort', () => { backoffAborted = true; resolve(); }, { once: true }));
    },
  });
  t.after(() => runtime.stop());
  await until(() => waiting);
  assert.deepEqual(delays, [500, 1000, 500, 1000]);
  current = control(configured, true);
  await runtime.done;
  assert.equal(backoffAborted, true);
  assert.equal(attempts, 4);
});

test('transient transport failure reconnects only while current control remains valid', async (t) => {
  let attempts = 0;
  const f = fixture(t);
  const runtime = startRuntime({ directory: pluginRoot }, configured, {
    env: {}, pollMilliseconds: 5, retryMilliseconds: 5,
    read: async () => control(), privateConfig: async () => secrets,
    lease: async () => ({ signal: new AbortController().signal, owns: () => true, release: async () => {} }),
    connect: async () => { attempts++; throw new Error('redacted-transport-error'); },
  });
  t.after(() => runtime.stop());
  await until(() => attempts >= 2);
  runtime.stop(); await runtime.done;
  const stoppedAt = attempts;
  await delay(20);
  assert.equal(attempts, stoppedAt);
  assert.equal(f.calls.length, 0);
});
