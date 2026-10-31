// Temporary acceptance server: serves the real page with the test bridge on loopback.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)); // tests/
const pluginRoot = fileURLToPath(new URL('../../', import.meta.url)); // plugin root
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  let file;
  if (path === '/' || path === '/index.html') file = pluginRoot + 'page/index.html';
  else if (path === '/_magpie/bridge.js') file = root + 'fixtures/bridge.js';
  else if (/^\/(options|controller|app)\.js$/.test(path)) file = pluginRoot + 'page' + path;
  else if (path === '/style.css') file = pluginRoot + 'page/style.css';
  else { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': types[ext] || 'text/plain', 'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'" });
    res.end(body);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.listen(49669, '127.0.0.1', () => console.log('PORT=' + server.address().port));
