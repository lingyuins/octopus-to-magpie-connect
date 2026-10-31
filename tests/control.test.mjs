import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readControl, loadPrivateConfig, parseJSON, publicOptions, mergeConfig } from '../src/control.mjs';

const configured = { version: 1, connect: true, cloud_url: 'wss://cloud.example/node/v1/connect', models: ['Model'], max_concurrency: 4, request_timeout_seconds: 300, node_token: '', magpie_key: '', magpie_url: '' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'plugin');
  await mkdir(root);
  const put = (plugins) => writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins }));
  return { dir, root, put };
}

test('matches own canonical absolute directory, never similar names or relative specs', async (t) => {
  const f = await fixture(t);
  await f.put([{ spec: 'octopus-to-magpie-connect', options: configured }, { spec: f.root, options: configured }]);
  assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true);
  await f.put([{ spec: 'octopus-to-magpie-connect', options: configured }]);
  await assert.rejects(readControl(f.dir, { root: f.root }));
  assert.equal((await readControl(f.dir, { root: f.root, spec: 'octopus-to-magpie-connect' })).options.connect, true);
  await f.put([{ spec: f.root, options: configured }, { spec: await realpath(f.root), options: configured }]);
  await assert.rejects(readControl(f.dir, { root: f.root }));
});

test('off, remove, malformed and unknown fields fail closed', async (t) => {
  const f = await fixture(t);
  await f.put([{ spec: f.root, off: true, options: configured }]);
  assert.equal((await readControl(f.dir, { root: f.root })).off, true);
  for (const options of [{ ...configured, unexpected_secret_field: 'page-secret' }, { ...configured, max_concurrency: 0 }, null]) {
    await f.put([{ spec: f.root, options }]);
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
  // Stored credentials in the options are accepted and survive the read.
  await f.put([{ spec: f.root, options: { ...configured, node_token: 'stored-token', magpie_key: 'stored-key' } }]);
  const withSecrets = await readControl(f.dir, { root: f.root });
  assert.equal(withSecrets.options.node_token, 'stored-token');
  assert.equal(withSecrets.options.magpie_key, 'stored-key');
  await f.put([]);
  await assert.rejects(readControl(f.dir, { root: f.root }));
  await writeFile(join(f.dir, 'plugins.json'), '{');
  await assert.rejects(readControl(f.dir, { root: f.root }));
  assert.throws(() => parseJSON('{"plugins":[],"plugins":[]}'));
  assert.throws(() => parseJSON('{"a":{"token":1,"token":2}}'));
  assert.deepEqual(parseJSON('{"x":[{},[],true,"quoted\\\"",null,3]}'), { x: [{}, [], true, 'quoted"', null, 3] });
  assert.equal(publicOptions({}).connect, false);
});

test('private config replacement never reads a partial file and retries after Windows sharing conflicts', async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, 'private.json');
  const next = join(f.dir, 'private.next.json');
  await writeFile(path, JSON.stringify({ node_token: 'old-node', magpie_key: 'key' }));
  const handle = await open(path, 'r');
  let replaced = false;
  try {
    await writeFile(next, JSON.stringify({ node_token: 'new-node', magpie_key: 'key' }));
    try { await rename(next, path); replaced = true; }
    catch (error) {
      assert.equal(process.platform, 'win32');
      assert.equal(error.code, 'EPERM');
      t.diagnostic('Windows open-handle rename is EPERM; replacement succeeds after reader closes');
      const unchanged = await loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: path }, f.root);
      assert.equal(unchanged.nodeToken, 'old-node');
    }
    assert.match(await handle.readFile('utf8'), /old-node/);
  } finally { await handle.close(); }
  if (!replaced) await rename(next, path);
  const result = await loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: path }, f.root);
  assert.equal(result.nodeToken, 'new-node');
});

test('Magpie-style Windows rename retry succeeds while a bounded reader closes', async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, 'plugins.json');
  const next = join(f.dir, 'plugins.next.json');
  await f.put([{ spec: f.root, options: configured }]);
  await writeFile(next, JSON.stringify({ plugins: [{ spec: f.root, options: { ...configured, connect: false } }] }));
  const handle = await open(path, 'r');
  const closing = delay(25).then(() => handle.close());
  try {
    // Mirrors Magpie steady.Rename: initial attempt plus 50 retries, 10ms apart.
    for (let attempt = 0; ; attempt++) {
      try { await rename(next, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= 50) throw error;
        await delay(10);
      }
    }
  } finally { await closing; }
  assert.equal((await readControl(f.dir, { root: f.root })).options.connect, false);
});

test('credentials come from explicit env or external snake_case private JSON, both optional', async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, 'private.json');
  await writeFile(path, JSON.stringify({ node_token: 'private-node', magpie_key: 'private-key', magpie_url: 'http://127.0.0.1:3425' }));
  const result = await loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: path, OCTOPUS_NODE_TOKEN: 'env-node' }, f.root);
  assert.equal(result.nodeToken, 'env-node');
  assert.equal(result.magpieKey, 'private-key');
  // No env and no file is fine now: the page can carry the credentials in options.
  assert.deepEqual(await loadPrivateConfig({}, f.root), { nodeToken: undefined, magpieKey: undefined, magpieURL: undefined, allowInsecureLoopback: false });
  // A present-but-empty env value is a configuration error, never a silent unset.
  await assert.rejects(loadPrivateConfig({ OCTOPUS_NODE_TOKEN: '' }, f.root));
  await assert.rejects(loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: 'relative.json' }, f.root));
  const inside = join(f.root, 'private.json');
  await writeFile(inside, '{}');
  await assert.rejects(loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: inside }, f.root));
  await writeFile(path, JSON.stringify({ nodeToken: 'camel-case-is-not-accepted', magpie_key: 'key' }));
  await assert.rejects(loadPrivateConfig({ OCTOPUS_MAGPIE_PRIVATE_CONFIG: path }, f.root));
  await assert.rejects(loadPrivateConfig({ OCTOPUS_NODE_TOKEN: 'token', OCTOPUS_MAGPIE_KEY: 'key', OCTOPUS_ALLOW_INSECURE_LOOPBACK: '1' }, f.root));
});

test('stored options credentials take precedence over env and private file, empty defers', async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, 'private.json');
  await writeFile(path, JSON.stringify({ node_token: 'file-node', magpie_key: 'file-key', magpie_url: 'http://127.0.0.1:1111' }));
  const env = { OCTOPUS_MAGPIE_PRIVATE_CONFIG: path, OCTOPUS_NODE_TOKEN: 'env-node', OCTOPUS_MAGPIE_KEY: 'env-key' };
  const privateValue = await loadPrivateConfig(env, f.root);
  const base = { ...configured, node_token: '', magpie_key: '', magpie_url: '' };
  // Empty option fields defer to env, then file, then the fixed default.
  let merged = mergeConfig(base, privateValue);
  assert.equal(merged.nodeToken, 'env-node');
  assert.equal(merged.magpieKey, 'env-key');
  assert.equal(merged.magpieURL, 'http://127.0.0.1:1111');
  // Stored options beat every other source; an absent env/file leaves the option value.
  merged = mergeConfig({ ...base, node_token: 'page-node', magpie_key: 'page-key', magpie_url: 'http://127.0.0.1:3425' }, privateValue);
  assert.equal(merged.nodeToken, 'page-node');
  assert.equal(merged.magpieKey, 'page-key');
  assert.equal(merged.magpieURL, 'http://127.0.0.1:3425');
  merged = mergeConfig({ ...base, node_token: 'page-node' }, await loadPrivateConfig({}, f.root));
  assert.equal(merged.nodeToken, 'page-node');
  assert.equal(merged.magpieKey, undefined);
  assert.equal(merged.magpieURL, 'http://127.0.0.1:3425');
});
