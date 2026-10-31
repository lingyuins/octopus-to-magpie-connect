import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('manifest is a publishable in-host plugin with fixed ws and classic page assets', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, 'octopus-to-magpie-connect');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(manifest.private, undefined);
  assert.match(manifest.description, /Octopus/);
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.keywords, ['opencode', 'opencode-plugin', 'octopus', 'magpie-plugin']);
  assert.deepEqual(manifest.files, ['index.mjs', 'src/', 'page/']);
  assert.equal(manifest.magpie.page.file, 'page/index.html');
  assert.deepEqual(Object.keys(manifest.magpie), ['icon', 'page']);
  assert.match(manifest.magpie.icon, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(manifest.main, 'index.mjs');
  assert.equal(manifest.type, 'module');
  assert.match(manifest.dependencies.ws, /^\d+\.\d+\.\d+$/);
  assert.equal(Object.hasOwn(manifest, 'bin'), false);
  const html = await read(manifest.magpie.page.file);
  const scripts = [...html.matchAll(/<script\b([^>]*)src="([^"]+)"[^>]*>/g)];
  assert.deepEqual(scripts.map((s) => s[2]), ['_magpie/bridge.js', 'options.js', 'controller.js', 'app.js']);
  assert.equal(html.includes('type="module"'), false);
  for (const script of scripts.slice(1)) await read(`page/${script[2]}`);
  await read('page/style.css');
});

test('both guides describe in-host operation, lazy host and reload hazards', async () => {
  for (const path of ['README.md', 'README.en.md']) {
    const markdown = await read(path);
    assert.match(markdown, /magpie plugin add octopus-to-magpie-connect\n/);
    assert.match(markdown, /magpie plugin add D:\/CodeWorkspace\/octopus-to-magpie-connect/);
    assert.match(markdown, /OCTOPUS_MAGPIE_PRIVATE_CONFIG/);
    assert.match(markdown, /Bun/);
  }
  const app = await read('page/app.js');
  assert.equal(app.includes('separately started'), false);
  assert.equal(app.includes('单独启动并监听'), false);
});

function element(id = '') {
  return {
    id, textContent: '', value: '', hidden: false, disabled: false, dataset: {}, children: [], handlers: {},
    className: '', type: '', placeholder: '', title: '',
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); },
    setAttribute(name, value) { this['attr:' + name] = value; },
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    click() { if (!this.disabled) for (const fn of this.handlers.click || []) fn.call(this); },
    keydown(event) { for (const fn of this.handlers.keydown || []) fn.call(this, event); },
  };
}
async function page(config = {}) {
  const html = await read('page/index.html');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element(m[1])]));
  const localized = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => ({ ...element(), dataset: { i18n: m[1] } }));
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    getElementById: (id) => nodes.get(id),
    querySelectorAll: () => localized,
    createElement: () => element(),
  };
  const networkCalls = [];
  const context = vm.createContext({ document, URL, URLSearchParams, TextEncoder, Date, console,
    octopusFixtureConfig: config,
    fetch: async (...args) => { networkCalls.push(args); throw new Error('Page must not access the network'); },
  });
  context.window = context;
  for (const path of ['tests/fixtures/bridge.js', 'page/options.js', 'page/controller.js', 'page/app.js']) vm.runInContext(await read(path), context, { filename: path });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { context, nodes, localized, networkCalls, settle };
}

test('initial asynchronous Chinese ready translates without an onTheme event', async () => {
  const { context, nodes, localized, settle } = await page({ manualHello: true });
  assert.equal(context.magpie.theme, null);
  assert.equal(nodes.get('models-fieldset').disabled, true);
  let themeEvents = 0;
  context.magpie.onTheme(() => { themeEvents += 1; });
  context.octopusFixture.hello('zh-CN', true);
  await settle();
  assert.equal(themeEvents, 0);
  assert.equal(context.document.documentElement.lang, 'zh-Hans');
  assert.match(nodes.get('message').textContent, /选项已加载/);
  assert.equal(localized.find((el) => el.dataset.i18n === 'save').textContent, '保存偏好');
  context.octopusFixture.theme('en');
  assert.match(nodes.get('message').textContent, /Options loaded/);
});

test('page performs no network calls, including former model-fetch action', async () => {
  const { nodes, networkCalls, settle } = await page();
  nodes.get('magpie-key').value = 'test-only-not-a-real-key';
  nodes.get('magpie-port').value = '3425';
  for (const fn of nodes.get('magpie-key').handlers.input || []) fn();
  nodes.get('model-fetch')?.click();
  await settle();
  assert.equal(networkCalls.length, 0);
  assert.equal(nodes.has('model-fetch'), false);
});

test('model command follows unsaved and saved ports without reading credentials or writing options', async () => {
  const { context, nodes, settle } = await page();
  const command = nodes.get('model-command');
  const button = nodes.get('model-command-copy');
  assert.ok(command, 'command preview exists');
  assert.ok(button, 'copy button exists');
  assert.equal(command.value, "(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3425/v1/models?format=text').Content");
  const copied = [];
  context.navigator = { clipboard: { writeText: async (value) => { copied.push(value); } } };
  nodes.get('node-token').value = 'not-for-the-clipboard';
  nodes.get('magpie-key').value = 'also-not-for-the-clipboard';
  button.click(); await settle();
  assert.equal(copied[0], command.value);
  assert.match(nodes.get('model-command-status').textContent, /copied/i);
  nodes.get('magpie-port').value = '4567';
  for (const fn of nodes.get('magpie-port').handlers.input || []) fn();
  assert.match(command.value, /127\.0\.0\.1:4567/);
  assert.equal(nodes.get('model-command-status').hidden, true);
  button.click(); await settle();
  assert.match(copied[1], /127\.0\.0\.1:4567/);
  assert.equal(copied.some((value) => /not-for-the-clipboard/.test(value)), false);
  context.octopusFixture.seed({ version: 1, connect: false, cloud_url: 'wss://cloud.example/node/v1/connect', models: ['m'], max_concurrency: 4, request_timeout_seconds: 300, node_token: '', magpie_key: '', magpie_url: 'http://127.0.0.1:8765' });
  await context.magpie.ready;
  context.octopusFixture.fail('get'); nodes.get('retry').click(); await settle();
  context.octopusFixture.fail(null); nodes.get('retry').click(); await settle();
  assert.match(command.value, /127\.0\.0\.1:8765/);
  assert.equal(context.octopusFixture.calls.length, 0);
});

test('copy command rejects invalid ports and uses the default only for an empty port', async () => {
  const { context, nodes, settle } = await page();
  const copied = [];
  context.navigator = { clipboard: { writeText: async (value) => { copied.push(value); } } };
  const button = nodes.get('model-command-copy');
  assert.ok(button, 'copy button exists');
  for (const port of ['0', '65536', '-1', '3.5', '1e3', 'http://evil', '3425;whoami']) {
    nodes.get('magpie-port').value = port;
    for (const fn of nodes.get('magpie-port').handlers.input || []) fn();
    assert.equal(nodes.get('model-command').value, '');
    button.click(); await settle();
    assert.match(nodes.get('model-command-status').textContent, /1.*65535/);
  }
  nodes.get('magpie-port').value = '';
  nodes.get('magpie-port').validity = { badInput: true };
  for (const fn of nodes.get('magpie-port').handlers.input || []) fn();
  assert.equal(nodes.get('model-command').value, '');
  button.click(); await settle();
  assert.equal(copied.length, 0);
  nodes.get('magpie-port').validity.badInput = false;
  for (const fn of nodes.get('magpie-port').handlers.input || []) fn();
  button.click(); await settle();
  assert.match(copied[0], /127\.0\.0\.1:3425/);
  assert.equal(context.octopusFixture.calls.length, 0);
});

test('copy command falls back synchronously and reports failure without claiming a copy', async () => {
  const { context, nodes, settle } = await page();
  const command = nodes.get('model-command');
  const button = nodes.get('model-command-copy');
  assert.ok(button, 'copy button exists');
  const operations = [];
  context.document.execCommand = (operation) => { operations.push(operation); return true; };
  button.click(); await settle();
  assert.deepEqual(operations, ['copy']);
  assert.equal(command.selected, true);
  assert.match(nodes.get('model-command-status').textContent, /copied/i);
  context.navigator = { clipboard: { writeText: async () => { throw new Error('private clipboard failure'); } } };
  context.document.execCommand = () => { assert.equal(command.disabled, false); return false; };
  button.click(); await settle();
  assert.match(nodes.get('model-command-status').textContent, /select|manual/i);
  assert.equal(nodes.get('model-command-status').textContent.includes('private clipboard failure'), false);
  context.octopusFixture.theme('zh');
  assert.match(nodes.get('model-command-status').textContent, /手动/);
  assert.equal(context.octopusFixture.calls.length, 0);
});

test('copy command prevents duplicate writes and clears stale feedback if the port changes', async () => {
  const { context, nodes, settle } = await page();
  let finish;
  let writes = 0;
  context.navigator = { clipboard: { writeText: () => { writes++; return new Promise((resolve) => { finish = resolve; }); } } };
  const button = nodes.get('model-command-copy');
  assert.ok(button, 'copy button exists');
  button.click(); button.click();
  assert.equal(writes, 1);
  assert.equal(button.disabled, true);
  nodes.get('magpie-port').value = '5555';
  for (const fn of nodes.get('magpie-port').handlers.input || []) fn();
  finish(); await settle();
  assert.equal(button.disabled, false);
  assert.equal(nodes.get('model-command-status').hidden, true);
  assert.match(nodes.get('model-command').value, /127\.0\.0\.1:5555/);
  assert.equal(context.octopusFixture.calls.length, 0);
});

test('actual page classic scripts load, translate live, confirm writes and ignore invalid edits on disconnect', async () => {
  const { context, nodes, localized, settle } = await page();
  assert.match(nodes.get('message').textContent, /Options loaded/);
  assert.equal(context.octopusFixture.calls.length, 0);
  assert.equal(nodes.get('saved-state').textContent, 'Do not connect');
  context.octopusFixture.theme('zh-TW', true);
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
  assert.equal(localized.find((el) => el.dataset.i18n === 'save').textContent, '保存偏好');
  assert.match(nodes.get('message').textContent, /选项已加载/);
  context.octopusFixture.theme('en');
  nodes.get('cloud-url').value = 'wss://cloud.example/node/v1/connect';
  nodes.get('concurrency').value = '4';
  nodes.get('timeout').value = '300';
  // Add a model via the chip flow; its exact (even hostile-looking) text is kept literal.
  nodes.get('model-input').value = '<img src=x onerror=alert(1)>';
  nodes.get('model-add').click();
  assert.equal(nodes.get('chips').children.length, 1);
  nodes.get('connect').click();
  assert.equal(nodes.get('confirmation').hidden, false);
  assert.equal(context.octopusFixture.calls.length, 0);
  nodes.get('confirm').click();
  await settle();
  assert.equal(context.octopusFixture.calls.length, 1);
  assert.equal(context.octopusFixture.calls[0].models[0], '<img src=x onerror=alert(1)>');
  assert.equal(nodes.get('saved-state').textContent, 'Connect');
  assert.match(nodes.get('message').textContent, /fully quit and restart Magpie/);
  assert.equal(nodes.get('restart-result').hidden, false);
  assert.equal(nodes.get('saved-when').hidden, false);
  context.octopusFixture.theme('zh');
  assert.match(nodes.get('message').textContent, /完全退出并重新启动 Magpie/);
  assert.match(nodes.get('message').textContent, /仅刷新插件页面不够/);
  context.octopusFixture.theme('en');
  nodes.get('cloud-url').value = 'invalid';
  nodes.get('disconnect').click();
  assert.equal(nodes.get('confirmation').hidden, false);
  assert.match(nodes.get('confirm-detail').textContent, /ignoring current form edits/);
  nodes.get('confirm').click();
  await settle();
  assert.match(nodes.get('message').textContent, /one second/);
  assert.equal(context.octopusFixture.calls.length, 1);
});

test('chips add exact IDs, reject invalid ones inline, and remove on click', async () => {
  const { context, nodes, settle } = await page();
  const input = nodes.get('model-input');
  const add = nodes.get('model-add');
  const err = nodes.get('model-error');
  // valid add
  input.value = 'a/b'; add.click();
  input.value = 'a/b'; add.click();            // duplicate rejected
  assert.equal(nodes.get('chips').children.length, 1);
  assert.match(err.textContent, /already in the list/);
  assert.equal(err.hidden, false);
  input.value = ' space'; add.click();          // surrounding space rejected
  assert.match(err.textContent, /surrounding spaces/);
  input.value = ''; add.click();                // empty rejected
  assert.match(err.textContent, /Enter a model ID/);
  input.value = 'c/d'; add.click();
  assert.equal(nodes.get('chips').children.length, 2);
  assert.equal(err.hidden, true);
  // chips render exact text and remove on click
  assert.equal(nodes.get('chips').children[0].children[0].textContent, 'a/b');
  nodes.get('chips').children[0].click();       // remove 'a/b'
  assert.equal(nodes.get('chips').children.length, 1);
  assert.equal(nodes.get('chips').children[0].children[0].textContent, 'c/d');
  assert.equal(context.octopusFixture.calls.length, 0); // chip edits never write
});

test('ready does not overwrite a newer theme event and handshake rejection is handled', async () => {
  const f = await page({ manualHello: true });
  f.context.octopusFixture.hello('zh', true);
  f.context.octopusFixture.theme('en');
  await f.settle();
  assert.equal(f.context.document.documentElement.lang, 'en');
  assert.match(f.nodes.get('message').textContent, /Options loaded/);
  f.context.octopusFixture.theme('zh-TW');
  assert.match(f.nodes.get('message').textContent, /选项已加载/);
  const rejected = await page({ manualHello: true });
  rejected.context.octopusFixture.rejectReady();
  await rejected.settle();
  assert.match(rejected.nodes.get('message').textContent, /Could not load options/);
  assert.equal(rejected.nodes.get('model-import').disabled, true);
  assert.equal(rejected.context.octopusFixture.calls.length, 0);
});

test('import UI safely renders exact removable chips, translates results and confirms exact writes', async () => {
  const { context, nodes, localized, networkCalls, settle } = await page();
  const input = nodes.get('model-import-input');
  const button = nodes.get('model-import');
  const status = nodes.get('model-import-status');
  input.value = JSON.stringify({ data: [{ id: '<img src=x onerror=alert(1)>' }, { id: 'literal,*' }, { id: 'literal,*' }] });
  button.click();
  assert.equal(nodes.get('chips').children.length, 2);
  assert.equal(nodes.get('chips').children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.match(status.textContent, /Added 2 model\(s\); skipped 1/);
  assert.equal(context.octopusFixture.calls.length, 0);
  assert.equal(nodes.get('saved-state').textContent, 'Do not connect');
  context.octopusFixture.theme('zh');
  assert.match(status.textContent, /已添加 2 个模型，跳过 1 个重复项/);
  assert.equal(localized.find((el) => el.dataset.i18n === 'importButton').textContent, '导入草稿');
  input.value = 'new\n bad';
  button.click();
  assert.match(status.textContent, /未导入任何模型/);
  assert.equal(nodes.get('chips').children.length, 2);
  assert.equal(input['attr:aria-invalid'], 'true');
  context.octopusFixture.theme('en');
  assert.match(status.textContent, /Nothing imported.*surrounding spaces/);
  nodes.get('chips').children[1].click();
  input.value = 'next\r\nnext\r\n';
  button.click();
  nodes.get('cloud-url').value = 'wss://cloud.example/node/v1/connect';
  nodes.get('connect').click();
  assert.equal(nodes.get('model-import').disabled, true);
  assert.equal(nodes.get('model-import-input').disabled, true);
  assert.equal(context.octopusFixture.calls.length, 0);
  nodes.get('confirm').click();
  await settle();
  assert.equal(context.octopusFixture.calls.length, 1);
  assert.deepEqual(Array.from(context.octopusFixture.calls[0].models), ['<img src=x onerror=alert(1)>', 'next']);
  assert.equal(context.octopusFixture.calls[0].connect, true);
  assert.equal(networkCalls.length, 0);
});

test('page assets keep import collapsed and contain no network APIs or credential interpolation', async () => {
  const app = await read('page/app.js');
  const fixture = await read('tests/fixtures/bridge.js');
  const html = await read('page/index.html');
  const server = await read('tests/fixtures/serve-page.mjs');
  assert.doesNotMatch(app, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
  assert.doesNotMatch(app, /fetchModels|updateFetchButton|model-fetch/);
  assert.doesNotMatch(fixture, /window\.fetch\s*=/);
  assert.match(server, /connect-src 'none'/);
  assert.match(html, /<details class="model-import" id="model-import-panel">/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3425\/v1\/models\?format=text/);
  assert.doesNotMatch(html, /Authorization|Bearer|api_key=|key=/i);
});

test('actual page safely renders unknown-option warnings and load errors', async () => {
  const { context, nodes, settle } = await page();
  context.octopusFixture.seed({ node_token: 'page-secret-token', untrusted: '<script>secret</script>' });
  context.octopusFixture.fail('get');
  nodes.get('retry').click();
  await settle();
  assert.match(nodes.get('message').textContent, /Could not load/);
  context.octopusFixture.fail(null);
  nodes.get('retry').click();
  await settle();
  assert.match(nodes.get('warning').textContent, /Unrecognized option fields were ignored/i);
  // The stored token survives but the form only ever shows the placeholder.
  assert.equal(nodes.get('warning').textContent.includes('page-secret-token'), false);
  assert.equal(nodes.get('node-token').value, '__keep__');
  assert.equal(nodes.get('cloud-url').value, '');
  context.octopusFixture.seed({ version: 999, connect: true });
  nodes.get('retry').click();
  await settle();
  assert.match(nodes.get('saved-state').textContent, /Stored request is invalid/);
  assert.match(nodes.get('warning').textContent, /Nothing was automatically saved/);
});
