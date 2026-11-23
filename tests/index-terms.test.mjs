import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CHARS, buildTermPassages, compatible, corporateName, countAndDrop, headingLike, leftOutParagraphs, mergeProposals, nameParts, parseTermsReply, personHeading, proposeTerms } from '../lib/index/terms.js';
import { serializeTermList } from '../lib/index/termlist.js';

// An invented manuscript's paragraphs, in the reader's shape.
const para = (index, text) => ({ index, kind: 'paragraph', text, hints: {} });
const MANUSCRIPT = [
  para(0, 'Chapter One'),
  para(1, 'Ada Example founded the Invented Society in Lisbon. Example later wrote Silent Rivers, her best-known book.'),
  para(2, 'Archives were scarce; the archive of the society burned.'),
  para(3, ''),
  para(4, 'Bibliography'),
  para(5, 'Example, Ada. Silent Rivers. Lisbon: Press, 1901.'),
  para(6, 'Zed, Zoe. Only Cited Here. London: Press, 1950.'),
  para(7, 'Chapter Two'),
  para(8, 'Ben Other answered Ada Example in 1903, and A. Example replied.'),
  para(9, 'Other wrote again.'),
];

test('bibliographies are left out by heading, or by the Formatter\'s roles when it has them', () => {
  const byHeadings = leftOutParagraphs(MANUSCRIPT);
  assert.equal(byHeadings.by, 'headings');
  assert.deepEqual([...byHeadings.left].sort((a, b) => a - b), [4, 5, 6]);
  const byRoles = leftOutParagraphs(MANUSCRIPT, { 4: 'bibliography-heading', 5: 'bibliography-entry', 6: 'body' });
  assert.deepEqual([...byRoles.left], [4, 5]);
});

test('passages hold whole numbered paragraphs, leave out the bibliography and stay under the size', () => {
  const { left } = leftOutParagraphs(MANUSCRIPT);
  const passages = buildTermPassages(MANUSCRIPT, { left, chars: 140 });
  assert.ok(passages.length >= 2);
  assert.deepEqual(passages.flatMap(passage => passage.asked), [0, 1, 2, 7, 8, 9]);
  assert.match(passages[0].text, /^\[0\] Chapter One\n\[1\] Ada Example founded/);
});

const PASSAGE = { key: 'terms:0-2', raw: MANUSCRIPT.slice(0, 3).map(entry => entry.text).join('\n') };

test('a proposal needs its quotation in the passage; parentheses never stay in a heading', () => {
  const reply = JSON.stringify({ entries: [
    { heading: 'Example, Ada', kind: 'person', variants: ['Example'], parent: null, see: null, seeAlso: [], quote: 'Ada Example founded the Invented Society' },
    { heading: 'Invented Society (Lisbon)', kind: 'organization', variants: [], quote: 'founded the Invented Society in Lisbon' },
    { heading: 'Made Up', kind: 'concept', variants: [], quote: 'words that are not in the passage at all' },
    { heading: 'archives', kind: 'thing', variants: 'archive', quote: 'Archives were scarce; the archive' },
  ] });
  const { proposals, unverified } = parseTermsReply(reply, PASSAGE);
  assert.equal(unverified, 1);
  assert.deepEqual(proposals.map(proposal => [proposal.heading, proposal.kind, proposal.variants]), [['Example, Ada', 'person', ['Example']], ['Invented Society', 'organization', []], ['archives', 'concept', ['archive']]]);
  assert.equal(parseTermsReply('not json', PASSAGE), null);
});

const proposal = (heading, kind, extra = {}) => ({ heading, kind, variants: [], parent: null, see: null, seeAlso: [], quote: 'q', passage: 'p1', ...extra });

test('merging: the same person named two ways, singular and plural, a bare surname, subentries', () => {
  const merged = mergeProposals([
    proposal('Example, Ada', 'person', { variants: ['Example'] }),
    proposal('Example, A.', 'person', { passage: 'p2' }),
    proposal('Other, Ben', 'person'),
    proposal('Other', 'person'),
    proposal('archive', 'concept'),
    proposal('archives', 'concept', { passage: 'p3' }),
    proposal('archives', 'concept'),
    proposal('fires', 'concept', { parent: 'archives' }),
    proposal('Silent Rivers', 'work'),
  ]);
  const byHeading = new Map(merged.map(entry => [entry.text, entry]));
  assert.deepEqual([...byHeading.keys()].sort(), ['Example, Ada (Example, A. Example)', 'Other, Ben (Other)', 'Silent Rivers', 'archives']);
  assert.equal(byHeading.get('Example, Ada (Example, A. Example)').section, 'names');
  assert.equal(byHeading.get('Example, Ada (Example, A. Example)').passages, 2);
  assert.deepEqual(byHeading.get('archives').subentries, [{ text: 'fires' }]);
  assert.equal(byHeading.get('Silent Rivers').section, 'terms');
  assert.ok(merged.every(entry => entry.status === 'proposed'));
});

test('two people with one surname and different forenames stay apart', () => {
  const merged = mergeProposals([proposal('Example, Ada', 'person'), proposal('Example, Bea', 'person'), proposal('Example', 'person')]);
  assert.deepEqual(merged.map(entry => entry.text).sort(), ['Example', 'Example, Ada', 'Example, Bea']);
  assert.deepEqual(nameParts('King, Martin Luther, Jr.'), { surname: 'King', forenames: ['Martin', 'Luther'], suffix: 'Jr.' });
});

test('occurrences are counted with the matcher; what occurs only in the bibliography is dropped', () => {
  const { left } = leftOutParagraphs(MANUSCRIPT);
  const merged = mergeProposals([proposal('Example, Ada', 'person', { variants: ['Example'] }), proposal('Zed, Zoe', 'person'), proposal('Lisbon', 'place')]);
  const { entries, dropped } = countAndDrop(merged, MANUSCRIPT, left);
  const count = text => entries.find(entry => entry.text.startsWith(text));
  assert.equal(count('Example, Ada').count, 4, 'Ada Example twice, Example and A. Example once each, outside the bibliography');
  assert.equal(count('Example, Ada').countLeftOut, 1);
  assert.equal(count('Lisbon').count, 1);
  assert.deepEqual(dropped.map(entry => entry.text), ['Zed, Zoe']);
  assert.match(serializeTermList(entries), /^Terms:\nLisbon\nNames:\nExample, Ada \(Example\)\n$/);
});

test('proposeTerms asks each passage once and gathers the verified proposals', async () => {
  const { left } = leftOutParagraphs(MANUSCRIPT);
  const sent = [];
  const callTerms = async ({ passage }) => {
    sent.push(passage);
    return { content: JSON.stringify({ entries: passage.includes('Ben Other') ? [{ heading: 'Other, Ben', kind: 'person', variants: ['Other'], quote: 'Ben Other answered Ada Example' }] : [] }) };
  };
  const { byPassage, failures, passages } = await proposeTerms({ paragraphs: MANUSCRIPT, left, model: 'm', callTerms, wait: async () => {} });
  assert.equal(sent.length, passages.length);
  assert.deepEqual(failures, []);
  assert.deepEqual([...byPassage.values()].flatMap(answer => answer.proposals).map(item => item.heading), ['Other, Ben']);
});

test('a title proposed under its first word after the article is also searched as the text writes it', () => {
  const [entry] = mergeProposals([proposal('Long Night, The', 'work')]);
  assert.equal(entry.text, 'Long Night, The (The Long Night)');
  const { entries } = countAndDrop([entry], [para(0, 'She wrote The Long Night in a year.')]);
  assert.equal(entries[0].count, 1);
});

test('a person in index form: honorifics out, a lower-case particle after the forenames, a body is an organization', () => {
  assert.equal(personHeading('de Example, Ada'), 'Example, Ada de');
  assert.equal(personHeading('van der Sample, Ben'), 'Sample, Ben van der');
  assert.equal(personHeading('De Sample, Ben'), 'De Sample, Ben', 'a capitalized particle is part of the surname');
  assert.equal(personHeading('Example, Dr. Ada'), 'Example, Ada');
  assert.equal(personHeading('Example, Ada, Jr.'), 'Example, Ada, Jr.');
  assert.equal(personHeading('Placeholder'), 'Placeholder');
  assert.equal(corporateName('Example Brothers'), true);
  assert.equal(corporateName('Example, Ada'), false);
  const merged = mergeProposals([proposal('de Example, Ada', 'person'), proposal('Example, Ada de', 'person', { passage: 'p2' }), proposal('Invented Records', 'person')]);
  assert.deepEqual(merged.map(entry => [entry.text, entry.section, entry.kind]), [['Example, Ada de', 'names', 'person'], ['Invented Records', 'terms', 'organization']]);
});

test('forenames: a short form, a nickname in quotation marks; two different people stay apart', () => {
  assert.equal(compatible(['Bob'], ['Bobby']), true);
  assert.equal(compatible(['Sam'], ['Samuel', 'J.']), true);
  assert.equal(compatible(['John', '“Sonny”'], ['Sonny']), true);
  assert.equal(compatible(['Al'], ['Alfred']), false, 'two letters are too few');
  assert.equal(compatible(['Ada'], ['Bea']), false);
  const merged = mergeProposals([proposal('Sample, Bob', 'person'), proposal('Sample, Bobby', 'person', { passage: 'p2' })]);
  assert.deepEqual(merged.map(entry => entry.text), ['Sample, Bobby (Bob Sample)']);
});

test('a title with its article and without, a work and a concept of the same words, and a person under another name merge', () => {
  const merged = mergeProposals([
    proposal('Long Night, The', 'work'), proposal('The Long Night', 'work', { passage: 'p2' }),
    proposal('Grain of the Sea', 'work'), proposal('grain of the sea', 'concept', { passage: 'p2' }), proposal('grain of the sea', 'concept', { passage: 'p3' }),
    proposal('Example, Kay', 'person', { variants: ['Lee Other'] }), proposal('Other, Lee', 'person', { passage: 'p2' }),
  ]);
  assert.deepEqual(merged.map(entry => entry.text).sort(), ['Example, Kay (Lee Other)', 'Long Night, The (The Long Night)', 'grain of the sea']);
  assert.equal(merged.find(entry => entry.text.startsWith('Example')).passages, 2);
});

test('the facts proposals are ranked by: pages of about PAGE_CHARS characters, paragraphs, a heading; and whether a passage discusses it', () => {
  const long = 'Filler words about other things. '.repeat(Math.ceil(PAGE_CHARS / 33));
  const book = [para(0, 'Lanterns at Night'), para(1, `Lanterns were common. ${long}`), para(2, `${long} lanterns again.`), para(3, 'A note on rivers, once.')];
  const merged = mergeProposals([proposal('lanterns', 'concept', { discussed: true }), proposal('rivers', 'concept')]);
  const { entries } = countAndDrop(merged, book);
  const of = text => entries.find(entry => entry.text === text);
  assert.deepEqual([of('lanterns').count, of('lanterns').paragraphs, of('lanterns').inHeading, of('lanterns').discussed], [3, 3, true, 1]);
  assert.ok(of('lanterns').spread >= 2);
  assert.deepEqual([of('rivers').spread, of('rivers').inHeading, of('rivers').discussed], [1, false, 0]);
  assert.equal(headingLike(para(9, 'Chapter Two: The Lanterns')), true);
  assert.equal(headingLike(para(9, 'A sentence that ends as prose does.')), false);
  assert.equal(headingLike({ index: 9, text: 'a quiet title', hints: { styleId: 'Heading2' } }), true);
  const [reply] = parseTermsReply(JSON.stringify({ entries: [{ heading: 'archives', kind: 'concept', discussed: true, quote: 'Archives were scarce; the archive' }] }), PASSAGE).proposals;
  assert.equal(reply.discussed, true);
});
