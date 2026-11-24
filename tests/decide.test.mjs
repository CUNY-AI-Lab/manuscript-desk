import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { withDefaults, LAYOUT_DEFAULTS, settlingDefault } from '../lib/decide/defaults.js';
import { authorOf, mechanicalOps, titleCased, typedInCapitals } from '../lib/decide/mechanical.js';
import { checkedChoice, copyeditable, firstDisposition, judgeReplace, judgeRole } from '../lib/decide/policy.js';
import { runUnit } from '../lib/decide/loop.js';
import { decidePlan, preparedSheet, triageRules } from '../lib/decide/run.js';
import { toolsFor } from '../lib/decide/tools.js';
import { buildOutputs } from '../web/format/output-state.js';
import { scriptedModel, scriptedReading, volume } from './decide-fixture.mjs';

const roleOf = roles => index => roles[index] ?? null;
const words = bytes => { const { files, main } = readPackage(bytes); return documentWords(files, main); };

// ---- The guards ----

test('the guards refuse every change to a title, a name, an affiliation, an abstract or keywords, and say where the proposal goes', () => {
  const at = (role, text = 'A Title of Some Length') => ({ text, role, caseRule: 'title', dashName: null });
  const cases = [
    [{ before: 'Some Length', after: 'Another Length' }, at('title-block'), 'changes-a-title-or-name', 'question'],
    [{ before: 'A Title of Some Length', after: 'A Title: of Some Length' }, at('title-block'), 'divides-a-title', 'question'],
    [{ before: 'Ada Placeholder', after: 'Ada Placeholdre' }, at('title-block', 'Ada Placeholder'), 'changes-a-title-or-name', 'question'],
    [{ before: 'Institute of Nowhere', after: 'Nowhere Institute' }, at('contributor-note', 'Ben teaches at the Institute of Nowhere.'), 'changes-a-name-or-affiliation', 'question'],
    [{ before: 'bells; glass', after: 'bells, glass' }, at('keywords', 'Keywords: bells; glass, sound'), 'changes-an-abstract-or-keywords', 'question'],
    [{ before: 'listens', after: 'hears' }, at('abstract', 'This chapter listens to bells.'), 'changes-an-abstract-or-keywords', 'question'],
    [{ before: 'The Sound', after: 'The Sounds' }, at('heading-1', 'The Sound'), 'changes-a-title-or-name', 'question'],
    [{ before: 'Bells.', after: 'Bell.' }, at('bibliography-entry', 'Example, Ben. Bells. Nowhere: Press, 2001.'), 'changes-a-reference', 'question'],
    [{ before: 'tehm', after: 'them' }, at('body', 'Bells ring tehm out.'), 'copyedits-the-text', 'copyedit'],
    [{ before: 'nothing here', after: 'x' }, at('body', 'Bells ring.'), 'not-in-text', null],
  ];
  for (const [edit, place, refusal, to] of cases) {
    const verdict = judgeReplace(edit, place);
    assert.equal(verdict.ok, false, JSON.stringify(edit));
    assert.equal(verdict.refusal, refusal, JSON.stringify(edit));
    assert.equal(verdict.to, to, JSON.stringify(edit));
  }
});

test('the guards allow only the declared mechanical cases: a dash written as the name above, and capitals to title case where a rule asks', () => {
  assert.deepEqual(judgeReplace({ before: '———', after: 'Example, Ben' }, { text: '———. Glass. Nowhere: Press, 2003.', role: 'bibliography-entry', caseRule: null, dashName: 'Example, Ben' }), { ok: true, kind: 'dash' });
  assert.equal(judgeReplace({ before: '———', after: 'Someone Else' }, { text: '———. Glass.', role: 'bibliography-entry', caseRule: null, dashName: 'Example, Ben' }).ok, false, 'only the name of the entry above');
  assert.deepEqual(judgeReplace({ before: 'GLASS BELLS', after: 'Glass Bells' }, { text: 'GLASS BELLS', role: 'title-block', caseRule: 'title', dashName: null }), { ok: true, kind: 'title-case' });
  assert.equal(judgeReplace({ before: 'GLASS BELLS', after: 'Glass Bells' }, { text: 'GLASS BELLS', role: 'title-block', caseRule: null, dashName: null }).ok, false, 'only where a rule asks for title case');
  assert.equal(judgeReplace({ before: 'GLASS BELLS', after: 'Glass Bell' }, { text: 'GLASS BELLS', role: 'title-block', caseRule: 'title', dashName: null }).ok, false, 'case only: no letter added or taken away');
  assert.equal(judgeRole({ from: 'title-block', to: 'body' }).ok, false);
  assert.equal(judgeRole({ from: 'body', to: 'title-block' }).ok, false);
  assert.equal(judgeRole({ from: 'body', to: 'heading-1' }).ok, true);
});

// ---- Dispositions ----

test('a finding leaves the author\'s list only when an operation resolves it, a default settles it, or the copyeditor takes it; the model cannot drop one', () => {
  const roles = { 1: 'body', 2: 'title-block', 3: 'abstract' };
  const none = () => null;
  const context = { roleOf: roleOf(roles), resolvedBy: none };
  assert.deepEqual(firstDisposition({ check: 'title-split', kind: 'chapter-title', paragraphIndex: 2, message: '' }, context), { choice: 'resolved', by: 'formatter' });
  assert.deepEqual(firstDisposition({ check: 'repeated-author-dash', kind: 'repeated-author-dash', paragraphIndex: 9, message: '' }, { ...context, resolvedBy: () => 'op-2' }), { choice: 'resolved', by: 'op-2' });
  assert.deepEqual(firstDisposition({ check: 'repeated-author-dash', kind: 'repeated-author-dash', paragraphIndex: 9, message: '' }, context), { choice: 'ask' }, 'without the operation applied it stays a question');
  assert.deepEqual(firstDisposition({ check: 'author-separators', kind: 'authors-joined-differently', paragraphIndex: 2, message: '' }, context), { choice: 'default', by: 'authors-as-typed' });
  assert.equal(firstDisposition({ check: 'abstract-length', kind: 'abstract-length', paragraphIndex: 3, message: 'This abstract has 255 words; the guidelines ask for about 200.' }, context).choice, 'default');
  assert.equal(firstDisposition({ check: 'abstract-length', kind: 'abstract-length', paragraphIndex: 3, message: 'This abstract has 400 words; the guidelines ask for about 200.' }, context).choice, 'ask', 'twice the length is a question');
  // A slip in running text: open, copyedit or ask; in protected text: a question.
  assert.deepEqual(firstDisposition({ check: 'reading', kind: 'typo', paragraphIndex: 1, message: '' }, context), { choice: 'open', allowed: ['ask', 'copyedit'] });
  assert.deepEqual(firstDisposition({ check: 'reading', kind: 'typo', paragraphIndex: 2, message: '' }, context), { choice: 'ask' });
  assert.deepEqual(firstDisposition({ check: 'reading', kind: 'missing-spaces', paragraphIndex: 3, message: '' }, context), { choice: 'ask' }, 'an abstract is the author\'s');
  assert.deepEqual(firstDisposition({ check: 'reading', kind: 'affiliation-inconsistent', paragraphIndex: 1, message: '' }, context), { choice: 'ask' }, 'a name or affiliation never goes to the copyeditor');
  assert.equal(copyeditable({ paragraphIndex: 1, other: { paragraph: 2 } }, roleOf(roles)), false, 'nor a difference whose other place is a title');
  // The model's choice is checked; anything else keeps the question.
  const open = { choice: 'open', allowed: ['ask', 'copyedit'] };
  assert.deepEqual(checkedChoice(open, { choice: 'copyedit' }), { disposition: { choice: 'copyedit' }, refused: false });
  assert.deepEqual(checkedChoice(open, { choice: 'dismiss' }), { disposition: { choice: 'ask' }, refused: true });
  assert.deepEqual(checkedChoice(open, { choice: 'resolved' }), { disposition: { choice: 'ask' }, refused: true });
  assert.deepEqual(checkedChoice(open, undefined), { disposition: { choice: 'ask' }, refused: false });
  assert.ok(settlingDefault({ check: 'a11y-link-text', paragraphIndex: 5 }, () => 'bibliography-entry'));
  assert.equal(settlingDefault({ check: 'a11y-link-text', paragraphIndex: 5 }, () => 'body'), null);
});

// ---- Operations ----

test('the mechanical operations: contents, dashes, capitals, a duplicate passage, a stray letter', () => {
  const { bytes, roles, sheet } = volume();
  const { paragraphs } = readDocx(bytes);
  const chapters = [{ first: 13, last: 16, titleBlock: [13, 14], parts: ['title', 'author'] }, { first: 17, last: 30, titleBlock: [17, 18, 19], parts: ['title', 'author', 'affiliation'] }, { first: 31, last: 41, titleBlock: [31, 32, 33], parts: ['title', 'author', 'affiliation'] }];
  const ops = mechanicalOps({ paragraphs, roles, chapters, sheet });
  const byKind = kind => ops.filter(op => op.kind === kind);
  const [contents] = byKind('contents');
  assert.deepEqual(contents.edits.filter(edit => edit.op === 'delete').map(edit => edit.from), [4, 5, 6, 7]);
  assert.deepEqual(contents.edits[0].lines.map(line => line.text), ['Notes on Contributors', 'Why We Read Lanterns', 'Glass Bells and Other Things', 'Paper Ships'], 'the titles as they will read, in title case where a rule asks');
  assert.equal(contents.resolves({ check: 'contents-against-chapters', paragraphIndex: 3, message: 'This contents list does not match the text in 2 places' }), true);
  assert.equal(contents.resolves({ check: 'contents-against-chapters', paragraphIndex: 31, message: 'The contents list gives this chapter as “Paper Ships Afloat”, which differs' }), false, 'a difference of wording stays the author\'s');
  const [dash] = byKind('dash');
  assert.deepEqual(dash.edits.map(edit => [edit.paragraph, edit.before, edit.after]), [[26, '———', 'Example, Ben'], [29, '——', 'Sample, Cy, and J. M. Writer']]);
  const [caps] = byKind('title-case');
  assert.deepEqual(caps.edits.map(edit => edit.after), ['Glass Bells and Other Things']);
  const [duplicate] = byKind('duplicate');
  assert.deepEqual(duplicate.edits.map(edit => [edit.from, edit.to]), [[35, 36]]);
  const [stray] = byKind('stray');
  assert.deepEqual(stray.paragraphs, [27]);
  // No rule, no operation: dashes and capitals are left without a rule asking.
  const bare = mechanicalOps({ paragraphs, roles, chapters, sheet: { ...sheet, rules: [] } });
  assert.deepEqual(bare.map(op => op.kind).sort(), ['contents', 'duplicate', 'stray']);
  // A refrain is not a duplicate: one short line repeated stays.
  assert.equal(authorOf('Writer, J. M. Lanterns at Sea. Nowhere: Press, 1999.'), 'Writer, J. M');
  assert.equal(authorOf('Placeholder, Ada. “Bells at Dusk.”'), 'Placeholder, Ada');
  assert.equal(titleCased('THE BELLS OF İZMİR AND OTHER PORTS: A SURVEY OF SOUND (1901–1950)'), 'The Bells of Izmir and Other Ports: A Survey of Sound (1901–1950)', 'the dotted capital I as a plain i');
  assert.equal(titleCased('BOOK II OF THE TWENTY-FIRST CENTURY'), 'Book II of the Twenty-First Century');
  assert.equal(typedInCapitals('Glass Bells'), false);
});

test('the defaults go in only where the guidelines are silent, never for a dissertation, and a guideline rule wins', () => {
  const { sheet } = volume();
  const { sheet: withThem, applied } = withDefaults(sheet);
  assert.deepEqual(applied.map(entry => entry.id), LAYOUT_DEFAULTS.map(entry => entry.id));
  assert.ok(withThem.rules.every(rule => rule.source.kind !== 'default' || rule.mode === 'fix'));
  const spoken = { ...sheet, rules: [...sheet.rules, { id: 'layout-1', category: 'layout', slot: 'layout.spacing', statement: 'Double spacing.', mode: 'fix', source: { kind: 'author' }, params: { line: 2 }, enabled: true }] };
  assert.ok(!withDefaults(spoken).applied.some(entry => entry.slot === 'layout.spacing'));
  assert.ok(withDefaults(spoken, { ignore: new Set(['layout-1']) }).applied.some(entry => entry.slot === 'layout.spacing'), 'a setting switched off as misread does not count as the guidelines speaking');
  assert.deepEqual(withDefaults({ ...sheet, docType: 'dissertation' }).applied, []);
  assert.ok(!withDefaults({ ...sheet, docType: 'article' }).applied.some(entry => entry.slot === 'chapters.label'), 'an article has no chapter labels');
});

test('a font size for figures is not the body font, and a slot left with one rule is no longer in conflict', () => {
  const rule = (id, params, quote) => ({ id, category: 'layout', slot: 'layout.font', statement: quote, mode: 'fix', source: { kind: 'guidelines', quote, doc: 0 }, params, enabled: true, conflict: true });
  const sheet = { version: 1, docType: 'monograph', manual: { id: null, named: null }, rules: [rule('layout-1', { family: 'House Serif', sizePt: null }, 'We have a house typeface that you may use for the text.'), rule('layout-2', { family: null, sizePt: 9 }, 'When your illustrations contain text, use at least 9 pt.')], dropped: 0, created: '2026-11-23T12:00:00Z' };
  const prepared = preparedSheet(sheet);
  assert.equal(prepared.rules.find(entry => entry.id === 'layout-2').slot, null);
  assert.equal(prepared.rules.find(entry => entry.id === 'layout-1').conflict, undefined);
  const cleared = preparedSheet(sheet, new Map([['layout-1', 'advice, not a requirement']]));
  assert.equal(cleared.rules.find(entry => entry.id === 'layout-1').enabled, false);
});

// ---- Triage ----

test('every rule ends as done, a default, not applicable, the copyeditor\'s, a thing to hand in, or a decision', () => {
  const rule = (id, mode = 'flag', extra = {}) => ({ id, category: 'other', slot: null, statement: `Rule ${id}.`, mode, source: { kind: 'author' }, params: {}, enabled: true, ...extra });
  const statuses = [
    { rule: rule('a'), status: 'done' }, { rule: rule('b'), status: 'flagged' }, { rule: rule('c'), status: 'flagged' }, { rule: rule('d', 'supply'), status: 'supply' },
    { rule: rule('e'), status: 'unchecked' }, { rule: rule('f'), status: 'unchecked' }, { rule: rule('g', 'supply'), status: 'supply' }, { rule: rule('h'), status: 'unchecked' },
    { rule: rule('i', 'fix', { source: { kind: 'default' } }), status: 'done' }, { rule: rule('j'), status: 'unchecked' },
  ];
  const answers = { triage: new Map([['d', { status: 'deliver', deliverable: 'image-files' }], ['e', { status: 'not-applicable' }], ['f', { status: 'copyedit' }], ['g', { status: 'deliver', deliverable: 'nonsense' }], ['h', { status: 'decision', question: 'Which?' }], ['j', { status: 'made-up' }]]) };
  const ends = triageRules({ statuses, answers, asked: [{ ruleId: 'b' }], settled: [] });
  assert.deepEqual(ends.map(entry => [entry.rule.id, entry.end]), [['a', 'done'], ['b', 'decision'], ['c', 'done'], ['d', 'deliver'], ['e', 'not-applicable'], ['f', 'copyedit'], ['g', 'deliver'], ['h', 'decision'], ['i', 'default'], ['j', 'decision']]);
  assert.equal(ends.find(entry => entry.rule.id === 'g').deliverable, 'other', 'an unknown kind of deliverable is "other"');
});

// ---- The loop ----

test('a unit is a short conversation: reading only in the first two turns, then decisions; a rate-limit refusal is waited out', async () => {
  const { bytes, roles } = volume();
  const { paragraphs } = readDocx(bytes);
  const unit = { kind: 'findings', name: 'chapter-1', items: ['F1'], text: 'F1 (typo) at paragraph 23: tehm' };
  const seen = [];
  let refusedOnce = false;
  const call = async ({ kind, reading, messages }) => {
    seen.push({ kind, reading, count: messages.length });
    if (!refusedOnce) { refusedOnce = true; throw { code: 'rate_limited', status: 429, retry: true }; }
    if (seen.length === 2) return { message: { content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_paragraphs', arguments: '{"from":22,"to":24}' } }] } };
    if (seen.length === 3) return { message: { content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'find_text', arguments: '{"text":"ring"}' } }] } };
    if (seen.length === 4) return { message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_paragraphs', arguments: '{"from":1,"to":3}' } }] } };
    return { message: { content: '', tool_calls: [{ id: 'd', type: 'function', function: { name: 'decide_findings', arguments: '{"items":[{"id":"F1","choice":"copyedit"}]}' } }] } };
  };
  const pauses = [];
  const { record, stats } = await runUnit({ unit, paragraphs, roleOf: roleOf(roles), call, wait: async ms => { pauses.push(ms); } });
  assert.deepEqual(seen.map(entry => entry.reading), [true, true, true, false, false]);
  assert.equal(pauses.length, 1);
  assert.equal(stats.readRefused, 1, 'reading after the second turn is refused');
  assert.equal(stats.stopped, 'finished');
  assert.deepEqual([...record.decided], [['F1', { choice: 'copyedit' }]]);
  assert.deepEqual(toolsFor('findings', true).map(tool => tool.function.name).slice(0, 2), ['read_paragraphs', 'find_text']);
  assert.ok(!toolsFor('findings', false).some(tool => tool.function.name === 'read_paragraphs'));
  assert.deepEqual(toolsFor('rules').map(tool => tool.function.name), ['triage_rules']);
});

test('the page says beforehand roughly how long the decide step takes', () => {
  const plan = decidePlan({ chapters: 12, openRules: 176, readingUnits: 14 });
  assert.ok(plan.calls > 30 && plan.calls < 60, String(plan.calls));
  assert.ok(plan.minutes >= 1 && plan.minutes <= 5, String(plan.minutes));
});

// ---- The whole step on the invented volume ----

test('formatting with the decide step does the work, keeps the questions, and hands back the files', async () => {
  const { bytes, roles, sheet } = volume();
  const { paragraphs } = readDocx(bytes);
  const log = [];
  const result = await buildOutputs({ bytes, paragraphs, roles, sheet, name: 'volume.docx', readText: scriptedReading, decide: scriptedModel(log), date: '2026-11-23T12:00:00Z' });
  assert.equal(result.ok, true, result.message);
  const { measures } = result;
  assert.deepEqual(measures.disposed.applied.map(op => op.kind).sort(), ['contents', 'dash', 'duplicate', 'stray', 'title-case']);
  assert.deepEqual(measures.report.edits.refused, []);
  // Words: everything declared, and rejecting every change gives the source back.
  const manuscript = result.files.find(file => file.id === 'manuscript').bytes;
  const check = compareWords(words(bytes), words(manuscript), measures.report.declared);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0);
  const { files, main } = readPackage(manuscript);
  assert.deepEqual(documentWords(files, main, { rejected: true }).body, words(bytes).body);
  for (const file of result.files) assert.equal(validateDocx(file.bytes).ok, true, file.name);
  // The title change was refused, counted and became a question; the typo is the copyeditor's.
  assert.deepEqual(measures.plan.refusals, [{ refusal: 'divides-a-title', paragraph: 13 }]);
  assert.equal(measures.copyedit, 1);
  assert.ok(measures.disposed.asked.some(finding => finding.check === 'note-on-title'), 'a note on an author\'s line stays a question');
  // The files: the manuscript, the checklist, what we did, the copyeditor's list; no To-dos list.
  assert.deepEqual(result.files.map(file => file.id).slice(0, 4), ['manuscript', 'checklist', 'what-we-did', 'copyedit']);
  assert.ok(!result.files.some(file => file.id === 'todos'));
  const comments = strFromU8(unzipSync(manuscript)['word/comments.xml']).replace(/<[^>]+>/gu, ' ');
  assert.match(comments, /What we did\./u);
  assert.match(comments, /Defaults we applied because the guidelines do not say: 1\.5 line spacing/u);
  assert.match(comments, /on the list “Queries for the copyeditor”/u);
  assert.doesNotMatch(comments, /tehm/u, 'a copyedit query is not a comment in the manuscript');
  const copyedit = strFromU8(unzipSync(result.files.find(file => file.id === 'copyedit').bytes)['word/document.xml']);
  assert.match(copyedit, /tehm/u);
  // The checklist: the decisions and one row per kind of thing to hand in.
  assert.equal(measures.checklistRows, measures.triage.filter(entry => entry.end === 'decision').length + new Set(measures.triage.filter(entry => entry.end === 'deliver').map(entry => entry.deliverable)).size);
  // The page's summary, in plain words.
  assert.match(result.summary.headline, /^Formatted\. You need to decide \d+ things?;/u);
  assert.ok(result.summary.defaults.some(line => /^1\.5 line spacing/u.test(line)));
  // The model was asked in units, with reading only in findings units.
  assert.ok(log.every(entry => entry.kind === 'findings' || entry.reading === false));
});

test('when the model service fails, every finding stays a question and the files are still made', async () => {
  const { bytes, roles, sheet } = volume();
  const { paragraphs } = readDocx(bytes);
  const failing = async () => { throw { code: 'service_unavailable', retry: false }; };
  const result = await buildOutputs({ bytes, paragraphs, roles, sheet, name: 'volume.docx', readText: scriptedReading, decide: failing });
  assert.equal(result.ok, true);
  assert.equal(result.measures.copyedit, 0, 'nothing goes to the copyeditor without a decision');
  assert.ok(result.measures.disposed.asked.some(finding => finding.kind === 'typo'));
  assert.ok(result.summary.notes.some(note => /did not answer/u.test(note)));
  assert.ok(result.measures.disposed.applied.length >= 4, 'the mechanical work is still done');
});
