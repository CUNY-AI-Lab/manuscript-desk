// Which sentences of a part of the guidelines read as requirements, and which no reading quoted.
// The guidelines here are text written for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asksSomething, sentencesOf, uncoveredSentences } from '../lib/rules/coverage.js';

const TEXT = `Preparing the manuscript

Authors must send the final text as one Word file. The editors read it
within a month. Please number every page in the footer.

• Use double quotation marks for quotations
• Keep a copy of everything you send

Questions? Write to the series office, which is open on weekdays.`;

test('sentencesOf joins wrapped lines, parts list items at their bullets and sentences at their ends', () => {
  assert.deepEqual(sentencesOf(TEXT), [
    'Preparing the manuscript',
    'Authors must send the final text as one Word file.',
    'The editors read it within a month.',
    'Please number every page in the footer.',
    '• Use double quotation marks for quotations',
    '• Keep a copy of everything you send',
    'Questions?',
    'Write to the series office, which is open on weekdays.',
  ]);
  assert.deepEqual(sentencesOf(42), []);
});

test('a sentence asks something when it has a word of obligation or begins with an imperative', () => {
  assert.equal(asksSomething('Authors must send the final text as one Word file.'), true);
  assert.equal(asksSomething('• Use double quotation marks for quotations'), true);
  assert.equal(asksSomething('The editors read it within a month.'), false);
  assert.equal(asksSomething('Please do.'), false, 'too short to be a requirement on its own');
});

test('the sentences that ask something and that no quotation covers', () => {
  const quotes = ['Authors must send the final text as one Word file', 'double quotation marks for quotations', null];
  const { asked, uncovered } = uncoveredSentences(TEXT, quotes);
  assert.equal(asked, 5);
  assert.deepEqual(uncovered, ['Please number every page in the footer.', '• Keep a copy of everything you send', 'Write to the series office, which is open on weekdays.']);
  // A quotation that spans two sentences covers both.
  assert.deepEqual(uncoveredSentences('You must sign the form. You must return it by May.', ['sign the form. You must return it']).uncovered, []);
});
