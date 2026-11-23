// The run the Index Builder's model helpers share, shaped like the Formatter's labelling run
// (lib/roles/label.js): each task is one call through the injected `call` (the browser passes a
// wrapper over a POST /manuscript/api/index/... route; tests pass a fake). At most three calls are in
// flight; a reply that does not parse, or a refusal marked retry, is asked once more; a rate-limit
// refusal is asked again after pauses that grow (lib/calls/backoff.js); a task whose answer runs out
// of output room is asked again as two halves (`split`), and a half that runs out again is a
// failure. Failures are recorded and the run carries on; `onResult` hears each answer as it comes,
// so a stopped run keeps what was answered. Stop is the signal: the run rejects with its reason.
// Pure: no DOM, no network.

import { RATE_LIMIT_RETRIES, backoffDelay, isRateLimited, pause } from '../calls/backoff.js';

export const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const MAX_MESSAGE = 300;
const OUTPUT_LIMIT = 'model_output_limit';

const failureCode = error => (typeof error?.code === 'string' && error.code ? error.code : 'network_error');
const failureMessage = error => (typeof error?.message === 'string' && error.message ? { message: error.message.slice(0, MAX_MESSAGE) } : {});

/**
 * @param {{ tasks: Array<{ key: string }>, call: (task, signal) => Promise<{ content: string }>,
 *   parse: (content, task) => object|null, split?: (task) => Array<object>|null, signal?: AbortSignal,
 *   onProgress?: Function, onResult?: (task, parsed) => void, wait?: Function }} options
 * @returns {Promise<{ results: Map<string, object>, failures: Array<{ key: string, code: string, message?: string }> }>}
 *   results by task key; a split task's halves answer under their own keys.
 */
export async function runCalls({ tasks, call, parse, split, signal, onProgress, onResult, wait = pause }) {
  if (!Array.isArray(tasks)) throw new Error('runCalls needs a list of tasks.');
  if (typeof call !== 'function' || typeof parse !== 'function') throw new Error('runCalls needs call and parse functions.');
  signal?.throwIfAborted();
  const results = new Map();
  const failures = [];
  let stopped = false;
  let done = 0;
  let total = tasks.length;
  const progress = () => {
    done += 1;
    if (typeof onProgress === 'function') { try { onProgress({ done, total }); } catch {} }
  };
  const tell = (task, parsed) => {
    results.set(task.key, parsed);
    if (typeof onResult === 'function') { try { onResult(task, parsed); } catch {} }
  };

  async function ask(task) {
    let waits = 0;
    for (let attempt = 1; ;) {
      let failure;
      try {
        const reply = await call(task, signal);
        const parsed = parse(reply?.content, task);
        if (parsed) return { parsed };
        failure = { code: 'invalid_model_response', retry: true };
      } catch (error) {
        failure = { code: failureCode(error), retry: error?.retry === true, status: error?.status, retryAfter: error?.retryAfter, ...failureMessage(error) };
      }
      const { retry, status, retryAfter, ...recorded } = failure;
      if (!stopped && isRateLimited(failure) && waits < RATE_LIMIT_RETRIES) {
        waits += 1;
        await wait(backoffDelay(waits, retryAfter), signal);
        if (!stopped) continue;
      }
      if (attempt === MAX_ATTEMPTS || !retry || stopped || isRateLimited(failure)) return { failure: recorded };
      attempt += 1;
    }
  }

  async function run(task, depth = 0) {
    const answer = await ask(task);
    if (stopped) return;
    if (answer.parsed) { tell(task, answer.parsed); progress(); return; }
    const halves = answer.failure.code === OUTPUT_LIMIT && depth === 0 && typeof split === 'function' ? split(task) : null;
    if (halves?.length === 2) {
      total += 2;
      progress();
      for (const half of halves) {
        if (stopped) return;
        await run(half, 1);
      }
      return;
    }
    failures.push({ key: task.key, ...answer.failure });
    progress();
  }

  let next = 0;
  async function worker() {
    while (!stopped && next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await run(task);
    }
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { stopped = true; reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, tasks.length) }, worker)), aborted]);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
  }
  return { results, failures };
}
