// Loads the built index.html in a headless browser and asserts the map,
// settlements and kingdom editor all still behave. Run with `npm run smoke`.
//
// Serves the project on its own port without the dev server's live-reload
// stream: an open EventSource never lets headless Chromium reach network idle,
// so --dump-dom would hang forever.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5271;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browser = BROWSERS.find(existsSync);
if (!browser) {
  console.error('No Chromium-based browser found; checked:\n  ' + BROWSERS.join('\n  '));
  process.exit(2);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^[/\\]+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
  });
  createReadStream(file).pipe(res);
});

await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

const profile = await mkdtemp(join(tmpdir(), 'merovar-smoke-'));
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  // Headless virtual time does not advance CSS transitions or rAF loops, so
  // animated states never settle. Reduced motion takes the instant path and
  // makes every assertion deterministic; the animation itself is checked by eye.
  '--force-prefers-reduced-motion',
  '--virtual-time-budget=30000', '--window-size=1200,820',
  `--user-data-dir=${profile}`, '--dump-dom',
  `http://127.0.0.1:${PORT}/tests/smoke.html`,
];

const dom = await new Promise((resolve, reject) => {
  const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', reject);
  child.on('close', () => resolve(out));
});

server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

const decode = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const body = decode(/<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? '');
if (!body || body === 'running') {
  console.error('The harness never reported. Is index.html built?');
  process.exit(1);
}

console.log(body);
const failed = body.split('\n').filter(line => line.startsWith('FAIL'));
const passed = body.split('\n').filter(line => line.startsWith('PASS'));
console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
