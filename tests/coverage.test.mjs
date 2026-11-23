// Which sentences of a part of the guidelines read as requirements, and which no reading quoted.
// The guidelines here are text written for these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asksSomething, entryAsks, leadInsOf, sentenceEntries, sentencesOf, uncoveredSentences } from '../lib/rules/coverage.js';

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

// A lead-in that asks, then bare noun phrases as items, as a PDF's text gives them: each bullet on
// a line of its own and its item on the next.
const LISTED = `Each chapter you send should include:

•
Chapter abstract
•
Figure captions and credits
•
Keywords

The office replies to the following:

• Spelling queries from readers

Each contributor is responsible for these tasks:
• Gathering the signed forms
• Indexing

Our team copyedits every chapter.
• Stray bullet after a paragraph`;

test('a list item carries the sentence ending in a colon that introduces its list', () => {
  const entries = sentenceEntries(LISTED);
  const find = sentence => entries.find(entry => entry.sentence === sentence);
  assert.deepEqual(find('• Chapter abstract'), { sentence: '• Chapter abstract', item: true, leadIn: 'Each chapter you send should include:' });
  assert.equal(find('• Keywords').leadIn, 'Each chapter you send should include:', 'across the items of the list');
  assert.equal(find('• Spelling queries from readers').leadIn, 'The office replies to the following:');
  assert.equal(find('• Indexing').leadIn, 'Each contributor is responsible for these tasks:', 'a lead-in in the same paragraph as the list');
  assert.deepEqual(find('• Stray bullet after a paragraph'), { sentence: '• Stray bullet after a paragraph', item: true, leadIn: null }, 'a sentence without a colon introduces nothing');
  assert.deepEqual(find('Our team copyedits every chapter.'), { sentence: 'Our team copyedits every chapter.', item: false, leadIn: null });
  assert.deepEqual(sentencesOf(LISTED), entries.map(entry => entry.sentence));
});

test('a short list item asks something when its lead-in does', () => {
  assert.equal(asksSomething('• Chapter abstract'), false, 'too short and asking nothing on its own');
  assert.equal(entryAsks({ sentence: '• Chapter abstract', item: true, leadIn: 'Each chapter you send should include:' }), true);
  assert.equal(entryAsks({ sentence: '• Gathering the signed forms', item: true, leadIn: 'Each contributor is responsible for these tasks:' }), true, 'a lead-in saying what the author is responsible for');
  assert.equal(entryAsks({ sentence: '• Spelling queries from readers', item: true, leadIn: 'The office replies to the following:' }), false, 'a lead-in that asks nothing');
  assert.equal(entryAsks({ sentence: '• Indexing', item: true, leadIn: 'Each contributor is responsible for these tasks:' }), false, 'shorter than a quotation the guidelines can be checked against');
  assert.equal(entryAsks({ sentence: 'Chapter abstract', item: false, leadIn: null }), false);
  assert.equal(entryAsks({ sentence: 'Authors must send the final text as one Word file.' }), true);
});

test('the items under a lead-in that asks are requirement sentences, covered only by a quotation that holds them', () => {
  const { asked, uncovered } = uncoveredSentences(LISTED, ['Chapter abstract and keywords']);
  assert.equal(asked, 4, 'the lead-in, of 37 characters, and three items; "Keywords" and "Indexing" are too short');
  assert.deepEqual(uncovered, ['Each chapter you send should include:', '• Figure captions and credits', '• Gathering the signed forms'], 'an item a quotation holds is covered');
  assert.deepEqual(uncoveredSentences('Please send:\n• Signed permission forms', ['permission forms for every image']).uncovered, ['• Signed permission forms'],
    'a short item that shares only its last words with a quotation is not covered');
  assert.deepEqual([...leadInsOf(LISTED)], [
    ['• Chapter abstract', 'Each chapter you send should include:'],
    ['• Figure captions and credits', 'Each chapter you send should include:'],
    ['• Keywords', 'Each chapter you send should include:'],
    ['• Gathering the signed forms', 'Each contributor is responsible for these tasks:'],
    ['• Indexing', 'Each contributor is responsible for these tasks:'],
  ]);
});
