import test from 'node:test';
import assert from 'node:assert/strict';
import { MATTER, ROLES, ROLE_IDS, STRUCTURAL, isRole } from '../lib/roles/roles.js';
import { buildPassages, describeParagraph } from '../lib/roles/passages.js';
import { parseRolesReply, reconcile } from '../lib/roles/reply.js';
import { labelRoles } from '../lib/roles/label.js';

// Paragraph models written for these tests, in the reader's shape.
const HINTS = { align: null, indentLeft: 0, indentRight: 0, indentFirst: 0, styleId: null, bold: false, italic: false, size: null, list: false, pageBreak: false, image: false, footnote: false, empty: false };
const p = (index, text, hints = {}, kind = 'paragraph') => ({ index, kind, text, hints: { ...HINTS, empty: text.trim() === '' && !hints.image, ...hints } });
const manuscript = count => Array.from({ length: count }, (_, index) => (index % 5 === 4 ? p(index, '') : p(index, `Sentence number ${index} of an invented chapter.`)));
const coded = (code, retry) => Object.assign(new Error(code), { code, retry });
const asked = passage => [...passage.matchAll(/^\[(\d+)\]/gm)].map(match => Number(match[1]));
// The indices a passage asks for: the lines between "Label these:" and the next blank line.
const labelLines = passage => asked(passage.split('Label these:')[1].split('\n\n')[0]);
const answerAll = (passage, role = 'body') => ({ content: JSON.stringify({ roles: Object.fromEntries(labelLines(passage).map(index => [index, role])) }) });

test('nineteen roles, each with a one-line definition; structural roles leave out body and bibliography entries', () => {
  assert.deepEqual(ROLE_IDS, ['title-block', 'epigraph', 'abstract', 'keywords', 'heading-1', 'heading-2', 'bibliography-heading', 'bibliography-entry', 'block-quotation', 'verse', 'figure', 'list-item', 'table', 'body',
    'title-page', 'front-matter-heading', 'contents-entry', 'contributor-note', 'part-title']);
  for (const role of ROLES) {
    assert.ok(role.definition.length > 10 && !role.definition.includes('\n'), role.id);
  }
  assert.equal(STRUCTURAL.size, 17);
  // The front and back matter's roles are structural and belong to no chapter.
  assert.deepEqual([...MATTER], ['title-page', 'front-matter-heading', 'contents-entry', 'contributor-note', 'part-title']);
  assert.ok([...MATTER].every(role => STRUCTURAL.has(role)));
  assert.equal(STRUCTURAL.has('body') || STRUCTURAL.has('bibliography-entry'), false);
  assert.equal(isRole('verse'), true);
  assert.equal(isRole('poem'), false);
});

test('describeParagraph shows index, formatting and text on one line', () => {
  const line = describeParagraph(p(7, 'First line\nsecond line\tafter tab', { align: 'center', indentLeft: 36, indentFirst: -18, size: 11, italic: true, footnote: true }));
  assert.equal(line, '[7] (centred; left indent 36pt; hanging indent 18pt; 11pt; all italic; note reference; 32 characters) First line ⏎ second line ⇥ after tab');
  assert.equal(describeParagraph(p(3, 'Plain.')), '[3] (6 characters) Plain.');
  assert.equal(describeParagraph(p(4, 'cells', {}, 'table')), '[4] (table; 5 characters) cells');
  assert.equal(describeParagraph(p(5, '', { image: true })), '[5] (image; 0 characters)');
});

test('describeParagraph shortens a long paragraph in the middle and states its full length', () => {
  const text = `${'a'.repeat(500)}${'m'.repeat(1000)}${'z'.repeat(500)}`;
  const line = describeParagraph(p(9, text, { indentFirst: 36 }));
  assert.match(line, /^\[9\] \(first-line indent 36pt; 2,000 characters, middle cut\) a{360} \[…\] z{200}$/);
  assert.equal(line.includes('mm'), false);
});

test('buildPassages asks for every non-empty paragraph once, in order, within the size limits', () => {
  const paragraphs = manuscript(400);
  const passages = buildPassages(paragraphs, { maxParagraphs: 50, overlapShare: 0 });
  const all = passages.flatMap(passage => passage.asked);
  assert.deepEqual(all, paragraphs.filter(entry => entry.text).map(entry => entry.index));
  assert.ok(passages.every(passage => passage.asked.length <= 50));
  for (const passage of passages) assert.deepEqual(labelLines(passage.text), passage.asked);
  const small = buildPassages(paragraphs, { size: 400, overlapShare: 0 });
  assert.ok(small.length > 20);
  const askedLength = passage => passage.text.split('Label these:\n')[1].split('\n\n')[0].split('\n').filter(line => line.startsWith('[')).join('\n').length;
  assert.ok(small.every(passage => askedLength(passage) <= 400 || passage.asked.length === 1));
});

test('a passage shows context before and after that it does not ask for, and folds empty paragraphs', () => {
  const paragraphs = manuscript(60);
  const [, second] = buildPassages(paragraphs, { maxParagraphs: 20, before: 3, after: 2, overlapShare: 0 });
  const [before, rest] = second.text.split('Label these:');
  assert.match(second.text, /^Paragraphs 25 to 48 of the 60 in the manuscript\./);
  assert.match(buildPassages(paragraphs.slice(10, 30), { total: 500 })[0].text, /^Paragraphs 10 to 28 of the 500 in the manuscript\./);
  assert.match(before, /Context before \(do not label\):\n\[21\][^\n]*\n\[22\][^\n]*\n\[23\][^\n]*\n\(empty paragraph\)\n\n$/);
  assert.deepEqual(asked(rest.split('Context after')[1]), [50, 51]);
  assert.equal(second.asked.includes(24), false, 'an empty paragraph is never asked');
  // The first passage has no context before, the last none after.
  const passages = buildPassages(paragraphs, { maxParagraphs: 20, overlapShare: 0 });
  assert.equal(passages[0].text.includes('Context before'), false);
  assert.equal(passages.at(-1).text.includes('Context after'), false);
});

test('buildPassages can overlap passages and rejects bad options', () => {
  const passages = buildPassages(manuscript(100), { maxParagraphs: 20, overlap: 4, overlapShare: 0 });
  assert.deepEqual(passages[1].asked.slice(0, 4), passages[0].asked.slice(-4));
  assert.throws(() => buildPassages(manuscript(10), { maxParagraphs: 5, overlap: 5 }), RangeError);
  assert.throws(() => buildPassages(manuscript(10), { maxParagraphs: 0 }), RangeError);
  assert.throws(() => buildPassages(manuscript(10), { overlapShare: 1 }), RangeError);
  assert.deepEqual(buildPassages([p(0, ''), p(1, ' ')]), []);
});

test('by default each passage starts halfway through the previous one, so a paragraph is read twice', () => {
  const passages = buildPassages(manuscript(200), { maxParagraphs: 20 });
  assert.deepEqual(passages[1].asked.slice(0, 10), passages[0].asked.slice(10));
  const reads = new Map();
  for (const index of passages.flatMap(passage => passage.asked)) reads.set(index, (reads.get(index) ?? 0) + 1);
  assert.ok([...reads.values()].every(count => count <= 2));
  assert.equal([...reads.values()].filter(count => count === 1).length, 20, 'only the first and last half-passages are read once');
});

test('parseRolesReply keeps known roles for asked indices only', () => {
  const reply = JSON.stringify({ roles: { 1: 'body', 2: 'Heading 1', 3: 'poem', 9: 'verse', x: 'body', 4: 7 } });
  const { labels, missing } = parseRolesReply(reply, [1, 2, 3, 4, 5]);
  assert.deepEqual([...labels], [[1, 'body'], [2, 'heading-1']]);
  assert.deepEqual(missing, [3, 4, 5]);
  const list = parseRolesReply('```json\n{"roles":[{"index":5,"role":"verse"},{"index":5,"role":"body"},{"i":6,"role":"list_item"}]}\n```', [5, 6]);
  assert.deepEqual([...list.labels], [[5, 'verse'], [6, 'list-item']]);
  for (const bad of ['not json', '{"labels":{}}', '[1,2]', null, 42, '{"roles":"body"}']) assert.equal(parseRolesReply(bad, [1]), null, String(bad));
});

test('reconcile prefers the passage in which the paragraph lies furthest from an edge', () => {
  const roles = reconcile([
    { asked: [1, 2, 3, 4, 5], labels: new Map([[1, 'body'], [2, 'body'], [3, 'body'], [4, 'verse'], [5, 'verse']]) },
    { asked: [4, 5, 6, 7, 8], labels: new Map([[4, 'body'], [5, 'body'], [6, 'body'], [7, 'body'], [8, 'body']]) },
    { asked: [9], labels: undefined },
  ]);
  // 4 is one from the edge in the first passage and at the edge of the second; 5 is at the first's edge.
  assert.deepEqual([...roles].sort((a, b) => a[0] - b[0]), [[1, 'body'], [2, 'body'], [3, 'body'], [4, 'verse'], [5, 'body'], [6, 'body'], [7, 'body'], [8, 'body']]);
});

test('labelRoles labels every non-empty paragraph and none of the empty ones', async () => {
  const paragraphs = manuscript(300);
  const calls = [];
  const progress = [];
  const signal = new AbortController().signal;
  const { roles, failures } = await labelRoles({
    paragraphs, model: 'm-1', signal, passageOptions: { maxParagraphs: 40 },
    callRoles: async request => { calls.push(request); return answerAll(request.passage); },
    onProgress: event => { progress.push(event); throw new Error('a display error is ignored'); },
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(Object.keys(roles).map(Number), paragraphs.filter(entry => entry.text).map(entry => entry.index));
  assert.ok(Object.values(roles).every(role => role === 'body'));
  assert.ok(calls.every(call => call.model === 'm-1' && call.signal === signal && typeof call.passage === 'string'));
  assert.equal(progress.length, calls.length);
  assert.deepEqual(progress.at(-1), { done: calls.length, total: calls.length });
});

test('labelRoles retries once after an unreadable reply, and after a rate-limit refusal three times with longer pauses, then records the failure', async () => {
  const paragraphs = manuscript(100);
  const attempts = new Map();
  const pauses = [];
  const { roles, failures } = await labelRoles({
    paragraphs, model: 'm', passageOptions: { maxParagraphs: 20, overlapShare: 0 },
    wait: async ms => { pauses.push(ms); },
    async callRoles({ passage }) {
      const first = labelLines(passage)[0];
      const attempt = (attempts.get(first) ?? 0) + 1;
      attempts.set(first, attempt);
      if (first === 0) return attempt === 1 ? { content: 'not json' } : answerAll(passage, 'title-block');
      if (first === 25) throw coded('rate_limited', true);
      if (first === 50) throw coded('model_output_limit', false);
      if (first === 75) return { content: JSON.stringify({ roles: { 75: 'body' } }) };
      return answerAll(passage);
    },
  });
  assert.equal(attempts.get(0), 2);
  assert.equal(attempts.get(25), 8, 'four times in the first pass, four in the second');
  assert.deepEqual(pauses, [2000, 4000, 8000, 2000, 4000, 8000]);
  assert.equal(attempts.get(50), 2, 'once whole and once as the first half, never retried without the retry mark, not asked in the second pass');
  assert.equal(attempts.get(76), 1, 'the paragraphs a reply left out are asked again on their own');
  assert.equal(roles[0], 'title-block');
  assert.equal(roles[80], 'body');
  assert.deepEqual(failures.map(failure => [failure.passage, failure.code, failure.unlabelled.length]), [[1, 'rate_limited', 20], [2, 'model_output_limit', 10]], 'the second half of passage 2 was labelled');
  assert.equal(failures[0].message, 'rate_limited');
  assert.equal(roles[25], undefined);
});

test('the second pass fills only gaps, and a reply that still leaves some out is reported', async () => {
  const paragraphs = manuscript(30);
  const passages = [];
  const { roles, failures } = await labelRoles({
    paragraphs, model: 'm', onProgress: event => passages.push(event),
    async callRoles({ passage }) {
      const indices = labelLines(passage);
      // The first reply leaves out 3 and 7; the second labels 3 only.
      if (indices.length > 2) return { content: JSON.stringify({ roles: Object.fromEntries(indices.filter(index => index !== 3 && index !== 7).map(index => [index, 'body'])) }) };
      return { content: JSON.stringify({ roles: { 3: 'verse', 8: 'verse' } }) };
    },
  });
  assert.equal(roles[3], 'verse');
  assert.equal(roles[8], 'body', 'an answer for a paragraph that was not asked again is ignored');
  assert.equal(roles[7], undefined);
  assert.deepEqual(failures, [{ passage: 0, code: 'incomplete_reply', unlabelled: [7] }]);
  assert.deepEqual(passages.at(-1), { done: 3, total: 3 }, 'the total grows by the second pass');
});

test('buildPassages with only asks just those paragraphs, each run in its own passage, with context', () => {
  const passages = buildPassages(manuscript(40), { only: new Set([2, 5, 6, 30]), before: 2, after: 1, overlapShare: 0 });
  assert.deepEqual(passages.map(passage => passage.asked), [[2], [5, 6], [30]]);
  assert.match(passages[1].text, /Context before \(do not label\):\n\[2\][^\n]*\n\[3\][^\n]*\n\(empty paragraph\)\n\nLabel these:\n\[5\][^\n]*\n\[6\][^\n]*\n\nContext after \(do not label\):\n\[7\]/);
});

test('labelRoles never has more than three calls in flight, and stops on abort', async () => {
  let inFlight = 0;
  let most = 0;
  const controller = new AbortController();
  let calls = 0;
  const run = labelRoles({
    paragraphs: manuscript(400), model: 'm', signal: controller.signal, passageOptions: { maxParagraphs: 10 },
    async callRoles({ passage }) {
      calls += 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      if (calls === 6) controller.abort(new Error('stopped by the author'));
      return answerAll(passage);
    },
  });
  await assert.rejects(run, /stopped by the author/);
  assert.equal(most, 3);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(calls <= 9, 'no new call starts after the abort');
});

test('labelRoles checks its arguments', async () => {
  await assert.rejects(labelRoles({ model: 'm', callRoles: async () => ({}) }), /paragraph list/);
  await assert.rejects(labelRoles({ paragraphs: [], model: 'm' }), /callRoles/);
  assert.deepEqual(await labelRoles({ paragraphs: [], model: 'm', callRoles: async () => assert.fail('no call') }), { roles: {}, failures: [] });
});

test('a passage that runs out of output room is asked as two halves; a half that fails again is reported once', async () => {
  const paragraphs = manuscript(100);
  const sizes = [];
  // Room for at most 12 paragraphs to label.
  const callRoles = limit => async ({ passage }) => {
    const indices = labelLines(passage);
    sizes.push(indices.length);
    if (indices.length > limit) throw coded('model_output_limit', false);
    return answerAll(passage);
  };
  const options = { paragraphs, model: 'm', passageOptions: { maxParagraphs: 20, overlapShare: 0 } };
  const progress = [];
  const whole = await labelRoles({ ...options, callRoles: callRoles(12), onProgress: event => progress.push(event) });
  assert.deepEqual(whole.failures, []);
  assert.equal(Object.keys(whole.roles).length, 80, 'every paragraph with text is labelled');
  // Four passages of 20, each failing whole and then read as two halves of 10: 12 calls.
  const tally = list => [...list].sort((a, b) => a - b).join(',');
  assert.equal(tally(sizes), '10,10,10,10,10,10,10,10,20,20,20,20');
  assert.deepEqual(progress.at(-1), { done: 12, total: 12 });

  sizes.length = 0;
  // Room for 9: every half of 10 fails again; each passage is reported once, and nothing is split further or asked again.
  const tight = await labelRoles({ ...options, callRoles: callRoles(9) });
  assert.equal(tally(sizes), '10,10,10,10,10,10,10,10,20,20,20,20');
  assert.deepEqual(tight.failures.map(failure => [failure.passage, failure.code, failure.unlabelled.length]),
    [[0, 'model_output_limit', 20], [1, 'model_output_limit', 20], [2, 'model_output_limit', 20], [3, 'model_output_limit', 20]]);

  sizes.length = 0;
  // Another failure code is not split.
  const other = await labelRoles({ ...options, callRoles: async ({ passage }) => { sizes.push(labelLines(passage).length); throw coded('upstream_timeout', false); } });
  assert.deepEqual(sizes.slice(0, 4), [20, 20, 20, 20]);
  assert.ok(other.failures.every(failure => failure.code === 'upstream_timeout'));
});
