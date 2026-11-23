// To-do checks on chapter titles: a title the formatter divided at its colon (to verify), quotation
// marks the guidelines do not allow in titles, titles typed in capitals against a capitalization
// rule, and a long title with no subtitle where the guidelines ask for one. Pure: no DOM, no network.

import { DECLARED } from '../format/declared.js';
import { ruleWith } from './rules.js';

// Double quotation marks of any style, or an opening single one before a letter (an apostrophe
// inside or at the end of a word is not a quotation mark).
const QUOTATION_MARKS = /["“”„‟«»‹›]|(?:^|[\s([{—–-])['‘‚]\p{L}/u;
// A title longer than this, with no subtitle, is long enough that guidelines asking for long titles
// to be divided would divide it: about one printed line of a chapter's title page.
export const LONG_TITLE = 70;

const letters = text => text.match(/\p{L}/gu) ?? [];
/** True when a title or heading is typed in capitals: at least two words and no lower-case letter. */
export const inCapitals = text => letters(text).length >= 6 && !/\p{Ll}/u.test(text) && text.trim().split(/\s+/u).length >= 2;

/** The separator between the names of an author line with several names (", ", " and ", " & "), or null. */
export function nameSeparator(text) {
  const found = /\s*(,|&|\band\b|\bund\b|\bet\b|\be\b|\by\b)\s*/u.exec(text.trim());
  return found ? (found[1] === ',' ? ', ' : ` ${found[1]} `) : null;
}

const CASE_WORDS = { title: 'title case (capitals for the main words)', sentence: 'sentence case (a capital for the first word and for names only)' };

export const TITLE_CHECKS = [
  {
    id: 'title-split',
    kind: 'chapter-title',
    needs: 'a title the formatter divided at its colon',
    basis: context => (context.placesOf(DECLARED.titleSplit).length ? { rule: ruleWith(context.sheet, { slot: 'chapters.subtitle' }) } : null),
    run: context => context.placesOf(DECLARED.titleSplit).map(index => ({
      paragraphIndex: index,
      message: 'This title was divided at its colon into a main title and a subtitle, as the guidelines ask for long titles. Check that the division falls where you want it and that the subtitle reads well on its own.',
    })),
  },
  {
    id: 'title-quotation-marks',
    kind: 'chapter-title',
    needs: 'a rule that chapter titles have no quotation marks',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'titles.quotes', where: params => params.allowed === false }); return rule ? { rule } : null; },
    run: context => context.chapters.flatMap(chapter => {
      const lines = [context.partAt(chapter, 'title'), ...context.partsAt(chapter, 'subtitle')].filter(index => index !== null);
      // Marks the formatter removed (a pair around the title and its subtitle together) are gone.
      const removed = new Set(context.placesOf(DECLARED.titleQuotes));
      const left = (index, position) => {
        const text = context.textOf(index).trim();
        if (!removed.has(index)) return text;
        return position === 0 ? text.slice(1) : text.slice(0, -1);
      };
      if (!lines.some((index, position) => QUOTATION_MARKS.test(left(index, position)))) return [];
      return [{
        paragraphIndex: context.titleOf(chapter),
        message: 'This chapter title has quotation marks, which the guidelines do not allow in chapter titles. Remove them; if the title quotes a source, consider rewording it so that it says what the chapter is about.',
      }];
    }),
  },
  {
    id: 'title-capitals',
    kind: 'chapter-title',
    needs: 'a rule on capitals in titles and headings',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'headings.case' }); return rule ? { rule } : null; },
    run: (context, rule) => {
      const wanted = CASE_WORDS[rule.params?.case] ?? 'the capitalization they give';
      const titles = context.chapters.flatMap(chapter => [context.partAt(chapter, 'title'), ...context.partsAt(chapter, 'subtitle')].filter(index => index !== null && inCapitals(context.textOf(index))).map(index => ({
        paragraphIndex: index,
        message: `This title is typed in capital letters. The guidelines ask for ${wanted}: retype it that way, so that the publisher's styles can set it.`,
      })));
      const headings = context.chapters.flatMap(chapter => context.paragraphsOf(chapter).filter(entry => ['heading-1', 'heading-2'].includes(context.roleOf(entry.index)) && inCapitals(entry.text)).map(entry => ({
        kind: 'heading-case',
        paragraphIndex: entry.index,
        message: `This heading is typed in capital letters. The guidelines ask for ${wanted}: retype it that way.`,
      })));
      return [...titles, ...headings];
    },
  },
  {
    id: 'author-separators',
    kind: 'authors-joined-differently',
    needs: 'a rule on consistency across chapters, and author lines that join two or more names in different ways',
    basis: context => { const rule = ruleWith(context.sheet, { category: 'consistency' }); return rule ? { rule } : null; },
    run: context => {
      // The word or sign between the names on each chapter's author line(s) with more than one name.
      const lines = context.chapters.flatMap(chapter => context.partsAt(chapter, 'author')).map(index => ({ index, separator: nameSeparator(context.textOf(index)) })).filter(line => line.separator);
      const counts = new Map();
      for (const line of lines) counts.set(line.separator, (counts.get(line.separator) ?? 0) + 1);
      if (counts.size < 2) return [];
      const described = [...counts].sort((a, b) => b[1] - a[1]).map(([separator, count]) => `“${separator}” ${count === 1 ? 'once' : `${count} times`}`);
      return lines.map(line => ({
        paragraphIndex: line.index,
        message: `The chapters' author lines join names in different ways (${described.join(', ')}). Make them the same throughout the book, so that the names read alike on every chapter's first page.`,
      }));
    },
  },
  {
    id: 'title-long',
    kind: 'chapter-title',
    needs: 'a rule that long chapter titles are divided into a title and a subtitle',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'chapters.subtitle', where: params => params.split === true }); return rule ? { rule } : null; },
    run: context => {
      const split = new Set(context.placesOf(DECLARED.titleSplit));
      return context.chapters.flatMap(chapter => {
        const index = context.partAt(chapter, 'title');
        if (index === null || split.has(index) || context.partsAt(chapter, 'subtitle').length) return [];
        const length = Array.from(context.textOf(index).trim()).length;
        if (length <= LONG_TITLE) return [];
        return [{
          paragraphIndex: index,
          message: `This chapter title is long (${length} characters) and has no subtitle or colon to divide it at. The guidelines ask for a long title to be divided into a main title and a subtitle: decide where to divide it, or shorten it.`,
        }];
      });
    },
  },
];
