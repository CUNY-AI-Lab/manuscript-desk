// The Formatter page's decisions for steps 4 to 6: the manuscript's size, the labelling plan, what
// is kept in this browser and how it comes back, what the review shows, which downloads are offered
// and how the summary reads. The manuscript is the invented one of tests/manuscript-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { ROLE_IDS, STRUCTURAL } from '../lib/roles/roles.js';
import { createStore } from '../web/shared/store.js';
import {
  DAMAGING, ROLE_LABELS, SAVED_KEY, afterLabelling, correctRole, effectiveRoles, excerpt, labelFailureLines, labellingPlan,
  manuscriptSize, matchFile, neighbours, newLabels, restoredLabels, reviewHeadline, reviewModel, rolesOfReply, savedLabels, sha256,
  unlabelledParagraphs,
} from '../web/format/manuscript-state.js';
import { STALE, afterFormat, baseName, buildOutputs, isStale, outputBasis, outputSummary, readingPlan, runningTitlesRule } from '../web/format/output-state.js';
import { RULES, manuscript, sheetWith } from './manuscript-fixture.mjs';

const JARGON = /\b(slot|schema|json|payload|params?|role id|hash)\b/i;
const { bytes, roles: GOLD } = manuscript();
const { paragraphs } = readDocx(bytes);
const HASH = await sha256(bytes);
const labelsWith = (roles, extra = {}) => ({ ...newLabels({ hash: HASH, name: 'book.docx', paragraphs: paragraphs.length, model: 'm' }), roles, ...extra });
const SHEET = sheetWith([RULES.restart, RULES.numbered, RULES.split, RULES.markers]);
const TITLES = ['running-title.length', 'length', { max: 30 }];

test('the manuscript\'s size counts words and paragraphs with text, in plain words', () => {
  const size = manuscriptSize(paragraphs);
  assert.equal(size.paragraphs, paragraphs.filter(entry => entry.text.trim()).length);
  assert.ok(size.words > 150);
  assert.equal(size.text, `${size.words} words in ${size.paragraphs} paragraphs`);
  assert.equal(manuscriptSize([{ index: 0, text: 'One.', hints: { empty: false } }]).text, '1 word in 1 paragraph');
});

test('the labelling plan states the number of model calls beforehand', () => {
  const plan = labellingPlan(paragraphs);
  assert.equal(plan.calls, 1);
  assert.match(plan.text, /^Labelling sends 33 paragraphs to the model in 1 passage, one model call each/);
  assert.doesNotMatch(plan.text, JARGON);
  const many = Array.from({ length: 200 }, (_, index) => ({ index, kind: 'paragraph', text: `Paragraph ${index} of an invented book.`, hints: { empty: false } }));
  assert.ok(labellingPlan(many).calls > 5);
  assert.equal(labellingPlan(many, { only: [3, 4, 5] }).calls, 1);
});

test('the file is known by the SHA-256 of its bytes', async () => {
  assert.match(HASH, /^[0-9a-f]{64}$/);
  assert.equal(await sha256(bytes), HASH);
  assert.notEqual(await sha256(manuscript({ typedNumbers: true }).bytes), HASH);
});

test('a reply is kept as roles only, never its text', () => {
  assert.deepEqual(rolesOfReply('{"roles":{"3":"body","4":"Verse","x":"body","5":"made-up","9":"heading-1"},"note":"secret words"}', 6), { 3: 'body' });
  assert.deepEqual(rolesOfReply('```json\n{"roles":{"1":"verse"}}\n```'), { 1: 'verse' });
  assert.equal(rolesOfReply('not json'), null);
  assert.equal(rolesOfReply('{"roles":{}}'), null);
});

test('what is saved holds the hash, roles and corrections by index, and no text', () => {
  const labels = correctRole(labelsWith({ ...GOLD }), 13, 'verse');
  const saved = savedLabels({ ...labels, failures: [{ passage: 2, code: 'upstream_timeout', message: 'Slow.', unlabelled: [0, 1] }], replies: { ['a'.repeat(64)]: { 3: 'body' } } });
  assert.deepEqual(Object.keys(saved).sort(), ['corrections', 'failures', 'hash', 'model', 'name', 'paragraphs', 'replies', 'roles']);
  // Words of the manuscript, apart from those that are also part of a role's name ("quotation").
  const roleWords = [...ROLE_IDS, 'paragraphs corrections failures replies unlabelled message model'].join(' ');
  const words = new Set(paragraphs.flatMap(entry => entry.text.toLowerCase().split(/[^a-z]+/)).filter(word => word.length > 4 && !roleWords.includes(word)));
  assert.ok(words.size > 20);
  const json = JSON.stringify(saved);
  assert.ok(![...words].some(word => json.includes(word)), 'no word of the manuscript is in the saved record');
  assert.deepEqual(saved.failures, [{ code: 'upstream_timeout', message: 'Slow.', unlabelled: [0, 1] }]);
  assert.deepEqual(restoredLabels(structuredClone(saved)), saved);
});

test('a saved record is checked as untrusted', () => {
  assert.equal(restoredLabels(null), null);
  assert.equal(restoredLabels({ hash: 'abc', paragraphs: 3 }), null);
  const back = restoredLabels({
    hash: HASH, name: 7, paragraphs: 10, model: 'm',
    roles: { 1: 'body', 2: 'nonsense', 20: 'body', '-1': 'verse', '<b>': 'body' },
    corrections: { 3: 'verse', 4: 'evil' },
    failures: [{ code: 'x', unlabelled: [1, 99] }, { code: 'y', unlabelled: [5, 5] }, 'junk'],
    replies: { notahash: { 1: 'body' }, ['b'.repeat(64)]: { 1: 'body', 2: 'x' } },
  });
  assert.deepEqual(back, { hash: HASH, name: 'the manuscript', paragraphs: 10, model: 'm', roles: { 1: 'body' }, corrections: { 3: 'verse' }, failures: [{ code: 'y', unlabelled: [5] }], replies: { ['b'.repeat(64)]: { 1: 'body' } } });
});

test('the same file reuses its labels; another file is labelled from the start, with a plain explanation', async () => {
  const labels = labelsWith({ ...GOLD });
  const same = matchFile(labels, { hash: HASH, paragraphs });
  assert.equal(same.kind, 'same');
  assert.equal(same.message, 'This is the file labelled before, book.docx. Its labels and your corrections were kept in this browser, so it is not labelled again.');
  const other = manuscript({ typedNumbers: true });
  const different = matchFile(labels, { hash: await sha256(other.bytes), paragraphs: readDocx(other.bytes).paragraphs });
  assert.equal(different.kind, 'other');
  assert.match(different.message, /^The labels kept in this browser are for another file, book\.docx\. This file is not the same one/);
  assert.equal(matchFile(null, { hash: HASH, paragraphs }).kind, 'none');
  const stopped = matchFile(labelsWith(null, { replies: { ['c'.repeat(64)]: { 1: 'body' } } }), { hash: HASH, paragraphs });
  assert.equal(stopped.message, 'Labelling this file stopped before it finished. 1 passage already labelled is kept in this browser and is not paid for again: choose Read the manuscript to finish.');
  for (const message of [same.message, different.message, stopped.message]) assert.doesNotMatch(message, JARGON);
});

test('a correction overrides the model; choosing the model\'s label again removes it', () => {
  let labels = labelsWith({ 13: 'block-quotation' });
  labels = correctRole(labels, 13, 'verse');
  assert.deepEqual(labels.corrections, { 13: 'verse' });
  assert.equal(effectiveRoles(labels)[13], 'verse');
  labels = correctRole(labels, 13, 'block-quotation');
  assert.deepEqual(labels.corrections, {});
  assert.equal(correctRole(labels, 13, 'nonsense'), labels);
});

test('after labelling, a second try only fills gaps and the failures are those still unlabelled', () => {
  const first = afterLabelling(labelsWith(null, { replies: { x: {} } }), { roles: { 1: 'body', 2: 'body' }, failures: [{ passage: 0, code: 'upstream_timeout', unlabelled: [3, 4] }, { passage: 1, code: 'incomplete_reply', unlabelled: [4, 5] }] });
  assert.deepEqual(first.roles, { 1: 'body', 2: 'body' });
  assert.deepEqual(first.failures, [{ code: 'upstream_timeout', unlabelled: [3, 4] }, { code: 'incomplete_reply', unlabelled: [5] }], 'each paragraph listed once');
  assert.deepEqual(first.replies, {});
  const second = afterLabelling(correctRole(first, 1, 'verse'), { roles: { 1: 'heading-1', 3: 'verse' }, failures: [{ passage: 0, code: 'quota_exceeded', unlabelled: [4, 5] }] }, { retry: true });
  assert.deepEqual(second.roles, { 1: 'body', 2: 'body', 3: 'verse' }, 'a retry never replaces a label');
  assert.deepEqual(second.corrections, { 1: 'verse' });
  assert.deepEqual(second.failures, [{ code: 'quota_exceeded', unlabelled: [4, 5] }]);
  assert.deepEqual(labelFailureLines(second.failures), ['2 paragraphs were not labelled. Your model allowance is used up.']);
  assert.deepEqual(labelFailureLines(first.failures), ['2 paragraphs were not labelled. The model service did not answer in time. Try again in a minute.', '1 paragraph was not labelled. The model\'s answer left them out.']);
});

test('the review shows by default what is not body text or a bibliography entry, grouped by chapter, unlabelled first', () => {
  const labels = correctRole(labelsWith({ ...GOLD }), 10, 'heading-1');
  const model = reviewModel(paragraphs, labels);
  const front = paragraphs.filter(entry => entry.text.trim() && !(entry.index in GOLD)).map(entry => entry.index);
  assert.deepEqual(model.unlabelled.map(item => item.index), front, 'the paragraphs with no label come first');
  assert.equal(model.chapters.length, 2);
  assert.equal(model.chapters[0].title, 'Paper Lanterns: How Invented Things Are Read');
  assert.equal(model.chapters[1].title, 'Glass Bells');
  const shown = model.chapters.flatMap(chapter => chapter.items);
  assert.ok(shown.every(item => STRUCTURAL.has(item.role) || item.corrected));
  assert.ok(shown.some(item => item.index === 10 && item.corrected && item.modelRole === 'body'), 'a corrected paragraph stays in view');
  assert.ok(!shown.some(item => item.role === 'body' && !item.corrected));
  assert.equal(model.total, 33);
  assert.equal(model.shown, front.length + shown.length);
  const counts = Object.fromEntries(model.counts.map(entry => [entry.role, entry.count]));
  assert.equal(counts['title-block'], 7);
  assert.equal(counts['heading-1'], 3);
  assert.equal(model.counts.find(entry => entry.role === 'verse').label, 'Verse');
  // Everything, and one role.
  const all = reviewModel(paragraphs, labels, 'all');
  assert.equal(all.shown, 33);
  const verse = reviewModel(paragraphs, labels, 'verse');
  assert.deepEqual(verse.chapters.flatMap(chapter => chapter.items).map(item => item.role), ['verse', 'verse', 'verse']);
  assert.equal(reviewHeadline(verse, 'verse'), `${verse.shown} paragraphs labelled verse, of 33 paragraphs with text.`);
  assert.equal(reviewHeadline(model, 'check'), `${model.shown} paragraphs to check, of 33 paragraphs with text.`);
  for (const label of Object.values(ROLE_LABELS)) assert.doesNotMatch(label, JARGON);
  assert.doesNotMatch(DAMAGING, JARGON);
  assert.match(DAMAGING, /most damaging mistake/);
});

test('front or back matter after a chapter is a review group of its own, and every role has words in the menu', () => {
  // The last four paragraphs with text: a heading and two notes, then a list item that stays with them.
  const at = paragraphs.filter(entry => entry.text.trim()).slice(-4).map(entry => entry.index);
  const labels = labelsWith({ ...GOLD, [at[0]]: 'front-matter-heading', [at[1]]: 'contributor-note', [at[2]]: 'contributor-note', [at[3]]: 'list-item' });
  const model = reviewModel(paragraphs, labels);
  const group = model.chapters.find(chapter => chapter.title === 'Front or back matter');
  assert.ok(group, 'a group for the matter');
  assert.deepEqual(group.items.map(item => item.role), ['front-matter-heading', 'contributor-note', 'contributor-note', 'list-item']);
  assert.equal(group.key, at[0]);
  assert.ok(model.chapters.every(chapter => !('matter' in chapter)));
  for (const role of ROLE_IDS) assert.ok(ROLE_LABELS[role], role);
});

test('an excerpt is the first 120 characters on one line; neighbours come on demand with their roles', () => {
  const long = { index: 0, text: `${'word '.repeat(40)}end`, hints: { empty: false } };
  assert.equal(Array.from(excerpt(long)).length, 120);
  assert.ok(excerpt(long).endsWith('…'));
  assert.equal(excerpt({ index: 1, text: 'A\nshort\tline', hints: {} }), 'A short line');
  assert.equal(excerpt({ index: 2, text: '', hints: { image: true } }), '(an image, with no text)');
  const near = neighbours(paragraphs, labelsWith({ ...GOLD }), 13);
  assert.deepEqual(near.map(entry => entry.side), ['before', 'before', 'after', 'after']);
  assert.ok(near.every(entry => typeof entry.excerpt === 'string' && entry.role));
  assert.equal(near[2].role, 'Body text');
});

test('the paragraphs still without a label are those with text that neither the model nor the scholar labelled', () => {
  const labels = correctRole(labelsWith({ ...GOLD }), 0, 'title-block');
  const left = unlabelledParagraphs(paragraphs, labels);
  assert.ok(!left.includes(0));
  assert.ok(left.every(index => paragraphs[index].text.trim()));
});

test('the labels are kept in this browser under their own key and come back after a reload', async () => {
  const store = createStore({ indexedDB: new IDBFactory() });
  const labels = correctRole(labelsWith({ ...GOLD }), 13, 'verse');
  await store.saveJob(SAVED_KEY, structuredClone(savedLabels(labels)));
  assert.deepEqual(restoredLabels(await store.loadJob(SAVED_KEY)), savedLabels(labels));
  assert.equal(await store.loadJob('format'), null, 'apart from the rule sheet\'s record');
});

// ---- Step 6 ----

test('formatting offers the formatted file, the To-dos list and the companions the sheet calls for, each a valid Word file', async () => {
  const result = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'My Book.docx', date: '2026-11-23T12:00:00Z' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map(file => [file.id, file.name]), [
    ['manuscript', 'My Book (formatted).docx'],
    ['todos', 'My Book To-dos.docx'],
    ['checklist', 'My Book Checklist.docx'],
  ]);
  for (const file of result.files) assert.equal(validateDocx(file.bytes).ok, true, file.name);
  assert.equal(validateDocx(result.files[0].bytes).counts.comments, result.summary.counts.comments);
  assert.ok(result.summary.counts.comments > 1);
  for (const file of result.files) assert.doesNotMatch(file.label, JARGON);
});

test('running titles are asked only when a rule asks for them, and a failed request leaves a template', async () => {
  const asked = [];
  const propose = async request => { asked.push(request); return JSON.stringify({ titles: { 1: 'Paper Lanterns', 2: 'Glass Bells' } }); };
  await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx', proposeTitles: propose });
  assert.equal(asked.length, 0);
  assert.equal(runningTitlesRule(SHEET), null);
  const withTitles = sheetWith([RULES.restart, TITLES]);
  const result = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: withTitles, name: 'b.docx', proposeTitles: propose });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].max, 30);
  assert.ok(result.files.some(file => file.id === 'running-titles-proposals'));
  const failed = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: withTitles, name: 'b.docx', proposeTitles: async () => { throw new Error('down'); } });
  assert.equal(failed.ok, true);
  assert.ok(failed.files.some(file => file.id === 'running-titles-template'));
  assert.match(failed.summary.notes.join(' '), /Running titles could not be proposed/);
});

test('the reading check runs only when chosen, states its calls first, and its verified queries become comments', async () => {
  const calls = readingPlan({ paragraphs, roles: GOLD, sheet: SHEET });
  assert.ok(calls >= 1);
  assert.equal(readingPlan({ paragraphs, roles: null, sheet: SHEET }), 0);
  const without = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx' });
  const asked = [];
  // The fake model quotes the first words of the first paragraph it was shown, and invents one quotation.
  const readText = async ({ unit }) => {
    asked.push(unit);
    const line = unit.split('\n').find(text => /^\[\d+\] \([^)]*\) .{12,}$/u.test(text));
    const [, index, text] = /^\[(\d+)\] \([^)]*\) (.*)$/u.exec(line);
    return JSON.stringify({ findings: [
      { kind: 'typo', paragraph: Number(index), quote: text.split(' ').slice(0, 4).join(' '), note: 'Check this word.' },
      { kind: 'typo', paragraph: Number(index), quote: 'words that are not there at all', note: 'Invented.' },
    ] });
  };
  const progress = [];
  const result = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx', readText, onReading: event => progress.push(event) });
  assert.equal(asked.length, calls, 'one call per chapter, as stated');
  assert.deepEqual(progress.at(-1), { done: calls, total: calls });
  assert.equal(result.ok, true);
  assert.equal(result.summary.counts.items, without.summary.counts.items + calls, 'each kept query is a To-dos item (and part of the comment at its paragraph)');
  assert.equal(result.summary.counts.reading, calls, 'only the verified query of each chapter is kept');
  assert.match(result.summary.flagged.join(' '), /The reading check read the opening of/);
  assert.equal(validateDocx(result.files[0].bytes).ok, true);
  assert.notEqual(outputBasis({ sheet: SHEET, roles: GOLD, reading: true }), outputBasis({ sheet: SHEET, roles: GOLD }), 'choosing the reading check makes earlier files out of date');
  const failed = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx', readText: async () => { throw { code: 'upstream_timeout', retry: false }; } });
  assert.equal(failed.ok, true, 'files are still offered');
  assert.match(failed.summary.notes.join(' '), /The reading check could not read/);
  for (const line of [...result.summary.flagged, ...failed.summary.notes]) assert.doesNotMatch(line, JARGON);
});

test('a formatter failure offers nothing and gives the reason; a failed re-run keeps the files made before', async () => {
  const broken = await buildOutputs({ bytes: new Uint8Array([1, 2, 3]), paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx' });
  assert.equal(broken.ok, false);
  assert.equal(broken.message, 'This is not a Word (.docx) file. Nothing was formatted.');
  assert.deepEqual(afterFormat(null, broken, 'b'), { output: null, error: broken.message, kept: false });
  const good = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: SHEET, name: 'b.docx' });
  const first = afterFormat(null, good, 'basis-1');
  assert.equal(first.output.files.length, 3);
  const again = afterFormat(first.output, broken, 'basis-2');
  assert.equal(again.output, first.output);
  assert.equal(again.kept, true);
  assert.match(again.error, /The files below are from the last time the manuscript was formatted\.$/);
  assert.equal(isStale(first.output, 'basis-1'), false);
  assert.equal(isStale(first.output, 'basis-2'), true);
  assert.equal(outputBasis({ sheet: SHEET, roles: GOLD }), outputBasis({ sheet: structuredClone(SHEET), roles: { ...GOLD } }));
  assert.notEqual(outputBasis({ sheet: SHEET, roles: GOLD }), outputBasis({ sheet: SHEET, roles: { ...GOLD, 13: 'verse' } }));
  assert.doesNotMatch(STALE, JARGON);
});

test('the summary says what was changed with counts, what was flagged and what is left to supply, in plain words', async () => {
  const supply = { ...SHEET, rules: [...SHEET.rules, { id: 'files-1', category: 'files', slot: null, statement: 'Send a signed permission form for each figure.', mode: 'supply', source: { kind: 'author' }, params: {}, enabled: true }] };
  const { summary } = await buildOutputs({ bytes, paragraphs, roles: GOLD, sheet: supply, name: 'b.docx' });
  assert.match(summary.headline, /^Formatted\. \d+ comments in the file, \d+ items on the To-dos list, 1 requirement for you to supply\.$/);
  assert.match(summary.changed[0], /^\d+ paragraphs were given a named style for what they are, in place of direct formatting\.$/);
  assert.ok(summary.changed.includes('1 chapter title divided at its colon into a title and a subtitle.'));
  assert.ok(summary.changed.some(line => /tracked changes, for you to accept or reject in Word\.$/.test(line)));
  assert.ok(summary.flagged.includes('Chapter title: 1 place.'));
  assert.deepEqual(summary.supply, ['Send a signed permission form for each figure.']);
  for (const line of [summary.headline, ...summary.changed, ...summary.flagged, ...summary.notes]) assert.doesNotMatch(line, JARGON);
  const conflicted = { ...SHEET, rules: [...SHEET.rules, { ...SHEET.rules[0], id: 'rule-9', params: { per: 'none' }, conflict: true }, { ...SHEET.rules[0], conflict: true }] };
  const notes = outputSummary({ report: { styles: {}, declared: [] }, findings: [], checks: [], sheet: conflicted, comments: 1, revisions: 0, todos: { counts: { items: 0 } } }).notes;
  assert.deepEqual(notes, ['1 setting in the rule sheet has rules that disagree, so it was not applied. Choose one rule in each case in step 3 and format again.']);
});

test('download names come from the file name, without characters a file name cannot hold', () => {
  assert.equal(baseName('My Book.docx'), 'My Book');
  assert.equal(baseName('a/b:c?.DOCX'), 'a b c');
  assert.equal(baseName(''), 'manuscript');
});
