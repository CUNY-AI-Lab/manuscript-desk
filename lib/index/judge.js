// Two model helpers over the hits of an entry (lib/index/hits.js), each through POST
// /manuscript/api/index/judge: judging ambiguous hits in context (keep or drop, with a reason) and
// sorting hits into the author's subentries. The hits go in batches of one entry, each place numbered
// within its batch and shown with the words around it; an answer counts only for a number it was
// shown. For the ambiguity question a place is one hit, and a drop counts only with evidence: words the
// model copied from that place's own context, which code finds there. For the subentry question a
// place is one page, with the words around each hit on it, since an index files a page, not a hit.
// The decisions are proposals: the page shows them and the author applies or reverses each one.
// Pure: no DOM, no network.

import { normalizeForMatch } from '../rules/quote.js';
import { runCalls } from './runner.js';
import { headingOf } from './termlist.js';
import { searchForms } from './hits.js';

export const JUDGE_TASKS = Object.freeze(['ambiguous', 'subentries']);
export const BATCH_HITS = 40;
export const BATCH_CHARS = 24000;
export const MAX_REASON = 200;
// The words shown for one page of the subentry question: the context of at most this many hits.
export const PAGE_CONTEXTS = 3;
const MIN_EVIDENCE = 4;
export const OPEN = '⟦';
export const CLOSE = '⟧';
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;

const flat = text => String(text ?? '').replace(/\s+/g, ' ');

const contextText = hit => { const { before = '', match = '', after = '' } = hit.context ?? {}; return `${flat(before)}${OPEN}${flat(match)}${CLOSE}${flat(after)}`; };

/** One hit as a line of a batch: its number, its page, the words around it with the hit marked. */
export function hitLine(n, hit) {
  return `[${n}] p. ${hit.page}${hit.top ? ' (first line of the page)' : ''}: ${contextText(hit)}`;
}

/** The hits of one page as a line of a subentry batch: the words around each, at most PAGE_CONTEXTS, an overlapping one left out. */
export function pageLine(n, hits) {
  const shown = [];
  for (const hit of hits) {
    if (shown.length >= PAGE_CONTEXTS) break;
    const last = shown[shown.length - 1];
    if (last && last.formIndex === hit.formIndex && hit.start - last.end < CONTEXT_GAP) continue;
    shown.push(hit);
  }
  const more = hits.length - shown.length;
  return `[${n}] p. ${hits[0].page}: ${shown.map(contextText).join(' / ')}${more > 0 ? ` (${more} more ${more === 1 ? 'place' : 'places'} on the page)` : ''}`;
}
const CONTEXT_GAP = 300;

// The places of a batch: for the ambiguity question each hit alone, for the subentries each page's hits.
function placesOf(task, hits) {
  if (task !== 'subentries') return hits.map(hit => [hit]);
  const byPage = new Map();
  for (const hit of hits) {
    const key = `${hit.pdfIndex}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(hit);
  }
  return [...byPage.values()];
}

function header(task, entry, { reasons = [], subentries = [] } = {}) {
  const lines = [`Index entry: ${entry.text.replace(/\s*\([^)]*\)/g, '')}`, `Searched for: ${searchForms(entry.text, entry.section, { matchCase: true }).join('; ')}`];
  if (entry.section === 'names') lines.push('This entry is a person.');
  if (task === 'ambiguous' && reasons.length) lines.push(`Why its hits are checked: ${reasons.join('; ')}.`);
  if (task === 'subentries') lines.push('Subentries:', ...subentries.map((sub, at) => `[S${at + 1}] ${headingOf(sub.text)}`));
  return lines;
}

/**
 * The batches for one entry: tasks of at most BATCH_HITS places and BATCH_CHARS characters.
 * @returns {Array<{ key: string, task: string, entryId: string, hitIds: string[], places: string[][], contexts: string[], text: string }>}
 *   places[n - 1]: the hit ids of place n; contexts[n - 1]: the words shown for it (not sent apart from the text)
 */
export function buildBatches(task, entry, hits, extra = {}) {
  if (!JUDGE_TASKS.includes(task)) throw new Error(`Unknown task: ${task}`);
  const head = header(task, entry, extra);
  const batches = [];
  let current = null;
  const start = () => { current = { key: `${task}:${entry.id}:${batches.length}`, task, entryId: entry.id, hitIds: [], places: [], contexts: [], lines: [] }; batches.push(current); };
  const lineOf = (n, place) => (task === 'subentries' ? pageLine(n, place) : hitLine(n, place[0]));
  for (const place of placesOf(task, hits)) {
    const line = lineOf((current?.places.length ?? 0) + 1, place);
    const size = current ? head.join('\n').length + current.lines.join('\n').length + line.length : 0;
    if (!current || current.places.length >= BATCH_HITS || size > BATCH_CHARS) start();
    current.places.push(place.map(hit => hit.id));
    current.hitIds.push(...place.map(hit => hit.id));
    current.contexts.push(place.map(contextText).join(' / '));
    current.lines.push(lineOf(current.places.length, place));
  }
  return batches.map(({ lines, ...batch }) => ({ ...batch, text: [...head, task === 'subentries' ? 'Pages found:' : 'Places found:', ...lines].join('\n') }));
}

// A batch cut in two, for an answer that ran out of room.
function halves(batch, hitsById, entry, extra) {
  if (batch.places.length < 2) return null;
  const middle = Math.ceil(batch.places.length / 2);
  return [batch.places.slice(0, middle), batch.places.slice(middle)].map((places, at) => ({
    ...buildBatches(batch.task, entry, places.flat().map(id => hitsById.get(id)), extra)[0],
    key: `${batch.key}.${at}`,
  }));
}

const plain = text => normalizeForMatch(String(text ?? '').replace(new RegExp(`[${OPEN}${CLOSE}]`, 'g'), '')).toLowerCase().replace(/\s+/g, ' ').trim();
/** Whether a drop's evidence is words of the place's own context (the marks aside), of at least MIN_EVIDENCE characters. */
export function evidenceFound(evidence, context) {
  const words = plain(evidence);
  return words.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_EVIDENCE && plain(context).includes(words);
}

function parseJson(content) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  try { return JSON.parse(fenced ? fenced[1] : content); } catch { return null; }
}

/**
 * The decisions of an ambiguity answer, by hit id; null when it does not parse. A drop counts only
 * when its evidence is words of that place's context; one without is left undecided and counted in
 * the map's `unverified`. A kept decision needs none.
 * @returns {Map<string, { keep: boolean, reason: string, evidence?: string }> & { unverified: number }}
 */
export function parseDecisions(content, batch) {
  const data = parseJson(content);
  if (!data || !Array.isArray(data.decisions)) return null;
  const out = Object.assign(new Map(), { unverified: 0 });
  for (const item of data.decisions) {
    const n = Number(item?.hit);
    if (!Number.isInteger(n) || n < 1 || n > batch.places.length || typeof item.keep !== 'boolean') continue;
    const id = batch.places[n - 1][0];
    if (out.has(id)) continue;
    const reason = typeof item.reason === 'string' ? flat(item.reason).trim().slice(0, MAX_REASON) : '';
    if (item.keep) { out.set(id, { keep: true, reason }); continue; }
    const evidence = typeof item.evidence === 'string' ? flat(item.evidence).trim().slice(0, MAX_REASON) : '';
    if (!evidenceFound(evidence, batch.contexts[n - 1])) { out.unverified += 1; continue; }
    out.set(id, { keep: false, reason, evidence });
  }
  return out;
}

/** The subentry of each hit of a sorting answer (an index into the subentries, or null), by hit id. */
export function parseAssignments(content, batch, subentryCount) {
  const data = parseJson(content);
  if (!data || !Array.isArray(data.assignments)) return null;
  const out = new Map();
  for (const item of data.assignments) {
    // "n" is the place's number in its batch; "page" is not read, since a model may give the printed page there.
    const n = Number(item?.n ?? item?.hit);
    if (!Number.isInteger(n) || n < 1 || n > batch.places.length) continue;
    const named = typeof item.subentry === 'string' ? /^S?(\d+)$/i.exec(item.subentry.trim()) : null;
    const at = named ? Number(named[1]) - 1 : null;
    const ids = batch.places[n - 1];
    if (out.has(ids[0])) continue;
    // A page's answer is every hit's on it.
    if (item.subentry === null || item.subentry === 'none') for (const id of ids) out.set(id, null);
    else if (at !== null && at >= 0 && at < subentryCount) for (const id of ids) out.set(id, at);
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
