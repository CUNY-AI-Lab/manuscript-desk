// What the To-dos list and the companion documents share: the kinds of finding in plain words, the
// rule sheet's rules and their sources as blocks, chapter names, and which rules the formatter
// applied. Pure: no DOM, no network.

import { CATEGORIES } from '../rules/schema.js';

export const KIND_LABELS = Object.freeze({
  'formatting-summary': 'What the formatting pass changed',
  'chapter-title': 'Chapter title',
  'heading-case': 'Capitals in a heading',
  'abstract-missing': 'Abstract and keywords',
  'abstract-length': 'Length of the abstract',
  'keywords-form': 'Keywords',
  'note-on-title': 'A note on a title or an author’s name',
  'repeated-author-dash': 'Repeated authors in the bibliography',
  'heading-numbering': 'Heading numbers',
  'bibliography-headings': 'Bibliography headings',
  'quotation-lines-joined': 'Quotation lines joined',
  'figure-to-supply': 'Figures',
  'table-from-tabs': 'A table typed with tabs',
  'table-for-layout': 'Word tables of running text',
  'wording-inconsistent': 'The same thing named or spelled two ways',
  'affiliation-inconsistent': 'A name or affiliation given two ways',
  'missing-spaces': 'Missing spaces',
  typo: 'Typing slips',
  'stray-or-duplicated-text': 'Stray or repeated text',
  'abstract-against-rules': 'Abstract and keywords against the guidelines',
  'contents-mismatch': 'The contents list against the chapters',
  'contributor-bio': 'Notes on contributors',
  'parts-order': 'The order of the parts',
  'parts-missing': 'Parts the work must have',
  'title-page-elements': 'The title page',
  'caption-position': 'Where captions go',
  'a11y-alt-text': 'Alternative text for pictures',
  'a11y-image-text': 'Pictures that may be images of text',
  'a11y-heading-skip': 'Heading levels',
  'a11y-table-header': 'Table header rows',
  'a11y-link-text': 'Link text',
  'a11y-colour': 'Highlighting and colour',
  'a11y-properties': 'Document title and language',
});
export const kindLabel = kind => KIND_LABELS[kind] ?? kind;
const CATEGORY_LABELS = new Map(CATEGORIES.map(entry => [entry.id, entry.label]));
export const categoryLabel = id => CATEGORY_LABELS.get(id) ?? id;

const active = rule => rule.enabled !== false && rule.conflict !== true;
export const rulesOf = sheet => (Array.isArray(sheet?.rules) ? sheet.rules : []);
export const activeRules = sheet => rulesOf(sheet).filter(active);
export const ruleById = (sheet, id) => rulesOf(sheet).find(rule => rule.id === id) ?? null;

/** Where a rule comes from, in words: the guidelines' sentence, the style manual, or the author. */
export function sourceBlocks(rule) {
  const source = rule?.source ?? {};
  if (source.kind === 'guidelines') return [{ type: 'quote', text: `“${source.quote}”` }];
  if (source.kind === 'manual') return [{ type: 'quote', text: `From ${source.manual}, ${source.section}.` }];
  return [{ type: 'quote', text: 'A rule added by hand to the rule sheet.' }];
}

/** The rule as blocks: its statement, then where it comes from. */
export function ruleBlocks(rule) {
  if (!rule) return [];
  return [{ type: 'paragraph', runs: [{ text: 'Rule: ', bold: true }, { text: rule.statement }] }, ...sourceBlocks(rule)];
}

// The slots the formatter applies, and whether a report's settings show it applied them.
const APPLIED = {
  'notes.restart': settings => settings.notesRestart === true,
  'headings.numbering': settings => settings.headingNumbers === true,
  'chapters.subtitle': settings => settings.splitTitles === true,
  'figures.markers': settings => Boolean(settings.figureMarker),
  'figures.numbering': settings => Boolean(settings.figureMarker),
  'layout.font': () => true,
  'layout.spacing': () => true,
  'layout.margins': settings => Boolean(settings.margins),
  'layout.page-numbers': settings => Boolean(settings.pageNumbers),
  'chapters.label': settings => Boolean(settings.chapterLabel),
  'layout.paper': settings => Boolean(settings.paper),
  'layout.margin-sides': settings => Boolean(settings.marginSides),
  'layout.element-spacing': settings => Boolean(settings.elementSpacing),
  'layout.page-sequences': settings => Boolean(settings.pageSequences),
  'chapters.new-page': settings => settings.chapterNewPage === true,
};
/** True when the formatter applied this rule's setting. */
export const appliedByFormatter = (rule, report) => active(rule) && Boolean(APPLIED[rule.slot]?.(report?.settings ?? {}));

/** A chapter's full title: its title line, then its subtitles, joined by colons. */
export function fullTitle(chapter, paragraphs) {
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const at = (chapter.parts ?? []).indexOf('title');
  const index = at >= 0 ? chapter.titleBlock[at] : chapter.titleBlock?.[0];
  const subtitles = (chapter.parts ?? []).flatMap((part, position) => (part === 'subtitle' ? [byIndex.get(chapter.titleBlock[position])?.text.trim()] : [])).filter(Boolean);
  return [byIndex.get(index)?.text.trim() || 'Untitled chapter', ...subtitles].join(': ');
}

/** A chapter's name for headings: "Chapter 2: Title", or the title alone for an unnumbered chapter. */
export function chapterName(chapter, paragraphs) {
  const title = fullTitle(chapter, paragraphs);
  return chapter.number ? `Chapter ${chapter.number}: ${title}` : title;
}
