import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRuleSheet } from '../lib/rules/extract.js';
import { splitGuidelines } from '../lib/rules/chunk.js';
import { GROUPS, MAX_RULES, validateSheet } from '../lib/rules/schema.js';

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
    { group: 'references', doc: 0, part: 0, code: 'quota_exceeded' },
    { group: 'structure', doc: 0, part: 0, code: 'network_error' },
  ]);
  assert.deepEqual(categories(sheet), ['spelling']);

  const twice = fake(() => { throw coded('upstream_busy', true); });
  const second = await run(twice.callRules);
  assert.equal(twice.calls.length, 6, 'each group is tried twice, no more');
  assert.deepEqual(second.failures.map(failure => failure.code), ['upstream_busy', 'upstream_busy', 'upstream_busy']);
});

test('a failed group does not remove the other groups rules', async () => {
  const { callRules } = fake(request => {
    if (request.group === 'references') throw coded('model_output_limit', false);
    return reply(RULES[request.group]);
  });
  const { sheet, failures } = await run(callRules);
  assert.deepEqual(failures, [{ group: 'references', doc: 0, part: 0, code: 'model_output_limit' }]);
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

test('takes manual.named from the first reply that names one', async () => {
  // The structure reply settles first, but references comes first in (document, part, group) order.
  const named = { style: null, references: '  The Chicago Manual of Style, 17th edition ', structure: 'MLA Handbook' };
  const { callRules } = fake(async request => {
    await tick(request.group === 'structure' ? 0 : 20);
    return reply([], named[request.group]);
  });
  const { sheet } = await run(callRules);
  assert.equal(sheet.manual.named, 'The Chicago Manual of Style, 17th edition');

  const long = fake(request => reply([], request.group === 'style' ? 'x'.repeat(200) : null));
  assert.equal((await run(long.callRules)).sheet.manual.named, 'x'.repeat(120));
  const none = fake(request => ({ content: JSON.stringify({ rules: [], manual: request.group === 'style' ? { named: '   ' } : null }) }));
  const sheet2 = (await run(none.callRules)).sheet;
  assert.equal(sheet2.manual.named, null);
  assert.equal(validateSheet(sheet2).ok, true);
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
