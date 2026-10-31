import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, open, rename, symlink } from 'node:fs/promises';
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

async function installedFixture(t, name = 'octopus-to-magpie-connect') {
  const f = await fixture(t);
  const root = join(f.dir, 'plugins', 'node_modules', ...name.split('/'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
  const mapping = (dependencies) => writeFile(join(f.dir, 'plugins', 'package.json'), JSON.stringify({ dependencies }));
  return { ...f, root, name, mapping };
}

test('npm bare, version and tag specs resolve only to their real installed package directory', async (t) => {
  for (const name of ['octopus-to-magpie-connect', '@fixture/octopus-to-magpie-connect']) {
    const f = await installedFixture(t, name);
    for (const spec of [name, `${name}@0.1.0`, `${name}@next`, `${name}@1.0.0-beta.1`]) {
      await f.put([{ spec: 'unrelated-plugin@latest', off: true }, { spec, options: configured }]);
      assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true, spec);
    }
    await f.put([{ spec: name, options: configured }]);
    // Equal package names elsewhere are not proof of this installation.
    const elsewhere = join(f.dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'package.json'), JSON.stringify({ name }));
    await assert.rejects(readControl(f.dir, { root: elsewhere }));
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'wrong-package' }));
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
});

test('npm rejects path-like and malformed specs before extracting an installed name', async (t) => {
  const f = await installedFixture(t);
  for (const spec of [
    `./${f.name}`, `../${f.name}`, `plugins/node_modules/${f.name}`, `file:${f.root}`,
    `${f.name}@`, `${f.name}@@next`, `${f.name}@../plugin`, `${f.name}@file:../plugin`,
    `${f.name}@https://example.invalid/pkg.tgz`, `${f.name}\\child`, ` ${f.name}`, `${f.name} `,
    `${f.name}\n`, `${f.name}@next\n`, './repository#main', 'fixture/repository\n',
    '@fixture', '@fixture/', 'Octopus-to-magpie-connect',
  ]) {
    await f.put([{ spec, options: configured }]);
    await assert.rejects(readControl(f.dir, { root: f.root }), spec);
    // An unrelated invalid spec must not become an extra self-match either.
    await f.put([{ spec, options: configured }, { spec: f.root, options: configured }]);
    assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true, spec);
  }
});

test('Git specs use the exact saved dependency value, not repository or package basename guesses', async (t) => {
  const f = await installedFixture(t, '@fixture/connector');
  const specs = [
    'github:fixture/differently-named-repository#main', 'gitlab:fixture/repository#v1',
    'bitbucket:fixture/repository', 'git+https://example.invalid/fixture/repository.git#ref',
    'git+ssh://git@example.invalid/fixture/repository.git#ref', 'git+file:///fixture/repository',
    'git://example.invalid/fixture/repository.git', 'https://github.com/fixture/repository#main',
    'https://gitlab.com/fixture/repository', 'http://bitbucket.org/fixture/repository',
    'fixture/repository#main',
  ];
  for (const spec of specs) {
    await f.mapping({ [f.name]: spec, unrelated: 'github:fixture/other' });
    await f.put([{ spec, options: configured }]);
    assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true, spec);
    await f.put([{ spec: `${spec}-different`, options: configured }]);
    await assert.rejects(readControl(f.dir, { root: f.root }), spec);
  }
  const spec = specs[0];
  await f.mapping({ connector: spec });
  await f.put([{ spec, options: configured }]);
  await assert.rejects(readControl(f.dir, { root: f.root }));
  await f.mapping({ [f.name]: spec });
  const elsewhere = join(f.dir, 'same-name');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'package.json'), JSON.stringify({ name: f.name }));
  await assert.rejects(readControl(f.dir, { root: elsewhere }));
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'wrong-package' }));
  await assert.rejects(readControl(f.dir, { root: f.root }));
});

test('Git mapping is bounded, duplicate-free and unambiguous; invalid mappings fail closed', async (t) => {
  const f = await installedFixture(t);
  const spec = 'github:fixture/repository#main';
  await f.put([{ spec, options: configured }]);
  const path = join(f.dir, 'plugins', 'package.json');
  await assert.rejects(readControl(f.dir, { root: f.root }));
  for (const text of [
    '{', 'null', '[]', '{}', '{"dependencies":[]}',
    JSON.stringify({ dependencies: { [f.name]: spec, other: spec } }),
    JSON.stringify({ dependencies: { '../escape': spec } }),
    JSON.stringify({ dependencies: { [f.name]: 123 } }),
    `{"dependencies":{"${f.name}":"${spec}","${f.name}":"${spec}"}}`,
    `{"dependencies":{"${f.name}":"${spec}"},"dependencies":{}}`,
    JSON.stringify({ dependencies: { [f.name]: spec }, padding: 'x'.repeat((2 << 20) + 1) }),
  ]) {
    await writeFile(path, text);
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
  await f.mapping({ [f.name]: spec });
  assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true);
});

test('installed package manifest is bounded, duplicate-free and must identify the exact package', async (t) => {
  const f = await installedFixture(t);
  await f.put([{ spec: f.name, options: configured }]);
  const path = join(f.root, 'package.json');
  for (const text of [
    '{', 'null', '[]', '{}', '{"name":123}',
    `{"name":"wrong-package","name":"${f.name}"}`,
    JSON.stringify({ name: f.name, padding: 'x'.repeat((2 << 20) + 1) }),
  ]) {
    await writeFile(path, text);
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
  await writeFile(path, JSON.stringify({ name: f.name }));
  assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true);
});

test('all default install forms require a unique entry, including cross-form duplicates', async (t) => {
  const f = await installedFixture(t);
  const git = 'github:fixture/repository#main';
  await f.mapping({ [f.name]: git });
  for (const specs of [[f.name, f.name], [f.name, `${f.name}@next`], [f.name, f.root], [git, git], [git, f.name]]) {
    await f.put(specs.map((spec) => ({ spec, options: configured })));
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
});

test('npm and Git installed directory links must resolve to the canonical root', async (t) => {
  const f = await fixture(t);
  const name = '@fixture/linked-connector';
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ name }));
  const modules = join(f.dir, 'plugins', 'node_modules', '@fixture');
  await mkdir(modules, { recursive: true });
  const target = join(modules, 'linked-connector');
  await symlink(f.root, target, process.platform === 'win32' ? 'junction' : 'dir');
  const git = 'github:fixture/link#ref';
  await writeFile(join(f.dir, 'plugins', 'package.json'), JSON.stringify({ dependencies: { [name]: git } }));
  for (const spec of [`${name}@next`, git, target]) {
    await f.put([{ spec, options: configured }]);
    assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true);
  }
  const different = join(f.dir, 'different');
  await mkdir(different);
  await writeFile(join(different, 'package.json'), JSON.stringify({ name }));
  await rm(target);
  await symlink(different, target, process.platform === 'win32' ? 'junction' : 'dir');
  for (const spec of [name, git]) {
    await f.put([{ spec, options: configured }]);
    await assert.rejects(readControl(f.dir, { root: f.root }));
  }
});

test('explicit spec remains a full-equality override and absolute directories need no package metadata', async (t) => {
  const f = await installedFixture(t);
  const git = 'github:fixture/repository#main';
  await f.mapping({ [f.name]: git });
  await f.put([{ spec: f.name, options: configured }, { spec: `${f.name}@next`, options: { ...configured, connect: false } }]);
  assert.equal((await readControl(f.dir, { root: f.root, spec: f.name })).options.connect, true);
  assert.equal((await readControl(f.dir, { root: f.root, spec: `${f.name}@next` })).options.connect, false);
  for (const spec of ['', null, `${f.name}@other`, f.name.toUpperCase()]) {
    await assert.rejects(readControl(f.dir, { root: f.root, spec }));
  }
  // Explicit selection does not depend on automatic resolution or its metadata.
  await writeFile(join(f.dir, 'plugins', 'package.json'), '{');
  await writeFile(join(f.root, 'package.json'), '{');
  await f.put([{ spec: git, options: configured }, { spec: f.root, options: { ...configured, connect: false } }]);
  assert.equal((await readControl(f.dir, { root: f.root, spec: git })).options.connect, true);
  assert.equal((await readControl(f.dir, { root: f.root, spec: f.root })).options.connect, false);
  await f.put([{ spec: f.root, options: configured }]);
  assert.equal((await readControl(f.dir, { root: f.root })).options.connect, true);
  await f.put([{ spec: git, options: configured }, { spec: git, options: configured }]);
  await assert.rejects(readControl(f.dir, { root: f.root, spec: git }));
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
