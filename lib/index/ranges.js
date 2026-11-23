// Page locators: consecutive pages joined into ranges, and the second number of a range written in
// the style a press asks for. Pure: no DOM, no network.
//   full       every digit: 321–328, 1496–1500
//   chicago    The Chicago Manual of Style's rule: all digits below 100 and from a multiple of 100
//              (71–72, 100–104); only the changed digits after 101 to 109 of a hundred (101–8,
//              808–33); at least two digits after 110 to 199 of a hundred (321–28, 1496–500)
//   two-digit  the changed digits, never fewer than two (104–08, 321–28, 1496–500)
// Roman numerals (front matter) are joined into ranges but never shortened.

export const RANGE_STYLES = Object.freeze(['full', 'chicago', 'two-digit']);
export const DASH = '–';

const ROMAN = /^[ivxlcdm]+$/i;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** The value of a roman numeral, or null. */
export function romanValue(text) {
  if (typeof text !== 'string' || !ROMAN.test(text)) return null;
  let total = 0;
  const digits = [...text.toLowerCase()].map(char => ROMAN_VALUES[char]);
  digits.forEach((value, at) => { total += value < (digits[at + 1] ?? 0) ? -value : value; });
  return total;
}

// A page's place in a run of consecutive pages: arabic and roman numbers are counted apart.
function counted(page) {
  if (/^\d+$/.test(page)) return { kind: 'arabic', value: Number(page) };
  const roman = romanValue(page);
  return roman === null ? null : { kind: 'roman', value: roman };
}

/** The second number of a range from `first` to `last` (arabic, first < last), in a style. */
export function secondNumber(first, last, style = 'chicago') {
  const a = String(first);
  const b = String(last);
  if (style === 'full' || a.length !== b.length) return b;
  if (style === 'chicago' && (first < 100 || first % 100 === 0)) return b;
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  const changed = b.slice(at);
  const least = style === 'chicago' && first % 100 < 10 ? 1 : 2;
  return b.slice(Math.max(0, b.length - Math.max(changed.length, least)));
}

/**
 * The locators of an entry from its pages (in book order): with `collapse`, each run of two or more
 * consecutive pages becomes a range.
 * @param {string[]} pages
 * @returns {string[]}
 */
export function collapsePages(pages, { collapse = true, style = 'chicago' } = {}) {
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    if (run.last === run.first) out.push(run.firstText);
    else if (run.kind === 'roman') out.push(`${run.firstText}${DASH}${run.lastText}`);
    else out.push(`${run.firstText}${DASH}${secondNumber(run.first, run.last, style)}`);
    run = null;
  };
  for (const page of pages) {
    const value = counted(page);
    if (collapse && run && value && value.kind === run.kind && value.value === run.last + 1) {
      run.last = value.value;
      run.lastText = page;
      continue;
    }
    flush();
    if (value) run = { kind: value.kind, first: value.value, last: value.value, firstText: page, lastText: page };
    else out.push(page);
  }
  flush();
  return out;
}
