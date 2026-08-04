// Real wall-clock profiling of the map in a headless browser.
//
// Deliberately does NOT use --virtual-time-budget: under virtual time
// performance.now() does not advance during synchronous work, so every
// measurement reads zero. Instead the page POSTs its results back here and the
// browser is killed once they arrive.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5288;
const PAGE = process.argv[2] || 'tests/perf.html';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find(existsSync);
if (!browser) { console.error('No Chromium-based browser found'); process.exit(2); }

let resolveResults;
const results = new Promise(resolve => { resolveResults = resolve; });

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__perf')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(204).end();
    resolveResults(body);
    return;
  }
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

const profile = await mkdtemp(join(tmpdir(), 'merovar-perf-'));
const child = spawn(browser, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1280,800', `--user-data-dir=${profile}`,
  `http://127.0.0.1:${PORT}/${PAGE}`,
], { stdio: 'ignore' });

const timeout = setTimeout(() => resolveResults('TIMED OUT after 120s'), 120000);
const output = await results;
clearTimeout(timeout);

child.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

console.log(output);
process.exit(/TIMED OUT/.test(output) ? 1 : 0);
