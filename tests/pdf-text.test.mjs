import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';
import { pageText, SPACE_GAP } from '../lib/guidelines/pdf-text.js';

mupdf.setLog(() => {});

const TIGHT_SENTENCE = 'When applicable the volume includes a list of abbreviations';
const fixture = async name => new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)));

// A stand-in for a MuPDF page. blocks is a list of text blocks, each a list of lines, each a list of
// [char, left, right, size] (or [char, quad, size] for a quad given whole). walk() replays them in
// MuPDF's order; the page records the options it was asked for and whether its text was released.
function fakePage(blocks) {
  const page = { options: [], destroyed: 0 };
  page.toStructuredText = options => {
    page.options.push(options);
    return {
      walk(walker) {
        for (const lines of blocks) {
          walker.beginTextBlock?.([0, 0, 100, 100]);
          for (const chars of lines) {
            walker.beginLine?.([0, 0, 100, 10], 0, [1, 0]);
            for (const char of chars) {
              const [c, ...rest] = char;
              const [quad, size] = Array.isArray(rest[0]) ? rest : [[rest[0], 0, rest[1], 0, rest[0], 10, rest[1], 10], rest[2]];
              walker.onChar?.(c, [quad[4], quad[5]], null, size, quad, [0], 0);
            }
            walker.endLine?.();
          }
          walker.endTextBlock?.();
        }
      },
      destroy() { page.destroyed += 1; },
    };
  };
  return page;
}

// One line of characters of one size, each one unit wide, with gaps[i] between char i and char i + 1.
function spaced(text, gaps, size = 10) {
  const chars = [];
  let x = 0;
  [...text].forEach((c, i) => {
    chars.push([c, x, x + 1, size]);
    x += 1 + (gaps[i] ?? 0);
  });
  return chars;
}

test('the space threshold is a tenth of the font size', () => {
  assert.equal(SPACE_GAP, 0.10);
});

test('inserts a space when the gap exceeds a tenth of the font size', () => {
  const page = fakePage([[spaced('abcd', [0, 1.5, 0])]]);
  assert.equal(pageText(page), 'ab cd\n\n');
  assert.deepEqual(page.options, ['preserve-whitespace']);
  assert.equal(page.destroyed, 1);
});

test('does not insert a space for a gap of exactly the threshold or less', () => {
  assert.equal(pageText(fakePage([[spaced('abcd', [0, 1.0, 0.4])]])), 'abcd\n\n');
});

test('never doubles a space next to a real space character', () => {
  // Wide gaps on both sides of a real space, and a wide gap between two real spaces.
  assert.equal(pageText(fakePage([[spaced('ab cd', [0, 3, 3, 0])]])), 'ab cd\n\n');
  assert.equal(pageText(fakePage([[spaced('a  b', [0, 3, 0])]])), 'a  b\n\n');
  assert.equal(pageText(fakePage([[spaced('a\tb', [3, 3])]])), 'a\tb\n\n');
});

test('never inserts a space at the start of a line', () => {
  // The first character of each line sits far from the last character of the line before.
  const lines = [[['a', 0, 1, 10], ['b', 1, 2, 10]], [['c', 50, 51, 10], ['d', 51, 52, 10]]];
  assert.equal(pageText(fakePage([lines])), 'ab\ncd\n\n');
  assert.equal(pageText(fakePage([[[['x', 40, 41, 10]]]])), 'x\n\n');
});

test('leaves negative gaps alone', () => {
  const overlapping = [['a', 0, 2, 10], ['b', 1, 3, 10]];
  const rightToLeft = [['c', 20, 21, 10], ['d', 10, 11, 10], ['e', 0, 1, 10]];
  assert.equal(pageText(fakePage([[overlapping, rightToLeft]])), 'ab\ncde\n\n');
});

test('measures the gap from the outermost corners of slanted quads', () => {
  // An italic-like slant: the bottom corners sit left of the top ones. Right edge of a is max(5, 4) = 5,
  // left edge of b is min(7, 6) = 6, so the gap is 1: no space at size 10, a space at size 5.
  const slanted = size => [['a', [1, 0, 5, 0, 0, 10, 4, 10], size], ['b', [7, 0, 11, 0, 6, 10, 10, 10], size]];
  assert.equal(pageText(fakePage([[slanted(10)]])), 'ab\n\n');
  assert.equal(pageText(fakePage([[slanted(5)]])), 'a b\n\n');
});

test('ends lines with a newline and separates blocks with a blank line', () => {
  const page = fakePage([[spaced('ab', []), spaced('cd', [])], [spaced('ef', [])]]);
  assert.equal(pageText(page), 'ab\ncd\n\nef\n\n');
  assert.equal(pageText(fakePage([])), '');
});

test('scales with font size', () => {
  assert.equal(pageText(fakePage([[spaced('abcd', [0, 1.5, 0], 20)]])), 'abcd\n\n');
  assert.equal(pageText(fakePage([[spaced('abcd', [0, 2.5, 0], 20)]])), 'ab cd\n\n');
});

test('releases the structured text when the walk throws', () => {
  const page = fakePage([]);
  const make = page.toStructuredText;
  page.toStructuredText = options => ({ ...make(options), walk() { throw new Error('malformed'); } });
  assert.throws(() => pageText(page), /malformed/);
  assert.equal(page.destroyed, 1);
});

// With the real mupdf package.
async function readPdf(name) {
  const doc = mupdf.Document.openDocument(await fixture(name), 'application/pdf');
  try {
    const texts = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        texts.push(pageText(page));
      } finally {
        page.destroy();
      }
    }
    return texts.join('\n\n');
  } finally {
    doc.destroy();
  }
}

test('tight.pdf: the gapped line reads the same as the normally spaced line', async () => {
  const lines = (await readPdf('tight.pdf')).split('\n').filter(line => line !== '');
  assert.deepEqual(lines, [TIGHT_SENTENCE, TIGHT_SENTENCE]);
});

test('guidelines.pdf still contains its sentence unchanged', async () => {
  assert.ok((await readPdf('guidelines.pdf')).includes('Use double quotation marks throughout the manuscript.'));
});
