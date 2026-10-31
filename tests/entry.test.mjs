import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import plugin from '../index.mjs';

// Invalid/missing input must return immediately and retire only its own runtime.
test('entry returns empty hooks promptly, never starts or terminates a host process', async () => {
  const logs = [];
  const before = Date.now();
  assert.deepEqual(await plugin({ client: { app: { log: async (value) => { logs.push(value.body); } } } }, { node_token: 'must-not-log-this' }), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((entry) => entry.message === 'Control or private configuration unavailable or invalid'));
  assert.equal(JSON.stringify(logs).includes('must-not-log-this'), false);
  assert.ok(Date.now() - before < 500);
  for (const path of ['../index.mjs', '../src/runtime.mjs', '../src/lease.mjs', '../src/control.mjs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /child_process|process\.(?:exit|kill)\s*\(|\bspawn\s*\(/);
  }
});
