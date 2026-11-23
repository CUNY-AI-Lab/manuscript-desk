// Stage 1 of the Index Builder: proposing the term list from the manuscript. The manuscript's body
// is cut into passages of whole paragraphs (bibliographies and sections of notes left out) and each
// is asked once, through POST /manuscript/api/index/terms, for the entries an indexer would make;
// each proposal must quote its passage, and one whose quotation is not there is dropped. Code then
// merges the proposals of all passages (the same person named two ways, singular and plural, a form
// that is another entry's variant), counts each entry's occurrences in the manuscript with the
// matcher stage 2 uses, and drops what occurs only in the parts left out. Pure: no DOM, no network.

import { findQuote, normalizeForMatch } from '../rules/quote.js';
import { runCalls } from './runner.js';
import { findHits } from './hits.js';
import { headingOf, lineOf, newEntry, variantsOf } from './termlist.js';

export const KINDS = Object.freeze(['person', 'place', 'organization', 'work', 'event', 'concept']);
export const PASSAGE_CHARS = 9000;
export const MAX_PASSAGE_CHARS = 30000;
const MAX_HEADING = 200;
const MAX_VARIANTS = 8;
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;

// A heading that starts a part an index does not cover, in the manuscript's own words.
const LEFT_OUT_HEADING = /^(?:select(?:ed)?\s+)?(?:bibliography|bibliographie|bibliografia|bibliograf[ií]a|references|reference list|works cited|works consulted|literature cited|sources(?: cited)?|notes|endnotes|literaturverzeichnis|riferimenti bibliografici)\.?$/iu;
const YEAR = /\b(?:1[5-9]\d\d|20\d\d)[a-z]?\b/;
const AUTHOR_START = /^\p{Lu}[\p{L}'’-]+,\s+\p{Lu}/u;
const REPEAT_DASH = /^[—–-]{2,}/;

const isEmpty = entry => (entry?.text ?? '').trim() === '';
// A paragraph that reads like an entry of a bibliography or a note: it starts with a surname and a
// comma, a dash for a repeated author or a note number, or it is short, holds a year and is cut up
// by punctuation as references are (prose with a year in it is not).
const entryLike = text => AUTHOR_START.test(text) || REPEAT_DASH.test(text) || /^\d{1,3}[.)]?\s/.test(text)
  || (YEAR.test(text) && text.length <= 400 && (text.match(/[.,:;]/g) ?? []).length >= 4);

/**
 * The paragraphs left out of stage 1: bibliographies and sections of notes. With the Formatter's
 * paragraph roles for this file, its bibliography headings and entries; otherwise a short heading
 * such as "Bibliography" or "Notes" and the paragraphs after it while they read like entries (two
 * paragraphs in a row that do not end the part).
 * @param {Array<{ index: number, text: string }>} paragraphs
 * @param {Record<number, string>|null} roles
 * @returns {{ left: Set<number>, by: 'roles'|'headings' }}
 */
export function leftOutParagraphs(paragraphs, roles = null) {
  const left = new Set();
  if (roles && Object.keys(roles).length) {
    for (const entry of paragraphs) if (roles[entry.index] === 'bibliography-heading' || roles[entry.index] === 'bibliography-entry') left.add(entry.index);
    return { left, by: 'roles' };
  }
  let inside = false;
  let firstMiss = null;
  for (const entry of paragraphs) {
    const text = (entry.text ?? '').trim();
    if (!text) { if (inside) left.add(entry.index); continue; }
    if (LEFT_OUT_HEADING.test(text)) { inside = true; firstMiss = null; left.add(entry.index); continue; }
    if (!inside) continue;
    if (entryLike(text)) { firstMiss = null; left.add(entry.index); continue; }
    // A short subheading inside a bibliography is one miss; a second in a row ends the part, which
    // then ended before the first.
    if (firstMiss === null) { firstMiss = entry.index; left.add(entry.index); continue; }
    inside = false;
    for (const index of [...left]) if (index >= firstMiss) left.delete(index);
    firstMiss = null;
  }
  return { left, by: 'headings' };
}

/**
 * The passages: runs of whole paragraphs of about PASSAGE_CHARS characters, each line "[index] text".
 * @returns {Array<{ key: string, asked: number[], text: string, raw: string }>} raw: the paragraphs' text, for the quotation check
 */
export function buildTermPassages(paragraphs, { left = new Set(), chars = PASSAGE_CHARS, only = null } = {}) {
  const passages = [];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    const first = current[0].index;
    const last = current[current.length - 1].index;
    passages.push({ key: `terms:${first}-${last}`, asked: current.map(entry => entry.index), text: current.map(entry => `[${entry.index}] ${entry.text}`).join('\n'), raw: current.map(entry => entry.text).join('\n') });
    current = [];
    size = 0;
  };
  for (const entry of paragraphs) {
    if (isEmpty(entry) || left.has(entry.index) || entry.kind === 'other') continue;
    const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PASSAGE_CHARS - 20);
    if (current.length && size + text.length > chars) flush();
    current.push({ index: entry.index, text });
    size += text.length + 10;
  }
  flush();
  return only ? passages.filter(passage => only.includes(passage.key)) : passages;
}

// A passage cut in two at a paragraph, for an answer that ran out of room.
function halves(passage) {
  if (passage.asked.length < 2) return null;
  const lines = passage.text.split('\n');
  const raws = passage.raw.split('\n');
  const middle = Math.ceil(lines.length / 2);
  return [[0, middle], [middle, lines.length]].map(([from, to], at) => ({ key: `${passage.key}.${at}`, asked: passage.asked.slice(from, to), text: lines.slice(from, to).join('\n'), raw: raws.slice(from, to).join('\n') }));
}

const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const list = value => (Array.isArray(value) ? value.map(text).filter(Boolean) : typeof value === 'string' && value.trim() ? [text(value)] : []);

/**
 * The proposals of one answer; null when it does not parse. A proposal whose quotation is not in
 * the passage is counted in `unverified` and left out.
 * @returns {{ proposals: object[], unverified: number }}
 */
export function parseTermsReply(content, passage) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try { data = JSON.parse(fenced ? fenced[1] : content); } catch { return null; }
  if (!data || !Array.isArray(data.entries)) return null;
  const proposals = [];
  let unverified = 0;
  for (const item of data.entries) {
    // Parentheses hold search variants in the term list, so a heading never carries them.
    const heading = text(item?.heading).replace(/\s*\([^)]*\)\s*/g, ' ').trim().slice(0, MAX_HEADING);
    if (!heading || !/\p{L}/u.test(heading)) continue;
    const quote = text(item?.quote);
    if (!findQuote(quote, passage.raw)) { unverified += 1; continue; }
    proposals.push({
      heading,
      kind: KINDS.includes(item?.kind) ? item.kind : 'concept',
      variants: list(item?.variants).filter(variant => !variant.includes('(') && !variant.includes(')')).slice(0, MAX_VARIANTS),
      parent: text(item?.parent).replace(/\s*\([^)]*\)\s*/g, ' ').trim().slice(0, MAX_HEADING) || null,
      see: text(item?.see).slice(0, MAX_HEADING) || null,
      seeAlso: list(item?.seeAlso).slice(0, 5),
      quote,
      passage: passage.key,
    });
  }
  return { proposals, unverified };
}

/**
 * Asks for proposals passage by passage.
 * @returns {Promise<{ byPassage: Map<string, object>, failures: object[], passages: object[] }>}
 */
export async function proposeTerms({ paragraphs, left, model, callTerms, signal, onProgress, onResult, only, wait }) {
  const passages = buildTermPassages(paragraphs, { left, only });
  const byPassage = new Map();
  const { failures } = await runCalls({
    tasks: passages,
    call: (passage, callSignal) => callTerms({ model, passage: passage.text, signal: callSignal }),
    parse: parseTermsReply,
    split: halves,
    signal,
    onProgress,
    onResult: (passage, parsed) => { byPassage.set(passage.key, parsed); onResult?.(passage, parsed); },
    wait,
  });
  return { byPassage, failures, passages };
}

// --- Merging ---

const fold = value => normalizeForMatch(value).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}, ]/gu, ' ').replace(/\s+/g, ' ').trim();
// The singular of a concept's last word, for telling "archive" and "archives" apart from nothing.
const singular = word => (/ies$/.test(word) && word.length > 4 ? `${word.slice(0, -3)}y` : /(ss|us|is)$/.test(word) ? word : /(ches|shes|xes|ses)$/.test(word) ? word.slice(0, -2) : /s$/.test(word) && word.length > 3 ? word.slice(0, -1) : word);
const conceptKey = heading => { const words = fold(heading).replace(/,/g, ' ').split(' ').filter(Boolean); if (words.length) words[words.length - 1] = singular(words[words.length - 1]); return words.join(' '); };

/** A name in index form taken apart: surname, forenames, suffix (null when there is no comma). */
export function nameParts(heading) {
  const parts = heading.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const suffix = parts.length > 2 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(parts[parts.length - 1]) ? parts.pop() : null;
  return { surname: parts[0], forenames: parts.slice(1).join(' ').split(/\s+/).filter(Boolean), suffix };
}

const initialOf = token => fold(token).replace(/\./g, '').charAt(0);
const isInitial = token => /^\p{L}\.?$/u.test(token);
// Two lists of forenames name the same person when one is the start of the other, an initial
// standing for a whole name.
export function compatible(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.length) return true;
  return short.every((token, at) => (isInitial(token) || isInitial(long[at]) ? initialOf(token) === initialOf(long[at]) : fold(token) === fold(long[at])));
}

const fuller = (a, b) => {
  const pa = nameParts(a.heading), pb = nameParts(b.heading);
  const score = (parts, heading) => (parts ? parts.forenames.filter(token => !isInitial(token)).length * 10 + parts.forenames.length * 2 + (parts.suffix ? 1 : 0) : 0) + heading.length / 1000;
  return score(pb, b.heading) > score(pa, a.heading) ? b : a;
};

/**
 * Merges the proposals of all passages into entries of the term list.
 * @param {object[]} proposals from parseTermsReply
 * @returns {object[]} entries (lib/index/termlist.js) with kind, status 'proposed', quotes, passages
 */
export function mergeProposals(proposals) {
  const groups = new Map();
  const keyOf = proposal => (proposal.kind === 'person' && nameParts(proposal.heading) ? `p:${fold(proposal.heading)}` : `${proposal.kind === 'person' ? 'p' : 't'}:${conceptKey(proposal.heading)}`);
  for (const proposal of proposals) {
    if (proposal.parent) continue;
    const key = keyOf(proposal);
    if (!groups.has(key)) groups.set(key, { heading: proposal.heading, kind: proposal.kind, headings: new Map(), variants: new Set(), quotes: [], passages: new Set(), see: new Set(), seeAlso: new Set(), subentries: new Map(), kinds: new Map() });
    const group = groups.get(key);
    group.headings.set(proposal.heading, (group.headings.get(proposal.heading) ?? 0) + 1);
    group.kinds.set(proposal.kind, (group.kinds.get(proposal.kind) ?? 0) + 1);
    proposal.variants.forEach(variant => group.variants.add(variant));
    if (group.quotes.length < 3) group.quotes.push(proposal.quote);
    group.passages.add(proposal.passage);
    if (proposal.see) group.see.add(proposal.see);
    proposal.seeAlso.forEach(target => group.seeAlso.add(target));
  }
  // The most frequent form of a concept's heading; persons are settled below.
  for (const group of groups.values()) {
    group.heading = [...group.headings].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    group.kind = [...group.kinds].sort((a, b) => b[1] - a[1])[0][0];
  }
  let list = [...groups.values()];
  // The same person named two ways: same surname, compatible forenames, into the fullest form.
  const persons = list.filter(group => group.kind === 'person' && nameParts(group.heading));
  const absorbed = new Set();
  for (const group of persons) {
    if (absorbed.has(group)) continue;
    const parts = nameParts(group.heading);
    for (const other of persons) {
      if (other === group || absorbed.has(other)) continue;
      const otherParts = nameParts(other.heading);
      if (fold(otherParts.surname) !== fold(parts.surname) || !compatible(parts.forenames, otherParts.forenames)) continue;
      // Merge only when no third person with the surname could also be meant.
      const rivals = persons.filter(third => third !== group && third !== other && !absorbed.has(third) && fold(nameParts(third.heading).surname) === fold(parts.surname) && (compatible(nameParts(third.heading).forenames, otherParts.forenames) || compatible(nameParts(third.heading).forenames, parts.forenames)));
      if (rivals.length) continue;
      const keep = fuller(group, other);
      const lose = keep === group ? other : group;
      absorb(keep, lose);
      absorbed.add(lose);
      if (lose === group) break;
    }
  }
  list = list.filter(group => !absorbed.has(group));
  // A form that is the heading of one entry and a variant of exactly one other is the same entry;
  // so is a bare surname given alone when only one person in the list bears it.
  const absorbed2 = new Set();
  for (const group of list) {
    const own = fold(group.heading);
    const hosts = list.filter(other => other !== group && !absorbed2.has(other) && ([...other.variants].some(variant => fold(variant) === own)
      || (!nameParts(group.heading) && other.kind === 'person' && group.kind === 'person' && fold(nameParts(other.heading)?.surname ?? '') === own)));
    if (hosts.length === 1 && !absorbed2.has(group)) {
      absorb(hosts[0], group);
      absorbed2.add(group);
    }
  }
  list = list.filter(group => !absorbed2.has(group));
  // Subentries the model proposed, under the entry they name.
  const byHeading = new Map(list.map(group => [fold(group.heading), group]));
  for (const proposal of proposals) {
    if (!proposal.parent) continue;
    const host = byHeading.get(fold(proposal.parent)) ?? list.find(group => [...group.variants].some(variant => fold(variant) === fold(proposal.parent)));
    if (!host) continue;
    const key = fold(proposal.heading);
    if (!host.subentries.has(key) && host.subentries.size < 20) host.subentries.set(key, lineOf(proposal.heading, proposal.variants));
  }
  const taken = new Set();
  return list.map(group => {
    const variants = [...group.variants].filter(variant => fold(variant) !== fold(group.heading) && !variant.includes(';'));
    const entry = newEntry({
      section: group.kind === 'person' ? 'names' : 'terms',
      text: lineOf(group.heading, variants),
      subentries: [...group.subentries.values()].map(sub => ({ text: sub })),
      see: [...group.see].filter(target => fold(target) !== fold(group.heading)).slice(0, 3),
      seeAlso: [...group.seeAlso].filter(target => fold(target) !== fold(group.heading)).slice(0, 5),
      taken,
      kind: group.kind,
      status: 'proposed',
      quotes: group.quotes,
      passages: group.passages.size,
    });
    taken.add(entry.id);
    return entry;
  });

  function absorb(keep, lose) {
    keep.variants.add(lose.heading);
    lose.variants.forEach(variant => keep.variants.add(variant));
    // A bare surname is a search form of the full name: it stays a variant.
    for (const [heading, count] of lose.headings) keep.headings.set(heading, (keep.headings.get(heading) ?? 0) + count);
    keep.quotes.push(...lose.quotes.slice(0, Math.max(0, 3 - keep.quotes.length)));
    lose.passages.forEach(passage => keep.passages.add(passage));
    lose.see.forEach(target => keep.see.add(target));
    lose.seeAlso.forEach(target => keep.seeAlso.add(target));
    for (const [key, sub] of lose.subentries) if (!keep.subentries.has(key)) keep.subentries.set(key, sub);
    keep.heading = keep.kind === 'person' ? fuller(keep, lose).heading : keep.heading;
    // A name in index order is searched in the order the text uses ("T. S. Eliot"), so that order is the variant kept.
    const parts = nameParts(lose.heading);
    if (parts) {
      keep.variants.delete(lose.heading);
      keep.variants.add([...parts.forenames, parts.surname].join(' '));
    }
  }
}

/**
 * Each entry's occurrences in the manuscript, counted with stage 2's matcher, in the paragraphs
 * read and in those left out; entries found only in the left-out paragraphs are dropped.
 * @returns {{ entries: object[], dropped: object[] }} entries carry `count` and `countLeftOut`
 */
export function countAndDrop(entries, paragraphs, left = new Set()) {
  const asPages = keep => paragraphs.map(entry => ({ number: keep(entry) ? String(entry.index) : null, text: entry.text ?? '' }));
  const inBody = findHits(asPages(entry => !left.has(entry.index)), entries, { contextFor: new Set() }).byEntry;
  // A bibliography gives names surname first ("Example, Ada."), which the search in direct order does
  // not find, so there a person is also looked for by the surname alone.
  const bySurname = entries.map(entry => {
    const parts = entry.section === 'names' ? nameParts(headingOf(entry.text)) : null;
    return parts ? { ...entry, text: lineOf(headingOf(entry.text), [...variantsOf(entry.text), parts.surname]) } : entry;
  });
  const inLeft = left.size ? findHits(asPages(entry => left.has(entry.index)), bySurname, { contextFor: new Set() }).byEntry : new Map();
  const kept = [];
  const dropped = [];
  for (const entry of entries) {
    const count = inBody.get(entry.id)?.hits.length ?? 0;
    const countLeftOut = inLeft.get(entry.id)?.hits.length ?? 0;
    const counted = { ...entry, count, countLeftOut };
    if (count === 0 && countLeftOut > 0) dropped.push(counted);
    else kept.push(counted);
  }
  return { entries: kept, dropped };
}

/** The variants of an entry other than its heading, for the editor. */
export const entryVariants = entry => variantsOf(entry.text);
