// Zero-dependency static dev server with live reload.
// Serves the repo root; reloads open browsers when a file changes.
import { createReadStream, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START_PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || 'localhost';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

// Appended to every HTML response; reconnects and reloads on change.
// The attribute is how "Save as file…" finds and drops this again — matching on
// the script's text would also match the application code that mentions it.
const LIVE_RELOAD = `
<script data-dev-reload>
(() => {
  let es;
  const connect = () => {
    es = new EventSource('/__dev/reload');
    es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  };
  connect();
})();
</script>
`;

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();

function broadcastReload() {
  for (const res of clients) res.write('data: reload\n\n');
}

// fs.watch fires several times per save; collapse into one reload.
let reloadTimer = null;
watch(ROOT, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  const name = String(filename);
  if (name.startsWith('.git') || name.includes(`node_modules${sep}`)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 100);
});

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  // Reject anything that escaped the root via `..`
  return full.startsWith(ROOT) ? full : null;
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/__dev/reload')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let file = resolvePath(req.url === '/' ? '/index.html' : req.url);
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  const ext = extname(file).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Length is omitted for HTML because the live-reload snippet is appended.
    ...(isHtml ? {} : { 'Content-Length': info.size }),
  });

  const stream = createReadStream(file);
  stream.on('error', () => res.end());
  stream.on('end', () => res.end(isHtml ? LIVE_RELOAD : undefined));
  stream.pipe(res, { end: !isHtml });
});

function listen(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log(`\n  Merovar dev server running at http://${HOST}:${port}/`);
    console.log('  Live reload on. Press Ctrl+C to stop.\n');
  });
}

listen(START_PORT);
