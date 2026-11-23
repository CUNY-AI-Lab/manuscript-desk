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
  [DECLARED.subtitleJoined]: ['subtitle broken over two lines joined into one line', 'subtitles broken over two lines joined into one line each'],
  [DECLARED.labelAdded]: ['chapter label line added above a chapter title, in the form the guidelines show', 'chapter label lines added above the chapter titles, in the form the guidelines show'],
  [DECLARED.titleSpaces]: ['space or line break at the start or end of a title or heading removed', 'spaces or line breaks at the start or end of titles and headings removed'],
  [DECLARED.titleQuotes]: ['quotation mark around a title and its subtitle together removed', 'quotation marks around a title and its subtitle together removed'],
  [DECLARED.titleColon]: ['colon at the end of a title, before its subtitle, removed', 'colons at the end of titles, before their subtitles, removed'],
  [DECLARED.titleStop]: ['full stop at the end of a title or subtitle removed', 'full stops at the end of titles or subtitles removed'],
  [DECLARED.subtitleCapital]: ['first letter of a subtitle divided from its title capitalized', 'first letters of subtitles divided from their titles capitalized'],
  [DECLARED.affiliationBrackets]: ['bracket around an affiliation line removed', 'brackets around affiliation lines removed'],
  [DECLARED.headingCase]: ['word of a heading repeated in every chapter given the same capitals as the others', 'words of headings repeated in every chapter given the same capitals as the others'],
  [DECLARED.typedNoteNumber]: ['typed copy of a note number next to its automatic number removed', 'typed copies of note numbers next to their automatic numbers removed'],
  [DECLARED.fontRemoved]: ['stretch of Latin text set in a font other than the body font given the body font', 'stretches of Latin text set in a font other than the body font given the body font'],
  [DECLARED.defaultFont]: ['document default font set to the body font', 'document default fonts set to the body font'],
  [DECLARED.firstPageDropped]: ['chapter section made to show its page number on its first page too', 'chapter sections made to show their page number on their first page too'],
  [DECLARED.pageSetup]: ['section given the page size and margins of the rest of the text', 'sections given the page size and margins of the rest of the text'],
  [DECLARED.pageNumbers]: ['section given page numbers where the guidelines ask', 'sections given page numbers where the guidelines ask'],
  [DECLARED.margins]: ['section given the margins the guidelines ask for', 'sections given the margins the guidelines ask for'],
  [DECLARED.paper]: ['section given the paper size the guidelines ask for', 'sections given the paper size the guidelines ask for'],
  [DECLARED.elementSpacing]: ['style given the line spacing the guidelines ask for (notes, quotations, bibliography or captions)', 'styles given the line spacing the guidelines ask for (notes, quotations, bibliography or captions)'],
  [DECLARED.pageSequences]: ['section numbered as the guidelines ask (the pages before the first chapter apart from the chapters)', 'sections numbered as the guidelines ask (the pages before the first chapter apart from the chapters)'],
  [DECLARED.titlePageUnnumbered]: ['title page counted but given no page number, as the guidelines ask', 'title pages counted but given no page number, as the guidelines ask'],
  [DECLARED.pageBreakBefore]: ['chapter or major section made to start on a new page', 'chapters and major sections made to start on a new page'],
  [DECLARED.pageNumbersAdded]: ['section given page numbers at the bottom centre, since the guidelines ask for numbers but leave their place open (move them if you like, the same on every page)', 'sections given page numbers at the bottom centre, since the guidelines ask for numbers but leave their place open (move them if you like, the same on every page)'],
  [DECLARED.pageNumberDistance]: ['section given headers and footers at least as far from the edge of the page as the guidelines ask', 'sections given headers and footers at least as far from the edge of the page as the guidelines ask'],
  [DECLARED.hangingIndent]: ['bibliography style given the hanging indent the guidelines ask for', 'bibliography styles given the hanging indent the guidelines ask for'],
  [DECLARED.docTitle]: ['document title set in the file\u2019s properties from the title page, for screen readers', 'document titles set in the file\u2019s properties from the title page, for screen readers'],
  [DECLARED.tableHeader]: ['table whose first row is set apart as a header marked as a header row, for screen readers', 'tables whose first row is set apart as a header marked as a header row, for screen readers'],
});

/** What the rule sheet left unset that the file keeps as it was, as one sentence, or null. */
export function layoutKept(report) {
  const layout = report.layout;
  if (!layout) return null;
  const kept = [];
  if (!layout.lineSet && layout.line) kept.push(`the line spacing (${lineWords(layout.line)})`);
  if (!layout.pageNumbersSet) kept.push(`the page numbers (${layout.pageNumbers ?? 'none'})`);
  if (!layout.marginsSet) kept.push('the margins');
  if (!layout.fontSet && layout.font) kept.push(`the font (${layout.font})`);
  if (!kept.length) return null;
  return `The rule sheet does not set ${kept.length === 1 ? 'this' : 'these'}, so the manuscript keeps its own: ${kept.join(', ')}. If the publisher asks for others, add them to the rule sheet and format again.`;
}

const lineWords = line => ({ 240: 'single', 360: 'one and a half', 480: 'double' }[line] ?? `${Math.round((Number(line) / 240) * 100) / 100} lines`);

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
      const kept = layoutKept(context.report);
      if (kept) lines.push(kept);
      lines.push('No other words were changed. The other comments mark what is still left for you; the To-dos list has them all, each with the guideline it comes from.');
      const first = context.paragraphs.find(entry => entry.hints?.empty === false && entry.kind === 'paragraph') ?? context.paragraphs[0];
      return [{ paragraphIndex: first ? first.index : null, message: lines.join('\n') }];
    },
  },
];
