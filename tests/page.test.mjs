import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('manifest is a private in-host plugin with fixed ws and classic page assets', async () => {
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, 'octopus-to-magpie-connect');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.private, true);
  assert.equal(manifest.magpie.page.file, 'page/index.html');
  assert.deepEqual(Object.keys(manifest.magpie), ['page']);
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
  for (const path of ['README.md', 'README_zh.md']) {
    const markdown = await read(path);
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
    click() { if (!this.disabled) for (const fn of this.handlers.click || []) fn.call(this); },
    keydown(event) { for (const fn of this.handlers.keydown || []) fn.call(this, event); },
  };
}
async function page() {
  const html = await read('page/index.html');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element(m[1])]));
  const localized = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => ({ ...element(), dataset: { i18n: m[1] } }));
  const document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    getElementById: (id) => nodes.get(id),
    querySelectorAll: () => localized,
    createElement: () => element(),
  };
  const context = vm.createContext({ document, URL, TextEncoder, Date, console });
  context.window = context;
  for (const path of ['tests/fixtures/bridge.js', 'page/options.js', 'page/controller.js', 'page/app.js']) vm.runInContext(await read(path), context, { filename: path });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { context, nodes, localized, settle };
}

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
