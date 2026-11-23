import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../lib/index/indexer.js';
import { displayOf, headingOf, lineOf, matcherInput, parseTermList, serializeTermList, variantsOf } from '../lib/index/termlist.js';

const pages = (...texts) => texts.map((text, i) => ({ number: String(i + 1), text }));

test('a book-index list with no headers is all terms, line for line', () => {
  const text = 'artificial intelligence (AI, machine learning)\nneural networks\n#MeToo\n\n“deep learning”\n';
  const { entries, problems } = parseTermList(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.map(entry => [entry.section, entry.text]), [['terms', 'artificial intelligence (AI, machine learning)'], ['terms', 'neural networks'], ['terms', '#MeToo'], ['terms', '“deep learning”']]);
  // The matcher is given exactly the lines book-index would be given, so the index is the same.
  const book = pages('AI is here', 'neural networks and #MeToo', 'deep learning');
  assert.deepEqual(buildIndex(book, matcherInput(entries).terms, matcherInput(entries).names), buildIndex(book, text, ''));
});

test('sections, subentries, cross-references and the ambiguous mark', () => {
  const { entries } = parseTermList('Terms:\nartificial intelligence (AI)\n  ethics (moral questions)\n  see also neural networks; robots\nAI\n\tsee artificial intelligence\nNames:\nBush, George W. [ambiguous]\nKing, Martin Luther, Jr.\n');
  assert.equal(entries.length, 4);
  const [ai, short, bush, king] = entries;
  assert.deepEqual(ai.subentries, [{ text: 'ethics (moral questions)' }]);
  assert.deepEqual(ai.seeAlso, ['neural networks', 'robots']);
  assert.deepEqual(short.see, ['artificial intelligence']);
  assert.equal(bush.section, 'names');
  assert.equal(bush.ambiguous, true);
  assert.equal(bush.text, 'Bush, George W.');
  assert.equal(king.section, 'names');
  assert.deepEqual(matcherInput(entries), { terms: 'artificial intelligence (AI)\nAI', names: 'Bush, George W.\nKing, Martin Luther, Jr.' });
});

test('indentation shared by every line of a section is ignored, so a pasted list still reads as terms', () => {
  const { entries } = parseTermList('   alpha\n   beta (b)\n      beta sub\n');
  assert.deepEqual(entries.map(entry => entry.text), ['alpha', 'beta (b)']);
  assert.deepEqual(entries[1].subentries, [{ text: 'beta sub' }]);
});

test('the same entry twice is one entry; an indented line with no entry above is an entry', () => {
  const { entries } = parseTermList('Names:\n  Smith, John\nSmith, John [ambiguous]\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ambiguous, true);
});

test('serializing and reading back keeps everything', () => {
  const text = 'Terms:\nartificial intelligence (AI)\n  ethics (moral questions)\n  see also neural networks; robots\nAI\n  see artificial intelligence\nNames:\nBush, George W. [ambiguous]\n';
  const { entries } = parseTermList(text);
  assert.equal(serializeTermList(entries), text);
  const again = parseTermList(serializeTermList(entries)).entries;
  assert.deepEqual(again.map(({ id, ...rest }) => rest), entries.map(({ id, ...rest }) => rest));
});

test('headings, variants, lines and book-index display keys', () => {
  assert.equal(headingOf('artificial intelligence (AI, machine learning)'), 'artificial intelligence');
  assert.deepEqual(variantsOf('artificial intelligence (AI, machine learning)'), ['AI', 'machine learning']);
  assert.equal(lineOf('Obama, Barack', ['Obama', 'obama, barack', 'Obama']), 'Obama, Barack (Obama)');
  assert.equal(displayOf('“deep learning”'), 'deep learning');
  assert.equal(displayOf('AI (artificial intelligence)'), 'AI (artificial intelligence)');
  assert.equal(displayOf('   '), '');
});

test('never throws on what is not a list, and refuses over-long lines', () => {
  assert.deepEqual(parseTermList(null).entries, []);
  const { entries, problems } = parseTermList(`${'x'.repeat(600)}\nshort`);
  assert.deepEqual(entries.map(entry => entry.text), ['short']);
  assert.equal(problems.length, 1);
});
