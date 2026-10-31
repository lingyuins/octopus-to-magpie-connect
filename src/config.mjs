import { isIP } from 'node:net';

const fail = (message) => { throw new Error(message); };
const bytes = (value) => Buffer.byteLength(value, 'utf8');

// Check the spelling before WHATWG URL parsing can normalize an unsafe origin.
function parseOrigin(raw, cloud, allowInsecureLoopback) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\s\\%?#@\u0000-\u001f\u007f]/u.test(raw)) {
    fail(cloud ? 'invalid cloud URL' : 'invalid local URL');
  }
  const match = /^(https?|wss?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?(\/.*)?$/.exec(raw);
  if (!match) fail(cloud ? 'invalid cloud URL' : 'invalid local URL');
  const [, scheme, authority, port, rawPath = ''] = match;
  if (port !== undefined && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)) {
    fail('invalid URL port');
  }
  const host = authority.startsWith('[') ? authority.slice(1, -1) : authority;
  const ip = isIP(host);
  let parsed;
  try { parsed = new URL(raw); } catch { fail('invalid URL'); }
  const parsedHost = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ip && isIP(parsedHost)) fail('nonliteral IP address');
  if (ip === 4 && parsedHost !== host) fail('nonliteral IP address');
  const loopback = ip === 4 ? host.split('.')[0] === '127' : ip === 6 && parsedHost === '::1';
  if (cloud) {
    if (scheme !== 'wss' && !(scheme === 'ws' && allowInsecureLoopback && loopback)) fail('cloud URL requires TLS');
    if (rawPath.length > 2048 || !rawPath.endsWith('/node/v1/connect') ||
        !rawPath.startsWith('/') || rawPath.slice(1).split('/').some((segment) =>
          !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..')) {
      fail('invalid cloud path');
    }
  } else if (scheme !== 'http' || !loopback || (rawPath !== '' && rawPath !== '/')) {
    fail('local URL must be a fixed HTTP literal-loopback origin');
  }
  return parsed;
}

function secret(value) {
  // Node HTTP headers are Latin-1; reject rather than discovering this in a dial.
  return typeof value === 'string' && value.length > 0 && bytes(value) <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/u.test(value);
}

export function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid connector configuration');
  const {
    cloudURL, nodeToken, magpieKey, models,
    magpieURL = 'http://127.0.0.1:3425',
    maxConcurrency = 4, requestTimeoutSeconds = 300, allowInsecureLoopback = false,
  } = config;
  if (typeof allowInsecureLoopback !== 'boolean') fail('invalid insecure-loopback flag');
  const cloud = parseOrigin(cloudURL, true, allowInsecureLoopback);
  const local = parseOrigin(magpieURL, false, false);
  if (!secret(nodeToken) || !secret(magpieKey)) fail('invalid connector credentials');
  if (!Array.isArray(models) || models.length < 1 || models.length > 1024 ||
      models.some((model) => typeof model !== 'string' || model.trim() !== model ||
        !model || /[\u0000-\u001f\u007f]/u.test(model) || bytes(model) > 512) || new Set(models).size !== models.length) {
    fail('invalid model allowlist');
  }
  // Zero selects the default, just like an omitted value.
  const concurrency = maxConcurrency === 0 ? 4 : maxConcurrency;
  const timeout = requestTimeoutSeconds === 0 ? 300 : requestTimeoutSeconds;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fail('invalid concurrency limit');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) fail('invalid request timeout');
  return Object.freeze({
    cloudURL: cloud.href, nodeToken, magpieURL: local.origin, magpieKey,
    models: Object.freeze([...models]), maxConcurrency: concurrency,
    requestTimeoutSeconds: timeout, allowInsecureLoopback,
  });
}

export function validateConfig(config) {
  normalizeConfig(config);
}
