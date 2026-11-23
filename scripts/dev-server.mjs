// The local test mode behind `npm run dev`. It serves the built pages and the Worker's real routes
// (createHandler from server/worker.js) on 127.0.0.1, standing in for the two things production
// puts around the Worker:
//   - Doorway: a throwaway identity issuer, made at start-up and kept in memory, signs both identity
//     legs (cail:manuscript and cail:gateway) for one fixed local person on every request. Whatever
//     identity, cookie or authorization headers the browser sends are dropped.
//   - The GATEWAY binding: the Worker's Gateway calls go to the public Gateway with the key in
//     CAIL_API_KEY, which pays for them. Without a key nothing is sent and model calls fail.
// It exists only in this script; the Worker itself has no key path and accepts no local origin.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname, join, resolve, sep } from 'node:path';
import { canonicalTestSubject } from '@cuny-ai-lab/cail-identity/testing';
import { createHandler } from '../server/worker.js';
import { ORIGIN, createLocalIdentity } from './identity.mjs';

export const DEFAULT_PORT = 8787;
const MOUNT = '/manuscript';
// The one local person every request is signed for.
const SUBJECT = canonicalTestSubject('manuscript-desk-local-test');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.png': 'image/png', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
// The only browser headers passed on to the Worker; everything else (cookies, authorization,
// identity assertions) is dropped by not being copied.
const FORWARDED = ['accept', 'content-type', 'x-cail-request-id'];
export const NO_KEY_MESSAGE = 'Local test mode has no CAIL_API_KEY, so model calls are off. Restart npm run dev with CAIL_API_KEY set to your CAIL Gateway key.';

const isApi = pathname => pathname === `${MOUNT}/api` || pathname.startsWith(`${MOUNT}/api/`);
const errorBody = (code, message) => JSON.stringify({ error: { code, message } });

// Stands in for the ASSETS binding: serves files from `root` (dist/) by the path the Worker asks for,
// which is the request path without the /manuscript mount.
export function distAssets(root) {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      let path;
      try { path = join(root, decodeURIComponent(pathname)); } catch { return notFound(); }
      if (path !== root && !path.startsWith(root + sep)) return notFound();
      if (pathname.endsWith('/')) path = join(path, 'index.html');
      let body;
      try { body = await readFile(path); } catch { return notFound(); }
      return new Response(request.method === 'HEAD' ? null : body, { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } });
    },
  };
}

// Stands in for the GATEWAY binding. The Worker's client addresses the Gateway by path on the
// production origin (/v1/catalog, /v1/quota, /v1/chat/completions) with the gateway identity leg in
// x-cail-identity-jwt; here that leg is removed and the key goes in Authorization instead.
export function keyedGateway({ key, upstreamFetch }) {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/v1/')) throw new TypeError('Local test mode reaches only the CAIL Gateway.');
    const headers = new Headers(init.headers);
    for (const name of ['x-cail-identity-jwt', 'x-cail-gateway-identity-jwt', 'authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
    // In the Gateway's own error shape, so the Worker passes the message on to the page.
    if (!key) return Response.json({ error: { message: NO_KEY_MESSAGE, type: 'service_unavailable_error', param: null, code: 'local_api_key_missing' } }, { status: 503, headers: { 'x-should-retry': 'false' } });
    headers.set('authorization', `Bearer ${key}`);
    return upstreamFetch(url.href, { ...init, headers });
  };
}

/**
 * Starts the local server on 127.0.0.1. Resolves { server, port, origin, close }.
 * @param {{ port?: number, key?: string, upstreamFetch?: typeof fetch, root?: string, log?: (line: string) => void }} options
 */
export async function startDevServer({ port = DEFAULT_PORT, key, upstreamFetch = globalThis.fetch, root = resolve('dist'), log = line => console.log(line) } = {}) {
  const identity = await createLocalIdentity();
  const env = { ...identity.env, ASSETS: distAssets(root) };
  const handle = createHandler({ gatewayFetch: keyedGateway({ key, upstreamFetch }) });
  let localPort;

  async function respond(request, response) {
    const host = request.headers.host ?? '';
    // Only this machine's own names are answered, so a page on another site that points its own
    // hostname at 127.0.0.1 (DNS rebinding) cannot use this server to spend the key.
    if (host !== `localhost:${localPort}` && host !== `127.0.0.1:${localPort}`) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end(`This local server answers only http://127.0.0.1:${localPort} and http://localhost:${localPort}.\n`);
    }
    const local = `http://${host}`;
    const target = new URL(request.url, local);
    if (target.pathname === '/') { response.writeHead(308, { location: `${MOUNT}/` }); return response.end(); }
    if (target.pathname !== MOUNT && !target.pathname.startsWith(`${MOUNT}/`)) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return response.end('Not found\n'); }
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    // Anything that can change state or spend the key must come from a page this server served.
    if (hasBody && request.headers.origin !== local) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(errorBody('invalid_origin', `Send this request from a page at ${local}.`));
    }

    const headers = await identity.signedHeaders({ subject: SUBJECT });
    for (const name of FORWARDED) if (typeof request.headers[name] === 'string') headers.set(name, request.headers[name]);
    if (hasBody) headers.set('origin', ORIGIN);
    // The Worker stops its Gateway call when the browser goes away, as request.signal does in production.
    const gone = new AbortController();
    response.on('close', () => { if (!response.writableFinished) gone.abort(); });
    const answer = await handle(new Request(`${ORIGIN}${target.pathname}${target.search}`, {
      method: request.method, headers, signal: gone.signal,
      ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
    }), env);

    const out = {};
    answer.headers.forEach((value, name) => { out[name] = value; });
    if (out.location?.startsWith(`${ORIGIN}/`)) out.location = `${local}${out.location.slice(ORIGIN.length)}`;
    response.writeHead(answer.status, out);
    if (!answer.body) return response.end();
    await pipeline(Readable.fromWeb(answer.body), response);
  }

  const server = createServer(async (request, response) => {
    const started = performance.now();
    let pathname = '';
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      await respond(request, response);
    } catch {
      // The error itself is never shown or logged: it could carry request details.
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(errorBody('local_server_error', 'The local test server could not complete this request.'));
      } else response.destroy();
    } finally {
      // One line per API request, never a body, header or query.
      if (isApi(pathname)) log(`${request.method} ${pathname} ${response.statusCode} ${Math.round(performance.now() - started)} ms`);
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  localPort = server.address().port;
  return {
    server,
    port: localPort,
    origin: `http://127.0.0.1:${localPort}`,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
