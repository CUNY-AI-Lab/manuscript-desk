import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, affiliationSplit, contentsCallsUnnumbered, markerForm, planFormatting, settingsFrom } from '../lib/format/plan.js';
import { isAffiliation, isLabel, isNames, titleParts } from '../lib/format/titles.js';
import { compareWords, diffWords } from '../lib/format/words.js';
import { addRows, alignKeys, compare, keyOf } from '../scripts/format-eval.mjs';
import { RULES, sheetWith } from './manuscript-fixture.mjs';

// A paragraph model written for these tests, as readDocx returns it.
const hints = (extra = {}) => ({ align: null, indentLeft: 0, indentRight: 0, indentFirst: 0, styleId: null, bold: false, italic: false, size: null, list: false, pageBreak: false, image: false, footnote: false, empty: false, ...extra });
const model = list => list.map(([text, extra], index) => ({ index, kind: 'paragraph', text, hints: hints({ empty: text.trim() === '' && !extra?.image && !extra?.footnote, ...extra }) }));
const lines = block => titleParts(block.map(text => ({ text })));

test('title blocks: label, title, subtitle, author and affiliation', () => {
  assert.deepEqual(lines(['A Title', 'Ada Placeholder', 'University of Elsewhere']), ['title', 'author', 'affiliation']);
  assert.deepEqual(lines(['Chapter 4', 'A Title', 'Ada Placeholder']), ['label', 'title', 'author']);
  assert.deepEqual(lines(['A Title', 'and what it means for the reader', 'Ada Placeholder', 'Institute of Nowhere']), ['title', 'subtitle', 'author', 'affiliation']);
  assert.deepEqual(lines(['A Title', 'Sounding Invented Objects', 'Ben Example and Cy Sample', 'Institute of Nowhere']), ['title', 'subtitle', 'author', 'affiliation'], 'a title-case subtitle before one author line and one affiliation');
  assert.deepEqual(lines(['A Title', 'Ada Placeholder', 'University of Elsewhere', 'Ben Example', 'Institute of Nowhere']), ['title', 'author', 'affiliation', 'author', 'affiliation']);
  assert.deepEqual(lines(['A Title', 'Ada Placeholder, University of Elsewhere']), ['title', 'author'], 'one line that names both is the author line');
  assert.deepEqual(lines(['Only a Title']), ['title']);
  assert.deepEqual(lines(['A Title', 'a subtitle in lower case']), ['title', 'subtitle']);
  assert.ok(isLabel('Chapter 12') && isLabel('PART II') && isLabel('3') && !isLabel('Chapter and verse in the archive'));
  assert.ok(isAffiliation('Universität Nirgendwo') && isAffiliation('ada@example.org') && !isAffiliation('Ada Placeholder'));
  assert.ok(isNames('Ada Placeholder and Ben van Example') && !isNames('Reading in 1920') && !isNames('What Is a Lantern?'));
});

test('the sheet\'s settings: rules switched off or in conflict are not applied', () => {
  assert.deepEqual(settingsFrom(null), DEFAULT_SETTINGS);
  const sheet = sheetWith([RULES.restart, RULES.numbered, RULES.split, RULES.markers]);
  const settings = settingsFrom(sheet);
  assert.equal(settings.notesRestart, true);
  assert.equal(settings.headingNumbers, true);
  assert.equal(settings.splitTitles, true);
  assert.deepEqual(settings.figureMarker, { before: '[Figure ', after: ' about here]', label: 'Figure', separator: '.' });
  assert.equal(settings.figuresPerChapter, true, 'the example\'s number has a chapter part');
  sheet.rules[0].enabled = false;
  sheet.rules[1].conflict = true;
  assert.equal(settingsFrom(sheet).notesRestart, false);
  assert.equal(settingsFrom(sheet).headingNumbers, false);
  assert.deepEqual(markerForm('[insert Fig. 5.3 here]'), { before: '[insert Fig. ', after: ' here]', label: 'Fig.', separator: '.' });
  assert.equal(markerForm('<Illustration 4>').label, 'Illustration');
});

test('chapters begin at a title block and end at the last paragraph with a role', () => {
  const paragraphs = model([['Front'], ['Title one'], ['Ada Placeholder'], ['Text.'], [''], ['Title two'], ['Text.'], ['Back matter']]);
  const roles = { 1: 'title-block', 2: 'title-block', 3: 'body', 5: 'title-block', 6: 'body' };
  const plan = planFormatting(paragraphs, roles);
  assert.deepEqual(plan.chapters.map(({ first, last, titleBlock }) => ({ first, last, titleBlock })), [{ first: 1, last: 3, titleBlock: [1, 2] }, { first: 5, last: 6, titleBlock: [5] }]);
  assert.deepEqual([...plan.removed], [4]);
  assert.equal(plan.decisions.has(0), false, 'no role, no decision');
  assert.equal(plan.decisions.get(3).style, 'body-first');
});

test('front and back matter belong to no chapter: a chapter ends before them, and they get styles of their own', () => {
  const paragraphs = model([
    ['A Book of Invented Lanterns'], ['Edited by'], ['Ada Placeholder'], ['University of Elsewhere'], [''],
    ['Contents'], [''], ['Paper Lanterns 3'], ['Ben Example'], [''],
    ['Paper Lanterns'], ['Ben Example'], ['Text.'], ['Works Cited'], ['Entry.'], [''],
    ['Notes on Contributors'], ['Ben Example teaches lantern studies.'], ['Abbreviations'], ['PL  Paper Lanterns'], [''],
    ['Part II: Glass'], ['Glass Bells'], ['Cy Sample'], ['Text.'],
  ]);
  const roles = { 0: 'title-page', 1: 'title-page', 2: 'title-page', 3: 'title-page', 5: 'front-matter-heading', 7: 'contents-entry', 8: 'contents-entry',
    10: 'title-block', 11: 'title-block', 12: 'body', 13: 'bibliography-heading', 14: 'bibliography-entry', 16: 'front-matter-heading', 17: 'contributor-note',
    18: 'front-matter-heading', 19: 'list-item', 21: 'part-title', 22: 'title-block', 23: 'title-block', 24: 'body' };
  const plan = planFormatting(paragraphs, roles);
  assert.deepEqual(plan.chapters.map(({ first, last }) => ({ first, last })), [{ first: 10, last: 14 }, { first: 22, last: 24 }], 'the notes, the list after them and the part title are in no chapter');
  const style = index => plan.decisions.get(index).style;
  assert.deepEqual([0, 1, 2, 3].map(style), ['book-title', 'book-label', 'book-author', 'book-affiliation'], '"Edited by" is a label wherever it stands');
  assert.deepEqual([5, 7, 8, 16, 17, 18, 19, 21].map(style), ['front-matter-heading', 'contents-entry', 'contents-entry', 'front-matter-heading', 'contributor-note', 'front-matter-heading', 'list-item', 'part-title']);
  assert.equal(style(12), 'body-first');
  // Spacers go from the start of the front matter to the end of the last chapter.
  assert.deepEqual([...plan.removed], [4, 6, 9, 15, 20]);
});

test('a bibliography heading after another is a subheading; an epigraph\'s short last line is its source', () => {
  const paragraphs = model([['Title'], ['A long epigraph that a chapter opens with, quoted from somewhere else entirely.'], ['— Someone'], ['Text.'], ['Works Cited'], ['Primary'], ['Entry.'], ['Secondary'], ['Entry.']]);
  const roles = { 0: 'title-block', 1: 'epigraph', 2: 'epigraph', 3: 'body', 4: 'bibliography-heading', 5: 'bibliography-heading', 6: 'bibliography-entry', 7: 'bibliography-heading', 8: 'bibliography-entry' };
  const styles = [...planFormatting(paragraphs, roles).decisions].map(([, decision]) => decision.style);
  assert.deepEqual(styles, ['chapter-title', 'epigraph', 'epigraph-source', 'body-first', 'bibliography-heading', 'bibliography-subheading', 'bibliography-entry', 'bibliography-subheading', 'bibliography-entry']);
});

test('figures are numbered by chapter, an introduction left unnumbered', () => {
  const paragraphs = model([['Introduction: Why Lanterns'], ['[FIGURE HERE]'], ['A Chapter'], ['Text.'], ['[FIGURE ONE]'], ['Text.'], ['Image', { image: true }], ['A caption.']]);
  const roles = { 0: 'title-block', 1: 'figure', 2: 'title-block', 3: 'body', 4: 'figure', 5: 'body', 6: 'figure', 7: 'figure' };
  const settings = settingsFrom(sheetWith([RULES.markers]));
  const { decisions } = planFormatting(paragraphs, roles, settings);
  assert.equal(decisions.get(1).figure.label, '1', 'an unnumbered chapter\'s figures are numbered through the work');
  assert.equal(decisions.get(4).figure.label, '1.1');
  assert.equal(decisions.get(4).figure.placeholder, true);
  assert.equal(decisions.get(6).figure.label, '1.2');
  assert.equal(decisions.get(7).captionLabel, '1.2', 'the text after an image is its caption');
});

test('an introduction with a title of its own is unnumbered when the contents list calls it Introduction, so the next chapter is chapter 1', () => {
  const paragraphs = model([['Contents'], ['Introduction: “Why Lanterns: A Short History” 3'], ['Glass and Wick 9'], ['“Why Lanterns: A Short History”'], ['Ada Placeholder'], ['Text.'], ['Glass and Wick'], ['Ben Example'], ['Text.'], ['[FIGURE HERE]']]);
  const roles = { 0: 'front-matter-heading', 1: 'contents-entry', 2: 'contents-entry', 3: 'title-block', 4: 'title-block', 5: 'body', 6: 'title-block', 7: 'title-block', 8: 'body', 9: 'figure' };
  const { chapters, decisions } = planFormatting(paragraphs, roles, settingsFrom(sheetWith([RULES.markers])));
  assert.deepEqual(chapters.map(chapter => chapter.number), [null, 1]);
  assert.equal(decisions.get(9).figure.label, '1.1', 'the first numbered chapter\'s figure is 1.1, not 2.1');
  // Without the contents line, the same opening is counted as chapter 1, as before.
  const bare = planFormatting(paragraphs, { ...roles, 1: 'body' }, DEFAULT_SETTINGS);
  assert.deepEqual(bare.chapters.map(chapter => chapter.number), [1, 2]);
  assert.equal(contentsCallsUnnumbered('Glass and Wick', ['Introduction: “Why Lanterns: A Short History” 3', 'Glass and Wick 9']), false);
  assert.equal(contentsCallsUnnumbered('Why', ['Introduction: Why 3']), false, 'too short a title to compare');
});

test('typed heading numbers are seen chapter by chapter', () => {
  const paragraphs = model([['Title'], ['1 Opening'], ['Text.'], ['2. Closing'], ['Second title'], ['Opening'], ['Text.']]);
  const roles = { 0: 'title-block', 1: 'heading-1', 2: 'body', 3: 'heading-1', 4: 'title-block', 5: 'heading-1', 6: 'body' };
  const plan = planFormatting(paragraphs, roles);
  assert.deepEqual(plan.chapters.map(chapter => chapter.typedNumbers), [true, false]);
});

test('empty paragraphs: a run between verse lines keeps one stanza break', () => {
  const paragraphs = model([['Title'], ['line one'], [''], [''], ['line two'], [''], ['Text.']]);
  const roles = { 0: 'title-block', 1: 'verse', 4: 'verse', 6: 'body' };
  const plan = planFormatting(paragraphs, roles);
  assert.deepEqual([...plan.stanzaBreaks], [2]);
  assert.deepEqual([...plan.removed].sort(), [3, 5]);
  const noted = model([['Title'], ['', { footnote: true }], ['Text.']]);
  assert.equal(planFormatting(noted, { 0: 'title-block', 2: 'body' }).removed.size, 0, 'a paragraph holding only a note reference stays');
});

test('the word diff finds what was removed and added, in order', () => {
  assert.deepEqual(diffWords(['a', 'b', 'c'], ['a', 'c']), { removed: ['b'], added: [] });
  assert.deepEqual(diffWords(['a', 'c'], ['a', 'b', 'c', 'd']), { removed: [], added: ['b', 'd'] });
  assert.deepEqual(diffWords(['x', 'y'], ['y', 'x']).removed.length, 1);
  const source = { body: ['Title:', 'Sub', 'text'], notes: ['n'] };
  const output = { body: ['Title', 'Sub', 'text', 'Fig.', '1'], notes: ['n'] };
  assert.deepEqual(compareWords(source, output, [{ removedWords: ['Title:'], addedWords: ['Title'] }]), { comparable: true, removed: 1, added: 3, declaredRemoved: 1, declaredAdded: 1, undeclaredRemoved: 0, undeclaredAdded: 2 });
});

test('the comparison keys ignore case, punctuation and a typed section number', () => {
  assert.equal(keyOf('2.1 The Opening, Again'), 'theopeningagain');
  assert.equal(keyOf('The opening again.'), 'theopeningagain');
  assert.equal(keyOf(' \t '), '');
});

test('alignment pairs equal texts in order, then near ones between them', () => {
  const { pairs } = alignKeys(['aaaa', 'bbbbbbbbbbbbbbbbbbbbbb', 'cccc', 'dddd'], ['aaaa', 'bbbbbbbbbbbbbbbbbbbbbx', 'zzzz', 'cccc']);
  assert.deepEqual(pairs, [[0, 0, 'exact'], [1, 1, 'near'], [2, 3, 'exact']]);
});

test('compare scores style agreement through the map and tallies the disagreements', () => {
  const unit = (position, text, style, section = 0) => ({ position, kind: 'paragraph', text, styleId: style, styleName: style, section });
  const output = [unit(0, 'front', '(none)'), unit(1, 'Title text', 'heading 1'), unit(2, 'First body text here', 'Body Text First'), unit(3, 'Second body text', 'Body Text'), unit(4, 'Only in output', 'Verse')];
  const reference = [unit(0, 'Contents', 'TOC1'), unit(1, 'Title text', 'Heading1', 1), unit(2, 'First body text here', 'BodyText', 1), unit(3, 'Second body text', 'BodyText', 1), unit(4, '', 'Verse', 1)];
  const map = { 'heading 1': 'Heading1', 'Body Text First': 'BodyTextFirst', 'Body Text': 'BodyText', Verse: 'Verse' };
  const { rows, emptyReference } = compare({ output, reference, map, chapterOfOutput: item => (item.position === 0 ? null : 'one'), referenceStart: 1 });
  const row = rows.get('one');
  assert.equal(row.reference, 3);
  assert.equal(row.output, 4);
  assert.equal(row.exact, 3);
  assert.equal(row.agree, 2);
  assert.deepEqual([...row.disagreements], [['BodyText -> Body Text First', 1]]);
  assert.deepEqual([...row.unmatchedOutput], [['Verse', 1]]);
  assert.equal(row.titleBlockAgree, 1);
  assert.equal(emptyReference, 1);
  assert.equal(addRows([row, row]).agree, 4);
});

test('an author line splits from its institution only when the rest reads as names', () => {
  assert.deepEqual(affiliationSplit('Ada Placeholder (University of Elsewhere)'), { at: 15, resume: 16 });
  assert.deepEqual(affiliationSplit('Ada Placeholder, Institute of Nowhere'), { at: 15, resume: 17 });
  assert.equal(affiliationSplit('Ada Placeholder'), null);
  assert.equal(affiliationSplit('Reading the Lantern (Institute of Nowhere)'), null, 'a lower-case word marks a phrase, not a name');
  assert.equal(affiliationSplit('on the reading of lanterns (Institute of Nowhere)'), null);
});

test('pasted lines join; separate quotations and lines parted by an empty paragraph do not', () => {
  const paragraphs = model([['Title'], ['The first line of a quotation that runs on'], ['into a second line and ends here.'], ['A separate quotation.'], [''], ['and this follows an empty paragraph.']]);
  const roles = { 0: 'title-block', 1: 'block-quotation', 2: 'block-quotation', 3: 'block-quotation', 5: 'block-quotation' };
  const { decisions } = planFormatting(paragraphs, roles);
  assert.equal(decisions.get(2).joinInto, 1);
  assert.equal(decisions.get(3).joinInto, undefined);
  assert.equal(decisions.get(5).joinInto, undefined);
});
