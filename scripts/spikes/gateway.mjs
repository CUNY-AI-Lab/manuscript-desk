// A cached, metered call to the CAIL Gateway for the model bake-off and the agent spike. It is not
// part of the product. Every answer is kept in a private cache file (outside the repository: a request
// holds manuscript or guideline text) under a key made of the model, the thinking setting and the
// whole payload, so a re-score pays for nothing it asked before. Every paid call adds its catalog cost
// to a ledger in the same private folder, and a call that would start once the ledger has reached the
// cap is refused before it is sent. The key is read only from CAIL_API_KEY and never printed.
//
// Unlike scripts/generality.mjs's createGatewayCall, an answer may be tool calls with no text, so the
// reply's message is returned whole.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATE_LIMIT_RETRIES, backoffDelay, isRateLimited, pause, retryAfterOf } from '../../lib/calls/backoff.js';
import { modelControls } from '../../server/model.js';
import { costOf, readCatalog } from '../generality.mjs';

const GATEWAY = 'https://tools.ailab.gc.cuny.edu';
export const PRIVATE_ROOT = process.env.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(process.env.MANUSCRIPT_DESK_GUIDELINES) : fileURLToPath(new URL('../../../manuscript-desk-guidelines', import.meta.url));
export const BAKEOFF_DIR = path.join(PRIVATE_ROOT, 'work', 'bakeoff');
const CACHE_FILE = path.join(BAKEOFF_DIR, 'answers.json');
const LEDGER_FILE = path.join(BAKEOFF_DIR, 'ledger.jsonl');
// The spending cap for the whole bake-off, in US dollars at catalog prices (the task's budget).
export const CAP_DOLLARS = Number(process.env.BAKEOFF_CAP ?? 15);
const TIMEOUT_MS = 180000;

/** The case folder under manuscripts/: the one named, else the only one there (as roles-eval finds it). */
export async function caseFolder(name) {
  const base = path.join(PRIVATE_ROOT, 'manuscripts');
  if (name) return path.join(base, name);
  const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  if (folders.length !== 1) throw new Error('Name the case: there is not exactly one folder under manuscripts/.');
  return path.join(base, folders[0]);
}

let cache = null;
let spent = null;
let writing = Promise.resolve();

async function load() {
  if (cache) return;
  await mkdir(BAKEOFF_DIR, { recursive: true });
  try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  spent = 0;
  try {
    for (const line of (await readFile(LEDGER_FILE, 'utf8')).split('\n').filter(Boolean)) spent += JSON.parse(line).cost ?? 0;
  } catch {}
}

/** Dollars spent so far, from the ledger. */
export async function spentSoFar() { await load(); return spent; }

let catalog = null;
export async function catalogRows() {
  catalog ??= (await readCatalog()) ?? new Map();
  return catalog;
}

/**
 * The model controls of a payload for a thinking setting: 'product' keeps what the product sends,
 * 'on' and 'off' replace them with modelControls' thinking-on or thinking-off controls.
 */
export function withThinking(payload, row, thinking, expectedOutputTokens = 4000, maxTokens) {
  if (thinking === 'product' || !thinking) return payload;
  const { max_tokens, reasoning_effort, chat_template_kwargs, ...rest } = payload;
  return { ...rest, ...modelControls(row, expectedOutputTokens, { thinking: thinking === 'on', ...(maxTokens ? { maxTokens } : {}) }) };
}

export class SpendCapError extends Error {
  constructor() { super(`The spending cap of $${CAP_DOLLARS} is reached.`); this.code = 'spend_cap'; }
}

/**
 * One chat call. Resolves { message, finish, usage: { prompt, completion }, seconds, cost, cached }
 * or rejects with an Error carrying { code }. A rate-limit refusal is asked again after the
 * product's backoff. `tag` names the stage in the ledger; `salt` makes a repeated run ask again.
 */
export async function chat(payload, { thinking = 'product', tag = '', salt = '' } = {}) {
  await load();
  const id = createHash('sha256').update(JSON.stringify({ thinking, salt, payload })).digest('hex');
  const hit = cache[id];
  if (hit) {
    if (hit.code) throw Object.assign(new Error(hit.code), { code: hit.code, cached: true });
    return { ...hit, cached: true };
  }
  const key = process.env.CAIL_API_KEY?.trim();
  if (!key) throw Object.assign(new Error('CAIL_API_KEY is not set'), { code: 'no_key' });
  if (spent >= CAP_DOLLARS) throw new SpendCapError();
  const rows = await catalogRows();
  const row = rows.get(payload.model);
  for (let retry = 0; ; retry += 1) {
    const start = performance.now();
    let response, data;
    try {
      response = await fetch(`${GATEWAY}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
      data = await response.json().catch(() => null);
    } catch (error) {
      const code = error?.name === 'TimeoutError' ? 'request_timeout' : 'network_error';
      // A timed-out call may still be billed; its cost is unknown and recorded as such.
      await record(id, { code, seconds: (performance.now() - start) / 1000 }, { tag, model: payload.model, thinking, cost: 0, unknown: true });
      throw Object.assign(new Error(code), { code });
    }
    const seconds = (performance.now() - start) / 1000;
    if (!response.ok) {
      const code = typeof data?.error?.code === 'string' ? data.error.code.slice(0, 80) : `http_${response.status}`;
      const failure = { code, status: response.status };
      if (isRateLimited(failure) && retry < RATE_LIMIT_RETRIES) { await pause(backoffDelay(retry + 1, retryAfterOf(response.headers.get('retry-after')))); continue; }
      // Refusals are not cached: they are the Gateway's state, not the model's answer.
      throw Object.assign(new Error(code), failure);
    }
    const usage = { prompt: data?.usage?.prompt_tokens ?? 0, completion: data?.usage?.completion_tokens ?? 0 };
    const cost = costOf(usage, row) ?? 0;
    const choice = data?.choices?.[0];
    const answer = { message: choice?.message ?? null, finish: choice?.finish_reason ?? null, usage, seconds, cost };
    await record(id, answer, { tag, model: payload.model, thinking, cost, prompt: usage.prompt, completion: usage.completion, seconds });
    return { ...answer, cached: false };
  }
}

async function record(id, answer, entry) {
  cache[id] = answer;
  spent += entry.cost ?? 0;
  writing = writing.then(async () => {
    await writeFile(CACHE_FILE, JSON.stringify(cache));
    await appendFile(LEDGER_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  });
  await writing;
}

/**
 * A text-only call for code that expects { content } (the product's labelling and extraction
 * runs): the product's payload, the thinking setting applied, the answer from the cache when it is
 * there. Rejects like createGatewayCall does, with { code, retry }.
 */
export function contentCall({ payloadOf, thinking = 'product', expected = 4000, maxTokens, tag, meter }) {
  return async request => {
    const rows = await catalogRows();
    const row = rows.get(request.model);
    const payload = withThinking(payloadOf(request, row), row, thinking, expected, maxTokens);
    let answer;
    try {
      answer = await chat(payload, { thinking, tag, salt: request.salt ?? '' });
    } catch (error) {
      meter?.(null, error);
      throw Object.assign(error, { retry: false });
    }
    meter?.(answer);
    if (answer.finish === 'length') throw Object.assign(new Error('model_output_limit'), { code: 'model_output_limit', retry: false });
    const content = answer.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('invalid_model_response'), { code: 'invalid_model_response', retry: false });
    return { content };
  };
}

/** A meter for a stage: calls, tokens, dollars (new calls only), seconds, failures by code. */
export function createMeter() {
  const meter = { calls: 0, cached: 0, prompt: 0, completion: 0, cost: 0, seconds: 0, failures: {} };
  const tick = (answer, error) => {
    if (error) { meter.failures[error.code ?? 'error'] = (meter.failures[error.code ?? 'error'] ?? 0) + 1; return; }
    meter.calls += 1;
    if (answer.cached) meter.cached += 1;
    meter.prompt += answer.usage?.prompt ?? 0;
    meter.completion += answer.usage?.completion ?? 0;
    meter.cost += answer.cost ?? 0;
    meter.seconds += answer.seconds ?? 0;
  };
  return { meter, tick };
}
