// The extraction run: reads a rule sheet out of one or more guidelines documents. Each document is
// split into parts and each part read once per group of categories through the injected
// `callRules` (the browser passes a wrapper over POST /manuscript/api/rules; tests pass a fake).
// The candidates of every reply go to one mergeExtracted call, which checks each quotation against
// the full documents. Pure: no DOM, no network of its own.

import { CATEGORIES, DOC_TYPES, GROUPS, MAX_RULES, categoriesFor, newSheet } from './schema.js';
import { splitGuidelines } from './chunk.js';
import { mergeExtracted } from './merge.js';

const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const MAX_NAMED = 120;
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

export async function extractRuleSheet({ docType, model, guidelines, callRules, signal, onProgress } = {}) {
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown document type: ${docType}`);
  if (!Array.isArray(guidelines) || guidelines.length === 0) throw new Error('extractRuleSheet needs at least one guidelines document.');
  if (typeof callRules !== 'function') throw new Error('extractRuleSheet needs a callRules function.');
  signal?.throwIfAborted();

  const categories = categoriesFor(docType);
  const offered = new Set(categories.map(entry => entry.id));
  const groups = GROUPS.filter(group => categories.some(entry => entry.group === group));
  // Every (document, part, group) call, in that order; results are kept in the same order.
  const tasks = guidelines.flatMap((document, doc) => splitGuidelines(document)
    .flatMap((text, part) => groups.map(group => ({ doc, part, group, text }))));
  const results = new Array(tasks.length);
  const total = tasks.length;
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
        failure = { code: failureCode(error), retry: error?.retry === true };
      }
      if (attempt === MAX_ATTEMPTS || !failure.retry || stopped) return { code: failure.code };
    }
  }

  async function worker() {
    while (!stopped && next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await read(tasks[index]);
      if (stopped) return;
      done += 1;
      // A display callback must not end the run: anything it throws is ignored.
      if (typeof onProgress === 'function') {
        try {
          onProgress({ done, total });
        } catch {}
      }
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
  let named = null;
  tasks.forEach(({ doc, part, group }, index) => {
    const result = results[index];
    if (result.code !== undefined) {
      failures.push({ group, doc, part, code: result.code });
      return;
    }
    named ??= result.named;
    for (const candidate of result.rules) candidates.push(isObject(candidate) ? { ...refile(candidate, offered), doc } : candidate);
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
