// Cutting a manuscript's paragraph model into passages for the model that labels roles. A passage
// asks for a run of consecutive paragraphs, each shown on one line with its index, its direct
// formatting and its text (long ones shortened in the middle, their full length stated), and shows a
// few paragraphs before and after it as context only, so a passage that starts in the middle of a
// chapter, a quotation or a bibliography can still be read. Empty paragraphs are never asked; a run
// of them is shown as one marker line, because a blank line is itself a cue. By default each passage
// starts halfway through the previous one, so every paragraph is read twice, and reconcile keeps
// the reading in which it had the most context on both sides. Pure: no DOM, no network.

export const PASSAGE_DEFAULTS = { total: undefined, only: undefined, size: 12000, maxParagraphs: 40, before: 8, after: 4, overlap: 0, overlapShare: 0.5, maxChars: 600, head: 360, tail: 200 };

const ALIGN_WORDS = { center: 'centred', right: 'right-aligned', justify: 'justified', left: 'left-aligned' };
const points = value => `${Number(value.toFixed(1))}pt`;
const grouped = number => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The visible text of a paragraph on one line: line breaks and tabs shown as marks, and a long
// text shortened in the middle.
function lineText(text, { maxChars, head, tail }) {
  const flat = text.replace(/\r?\n/g, ' ⏎ ').replace(/\t/g, ' ⇥ ').replace(/[^\S ]+/g, ' ');
  const characters = Array.from(flat);
  if (characters.length <= maxChars) return { shown: flat, shortened: false };
  return { shown: `${characters.slice(0, head).join('').trimEnd()} […] ${characters.slice(-tail).join('').trimStart()}`, shortened: true };
}

/**
 * One paragraph as a passage line: "[index] (hints) text".
 * @param {{ index: number, kind: string, text: string, hints: object }} entry
 */
export function describeParagraph(entry, options = {}) {
  const settings = { ...PASSAGE_DEFAULTS, ...options };
  const { hints = {} } = entry;
  const { shown, shortened } = lineText(entry.text ?? '', settings);
  const marks = [];
  if (entry.kind === 'table') marks.push('table');
  else if (entry.kind === 'other') marks.push('block');
  if (ALIGN_WORDS[hints.align]) marks.push(ALIGN_WORDS[hints.align]);
  if (hints.indentLeft) marks.push(`left indent ${points(hints.indentLeft)}`);
  if (hints.indentRight) marks.push(`right indent ${points(hints.indentRight)}`);
  if (hints.indentFirst > 0) marks.push(`first-line indent ${points(hints.indentFirst)}`);
  else if (hints.indentFirst < 0) marks.push(`hanging indent ${points(-hints.indentFirst)}`);
  if (hints.size) marks.push(points(hints.size));
  if (hints.bold) marks.push('all bold');
  if (hints.italic) marks.push('all italic');
  if (hints.list) marks.push('numbered or bulleted');
  if (hints.image) marks.push('image');
  if (hints.footnote) marks.push('note reference');
  if (hints.pageBreak) marks.push('page break');
  if (hints.styleId) marks.push(`style ${hints.styleId}`);
  // The length is always given: a run of lines of nearly equal length reads as wrapped prose.
  const length = Array.from(entry.text ?? '').length;
  marks.push(shortened ? `${grouped(length)} characters, middle cut` : `${grouped(length)} characters`);
  return `[${entry.index}]${marks.length ? ` (${marks.join('; ')})` : ''} ${shown}`.trimEnd();
}

const isEmpty = entry => entry?.hints?.empty === true || (entry?.text ?? '').trim() === '' && entry?.hints?.image !== true;

// The lines for paragraphs list[from..to] (positions in the full list), empty ones folded into markers.
function lines(list, from, to, settings) {
  const out = [];
  let blank = 0;
  for (let at = from; at <= to; at += 1) {
    if (isEmpty(list[at])) { blank += 1; continue; }
    if (blank) out.push(blank === 1 ? '(empty paragraph)' : `(${blank} empty paragraphs)`);
    blank = 0;
    out.push(describeParagraph(list[at], settings));
  }
  if (blank && out.length) out.push(blank === 1 ? '(empty paragraph)' : `(${blank} empty paragraphs)`);
  return out;
}

/**
 * The passages for labelling `paragraphs` (the reader's model, in document order). With `only` (a
 * set of indices), only those paragraphs are asked, each run of them in passages of its own, with
 * the paragraphs around them as context.
 * @returns {Array<{ asked: number[], text: string }>} asked holds paragraph indices
 */
export function buildPassages(paragraphs, options = {}) {
  if (!Array.isArray(paragraphs)) throw new TypeError('buildPassages needs the paragraph list.');
  const settings = { ...PASSAGE_DEFAULTS, ...options };
  const { size, maxParagraphs, before, after, overlap, overlapShare } = settings;
  // The manuscript's length, for a list that is only part of it.
  const total = settings.total ?? (paragraphs.length ? paragraphs[paragraphs.length - 1].index + 1 : 0);
  if (!Number.isInteger(maxParagraphs) || maxParagraphs < 1) throw new RangeError('maxParagraphs must be a whole number of 1 or more.');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxParagraphs) throw new RangeError('overlap must be a whole number from 0 to less than maxParagraphs.');
  if (typeof overlapShare !== 'number' || !(overlapShare >= 0 && overlapShare < 1)) throw new RangeError('overlapShare must be a number from 0 to less than 1.');
  // Positions in the list of the paragraphs that are asked.
  const askable = [];
  paragraphs.forEach((entry, position) => { if (!isEmpty(entry)) askable.push(position); });
  const wanted = at => !settings.only || settings.only.has(paragraphs[askable[at]].index);
  const passages = [];
  let start = 0;
  while (start < askable.length && !wanted(start)) start += 1;
  while (start < askable.length) {
    let end = start;
    let used = describeParagraph(paragraphs[askable[start]], settings).length;
    while (end + 1 < askable.length && end + 1 - start < maxParagraphs && wanted(end + 1)) {
      const next = describeParagraph(paragraphs[askable[end + 1]], settings).length + 1;
      if (used + next > size) break;
      used += next;
      end += 1;
    }
    const first = askable[start];
    const last = askable[end];
    const contextFrom = askable[Math.max(0, start - before)];
    const contextTo = askable[Math.min(askable.length - 1, end + after)];
    const parts = [`Paragraphs ${paragraphs[first].index} to ${paragraphs[last].index} of the ${total} in the manuscript.`];
    if (contextFrom < first) parts.push('', 'Context before (do not label):', ...lines(paragraphs, contextFrom, first - 1, settings));
    parts.push('', 'Label these:', ...lines(paragraphs, first, last, settings));
    if (contextTo > last) parts.push('', 'Context after (do not label):', ...lines(paragraphs, last + 1, contextTo, settings));
    passages.push({ asked: askable.slice(start, end + 1).map(position => paragraphs[position].index), text: parts.join('\n') });
    if (end + 1 >= askable.length) break;
    // The next passage starts `overlap` paragraphs, or that share of this passage, before its end.
    start = Math.max(start + 1, end + 1 - Math.max(overlap, Math.floor((end + 1 - start) * overlapShare)));
    while (start < askable.length && !wanted(start)) start += 1;
  }
  return passages;
}
