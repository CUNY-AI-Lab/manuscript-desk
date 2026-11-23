// To-do checks on a chapter's sections and bibliography: heading numbers the formatter added (to
// verify where the text refers to sections by number), chapters whose typed heading numbers were
// kept and are incomplete, and bibliographies headed differently from chapter to chapter where the
// guidelines ask for one style across a collection. Pure: no DOM, no network.

import { DECLARED } from '../format/declared.js';
import { TYPED_NUMBER } from '../format/plan.js';
import { listed, plural } from './context.js';
import { ruleWith } from './rules.js';

const HEADINGS = new Set(['heading-1', 'heading-2']);
// A typed number that ends with a full stop: "2.1." where a decimal scheme shows "2.1".
const NUMBER_WITH_STOP = /^\s*\d{1,3}(?:\.\d{1,3})*\.\s/u;

export const SECTION_CHECKS = [
  {
    id: 'heading-numbers-added',
    kind: 'heading-numbering',
    needs: 'headings the formatter numbered',
    basis: context => (context.placesOf(DECLARED.headingNumbers).length ? { rule: ruleWith(context.sheet, { slot: 'headings.numbering' }) } : null),
    run: context => {
      const places = context.placesOf(DECLARED.headingNumbers);
      const chapters = new Set(places.map(index => context.chapterOf(index)).filter(at => at !== null));
      return [{
        paragraphIndex: places[0],
        message: `Section headings are now numbered through Word numbering (${plural(places.length, 'heading')} in ${plural(chapters.size, 'chapter')}), as the guidelines ask; the numbers start again in each chapter and are not typed text. Where the text refers to a section by its number, check that the number is still right.`,
      }];
    },
  },
  {
    id: 'heading-numbers-typed',
    kind: 'heading-numbering',
    needs: 'a rule that headings are numbered, and a chapter whose headings carry typed numbers',
    basis: context => {
      const rule = ruleWith(context.sheet, { slot: 'headings.numbering', where: params => params.scheme === 'decimal' });
      return rule && context.chapters.some(chapter => chapter.typedNumbers) ? { rule } : null;
    },
    run: context => context.chapters.flatMap(chapter => {
      if (!chapter.typedNumbers) return [];
      const headings = context.paragraphsOf(chapter).filter(entry => HEADINGS.has(context.roleOf(entry.index)));
      const untyped = headings.filter(entry => !TYPED_NUMBER.test(entry.text));
      const stopped = headings.filter(entry => NUMBER_WITH_STOP.test(entry.text));
      if (!untyped.length && !stopped.length) return [];
      const problems = [];
      if (untyped.length) problems.push(`${plural(untyped.length, 'heading')} of the ${headings.length} ${untyped.length === 1 ? 'has' : 'have'} no number (an opening section, say): decide whether to number ${untyped.length === 1 ? 'it' : 'them'}, since the guidelines ask for numbered headings`);
      if (stopped.length) problems.push(`${plural(stopped.length, 'number')} end${stopped.length === 1 ? 's' : ''} with a full stop (2.1. rather than 2.1)`);
      return [{
        paragraphIndex: headings[0].index,
        message: `This chapter's headings already carry typed numbers, so Word numbering was not added here and the numbers were left as typed. ${listed(problems).replace(/^./u, letter => letter.toUpperCase())}. If the text refers to sections by number, check those references after any change.`,
      }];
    }),
  },
  {
    id: 'bibliography-headings',
    kind: 'bibliography-headings',
    needs: 'a rule asking for consistency across the chapters of a collection',
    basis: context => { const rule = ruleWith(context.sheet, { category: 'consistency' }); return rule && context.chapters.length > 1 ? { rule } : null; },
    run: context => {
      const firsts = context.chapters.map(chapter => context.withRole(chapter, 'bibliography-heading')[0]).filter(Boolean);
      const groups = new Map();
      for (const entry of firsts) {
        // Capitals count: "Works cited" and "Works Cited" are two headings to make one.
        const shown = entry.text.trim().replace(/[\s:.]+$/u, '').replace(/\s+/gu, ' ');
        const key = shown;
        if (!groups.has(key)) groups.set(key, { shown, count: 0 });
        groups.get(key).count += 1;
      }
      if (groups.size < 2) return [];
      const ways = [...groups.values()].sort((a, b) => b.count - a.count).map(({ shown, count }) => `“${shown}” (${plural(count, 'chapter')})`);
      return [{
        paragraphIndex: firsts[0].index,
        message: `The chapters head their bibliographies in ${groups.size} different ways: ${listed(ways)}. The guidelines ask for one style across the volume: use the same heading, with the same capitals, in every chapter.`,
      }];
    },
  },
];
