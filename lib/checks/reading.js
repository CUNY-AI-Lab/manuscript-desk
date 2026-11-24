// The reading check: a model reads each chapter's opening (its title block, abstract and keywords,
// its headings and the first stretch of its running text) and reports the problems an editor would
// query that only reading shows: the same thing named or spelled two ways, a name or affiliation
// that differs between two places, missing spaces and typing slips, stray or repeated text, an
// abstract or keywords out of line with the rule sheet in a way counting cannot show. Model output is
// never trusted: a finding is kept only when it names a paragraph it was shown and quotes words that
// occur in that paragraph (findQuote), and a finding that compares two places must quote the other
// place too. Findings become comments and To-dos entries, never changes to the text. The call is
// injected (the browser passes a wrapper over POST /manuscript/api/reading; tests pass a fake).
// Pure: no DOM, no network.

import { findQuote, normalizeForMatch } from '../rules/quote.js';
import { RATE_LIMIT_RETRIES, backoffDelay, isRateLimited, pause } from '../calls/backoff.js';
import { checkContext } from './context.js';
import { notesByChapter } from './front.js';

/** The kinds of problem the reading reports, each with the line the prompt gives the model. */
export const READING_KINDS = Object.freeze({
  'wording-inconsistent': 'the same thing (a person, a work, a term, a title or a count) named, spelled or given differently in two places',
  'affiliation-inconsistent': 'an author\'s name or institution given differently in two places',
  'missing-spaces': 'words run together, or no space after a punctuation mark',
  typo: 'a typing slip: a misspelled or doubled word, a wrong, missing or extra letter',
  'stray-or-duplicated-text': 'a stray character, symbol or fragment that does not belong to the sentence, or a passage repeated',
  'abstract-against-rules': 'an abstract or keywords that do not do what a rule listed with the chapter asks, in a way that counting words or keywords cannot show',
});
/** The kinds that compare two places: a finding of these must quote both. */
export const PAIRED = new Set(['wording-inconsistent', 'affiliation-inconsistent']);

// What a unit shows of a chapter: these roles whole, then running text up to BODY_CHARS characters.
const OPENING_ROLES = new Set(['title-block', 'epigraph', 'abstract', 'keywords']);
const HEADING_ROLES = new Set(['heading-1', 'heading-2', 'heading-3']);
const RUNNING_ROLES = new Set(['body', 'block-quotation', 'verse', 'list-item']);
export const BODY_CHARS = 8000;
const RULE_CATEGORIES = new Set(['abstract-keywords', 'title-page']);
const MAX_RULES_LISTED = 12;
const MAX_FINDINGS = 12;
const MAX_NOTE = 300;
const MAX_QUOTE = 300;
const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const OUTPUT_LIMIT = 'model_output_limit';
// The roles of the front and back matter the reading shows: a book's title page, its contents list,
// the headings of its sections and part titles, and the notes on contributors no chapter took.
const MATTER_ROLES = new Set(['title-page', 'front-matter-heading', 'contents-entry', 'part-title', 'contributor-note']);
const ROLE_NAMES = { 'title-block': 'title block', epigraph: 'epigraph', abstract: 'abstract', keywords: 'keywords', 'heading-1': 'heading', 'heading-2': 'subheading', 'heading-3': 'subheading', body: 'text', 'block-quotation': 'block quotation', verse: 'verse', 'list-item': 'list item',
  'title-page': 'book title page', 'front-matter-heading': 'section heading', 'contents-entry': 'contents list', 'part-title': 'part title', 'contributor-note': 'note on a contributor' };
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const oneLine = text => String(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').replace(/\s+/gu, ' ').trim();
/** The sign that stands for a note reference in the text the model reads (the reader's text has none). */
export const NOTE_SIGN = '\u207F';
// A paragraph's text with the note sign where its note references stand.
function withNotes(entry) {
  const notes = Array.isArray(entry.notes) ? [...entry.notes].sort((a, b) => b - a) : [];
  let text = entry.text.replaceAll(NOTE_SIGN, '');
  for (const at of notes) text = `${text.slice(0, at)}${NOTE_SIGN}${text.slice(at)}`;
  return text;
}

const LEFT_OUT = '(the rest of the running text is left out)';

// A unit from its lines: the request text, and the paragraphs it shows.
function makeUnit({ chapter, first, ruleLines, rules, lines, shown }) {
  const notes = lines.filter(entry => entry.note);
  const text = [
    ...(ruleLines.length ? ['Rules from the publisher\'s guidelines about the title block, the abstract and the keywords:', ...ruleLines, ''] : []),
    chapter === null ? 'The book\'s front and back matter:' : 'The chapter\'s opening:',
    ...lines.filter(entry => !entry.note).map(entry => entry.line),
    ...(notes.length ? ['', 'The notes on this chapter\'s authors, from the book\'s notes on contributors:', ...notes.map(entry => entry.line)] : []),
  ].join('\n');
  return { chapter, first, text, shown, rules, ruleLines, lines };
}

/**
 * A unit cut in two for a reply that ran out of room: each half keeps the title block, abstract,
 * keywords and headings and takes half of the running text. Null when there is too little to cut.
 */
export function halveUnit(unit) {
  const running = unit.lines.filter(entry => entry.running);
  if (running.length < 2) return null;
  const cut = new Set(running.slice(0, Math.ceil(running.length / 2)).map(entry => entry.index));
  return [true, false].map(firstHalf => {
    const lines = unit.lines.filter(entry => !entry.running || cut.has(entry.index) === firstHalf).filter(entry => entry.index !== null || !firstHalf);
    const kept = new Set(lines.map(entry => entry.index));
    const shown = new Map([...unit.shown].filter(([index]) => kept.has(index)));
    return makeUnit({ ...unit, lines: firstHalf ? [...lines, { index: null, running: false, line: LEFT_OUT }] : lines, shown });
  });
}

/**
 * The units the reading check sends, one per chapter that has text to read: the request text and
 * the paragraphs it shows, by index.
 * @param {{ paragraphs: Array<object>, roles: Record<number, string>, chapters: Array<{ first: number, last: number }>, sheet?: object | null, bodyChars?: number }} input
 * @returns {Array<{ chapter: number, first: number, text: string, shown: Map<number, string> }>}
 */
export function readingUnits({ paragraphs, roles, chapters, sheet = null, bodyChars = BODY_CHARS }) {
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const rules = (sheet?.rules ?? []).filter(rule => rule.enabled !== false && RULE_CATEGORIES.has(rule.category)).slice(0, MAX_RULES_LISTED);
  const ruleLines = rules.map((rule, at) => `R${at + 1}. ${oneLine(rule.statement)}`);
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  // Each chapter's authors' notes on contributors go with it; the notes no chapter took, with the
  // rest of the front and back matter, make a unit of their own.
  const notes = notesByChapter(checkContext({ paragraphs, roles, report: { chapters }, sheet }));
  const noteLine = index => ({ index, running: false, note: true, line: `[${index}] (${ROLE_NAMES['contributor-note']}) ${oneLine(withNotes(byIndex.get(index)))}` });
  const units = [];
  (chapters ?? []).forEach((chapter, at) => {
    const inChapter = paragraphs.filter(entry => entry.index >= chapter.first && entry.index <= chapter.last && entry.hints?.empty === false && entry.text.trim());
    const shown = new Map();
    const lines = [];
    let running = 0;
    for (const entry of inChapter) {
      const role = roleOf(entry.index);
      const opening = OPENING_ROLES.has(role) || HEADING_ROLES.has(role);
      const fits = RUNNING_ROLES.has(role) && running < bodyChars;
      if (!opening && !fits) {
        if (RUNNING_ROLES.has(role) && !lines.some(line => line.index === null)) lines.push({ index: null, running: false, line: LEFT_OUT });
        continue;
      }
      if (fits) running += entry.text.length;
      shown.set(entry.index, entry.text);
      lines.push({ index: entry.index, running: !opening, line: `[${entry.index}] (${ROLE_NAMES[role]}) ${oneLine(withNotes(entry))}` });
    }
    for (const index of notes.byChapter.get(at) ?? []) {
      shown.set(index, byIndex.get(index).text);
      lines.push(noteLine(index));
    }
    if (!shown.size) return;
    units.push(makeUnit({ chapter: at, first: chapter.first, ruleLines, rules: rules.map(rule => rule.id), lines, shown }));
  });
  const inChapter = index => (chapters ?? []).some(chapter => index >= chapter.first && index <= chapter.last);
  const rest = new Set(notes.rest);
  const matter = paragraphs.filter(entry => entry.hints?.empty === false && entry.text.trim() && !inChapter(entry.index)
    && MATTER_ROLES.has(roleOf(entry.index)) && (roleOf(entry.index) !== 'contributor-note' || rest.has(entry.index)));
  if (matter.length) {
    const shown = new Map(matter.map(entry => [entry.index, entry.text]));
    const lines = matter.map(entry => ({ index: entry.index, running: false, line: `[${entry.index}] (${ROLE_NAMES[roleOf(entry.index)]}) ${oneLine(withNotes(entry))}` }));
    units.unshift(makeUnit({ chapter: null, first: matter[0].index, ruleLines: [], rules: [], lines, shown }));
  }
  return units;
}

/**
 * The reading's findings that a code check has not already made: a model's query of the same kind
 * at the same paragraph as a check's finding is left out, so the author is not asked twice.
 */
export function withoutRepeats(found, findings) {
  const made = new Set(findings.map(finding => `${finding.kind}\u0000${finding.paragraphIndex}`));
  return found.filter(finding => !made.has(`${finding.kind}\u0000${finding.paragraph}`));
}

// A quotation the model gives for a place, checked against that paragraph's text (the note signs
// it was shown taken out first); `noted` says whether the quotation held one.
function placeOf(value, unit) {
  if (!isObject(value)) return null;
  const paragraph = Number(value.paragraph);
  if (!Number.isInteger(paragraph) || !unit.shown.has(paragraph)) return null;
  const given = typeof value.quote === 'string' ? oneLine(value.quote).slice(0, MAX_QUOTE) : '';
  const quote = oneLine(given.replaceAll(NOTE_SIGN, ''));
  if (!quote || !findQuote(quote, unit.shown.get(paragraph))) return null;
  return { paragraph, quote, noted: given.includes(NOTE_SIGN) };
}

/**
 * The findings of one reply that hold up: a known kind, a paragraph the unit showed, a quotation
 * that occurs in it, and for a paired kind a second place, also quoted, that says something else.
 * Null when the reply does not parse; `dropped` counts the findings that did not hold up.
 * @returns {{ findings: Array<{ kind, paragraph, quote, other?: { paragraph, quote }, note, rule: string | null }>, dropped: number } | null}
 */
export function parseReadingReply(content, unit) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return null;
  }
  if (!isObject(data) || !Array.isArray(data.findings)) return null;
  const findings = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of data.findings.slice(0, MAX_FINDINGS * 2)) {
    const kind = isObject(raw) && Object.hasOwn(READING_KINDS, raw.kind) ? raw.kind : null;
    const here = kind ? placeOf(raw, unit) : null;
    const other = here && PAIRED.has(kind) ? placeOf(raw.other, unit) : null;
    const differs = other && normalizeForMatch(other.quote) !== normalizeForMatch(here.quote);
    // Words run together across a note reference are not missing a space: the note stands there.
    const atNote = kind === 'missing-spaces' && here?.noted;
    if (!here || atNote || (PAIRED.has(kind) && !differs)) { dropped += 1; continue; }
    const key = `${kind}\u0000${here.paragraph}\u0000${normalizeForMatch(here.quote)}`;
    if (seen.has(key) || findings.length >= MAX_FINDINGS) { dropped += 1; continue; }
    seen.add(key);
    const note = typeof raw.note === 'string' ? oneLine(raw.note).slice(0, MAX_NOTE) : '';
    const ruleAt = typeof raw.rule === 'string' ? /^R(\d{1,2})$/u.exec(raw.rule.trim()) : null;
    const rule = kind === 'abstract-against-rules' && ruleAt ? unit.rules?.[Number(ruleAt[1]) - 1] ?? null : null;
    findings.push({ kind, paragraph: here.paragraph, quote: here.quote, ...(other ? { other: { paragraph: other.paragraph, quote: other.quote } } : {}), note, rule });
  }
  return { findings, dropped };
}

/**
 * Reads every unit through `call` (resolving the model's reply text), at most MAX_IN_FLIGHT at a
 * time: retried once after a reply that does not parse or a rejection marked retry, and after a
 * rate-limit refusal up to RATE_LIMIT_RETRIES times with longer pauses. A unit whose reply runs out
 * of output room (the model's thinking took it) is read again as two halves (halveUnit), and a half
 * that runs out again is asked once more. A unit that still fails is recorded, with the findings
 * of any half that was read, and the run goes on.
 * @param {{ units: Array<object>, model: string, call: (request: { model: string, unit: string, signal?: AbortSignal }) => Promise<string>, signal?: AbortSignal, onProgress?: Function, wait?: Function }} input
 * @returns {Promise<{ findings: Array<object>, failures: Array<{ chapter: number, code: string }>, dropped: number }>}
 */
export async function readChapters({ units, model, call, signal, onProgress, wait = pause }) {
  if (typeof call !== 'function') throw new Error('readChapters needs a call function.');
  signal?.throwIfAborted();
  const results = new Array(units.length);
  let next = 0;
  let done = 0;
  // A unit's findings; one whose reply runs out of room is read again as two halves, once each.
  async function readUnit(unit, whole = true) {
    let waits = 0;
    for (let attempt = 1; ;) {
      let failure;
      try {
        const parsed = parseReadingReply(await call({ model, unit: unit.text, signal }), unit);
        if (parsed) return parsed;
        failure = { code: 'invalid_model_response', retry: true };
      } catch (error) {
        signal?.throwIfAborted();
        const code = typeof error?.code === 'string' && error.code ? error.code : 'network_error';
        // A reply that ran out of room (the model's thinking took it) is asked once more.
        failure = { code, retry: error?.retry === true || code === OUTPUT_LIMIT, status: error?.status, retryAfter: error?.retryAfter };
      }
      if (isRateLimited(failure) && waits < RATE_LIMIT_RETRIES) {
        waits += 1;
        await wait(backoffDelay(waits, failure.retryAfter), signal);
        continue;
      }
      const halves = whole && failure.code === OUTPUT_LIMIT ? halveUnit(unit) : null;
      if (halves) {
        const read = [];
        for (const half of halves) read.push(await readUnit(half, false));
        const findings = [];
        const seen = new Set();
        for (const finding of read.flatMap(result => result.findings ?? [])) {
          const key = `${finding.kind}\u0000${finding.paragraph}\u0000${normalizeForMatch(finding.quote)}`;
          if (!seen.has(key)) { seen.add(key); findings.push(finding); }
        }
        const failed = read.find(result => result.failure);
        return { findings, dropped: read.reduce((sum, result) => sum + (result.dropped ?? 0), 0), ...(failed ? { failure: failed.failure } : {}) };
      }
      if (attempt === MAX_ATTEMPTS || !failure.retry || isRateLimited(failure)) return { failure: { code: failure.code } };
      attempt += 1;
    }
  }
  async function worker() {
    while (next < units.length) {
      const at = next;
      next += 1;
      results[at] = await readUnit(units[at]);
      done += 1;
      try { onProgress?.({ done, total: units.length }); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, units.length) }, worker));
  const findings = [];
  const failures = [];
  let dropped = 0;
  results.forEach((result, at) => {
    if (result.failure) failures.push({ chapter: units[at].chapter, ...result.failure });
    dropped += result.dropped ?? 0;
    for (const finding of result.findings ?? []) findings.push({ ...finding, chapter: units[at].chapter });
  });
  return { findings, failures, dropped };
}

/**
 * The reading's findings in the shape of the To-do checks' findings, with a message in plain words
 * that says the model proposed it and quotes the place (and the other place it differs from).
 */
export function readingFindings(found) {
  return found.map(finding => {
    const parts = [`Query from a model's reading of the text, for you to check: ${finding.note || 'please check this passage.'}`, `Here: “${finding.quote}”`];
    if (finding.other) parts.push(`Elsewhere: “${finding.other.quote}”`);
    return { kind: finding.kind, chapter: finding.chapter, paragraphIndex: finding.paragraph, ruleId: finding.rule ?? null, message: parts.join('\n'), check: 'reading', ...(finding.other ? { other: { paragraph: finding.other.paragraph } } : {}) };
  });
}
