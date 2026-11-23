import test from 'node:test';
import assert from 'node:assert/strict';
import { splitGuidelines } from '../lib/rules/chunk.js';

// Text written for these tests. Every sentence carries its own number, so a part's position in the
// text can be found with indexOf.
const sentence = n => `Sentence ${n} sets out one more requirement that authors must meet.`;
const paragraph = (first, count) => Array.from({ length: count }, (_, i) => sentence(first + i)).join(' ');
const paragraphs = (count, sentencesEach) => Array.from({ length: count }, (_, i) => paragraph(i * sentencesEach, sentencesEach)).join('\n\n');

// The start of each part in `text`, checking that each part is a slice of it.
function starts(text, parts) {
  const found = [];
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    assert.notEqual(at, -1, 'every part is a slice of the text');
    found.push(at);
    from = at + 1;
  }
  return found;
}

// Every character of `text` is in some part, with parts in order and no gaps between them.
function assertCovers(text, parts, size) {
  const at = starts(text, parts);
  assert.equal(at[0], 0);
  for (let i = 0; i < parts.length; i += 1) {
    assert.ok(parts[i].length <= size, `part ${i} is at most ${size} characters`);
    if (i > 0) assert.ok(at[i] <= at[i - 1] + parts[i - 1].length, `part ${i} begins no later than part ${i - 1} ends`);
  }
  assert.equal(at.at(-1) + parts.at(-1).length, text.length);
}

test('short text is one part', () => {
  assert.deepEqual(splitGuidelines('Use double quotation marks.'), ['Use double quotation marks.']);
  const exactly = 'x'.repeat(40000);
  assert.deepEqual(splitGuidelines(exactly), [exactly]);
  assert.deepEqual(splitGuidelines('Twelve words.', { size: 13, overlap: 2 }), ['Twelve words.']);
});

test('long text is cut at a paragraph break and parts overlap by about 2000 characters', () => {
  const text = paragraphs(30, 40); // about 2,700 characters a paragraph, 82,000 in all
  assert.ok(text.length > 80000);
  const parts = splitGuidelines(text);
  assert.ok(parts.length >= 3);
  const at = starts(text, parts);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const end = at[i] + parts[i].length;
    assert.ok(parts[i].length <= 40000);
    assert.ok(parts[i].length > 37000, 'the cut is the last paragraph break before 40,000 characters');
    assert.match(text.slice(end - 2, end), /\n\n/, 'the part ends at a paragraph break');
    assert.doesNotMatch(text.slice(end, at[i] + 40000), /\n\s*\n/, 'no later paragraph break fits in the part');
    const overlap = end - at[i + 1];
    assert.ok(overlap > 1900 && overlap <= 2000, `overlap of ${overlap} characters`);
    assert.match(text.slice(at[i + 1] - 2, at[i + 1]), /\. $|\n\n$/, 'the next part begins at a sentence or paragraph');
  }
});

test('falls back to the last sentence end when a part holds no paragraph break', () => {
  const text = paragraph(0, 1000); // one paragraph of about 67,000 characters
  const parts = splitGuidelines(text);
  const at = starts(text, parts);
  const end = at[0] + parts[0].length;
  assert.match(parts[0], /meet\. $/);
  assert.doesNotMatch(text.slice(end, 40000), /\.\s/, 'no later sentence end fits in the part');
  assertCovers(text, parts, 40000);
});

test('every character of the input appears in some part', () => {
  const run = Array.from({ length: 300 }, (_, i) => `w${i}`).join('');
  const mixed = [paragraphs(6, 5), run, paragraph(500, 30), run.replaceAll('w', 'v'), paragraph(700, 9), paragraph(709, 9)].join('\n\n');
  assertCovers(mixed, splitGuidelines(mixed, { size: 500, overlap: 100 }), 500);
  assertCovers(mixed, splitGuidelines(mixed, { size: 900, overlap: 0 }), 900);
  const text = paragraphs(30, 40);
  assertCovers(text, splitGuidelines(text), 40000);
});

test('a 100000-character text with no breaks still splits', () => {
  const text = Array.from({ length: 20000 }, (_, i) => String(i % 100000).padStart(5, '0')).join('');
  assert.equal(text.length, 100000);
  const parts = splitGuidelines(text);
  assert.ok(parts.length >= 3);
  assertCovers(text, parts, 40000);
  assert.equal(parts[0].length, 40000);
  assert.equal(splitGuidelines('x'.repeat(100000)).length, 3);
});

test('rejects options that cannot split', () => {
  assert.throws(() => splitGuidelines('text', { size: 0 }), RangeError);
  assert.throws(() => splitGuidelines('text', { size: 100, overlap: 100 }), RangeError);
  assert.throws(() => splitGuidelines('text', { size: 100, overlap: -1 }), RangeError);
  assert.throws(() => splitGuidelines(42), TypeError);
});
