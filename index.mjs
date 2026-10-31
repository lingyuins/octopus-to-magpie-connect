import { startRuntime } from './src/runtime.mjs';

export default async function plugin(input, options = {}) {
  // Magpie owns this Bun host. Start supervision without blocking hook loading
  // or spawning/terminating any process; failures remain fail-closed.
  let previous;
  const messages = {
    starting: 'Starting in-host connector', disabled: 'Connection not requested',
    waiting_for_owner: 'Waiting for local connector ownership',
    connecting: 'Connecting', connected: 'Connected', disconnected: 'Disconnected',
    authentication_failed: 'Authentication failed', handshake_failed: 'Connection handshake failed',
    connection_failed: 'Connection failed; retrying while configuration remains current',
    control_invalid: 'Control or private configuration unavailable or invalid', stopped: 'Connector stopped',
  };
  const runtime = startRuntime(input, options, { onState(state) {
    if (previous === state || !Object.hasOwn(messages, state)) return;
    previous = state;
    try {
      const logged = input?.client?.app?.log?.({ body: {
        service: 'octopus-to-magpie-connect', level: 'info', message: messages[state],
      } });
      void Promise.resolve(logged).catch(() => {});
    } catch { /* Optional host diagnostics are never a lifecycle dependency. */ }
  } });
  void runtime.done.catch(() => {});
  return {};
}
