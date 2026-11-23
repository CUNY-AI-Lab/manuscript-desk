// The quotation check: does a quotation a model attributed to the guidelines really occur in them?
// Rules whose quotation fails are discarded, so the tool never credits a publisher with an invented
// requirement. Strict about content; tolerant only of typography that PDF extraction and retyping
// change (quote style, dash type, whitespace, case, soft and line-break hyphens).
// Pure: no DOM, no network, never throws.

const MIN_SEGMENT = 12;
const MAX_SPAN = 600;

const SINGLE_QUOTES = /[‘’‚‛′‵]/g;
const DOUBLE_QUOTES = /[“”„‟″‶]/g;
const DASHES = /[‐-―−]/g;
const LINE_BREAK_HYPHEN = /-[ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;
// An ellipsis marks an elision, bracketed or not.
const ELISION = /\[\s*(?:\.{3}|…)\s*\]|\.{3}|…/;
// Stripped from a segment's edges: quotation marks (after normalization) at either end, plus
// terminal punctuation at the end.
const LEADING = /^(?:["'«»‹›]|\s)+/;
const TRAILING = /(?:["'«»‹›.,;:]|\s)+$/;

export function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(LINE_BREAK_HYPHEN, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

// The normalized segments of a quotation, or null if any is too short to be evidence.
function segmentsOf(quote) {
  const segments = quote.split(ELISION).map(part => normalizeForMatch(part).replace(LEADING, '').replace(TRAILING, ''));
  return segments.every(segment => segment.length >= MIN_SEGMENT) ? segments : null;
}

// End of the last segment when every segment after the first is found in order from `from`, else -1.
function endOfRest(haystack, segments, from) {
  let end = from;
  for (let i = 1; i < segments.length; i++) {
    const at = haystack.indexOf(segments[i], end);
    if (at === -1) return -1;
    end = at + segments[i].length;
  }
  return end;
}

export function findQuote(quote, guidelines) {
  if (typeof quote !== 'string' || typeof guidelines !== 'string' || guidelines === '') return false;
  const segments = segmentsOf(quote);
  if (!segments) return false;
  const haystack = normalizeForMatch(guidelines);
  const [first] = segments;
  // Try each occurrence of the first segment: an earlier one may sit too far from the rest.
  for (let start = haystack.indexOf(first); start !== -1; start = haystack.indexOf(first, start + 1)) {
    const end = endOfRest(haystack, segments, start + first.length);
    if (end === -1) return false; // later starts cannot find what this one could not
    if (end - start <= MAX_SPAN) return true;
  }
  return false;
}
