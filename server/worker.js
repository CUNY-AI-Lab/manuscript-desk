import { CAIL_CANONICAL_ISSUER, loadIdentityVerifierConfig, readIdentityKeyring, verifyIdentityJwt, verifyKeyringGatewayJwt } from '@cuny-ai-lab/cail-identity';
import { CailError, createCailClient } from '@cuny-ai-lab/cail-client';
import { DOC_TYPES } from '../lib/rules/schema.js';
import { modelControls } from './model.js';
import { GROUPS, rolesPayload, rulesPrompt, runningTitlesPayload } from './prompts.js';

const ORIGIN = 'https://tools.ailab.gc.cuny.edu';
const AUDIENCE = 'cail:manuscript';
const MOUNT = '/manuscript';
// Doorway's launch route for this tool; 401 bodies carry it so the page restarts sign-in there.
const LAUNCH_PATH = '/launch/manuscript';
const MAX_BODY = 1024 * 1024;
const DEADLINE_MS = 180000;
// The browser splits guidelines into parts of about 40,000 characters; this leaves room for overlap.
const MAX_GUIDELINES_CHARS = 60000;
// Room for one group's rules from one part of the guidelines.
const RULES_OUTPUT_TOKENS = 6000;
// The browser cuts a manuscript into passages of about 12,000 characters of paragraphs to label,
// plus a few paragraphs of context on each side; this leaves room for long context lines.
const MAX_PASSAGE_CHARS = 40000;
const MAX_TITLES_CHARS = 20000;
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const CATALOG_RETRY_MS = 30000;
const CATALOG_TIMEOUT_MS = 5000;
const TIMEOUT_ADVICE = 'Try a shorter section or another model.';
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class AppError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}
// The mount, or an asset path under it whose last segment has no file extension and no trailing
// slash. API paths are never folders, and vendor/ holds files without extensions (MuPDF's LICENSE
// and VERSION), which are served as they are.
const isFolderWithoutSlash = pathname => pathname === MOUNT
  || (pathname.startsWith(`${MOUNT}/`) && pathname !== `${MOUNT}/api` && !pathname.startsWith(`${MOUNT}/api/`)
    && !pathname.startsWith(`${MOUNT}/vendor/`)
    && !pathname.endsWith('/') && !pathname.slice(pathname.lastIndexOf('/') + 1).includes('.'));
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

async function boundedText(message, limit = MAX_BODY) {
  if (Number(message.headers.get('content-length')) > limit) throw new AppError('body_too_large', 'This document is too large. Try a smaller section.', 413);
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AppError('body_too_large', 'This document is too large. Try a smaller section.', 413); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function bodyJSON(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('invalid_request', 'Send a JSON request.', 415);
  try { return JSON.parse(await boundedText(request)); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('invalid_request', 'The request could not be read.'); }
}

function validateModel(model) {
  if (typeof model !== 'string' || model.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(model)) throw new AppError('invalid_model', 'Choose a model or enter its exact prefix-free Gateway ID.');
  return model;
}

async function verifierConfigs(env) {
  const configs = await Promise.all([AUDIENCE, 'cail:gateway'].map(expectedAudience => loadIdentityVerifierConfig({ jwks: env.CAIL_IDENTITY_JWKS, issuer: env.CAIL_IDENTITY_ISSUER, expectedAudience, supportedIssuers: [CAIL_CANONICAL_ISSUER] })));
  if (configs.some(result => !result.ok)) throw new AppError('identity_unavailable', 'Sign-in verification is temporarily unavailable.', 503);
  return configs.map(result => result.config);
}

async function readiness(env, client) {
  await verifierConfigs(env);
  // The Gateway is reachable only through the GATEWAY service binding: a global fetch() to
  // tools.ailab.gc.cuny.edu from a Worker in the same zone goes to the zone's origin, not to the
  // Gateway Worker, and answers 404. Reading the public catalog through the binding proves the path
  // without a credential or any spend.
  try { await client.getCatalogSnapshot({ modality: 'all', signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) }); }
  catch { throw new AppError('gateway_unavailable', 'The model service is unreachable from this tool.', 503); }
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') throw new AppError('assets_unavailable', 'Application assets are unavailable.', 503);
  const asset = await env.ASSETS.fetch(new Request(`${ORIGIN}/`));
  const available = asset.ok && asset.headers.get('content-type')?.includes('text/html');
  await asset.body?.cancel();
  if (!available) throw new AppError('assets_unavailable', 'Application assets are unavailable.', 503);
  return json({ status: 'ready', version_id: env.CF_VERSION_METADATA?.id || null, tag: env.CF_VERSION_METADATA?.tag || null });
}

async function authenticate(request, env) {
  const configs = await verifierConfigs(env);
  // Only an absent app leg means "no session" (which makes the page restart sign-in). A present but
  // malformed leg is an invalid credential, like one that fails verification.
  if (request.headers.get('x-cail-identity-jwt') === null) throw new AppError('authentication_required', 'Sign in with CUNY to continue.', 401);
  const keyring = readIdentityKeyring(request.headers);
  if (!keyring) throw new AppError('invalid_credential', 'Your sign-in has expired or is invalid. Sign in again.', 401);
  const identity = await verifyIdentityJwt(keyring.appJwt, configs[0]);
  if (!identity || !await verifyKeyringGatewayJwt(keyring, configs[1], identity.subject)) throw new AppError('invalid_credential', 'Your sign-in has expired or is invalid. Sign in again.', 401);
  return { kind: 'jwt', token: keyring.gatewayJwt };
}

// Gateway calls go through env.GATEWAY, a service binding to the Gateway Worker (cail-model-api).
// Tests may pass gatewayFetch, or fetchImpl; this Worker reaches nothing else.
export function createHandler({ gatewayFetch, fetchImpl, deadlineMs = DEADLINE_MS } = {}) {
  let binding = null;
  const viaBinding = (input, init) => {
    if (!binding) throw new TypeError('GATEWAY service binding is not configured.');
    return binding.fetch(input, init);
  };
  const client = createCailClient({ app: 'manuscript', fetchImpl: gatewayFetch ?? fetchImpl ?? viaBinding });
  // Per-isolate cache of catalog rows by model ID; the catalog is public and shared. Concurrent
  // requests share one read, which has its own short deadline and ignores any one caller's signal,
  // so a person cancelling their request cannot poison the cache. Only a failed read is held back
  // for 30 s; meanwhile models are treated as unlisted.
  let catalogCache = { at: 0, models: new Map() };
  let catalogRead = null;
  function catalogModels() {
    if (Date.now() - catalogCache.at <= CATALOG_CACHE_MS) return Promise.resolve(catalogCache.models);
    catalogRead ??= client.getCatalogSnapshot({ modality: 'all', signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
      .then(catalog => { catalogCache = { at: Date.now(), models: new Map(catalog.data.map(row => [row.id, row])) }; },
        () => { catalogCache = { at: Date.now() - CATALOG_CACHE_MS + CATALOG_RETRY_MS, models: new Map() }; })
      .then(() => catalogCache.models)
      .finally(() => { catalogRead = null; });
    return catalogRead;
  }
  // The catalog row for a model (undefined when unlisted or the catalog is unreadable), for the
  // model routes to size their output budget.
  async function catalogRow(model, signal) {
    signal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
    try { return (await Promise.race([catalogModels(), aborted])).get(model); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  // The text of one model reply, or an AppError: a reply cut off at its length limit, one that does
  // not parse, or one with no content. Nothing of the request or the reply is logged.
  async function modelContent(payload, credential, signal, requestId, lengthMessage) {
    const correlation = { request_id: requestId, trace_id: crypto.randomUUID().replaceAll('-', ''), span_id: crypto.randomUUID().replaceAll('-', '').slice(0, 16), trace_flags: 0 };
    const response = await client.chatCompletions(payload, credential, { signal, correlation });
    let data;
    try { data = JSON.parse(await boundedText(response)); } catch (error) { if (error instanceof AppError) throw error; throw new AppError('invalid_model_response', 'The model returned a response this tool could not read. Try again, or choose another model.', 502); }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AppError('model_output_limit', lengthMessage, 502);
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AppError('invalid_model_response', 'The model returned an empty answer. Try again, or choose another model.', 502);
    return content;
  }
  return async function handle(request, env) {
    if (env?.GATEWAY && typeof env.GATEWAY.fetch === 'function') binding = env.GATEWAY;
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    const suppliedId = request.headers.get('x-cail-request-id');
    const requestId = UUID.test(suppliedId || '') ? suppliedId : crypto.randomUUID();
    try {
      if (url.pathname === `${MOUNT}/health` && ['GET', 'HEAD'].includes(request.method)) return await readiness(env, client);
      // This Worker is binding-only. Doorway owns request-time Admission checks.
      // No public worker origin or application-credential fallback is exposed.
      const credential = await authenticate(request, env);
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new AppError('method_not_allowed', 'Method not allowed.', 405);
      if (request.method === 'POST' && request.headers.get('origin') !== ORIGIN) throw new AppError('invalid_origin', 'Reload this tool from the CUNY AI Lab tools page.', 403);
      // A folder asked for without its trailing slash (the mount itself, or a page such as /format)
      // goes to the same path with one, so the page's relative links resolve inside the folder.
      if (isFolderWithoutSlash(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        url.pathname = `${url.pathname}/`;
        return new Response(null, { status: 308, headers: { location: url.href, 'cache-control': 'no-store' } });
      }
      if (!url.pathname.startsWith(`${MOUNT}/`)) throw new AppError('not_found', 'Not found.', 404);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
      const path = url.pathname.slice(MOUNT.length);
      if (path === '/api/session' && request.method === 'GET') return json({ authenticated: true });
      if (path === '/api/quota' && request.method === 'GET') return json(await client.getQuota(credential, { signal }));
      if (path === '/api/catalog' && request.method === 'GET') return json(await client.getCatalogSnapshot({ modality: 'all', signal }));
      if (path === '/api/rules' && request.method === 'POST') {
        const body = await bodyJSON(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_request', 'The request could not be read.');
        const model = validateModel(body.model);
        if (!DOC_TYPES.includes(body.docType)) throw new AppError('invalid_request', 'Choose whether this is an article, a monograph or an edited collection.');
        if (!GROUPS.includes(body.group)) throw new AppError('invalid_request', 'The request named a part of the guidelines this tool does not read. Reload the page and try again.');
        // The text is never echoed in an error, logged or stored.
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_GUIDELINES_CHARS) throw new AppError('invalid_request', 'Send between 1 and 60,000 characters of guidelines text at a time.');
        const payload = { model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: rulesPrompt({ docType: body.docType, group: body.group }) }, { role: 'user', content: body.text }], ...modelControls(await catalogRow(model, signal), RULES_OUTPUT_TOKENS) };
        const content = await modelContent(payload, credential, signal, requestId, 'The model ran out of room before it finished reading this part of the guidelines. Try again, or choose another model.');
        return json({ content, request_id: requestId });
      }
      if (path === '/api/roles' && request.method === 'POST') {
        const body = await bodyJSON(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_request', 'The request could not be read.');
        const model = validateModel(body.model);
        // The passage is never echoed in an error, logged or stored.
        if (typeof body.passage !== 'string' || !body.passage.trim() || body.passage.length > MAX_PASSAGE_CHARS) throw new AppError('invalid_request', 'Send between 1 and 40,000 characters of the manuscript at a time.');
        const payload = rolesPayload({ model, passage: body.passage, row: await catalogRow(model, signal) });
        const content = await modelContent(payload, credential, signal, requestId, 'The model ran out of room before it finished labelling this part of the manuscript. Try again, or choose another model.');
        return json({ content, request_id: requestId });
      }
      if (path === '/api/running-titles' && request.method === 'POST') {
        const body = await bodyJSON(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('invalid_request', 'The request could not be read.');
        const model = validateModel(body.model);
        if (!Number.isInteger(body.max) || body.max < 10 || body.max > 200) throw new AppError('invalid_request', 'A running title\'s length must be a whole number of characters from 10 to 200.');
        // The titles are never echoed in an error, logged or stored.
        if (typeof body.titles !== 'string' || !body.titles.trim() || body.titles.length > MAX_TITLES_CHARS) throw new AppError('invalid_request', 'Send between 1 and 20,000 characters of chapter titles.');
        const payload = runningTitlesPayload({ model, titles: body.titles, max: body.max, row: await catalogRow(model, signal) });
        const content = await modelContent(payload, credential, signal, requestId, 'The model ran out of room before it finished the running titles. Try again, or choose another model.');
        return json({ content, request_id: requestId });
      }
      if (path.startsWith('/api/')) throw new AppError('not_found', 'Not found.', 404);
      if (!env.ASSETS || !['GET', 'HEAD'].includes(request.method)) throw new AppError('not_found', 'Not found.', 404);
      const assetURL = new URL(request.url);
      assetURL.pathname = path;
      const asset = await env.ASSETS.fetch(new Request(assetURL, { method: request.method }));
      const response = new Response(asset.body, asset);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('referrer-policy', 'no-referrer');
      response.headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
      return response;
    } catch (error) {
      const known = error instanceof AppError || error instanceof CailError;
      const status = known ? (error.status >= 400 ? error.status : 502) : error.name === 'TimeoutError' ? 504 : error.name === 'AbortError' ? 499 : 502;
      const code = known ? error.code : status === 504 ? 'request_timeout' : status === 499 ? 'request_cancelled' : 'service_unavailable';
      const message = known ? (error.code === 'upstream_timeout' ? `${error.message} ${TIMEOUT_ADVICE}` : error.message) : status === 504 ? `The model did not finish within ${DEADLINE_MS / 60000} minutes. ${TIMEOUT_ADVICE}` : status === 499 ? 'The request was cancelled.' : 'The service is temporarily unavailable.';
      const retry = error instanceof CailError ? error.extras.should_retry : status === 503;
      const retryAfter = error instanceof CailError ? error.extras.retry_after_seconds : undefined;
      return json({ error: { code, message, request_id: requestId, ...(status === 401 ? { launch: LAUNCH_PATH } : {}) } }, status, { 'x-should-retry': retry === true ? 'true' : 'false', 'x-cail-request-id': requestId, ...(Number.isInteger(retryAfter) && retryAfter > 0 ? { 'retry-after': String(retryAfter) } : {}) });
    }
  };
}

export default { fetch: createHandler() };
