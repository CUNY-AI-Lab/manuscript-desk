// The Index Builder page's decisions, as pure functions that load under Node: editing the term list,
// what the index holds once the author's choices are applied, what is kept in this browser (never
// the PDF, the manuscript or text from them) and how it comes back, the plans said before a model
// helper runs, and the index conventions read from a Formatter rule sheet. app.js draws them.

import { SHEET_VERSION, validateSheet } from '../../lib/rules/schema.js';
import { headingOf, lineOf, newEntry, parseTermList, serializeTermList, variantsOf, SECTIONS } from '../../lib/index/termlist.js';
import { LAYOUTS, SORTINGS } from '../../lib/index/format.js';
import { RANGE_STYLES } from '../../lib/index/ranges.js';
import { buildTermPassages, corporateName, indexFormOfName, nameParts } from '../../lib/index/terms.js';
import { reverseName } from '../../lib/index/indexer.js';
import { DEFAULT_FILTER, PAGE_CHOICES } from '../../lib/index/rank.js';

export const SAVED_KEY = 'index';
export const STORE_NAME = 'manuscript-desk-index';
export const STATUSES = Object.freeze(['proposed', 'accepted', 'dropped']);
export const DEFAULT_SETTINGS = Object.freeze({ pageOne: '', matchCase: false, layout: 'indented', style: 'chicago', sorting: 'letter-by-letter', collapse: true, filter: DEFAULT_FILTER });
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// --- The term list ---

/** Entries read from a file or pasted text are the author's own: accepted. */
export function entriesFromText(text, existing = []) {
  const taken = new Set(existing.map(entry => entry.id));
  const { entries, problems } = parseTermList(text);
  return { entries: entries.map(entry => ({ ...entry, id: taken.has(entry.id) ? newEntry({ ...entry, id: undefined, taken }).id : entry.id, status: 'accepted' })), problems };
}

// --- The two boxes: Names and Subjects ---

export const GROUPS = Object.freeze(['names', 'terms']);
export const GROUP_LABELS = Object.freeze({ names: 'Names', terms: 'Subjects' });
const SECTION_LINE = /^\s*(terms|names)\s*:\s*$/im;
const AMBIGUOUS_MARK = /\s+\[ambiguous\]\s*$/i;
const indentOf = line => /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;

// The lines of a box that start an entry (not a subentry or a cross-reference indented under one).
function entryLines(text) {
  const lines = String(text ?? '').split(/\r\n?|\n/);
  const content = lines.filter(line => line.trim());
  const common = content.length ? Math.min(...content.map(indentOf)) : 0;
  return lines.map(line => ({ line, entry: Boolean(line.trim()) && indentOf(line) <= common }));
}

/** A line of the Names box in index form: its heading through indexFormOfName, its other forms and mark kept. */
function nameLine(line) {
  const ambiguous = AMBIGUOUS_MARK.test(line);
  const bare = line.replace(AMBIGUOUS_MARK, '').trim();
  const converted = lineOf(indexFormOfName(headingOf(bare)).heading, variantsOf(bare));
  return `${converted}${ambiguous ? ' [ambiguous]' : ''}`;
}

/**
 * What the Names box will add, line by line, for the page to show beside what was typed.
 * @returns {Array<{ typed: string, heading: string, how: string, searched: string }>} how: from
 *   indexFormOfName; searched: the form the proofs are searched for
 */
export function previewNames(text) {
  if (SECTION_LINE.test(String(text ?? ''))) return [];
  return entryLines(text).filter(item => item.entry).map(({ line }) => {
    const typed = headingOf(line.replace(AMBIGUOUS_MARK, ''));
    const { heading, how } = indexFormOfName(typed);
    return { typed, heading, how, searched: reverseName(heading)[0] };
  }).filter(row => row.typed);
}

/**
 * The entries the Names box adds: each line a person, typed as it is said and put surname first
 * (indexFormOfName); lines indented under one are its subentries or cross-references. Text that
 * holds its own "Terms:" or "Names:" lines is a whole term list and is read as one.
 */
export function namesFromText(text, existing = []) {
  if (SECTION_LINE.test(String(text ?? ''))) return entriesFromText(text, existing);
  const lines = entryLines(text).map(({ line, entry }) => (entry ? nameLine(line) : line));
  return entriesFromText(`Names:\n${lines.join('\n')}`, existing);
}

/** The entries the Subjects box adds: the term list's own syntax, so a pasted list works as it is. */
export const subjectsFromText = (text, existing = []) => entriesFromText(text, existing);

/**
 * Moves an entry to the other group. Into Names, a heading not yet surname first is put in index
 * form; out of Names, a surname-first heading keeps the order the text uses as a form to search for,
 * so the entry finds what it found before. The model's kind is kept; `moved` keeps it shown.
 */
export function moveEntry(list, id, section) {
  if (!SECTIONS.includes(section)) return list;
  return list.map(entry => {
    if (entry.id !== id || entry.section === section) return entry;
    const heading = headingOf(entry.text);
    const variants = variantsOf(entry.text);
    const text = section === 'names'
      ? lineOf(indexFormOfName(heading).heading, variants)
      : nameParts(heading) ? lineOf(heading, [...variants, reverseName(heading)[0]]) : entry.text;
    return { ...entry, section, text, moved: true };
  });
}

// A subject that reads as a person's name written surname first: one to three capitalized words, a
// comma, one to four capitalized words or initials, and perhaps a suffix; not a title filed under its
// article ("Long Night, The") and not a body ("Example Press, The").
const CAPITALIZED = /^(?:\p{Lu}[\p{L}'’.-]*|(?:de|du|da|di|del|della|van|von|der|den|le|la)\b)$/u;
const ARTICLE = /^(?:the|a|an|la|le|les|l'|il|lo|gli|i|el|los|las|der|die|das|o|os|as)$/iu;
export function looksLikeInvertedName(heading) {
  const parts = nameParts(heading);
  if (!parts || corporateName(heading)) return false;
  const surname = parts.surname.split(' ');
  if (heading.split(',').length - (parts.suffix ? 1 : 0) !== 2) return false;
  if (surname.length > 3 || parts.forenames.length > 4 || parts.forenames.length === 0) return false;
  if (parts.forenames.length === 1 && ARTICLE.test(parts.forenames[0])) return false;
  return [...surname, ...parts.forenames].every(token => CAPITALIZED.test(token)) && surname.some(token => /^\p{Lu}/u.test(token));
}

/** The subjects the page offers to move to Names: written as a person's name, surname first, not moved before. */
export const invertedSubjects = list => list.filter(entry => entry.section === 'terms' && entry.status !== 'dropped' && entry.moved !== true && looksLikeInvertedName(headingOf(entry.text)));

/** Adds entries to a list; one already there (same section, same line) is not added twice. */
export function addEntries(list, added) {
  const have = new Set(list.map(entry => `${entry.section}\u0000${entry.text.toLowerCase()}`));
  const fresh = added.filter(entry => !have.has(`${entry.section}\u0000${entry.text.toLowerCase()}`));
  return { list: [...list, ...fresh], added: fresh.length, skipped: added.length - fresh.length };
}

/** The list the author downloads and the index uses: everything not dropped and not still a mere proposal. */
export const workingList = list => list.filter(entry => entry.status === 'accepted');

export function setStatus(list, ids, status) {
  if (!STATUSES.includes(status)) return list;
  const wanted = new Set(ids);
  return list.map(entry => (wanted.has(entry.id) ? { ...entry, status } : entry));
}

/** Changes an entry's line, section, subentries or cross-references; returns null when the line has nothing to search. */
export function editEntry(list, id, { heading, variants, section, subentries, see, seeAlso, ambiguous }) {
  return list.map(entry => {
    if (entry.id !== id) return entry;
    const text = heading === undefined && variants === undefined ? entry.text : lineOf(heading ?? headingOf(entry.text), variants ?? variantsOf(entry.text));
    return {
      ...entry,
      text,
      ...(section && SECTIONS.includes(section) ? { section } : {}),
      ...(subentries ? { subentries: subentries.map(line => ({ text: line })).filter(sub => sub.text.trim()) } : {}),
      ...(see ? { see } : {}),
      ...(seeAlso ? { seeAlso } : {}),
      ...(ambiguous === undefined ? {} : { ambiguous: Boolean(ambiguous) }),
    };
  });
}

/** Merges one entry into another: its heading and variants become the other's variants. */
export function mergeEntries(list, fromId, intoId) {
  const from = list.find(entry => entry.id === fromId);
  const into = list.find(entry => entry.id === intoId);
  if (!from || !into || from === into) return list;
  const fromHeading = headingOf(from.text);
  // A name in index order joins as the order the text uses ("Ada Example"), which is what is searched.
  const parts = from.section === 'names' && fromHeading.includes(',') ? fromHeading.split(',').map(part => part.trim()) : null;
  const asSearched = parts && parts.length >= 2 ? `${parts.slice(1).join(' ')} ${parts[0]}` : fromHeading;
  const variants = [...variantsOf(into.text), asSearched, ...variantsOf(from.text)];
  const merged = {
    ...into,
    text: lineOf(headingOf(into.text), variants),
    subentries: [...into.subentries, ...from.subentries.filter(sub => !into.subentries.some(have => have.text === sub.text))],
    see: [...new Set([...into.see, ...from.see])],
    seeAlso: [...new Set([...into.seeAlso, ...from.seeAlso])],
    ambiguous: into.ambiguous || from.ambiguous,
    count: (into.count ?? 0) + (from.count ?? 0),
    ...(Number.isInteger(into.spread) || Number.isInteger(from.spread) ? { spread: Math.max(into.spread ?? 0, from.spread ?? 0) } : {}),
    ...(into.discussed || from.discussed ? { discussed: (into.discussed ?? 0) + (from.discussed ?? 0) } : {}),
    quotes: [...(into.quotes ?? []), ...(from.quotes ?? [])].slice(0, 3),
  };
  return list.filter(entry => entry.id !== fromId).map(entry => (entry.id === intoId ? merged : entry));
}

export const termListFile = list => ({ name: 'term-list.txt', text: serializeTermList(workingList(list)) });

// --- Plans said before a helper runs ---

export function termsPlan(paragraphs, left) {
  const passages = buildTermPassages(paragraphs, { left });
  return { calls: passages.length, text: `${plural(passages.length, 'model call', 'model calls')}, one per passage of about 9,000 characters${left.size ? `; ${plural(left.size, 'paragraph', 'paragraphs')} of bibliography left out` : ''}.` };
}

export const JUDGE_SCOPES = Object.freeze(['marked', 'flagged', 'both']);
const MARKED = 'marked by you';

/**
 * The entries the ambiguity judge can read, by scope: those the author marked, those the tool flags
 * for another reason, or both; each only when it has hits.
 * @param {object[]} list the working list
 * @param {Map<string, string[]>} reasons from detectAmbiguous
 * @param {Map<string, { hits: object[] }>} byEntry
 * @returns {{ marked: object[], flagged: object[], both: object[] }}
 */
export function judgeScopes(list, reasons, byEntry) {
  const withHits = list.filter(entry => reasons.has(entry.id) && (byEntry.get(entry.id)?.hits.length ?? 0) > 0);
  return {
    marked: withHits.filter(entry => reasons.get(entry.id).includes(MARKED)),
    flagged: withHits.filter(entry => reasons.get(entry.id).some(reason => reason !== MARKED)),
    both: withHits,
  };
}

/** The scope the judge starts on: the author's marks when there are any, else what the tool flags. */
export const defaultJudgeScope = scopes => (scopes.marked.length ? 'marked' : 'flagged');

// --- The index the author gets ---

/**
 * The entries as the index prints them, from the match and the author's choices: pages where every
 * hit was dropped by an applied decision are left out; a page goes to a subentry when the
 * subentry's own words are on it or an applied sorting puts a hit there, and then not under the
 * heading itself.
 * @param {object[]} list the working list
 * @param {Map<string, { pages: string[], hits: object[], subentryPages: string[][] }>} byEntry
 * @param {{ decisions?: Record<string, { keep: boolean }>, overrides?: Record<string, boolean>, appliedJudge?: Record<string, boolean>,
 *   assignments?: Record<string, number|null>, appliedSorting?: Record<string, boolean> }} choices
 */
export function indexEntries(list, byEntry, { decisions = {}, overrides = {}, appliedJudge = {}, assignments = {}, appliedSorting = {} } = {}) {
  return list.map(entry => {
    const found = byEntry.get(entry.id) ?? { pages: [], hits: [], subentryPages: [] };
    const keep = hit => (hit.id in overrides ? overrides[hit.id] : !(appliedJudge[entry.id] && decisions[hit.id]?.keep === false));
    const pages = found.pages.filter(page => {
      const onPage = found.hits.filter(hit => hit.page === page);
      return !onPage.length || onPage.some(keep);
    });
    const subPages = (entry.subentries ?? []).map((_, at) => new Set((found.subentryPages?.[at] ?? []).filter(page => pages.includes(page))));
    if (appliedSorting[entry.id]) {
      for (const hit of found.hits) {
        const at = assignments[hit.id];
        if (Number.isInteger(at) && subPages[at] && pages.includes(hit.page) && keep(hit)) subPages[at].add(hit.page);
      }
    }
    const placed = new Set(subPages.flatMap(set => [...set]));
    return {
      id: entry.id,
      heading: headingOf(entry.text),
      pages: pages.filter(page => !placed.has(page)),
      subentries: (entry.subentries ?? []).map((sub, at) => ({ heading: headingOf(sub.text), pages: pages.filter(page => subPages[at].has(page)) })),
      see: entry.see ?? [],
      seeAlso: entry.seeAlso ?? [],
    };
  });
}

// --- The conventions from a Formatter rule sheet ---

const SLOT_SETTING = { 'index.layout': ['layout', 'layout', LAYOUTS], 'index.page-ranges': ['style', 'style', RANGE_STYLES], 'index.sorting': ['sorting', 'order', SORTINGS] };

/** Reads a rule sheet file for its index settings. */
export function settingsFromSheet(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, message: 'This is not a rule sheet file.' }; }
  if (!isObject(data) || data.version !== SHEET_VERSION) return { ok: false, message: 'This is not a rule sheet file from this version of the Formatter.' };
  const result = validateSheet(data);
  if (!result.ok) return { ok: false, message: 'This rule sheet file is damaged and cannot be used.' };
  const settings = {};
  const found = [];
  for (const rule of result.sheet.rules) {
    const slot = SLOT_SETTING[rule.slot];
    if (!slot || rule.enabled === false || rule.conflict === true) continue;
    const [setting, param, allowed] = slot;
    if (allowed.includes(rule.params?.[param])) { settings[setting] = rule.params[param]; found.push(rule.slot); }
  }
  return { ok: true, settings, found };
}

// --- What this browser keeps ---

const savedEntry = ({ id, section, text, ambiguous, subentries, see, seeAlso, status, kind, count, countLeftOut, passages, spread, discussed, inHeading, moved }) => ({ id, section, text, ambiguous, subentries, see, seeAlso, status, kind, count, countLeftOut, passages, spread, discussed, inHeading, moved });
// The numbers and marks a saved entry keeps beside its line, checked on the way back.
const savedFacts = own => ({
  ...Object.fromEntries(['count', 'countLeftOut', 'passages', 'spread', 'discussed'].filter(key => Number.isInteger(own[key]) && own[key] >= 0).map(key => [key, own[key]])),
  ...(own.inHeading === true ? { inHeading: true } : {}),
  ...(own.moved === true ? { moved: true } : {}),
});
// The group of a saved entry. Work saved before the groups, or damaged, may lack a section: a
// person the model proposed is a name, anything else a subject, so nothing is lost on the way back.
const savedSection = entry => (SECTIONS.includes(entry.section) ? entry.section : entry.kind === 'person' ? 'names' : 'terms');

/**
 * The work kept in this browser: the term list (without the quotations from the manuscript), the
 * passages already answered (their proposals without quotations), the PDF's name, hash and page
 * count, the settings, the page ranges (numbers and kinds, not their headings), and the helpers'
 * decisions (keep or drop, the subentry chosen; not the model's reasons).
 */
export function savedState(state) {
  return {
    entries: state.entries.map(savedEntry),
    proposing: state.proposing ? {
      hash: state.proposing.hash,
      name: state.proposing.name,
      answered: Object.fromEntries(Object.entries(state.proposing.answered).map(([key, answer]) => [key, { unverified: answer.unverified, proposals: answer.proposals.map(({ quote, ...rest }) => rest) }])),
    } : null,
    pdf: state.pdf ? { name: state.pdf.name, hash: state.pdf.hash, pages: state.pdf.pages } : null,
    settings: { ...state.settings, filter: { ...(state.settings.filter ?? DEFAULT_FILTER) } },
    ranges: state.ranges.map(({ kind, first, last, on, cut }) => ({ kind, first, last, on, ...(Number.isInteger(cut) ? { cut } : {}) })),
    manualRanges: state.manualRanges,
    decisions: Object.fromEntries(Object.entries(state.decisions).map(([id, answer]) => [id, { keep: answer.keep }])),
    overrides: { ...state.overrides },
    appliedJudge: { ...state.appliedJudge },
    assignments: { ...state.assignments },
    appliedSorting: { ...state.appliedSorting },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
/** The term editor's thresholds, checked: anything that does not fit is the default. */
export function restoredFilter(filter) {
  if (!isObject(filter)) return { ...DEFAULT_FILTER };
  const names = PAGE_CHOICES.includes(filter.names) ? filter.names : DEFAULT_FILTER.names;
  return {
    concepts: PAGE_CHOICES.includes(filter.concepts) ? filter.concepts : DEFAULT_FILTER.concepts,
    names,
    // Saved before people had a threshold of their own: they followed the names'.
    people: PAGE_CHOICES.includes(filter.people) ? filter.people : names,
  };
}
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const boolMap = value => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'boolean')) : {});

/** The saved work, checked: anything that does not fit is left out. */
export function restoredState(saved) {
  if (!isObject(saved)) return {};
  const kept = (Array.isArray(saved.entries) ? saved.entries : []).filter(entry => isObject(entry) && typeof entry.text === 'string').map(entry => ({ ...entry, section: savedSection(entry) }));
  const text = serializeTermList(kept);
  const parsed = parseTermList(text).entries;
  // The file syntax checks the lines; the saved fields not in it are taken from the saved entry in the same order.
  const entries = parsed.map(entry => {
    const own = kept.find(item => item.section === entry.section && item.text === entry.text) ?? {};
    return { ...entry, id: typeof own.id === 'string' && /^e\d+$/.test(own.id) ? own.id : entry.id, status: pick(own.status, STATUSES, 'accepted'), ...(typeof own.kind === 'string' ? { kind: own.kind } : {}), ...savedFacts(own) };
  });
  const settings = isObject(saved.settings) ? {
    pageOne: typeof saved.settings.pageOne === 'string' && /^\d{0,5}$/.test(saved.settings.pageOne) ? saved.settings.pageOne : '',
    matchCase: saved.settings.matchCase === true,
    layout: pick(saved.settings.layout, LAYOUTS, DEFAULT_SETTINGS.layout),
    style: pick(saved.settings.style, RANGE_STYLES, DEFAULT_SETTINGS.style),
    sorting: pick(saved.settings.sorting, SORTINGS, DEFAULT_SETTINGS.sorting),
    collapse: saved.settings.collapse !== false,
    filter: restoredFilter(saved.settings.filter),
  } : { ...DEFAULT_SETTINGS };
  const proposing = isObject(saved.proposing) && HEX64.test(saved.proposing.hash ?? '') && isObject(saved.proposing.answered)
    ? { hash: saved.proposing.hash, name: String(saved.proposing.name ?? ''), answered: Object.fromEntries(Object.entries(saved.proposing.answered).filter(([, answer]) => isObject(answer) && Array.isArray(answer.proposals))) }
    : null;
  const pdf = isObject(saved.pdf) && HEX64.test(saved.pdf.hash ?? '') && Number.isInteger(saved.pdf.pages) ? { name: String(saved.pdf.name ?? ''), hash: saved.pdf.hash, pages: saved.pdf.pages } : null;
  const ranges = Array.isArray(saved.ranges) ? saved.ranges.filter(range => isObject(range) && Number.isInteger(range.first) && Number.isInteger(range.last) && typeof range.kind === 'string').map(range => ({ kind: range.kind, first: range.first, last: range.last, on: range.on === true, heading: '', ...(Number.isInteger(range.cut) ? { cut: range.cut } : {}) })) : [];
  const decisions = isObject(saved.decisions) ? Object.fromEntries(Object.entries(saved.decisions).filter(([, answer]) => isObject(answer) && typeof answer.keep === 'boolean').map(([id, answer]) => [id, { keep: answer.keep, reason: '' }])) : {};
  const assignments = isObject(saved.assignments) ? Object.fromEntries(Object.entries(saved.assignments).filter(([, at]) => at === null || Number.isInteger(at))) : {};
  return { entries, settings, proposing, pdf, ranges, manualRanges: typeof saved.manualRanges === 'string' ? saved.manualRanges.slice(0, 200) : '', decisions, overrides: boolMap(saved.overrides), appliedJudge: boolMap(saved.appliedJudge), assignments, appliedSorting: boolMap(saved.appliedSorting) };
}
