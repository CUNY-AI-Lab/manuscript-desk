// Two model helpers over the hits of an entry (lib/index/hits.js), each through POST
// /manuscript/api/index/judge: judging ambiguous hits in context (keep or drop, with a reason) and
// sorting hits into the author's subentries. The hits go in batches, each hit numbered within its
// batch and shown with the words around it; an answer counts only for a number it was shown. The
// decisions are proposals: the page shows them and the author applies or reverses each one.
// Pure: no DOM, no network.

import { runCalls } from './runner.js';
import { headingOf } from './termlist.js';
import { searchForms } from './hits.js';

export const JUDGE_TASKS = Object.freeze(['ambiguous', 'subentries']);
export const BATCH_HITS = 40;
export const BATCH_CHARS = 24000;
export const MAX_REASON = 200;
export const OPEN = '⟦';
export const CLOSE = '⟧';
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;

const flat = text => String(text ?? '').replace(/\s+/g, ' ');

/** One hit as a line of a batch: its number, its page, the words around it with the hit marked. */
export function hitLine(n, hit) {
  const { before = '', match = '', after = '' } = hit.context ?? {};
  return `[${n}] p. ${hit.page}: ${flat(before)}${OPEN}${flat(match)}${CLOSE}${flat(after)}`;
}

function header(task, entry, { reasons = [], subentries = [] } = {}) {
  const lines = [`Index entry: ${entry.text.replace(/\s*\([^)]*\)/g, '')}`, `Searched for: ${searchForms(entry.text, entry.section, { matchCase: true }).join('; ')}`];
  if (entry.section === 'names') lines.push('This entry is a person.');
  if (task === 'ambiguous' && reasons.length) lines.push(`Why its hits are checked: ${reasons.join('; ')}.`);
  if (task === 'subentries') lines.push('Subentries:', ...subentries.map((sub, at) => `[S${at + 1}] ${headingOf(sub.text)}`));
  return lines;
}

/**
 * The batches for one entry: tasks of at most BATCH_HITS hits and BATCH_CHARS characters.
 * @returns {Array<{ key: string, task: string, entryId: string, hitIds: string[], text: string }>}
 */
export function buildBatches(task, entry, hits, extra = {}) {
  if (!JUDGE_TASKS.includes(task)) throw new Error(`Unknown task: ${task}`);
  const head = header(task, entry, extra);
  const batches = [];
  let current = null;
  const start = () => { current = { key: `${task}:${entry.id}:${batches.length}`, task, entryId: entry.id, hitIds: [], lines: [] }; batches.push(current); };
  for (const hit of hits) {
    const line = hitLine((current?.hitIds.length ?? 0) + 1, hit);
    const size = current ? head.join('\n').length + current.lines.join('\n').length + line.length : 0;
    if (!current || current.hitIds.length >= BATCH_HITS || size > BATCH_CHARS) start();
    current.hitIds.push(hit.id);
    current.lines.push(hitLine(current.hitIds.length, hit));
  }
  return batches.map(({ lines, ...batch }) => ({ ...batch, text: [...head, 'Places found:', ...lines].join('\n') }));
}

// A batch cut in two, for an answer that ran out of room.
function halves(batch, hitsById, entry, extra) {
  if (batch.hitIds.length < 2) return null;
  const middle = Math.ceil(batch.hitIds.length / 2);
  return [batch.hitIds.slice(0, middle), batch.hitIds.slice(middle)].map((ids, at) => ({
    ...buildBatches(batch.task, entry, ids.map(id => hitsById.get(id)), extra)[0],
    key: `${batch.key}.${at}`,
  }));
}

function parseJson(content) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  try { return JSON.parse(fenced ? fenced[1] : content); } catch { return null; }
}

/** The decisions of an ambiguity answer, by hit id; null when it does not parse. */
export function parseDecisions(content, batch) {
  const data = parseJson(content);
  if (!data || !Array.isArray(data.decisions)) return null;
  const out = new Map();
  for (const item of data.decisions) {
    const n = Number(item?.hit);
    if (!Number.isInteger(n) || n < 1 || n > batch.hitIds.length || typeof item.keep !== 'boolean') continue;
    const id = batch.hitIds[n - 1];
    if (!out.has(id)) out.set(id, { keep: item.keep, reason: typeof item.reason === 'string' ? flat(item.reason).trim().slice(0, MAX_REASON) : '' });
  }
  return out;
}

/** The subentry of each hit of a sorting answer (an index into the subentries, or null), by hit id. */
export function parseAssignments(content, batch, subentryCount) {
  const data = parseJson(content);
  if (!data || !Array.isArray(data.assignments)) return null;
  const out = new Map();
  for (const item of data.assignments) {
    const n = Number(item?.hit);
    if (!Number.isInteger(n) || n < 1 || n > batch.hitIds.length) continue;
    const named = typeof item.subentry === 'string' ? /^S?(\d+)$/i.exec(item.subentry.trim()) : null;
    const at = named ? Number(named[1]) - 1 : null;
    const id = batch.hitIds[n - 1];
    if (out.has(id)) continue;
    if (item.subentry === null || item.subentry === 'none') out.set(id, null);
    else if (at !== null && at >= 0 && at < subentryCount) out.set(id, at);
  }
  return out;
}

/** The plan of a run, said before it starts: how many hits and how many calls. */
export function judgePlan(task, entries, byEntry, extra = () => ({})) {
  let hits = 0, calls = 0;
  for (const entry of entries) {
    const found = byEntry.get(entry.id)?.hits ?? [];
    hits += found.length;
    calls += found.length ? buildBatches(task, entry, found, extra(entry)).length : 0;
  }
  return { hits, calls };
}

/**
 * Runs one of the two helpers over some entries.
 * @param {{ task: 'ambiguous'|'subentries', entries: object[], byEntry: Map, model: string,
 *   callJudge: Function, reasons?: Map<string, string[]>, only?: string[], signal?: AbortSignal,
 *   onProgress?: Function, onResult?: Function, wait?: Function }} options
 *   only: batch keys to ask again (the failures of an earlier run)
 * @returns {Promise<{ answers: Map<string, object>, failures: object[], batches: number }>} answers by hit id:
 *   { keep, reason } for ambiguous, the subentry index or null for subentries
 */
export async function runJudge({ task, entries, byEntry, model, callJudge, reasons = new Map(), only, signal, onProgress, onResult, wait }) {
  if (!JUDGE_TASKS.includes(task)) throw new Error(`Unknown task: ${task}`);
  const extraOf = entry => ({ reasons: reasons.get(entry.id) ?? [], subentries: entry.subentries ?? [] });
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const hitsById = new Map();
  let tasks = [];
  for (const entry of entries) {
    const hits = byEntry.get(entry.id)?.hits ?? [];
    if (!hits.length || (task === 'subentries' && !entry.subentries?.length)) continue;
    for (const hit of hits) hitsById.set(hit.id, hit);
    tasks.push(...buildBatches(task, entry, hits, extraOf(entry)));
  }
  if (Array.isArray(only)) tasks = tasks.filter(batch => only.includes(batch.key));
  const answers = new Map();
  const { failures } = await runCalls({
    tasks,
    call: (batch, callSignal) => callJudge({ model, task, text: batch.text, signal: callSignal }),
    parse: (content, batch) => (task === 'ambiguous' ? parseDecisions(content, batch) : parseAssignments(content, batch, byId.get(batch.entryId).subentries.length)),
    split: batch => halves(batch, hitsById, byId.get(batch.entryId), extraOf(byId.get(batch.entryId))),
    signal,
    onProgress,
    onResult: (batch, parsed) => {
      for (const [id, answer] of parsed) answers.set(id, answer);
      onResult?.(batch, parsed);
    },
    wait,
  });
  return { answers, failures, batches: tasks.length };
}
