// The work the decide step does by itself, in code, because the guidelines or plain good practice
// settle it and no judgment is needed: the typed contents list replaced by one Word builds from the
// chapter titles; a repeated-author dash written as the name from the entry above, when a rule asks
// for full names; a title or heading typed in capitals retyped in title case, when a rule asks for
// title case; a passage typed twice in a row removed once; a stray letter on a line of its own in
// running text or a bibliography removed; and a list of illustrations from the figures' numbers and
// captions, when a rule asks for one. Each operation is a set of declared edits for formatDocx
// (lib/format/format.js), with what it resolves. These are the only changes to the words of a title,
// a name or a contents line the decide step ever makes. Pure: no DOM, no network.

import { DECLARED } from '../format/declared.js';
import { ruleWith, rulesWith } from '../checks/rules.js';

const isEmpty = entry => !entry || entry.hints?.empty === true || !entry.text.trim();
const normal = text => text.replace(/\s+/gu, ' ').trim();
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as', 'into', 'upon', 'via', 'per', 'vs']);
const ROMAN = /^[IVXLCDM]+$/u;
// The lower case of an upper-case letter (the Turkish dotted capital I as a plain i).
const lower = text => text.replaceAll('İ', 'i').toLocaleLowerCase();

/** True when a line's letters are all capitals and it has a word of at least two letters. */
export function typedInCapitals(text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase() && /\p{L}{2}/u.test(text);
}

/**
 * A line typed in capitals in title case: every word capitalized but the short words a title keeps
 * in lower case (not first, not last, not after a colon); roman numerals stay. Letters only change
 * case: no letter, space or sign is added or taken away (the dotted capital I becomes a plain i).
 */
export function titleCased(text) {
  const tokens = text.split(/(\s+)/u);
  const words = tokens.map((token, at) => ({ token, at })).filter(({ token }) => /\p{L}/u.test(token));
  let afterColon = true;
  return tokens.map((token, at) => {
    if (!/\p{L}/u.test(token)) { if (/:\s*$/u.test(token)) afterColon = true; return token; }
    const core = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const position = words.findIndex(entry => entry.at === at);
    const last = position === words.length - 1;
    const first = afterColon;
    afterColon = /:$/u.test(token);
    if (ROMAN.test(core) && core.length <= 6) return token;
    const down = lower(token);
    if (!first && !last && MINOR_WORDS.has(lower(core))) return down;
    // The first letter of the word, and the first letter after a hyphen, are capitals.
    return down.replace(/(^|[-‐–(“‘"'/])(\p{L})/gu, (match, sign, letter) => `${sign}${letter.toLocaleUpperCase()}`);
  }).join('');
}

const DASH = /^(\s*)([—–\-_]{2,}|[—–]{1})(?=\s*[.,])/u;

/**
 * The author part of a bibliography entry: up to the first full stop that ends a word which is not
 * an initial, or that ends a run of initials right after an inverted surname ("Writer, J. M." in
 * "Writer, J. M. Paper."; but "Sample, Cy, and J. M. Writer" in full).
 */
export function authorOf(text) {
  const tokens = text.trim().split(/\s+/u);
  const initial = token => /^\p{Lu}\.(?:-?\p{Lu}\.)*$/u.test(token);
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (!/\.$/u.test(token)) continue;
    if (initial(token)) {
      if (at + 1 < tokens.length && initial(tokens[at + 1])) continue;
      let start = at;
      while (start > 0 && initial(tokens[start - 1])) start -= 1;
      if (!(start === 1 && /,$/u.test(tokens[0]))) continue;
    }
    const author = tokens.slice(0, at + 1).join(' ').replace(/\.$/u, '');
    return author.length >= 3 && /\p{L}{2}/u.test(author) && !DASH.test(author) ? author : null;
  }
  return null;
}

// Roles of running text and references, where a duplicate or a stray letter may be removed.
const RUNNING = new Set(['body', 'block-quotation', 'verse', 'list-item', 'bibliography-entry']);

const ILLUSTRATIONS = /\blists? of (?:illustrations|figures)\b/iu;

/**
 * The operations, each { id, kind, edits, paragraphs, resolves(finding), count, words }.
 * @param {{ paragraphs: Array<object>, roles: Record<number, string>, chapters: Array<object>, sheet: object | null, figures?: Array<object> }} input
 *   chapters: the formatter's report.chapters (first, last, titleBlock, parts, number); figures: its
 *   report.figures (index, label, captionAt)
 */
export function mechanicalOps({ paragraphs, roles, chapters = [], sheet = null, figures = [] }) {
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const ops = [];
  const add = op => ops.push({ id: `op-${ops.length + 1}`, ...op });
  const firstChapter = chapters[0]?.first ?? Infinity;
  const titleCase = rulesWith(sheet, { slot: 'headings.case' }).some(rule => rule.params?.case === 'title');
  // A line as it reads once the operations below are made (a title in capitals in title case).
  const asMade = text => (titleCase && typedInCapitals(text) ? titleCased(text) : text);

  // The typed contents list, before the first chapter: deleted line by line (a line Word cannot
  // delete safely, one carrying a section break, stays), and a contents field in its place whose
  // typed-in result lists the headings and titles after it, which Word replaces when it updates.
  const entries = paragraphs.filter(entry => entry.index < firstChapter && roleOf(entry.index) === 'contents-entry' && !isEmpty(entry));
  if (entries.length >= 2 && chapters.length) {
    const start = entries[0].index;
    const end = entries[entries.length - 1].index;
    const block = entries.filter(entry => entry.index <= end);
    const heading = [...paragraphs].reverse().find(entry => entry.index < start && !isEmpty(entry));
    const headed = heading && roleOf(heading.index) === 'front-matter-heading' ? heading.index : null;
    const titleOf = chapter => {
      const parts = chapter.parts ?? [];
      const line = part => (chapter.titleBlock ?? []).filter((_, at) => parts[at] === part).map(index => asMade(normal(byIndex.get(index)?.text ?? ''))).filter(Boolean);
      const [title] = line('title');
      return [title ?? normal(byIndex.get(chapter.first)?.text ?? ''), ...line('subtitle')].filter(Boolean).join(': ');
    };
    const lines = [];
    for (const entry of paragraphs) {
      if (entry.index <= end || isEmpty(entry)) continue;
      const role = roleOf(entry.index);
      if (role === 'front-matter-heading' || role === 'part-title' || role === 'appendix-heading') lines.push({ text: normal(entry.text), style: 'contents-entry' });
      const chapter = chapters.find(item => item.first === entry.index);
      if (chapter) lines.push({ text: titleOf(chapter), style: 'contents-entry' });
    }
    const contents = new Set(block.map(entry => entry.index));
    add({
      kind: 'contents',
      edits: [{ op: 'insert', before: start, field: 'contents', lines, kind: DECLARED.contentsInserted }, ...block.map(entry => ({ op: 'delete', from: entry.index, to: entry.index, kind: DECLARED.contentsReplaced }))],
      paragraphs: [...(headed !== null ? [headed] : []), ...contents],
      count: block.length,
      words: `the typed contents list (${block.length} lines) replaced by a contents list Word builds from the chapter titles`,
      // Resolved: the list's own summary of mismatches, and a chapter missing from it. A title worded
      // differently in the list and on its title page stays a question: which wording is right is
      // the author's to say.
      // A query about a line of the typed list is resolved too: the line is gone.
      resolves: finding => (finding.check === 'contents-against-chapters' && (contents.has(finding.paragraphIndex) || finding.paragraphIndex === headed || /^This chapter is not in the contents list/u.test(finding.message)))
        || (finding.check === 'reading' && contents.has(finding.paragraphIndex) && !Number.isInteger(finding.other?.paragraph)),
      flag: headed ?? start,
    });
  }

  // Repeated-author dashes, when a rule asks for the name every time.
  const fullNames = ruleWith(sheet, { slot: 'references.repeated-author', where: params => params.form === 'name' });
  if (fullNames) {
    let name = null;
    const replaced = [];
    const edits = [];
    for (const entry of paragraphs) {
      if (isEmpty(entry)) continue;
      if (roleOf(entry.index) !== 'bibliography-entry') { name = null; continue; }
      const dash = DASH.exec(entry.text);
      if (!dash) { name = authorOf(entry.text); continue; }
      if (!name) continue;
      edits.push({ op: 'replace', paragraph: entry.index, before: dash[2], after: name, kind: DECLARED.authorDash });
      replaced.push(entry.index);
    }
    if (edits.length) {
      const set = new Set(replaced);
      add({ kind: 'dash', edits, paragraphs: replaced, count: edits.length, words: `${edits.length === 1 ? 'a dash for a repeated author' : `${edits.length} dashes for repeated authors`} in the bibliographies written as the name from the entry above`, resolves: finding => finding.check === 'repeated-author-dash' && set.has(finding.paragraphIndex) });
    }
  }

  // Titles and headings typed in capitals, when a rule asks for title case.
  if (titleCase) {
    const edits = [];
    const at = [];
    for (const chapter of chapters) {
      (chapter.titleBlock ?? []).forEach((index, position) => {
        const part = chapter.parts?.[position];
        const entry = byIndex.get(index);
        if ((part === 'title' || part === 'subtitle') && entry && typedInCapitals(entry.text)) {
          const text = entry.text.trim();
          edits.push({ op: 'replace', paragraph: index, before: text, after: titleCased(text), kind: DECLARED.titleCase });
          at.push(index);
        }
      });
    }
    for (const entry of paragraphs) {
      if (!/^heading-[12]$/u.test(roleOf(entry.index) ?? '') || isEmpty(entry) || !typedInCapitals(entry.text)) continue;
      const text = entry.text.trim();
      edits.push({ op: 'replace', paragraph: entry.index, before: text, after: titleCased(text), kind: DECLARED.titleCase });
      at.push(entry.index);
    }
    if (edits.length) {
      const set = new Set(at);
      add({ kind: 'title-case', edits, paragraphs: at, count: edits.length, words: `${edits.length === 1 ? 'a title or heading' : `${edits.length} titles and headings`} typed in capitals retyped in title case, as the guidelines ask (check names and abbreviations)`, resolves: finding => finding.check === 'title-capitals' && set.has(finding.paragraphIndex) });
    }
  }

  // A passage typed twice in a row: two or more paragraphs, or one long one, the same word for word
  // (spaces aside). The first copy goes, unless it holds a note the second does not.
  const running = paragraphs.filter(entry => !isEmpty(entry) && RUNNING.has(roleOf(entry.index)));
  const taken = new Set();
  for (let at = 0; at < running.length; at += 1) {
    if (taken.has(running[at].index)) continue;
    for (let size = Math.min(12, Math.floor((running.length - at) / 2)); size >= 1; size -= 1) {
      const first = running.slice(at, at + size);
      const second = running.slice(at + size, at + 2 * size);
      const together = [...first, ...second];
      // Consecutive in the file (empty paragraphs between them aside), the same roles, the same words.
      const consecutive = together.every((entry, position) => position === 0 || paragraphs.slice(together[position - 1].index + 1, entry.index).every(isEmpty));
      if (!consecutive || !first.every((entry, position) => normal(entry.text) === normal(second[position].text) && roleOf(entry.index) === roleOf(second[position].index))) continue;
      const length = first.reduce((sum, entry) => sum + normal(entry.text).length, 0);
      if (size === 1 ? length < 200 : length < 40) continue;
      const noted = list => list.some(entry => entry.hints?.footnote);
      const drop = noted(first) && !noted(second) ? second : first;
      const keep = drop === first ? second : first;
      for (const entry of together) taken.add(entry.index);
      const indices = new Set(together.map(entry => entry.index));
      add({
        kind: 'duplicate',
        edits: [{ op: 'delete', from: drop[0].index, to: drop[drop.length - 1].index, kind: DECLARED.duplicateRemoved }],
        paragraphs: drop.map(entry => entry.index),
        kept: keep.map(entry => entry.index),
        count: drop.length,
        words: `a passage of ${drop.length === 1 ? 'one paragraph' : `${drop.length} paragraphs`} typed twice in a row removed once (check that the copy kept is the one you want)`,
        resolves: finding => finding.kind === 'stray-or-duplicated-text' && indices.has(finding.paragraphIndex),
        flag: keep[0].index,
      });
      break;
    }
  }

  // A stray letter or two on a line of its own, between two paragraphs of the same running role.
  const nonEmpty = paragraphs.filter(entry => !isEmpty(entry));
  nonEmpty.forEach((entry, position) => {
    const role = roleOf(entry.index);
    if (!['body', 'bibliography-entry'].includes(role) || !/^\p{L}{1,2}$/u.test(entry.text.trim()) || entry.hints?.footnote || taken.has(entry.index)) return;
    const before = nonEmpty[position - 1];
    const after = nonEmpty[position + 1];
    if (!before || !after || roleOf(before.index) !== role || roleOf(after.index) !== role || normal(before.text).length < 20 || normal(after.text).length < 20) return;
    add({
      kind: 'stray',
      edits: [{ op: 'delete', from: entry.index, to: entry.index, kind: DECLARED.strayRemoved }],
      paragraphs: [entry.index],
      count: 1,
      words: 'a stray letter on a line of its own removed',
      resolves: finding => finding.kind === 'stray-or-duplicated-text' && finding.paragraphIndex === entry.index,
    });
  });

  // A list of illustrations, when a rule asks for one and the manuscript has numbered figures but no
  // such list: a heading and one line per figure (its number and caption), after the contents list.
  const asksForList = (sheet?.rules ?? []).some(rule => rule.enabled !== false && ILLUSTRATIONS.test(`${rule.statement} ${rule.source?.quote ?? ''}`));
  const hasList = paragraphs.some(entry => entry.index < firstChapter && ['front-matter-heading', 'contents-entry'].includes(roleOf(entry.index)) && /^\s*(?:list of )?(?:illustrations|figures)\b/iu.test(entry.text));
  if (asksForList && !hasList && figures.length && chapters.length) {
    const lastContents = entries.length ? entries[entries.length - 1].index : null;
    const after = paragraphs.find(entry => !isEmpty(entry) && entry.index > (lastContents ?? -1) && entry.index < firstChapter && roleOf(entry.index) === 'front-matter-heading') ?? byIndex.get(firstChapter);
    if (after) {
      const lines = [{ text: 'List of Illustrations', style: 'front-matter-heading' }, ...figures.map(figure => {
        const caption = Number.isInteger(figure.captionAt) ? normal(byIndex.get(figure.captionAt)?.text ?? '') : '';
        return { text: `Figure ${figure.label}${caption ? ` ${caption}` : ''}`, style: 'contents-entry' };
      })];
      add({ kind: 'illustrations', edits: [{ op: 'insert', before: after.index, lines, kind: DECLARED.illustrationsList }], paragraphs: [], count: figures.length, words: `a list of illustrations (${figures.length === 1 ? 'one figure' : `${figures.length} figures`}) added after the contents, from the figure numbers and captions (complete the captions there and in the text)`, resolves: () => false, flag: after.index });
    }
  }

  return ops;
}

/** The operations whose every edit the formatter applied (a contents list: its field and at least one deletion). */
export function appliedOps(ops, edits) {
  const applied = new Set(edits?.applied ?? []);
  return ops.filter(op => (op.kind === 'contents' ? applied.has(op.edits[0]) && op.edits.slice(1).some(edit => applied.has(edit)) : op.edits.every(edit => applied.has(edit))));
}
