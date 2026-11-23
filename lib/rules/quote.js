// The quotation check: does a quotation a model attributed to the guidelines really occur in them?
// Rules whose quotation fails are discarded, so the tool never credits a publisher with an invented
// requirement. Strict about content; tolerant only of typography that PDF extraction and retyping
// change (quote style, dash type, whitespace, case, soft and line-break hyphens).
// Pure: no DOM, no network, never throws.

const MIN_SEGMENT = 12;
const MAX_SPAN = 600;

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
// ASCII hyphen, U+2010 hyphen or U+2011 non-breaking hyphen (NFKC already maps U+2011 to U+2010).
const LINE_BREAK_HYPHEN = /[-\u2010\u2011][ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;
// An ellipsis marks an elision, bracketed or not.
const ELISION = /\[\s*(?:\.{3}|\u2026)\s*\]|\.{3}|\u2026/;
// Stripped from both edges of a segment: quotation marks (after normalization) and the punctuation
// .,;: (so a four-dot ellipsis or a comma after an elision does not stick to a segment).
const EDGES = /^["'\u00AB\u00BB\u2039\u203A.,;:\s]+|["'\u00AB\u00BB\u2039\u203A.,;:\s]+$/g;

export function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .replace(/\u00AD/g, '')
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
  const segments = quote.split(ELISION).map(part => normalizeForMatch(part).replace(EDGES, ''));
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
