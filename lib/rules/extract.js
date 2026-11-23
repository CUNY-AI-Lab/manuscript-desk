// The extraction run: reads a rule sheet out of one or more guidelines documents. Each document is
// split into parts and each part read once per group of categories through the injected
// `callRules` (the browser passes a wrapper over POST /manuscript/api/rules; tests pass a fake).
// A part whose answer runs out of output room is read again as two halves, each its own call; a
// half that runs out of room too is recorded as a failure. Then, for the settings (slots) that no
// reading filled, each part is asked once more through `callSettings` (POST /api/settings) whether
// it states them, with the quotation: a focused question instead of a second full reading, which
// round 4 measured to fill settings that one reading drops but doubled the calls. A setting such an
// answer gives counts only with its slot and a verified quotation. The candidates of every reply go
// to one mergeExtracted call, which checks each quotation against the full documents; a setting two
// parts fill differently becomes a conflict for the author, as any other. A call refused for the
// rate limit is asked again after a pause (lib/calls/backoff.js). Pure: no DOM, no network.

import { CATEGORIES, DOC_TYPES, GROUPS, MAX_RULES, categoriesFor, newSheet, slotsFor } from './schema.js';
import { splitGuidelines, splitInTwo } from './chunk.js';
import { mergeExtracted } from './merge.js';
import { normalizeForMatch } from './quote.js';
import { RATE_LIMIT_RETRIES, backoffDelay, isRateLimited, pause } from '../calls/backoff.js';

const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const MAX_NAMED = 120;
const MAX_MESSAGE = 300;
// A whole reply wrapped in a Markdown code fence, with or without a language tag.
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

// The candidates and the named manual of a reply, or null if it does not parse or has no rules array.
function parseReply(content) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return null;
  }
  if (!isObject(data) || !Array.isArray(data.rules)) return null;
  const named = isObject(data.manual) && typeof data.manual.named === 'string' ? data.manual.named.trim().slice(0, MAX_NAMED) : '';
  return { rules: data.rules, named: named || null };
}

const KNOWN_CATEGORIES = new Set(CATEGORIES.map(entry => entry.id));

// A candidate filed under a known category the document type does not offer is kept as a requirement
// under `other`: no setting, and left as a comment where the model asked for a fix. Anything else is
// passed on unchanged (an unknown category is dropped by mergeExtracted).
function refile(candidate, offered) {
  if (!isObject(candidate) || !KNOWN_CATEGORIES.has(candidate.category) || offered.has(candidate.category)) return candidate;
  return { ...candidate, category: 'other', slot: null, params: {}, mode: candidate.mode === 'fix' ? 'flag' : candidate.mode };
}

const failureCode = error => (typeof error?.code === 'string' && error.code ? error.code : 'network_error');
// The message a rejection carries (the Worker's, through the page's wrapper), if it is text.
const failureMessage = error => (typeof error?.message === 'string' && error.message ? { message: error.message.slice(0, MAX_MESSAGE) } : {});

const OUTPUT_LIMIT = 'model_output_limit';
/** The group name of a focused settings question in failures and in `only`. */
export const SETTINGS_GROUP = 'settings';
const sameTask = (a, b) => a.group === b.group && a.doc === b.doc && a.part === b.part;

/**
 * @param {{ docType: string, model: string, guidelines: string[], callRules: Function, callSettings?: Function,
 *   signal?: AbortSignal, onProgress?: Function, known?: string[], wait?: Function,
 *   only?: Array<{ group: string, doc: number, part: number, half?: 0 | 1 }> }} options
 *   only: read just these parts (the failures of an earlier reading of the same guidelines); a
 *   failure with a half reads only that half, and one of the settings group asks that part's
 *   settings question again. known: slots the sheet being completed already fills, which are not
 *   asked for. callSettings: without it no settings question is asked. wait: the pause before
 *   asking again after a rate-limit refusal (tests pass a fake).
 * @returns {Promise<{ sheet: object, failures: Array<object>, asked: { settings: string[], parts: number, added: string[] } }>}
 *   asked: the settings the focused question asked for, of how many parts, and those it filled.
 */
export async function extractRuleSheet({ docType, model, guidelines, callRules, callSettings, signal, onProgress, only, known = [], wait = pause } = {}) {
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown document type: ${docType}`);
  if (!Array.isArray(guidelines) || guidelines.length === 0) throw new Error('extractRuleSheet needs at least one guidelines document.');
  if (typeof callRules !== 'function') throw new Error('extractRuleSheet needs a callRules function.');
  if (callSettings !== undefined && typeof callSettings !== 'function') throw new Error('callSettings must be a function.');
  signal?.throwIfAborted();

  const categories = categoriesFor(docType);
  const offered = new Set(categories.map(entry => entry.id));
  const groups = GROUPS.filter(group => categories.some(entry => entry.group === group));
  const parts = guidelines.flatMap((document, doc) => splitGuidelines(document).map((text, part) => ({ doc, part, text })));
  // Every (document, part, group) call, in that order; results are kept in the same order.
  let tasks = parts.flatMap(({ doc, part, text }) => groups.map(group => ({ doc, part, group, text })));
  // The parts asked the settings question: all of them, or on a second try those named.
  let asked = callSettings ? parts : [];
  if (Array.isArray(only)) {
    tasks = tasks.flatMap(task => {
      const wanted = only.filter(entry => sameTask(entry, task));
      if (!wanted.length) return [];
      if (wanted.some(entry => entry.half === undefined)) return [task];
      return [{ ...task, halves: [...new Set(wanted.map(entry => entry.half))].sort() }];
    });
    asked = asked.filter(entry => only.some(wanted => sameTask(wanted, { ...entry, group: SETTINGS_GROUP })));
  }
  const results = new Array(tasks.length);
  const settingsResults = new Array(asked.length);
  let total = tasks.reduce((sum, task) => sum + (task.halves?.length ?? 1), 0) + asked.length;
  let stopped = false;
  let done = 0;

  // One call, retried once after a reply that does not parse or a rejection marked retry, and up to
  // RATE_LIMIT_RETRIES times, each after a longer pause, after a rate-limit refusal.
  async function read(call, request) {
    let waits = 0;
    for (let attempt = 1; ;) {
      let failure;
      try {
        const reply = await call({ model, docType, ...request, signal });
        const parsed = parseReply(reply?.content);
        if (parsed) return parsed;
        failure = { code: 'invalid_model_response', retry: true };
      } catch (error) {
        failure = { code: failureCode(error), retry: error?.retry === true, status: error?.status, retryAfter: error?.retryAfter, ...failureMessage(error) };
      }
      const { retry, status, retryAfter, ...recorded } = failure;
      if (stopped) return recorded;
      if (isRateLimited(failure)) {
        if (waits === RATE_LIMIT_RETRIES) return recorded;
        waits += 1;
        await wait(backoffDelay(waits, retryAfter), signal);
        if (stopped) return recorded;
        continue;
      }
      if (attempt === MAX_ATTEMPTS || !retry) return recorded;
      attempt += 1;
    }
  }

  const progress = () => {
    done += 1;
    // A display callback must not end the run: anything it throws is ignored.
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done, total });
      } catch {}
    }
  };

  // The halves of a part, each read once as its own call and never split further. A text too
  // short to halve keeps the whole part's failure.
  async function readHalves(task, which, failure) {
    const halves = splitInTwo(task.text);
    if (!halves) return [{ ...failure }];
    const out = [];
    for (const half of which) {
      if (stopped) break;
      out.push({ half, ...await read(callRules, { group: task.group, text: halves[half] }) });
      if (!stopped) progress();
    }
    return out;
  }

  // One task's results: one whole-part result, or the results of its halves.
  async function readTask(task) {
    if (task.halves) return readHalves(task, task.halves, { code: OUTPUT_LIMIT });
    const result = await read(callRules, { group: task.group, text: task.text });
    if (stopped) return [result];
    progress();
    if (result.code !== OUTPUT_LIMIT) return [result];
    total += 2;
    return readHalves(task, [0, 1], result);
  }

  // Runs job(index) for every index below `count`, at most MAX_IN_FLIGHT at a time.
  async function pool(count, job) {
    let next = 0;
    const worker = async () => {
      while (!stopped && next < count) {
        const index = next;
        next += 1;
        await job(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, count) }, worker));
  }

  const candidates = [];
  const failures = [];
  // A model may name a manual the guidelines never mention; a name is kept only when it occurs in
  // one of the documents (plain inclusion, so a short name such as "APA 7" can pass).
  const documents = guidelines.map(normalizeForMatch);
  const namedInGuidelines = name => {
    const needle = normalizeForMatch(name);
    return needle !== '' && documents.some(document => document.includes(needle));
  };
  let named = null;
  let missing = [];

  async function run() {
    await pool(tasks.length, async index => { results[index] = await readTask(tasks[index]); });
    if (stopped) return;
    tasks.forEach(({ doc, part, group }, index) => {
      for (const result of results[index]) {
        if (result.code !== undefined) { failures.push({ group, doc, part, ...result }); continue; }
        if (named === null && result.named !== null && namedInGuidelines(result.named)) named = result.named;
        for (const candidate of result.rules) candidates.push(isObject(candidate) ? { ...refile(candidate, offered), doc } : candidate);
      }
    });
    // The settings no reading filled (nor the sheet being completed), asked of every part.
    const filled = new Set([...mergeExtracted(candidates, guidelines).rules.map(rule => rule.slot), ...known]);
    missing = slotsFor(docType).filter(slot => !filled.has(slot));
    if (!missing.length) {
      total -= asked.length;
      asked = [];
      return;
    }
    await pool(asked.length, async index => {
      settingsResults[index] = await read(callSettings, { slots: missing, text: asked[index].text });
      if (!stopped) progress();
    });
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      stopped = true;
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([run(), aborted]);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
  }

  // A settings answer counts only as a setting it was asked for: it must keep that slot and its
  // quotation must be in the guidelines. Anything else in it a reading already gave or left out.
  const wanted = new Set(missing);
  const isSetting = candidate => isObject(candidate) && wanted.has(candidate.slot)
    && mergeExtracted([candidate], guidelines).rules[0]?.slot === candidate.slot;
  asked.forEach(({ doc, part }, index) => {
    const result = settingsResults[index];
    if (result.code !== undefined) { failures.push({ group: SETTINGS_GROUP, doc, part, ...result }); return; }
    for (const candidate of result.rules) {
      const refiled = isObject(candidate) ? { ...refile(candidate, offered), doc } : candidate;
      if (isSetting(refiled)) candidates.push(refiled);
    }
  });
  const { rules, dropped } = mergeExtracted(candidates, guidelines);
  const added = [...new Set(rules.map(rule => rule.slot).filter(slot => wanted.has(slot)))];
  const sheet = newSheet(docType);
  sheet.manual.named = named;
  // A sheet holds at most MAX_RULES rules: the first ones in output order are kept, the rest counted as dropped.
  sheet.rules = rules.slice(0, MAX_RULES);
  sheet.dropped = dropped + rules.length - sheet.rules.length;
  sheet.created = new Date().toISOString();
  return { sheet, failures, asked: { settings: asked.length ? missing : [], parts: asked.length, added: asked.length ? added : [] } };
}
