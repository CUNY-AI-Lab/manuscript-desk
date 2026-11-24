// One unit of the decide step as a short conversation: the unit's text, then at most a few turns in
// which the model calls the tools; the reading tools only in the first READING_TURNS turns of a
// findings unit, after which it is told to decide. The tools run here, on the page's own copy of the
// manuscript; nothing is stored between requests, so the Worker stays stateless. The model's
// answers are recorded as proposals; code judges them afterwards (policy.js, run.js). A refusal for
// the rate limit is asked again after a pause (lib/calls/backoff.js); a reply that runs out of room
// is reported so the caller can halve the unit. Pure apart from the injected `call`.

import { backoffDelay, isRateLimited, pause } from '../calls/backoff.js';
import { paragraphLine } from './units.js';
import { FINAL_TOOL, READING_TOOLS, READING_TURNS } from './tools.js';

export const MAX_TURNS = 5;
// The decide step makes many short calls in a row, so a rate-limit refusal is waited out longer
// than elsewhere: up to six pauses, doubling to half a minute (lib/calls/backoff.js).
export const DECIDE_RATE_RETRIES = 6;
const MAX_READ = 40;
const MAX_FOUND = 15;
const MAX_RESULT = 12000;
export const OUTPUT_LIMIT = 'model_output_limit';
const CLOSED = 'Reading is now closed for this part. Decide every item listed with the tools now.';

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value, n = 600) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').trim().slice(0, n) : '');

/**
 * A session over one unit: the tool handlers and what they recorded.
 * @param {{ unit: object, paragraphs: Array<object>, roleOf: Function }} input
 */
export function createSession({ unit, paragraphs, roleOf }) {
  const items = new Set(unit.items);
  // A findings unit reads only its own chapter (or, for the front and back matter, what lies outside
  // every chapter): nothing else of the manuscript is sent.
  const readable = entry => (unit.range ? entry.index >= unit.range[0] && entry.index <= unit.range[1] : !(unit.outside ?? []).some(([first, last]) => entry.index >= first && entry.index <= last));
  const own = paragraphs.filter(readable);
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const record = { decided: new Map(), cleared: new Map(), triage: new Map(), edits: [], deletions: [], roles: [], malformed: 0, finished: false };
  const undecided = () => unit.items.filter(id => !(unit.kind === 'rules' ? record.triage : record.decided).has(id));
  const left = () => { const rest = undecided(); return rest.length ? `${rest.length} still to decide: ${rest.slice(0, 30).join(', ')}` : 'all decided'; };
  const list = value => (Array.isArray(value) ? value.filter(isObject) : []);
  const handlers = {
    read_paragraphs({ from, to }) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return 'ERROR: from and to must be paragraph numbers, from <= to.';
      const last = Math.min(to, from + MAX_READ - 1);
      const lines = own.filter(entry => entry.index >= from && entry.index <= last && !entry.hints?.empty).map(entry => paragraphLine(entry, roleOf(entry.index)));
      return lines.length ? lines.join('\n') : '(no paragraphs with text there in this part of the manuscript)';
    },
    find_text({ text: wanted }) {
      if (typeof wanted !== 'string' || wanted.trim().length < 2) return 'ERROR: give at least two characters.';
      const needle = wanted.trim().toLocaleLowerCase();
      const hits = own.filter(entry => entry.text.toLocaleLowerCase().includes(needle)).slice(0, MAX_FOUND);
      return hits.length ? hits.map(entry => paragraphLine(entry, roleOf(entry.index), 300)).join('\n') : '(not found)';
    },
    clear_settings({ items: given }) {
      let ignored = 0;
      for (const item of list(given)) {
        if (items.has(item.id)) record.cleared.set(item.id, text(item.reason, 300)); else ignored += 1;
      }
      record.finished = true;
      return `OK: ${record.cleared.size} switched off${ignored ? `; ${ignored} ignored (not a setting listed)` : ''}.`;
    },
    decide_findings({ items: given }) {
      let ignored = 0;
      for (const item of list(given)) {
        if (!items.has(item.id) || !['copyedit', 'ask'].includes(item.choice)) { ignored += 1; continue; }
        record.decided.set(item.id, { choice: item.choice, ...(text(item.question) ? { question: text(item.question) } : {}) });
      }
      if (!undecided().length) record.finished = true;
      return `OK${ignored ? `; ${ignored} ignored (unknown id or choice)` : ''}; ${left()}.`;
    },
    propose_edit({ paragraph, before, after, reason }) {
      if (!byIndex.has(paragraph) || typeof before !== 'string' || typeof after !== 'string') return 'ERROR: give a paragraph number, the words before and after.';
      record.edits.push({ paragraph, before: before.slice(0, 2000), after: after.slice(0, 2000), reason: text(reason, 300) });
      return 'Recorded: code checks it before anything changes.';
    },
    delete_paragraphs({ from, to, reason }) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || !byIndex.has(from) || !byIndex.has(to)) return 'ERROR: from and to must be paragraph numbers, from <= to.';
      record.deletions.push({ from, to, reason: text(reason, 300) });
      return 'Recorded: code checks it before anything changes.';
    },
    set_role({ paragraph, role, reason }) {
      if (!byIndex.has(paragraph) || typeof role !== 'string') return 'ERROR: give a paragraph number and a role.';
      record.roles.push({ paragraph, role, from: roleOf(paragraph), reason: text(reason, 300) });
      return 'Recorded.';
    },
    triage_rules({ items: given }) {
      let ignored = 0;
      for (const item of list(given)) {
        if (!items.has(item.id) || typeof item.status !== 'string') { ignored += 1; continue; }
        record.triage.set(item.id, { status: item.status, ...(typeof item.deliverable === 'string' ? { deliverable: item.deliverable } : {}), ...(text(item.question) ? { question: text(item.question) } : {}) });
      }
      if (!undecided().length) record.finished = true;
      return `OK${ignored ? `; ${ignored} ignored (unknown id)` : ''}; ${left()}.`;
    },
  };
  return { handlers, record, undecided };
}

/**
 * One call through `call`, asked again after a rate-limit refusal (a few times, longer each time)
 * and once after a failure marked retry. Rejects with { code } otherwise.
 */
async function ask(call, request, { signal, wait }) {
  let waits = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call({ ...request, signal });
    } catch (error) {
      signal?.throwIfAborted();
      const failure = { code: typeof error?.code === 'string' ? error.code : 'network_error', retry: error?.retry === true, status: error?.status, retryAfter: error?.retryAfter };
      if (isRateLimited(failure) && waits < DECIDE_RATE_RETRIES) { waits += 1; attempt -= 1; await wait(backoffDelay(waits, failure.retryAfter), signal); continue; }
      if (failure.retry && attempt < 2 && failure.code !== OUTPUT_LIMIT) continue;
      throw failure;
    }
  }
}

/**
 * Runs one unit. Resolves { record, stats } (stats: calls, turns, toolCalls, malformed, readRefused,
 * stopped: 'finished' | 'turns' | 'no_tool_call' | a failure code).
 * @param {{ unit: object, paragraphs: Array<object>, roleOf: Function, call: Function, signal?: AbortSignal, wait?: Function }} input
 */
export async function runUnit({ unit, paragraphs, roleOf, call, signal, wait = pause }) {
  const { handlers, record, undecided } = createSession({ unit, paragraphs, roleOf });
  const messages = [{ role: 'user', content: unit.text }];
  const stats = { calls: 0, turns: 0, toolCalls: 0, malformed: 0, readRefused: 0, stopped: null };
  let quiet = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const reading = unit.kind === 'findings' && turn < READING_TURNS;
    let reply;
    try {
      reply = await ask(call, { kind: unit.kind, reading, messages }, { signal, wait });
    } catch (failure) {
      stats.stopped = failure.code ?? 'failed';
      break;
    }
    stats.calls += 1;
    stats.turns += 1;
    const message = isObject(reply?.message) ? reply.message : {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
    messages.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      quiet += 1;
      if (quiet >= 2) { stats.stopped = 'no_tool_call'; break; }
      messages.push({ role: 'user', content: `Answer with the tools: ${FINAL_TOOL[unit.kind]} for every item listed.` });
      continue;
    }
    for (const toolCall of calls) {
      stats.toolCalls += 1;
      const name = toolCall.function?.name;
      let args = null;
      try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch {}
      let result;
      if (!handlers[name] || !isObject(args)) { stats.malformed += 1; result = 'ERROR: unknown tool or arguments that are not a JSON object.'; }
      else if (!reading && READING_TOOLS.includes(name)) { stats.readRefused += 1; result = `REFUSED: ${CLOSED}`; }
      else result = String(handlers[name](args));
      messages.push({ role: 'tool', tool_call_id: typeof toolCall.id === 'string' ? toolCall.id : `call-${stats.toolCalls}`, content: result.slice(0, MAX_RESULT) });
    }
    if (record.finished) { stats.stopped = 'finished'; break; }
    if (unit.kind === 'findings' && turn + 1 === READING_TURNS) messages.push({ role: 'user', content: CLOSED });
  }
  stats.stopped ??= 'turns';
  return { record, stats, undecided: undecided() };
}
