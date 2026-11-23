// The extraction run: reads a rule sheet out of one or more guidelines documents. Each document is
// split into parts and each part read once per group of categories through the injected
// `callRules` (the browser passes a wrapper over POST /manuscript/api/rules; tests pass a fake).
// The candidates of every reply go to one mergeExtracted call, which checks each quotation against
// the full documents. A part whose answer runs out of output room is read again as two halves, each
// its own call; a half that runs out of room too is recorded as a failure. Pure: no DOM, no network
// of its own.

import { CATEGORIES, DOC_TYPES, GROUPS, MAX_RULES, categoriesFor, newSheet } from './schema.js';
import { splitGuidelines, splitInTwo } from './chunk.js';
import { mergeExtracted } from './merge.js';
import { normalizeForMatch } from './quote.js';

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
const sameTask = (a, b) => a.group === b.group && a.doc === b.doc && a.part === b.part;

/**
 * @param {{ docType: string, model: string, guidelines: string[], callRules: Function, signal?: AbortSignal,
 *   onProgress?: Function, only?: Array<{ group: string, doc: number, part: number, half?: 0 | 1 }> }} options
 *   only: read just these parts (the failures of an earlier reading of the same guidelines); a
 *   failure with a half reads only that half.
 */
export async function extractRuleSheet({ docType, model, guidelines, callRules, signal, onProgress, only } = {}) {
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown document type: ${docType}`);
  if (!Array.isArray(guidelines) || guidelines.length === 0) throw new Error('extractRuleSheet needs at least one guidelines document.');
  if (typeof callRules !== 'function') throw new Error('extractRuleSheet needs a callRules function.');
  signal?.throwIfAborted();

  const categories = categoriesFor(docType);
  const offered = new Set(categories.map(entry => entry.id));
  const groups = GROUPS.filter(group => categories.some(entry => entry.group === group));
  // Every (document, part, group) call, in that order; results are kept in the same order.
  let tasks = guidelines.flatMap((document, doc) => splitGuidelines(document)
    .flatMap((text, part) => groups.map(group => ({ doc, part, group, text }))));
  if (Array.isArray(only)) {
    tasks = tasks.flatMap(task => {
      const wanted = only.filter(entry => sameTask(entry, task));
      if (!wanted.length) return [];
      if (wanted.some(entry => entry.half === undefined)) return [task];
      return [{ ...task, halves: [...new Set(wanted.map(entry => entry.half))].sort() }];
    });
  }
  const results = new Array(tasks.length);
  let total = tasks.reduce((sum, task) => sum + (task.halves?.length ?? 1), 0);
  let stopped = false;
  let next = 0;
  let done = 0;

  // One call, retried once after a reply that does not parse or a rejection marked retry.
  async function read({ group, text }) {
    for (let attempt = 1; ; attempt += 1) {
      let failure;
      try {
        const reply = await callRules({ model, docType, group, text, signal });
        const parsed = parseReply(reply?.content);
        if (parsed) return parsed;
        failure = { code: 'invalid_model_response', retry: true };
      } catch (error) {
        failure = { code: failureCode(error), retry: error?.retry === true, ...failureMessage(error) };
      }
      if (attempt === MAX_ATTEMPTS || !failure.retry || stopped) {
        const { retry, ...recorded } = failure;
        return recorded;
      }
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
      out.push({ half, ...await read({ group: task.group, text: halves[half] }) });
      if (!stopped) progress();
    }
    return out;
  }

  // One task's results: one whole-part result, or the results of its halves.
  async function readTask(task) {
    if (task.halves) return readHalves(task, task.halves, { code: OUTPUT_LIMIT });
    const result = await read(task);
    if (stopped) return [result];
    progress();
    if (result.code !== OUTPUT_LIMIT) return [result];
    total += 2;
    return readHalves(task, [0, 1], result);
  }

  async function worker() {
    while (!stopped && next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await readTask(tasks[index]);
      if (stopped) return;
    }
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
    const workers = Array.from({ length: Math.min(MAX_IN_FLIGHT, tasks.length) }, worker);
    await Promise.race([Promise.all(workers), aborted]);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
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
  tasks.forEach(({ doc, part, group }, index) => {
    for (const result of results[index] ?? []) {
      if (result.code !== undefined) {
        failures.push({ group, doc, part, ...result });
        continue;
      }
      if (named === null && result.named !== null && namedInGuidelines(result.named)) named = result.named;
      for (const candidate of result.rules) candidates.push(isObject(candidate) ? { ...refile(candidate, offered), doc } : candidate);
    }
  });
  const { rules, dropped } = mergeExtracted(candidates, guidelines);
  const sheet = newSheet(docType);
  sheet.manual.named = named;
  // A sheet holds at most MAX_RULES rules: the first ones in output order are kept, the rest counted as dropped.
  sheet.rules = rules.slice(0, MAX_RULES);
  sheet.dropped = dropped + rules.length - sheet.rules.length;
  sheet.created = new Date().toISOString();
  return { sheet, failures };
}
