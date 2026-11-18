/**
 * Static file server for the exported web bundle, with a single-page fallback.
 * Development only: it exists so the browser test has something to load.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const requested = resolve(join(root, normalize(decodeURIComponent(url.pathname))));

  // Never serve outside the bundle directory.
  if (requested !== root && !requested.startsWith(root + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  try {
    const data = await readFile(requested);
    res.writeHead(200, { 'content-type': TYPES[extname(requested)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }
}).listen(port, () => console.log(`static on ${port}`));
