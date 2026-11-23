// The general finding at the top of the formatted file: what the formatting pass changed, with
// counts, built from the formatter's declared transformations. Pure: no DOM, no network.

import { DECLARED } from '../format/declared.js';
import { plural } from './context.js';

// Each kind of declared change in plain words, as a count of things.
export const CHANGE_WORDS = Object.freeze({
  [DECLARED.emptyRemoved]: ['empty paragraph used for spacing removed', 'empty paragraphs used for spacing removed'],
  [DECLARED.emptyKept]: ['empty paragraph kept because it holds a field, a note or other markup', 'empty paragraphs kept because they hold a field, a note or other markup'],
  [DECLARED.linesJoined]: ['line of a set-off quotation, pasted one per paragraph, joined back into its paragraph', 'lines of set-off quotations, pasted one per paragraph, joined back into their paragraphs'],
  [DECLARED.stanzaBreak]: ['empty paragraph kept as a stanza break in verse', 'empty paragraphs kept as stanza breaks in verse'],
  [DECLARED.titleSplit]: ['chapter title divided at its colon into a title and a subtitle', 'chapter titles divided at their colon into a title and a subtitle'],
  [DECLARED.authorSplit]: ['author line divided from the affiliation on the same line', 'author lines divided from the affiliation on the same line'],
  [DECLARED.markerRewritten]: ['figure placement marker rewritten in the form the guidelines show', 'figure placement markers rewritten in the form the guidelines show'],
  [DECLARED.markerAdded]: ['figure placement marker added', 'figure placement markers added'],
  [DECLARED.captionAdded]: ['figure caption line added, holding only the figure number', 'figure caption lines added, holding only the figure number'],
  [DECLARED.captionNumbered]: ['figure number added to a caption', 'figure numbers added to captions'],
  [DECLARED.breakInsideRemoved]: ['section break inside a chapter removed', 'section breaks inside a chapter removed'],
  [DECLARED.emptySectionRemoved]: ['empty section removed', 'empty sections removed'],
  [DECLARED.breakAdded]: ['section break added at the start of a chapter, so that note numbers start again there', 'section breaks added at the start of chapters, so that note numbers start again in each'],
  [DECLARED.carrierAdded]: ['empty paragraph added to carry a section break', 'empty paragraphs added to carry section breaks'],
  [DECLARED.headingNumbers]: ['section heading numbered through Word numbering (not typed text)', 'section headings numbered through Word numbering (not typed text)'],
  [DECLARED.duplicateStyle]: ['duplicate style definition removed', 'duplicate style definitions removed'],
});

/** The changes of a formatter report, one line each: "12 empty paragraphs used for spacing removed". */
export function changeLines(report) {
  return (report.declared ?? []).filter(entry => entry.count > 0).map(entry => {
    const [one, many] = CHANGE_WORDS[entry.kind] ?? [entry.kind, entry.kind];
    return plural(entry.count, one, many);
  });
}

export const SUMMARY_CHECKS = [
  {
    id: 'formatting-summary',
    kind: 'formatting-summary',
    needs: 'a formatting pass that changed the file',
    basis: context => (Object.keys(context.report.styles ?? {}).length || (context.report.declared ?? []).length ? { rule: null } : null),
    run: context => {
      const styled = Object.values(context.report.styles ?? {}).reduce((sum, count) => sum + count, 0);
      const lines = [
        'What this formatting pass changed. CAIL Manuscript Desk formatted this file to the rule sheet you reviewed:',
        `- ${plural(styled, 'paragraph was', 'paragraphs were')} given a named style for what ${styled === 1 ? 'it is' : 'they are'} (${plural(Object.keys(context.report.styles ?? {}).length, 'style')} in all), and lost the direct formatting the style now carries; italics, bold and other formatting inside a sentence were kept;`,
        ...changeLines(context.report).map(line => `- ${line};`),
      ];
      lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/u, '.');
      lines.push('No other words were changed. The other comments mark what is still left for you; the To-dos list has them all, each with the guideline it comes from.');
      const first = context.paragraphs.find(entry => entry.hints?.empty === false && entry.kind === 'paragraph') ?? context.paragraphs[0];
      return [{ paragraphIndex: first ? first.index : null, message: lines.join('\n') }];
    },
  },
];
