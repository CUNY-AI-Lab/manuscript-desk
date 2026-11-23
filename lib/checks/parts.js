// To-do checks on the parts of a whole work (a dissertation's above all): whether its parts come in
// the order the rule sheet gives and whether the required ones are there, what its title page
// states, and whether captions stand above or below their tables and figures as asked. The parts
// are found from the paragraph roles and the words of the front- and back-matter headings; nothing
// is moved or added: a part out of order or missing is a comment and a To-do. Pure: no DOM, no network.

import { partsOf } from '../rules/schema.js';
import { isAffiliation, titlePageFacts } from '../format/titles.js';
import { listed } from './context.js';
import { ruleWith } from './rules.js';

// The parts in plain words, for messages.
export const PART_NAMES = Object.freeze({
  'title-page': 'the title page', copyright: 'the copyright page', approval: 'the approval page', abstract: 'the abstract', dedication: 'the dedication',
  epigraph: 'the epigraph', foreword: 'the foreword', preface: 'the preface', acknowledgments: 'the acknowledgments', contents: 'the table of contents',
  'list-of-tables': 'the list of tables', 'list-of-figures': 'the list of figures', 'list-of-abbreviations': 'the list of abbreviations', body: 'the first chapter',
  appendix: 'the appendices', notes: 'the notes', glossary: 'the glossary', bibliography: 'the bibliography', vita: 'the vita',
});

// A front- or back-matter heading's words, as the part it opens, in English and a few other languages.
const HEADINGS = [
  ['approval', /^(?:approval|approval page|committee|signature page|dissertation committee)\b/iu],
  ['abstract', /^(?:abstract|summary|riassunto|resumen|résumé|zusammenfassung)\b/iu],
  ['dedication', /^dedicat/iu],
  ['foreword', /^foreword\b/iu],
  ['preface', /^(?:preface|prefazione|prefacio|préface|vorwort)\b/iu],
  ['acknowledgments', /^(?:acknowledg|ringraziamenti|agradecimientos|remerciements|danksagung)/iu],
  ['list-of-tables', /^(?:list of )?tables\b/iu],
  ['list-of-figures', /^(?:list of )?(?:figures|illustrations|plates|maps)\b/iu],
  ['list-of-abbreviations', /^(?:list of )?abbreviations\b/iu],
  ['contents', /^(?:table of )?contents\b|^(?:indice|índice|sommaire|inhalt)\b/iu],
  ['appendix', /^(?:appendi|annex|allegat)/iu],
  ['glossary', /^glossar/iu],
  ['notes', /^(?:end)?notes$/iu],
  ['vita', /^(?:vita|curriculum vitae|autobiographical statement|biographical (?:sketch|statement)|about the author)\b/iu],
];
/** The part of the front or back matter a heading's words name ("acknowledgments"), or null. */
export const frontMatterPart = text => HEADINGS.find(([, pattern]) => pattern.test(String(text ?? '').trim()))?.[0] ?? null;
const COPYRIGHT_LINE = /^\s*(?:©|\(c\)|copyright\b)/iu;

/**
 * Where each part of the work starts (source paragraph index), in document order. A part found
 * more than once (a bibliography after every chapter) is placed at its last occurrence, except the
 * chapters' body, which starts at the first chapter.
 * @returns {Map<string, number>}
 */
export function partsFound(context) {
  const found = new Map();
  const first = (part, index) => { if (!found.has(part)) found.set(part, index); };
  const firstChapter = context.chapters[0]?.first ?? null;
  for (const entry of context.paragraphs) {
    if (entry.hints?.empty !== false) continue;
    const role = context.roleOf(entry.index);
    const text = entry.text.trim();
    const before = firstChapter === null || entry.index < firstChapter;
    if (role === 'title-page') first('title-page', entry.index);
    else if (role === 'copyright-page' || (before && role && COPYRIGHT_LINE.test(text))) first('copyright', entry.index);
    else if (role === 'approval-page') first('approval', entry.index);
    else if (role === 'dedication') first('dedication', entry.index);
    else if (role === 'appendix-heading') first('appendix', entry.index);
    else if (role === 'contents-entry') first('contents', entry.index);
    else if (role === 'abstract' && before) first('abstract', entry.index);
    else if (role === 'bibliography-heading') found.set('bibliography', entry.index);
    else if (role === 'front-matter-heading') {
      const part = HEADINGS.find(([, pattern]) => pattern.test(text))?.[0];
      // A heading precedes its section's lines, so it marks where the part starts.
      if (part === 'contents' && found.has('contents') && found.get('contents') > entry.index) found.set('contents', entry.index);
      else if (part) first(part, entry.index);
      if (part === 'approval' && found.get('approval') > entry.index) found.set('approval', entry.index);
    }
  }
  if (firstChapter !== null) found.set('body', firstChapter);
  // The lists of tables and figures are often headed by a line that reads as a contents entry.
  return new Map([...found].sort((a, b) => a[1] - b[1]));
}

/** The parts that stand out of the order given: those outside the longest run that keeps it. */
export function outOfOrder(order, found) {
  const present = order.filter(part => found.has(part)).map(part => ({ part, at: found.get(part) }));
  // Longest increasing subsequence of positions, by the order's sequence.
  const best = present.map(() => 1);
  const back = present.map(() => -1);
  present.forEach((item, i) => {
    for (let j = 0; j < i; j += 1) if (present[j].at < item.at && best[j] + 1 > best[i]) { best[i] = best[j] + 1; back[i] = j; }
  });
  let end = best.indexOf(Math.max(0, ...best));
  const kept = new Set();
  while (end >= 0) { kept.add(present[end].part); end = back[end]; }
  return present.filter(item => !kept.has(item.part));
}

const isTableCaption = text => /^\s*(?:table|tab\.|tabella|tabla|tableau|tabelle)\s*[\dIVXLC]/iu.test(text);
const isFigureCaption = text => /^\s*(?:figure|fig\.|figura|abbildung|abb\.|illustration|plate|map|chart|graph)\s*[\dIVXLC]/iu.test(text);

/** The caption next to an element: { index, side: 'above' | 'below' } or null, skipping empty paragraphs. */
function captionBeside(context, position, test) {
  const list = context.paragraphs;
  const look = (step, side) => {
    for (let at = position + step; at >= 0 && at < list.length; at += step) {
      const entry = list[at];
      if (entry.hints?.empty !== false) continue;
      return entry.kind === 'paragraph' && test(entry.text) ? { index: entry.index, side } : null;
    }
    return null;
  };
  return look(-1, 'above') ?? look(1, 'below');
}

// What a title page can be checked for, read from its lines and their parts.
const MONTH = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu;
const ELEMENT_TESTS = {
  title: ({ parts }) => parts.includes('title'),
  author: ({ parts }) => parts.includes('author'),
  statement: ({ lines, parts }) => lines.some((line, at) => parts[at] === 'statement' && /\b(?:dissertation|thesis|tesi|tesis|th[eè]se|capstone|submitted|presented|fulfil+ment|candidacy)\b/iu.test(line)),
  degree: ({ text }) => /\b(?:doctor|master|bachelor)\s+of\b|\bph\.?\s?d\b|\bdoctorate\b|\bm\.(?:a|s|phil)\.?(?:\s|$)|\b(?:laurea|dottorato|doctorat|doctorado|doutorado|mestrado|maestr[ií]a|magister|promotion)\b/iu.test(text),
  program: ({ text }) => /\b(?:program|programme|curriculum|corso di laurea|department|dipartimento|departamento|d[ée]partement|graduate faculty in|faculty of|school of)\b/iu.test(text),
  institution: ({ lines }) => lines.some(line => isAffiliation(line)),
  year: ({ text }) => /\b(?:19|20)\d{2}\b/u.test(text),
  month: ({ text }) => MONTH.test(text),
  advisor: ({ text }) => /\b(?:advis[eo]r|supervisor|director|chair|committee|relat(?:ore|rice)|correlat(?:ore|rice)|tutor|promotor|betreuer\w*|directeur|directrice)\b/iu.test(text),
};
const ELEMENT_NAMES = { title: 'the full title', author: 'the author’s full name', statement: 'the statement of what the work is and what it is submitted for', degree: 'the degree', program: 'the program', institution: 'the institution', year: 'the year', month: 'the month', advisor: 'the advisor' };

export const PARTS_CHECKS = [
  {
    id: 'no-chapters',
    kind: 'no-chapters',
    needs: 'a book or dissertation in which no chapter title was labelled',
    basis: context => (['monograph', 'edited-collection', 'dissertation'].includes(context.sheet?.docType) && !context.chapters.length && Object.keys(context.roles).length ? { rule: null } : null),
    run: () => [{
      paragraphIndex: null,
      message: 'No chapter was found, because no paragraph is labelled as a chapter\u2019s title block (chapter titles typed in Word\u2019s Heading 1 style are sometimes labelled as section headings). Without chapters the tool could not number the front matter apart, start each chapter on a new page or restart the notes in each chapter. In step 5, give each chapter\u2019s title (and its label, such as \u201cChapter 1\u201d) the label \u201cChapter title block\u201d, then format again.',
    }],
  },
  {
    id: 'parts-order',
    kind: 'parts-order',
    needs: 'a rule giving the order of the work’s parts',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'matter.order' }); return rule ? { rule } : null; },
    run: (context, rule) => {
      const order = partsOf(rule.params.order);
      const found = partsFound(context);
      return outOfOrder(order, found).map(({ part }) => {
        const at = order.indexOf(part);
        const earlier = order.slice(0, at).filter(other => found.has(other) && found.get(other) > found.get(part)).map(other => PART_NAMES[other]);
        const later = order.slice(at + 1).filter(other => found.has(other) && found.get(other) < found.get(part)).map(other => PART_NAMES[other]);
        const where = [earlier.length ? `after ${listed(earlier)}` : '', later.length ? `before ${listed(later)}` : ''].filter(Boolean).join(' and ');
        return { paragraphIndex: found.get(part), message: `${PART_NAMES[part].charAt(0).toUpperCase()}${PART_NAMES[part].slice(1)} is out of the order the guidelines give: it should come ${where}. Move it there (the tool does not move parts). The order asked for: ${order.map(name => PART_NAMES[name].replace(/^the /u, '')).join(', ')}.` };
      });
    },
  },
  {
    id: 'parts-missing',
    kind: 'parts-missing',
    needs: 'a rule naming the parts the work must have',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'matter.order', where: params => typeof params.required === 'string' }); return rule ? { rule } : null; },
    run: (context, rule) => {
      const found = partsFound(context);
      const hasTables = context.paragraphs.some(entry => entry.kind === 'table' || context.roleOf(entry.index) === 'table');
      const hasFigures = context.paragraphs.some(entry => entry.hints?.image || context.roleOf(entry.index) === 'figure');
      // A list of tables or figures is required only when the work has tables or figures.
      const needed = partsOf(rule.params.required).filter(part => (part === 'list-of-tables' ? hasTables : part === 'list-of-figures' ? hasFigures : true));
      return needed.filter(part => !found.has(part)).map(part => ({
        paragraphIndex: null,
        message: `The manuscript has no ${PART_NAMES[part].replace(/^the /u, '')}${part === 'list-of-tables' || part === 'list-of-figures' ? ` (it has ${part === 'list-of-tables' ? 'tables' : 'figures'}, so the guidelines require one)` : ''}, or the tool did not recognize it. The guidelines require it: add it in its place in the order${part === 'contents' || part.startsWith('list-of') ? ' (in Word, References > Table of Contents, or Insert Table of Figures for captions made with Insert Caption; in Google Docs, Insert > Table of contents)' : ''}. If it is there under another heading, check its label in step 5.`,
      }));
    },
  },
  {
    id: 'title-page-elements',
    kind: 'title-page-elements',
    needs: 'a rule on what the title page states',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'title-page.elements' }); return rule ? { rule } : null; },
    run: (context, rule) => {
      const asked = partsOf(rule.params.elements);
      // The title page: its lines, and a picture or a table between them (a logo, a table of the
      // candidate's and advisors' names), whose cells are read as lines too.
      const page = [];
      let between = [];
      for (const entry of context.paragraphs) {
        if (entry.hints?.empty !== false) continue;
        const role = context.roleOf(entry.index);
        if (role === 'title-page') { page.push(...between, entry); between = []; }
        else if (page.length && (role === 'figure' || role === 'table' || entry.kind === 'table')) between.push(entry);
        else if (page.length) break;
      }
      if (!page.length) return [{ paragraphIndex: null, message: `No title page was found (no paragraph is labelled as one in step 5). The guidelines ask that it state ${listed(asked.map(element => ELEMENT_NAMES[element]))}.` }];
      const facts = titlePageFacts(page.filter(entry => entry.text.trim()));
      const missing = asked.filter(element => !ELEMENT_TESTS[element](facts));
      if (!missing.length) return [];
      return [{ paragraphIndex: page[0].index, message: `The title page does not seem to state ${listed(missing.map(element => ELEMENT_NAMES[element]))}, which the guidelines ask for. Add ${missing.length === 1 ? 'it' : 'them'}, in the form the guidelines’ sample shows.` }];
    },
  },
  {
    id: 'caption-position',
    kind: 'caption-position',
    needs: 'a rule on where captions go',
    basis: context => { const rule = ruleWith(context.sheet, { slot: 'captions.position' }); return rule ? { rule } : null; },
    run: (context, rule) => {
      const out = [];
      const { tables, figures } = rule.params;
      context.paragraphs.forEach((entry, position) => {
        if (tables && (entry.kind === 'table')) {
          const caption = captionBeside(context, position, isTableCaption);
          if (caption && caption.side !== tables) out.push({ paragraphIndex: caption.index, message: `This table’s title is ${caption.side} the table; the guidelines put table titles ${tables} the table. Move it ${tables} (the tool does not move text).` });
        }
        if (figures && entry.kind === 'paragraph' && entry.hints?.image) {
          const caption = captionBeside(context, position, isFigureCaption);
          if (caption && caption.side !== figures) out.push({ paragraphIndex: caption.index, message: `This figure’s caption is ${caption.side} the figure; the guidelines put figure captions ${figures} the figure. Move it ${figures} (the tool does not move text).` });
        }
      });
      return out;
    },
  },
];
