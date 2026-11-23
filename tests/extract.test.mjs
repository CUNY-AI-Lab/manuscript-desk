import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_GROUP, extractRuleSheet } from '../lib/rules/extract.js';
import { splitGuidelines, splitInTwo } from '../lib/rules/chunk.js';
import { GROUPS, MAX_RULES, slotsFor, validateSheet } from '../lib/rules/schema.js';

// Guideline text written for these tests.
const G0 = 'Use American spelling throughout, following Merriam-Webster. Please use double quotation marks for all quotations. '
  + 'Notes should be footnotes rather than endnotes. Submit the manuscript as a Word file, with figures supplied as separate files.';
const G1 = 'Abstracts must not exceed 250 words. Every figure needs a caption and a credit line.';
const LONG = Array.from({ length: 30 }, (_, p) => Array.from({ length: 40 }, (_, s) => `Sentence ${p * 40 + s} states one more requirement.`).join(' ')).join('\n\n');

// Candidates in the shape a model reply delivers them, one or more per group.
const RULES = {
  style: [{ category: 'spelling', slot: 'spelling.variety', statement: 'Use US spelling.', quote: 'Use American spelling throughout', mode: 'fix', params: { variety: 'us' } }],
  references: [{ category: 'notes', slot: 'notes.kind', statement: 'Use footnotes.', quote: 'Notes should be footnotes rather than endnotes', mode: 'fix', params: { kind: 'footnotes' } }],
  structure: [{ category: 'files', slot: null, statement: 'Submit a Word file.', quote: 'Submit the manuscript as a Word file', mode: 'flag', params: {} }],
};
const reply = (rules, named = null) => ({ content: JSON.stringify({ rules, manual: { named } }) });
const coded = (code, retry) => Object.assign(new Error(code), { code, retry });
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// A fake callRules: answers each group with `answer(request, attempt)` (default: that group's
// RULES) and records every request.
function fake(answer = request => reply(RULES[request.group])) {
  const calls = [];
  const callRules = async request => {
    const attempt = calls.filter(call => call.group === request.group && call.text === request.text).length + 1;
    calls.push(request);
    return answer(request, attempt);
  };
  return { calls, callRules };
}

// Most tests ask no settings question (no callSettings); the questions are tested on their own below.
const run = (callRules, options = {}) => extractRuleSheet({ docType: 'article', model: 'glm-5.3', guidelines: [G0], callRules, ...options });
const categories = sheet => sheet.rules.map(rule => rule.category);

test('calls each of the three groups once for a one-part document', async () => {
  const { calls, callRules } = fake();
  const signal = new AbortController().signal;
  const { sheet, failures } = await run(callRules, { signal });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.group).sort(), [...GROUPS].sort());
  for (const call of calls) {
    assert.deepEqual(call, { model: 'glm-5.3', docType: 'article', group: call.group, text: G0, signal });
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(categories(sheet), ['spelling', 'notes', 'files']);
  assert.ok(sheet.rules.every(rule => rule.source.doc === 0));
  assert.equal(validateSheet(sheet).ok, true);
  assert.equal(sheet.docType, 'article');
  assert.equal(sheet.dropped, 0);
  assert.ok(Math.abs(Date.parse(sheet.created) - Date.now()) < 5000);
});

test('calls groups times parts times documents', async () => {
  const { calls, callRules } = fake(() => reply([]));
  const parts = splitGuidelines(LONG);
  assert.equal(parts.length, 2);
  await run(callRules, { guidelines: [G1, LONG] });
  assert.equal(calls.length, 9);
  const asked = calls.map(call => `${call.group}:${[G1, ...parts].indexOf(call.text)}`).sort();
  assert.deepEqual(asked, GROUPS.flatMap(group => [0, 1, 2].map(text => `${group}:${text}`)).sort());
});

test('tags each candidate with the document it was read from', async () => {
  // The quotation is in both documents; the reply for the second one claims the first.
  const second = `Preface to the guidelines. ${G1}`;
  const captions = { category: 'other', slot: null, statement: 'Caption every figure.', quote: 'Every figure needs a caption', mode: 'supply', params: {} };
  const { callRules } = fake(request => reply(request.text === second && request.group === 'structure' ? [{ ...captions, doc: 0 }] : []));
  const { sheet } = await run(callRules, { guidelines: [G1, second] });
  assert.deepEqual(sheet.rules.map(rule => [rule.category, rule.source.doc]), [['other', 1]]);
});

test('never has more than three calls in flight', async () => {
  let inFlight = 0;
  let most = 0;
  let count = 0;
  const callRules = async request => {
    const index = (count += 1);
    inFlight += 1;
    most = Math.max(most, inFlight);
    await tick((index * 7) % 5);
    inFlight -= 1;
    if (index % 4 === 0) throw coded('upstream_busy', false);
    return reply(RULES[request.group]);
  };
  const { failures } = await run(callRules, { guidelines: [G0, G1, G0, G1, G0] });
  assert.equal(count, 15);
  assert.equal(most, 3);
  assert.equal(failures.length, 3, 'failed calls did not stop the others');
});

test('accepts a reply wrapped in a json code fence', async () => {
  const { callRules } = fake(request => {
    const body = JSON.stringify({ rules: RULES[request.group], manual: { named: null } }, null, 2);
    return { content: request.group === 'style' ? `\`\`\`json\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\`\n` };
  });
  const { sheet, failures } = await run(callRules);
  assert.deepEqual(failures, []);
  assert.deepEqual(categories(sheet), ['spelling', 'notes', 'files']);
});

test('retries a non-JSON reply once and then records a failure', async () => {
  const { calls, callRules } = fake(request => {
    if (request.group === 'style') return { content: 'Here are the rules you asked for.' };
    if (request.group === 'references') return { content: JSON.stringify({ manual: { named: null } }) };
    return reply(RULES.structure);
  });
  const { sheet, failures } = await run(callRules);
  assert.equal(calls.filter(call => call.group === 'style').length, 2);
  assert.equal(calls.filter(call => call.group === 'references').length, 2, 'a reply without a rules array is retried too');
  assert.equal(calls.filter(call => call.group === 'structure').length, 1);
  assert.deepEqual(failures, [
    { group: 'style', doc: 0, part: 0, code: 'invalid_model_response' },
    { group: 'references', doc: 0, part: 0, code: 'invalid_model_response' },
  ]);
  assert.deepEqual(categories(sheet), ['files']);
});

test('a non-JSON first reply followed by a good one records no failure', async () => {
  const { calls, callRules } = fake((request, attempt) => (attempt === 1 ? { content: '{"rules": [' } : reply(RULES[request.group])));
  const { sheet, failures } = await run(callRules);
  assert.equal(calls.length, 6);
  assert.deepEqual(failures, []);
  assert.deepEqual(categories(sheet), ['spelling', 'notes', 'files']);
});

test('retries a rejection with retry true once; does not retry when retry is false', async () => {
  const { calls, callRules } = fake((request, attempt) => {
    if (request.group === 'style' && attempt === 1) throw coded('upstream_busy', true);
    if (request.group === 'references') throw coded('quota_exceeded', false);
    if (request.group === 'structure') throw new Error('Failed to fetch');
    return reply(RULES[request.group]);
  });
  const { sheet, failures } = await run(callRules);
  assert.deepEqual(calls.map(call => call.group).sort(), ['references', 'structure', 'style', 'style']);
  assert.deepEqual(failures, [
    { group: 'references', doc: 0, part: 0, code: 'quota_exceeded', message: 'quota_exceeded' },
    { group: 'structure', doc: 0, part: 0, code: 'network_error', message: 'Failed to fetch' },
  ]);
  assert.deepEqual(categories(sheet), ['spelling']);

  const twice = fake(() => { throw coded('upstream_busy', true); });
  const second = await run(twice.callRules);
  assert.equal(twice.calls.length, 6, 'each group is tried twice, no more');
  assert.deepEqual(second.failures.map(failure => failure.code), ['upstream_busy', 'upstream_busy', 'upstream_busy']);
});

test('a failure keeps the message the rejection carried, cut to 300 characters', async () => {
  const { callRules } = fake((request, attempt) => {
    if (request.group === 'style') throw { code: 'quota_exceeded', retry: false, message: 'Your allowance is used up.' };
    if (request.group === 'references') throw { code: 'upstream_busy', retry: true, message: attempt === 1 ? 'Busy, first try.' : 'y'.repeat(400) };
    throw { code: 'service_unavailable', retry: false, message: 42 };
  });
  const { failures } = await run(callRules);
  assert.deepEqual(failures, [
    { group: 'style', doc: 0, part: 0, code: 'quota_exceeded', message: 'Your allowance is used up.' },
    { group: 'references', doc: 0, part: 0, code: 'upstream_busy', message: 'y'.repeat(300) },
    { group: 'structure', doc: 0, part: 0, code: 'service_unavailable' },
  ], 'the last attempt\'s message; none when it is not a string');
  const empty = fake(() => { throw { code: 'service_unavailable', message: '' }; });
  assert.ok((await run(empty.callRules)).failures.every(failure => !Object.hasOwn(failure, 'message')), 'an empty message is left out');
});

test('a failed group does not remove the other groups rules', async () => {
  const { callRules } = fake(request => {
    if (request.group === 'references') throw coded('upstream_timeout', false);
    return reply(RULES[request.group]);
  });
  const { sheet, failures } = await run(callRules);
  assert.deepEqual(failures, [{ group: 'references', doc: 0, part: 0, code: 'upstream_timeout', message: 'upstream_timeout' }]);
  assert.deepEqual(categories(sheet), ['spelling', 'files']);
  assert.equal(validateSheet(sheet).ok, true);
});

test('drops an invented quote and reports it in sheet.dropped', async () => {
  const invented = { ...RULES.style[0], slot: 'spelling.variety', params: { variety: 'uk' }, quote: 'Authors must use British spelling everywhere' };
  const { callRules } = fake(request => reply(request.group === 'style' ? [invented, 'not a rule', ...RULES.style] : RULES[request.group]));
  const { sheet, failures } = await run(callRules);
  assert.deepEqual(failures, []);
  assert.equal(sheet.dropped, 2, 'the invented quote and the entry that is not a rule');
  assert.deepEqual(sheet.rules.map(rule => [rule.category, rule.params]), [['spelling', { variety: 'us' }], ['notes', { kind: 'footnotes' }], ['files', {}]]);
});

test('keeps the first 400 rules and counts the rest as dropped', async () => {
  // 450 requirements, each with its own quotation, so none is a duplicate of another.
  const many = Array.from({ length: 450 }, (_, n) => `Requirement number ${n} applies to every manuscript.`).join(' ');
  const rule = n => ({ category: 'other', slot: null, statement: `Meet requirement ${n}.`, quote: `Requirement number ${n} applies`, mode: 'flag', params: {} });
  const invented = { ...rule(0), quote: 'Requirement number 9999 applies' };
  const { callRules } = fake(request => reply(request.group === 'structure' ? [...Array.from({ length: 450 }, (_, n) => rule(n)), invented] : []));
  const { sheet, failures } = await run(callRules, { guidelines: [many] });
  assert.deepEqual(failures, []);
  assert.equal(MAX_RULES, 400);
  assert.equal(sheet.rules.length, 400);
  assert.equal(sheet.dropped, 51, 'the invented quote and the 50 rules past the limit');
  assert.equal(sheet.rules[0].statement, 'Meet requirement 0.');
  assert.equal(sheet.rules[399].statement, 'Meet requirement 399.');
  assert.equal(validateSheet(sheet).ok, true);
});

test('takes manual.named from the first reply that names one found in the guidelines', async () => {
  // The structure reply settles first, but references comes first in (document, part, group) order.
  const named = { style: null, references: '  The Chicago Manual of Style, 17th edition ', structure: 'MLA Handbook' };
  const both = `${G0} Follow the Chicago  Manual of Style, 17th Edition, and the MLA Handbook for anything else.`;
  const { callRules } = fake(async request => {
    await tick(request.group === 'structure' ? 0 : 20);
    return reply([], named[request.group]);
  });
  const { sheet } = await run(callRules, { guidelines: [both] });
  assert.equal(sheet.manual.named, 'The Chicago Manual of Style, 17th edition');

  const long = fake(request => reply([], request.group === 'style' ? 'x'.repeat(200) : null));
  assert.equal((await run(long.callRules, { guidelines: [`${G0} ${'x'.repeat(200)}`] })).sheet.manual.named, 'x'.repeat(120));
  const none = fake(request => ({ content: JSON.stringify({ rules: [], manual: request.group === 'style' ? { named: '   ' } : null }) }));
  const sheet2 = (await run(none.callRules)).sheet;
  assert.equal(sheet2.manual.named, null);
  assert.equal(validateSheet(sheet2).ok, true);
});

test('a named manual is kept only when the guidelines name it', async () => {
  // Short names count: the check is plain inclusion, not the quotation check.
  const apa = fake(request => reply([], request.group === 'references' ? 'APA 7' : null));
  assert.equal((await run(apa.callRules, { guidelines: [G1, `${G0} References follow APA 7 throughout.`] })).sheet.manual.named, 'APA 7', 'found in the second document');

  const invented = fake(request => reply([], request.group === 'references' ? 'The Chicago Manual of Style' : null));
  const { sheet } = await run(invented.callRules);
  assert.equal(sheet.manual.named, null, 'a manual the guidelines do not name is dropped');
  assert.equal(validateSheet(sheet).ok, true);

  // The first reply in order names a manual the text does not; a later one names one it does.
  const later = fake(request => reply([], { style: 'The Oxford Guide to Style', references: 'Merriam-Webster', structure: 'Word' }[request.group]));
  assert.equal((await run(later.callRules)).sheet.manual.named, 'Merriam-Webster');
});

test('reports progress up to the total', async () => {
  const progress = [];
  const { callRules } = fake((request, attempt) => {
    if (request.group === 'style' && attempt === 1) throw coded('upstream_busy', true);
    if (request.group === 'references') return { content: 'nonsense' };
    return reply(RULES[request.group]);
  });
  await run(callRules, { guidelines: [G0, G1], onProgress: event => progress.push(event) });
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6].map(done => ({ done, total: 6 })));
});

test('an onProgress that throws does not end the run', async () => {
  const { calls, callRules } = fake();
  let seen = 0;
  const { sheet, failures } = await run(callRules, { onProgress: () => { seen += 1; throw new Error('display broke'); } });
  assert.equal(seen, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(failures, []);
  assert.deepEqual(categories(sheet), ['spelling', 'notes', 'files']);
});

test('rejects when aborted', async () => {
  const before = new AbortController();
  const reason = new Error('Stopped by the author');
  before.abort(reason);
  const idle = fake();
  await assert.rejects(run(idle.callRules, { signal: before.signal }), error => error === reason);
  assert.equal(idle.calls.length, 0);

  const during = new AbortController();
  const signals = [];
  let started = 0;
  const callRules = ({ signal }) => {
    started += 1;
    signals.push(signal);
    if (started === 3) queueMicrotask(() => during.abort(reason));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const progress = [];
  await assert.rejects(run(callRules, { guidelines: [G0, G1], signal: during.signal, onProgress: event => progress.push(event) }), error => error === reason);
  await tick(5);
  assert.equal(started, 3, 'no call starts after the abort');
  assert.ok(signals.every(signal => signal === during.signal));
  assert.deepEqual(progress, []);

  const busy = new AbortController();
  let tries = 0;
  const abortThenBusy = async () => {
    tries += 1;
    busy.abort(reason);
    throw coded('upstream_busy', true);
  };
  await assert.rejects(run(abortThenBusy, { signal: busy.signal }), error => error === reason);
  await tick(5);
  assert.equal(tries, 1, 'a call is not retried after the abort');
});

test('rejects arguments a caller should never pass', async () => {
  const { calls, callRules } = fake();
  await assert.rejects(run(callRules, { docType: 'novel' }), Error);
  await assert.rejects(run(callRules, { guidelines: [] }), Error);
  await assert.rejects(run(callRules, { guidelines: 'not a list' }), Error);
  await assert.rejects(run('not a function'), Error);
  assert.equal(calls.length, 0);
});

test('a rule filed under a category the document type does not offer is kept under other, never fixed', async () => {
  const { callRules } = fake(request => reply(request.group === 'structure' ? [
    { category: 'anonymization', slot: 'anonymize', statement: 'Remove your name from the manuscript.', quote: 'Submit the manuscript as a Word file', mode: 'fix', params: { required: true } },
    { category: 'abstract-keywords', slot: null, statement: 'Write an abstract.', quote: 'with figures supplied as separate files', mode: 'supply', params: {} },
    { category: 'no-such-category', slot: null, statement: 'Unknown.', quote: 'Please use double quotation marks', mode: 'flag', params: {} },
  ] : []));
  const { sheet } = await run(callRules, { docType: 'monograph' });
  assert.deepEqual(sheet.rules.map(rule => [rule.category, rule.slot, rule.mode, rule.params, rule.statement]), [
    ['other', null, 'flag', {}, 'Remove your name from the manuscript.'],
    ['other', null, 'supply', {}, 'Write an abstract.'],
  ]);
  assert.equal(sheet.dropped, 1, 'an unknown category is still dropped');
  assert.equal(validateSheet(sheet).ok, true);
});

// ---- A part whose answer runs out of output room is read again in two halves ----

// Paragraphs of invented requirements, each stating one rule a fake model "finds" by its number.
const REQUIREMENTS = Array.from({ length: 24 }, (_, n) => `Requirement number ${n + 1} must be met by every author who submits.`);
const BIG = REQUIREMENTS.join('\n\n');
// A fake model that runs out of room above `limit` characters and otherwise reports, for the
// spelling group only, one rule per requirement it was shown.
function roomy(limit, { code = 'model_output_limit' } = {}) {
  return fake(request => {
    if (request.text.length > limit) throw coded(code, false);
    if (request.group !== 'style') return reply([]);
    return reply(REQUIREMENTS.filter(sentence => request.text.includes(sentence))
      .map(sentence => ({ category: 'other', slot: null, statement: sentence, quote: sentence, mode: 'flag', params: {} })));
  });
}
const runBig = (callRules, options = {}) => extractRuleSheet({ docType: 'article', model: 'glm-5.3', guidelines: [BIG], callRules, ...options });

test('splitInTwo cuts at the paragraph break nearest the middle, the second half starting a little before', () => {
  const [first, second] = splitInTwo(BIG);
  assert.ok(first.endsWith('\n\n') && !second.startsWith('\n'));
  assert.ok(Math.abs(first.length - BIG.length / 2) < REQUIREMENTS[0].length + 4, 'near the middle');
  assert.ok(first.length + second.length >= BIG.length, 'nothing is lost');
  assert.ok(REQUIREMENTS.every(sentence => first.includes(sentence) || second.includes(sentence)));
  assert.equal(splitInTwo('x'), null);
  const prose = 'One sentence here. Another sentence there. A third, much longer sentence ends it.';
  assert.deepEqual(splitInTwo(prose, { overlap: 0 }).map(half => half.trim()), ['One sentence here. Another sentence there.', 'A third, much longer sentence ends it.']);
});

test('a part that runs out of output room is read as two halves, and every rule is found', async () => {
  const { calls, callRules } = roomy(BIG.length - 1);
  const seen = [];
  const { sheet, failures } = await runBig(callRules, { onProgress: progress => seen.push(progress) });
  assert.deepEqual(failures, []);
  assert.equal(sheet.rules.length, REQUIREMENTS.length);
  // All three groups run out of room on the whole part: 3 whole calls and 6 halves.
  assert.equal(calls.length, 9);
  assert.equal(calls.filter(call => call.text === BIG).length, 3);
  assert.deepEqual(seen.at(-1), { done: 9, total: 9 });
});

test('a half that runs out of room again is reported once and not split further', async () => {
  const lengths = splitInTwo(BIG).map(half => half.length);
  assert.notEqual(lengths[0], lengths[1]);
  // Room for the shorter half only.
  const { calls, callRules } = roomy(Math.min(...lengths));
  const longer = lengths[0] > lengths[1] ? 0 : 1;
  const { sheet, failures } = await runBig(callRules);
  assert.equal(calls.length, 9, 'three whole parts and two halves each, no quarters');
  assert.deepEqual(failures.map(({ group, part, half, code }) => ({ group, part, half, code })),
    ['style', 'references', 'structure'].map(group => ({ group, part: 0, half: longer, code: 'model_output_limit' })));
  assert.ok(sheet.rules.length > 0 && sheet.rules.length < REQUIREMENTS.length, 'the half that fitted still gives its rules');
});

test('other failure codes are not split', async () => {
  const { calls, callRules } = roomy(BIG.length - 1, { code: 'upstream_timeout' });
  const { failures } = await runBig(callRules);
  assert.equal(calls.length, 3);
  assert.deepEqual(failures.map(failure => [failure.code, failure.half]), [['upstream_timeout', undefined], ['upstream_timeout', undefined], ['upstream_timeout', undefined]]);
});

test('only reads the parts and halves named, and nothing else', async () => {
  const first = await runBig(roomy(Math.min(...splitInTwo(BIG).map(half => half.length))).callRules);
  const failed = first.failures.filter(failure => failure.group === 'style');
  assert.equal(failed.length, 1);
  const { calls, callRules } = roomy(BIG.length);
  const { sheet, failures } = await runBig(callRules, { only: failed });
  assert.deepEqual(failures, []);
  assert.deepEqual(calls.map(call => call.group), ['style'], 'one call: the failed half alone');
  assert.equal(calls[0].text, splitInTwo(BIG)[failed[0].half]);
  assert.ok(sheet.rules.length > 0);
  // A whole-part failure in only reads the whole part.
  const again = roomy(BIG.length);
  await runBig(again.callRules, { only: [{ group: 'references', doc: 0, part: 0, code: 'upstream_timeout' }] });
  assert.deepEqual(again.calls.map(call => [call.group, call.text === BIG]), [['references', true]]);
});

// ---- After the reading, a focused question for the settings no reading filled ----

const SPELLING = RULES.style[0];
const FOOTNOTES = RULES.references[0];
const PLAIN = RULES.structure[0];
const FIGURES = { category: 'figures-tables', slot: 'figures.files', statement: 'Supply figures as separate files.', quote: 'with figures supplied as separate files', mode: 'flag', params: { separate: true } };

// A fake callSettings: answers with `answer(request, attempt)` and records every request.
function fakeSettings(answer = () => reply([])) {
  const calls = [];
  const callSettings = async request => {
    calls.push(request);
    return answer(request, calls.length);
  };
  return { calls, callSettings };
}

test('each part is asked once about the settings no reading filled, after the readings', async () => {
  const { calls, callRules } = fake();
  const settings = fakeSettings(() => reply([FIGURES]));
  const seen = [];
  const signal = new AbortController().signal;
  const { sheet, failures, asked } = await run(callRules, { callSettings: settings.callSettings, signal, onProgress: event => seen.push(event) });
  assert.equal(calls.length, 3, 'one reading per group');
  assert.equal(settings.calls.length, 1, 'one question for the one part');
  const [question] = settings.calls;
  const expected = slotsFor('article').filter(slot => !['spelling.variety', 'notes.kind'].includes(slot));
  assert.deepEqual(question, { model: 'glm-5.3', docType: 'article', slots: expected, text: G0, signal });
  assert.deepEqual(asked, { settings: expected, parts: 1, added: ['figures.files'] });
  assert.deepEqual(failures, []);
  assert.deepEqual(sheet.rules.map(rule => rule.slot), ['spelling.variety', 'notes.kind', 'figures.files', null]);
  assert.deepEqual(seen.at(-1), { done: 4, total: 4 });
});

test('a settings answer counts only as a setting it was asked for, with its slot and a verified quotation', async () => {
  const { callRules } = fake();
  const settings = fakeSettings(() => reply([
    FIGURES,
    { ...FIGURES, slot: null, statement: 'A plain rule.' },
    { ...SPELLING, params: { variety: 'uk' } },
    { ...FIGURES, slot: 'figures.callouts', params: { required: true }, quote: 'not in the guidelines at all' },
    { ...FIGURES, slot: 'figures.numbering', params: { per: 'sometimes' } },
    'not a rule',
  ]));
  const { sheet } = await run(callRules, { callSettings: settings.callSettings });
  assert.deepEqual(sheet.rules.map(rule => [rule.slot, rule.conflict ?? false]), [['spelling.variety', false], ['notes.kind', false], ['figures.files', false], [null, false]],
    'a setting not asked for, a plain rule, an unverified quotation and a setting with wrong params are not added');
  assert.equal(sheet.dropped, 0, 'what a settings answer could not confirm is not counted as left out');
});

test('two parts that state a setting differently make a conflict; no question is asked when nothing is missing', async () => {
  const { callRules } = fake(() => reply([]));
  const parts = splitGuidelines(LONG);
  assert.equal(parts.length, 2);
  const settings = fakeSettings((request, n) => reply(n === 1 ? [{ ...FOOTNOTES, quote: 'Sentence 1 states one more requirement' }] : [{ ...FOOTNOTES, params: { kind: 'endnotes' }, quote: 'Sentence 1150 states one more requirement' }]));
  const { sheet } = await extractRuleSheet({ docType: 'article', model: 'glm-5.3', guidelines: [LONG], callRules, callSettings: settings.callSettings });
  assert.equal(settings.calls.length, 2);
  assert.deepEqual(sheet.rules.map(rule => [rule.params.kind, rule.conflict]), [['footnotes', true], ['endnotes', true]]);
  const none = fakeSettings();
  const all = slotsFor('article');
  const result = await run(fake().callRules, { callSettings: none.callSettings, known: all });
  assert.equal(none.calls.length, 0);
  assert.deepEqual(result.asked, { settings: [], parts: 0, added: [] });
});

test('a failed settings question is a failure of the settings group, and a second try asks only that part again', async () => {
  const settings = fakeSettings(() => { throw coded('upstream_timeout', false); });
  const first = await run(fake().callRules, { callSettings: settings.callSettings });
  assert.deepEqual(first.failures, [{ group: SETTINGS_GROUP, doc: 0, part: 0, code: 'upstream_timeout', message: 'upstream_timeout' }]);
  assert.equal(first.sheet.rules.length, 3, 'the readings are kept');
  const again = fake();
  const second = fakeSettings(() => reply([FIGURES]));
  const { sheet, failures } = await run(again.callRules, { callSettings: second.callSettings, only: first.failures, known: ['spelling.variety', 'notes.kind'] });
  assert.equal(again.calls.length, 0, 'no part is read again');
  assert.equal(second.calls.length, 1);
  assert.ok(!second.calls[0].slots.includes('notes.kind'), 'settings the sheet has are not asked for');
  assert.deepEqual(failures, []);
  assert.deepEqual(sheet.rules.map(rule => rule.slot), ['figures.files']);
});

test('a rate-limit refusal is asked again after pauses that grow, or after its Retry-After; a spent allowance is not', async () => {
  const pauses = [];
  const wait = async ms => { pauses.push(ms); };
  const limited = fake((request, attempt) => {
    if (request.group === 'style' && attempt <= 2) throw { code: 'upstream_rate_limited', status: 429, retry: true };
    if (request.group === 'references' && attempt === 1) throw { code: 'upstream_rate_limited', status: 429, retry: true, retryAfter: 5 };
    if (request.group === 'structure') throw { code: 'quota_exceeded', status: 429, retry: false };
    return reply(RULES[request.group]);
  });
  const { sheet, failures } = await run(limited.callRules, { wait });
  assert.deepEqual(pauses.sort((a, b) => a - b), [2000, 4000, 5000]);
  assert.deepEqual(categories(sheet), ['spelling', 'notes']);
  assert.deepEqual(failures.map(failure => [failure.group, failure.code]), [['structure', 'quota_exceeded']]);
  assert.equal(limited.calls.filter(call => call.group === 'structure').length, 1);
  pauses.length = 0;
  const always = fake(() => { throw { code: 'upstream_rate_limited', status: 429, retry: true }; });
  const result = await run(always.callRules, { wait });
  assert.equal(always.calls.length, 12, 'each call asked once and three more times');
  assert.deepEqual(pauses.filter(ms => ms === 8000).length, 3);
  assert.deepEqual(result.failures.map(failure => failure.code), ['upstream_rate_limited', 'upstream_rate_limited', 'upstream_rate_limited']);
});

test('stopping during a pause after a rate-limit refusal ends the run', async () => {
  const controller = new AbortController();
  const limited = fake(() => { throw { code: 'upstream_rate_limited', status: 429, retry: true }; });
  const wait = (ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const running = run(limited.callRules, { wait, signal: controller.signal });
  await tick(5);
  controller.abort(new Error('stopped'));
  await assert.rejects(running, /stopped/);
});
