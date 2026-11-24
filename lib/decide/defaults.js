// The defaults the decide step applies when the guidelines are silent, for books and articles: the
// settings a careful production editor would choose for a submission, applied without asking and
// listed once in the summary. A guideline rule on the same setting always wins. Dissertations keep
// their built-in set (lib/presets/) and get none of these. Also the defaults that settle a kind of
// finding without a question (two authors' names joined two ways, a length "about" a number), each
// stated in the summary when it settles something. Pure: no DOM, no network.

import { validateSheet } from '../rules/schema.js';

const CM = 1 / 2.54;

// The layout defaults, in the order the summary lists them. `books`: for monographs and edited
// collections only (an article has no chapter labels).
export const LAYOUT_DEFAULTS = Object.freeze([
  { id: 'line-spacing', slot: 'layout.spacing', category: 'layout', params: { line: 1.5 }, words: '1.5 line spacing for the text' },
  { id: 'page-numbers', slot: 'layout.page-numbers', category: 'layout', params: { position: 'bottom-center' }, words: 'page numbers at the bottom centre of every page' },
  { id: 'margins', slot: 'layout.margins', category: 'layout', params: { inches: 1 }, words: 'margins of 2.54 cm (one inch) on every side' },
  { id: 'chapter-labels', slot: 'chapters.label', category: 'chapters', params: { example: 'Chapter 1' }, words: 'a label line (“Chapter 1”) above each numbered chapter title', books: true },
  { id: 'hanging-indent', slot: 'references.hanging-indent', category: 'references', params: { inches: Math.round(CM * 10000) / 10000 }, words: 'a hanging indent of 1 cm for bibliography entries' },
  { id: 'font', slot: 'layout.font', category: 'layout', params: { family: 'Times New Roman', sizePt: 12 }, words: '12 pt Times New Roman, a serif font every publisher can open' },
]);

// The defaults that settle a kind of finding. `settles(finding, roleOf)` says whether it settles this one.
export const SETTLING_DEFAULTS = Object.freeze([
  {
    id: 'authors-as-typed',
    words: 'where chapters join two authors’ names in different ways (“and”, “&”, a comma), each is left as typed: the publisher’s copyeditor makes them one style',
    settles: finding => finding.check === 'author-separators',
  },
  {
    id: 'about-length',
    words: 'a length the guidelines give as “about” a number is a guide: an abstract or a note up to a third longer or shorter is not queried',
    settles: finding => {
      if (finding.check !== 'abstract-length' && !(finding.check === 'contributors-against-chapters' && /words; the guidelines ask for about/u.test(finding.message))) return false;
      const words = /has (\d[\d,]*) words?/u.exec(finding.message);
      const asked = /ask for about (\d[\d,]*)/u.exec(finding.message);
      if (!words || !asked) return false;
      const ratio = Number(words[1].replaceAll(',', '')) / Number(asked[1].replaceAll(',', ''));
      return ratio <= 4 / 3 && ratio >= 2 / 3;
    },
  },
  {
    id: 'addresses-in-references',
    words: 'web addresses in the bibliographies are left in full, as citation styles print them, though screen readers read them out letter by letter',
    settles: (finding, roleOf) => finding.check === 'a11y-link-text' && roleOf?.(finding.paragraphIndex) === 'bibliography-entry',
  },
]);

const BOOKS = new Set(['monograph', 'edited-collection']);

/** True when a rule of the sheet is one of these defaults. */
export const isDefaultRule = rule => rule?.source?.kind === 'default';
const active = rule => rule.enabled !== false;

/**
 * The sheet with a default rule for every layout setting it leaves unset, for books and articles.
 * A rule on the slot (even one switched off, or in conflict) means the guidelines speak, and the
 * default is not applied. Returns { sheet, applied: [{ id, slot, words }] }.
 */
export function withDefaults(sheet, { ignore = new Set() } = {}) {
  const docType = sheet?.docType;
  if (!sheet || docType === 'dissertation' || !Array.isArray(sheet.rules)) return { sheet, applied: [] };
  // `ignore`: rules the decide step switched off as misread, which do not count as the guidelines speaking.
  const spoken = new Set(sheet.rules.filter(rule => rule.slot && !ignore.has(rule.id) && !isDefaultRule(rule)).map(rule => rule.slot));
  const applied = LAYOUT_DEFAULTS.filter(entry => !spoken.has(entry.slot) && (!entry.books || BOOKS.has(docType)));
  if (!applied.length) return { sheet, applied: [] };
  const rules = [...sheet.rules.filter(rule => !isDefaultRule(rule)), ...applied.map(entry => ({
    id: `default-${entry.id}`,
    category: entry.category,
    slot: entry.slot,
    statement: `Default we applied because the guidelines do not say: ${entry.words}.`,
    mode: 'fix',
    source: { kind: 'default' },
    params: { ...entry.params },
    enabled: true,
  }))];
  const checked = validateSheet({ ...sheet, rules });
  if (!checked.ok) return { sheet, applied: [] };
  return { sheet: checked.sheet, applied: applied.map(({ id, slot, words }) => ({ id, slot, words })) };
}


/** The settling default that settles a finding, or null. */
export const settlingDefault = (finding, roleOf) => SETTLING_DEFAULTS.find(entry => entry.settles(finding, roleOf)) ?? null;

export { active as activeRule };
