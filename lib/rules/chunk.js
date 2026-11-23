// Splitting guidelines too long for one model call into overlapping parts. Each part ends at a
// paragraph break where one fits, else at a sentence end, else at the size limit; each later part
// starts a little before the previous part ended, so a requirement stated across the cut is read
// whole in one of them. Pure: no DOM, no network.

// A blank line and the whitespace after it; or a sentence end, any closing quotation marks or
// brackets, and the whitespace after them. A boundary is the position where the match ends.
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/g;
const SENTENCE_END = /[.!?]["'”’)\]]*\s+/g;
const BOUNDARY = /\n[ \t]*\n\s*|[.!?]["'”’)\]]*\s+/g;

// The last boundary of `pattern` in text[from, to) that lies after `after`, or -1.
function lastBoundary(text, pattern, from, to, after) {
  let found = -1;
  for (const match of text.slice(from, to).matchAll(pattern)) {
    const end = from + match.index + match[0].length;
    if (end > after) found = end;
  }
  return found;
}

// The first boundary in text[from, to), or -1.
function firstBoundary(text, from, to) {
  for (const match of text.slice(from, to).matchAll(BOUNDARY)) {
    const end = from + match.index + match[0].length;
    if (end < to) return end;
  }
  return -1;
}

export function splitGuidelines(text, { size = 40000, overlap = 2000 } = {}) {
  if (typeof text !== 'string') throw new TypeError('splitGuidelines needs the guidelines text.');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a whole number of 1 or more.');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new RangeError('overlap must be a whole number from 0 to less than size.');
  const parts = [];
  let start = 0;
  let covered = 0; // the end of the previous part: a cut must reach past it to read anything new
  while (text.length - start > size) {
    const limit = start + size;
    let cut = lastBoundary(text, PARAGRAPH_BREAK, start, limit, covered);
    if (cut === -1) cut = lastBoundary(text, SENTENCE_END, start, limit, covered);
    if (cut === -1) cut = limit;
    parts.push(text.slice(start, cut));
    covered = cut;
    const from = Math.max(cut - overlap, start + 1);
    const next = firstBoundary(text, from, cut);
    start = next === -1 ? from : next;
  }
  parts.push(text.slice(start));
  return parts;
}

// The boundary of `pattern` in text(from, to) nearest to `target`, or -1.
function nearestBoundary(text, pattern, from, to, target) {
  let best = -1;
  for (const match of text.slice(from, to).matchAll(pattern)) {
    const end = from + match.index + match[0].length;
    if (end <= from || end >= to) continue;
    if (best === -1 || Math.abs(end - target) < Math.abs(best - target)) best = end;
  }
  return best;
}

/**
 * Splits one part in two, for a part whose answer did not fit the model's output: the cut is the
 * paragraph break nearest the middle (else the sentence end nearest it, else the middle itself),
 * and the second half starts a little before the cut, at a boundary within `overlap` characters,
 * as later parts do in splitGuidelines. Null for a text too short to split.
 * @param {string} text
 * @returns {[string, string] | null}
 */
export function splitInTwo(text, { overlap = 1000 } = {}) {
  if (typeof text !== 'string') throw new TypeError('splitInTwo needs the text.');
  if (text.trim().length < 2) return null;
  const middle = Math.floor(text.length / 2);
  let cut = nearestBoundary(text, PARAGRAPH_BREAK, 0, text.length, middle);
  if (cut === -1) cut = nearestBoundary(text, SENTENCE_END, 0, text.length, middle);
  if (cut === -1) cut = middle;
  const from = Math.max(cut - Math.min(overlap, Math.floor(cut / 4)), 1);
  const next = firstBoundary(text, from, cut);
  const first = text.slice(0, cut);
  const second = text.slice(next === -1 ? cut : next);
  return first.trim() && second.trim() ? [first, second] : null;
}
