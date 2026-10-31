// Explicitly launched test fixture, never imported by the plugin entry.
import { acquireLease } from '../../src/lease.mjs';
const lease = await acquireLease(process.argv[2]);
if (!lease) throw new Error('fixture lease unavailable');
if (process.send) process.send({ ready: true, port: lease.port });
process.on('message', async (message) => {
  if (message === 'release') {
    await lease.release();
    process.disconnect();
  }
});
