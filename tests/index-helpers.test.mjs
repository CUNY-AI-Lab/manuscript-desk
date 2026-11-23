import test from 'node:test';
import assert from 'node:assert/strict';
import { runCalls } from '../lib/index/runner.js';
import { PAGE_CONTEXTS, buildBatches, evidenceFound, judgePlan, pageLine, parseAssignments, parseDecisions, runJudge } from '../lib/index/judge.js';
import { applyExclusions, buildWindows, findMatter, headingAt, joinRanges, pageDigest, parseManualRanges, parseRanges } from '../lib/index/matter.js';
import { findHits } from '../lib/index/hits.js';
import { parseTermList } from '../lib/index/termlist.js';

const noWait = async () => {};

test('runCalls: three in flight, a retry after an unreadable reply, halves after running out of room, failures kept', async () => {
  let inFlight = 0, most = 0;
  const seen = [];
  const tasks = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key, size: key === 'c' ? 2 : 1 }));
  const call = async task => {
    inFlight += 1; most = Math.max(most, inFlight);
    await new Promise(done => setTimeout(done, 5));
    inFlight -= 1;
    seen.push(task.key);
    if (task.key === 'b' && seen.filter(key => key === 'b').length === 1) return { content: 'not json' };
    if (task.key === 'c') throw Object.assign(new Error('room'), { code: 'model_output_limit' });
    if (task.key === 'e') throw Object.assign(new Error('nope'), { code: 'quota_exceeded' });
    return { content: JSON.stringify({ ok: task.key }) };
  };
  const parse = content => { try { return JSON.parse(content); } catch { return null; } };
  const split = task => [{ key: `${task.key}.0`, size: 1 }, { key: `${task.key}.1`, size: 1 }];
  const progress = [];
  const { results, failures } = await runCalls({ tasks, call: (task) => (task.key.startsWith('c.') ? Promise.resolve({ content: JSON.stringify({ ok: task.key }) }) : call(task)), parse, split, wait: noWait, onProgress: p => progress.push(p) });
  assert.ok(most <= 3);
  assert.deepEqual([...results.keys()].sort(), ['a', 'b', 'c.0', 'c.1', 'd']);
  assert.deepEqual(failures.map(failure => [failure.key, failure.code]), [['e', 'quota_exceeded']]);
  assert.deepEqual(progress.at(-1), { done: 7, total: 7 });
});

test('runCalls: a rate-limit refusal waits and asks again; Stop rejects and keeps what was answered', async () => {
  let refusals = 0;
  const waits = [];
  const { results } = await runCalls({
    tasks: [{ key: 'a' }],
    call: async () => { if (refusals++ < 2) throw Object.assign(new Error('slow down'), { code: 'rate_limited', status: 429 }); return { content: '{}' }; },
    parse: () => ({}),
    wait: async ms => { waits.push(ms); },
  });
  assert.equal(results.size, 1);
  assert.deepEqual(waits, [2000, 4000]);
  const controller = new AbortController();
  const answered = [];
  const run = runCalls({ tasks: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }], call: async task => { if (task.key === 'd') controller.abort(new Error('stopped')); await new Promise(done => setTimeout(done, 5)); return { content: '{}' }; }, parse: () => ({}), signal: controller.signal, onResult: task => answered.push(task.key) });
  await assert.rejects(run, /stopped/);
});

// Invented pages for the helpers.
const pages = (...texts) => texts.map((text, i) => ({ number: String(i + 1), text }));
const BOOK = pages('The Bush family met. A bush grew.', 'Bush spoke at length about the river.', 'Nothing here.');

test('batches number each hit, mark it and give its page; answers count only for numbers shown', () => {
  const { entries } = parseTermList('Names:\nBush\n');
  const { byEntry } = findHits(BOOK, entries);
  const [batch] = buildBatches('ambiguous', entries[0], byEntry.get(entries[0].id).hits, { reasons: ['found 1 time in lower case'] });
  assert.match(batch.text, /^Index entry: Bush\nSearched for: Bush\nThis entry is a person\.\nWhy its hits are checked: found 1 time in lower case\.\nPlaces found:\n\[1\] p\. 1 \(first line of the page\): The ⟦Bush⟧ family met/);
  assert.match(batch.text, /\[2\] p\. 1 \(first line of the page\): .*A ⟦bush⟧ grew\./);
  assert.equal(batch.hitIds.length, 3);
  const decisions = parseDecisions(JSON.stringify({ decisions: [{ hit: 2, keep: false, reason: 'a plant', evidence: 'A bush grew' }, { hit: 9, keep: false }, { hit: 1, keep: 'yes' }, { hit: 3, keep: true, reason: 'the person' }] }), batch);
  assert.deepEqual([...decisions], [[batch.hitIds[1], { keep: false, reason: 'a plant', evidence: 'A bush grew' }], [batch.hitIds[2], { keep: true, reason: 'the person' }]]);
  assert.equal(decisions.unverified, 0);
  assert.equal(parseDecisions('nonsense', batch), null);
});

test('a drop counts only with evidence from its own place; a kept hit needs none', () => {
  const { entries } = parseTermList('Names:\nBush\n');
  const { byEntry } = findHits(BOOK, entries);
  const [batch] = buildBatches('ambiguous', entries[0], byEntry.get(entries[0].id).hits);
  const reply = decisions => parseDecisions(JSON.stringify({ decisions }), batch);
  // Evidence from another place, too short, missing, or not in the text at all: undecided.
  const out = reply([{ hit: 1, keep: false, evidence: 'spoke at length' }, { hit: 2, keep: false, evidence: 'A' }, { hit: 3, keep: false }, { hit: 1, keep: false, evidence: 'words not there' }]);
  assert.equal(out.size, 0);
  assert.equal(out.unverified, 4);
  // The marks around the hit are not part of the evidence; case and spacing aside.
  assert.equal(evidenceFound('A  BUSH grew', batch.contexts[1]), true);
  assert.equal(evidenceFound('⟦bush⟧ grew', batch.contexts[1]), true);
});

test('the subentry question numbers pages, each with the words around its hits, and an answer covers the page', () => {
  const book = pages('Rome spoke. Later Rome again. And Rome a third time, Rome a fourth.', 'Rome flooded.');
  const { entries } = parseTermList('Terms:\nRome\n  speeches (spoke)\n  floods\n');
  const { byEntry } = findHits(book, entries);
  const hits = byEntry.get(entries[0].id).hits;
  const [batch] = buildBatches('subentries', entries[0], hits, { subentries: entries[0].subentries });
  assert.deepEqual(batch.places.map(place => place.length), [4, 1]);
  assert.match(batch.text, /Subentries:\n\[S1\] speeches\n\[S2\] floods\nPages found:\n\[1\] p\. 1: .*⟦Rome⟧.*\n\[2\] p\. 2: ⟦Rome⟧ flooded\./);
  assert.ok(pageLine(1, hits.slice(0, 4)).split(' / ').length <= PAGE_CONTEXTS);
  const sorted = parseAssignments(JSON.stringify({ assignments: [{ n: 1, subentry: 'S1' }, { n: 2, subentry: null }, { n: 3, subentry: 'S1' }, { page: 2, subentry: 'S2' }] }), batch, 2);
  assert.deepEqual([...sorted.values()], [0, 0, 0, 0, null], 'a printed page number is never taken for a place');
  assert.deepEqual([...parseAssignments(JSON.stringify({ assignments: [{ hit: 2, subentry: 'S7' }] }), batch, 2).values()], [], 'an unknown subentry is no answer');
});

test('batches stay under the hit limit; the plan counts hits and calls', () => {
  const many = pages(...Array.from({ length: 90 }, (_, i) => `Page ${i} mentions Rome once.`));
  const { entries } = parseTermList('Rome\n');
  const { byEntry } = findHits(many, entries);
  const batches = buildBatches('ambiguous', entries[0], byEntry.get(entries[0].id).hits);
  assert.deepEqual(batches.map(batch => batch.hitIds.length), [40, 40, 10]);
  assert.deepEqual(judgePlan('ambiguous', entries, byEntry), { hits: 90, calls: 3 });
});

test('runJudge collects decisions by hit id and sorting by subentry', async () => {
  const { entries } = parseTermList('Terms:\nriver\n  speeches (spoke)\n  floods\nNames:\nBush\n');
  const { byEntry } = findHits(BOOK, entries);
  const callJudge = async ({ task, text }) => ({ content: task === 'ambiguous'
    ? JSON.stringify({ decisions: [...text.matchAll(/^\[(\d+)\]/gm)].map(match => ({ hit: Number(match[1]), keep: !/⟦bush⟧/.test(text.split('\n').find(line => line.startsWith(`[${match[1]}]`))), reason: 'checked', evidence: 'bush grew' })) })
    : JSON.stringify({ assignments: [{ n: 1, subentry: 'S1' }] }) });
  const judged = await runJudge({ task: 'ambiguous', entries: [entries[1]], byEntry, model: 'm', callJudge, wait: noWait });
  assert.deepEqual([...judged.answers.values()].map(answer => answer.keep), [true, false, true]);
  const sorted = await runJudge({ task: 'subentries', entries, byEntry, model: 'm', callJudge, wait: noWait });
  assert.equal(sorted.batches, 1, 'only entries with subentries are asked');
  assert.deepEqual([...sorted.answers.values()], [0]);
});

// --- Page ranges ---

const BOOK_PAGES = [
  { label: 'i', text: 'An Invented Book\nby A. Writer\n' },
  { label: 'v', text: 'Contents\nIntroduction 1\nOne 5\n' },
  { label: '1', text: 'Introduction\nThe argument begins here and runs on.\n' },
  { label: '2', text: `${'Chapter text continues at length. '.repeat(10)}\nBibliography\nAdams, A. A Book. 1999.\n` },
  { label: '3', text: 'Baker, B. Another Book. 2001.\n' },
  { label: '4', text: 'Index\nAdams, 2\n' },
];

test('page digests show openings and short lines; windows cover every page once', () => {
  assert.equal(pageDigest(BOOK_PAGES[1], 1), '[2] (printed v) Contents / Introduction 1 / One 5');
  const windows = buildWindows(BOOK_PAGES, { chars: 150 });
  assert.ok(windows.length > 1);
  assert.equal(windows[0].first, 1);
  assert.equal(windows.at(-1).last, 6);
  for (let at = 1; at < windows.length; at += 1) assert.equal(windows[at].first, windows[at - 1].last + 1);
});

test('a range counts only when its heading is on its first page; continuing ranges join', () => {
  const window = { first: 1, last: 6 };
  const reply = JSON.stringify({ ranges: [
    { kind: 'front-matter', first: 1, last: 2, heading: 'An Invented Book' },
    { kind: 'bibliography', first: 4, last: 5, heading: 'Bibliography' },
    { kind: 'index', first: 6, last: 6, heading: 'Index' },
    { kind: 'notes', first: 3, last: 3, heading: 'Notes' },
    { kind: 'bibliography', first: 5, last: 9, heading: 'Baker' },
    { kind: 'appendix', first: 3, last: 3, heading: 'Introduction' },
  ] });
  const parsed = parseRanges(reply, window, BOOK_PAGES);
  assert.deepEqual(parsed.ranges.map(range => [range.kind, range.first, range.last]), [['front-matter', 1, 2], ['bibliography', 4, 5], ['index', 6, 6]]);
  assert.equal(parsed.rejected, 3);
  assert.equal(headingAt('Bib', BOOK_PAGES[3].text), -1, 'too short to be evidence');
  const joined = joinRanges([{ kind: 'bibliography', first: 4, last: 4, heading: 'Bibliography' }, { kind: 'bibliography', first: 5, last: 5, heading: '', continues: true }, { kind: 'notes', first: 3, last: 3, continues: true, heading: '' }]);
  assert.deepEqual(joined, { ranges: [{ kind: 'bibliography', first: 4, last: 5, heading: 'Bibliography' }], dropped: 1 });
});

test('excluding ranges skips their pages but keeps the chapter text before a heading in mid-page', () => {
  const numbered = BOOK_PAGES.map(page => ({ number: page.label, text: page.text }));
  const { pages: out, kept } = applyExclusions(numbered, [{ first: 4, last: 5, heading: 'Bibliography' }, { first: 6, last: 6, heading: 'Index' }, { first: 1, last: 2, heading: 'An Invented Book' }]);
  assert.deepEqual(out.map(page => page.number), [null, null, '1', '2', null, null]);
  assert.deepEqual(kept, [4]);
  assert.equal(out[3].text.includes('Bibliography'), false);
  assert.ok(out[3].text.startsWith('Chapter text continues'));
  assert.deepEqual(parseManualRanges('1-2, 6', 6), [{ kind: 'manual', first: 1, last: 2, heading: '' }, { kind: 'manual', first: 6, last: 6, heading: '' }]);
  assert.equal(parseManualRanges('3-9', 6), null);
  assert.equal(parseManualRanges('three', 6), null);
});

test('findMatter asks once per window and returns the joined, checked ranges', async () => {
  const calls = [];
  const result = await findMatter({ pages: BOOK_PAGES, model: 'm', wait: noWait, callRanges: async ({ pages: text }) => { calls.push(text); return { content: JSON.stringify({ ranges: [{ kind: 'index', first: 6, last: 6, heading: 'Index' }] }) }; } });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^Pages 1 to 6 of the 6 in the PDF\./);
  assert.deepEqual(result.ranges, [{ kind: 'index', first: 6, last: 6, heading: 'Index' }]);
});
