// To-do checks on what is set off from the running text: quotations whose pasted lines the
// formatter joined (to verify), what each figure still needs (an image file, permission, an alt
// text, a caption, a mention in the text) where the guidelines ask for it, lines laid out with tabs
// that the formatter styled as a table but that are no Word table, and Word tables that hold
// running text rather than data. Pure: no DOM, no network.

import { DECLARED } from '../format/declared.js';
import { plural } from './context.js';
import { ruleWith } from './rules.js';

// Words a callout to a figure starts with, in the languages scholarly books are most often written in.
const CALLOUT_WORDS = '(?:fig\\w*|ill\\w*|abb\\w*|afb\\w*|tav\\w*|tab\\w*|plate\\w*|planche\\w*|image\\w*|immagin\\w*|imagen\\w*|map\\w*|bild\\w*|obraz\\w*)';

/** The figures of each chapter: { chapter, figures: [{ index, label }] }, from the formatter's numbering or the roles. */
export function figuresByChapter(context) {
  const out = new Map();
  const add = (chapter, figure) => {
    if (chapter === null) return;
    if (!out.has(chapter)) out.set(chapter, []);
    out.get(chapter).push(figure);
  };
  const numbered = context.report.figures ?? [];
  if (numbered.length) {
    for (const figure of numbered) add(context.chapterOf(figure.index), { index: figure.index, label: figure.label });
  } else {
    // Without numbering, a figure is a run of figure paragraphs.
    context.chapters.forEach((chapter, at) => {
      let previous = null;
      for (const entry of context.paragraphsOf(chapter)) {
        const isFigure = context.roleOf(entry.index) === 'figure';
        if (isFigure && previous !== 'figure') add(at, { index: entry.index, label: null });
        previous = isFigure ? 'figure' : 'other';
      }
    });
  }
  return [...out].map(([chapter, figures]) => ({ chapter, figures }));
}

const numbersOf = figures => {
  const labels = figures.map(figure => figure.label).filter(Boolean);
  if (labels.length !== figures.length || !labels.length) return figures.length === 1 ? 'The figure in this chapter' : `The ${figures.length} figures in this chapter`;
  if (labels.length === 1) return `Figure ${labels[0]}`;
  return labels.length === 2 ? `Figures ${labels[0]} and ${labels[1]}` : `Figures ${labels[0]} to ${labels[labels.length - 1]}`;
};

/** The figures the chapter's text does not refer to by number. */
function withoutCallout(context, chapter, figures) {
  const text = context.paragraphsOf(chapter).filter(entry => context.roleOf(entry.index) !== 'figure').map(entry => entry.text).join('\n');
  return figures.filter(figure => {
    if (!figure.label) return false;
    const number = figure.label.replace(/[.\-–]/gu, match => `\\${match}`);
    return !new RegExp(`(?<![\\p{L}])${CALLOUT_WORDS}\\.?\\s*${number}(?![\\d])`, 'iu').test(text);
  });
}

// What a figure may still need, each with the rule that asks for it.
const FIGURE_NEEDS = [
  { id: 'file', rule: sheet => ruleWith(sheet, { slot: 'figures.files', where: params => params.separate === true }), say: () => 'an image file of its own, named with its number, in the resolution the guidelines give' },
  { id: 'permission', rule: sheet => ruleWith(sheet, { category: 'permissions' }), say: () => 'written permission from the rights holder for any image the author did not make' },
  { id: 'alt-text', rule: sheet => ruleWith(sheet, { category: 'alt-text' }), say: () => 'an alt text, so that someone using a screen reader learns what the image holds' },
];

export const DISPLAY_CHECKS = [
  {
    id: 'quotation-lines-joined',
    kind: 'quotation-lines-joined',
    needs: 'quotations whose pasted lines the formatter joined',
    basis: context => (context.placesOf(DECLARED.linesJoined).length ? { rule: null } : null),
    run: context => {
      // Each joined line is declared at the first paragraph of its quotation's paragraph; the
      // paragraphs of one quotation are those with nothing but quotation lines between them.
      const lines = (context.report.declared ?? []).find(entry => entry.kind === DECLARED.linesJoined)?.places ?? [];
      const roots = [...new Set(lines)].sort((a, b) => a - b);
      const between = (from, to) => context.paragraphs.filter(entry => entry.index > from && entry.index < to && entry.hints?.empty === false);
      const quotations = [];
      for (const root of roots) {
        const last = quotations[quotations.length - 1];
        if (last && context.chapterOf(last[0]) === context.chapterOf(root) && between(last[last.length - 1], root).every(entry => context.roleOf(entry.index) === 'block-quotation')) last.push(root);
        else quotations.push([root]);
      }
      return quotations.map(paragraphs => {
        const count = lines.filter(index => paragraphs.includes(index)).length;
        return {
          paragraphIndex: paragraphs[0],
          message: `This set-off quotation came in as one paragraph per line, the way text copied out of a PDF arrives. ${plural(count, 'line was', 'lines were')} put back together into ${paragraphs.length === 1 ? 'one paragraph' : `${paragraphs.length} paragraphs`}, joining a line to the next where it broke off mid-sentence or filled the whole width. Compare the paragraph breaks with the original.`,
        };
      });
    },
  },
  ...FIGURE_NEEDS.map(need => ({
    id: `figure-${need.id}`,
    kind: 'figure-to-supply',
    needs: `a rule asking for each figure's ${need.id === 'file' ? 'image file' : need.id === 'permission' ? 'permission' : 'alt text'}`,
    basis: context => { const rule = need.rule(context.sheet); return rule && figuresByChapter(context).length ? { rule } : null; },
    run: context => figuresByChapter(context).map(({ figures }) => ({
      paragraphIndex: figures[0].index,
      message: `${numbersOf(figures)} still ${figures.length === 1 ? 'needs' : 'need, each,'} ${need.say()}.`,
    })),
  })),
  {
    id: 'figure-caption',
    kind: 'figure-to-supply',
    needs: 'caption lines the formatter added with only a figure number',
    basis: context => (context.placesOf(DECLARED.captionAdded).length ? { rule: ruleWith(context.sheet, { slot: 'figures.markers' }) } : null),
    run: context => {
      const added = context.placesOf(DECLARED.captionAdded);
      return figuresByChapter(context).flatMap(({ chapter, figures }) => {
        const { first, last } = context.chapters[chapter];
        const count = added.filter(index => index >= first && index <= last).length;
        if (!count) return [];
        return [{
          paragraphIndex: figures[0].index,
          message: `${count === figures.length ? numbersOf(figures) : `${plural(count, 'figure')} in this chapter`} ${count === 1 ? 'has' : 'have'} a caption line that holds only the figure number. Write each caption there (a note attached to the old marker may hold it), and keep the same number in the marker, the caption and the image file's name.`,
        }];
      });
    },
  },
  {
    id: 'figure-callouts',
    kind: 'figure-to-supply',
    needs: 'a rule that the text refers to every figure',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'figures.callouts', where: params => params.required === true }); return rule && figuresByChapter(context).some(({ figures }) => figures.some(figure => figure.label)) ? { rule } : null; },
    run: context => figuresByChapter(context).flatMap(({ chapter, figures }) => {
      const missing = withoutCallout(context, context.chapters[chapter], figures);
      if (!missing.length) return [];
      const label = context.settings.figureMarker?.label ?? 'Fig.';
      return [{
        paragraphIndex: figures[0].index,
        message: `The text does not refer to ${missing.length === figures.length ? (figures.length === 1 ? 'this figure' : `any of the ${figures.length} figures`) : `${plural(missing.length, 'figure')} of ${figures.length} (${missing.map(figure => figure.label).join(', ')})`} by number. The guidelines ask for a mention of each in the text, such as “see ${label} ${missing[0].label}”: add one where the text discusses the image.`,
      }];
    }),
  },
  {
    id: 'table-from-tabs',
    kind: 'table-from-tabs',
    needs: 'lines laid out with tabs that the formatter styled as a table',
    basis: context => (context.paragraphs.some(entry => entry.kind === 'paragraph' && context.roleOf(entry.index) === 'table' && entry.text.includes('\t')) ? { rule: null } : null),
    run: context => {
      const runs = [];
      let current = null;
      for (const entry of context.paragraphs) {
        if (entry.hints?.empty) continue;
        const tabbed = entry.kind === 'paragraph' && context.roleOf(entry.index) === 'table' && entry.text.includes('\t');
        if (tabbed) { if (current) current.push(entry); else runs.push(current = [entry]); } else current = null;
      }
      return runs.map(lines => ({
        paragraphIndex: lines[0].index,
        message: `${lines.length === 1 ? 'This line lays' : `These ${lines.length} lines lay`} out a table with tabs. ${lines.length === 1 ? 'It was' : 'They were'} given the table text style, but ${lines.length === 1 ? 'it is' : 'they are'} not a Word table, so the columns will not hold when the book is typeset: make ${lines.length === 1 ? 'it' : 'them'} a Word table (in Word, select the lines, then Table > Convert Text to Table), with a number and a caption if the guidelines ask for them.`,
      }));
    },
  },
  {
    id: 'table-for-layout',
    kind: 'table-for-layout',
    needs: 'Word tables holding running text or verse, which the formatter styled as tables',
    basis: context => (context.paragraphs.some(entry => entry.kind === 'table' && context.roleOf(entry.index) && context.roleOf(entry.index) !== 'table') ? { rule: null } : null),
    run: context => context.chapters.flatMap(chapter => {
      const tables = context.paragraphsOf(chapter).filter(entry => entry.kind === 'table' && context.roleOf(entry.index) && context.roleOf(entry.index) !== 'table');
      if (!tables.length) return [];
      return [{
        paragraphIndex: tables[0].index,
        message: `${tables.length === 1 ? 'This Word table holds' : `${tables.length} Word tables in this chapter, starting here, hold`} running text or verse set side by side (a text and its translation, say) rather than data, and ${tables.length === 1 ? 'was' : 'were'} given the table text style. If ${tables.length === 1 ? 'it is a parallel text' : 'they are parallel texts'}, tell the publisher's typesetter, so that ${tables.length === 1 ? 'it is' : 'they are'} not numbered and captioned as ${tables.length === 1 ? 'a table' : 'tables'}.`,
      }];
    }),
  },
];
