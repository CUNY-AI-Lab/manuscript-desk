// The decide step's units of work: small, each with what it needs attached, so that a model answers
// with decisions instead of reading the book. One unit checks the rule sheet's settings against the
// sentences they came from; one per chapter (and one for the front matter) decides the queries of
// the reading check that sit in running text; the guideline rules no check verified are triaged
// forty at a time. Each unit is { kind, name, text, items } (items: the ids it must decide). The
// text is manuscript or guideline text to read, never instructions; the Worker's system prompt says
// so. Pure: no DOM, no network.

import { NOTE_SIGN } from '../checks/reading.js';

const cut = (text, n) => { const one = String(text ?? '').replace(/\s+/gu, ' ').trim(); return one.length > n ? `${one.slice(0, n)}…` : one; };
export const FINDINGS_PER_UNIT = 18;
export const RULES_PER_UNIT = 40;

/** A paragraph as the model reads it: [number] (role) text, a note sign where a note stands. */
export function paragraphLine(entry, role, n = 400) {
  if (!entry) return '';
  const notes = Array.isArray(entry.notes) ? [...entry.notes].sort((a, b) => b - a) : [];
  let text = entry.text;
  for (const at of notes) text = `${text.slice(0, at)}${NOTE_SIGN}${text.slice(at)}`;
  return `[${entry.index}] (${role ?? (entry.hints?.empty ? 'empty' : 'none')}) ${cut(text, n)}`;
}

// The settings a misreading would do harm with, because the formatter applies them to the whole
// text: only these are checked, and only these may be switched off.
export const CLEARABLE_SLOTS = new Set(['layout.font', 'layout.spacing', 'layout.margins', 'layout.margin-sides', 'layout.page-numbers', 'layout.paper', 'layout.element-spacing', 'layout.page-number-distance', 'chapters.label', 'figures.markers', 'references.hanging-indent']);

/** The settings unit: the layout settings read from the guidelines, each with its sentence. */
export function settingsUnit(sheet) {
  const rules = (sheet?.rules ?? []).filter(rule => CLEARABLE_SLOTS.has(rule.slot) && rule.enabled !== false && rule.source?.kind === 'guidelines' && !rule.source.set);
  if (!rules.length) return null;
  const lines = rules.map(rule => `${rule.id}: ${rule.slot} = ${JSON.stringify(rule.params)}${rule.conflict ? ' (in conflict with another rule on the same setting)' : ''}. Mode ${rule.mode}. From the guidelines: “${cut(rule.source.quote, 300)}”`);
  return {
    kind: 'settings',
    name: 'settings',
    items: rules.map(rule => rule.id),
    text: [`Layout settings a model read out of the publisher's guidelines for this ${sheet.docType ?? 'manuscript'}, each with the sentence it came from. The formatter applies each one to the whole text of the manuscript. Most are right: leave every setting its sentence states for the manuscript's text. Switch off only a setting taken from a sentence about something else (the text inside illustrations, a table, the typeset book rather than the manuscript), or a typeface the author is only encouraged or invited to use. Where two settings conflict, switch off the misread one.`, '', ...lines].join('\n'),
  };
}

/**
 * The findings units: per chapter (and one for the front and back matter), the open queries with
 * their paragraph and, for a query comparing two places, the other place.
 * @param {{ open: Array<{ id: string, finding: object }>, paragraphs: Array<object>, roleOf: Function, chapters: Array<object> }} input
 */
export function findingUnits({ open, paragraphs, roleOf, chapters }) {
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const chapterOf = index => chapters.findIndex(chapter => index >= chapter.first && index <= chapter.last);
  const groups = new Map();
  for (const item of open) {
    const key = chapterOf(item.finding.paragraphIndex);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const units = [];
  for (const [chapter, items] of [...groups].sort((a, b) => a[0] - b[0])) {
    const head = chapter >= 0 ? (chapters[chapter].titleBlock ?? []).slice(0, 4).map(index => paragraphLine(byIndex.get(index), roleOf(index), 160)).join(' | ') : '';
    for (let at = 0; at < items.length; at += FINDINGS_PER_UNIT) {
      const batch = items.slice(at, at + FINDINGS_PER_UNIT);
      const lines = batch.flatMap(({ id, finding }) => {
        const out = [`${id} (${finding.kind}) at paragraph ${finding.paragraphIndex}: ${cut(finding.message, 360)}`, `    here: ${paragraphLine(byIndex.get(finding.paragraphIndex), roleOf(finding.paragraphIndex), 500)}`];
        if (Number.isInteger(finding.other?.paragraph) && finding.other.paragraph !== finding.paragraphIndex) out.push(`    other place: ${paragraphLine(byIndex.get(finding.other.paragraph), roleOf(finding.other.paragraph), 300)}`);
        return out;
      });
      units.push({
        kind: 'findings',
        name: `${chapter >= 0 ? `chapter-${chapter + 1}` : 'front-and-back'}${at ? `-${at / FINDINGS_PER_UNIT + 1}` : ''}`,
        items: batch.map(item => item.id),
        text: [
          chapter >= 0 ? `One chapter of a scholarly manuscript, paragraphs ${chapters[chapter].first} to ${chapters[chapter].last}. Its title block: ${head}` : 'The front and back matter of a scholarly manuscript.',
          '',
          `Queries a model's reading proposed in the running text (${batch.length}). Decide each: a possible slip in the prose goes to the copyeditor; ask the author only what only the author can answer.`,
          ...lines,
        ].join('\n'),
      });
    }
  }
  return units;
}

/** The rules units: the rules no check verified, forty at a time. */
export function ruleUnits({ rules, docType, made = [] }) {
  const units = [];
  for (let at = 0; at < rules.length; at += RULES_PER_UNIT) {
    const batch = rules.slice(at, at + RULES_PER_UNIT);
    units.push({
      kind: 'rules',
      name: `rules-${at / RULES_PER_UNIT + 1}`,
      items: batch.map(rule => rule.id),
      text: [
        `Rules of the publisher's guidelines for this ${docType ?? 'manuscript'} that no check of the tool verified (${batch.length} of ${rules.length}). The tool has already formatted the manuscript with named styles: chapter titles, headings and their levels, block quotations set off and indented, paragraphs indented with no blank lines between them, footnotes as the guidelines set them, notes, figures and tables marked; and it made these documents: ${made.length ? made.join(', ') : 'none'}.`,
        'Triage every rule. Most rules are "done" (the formatting or the manuscript already meets it), "not-applicable" (advice for a later stage such as proofs or the index proofs, a rule for another kind of book or for a case this manuscript does not have, a general aim with nothing to do now, an offer of help) or "deliver" (a file, form, permission or text to hand in). Use "copyedit" for matters of the prose: spelling, punctuation, quotation marks, abbreviations, the form of citations and references. Use "decision" only for an open choice the author or editor must make before submitting, and say it as a short question; there are usually few.',
        '',
        ...batch.map(rule => `${rule.id} (${rule.mode === 'supply' ? 'to supply' : rule.mode}, ${rule.category}): ${cut(rule.statement, 200)}${rule.source?.kind === 'guidelines' ? ` (“${cut(rule.source.quote, 160)}”)` : ''}`),
      ].join('\n'),
    });
  }
  return units;
}
