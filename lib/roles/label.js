// The labelling run: gives every non-empty paragraph of a manuscript a role. The paragraph model is
// cut into passages and each is read once through the injected `callRoles` (the browser passes a
// wrapper over POST /manuscript/api/roles; tests pass a fake). Shaped like extractRuleSheet: a cap on
// calls in flight, one retry, failures recorded and the run carried on. Paragraphs still without a
// role after that (a failed passage, or a reply that left some out) are asked once more, in passages
// of their own. Pure: no DOM, no network.

import { buildPassages } from './passages.js';
import { parseRolesReply, reconcile } from './reply.js';

const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const MAX_MESSAGE = 300;

const failureCode = error => (typeof error?.code === 'string' && error.code ? error.code : 'network_error');
const failureMessage = error => (typeof error?.message === 'string' && error.message ? { message: error.message.slice(0, MAX_MESSAGE) } : {});

/**
 * @param {{ paragraphs: Array<object>, model: string, callRoles: Function, signal?: AbortSignal,
 *   onProgress?: Function, passageOptions?: object }} options
 * @returns {Promise<{ roles: Record<number, string>, failures: Array<object> }>} roles by paragraph
 *   index; empty paragraphs get none. A failure names its passage and the indices left unlabelled.
 */
export async function labelRoles({ paragraphs, model, callRoles, signal, onProgress, passageOptions } = {}) {
  if (!Array.isArray(paragraphs)) throw new Error('labelRoles needs the paragraph list.');
  if (typeof callRoles !== 'function') throw new Error('labelRoles needs a callRoles function.');
  signal?.throwIfAborted();

  // Reads every passage, at most MAX_IN_FLIGHT at a time; resolves their results in order.
  async function readAll(passages, progress) {
    const results = new Array(passages.length);
    let next = 0;
    async function worker() {
      while (!stopped && next < passages.length) {
        const index = next;
        next += 1;
        results[index] = await read(passages[index]);
        if (stopped) return;
        progress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, passages.length) }, worker));
    return results;
  }

  // One call, retried once after a reply that does not parse or a rejection marked retry.
  async function read({ asked, text }) {
    for (let attempt = 1; ; attempt += 1) {
      let failure;
      try {
        const reply = await callRoles({ model, passage: text, signal });
        const parsed = parseRolesReply(reply?.content, asked);
        if (parsed) return parsed;
        failure = { code: 'invalid_model_response', retry: true };
      } catch (error) {
        failure = { code: failureCode(error), retry: error?.retry === true, ...failureMessage(error) };
      }
      if (attempt === MAX_ATTEMPTS || !failure.retry || stopped) {
        const { retry, ...recorded } = failure;
        return { failure: recorded };
      }
    }
  }

  const passages = buildPassages(paragraphs, passageOptions);
  let stopped = false;
  let done = 0;
  let total = passages.length;
  const progress = () => {
    done += 1;
    // A display callback must not end the run: anything it throws is ignored.
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done, total });
      } catch {}
    }
  };

  let results, retried = [], retriedResults = [];
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      stopped = true;
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([(async () => {
      results = await readAll(passages, progress);
      const first = reconcile(passages.map((passage, index) => ({ asked: passage.asked, labels: results[index]?.labels })));
      const left = new Set(passages.flatMap(passage => passage.asked).filter(index => !first.has(index)));
      if (left.size === 0 || stopped) return;
      // The second pass reads each gap once, without staggering.
      retried = buildPassages(paragraphs, { ...passageOptions, only: left, overlap: 0, overlapShare: 0 });
      total += retried.length;
      retriedResults = await readAll(retried, progress);
    })(), aborted]);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
  }

  // A second answer only fills a gap; it never replaces a first one.
  const labelled = reconcile(passages.map((passage, index) => ({ asked: passage.asked, labels: results[index]?.labels })));
  retried.forEach((passage, index) => {
    for (const [paragraph, role] of retriedResults[index]?.labels ?? []) if (!labelled.has(paragraph)) labelled.set(paragraph, role);
  });
  const failures = [];
  passages.forEach(({ asked }, index) => {
    const result = results[index];
    const unlabelled = asked.filter(paragraph => !labelled.has(paragraph));
    if (result.failure && unlabelled.length) failures.push({ passage: index, ...result.failure, unlabelled });
    // A reply that left paragraphs out; any labelled by an overlapping passage or the second pass are not missing.
    else if (unlabelled.length) failures.push({ passage: index, code: 'incomplete_reply', unlabelled });
  });
  const roles = {};
  for (const [index, role] of [...labelled].sort((a, b) => a[0] - b[0])) roles[index] = role;
  return { roles, failures };
}
