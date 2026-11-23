// To-do checks on what a chapter must carry besides its text: an abstract and keywords where the
// guidelines ask for them (present, of the length and number asked, written in one form), notes on
// a title or an author's name where the guidelines forbid them, and dashes standing for a repeated
// author in a bibliography where the guidelines ask for the full name. Pure: no DOM, no network.

import { plural } from './context.js';
import { firstRule, ruleWith } from './rules.js';

// A label at the start of an abstract or keywords paragraph: "Abstract:", "Key words:", "Parole chiave:".
const LABEL = /^\s*[\p{L}][\p{L}\p{M}'’-]*(?:\s[\p{L}][\p{L}\p{M}'’-]*)?\s*[:：.—–-]\s*/u;
// A bibliography entry that begins with a dash or rule standing for the author of the entry above.
const REPEATED_AUTHOR = /^\s*(?:[—―]|[–‒-]{2,}|_{2,})/u;

const withoutLabel = text => {
  const match = LABEL.exec(text);
  return match && match[0].length <= 30 ? text.slice(match[0].length) : text;
};
const wordCount = text => text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;

/** The keywords of a keywords paragraph: { items, separators } (the separators used between them). */
export function parseKeywords(text) {
  const body = withoutLabel(text).trim().replace(/[.;,]+$/u, '');
  const separator = body.includes(';') ? ';' : body.includes(',') ? ',' : null;
  const items = (separator ? body.split(separator) : [body]).map(item => item.trim()).filter(Boolean);
  // With semicolons between keywords, some items also holding commas means both are used as separators.
  const mixed = separator === ';' && items.some(item => item.includes(',')) && items.some(item => !item.includes(','));
  return { items, mixed };
}

const range = ({ min, max }) => (min === max ? `${max}` : min ? `${min} to ${max}` : `at most ${max}`);

export const MATTER_CHECKS = [
  {
    id: 'abstract-missing',
    kind: 'abstract-missing',
    needs: 'a rule asking for abstracts or keywords, in a work whose chapters each have one (a dissertation has one abstract for the whole, checked with the order of its parts)',
    basis: context => { const rule = context.sheet?.docType !== 'dissertation' && firstRule(context.sheet, [{ slot: 'abstract.words' }, { slot: 'keywords.count' }, { category: 'abstract-keywords' }]); return rule ? { rule } : null; },
    run: context => {
      const abstractRule = firstRule(context.sheet, [{ slot: 'abstract.words' }, { category: 'abstract-keywords' }]);
      const keywordsRule = firstRule(context.sheet, [{ slot: 'keywords.count' }, { category: 'abstract-keywords' }]);
      return context.chapters.flatMap(chapter => {
        const noAbstract = !context.withRole(chapter, 'abstract').length;
        const noKeywords = !context.withRole(chapter, 'keywords').length;
        if (!noAbstract && !noKeywords) return [];
        const abstract = abstractRule?.slot === 'abstract.words' ? `an abstract (about ${abstractRule.params.max} words)` : 'an abstract';
        const keywords = keywordsRule?.slot === 'keywords.count' ? `keywords (${range(keywordsRule.params)})` : 'keywords';
        const [missing, asked, them] = noAbstract && noKeywords ? ['no abstract and no keywords', `${abstract} and ${keywords}`, 'them']
          : noAbstract ? ['no abstract', abstract, 'it'] : ['no keywords', keywords, 'them'];
        return [{
          paragraphIndex: chapter.titleBlock[chapter.titleBlock.length - 1],
          rule: noAbstract ? abstractRule : keywordsRule,
          message: `This chapter has ${missing}. The guidelines ask for ${asked} for every chapter: write ${them} and add ${them} after the title, or supply ${them} in the way the guidelines say.`,
        }];
      });
    },
  },
  {
    id: 'abstract-length',
    kind: 'abstract-length',
    needs: 'a rule on the length of an abstract',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'abstract.words' }); return rule ? { rule } : null; },
    run: (context, rule) => context.chapters.flatMap(chapter => {
      const parts = context.withRole(chapter, 'abstract');
      if (!parts.length) return [];
      const words = parts.reduce((sum, entry, at) => sum + wordCount(at === 0 ? withoutLabel(entry.text) : entry.text), 0);
      if (words <= rule.params.max) return [];
      return [{
        paragraphIndex: parts[0].index,
        message: `This abstract has ${words} words; the guidelines ask for about ${rule.params.max}. Shorten it, or check with the editors how strictly the length applies.`,
      }];
    }),
  },
  {
    id: 'keywords-form',
    kind: 'keywords-form',
    needs: 'a rule on the number of keywords',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'keywords.count' }); return rule ? { rule } : null; },
    run: (context, rule) => context.chapters.flatMap(chapter => {
      const entry = context.withRole(chapter, 'keywords')[0];
      if (!entry) return [];
      const { items, mixed } = parseKeywords(entry.text);
      const problems = [];
      const { min, max } = rule.params;
      if (items.length > max || (min && items.length < min)) problems.push(`there are ${items.length}, where the guidelines ask for ${range(rule.params)}`);
      const seen = new Map();
      for (const item of items) { const key = item.toLocaleLowerCase(); seen.set(key, (seen.get(key) ?? 0) + 1); }
      const repeated = [...seen].filter(([, count]) => count > 1).length;
      if (repeated) problems.push(`${plural(repeated, 'keyword')} ${repeated === 1 ? 'appears' : 'appear'} more than once`);
      if (mixed) problems.push('some keywords are separated by semicolons and others by commas');
      if (!problems.length) return [];
      return [{
        paragraphIndex: entry.index,
        message: `In these keywords, ${problems.join('; ')}. Correct the list.`,
      }];
    }),
  },
  {
    id: 'note-on-title',
    kind: 'note-on-title',
    needs: 'a rule that chapter titles and author names carry no notes',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'notes.titles', where: params => params.allowed === false }); return rule ? { rule } : null; },
    run: context => context.chapters.flatMap(chapter => chapter.titleBlock.filter(index => context.byIndex.get(index)?.hints?.footnote).map(index => ({
      paragraphIndex: index,
      message: 'This line of the title block carries a note, and the guidelines want none there. Put what the note says where the guidelines direct (usually a short section closing the chapter), then delete the note.',
    }))),
  },
  {
    id: 'repeated-author-dash',
    kind: 'repeated-author-dash',
    needs: 'a rule that a repeated author is named in full',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'references.repeated-author', where: params => params.form === 'name' }); return rule ? { rule } : null; },
    run: context => context.chapters.flatMap(chapter => {
      const dashed = context.withRole(chapter, 'bibliography-entry').filter(entry => REPEATED_AUTHOR.test(entry.text));
      if (!dashed.length) return [];
      return [{
        paragraphIndex: dashed[0].index,
        message: `${dashed.length === 1 ? 'This entry begins' : `${dashed.length} entries in this bibliography, starting here, begin`} with a dash standing for the author of the entry above. The guidelines ask for the full name every time: replace ${dashed.length === 1 ? 'the dash' : 'each dash'} with the author's name or names.`,
      }];
    }),
  },
];
