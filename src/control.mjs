import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import optionsAPI from '../page/options.js';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('config_invalid');

// JSON.parse alone accepts duplicate security/control keys with last-wins semantics.
export function parseJSON(text) {
  const value = JSON.parse(text);
  let at = 0;
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '\\') at++;
      else if (text[at - 1] === '"') break;
    }
    return JSON.parse(text.slice(start, at));
  }
  function visit() {
    space();
    if (text[at] === '{') {
      at++; space();
      const keys = new Set();
      while (text[at] !== '}') {
        const key = string();
        if (keys.has(key)) throw invalid();
        keys.add(key); space(); at++; visit(); space();
        if (text[at] !== ',') break;
        at++; space();
      }
      at++;
    } else if (text[at] === '[') {
      at++; space();
      while (text[at] !== ']') {
        visit(); space();
        if (text[at] !== ',') break;
        at++; space();
      }
      at++;
    } else if (text[at] === '"') string();
    else while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
  }
  visit();
  return value;
}

async function readJSON(path, maxBytes) {
  const file = await open(path, 'r');
  let text;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw invalid();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw invalid();
    text = buffer.subarray(0, size).toString('utf8');
  } finally { await file.close(); }
  return parseJSON(text);
}

export function publicOptions(raw = {}) {
  if (record(raw) && Object.keys(raw).length === 0) raw = optionsAPI.DEFAULT_OPTIONS;
  const result = optionsAPI.validateOptions(raw);
  if (!result.ok) throw invalid();
  return { ...result.value, models: [...result.value.models].sort() };
}

// Match Magpie's package-name and Git-spec grammar, never a path disguised by
// a version suffix. Only npm versions/tags are needed here, not URLs or aliases.
const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const validPackageName = (name) => typeof name === 'string' && packageName.test(name) && !/\s/.test(name);
const npmSpec = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/;
const gitSpec = /^(?:(?:github|gitlab|bitbucket):|git\+[a-z]+:\/\/|git:\/\/)\S+$|^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/\S+$|^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+(?:#\S+)?$/;

export async function readControl(directory, { root = pluginRoot, spec } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw invalid();
  if (spec !== undefined && (typeof spec !== 'string' || !spec)) throw invalid();
  const canonicalRoot = await realpath(root);
  const list = await readJSON(join(directory, 'plugins.json'), 2 << 20);
  if (!record(list) || !Array.isArray(list.plugins)) throw invalid();
  let dependencies;
  let ownName;
  async function installedName(entrySpec) {
    if (/\s/.test(entrySpec) || /^[.\\/]/.test(entrySpec) || entrySpec.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(entrySpec)) return undefined;
    if (!gitSpec.test(entrySpec)) return npmSpec.exec(entrySpec)?.[1];
    if (dependencies === undefined) {
      const manifest = await readJSON(join(directory, 'plugins', 'package.json'), 2 << 20);
      if (!record(manifest) || !record(manifest.dependencies)) throw invalid();
      dependencies = Object.entries(manifest.dependencies);
      if (dependencies.some(([name, value]) => !validPackageName(name) || typeof value !== 'string')) throw invalid();
    }
    const names = dependencies.filter(([, value]) => value === entrySpec).map(([name]) => name);
    // Magpie's map iteration cannot safely distinguish multiple keys for one
    // Git spec. Refuse that ambiguity rather than guessing which target it used.
    if (names.length !== 1) throw invalid();
    return names[0];
  }
  async function isSelf(path) {
    try { return await realpath(path) === canonicalRoot; }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  }
  const matches = [];
  for (const entry of list.plugins) {
    if (!record(entry) || typeof entry.spec !== 'string') throw invalid();
    let matchesSelf = false;
    if (spec !== undefined) {
      matchesSelf = entry.spec === spec;
    } else if (isAbsolute(entry.spec)) {
      try { matchesSelf = await realpath(entry.spec) === canonicalRoot; } catch { /* Not this installed directory. */ }
    } else {
      const name = await installedName(entry.spec);
      if (name && await isSelf(join(directory, 'plugins', 'node_modules', ...name.split('/')))) {
        if (ownName === undefined) {
          const manifest = await readJSON(join(canonicalRoot, 'package.json'), 2 << 20);
          if (!record(manifest) || !validPackageName(manifest.name)) throw invalid();
          ownName = manifest.name;
        }
        if (ownName !== name) throw invalid();
        matchesSelf = true;
      }
    }
    if (matchesSelf) matches.push(entry);
  }
  if (matches.length !== 1) throw invalid();
  const entry = matches[0];
  if (Object.keys(entry).some((key) => !['spec', 'off', 'options'].includes(key))) throw invalid();
  if (entry.off !== undefined && typeof entry.off !== 'boolean') throw invalid();
  const value = publicOptions(entry.options);
  return { off: entry.off === true, options: value, fingerprint: JSON.stringify(value) };
}

// Partial private configuration from the environment and an optional external
// file. Either may be absent: the plugin page can carry credentials in the
// stored options instead, and mergeConfig decides the final value per field.
// A source that is present but malformed still fails closed.
export async function loadPrivateConfig(env = process.env, root = pluginRoot) {
  let value = {};
  if (env.OCTOPUS_MAGPIE_PRIVATE_CONFIG !== undefined) {
    const path = env.OCTOPUS_MAGPIE_PRIVATE_CONFIG;
    if (typeof path !== 'string' || !isAbsolute(path)) throw invalid();
    const target = await realpath(path);
    const base = await realpath(root);
    const inside = relative(base, target);
    if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) throw invalid();
    value = await readJSON(target, 64 << 10);
    if (!record(value) || Object.keys(value).some((key) => !['node_token', 'magpie_key', 'magpie_url', 'allow_insecure_loopback'].includes(key))) throw invalid();
    for (const key of ['node_token', 'magpie_key', 'magpie_url']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw invalid();
    }
    if (value.allow_insecure_loopback !== undefined && typeof value.allow_insecure_loopback !== 'boolean') throw invalid();
  }
  for (const name of ['OCTOPUS_NODE_TOKEN', 'OCTOPUS_MAGPIE_KEY', 'OCTOPUS_MAGPIE_URL']) {
    if (env[name] !== undefined && (typeof env[name] !== 'string' || env[name] === '')) throw invalid();
  }
  const result = {
    nodeToken: env.OCTOPUS_NODE_TOKEN ?? value.node_token,
    magpieKey: env.OCTOPUS_MAGPIE_KEY ?? value.magpie_key,
    magpieURL: env.OCTOPUS_MAGPIE_URL ?? value.magpie_url,
    allowInsecureLoopback: value.allow_insecure_loopback ?? false,
  };
  if (env.OCTOPUS_ALLOW_INSECURE_LOOPBACK !== undefined) {
    if (!['true', 'false'].includes(env.OCTOPUS_ALLOW_INSECURE_LOOPBACK)) throw invalid();
    result.allowInsecureLoopback = env.OCTOPUS_ALLOW_INSECURE_LOOPBACK === 'true';
  }
  return result;
}

// Stored options are the most explicit source, then the environment, then an
// external private file, then the fixed local default. An empty option field
// simply defers to the next source.
export function mergeConfig(publicValue, privateValue) {
  return {
    nodeToken: publicValue.node_token || privateValue.nodeToken,
    magpieKey: publicValue.magpie_key || privateValue.magpieKey,
    magpieURL: publicValue.magpie_url || privateValue.magpieURL || 'http://127.0.0.1:3425',
    allowInsecureLoopback: privateValue.allowInsecureLoopback,
    cloudURL: publicValue.cloud_url,
    models: [...publicValue.models],
    maxConcurrency: publicValue.max_concurrency,
    requestTimeoutSeconds: publicValue.request_timeout_seconds,
  };
}
