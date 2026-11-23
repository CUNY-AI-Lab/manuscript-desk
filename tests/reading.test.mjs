import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_CHARS, NOTE_SIGN, PAIRED, READING_KINDS, halveUnit, parseReadingReply, readChapters, readingFindings, readingUnits } from '../lib/checks/reading.js';
import { readingPayload, readingPrompt } from '../server/prompts.js';
import { createHandler } from '../server/worker.js';
import { commentsFor, todosDocument } from '../lib/todos/todos.js';
import { KIND_LABELS } from '../lib/todos/shared.js';
import { ORIGIN, env, signed } from './helpers.mjs';

// An invented chapter: a title block, an abstract and keywords, headings and running text.
const para = (index, text) => ({ index, kind: 'paragraph', text, hints: { empty: text === '' } });
const PARAGRAPHS = [
  para(0, 'Front matter line'),
  para(1, 'Bridges of Salt: Three Ports of the Western Sea'),
  para(2, 'Ada Lindqvist'),
  para(3, '(University of Tamsk)'),
  para(4, 'Abstract: This chapter follows four ports of the western sea and their bridges.Their trade is read against the tides.'),
  para(5, 'Keywords: trade; ports; bridges;  Lindqvist'),
  para(6, 'The First Port'),
  para(7, 'The first port, Varn, traded in salt. Its bridges are made of stone.'),
  para(8, ''),
  para(9, 'A long paragraph of running text. '.repeat(300)),
  para(10, 'Running text the unit leaves out once its budget is spent.'),
  para(11, 'The Second Port'),
  para(12, 'Bibliography entry that is never sent.'),
];
const ROLES = { 1: 'title-block', 2: 'title-block', 3: 'title-block', 4: 'abstract', 5: 'keywords', 6: 'heading-1', 7: 'body', 9: 'body', 10: 'body', 11: 'heading-1', 12: 'bibliography-entry' };
const CHAPTERS = [{ first: 1, last: 12 }];
const SHEET = { rules: [
  { id: 'abstract-keywords-1', category: 'abstract-keywords', slot: null, statement: 'The abstract must not cite other works.', enabled: true, source: { kind: 'guidelines', quote: 'Abstracts must not cite other works.', doc: 0 } },
  { id: 'notes-1', category: 'notes', slot: null, statement: 'Use footnotes.', enabled: true, source: { kind: 'guidelines', quote: 'Use footnotes, never endnotes.', doc: 0 } },
] };
const [UNIT] = readingUnits({ paragraphs: PARAGRAPHS, roles: ROLES, chapters: CHAPTERS, sheet: SHEET });
const reply = findings => JSON.stringify({ findings });

test('a unit shows the title block, abstract, keywords and headings whole, and running text up to a budget', () => {
  assert.equal(UNIT.chapter, 0);
  assert.equal(UNIT.first, 1);
  assert.deepEqual([...UNIT.shown.keys()], [1, 2, 3, 4, 5, 6, 7, 9, 11]);
  assert.ok(UNIT.text.includes('[4] (abstract) Abstract: This chapter follows four ports'));
  assert.ok(UNIT.text.includes('[6] (heading) The First Port'));
  assert.ok(UNIT.text.includes('(the rest of the running text is left out)'));
  assert.ok(!UNIT.text.includes('never sent') && !UNIT.text.includes('Front matter line'), 'nothing outside the chapter, no bibliography');
  assert.ok(UNIT.text.includes('R1. The abstract must not cite other works.') && !UNIT.text.includes('footnotes'), 'only the rules about the title block, abstract and keywords');
  assert.deepEqual(UNIT.rules, ['abstract-keywords-1']);
  assert.equal(BODY_CHARS, 8000);
  assert.deepEqual(readingUnits({ paragraphs: PARAGRAPHS, roles: {}, chapters: [], sheet: null }), [], 'no chapter, no call');
});

test('a finding is kept only with a known kind, a paragraph it was shown and words that occur in it', () => {
  const result = parseReadingReply(reply([
    { kind: 'missing-spaces', paragraph: 4, quote: 'their bridges.Their trade', note: 'A space is missing after the full stop.' },
    { kind: 'missing-spaces', paragraph: 4, quote: 'their bridges. Their trade', note: 'Corrected quotation: not in the text.' },
    { kind: 'typo', paragraph: 12, quote: 'Bibliography entry that', note: 'Not shown to the model.' },
    { kind: 'typo', paragraph: 99, quote: 'their bridges.Their trade', note: 'No such paragraph.' },
    { kind: 'style', paragraph: 4, quote: 'their bridges.Their trade', note: 'Not a kind it may report.' },
    { kind: 'typo', paragraph: 4, quote: 'four', note: 'Too short to verify.' },
    { kind: 'missing-spaces', paragraph: 4, quote: 'their bridges.Their trade', note: 'The same again.' },
    'not a finding',
  ]), UNIT);
  assert.deepEqual(result.findings, [{ kind: 'missing-spaces', paragraph: 4, quote: 'their bridges.Their trade', note: 'A space is missing after the full stop.', rule: null }]);
  assert.equal(result.dropped, 7);
  assert.equal(parseReadingReply('not json', UNIT), null);
  assert.equal(parseReadingReply('{"items":[]}', UNIT), null);
  assert.deepEqual(parseReadingReply('```json\n{"findings":[]}\n```', UNIT), { findings: [], dropped: 0 });
});

test('the model sees where note references stand, and words run together at a note are not missing a space', () => {
  const noted = [para(1, 'A Title Long Enough To Read'), { ...para(2, 'The port traded alone.Later it grew.'), notes: [22] }];
  const [unit] = readingUnits({ paragraphs: noted, roles: { 1: 'title-block', 2: 'body' }, chapters: [{ first: 1, last: 2 }] });
  assert.ok(unit.text.includes(`[2] (text) The port traded alone.${NOTE_SIGN}Later it grew.`));
  const result = parseReadingReply(reply([
    { kind: 'missing-spaces', paragraph: 2, quote: `traded alone.${NOTE_SIGN}Later it`, note: 'Run together.' },
    { kind: 'typo', paragraph: 2, quote: `The port traded alone.${NOTE_SIGN}`, note: 'The sign is taken out before the check.' },
  ]), unit);
  assert.deepEqual(result.findings.map(finding => [finding.kind, finding.quote]), [['typo', 'The port traded alone.']]);
  assert.equal(result.dropped, 1);
});

test('a finding that compares two places must quote both, and they must differ', () => {
  const result = parseReadingReply(reply([
    { kind: 'wording-inconsistent', paragraph: 4, quote: 'follows four ports of the western sea', other: { paragraph: 1, quote: 'Three Ports of the Western Sea' }, note: 'The abstract says four ports, the title three.' },
    { kind: 'wording-inconsistent', paragraph: 4, quote: 'follows four ports of the western sea', note: 'No other place.' },
    { kind: 'affiliation-inconsistent', paragraph: 3, quote: '(University of Tamsk)', other: { paragraph: 2, quote: 'University of Elsewhere' }, note: 'The other place is not in the text.' },
    { kind: 'wording-inconsistent', paragraph: 7, quote: 'Its bridges are made of stone', other: { paragraph: 7, quote: 'Its bridges are made of stone' }, note: 'The same words twice.' },
  ]), UNIT);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].other, { paragraph: 1, quote: 'Three Ports of the Western Sea' });
  assert.equal(result.dropped, 3);
  assert.deepEqual([...PAIRED].sort(), ['affiliation-inconsistent', 'wording-inconsistent']);
});

test('a finding against an abstract rule names the rule only when the rule was listed', () => {
  const result = parseReadingReply(reply([
    { kind: 'abstract-against-rules', paragraph: 4, quote: 'This chapter follows four ports', rule: 'R1', note: 'Check the rule.' },
    { kind: 'abstract-against-rules', paragraph: 5, quote: 'trade; ports; bridges', rule: 'R7', note: 'No such rule.' },
  ]), UNIT);
  assert.deepEqual(result.findings.map(finding => finding.rule), ['abstract-keywords-1', null]);
});

test('readChapters reads every unit, retries an unreadable reply once, waits out a rate limit and records what still fails', async () => {
  const units = readingUnits({ paragraphs: PARAGRAPHS, roles: ROLES, chapters: [{ first: 1, last: 5 }, { first: 6, last: 12 }], sheet: null });
  assert.equal(units.length, 2);
  const asked = [];
  const pauses = [];
  const call = async request => {
    asked.push(request);
    const first = request.unit.includes('[1]');
    if (first && asked.filter(entry => entry.unit === request.unit).length === 1) return 'not json';
    if (first) return reply([{ kind: 'missing-spaces', paragraph: 4, quote: 'their bridges.Their trade', note: 'Space.' }, { kind: 'typo', paragraph: 7, quote: 'made of stone here', note: 'Not shown in this unit.' }]);
    throw { code: 'upstream_rate_limited', status: 429, retry: true };
  };
  const progress = [];
  const result = await readChapters({ units, model: 'm', call, wait: async ms => { pauses.push(ms); }, onProgress: event => progress.push(event) });
  assert.deepEqual(asked[0], { model: 'm', unit: units[0].text, signal: undefined });
  assert.equal(asked.filter(entry => entry.unit === units[1].text).length, 4, 'once, then three times after a pause');
  assert.deepEqual(pauses, [2000, 4000, 8000]);
  assert.deepEqual(result.failures, [{ chapter: 1, code: 'upstream_rate_limited' }]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].chapter, 0);
  assert.equal(result.dropped, 1);
  assert.deepEqual(progress.at(-1), { done: 2, total: 2 });
});

test('a unit whose reply runs out of room is read as two halves, each with the chapter\'s opening', async () => {
  const many = [para(1, 'A Title Long Enough To Read'), para(2, 'Abstract: a summary of the chapter.'), ...[3, 4, 5, 6].map(index => para(index, `Running paragraph number ${index} of the chapter.`))];
  const roles = { 1: 'title-block', 2: 'abstract', 3: 'body', 4: 'body', 5: 'body', 6: 'body' };
  const [unit] = readingUnits({ paragraphs: many, roles, chapters: [{ first: 1, last: 6 }] });
  const [first, second] = halveUnit(unit);
  assert.deepEqual([...first.shown.keys()], [1, 2, 3, 4]);
  assert.deepEqual([...second.shown.keys()], [1, 2, 5, 6]);
  assert.ok(first.text.endsWith('(the rest of the running text is left out)'));
  assert.equal(halveUnit(readingUnits({ paragraphs: many.slice(0, 3), roles, chapters: [{ first: 1, last: 3 }] })[0]), null);
  const asked = [];
  const call = async ({ unit: text }) => {
    asked.push(text);
    if (text === unit.text) throw { code: 'model_output_limit', retry: false };
    const index = text.includes('[3]') ? 3 : 5;
    return reply([{ kind: 'typo', paragraph: index, quote: `Running paragraph number ${index}`, note: 'Check.' }, { kind: 'typo', paragraph: 1, quote: 'A Title Long Enough', note: 'In both halves.' }]);
  };
  const result = await readChapters({ units: [unit], model: 'm', call });
  assert.deepEqual(asked, [unit.text, first.text, second.text], 'the whole once, then each half once');
  assert.deepEqual(result.findings.map(finding => finding.paragraph).sort(), [1, 3, 5], 'a finding both halves give is kept once');
  assert.deepEqual(result.failures, []);
});

test('stopping ends the reading run', async () => {
  const controller = new AbortController();
  const running = readChapters({ units: [UNIT], model: 'm', signal: controller.signal, call: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  controller.abort(new Error('stopped'));
  await assert.rejects(running, /stopped/);
});

test('findings become comments and To-dos marked as a model\'s proposal, quoting both places, and change no text', () => {
  const found = parseReadingReply(reply([
    { kind: 'wording-inconsistent', paragraph: 4, quote: 'follows four ports of the western sea', other: { paragraph: 1, quote: 'Three Ports of the Western Sea' }, note: 'The abstract says four ports, the title three.' },
  ]), UNIT).findings.map(finding => ({ ...finding, chapter: 0 }));
  const findings = readingFindings(found);
  assert.deepEqual(findings.map(({ message, ...rest }) => rest), [{ kind: 'wording-inconsistent', chapter: 0, paragraphIndex: 4, ruleId: null, check: 'reading' }]);
  assert.match(findings[0].message, /^Query from a model's reading of the text, for you to check: The abstract says four ports, the title three\.\nHere: “follows four ports of the western sea”\nElsewhere: “Three Ports of the Western Sea”$/);
  const comments = commentsFor(findings, SHEET);
  assert.deepEqual(comments.map(comment => comment.sourceIndex), [4]);
  const report = { chapters: [{ first: 1, last: 12, titleBlock: [1, 2, 3], parts: ['title', 'author', 'affiliation'], number: 1 }], styles: {}, declared: [], settings: {} };
  const todos = todosDocument({ findings, checks: [], sheet: SHEET, report, paragraphs: PARAGRAPHS });
  assert.equal(todos.counts.items, 1);
  for (const kind of Object.keys(READING_KINDS)) assert.ok(KIND_LABELS[kind], `a plain label for ${kind}`);
});

test('the reading prompt lists the kinds and asks for quotations; the payload keeps thinking on, at temperature 0', () => {
  const prompt = readingPrompt();
  for (const kind of Object.keys(READING_KINDS)) assert.ok(prompt.includes(`"${kind}"`));
  assert.match(prompt, /an empty list is a correct answer/);
  assert.match(prompt, /copied exactly as they stand/);
  const payload = readingPayload({ model: 'm', unit: UNIT.text, row: { capabilities: ['reasoning'], provider: 'workers-ai', context_length: 100000 } });
  assert.equal(payload.temperature, 0);
  assert.deepEqual(payload.messages[1], { role: 'user', content: UNIT.text });
  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: true });
});

test('POST /api/reading sends the unit with the reading prompt, and refuses an empty or oversized unit without echoing it', async () => {
  const sent = [];
  const handle = createHandler({ gatewayFetch: async (url, init) => {
    if (new URL(url).pathname === '/v1/catalog') return Response.json({ object: 'list', data: [] });
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"findings":[]}' }, finish_reason: 'stop' }] });
  } });
  const request = body => signed('/api/reading', { headers: { origin: ORIGIN, 'content-type': 'application/json' } }, { method: 'POST', body: JSON.stringify(body) });
  const ok = await handle(await request({ model: 'glm-5.3', unit: UNIT.text }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).content, '{"findings":[]}');
  assert.deepEqual(sent[0].messages, [{ role: 'system', content: readingPrompt() }, { role: 'user', content: UNIT.text }]);
  for (const unit of ['', '   ', 'x'.repeat(40001), 42]) {
    const refused = await handle(await request({ model: 'glm-5.3', unit }), env);
    assert.equal(refused.status, 400);
    assert.ok(!JSON.stringify(await refused.json()).includes('xxxx'));
  }
  assert.equal(sent.length, 1);
});
