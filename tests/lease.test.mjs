import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { acquireLease, leasePort } from '../src/lease.mjs';

const fixture = fileURLToPath(new URL('./fixtures/lease-owner.mjs', import.meta.url));
async function childOwner(t, identity) {
  const child = fork(fixture, [identity], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [message] = await once(child, 'message');
  assert.equal(message.ready, true);
  return child;
}

test('exclusive OS listener refuses live owners, rejects connections and releases cleanly', async () => {
  const identity = randomUUID();
  const lease = await acquireLease(identity);
  assert.ok(lease);
  try {
    assert.equal(lease.port, leasePort(identity));
    assert.equal(await acquireLease(identity), null);
    assert.equal(lease.owns(), true);
    const socket = createConnection({ host: '127.0.0.1', port: lease.port });
    socket.on('error', () => {});
    await once(socket, 'close');
    assert.equal(lease.owns(), true);
  } finally { await lease.release(); }
  assert.equal(lease.owns(), false);
  const replacement = await acquireLease(identity);
  assert.ok(replacement);
  await replacement.release();
});

test('root and token leases exclude copied installations and release partial acquisitions', async () => {
  const rootA = randomUUID();
  const rootB = randomUUID();
  const token = randomUUID();
  const first = await acquireLease([rootA, token]);
  assert.ok(first);
  try {
    assert.equal(await acquireLease([rootB, token]), null);
    assert.equal(await acquireLease([rootA, randomUUID()]), null);
    const releasedPartial = await acquireLease(rootB);
    assert.ok(releasedPartial);
    await releasedPartial.release();
  } finally { await first.release(); }
  const successor = await acquireLease([rootB, token]);
  assert.ok(successor);
  await successor.release();
});

test('cross-process live owner cannot be stolen; graceful owner release permits successor', async (t) => {
  const identity = randomUUID();
  const child = await childOwner(t, identity);
  assert.equal(await acquireLease(identity), null);
  const exited = once(child, 'exit');
  child.send('release');
  await exited;
  const replacement = await acquireLease(identity);
  assert.ok(replacement);
  await replacement.release();
});

test('OS releases the lease after owner death without timestamps or stale-file takeover', async (t) => {
  const identity = randomUUID();
  const child = await childOwner(t, identity);
  assert.equal(await acquireLease(identity), null);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const replacement = await acquireLease(identity);
  assert.ok(replacement);
  await replacement.release();
});
