import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { publicOptions, readControl, loadPrivateConfig, mergeConfig, pluginRoot } from './control.mjs';
import { acquireLease } from './lease.mjs';
import { normalizeConfig } from './config.mjs';
import { connectOnce } from './transport.mjs';

function pause(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function retryDelay(attempt, initialMilliseconds = 500, random = Math.random) {
  const initial = Math.max(1, Math.min(30000, initialMilliseconds));
  const ceiling = Math.min(30000, initial * 2 ** Math.min(16, attempt + 1));
  const floor = Math.max(initial, ceiling / 2);
  return Math.floor(floor + Math.max(0, Math.min(1, random())) * (ceiling - floor));
}

export function startRuntime(input, options, {
  env = process.env,
  root = pluginRoot,
  pollMilliseconds = 250,
  retryMilliseconds = 500,
  random = Math.random,
  now = () => performance.now(),
  wait = pause,
  read = readControl,
  privateConfig = loadPrivateConfig,
  lease = acquireLease,
  connect = connectOnce,
  onState = () => {},
} = {}) {
  const stop = new AbortController();
  let state = 'starting';
  const publish = (value) => {
    state = value;
    try { onState(value); } catch { /* Diagnostics cannot break cancellation. */ }
  };
  const done = (async () => {
    let ownership;
    let session;
    let sessionDone;
    try {
      const expected = publicOptions(options);
      const fingerprint = JSON.stringify(expected);
      const identity = `octopus-to-magpie-connect:${await realpath(root)}`;
      let secretFingerprint;
      while (!stop.signal.aborted) {
        // Never adopt changed options inside an old host: Magpie may keep that
        // host for in-flight work for ten minutes after creating its successor.
        const control = await read(input?.directory, { root, spec: env.OCTOPUS_MAGPIE_PLUGIN_SPEC });
        if (control.off || control.fingerprint !== fingerprint) break;
        if (!expected.connect) { publish('disabled'); await pause(pollMilliseconds, stop.signal); continue; }
        const secrets = await privateConfig(env, root);
        const currentSecrets = JSON.stringify(secrets);
        if (secretFingerprint !== undefined && secretFingerprint !== currentSecrets) break;
        secretFingerprint = currentSecrets;
        const config = normalizeConfig(mergeConfig(expected, secrets));
        if (!ownership) {
          const nodeIdentity = `octopus-node:${createHash('sha256').update(config.nodeToken).digest('hex')}`;
          ownership = await lease([identity, nodeIdentity]);
          if (!ownership) { publish('waiting_for_owner'); await pause(pollMilliseconds, stop.signal); continue; }
          ownership.signal.addEventListener('abort', () => stop.abort(), { once: true });
          const latest = await read(input?.directory, { root, spec: env.OCTOPUS_MAGPIE_PLUGIN_SPEC });
          if (latest.off || latest.fingerprint !== fingerprint || stop.signal.aborted) break;
        }
        if (!ownership.owns()) break;
        if (!sessionDone) {
          session = new AbortController();
          stop.signal.addEventListener('abort', abortSession, { once: true });
          sessionDone = (async () => {
            let attempt = 0;
            while (!session.signal.aborted && ownership.owns()) {
              let connectedAt;
              try {
                await connect(config, { signal: session.signal, onState: (value) => {
                  if (value === 'connected' && connectedAt === undefined) connectedAt = now();
                  if (!session.signal.aborted && ['connecting', 'connected', 'disconnected', 'authentication_failed', 'handshake_failed'].includes(value)) publish(value);
                } });
              } catch { if (!session.signal.aborted) publish('connection_failed'); }
              if (connectedAt !== undefined && now() - connectedAt > 60000) attempt = 0;
              if (!session.signal.aborted) {
                const milliseconds = retryDelay(attempt, retryMilliseconds, random);
                attempt = Math.min(attempt + 1, 16);
                await wait(milliseconds, session.signal);
              }
            }
          })();
        }
        await pause(pollMilliseconds, stop.signal);
      }
    } catch { publish('control_invalid'); }
    finally {
      session?.abort();
      if (sessionDone) await sessionDone;
      stop.signal.removeEventListener('abort', abortSession);
      if (ownership) await ownership.release();
      publish('stopped');
    }
    function abortSession() { session?.abort(); }
  })();
  return Object.freeze({ stop: () => stop.abort(), done, getState: () => state });
}
