// Finding the pages an index should not cover (front matter, sections of notes, bibliographies, an
// existing index), through POST /manuscript/api/index/ranges. The model sees each page's opening
// lines and its short lines (where headings are), never whole pages, in windows of pages; it
// proposes ranges, each quoting the heading it saw on the range's first page, and code keeps a
// range only when that heading is on that page. A section that runs on from the previous window is
// joined to the range that ends there. The author then confirms each range; an excluded range's
// first page keeps the text before its heading, since a bibliography often starts in the middle of
// a chapter's last page. Pure: no DOM, no network.

import { runCalls } from './runner.js';
import { normalizeText } from './indexer.js';

export const MATTER_KINDS = Object.freeze(['front-matter', 'notes', 'bibliography', 'index', 'other']);
export const KIND_LABELS = Object.freeze({ 'front-matter': 'Front matter', notes: 'Notes', bibliography: 'Bibliography or references', index: 'An existing index', other: 'Other back matter', manual: 'Excluded by you' });
export const WINDOW_CHARS = 30000;
const OPENING_LINES = 3;
const OPENING_CHARS = 110;
const SHORT_LINE = 60;
const MAX_SHORT = 6;
// Text before a heading on a range's first page that is worth keeping: more than a running head.
const KEEP_BEFORE = 200;
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;

const clip = (text, chars) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** One page as the question shows it: "[12] (printed 4) first lines | short lines". */
export function pageDigest(page, pdfIndex) {
  const lines = String(page.text ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => /\p{L}/u.test(line));
  const opening = lines.slice(0, OPENING_LINES).map(line => clip(line, OPENING_CHARS));
  const short = lines.slice(OPENING_LINES).filter(line => line.length <= SHORT_LINE && /^\p{Lu}|^\d/u.test(line)).slice(0, MAX_SHORT);
  const printed = page.label ? ` (printed ${page.label})` : '';
  const body = lines.length ? [opening.join(' / '), ...(short.length ? [`short lines: ${short.join(' / ')}`] : [])].join(' | ') : '(no text)';
  return `[${pdfIndex + 1}]${printed} ${body}`;
}

/**
 * The windows of page digests, each one call.
 * @param {Array<{ text: string, label?: string }>} pages every page of the PDF, in order
 * @returns {Array<{ key: string, first: number, last: number, text: string }>} first, last: PDF page numbers from 1
 */
export function buildWindows(pages, { chars = WINDOW_CHARS } = {}) {
  const windows = [];
  let lines = [];
  let first = 1;
  let size = 0;
  const flush = last => {
    if (!lines.length) return;
    windows.push({ key: `ranges:${windows.length}`, first, last, text: [`Pages ${first} to ${last} of the ${pages.length} in the PDF.`, ...lines].join('\n') });
    lines = [];
    size = 0;
  };
  pages.forEach((page, at) => {
    const line = pageDigest(page, at);
    if (lines.length && size + line.length + 1 > chars) { flush(at); first = at + 1; }
    lines.push(line);
    size += line.length + 1;
  });
  flush(pages.length);
  return windows;
}

const WORD = /[\p{L}\p{N}]/u;
const fold = text => normalizeText(String(text ?? '')).replace(/\s+/g, ' ').trim();

/** Where a quoted heading stands on a page's text (its index in the folded text), or -1. */
export function headingAt(heading, pageText) {
  const needle = fold(heading).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if ((needle.match(/\p{L}/gu) ?? []).length < 3) return -1;
  const haystack = fold(pageText);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!WORD.test(haystack.charAt(at - 1)) && !WORD.test(haystack.charAt(at + needle.length))) return at;
  }
  return -1;
}

/** The ranges of one answer, checked against the pages; null when it does not parse. */
export function parseRanges(content, window, pages) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try { data = JSON.parse(fenced ? fenced[1] : content); } catch { return null; }
  if (!data || !Array.isArray(data.ranges)) return null;
  const kept = [];
  let rejected = 0;
  for (const item of data.ranges) {
    const first = Number(item?.first);
    const last = Number(item?.last);
    const kind = MATTER_KINDS.includes(item?.kind) ? item.kind : null;
    const continues = item?.continues === true;
    if (!kind || !Number.isInteger(first) || !Number.isInteger(last) || first < window.first || first > last || last > window.last) { rejected += 1; continue; }
    const heading = typeof item.heading === 'string' ? item.heading.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (continues && first === window.first) { kept.push({ kind, first, last, heading: '', continues: true }); continue; }
    if (headingAt(heading, pages[first - 1]?.text ?? '') === -1) { rejected += 1; continue; }
    kept.push({ kind, first, last, heading });
  }
  return { ranges: kept, rejected };
}

/**
 * Joins the windows' ranges: a continuing range is added to a verified range of the same kind that
 * ends on the page before it (or on its first page); one with nothing to join is dropped. Ranges of
 * the same kind that overlap are merged.
 * @returns {{ ranges: Array<{ kind, first, last, heading }>, dropped: number }}
 */
export function joinRanges(found) {
  const sorted = [...found].sort((a, b) => a.first - b.first || (a.continues ? 1 : 0) - (b.continues ? 1 : 0));
  const out = [];
  let dropped = 0;
  for (const range of sorted) {
    const before = [...out].reverse().find(other => other.kind === range.kind && other.last >= range.first - 1);
    if (before) { before.last = Math.max(before.last, range.last); continue; }
    if (range.continues) { dropped += 1; continue; }
    out.push({ kind: range.kind, first: range.first, last: range.last, heading: range.heading });
  }
  return { ranges: out, dropped };
}

/**
 * Asks for the ranges over the whole PDF.
 * @returns {Promise<{ ranges: object[], rejected: number, failures: object[], calls: number }>}
 */
export async function findMatter({ pages, model, callRanges, signal, onProgress, only, wait }) {
  let windows = buildWindows(pages);
  if (Array.isArray(only)) windows = windows.filter(window => only.includes(window.key));
  let rejected = 0;
  const found = [];
  const { failures } = await runCalls({
    tasks: windows,
    call: (window, callSignal) => callRanges({ model, pages: window.text, signal: callSignal }),
    parse: (content, window) => parseRanges(content, window, pages),
    signal,
    onProgress,
    onResult: (window, parsed) => { found.push(...parsed.ranges); rejected += parsed.rejected; },
    wait,
  });
  const joined = joinRanges(found);
  return { ranges: joined.ranges, rejected: rejected + joined.dropped, failures, calls: windows.length };
}

/**
 * The pages with the confirmed ranges taken out: every page of a range is skipped (number null),
 * except that a range's first page keeps the text before its heading when there is more than a
 * running head of it.
 * @param {Array<{ number: string|null, text: string }>} pages
 * @param {Array<{ first: number, last: number, heading?: string }>} ranges PDF page numbers from 1
 * @returns {{ pages: object[], kept: number[] }} kept: PDF page numbers whose first part was kept
 */
export function applyExclusions(pages, ranges) {
  const out = pages.map(page => ({ ...page }));
  const kept = [];
  for (const range of ranges) {
    for (let number = range.first; number <= range.last; number += 1) {
      const page = out[number - 1];
      if (!page) continue;
      if (number === range.first && range.heading) {
        const text = pages[number - 1].text;
        const cut = cutBefore(range.heading, text);
        if (cut > KEEP_BEFORE) { page.text = text.slice(0, cut); kept.push(number); continue; }
      }
      page.number = null;
    }
  }
  return { pages: out, kept };
}

// The position in a page's own text where a heading line begins, found line by line, or -1.
function cutBefore(heading, text) {
  const want = fold(heading);
  let offset = 0;
  for (const line of text.split('\n')) {
    if (want && fold(line).startsWith(want)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

/** Ranges the author types: "1-12, 300-340" (PDF page numbers). Returns null when it cannot be read. */
export function parseManualRanges(text, pageCount) {
  const ranges = [];
  for (const part of String(text ?? '').split(/[,;]/).map(piece => piece.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!match) return null;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > pageCount) return null;
    ranges.push({ kind: 'manual', first, last, heading: '' });
  }
  return ranges;
}
