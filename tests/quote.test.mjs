import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForMatch, findQuote } from '../lib/rules/quote.js';

const G = 'Please use double quotation marks (“like this”) throughout.\nNotes should be foot-\nnotes, numbered from 1 in each chapter. Use en dashes – not hyphens – in ranges.';

test('finds a verbatim quote', () => assert.equal(findQuote('Please use double quotation marks', G), true));
test('ignores curly versus straight quotes and dash type', () => assert.equal(findQuote('double quotation marks ("like this") throughout', G), true));
test('joins a word hyphenated across a line break', () => assert.equal(findQuote('Notes should be footnotes, numbered from 1', G), true));
test('ignores case and runs of whitespace', () => assert.equal(findQuote('USE  EN DASHES - not hyphens', G), true));
test('accepts an elided quote whose segments occur in order', () => assert.equal(findQuote('Please use double quotation marks … numbered from 1 in each chapter', G), true));
test('rejects segments out of order', () => assert.equal(findQuote('numbered from 1 in each chapter ... Please use double quotation marks', G), false));
test('rejects a paraphrase', () => assert.equal(findQuote('Authors must use double quotes everywhere', G), false));
test('rejects a quote with a segment under 12 characters', () => assert.equal(findQuote('Please use ... notes', G), false));

test('rejects segments more than 600 characters apart', () => {
  const far = 'Abstracts must not exceed 250 words. ' + 'x'.repeat(700) + ' Keywords follow the abstract.';
  assert.equal(findQuote('Abstracts must not exceed 250 words ... Keywords follow the abstract', far), false);
  const near = 'Abstracts must not exceed 250 words. ' + 'x'.repeat(100) + ' Keywords follow the abstract.';
  assert.equal(findQuote('Abstracts must not exceed 250 words ... Keywords follow the abstract', near), true);
});

test('rejects an empty or non-string quote', () => {
  assert.equal(findQuote('', G), false);
  assert.equal(findQuote('   ', G), false);
  assert.equal(findQuote('…', G), false);
  for (const bad of [undefined, null, 42, {}, ['Please use double quotation marks']]) assert.equal(findQuote(bad, G), false);
});

test('rejects empty or non-string guidelines', () => {
  assert.equal(findQuote('Please use double quotation marks', ''), false);
  for (const bad of [undefined, null, 42, {}]) assert.equal(findQuote('Please use double quotation marks', bad), false);
});

test('accepts an elision written in square brackets', () => {
  assert.equal(findQuote('Please use double quotation marks [...] numbered from 1 in each chapter', G), true);
  assert.equal(findQuote('Please use double quotation marks […] numbered from 1 in each chapter', G), true);
});

test('strips surrounding quotation marks and terminal punctuation from a segment', () => {
  assert.equal(findQuote('“Notes should be footnotes, numbered from 1 in each chapter.”', G), true);
  assert.equal(findQuote('"Use en dashes - not hyphens - in ranges;"', G), true);
});

test('strips leading punctuation from a segment after an elision', () => {
  assert.equal(findQuote('Please use double quotation marks … , numbered from 1 in each chapter', G), true);
  assert.equal(findQuote('Please use double quotation marks …; numbered from 1 in each chapter', G), true);
});

test('accepts a four-dot ellipsis', () => {
  // The guidelines have no period before "not hyphens", so the stray one must be stripped.
  assert.equal(findQuote('numbered from 1 in each chapter. ... not hyphens - in ranges', G), true);
  assert.equal(findQuote('numbered from 1 in each chapter.... not hyphens - in ranges', G), true);
});

test('applies the 12-character minimum after stripping', () => {
  // "use en dashes" is 13 characters; "in ranges" is 9 once the period and quotes are gone.
  assert.equal(findQuote('use en dashes ... "in ranges."', G), false);
});

test('finds a later occurrence of the first segment when the earliest is too far away', () => {
  const g = 'Figures must be supplied separately. ' + 'y'.repeat(700) + ' Figures must be supplied separately as TIFF files at 300 dpi.';
  assert.equal(findQuote('Figures must be supplied separately ... TIFF files at 300 dpi', g), true);
});

test('normalizeForMatch handles soft hyphens, line-break hyphens, quotes, primes, dashes and space', () => {
  assert.equal(normalizeForMatch('foot\u00ADnotes'), 'footnotes');
  assert.equal(normalizeForMatch('foot-  \n  notes'), 'footnotes');
  assert.equal(normalizeForMatch('Anglo-\nSaxon'), 'anglo- saxon');
  assert.equal(normalizeForMatch('foot\u2010\nnotes'), 'footnotes');
  assert.equal(normalizeForMatch('foot\u2011 \n notes'), 'footnotes');
  assert.equal(normalizeForMatch('Anglo\u2010\nSaxon'), 'anglo- saxon');
  assert.equal(normalizeForMatch('‘a’ “b” 5′ 6″'), '\'a\' "b" 5\' 6\'\'');
  assert.equal(normalizeForMatch('a\u2010b–c—d\u2212e'), 'a-b-c-d-e');
  assert.equal(normalizeForMatch('  One\u00A0\t two\n\nTHREE  '), 'one two three');
  assert.equal(normalizeForMatch('ﬁgure'), 'figure');
});

test('normalizeForMatch never throws on a non-string', () => {
  for (const bad of [undefined, null, 42, {}]) assert.equal(normalizeForMatch(bad), '');
});

test('rejects a match that starts or ends inside a longer number or word', () => {
  assert.equal(findQuote('Abstracts must not exceed 25', 'Abstracts must not exceed 250 words.'), false);
  assert.equal(findQuote('250 words including references', 'Manuscripts are limited to 1250 words including references.'), false);
  // Whole words inside a longer sentence still count.
  assert.equal(findQuote('is required of all authors', 'No fee is required of all authors'), true);
});

test('rejects a middle segment that only matches mid-word', () => {
  assert.equal(findQuote('Please use double quotation marks ... otes should be footnotes ... in each chapter', G), false);
});

test('skips an occurrence that fails the word boundary for a later whole-word one', () => {
  const g = 'Reviews: 1250 words including references. Notes: 250 words including references, written in English.';
  assert.equal(findQuote('250 words including references', g), true);
  assert.equal(findQuote('250 words including references ... written in English', g), true);
  assert.equal(findQuote('Use the house style ... 250 words maximum', 'Use the house style: 1250 words maximum for reviews, 250 words maximum for notes.'), true);
});

test('rejects a segment without at least 8 letters or digits', () => {
  assert.equal(findQuote('============', 'a ============ b'), false);
  assert.equal(findQuote('Please use double quotation marks ... ============', 'Please use double quotation marks ============ b'), false);
});
