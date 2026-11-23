// Builds dist/ and serves it at http://127.0.0.1:8000/manuscript/, the path the pages have in
// production. Static pages only: there is no Worker here, so /manuscript/api/* answers 404.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import './build.mjs';

const ROOT = resolve('dist');
const MOUNT = '/manuscript';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };

createServer(async (request, response) => {
  const notFound = () => { response.statusCode = 404; response.end('Not found'); };
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  if (pathname === '/' || pathname === MOUNT) { response.writeHead(308, { location: `${MOUNT}/` }); return response.end(); }
  if (!pathname.startsWith(`${MOUNT}/`)) return notFound();
  let path;
  try { path = join(ROOT, decodeURIComponent(pathname.slice(MOUNT.length))); } catch { return notFound(); }
  if (path !== ROOT && !path.startsWith(ROOT + sep)) return notFound();
  if ((await stat(path).catch(() => null))?.isDirectory()) {
    if (!pathname.endsWith('/')) { response.writeHead(308, { location: `${pathname}/` }); return response.end(); }
    path = join(path, 'index.html');
  }
  createReadStream(path).on('error', notFound).on('open', () => response.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream')).pipe(response);
}).listen(8000, '127.0.0.1', () => console.log(`http://127.0.0.1:8000${MOUNT}/`));
