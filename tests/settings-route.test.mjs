import test from 'node:test';
import assert from 'node:assert/strict';
import { cailErrorEnvelope, cailErrorResponse } from '@cuny-ai-lab/cail-client/testing';
import { createHandler } from '../server/worker.js';
import { settingsPayload, settingsPrompt } from '../server/prompts.js';
import { SLOTS, SLOT_USES, slotsFor } from '../lib/rules/schema.js';
import { ORIGIN, env, signed } from './helpers.mjs';

// Guideline text written for these tests.
const GUIDELINES = 'Abstracts should not exceed 150 words. Give between four and six keywords.';
const ok = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const REPLY = '{"rules":[]}';

function gateway({ reply = ok(REPLY), sent = [] } = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/catalog') return Response.json({ object: 'list', data: [] });
    assert.equal(path, '/v1/chat/completions');
    sent.push(JSON.parse(init.body));
    return typeof reply === 'function' ? reply() : Response.json(reply);
  };
}
const settingsRequest = body => signed('/api/settings', { headers: { origin: ORIGIN, 'content-type': 'application/json' } }, { method: 'POST', body: JSON.stringify(body) });
const body = (overrides = {}) => ({ model: 'glm-5.3', docType: 'article', slots: ['abstract.words', 'keywords.count'], text: GUIDELINES, ...overrides });

test('the settings prompt lists only the settings asked for, each with its params and use', () => {
  const prompt = settingsPrompt({ docType: 'article', slots: ['abstract.words', 'keywords.count'] });
  assert.match(prompt, /"abstract\.words" in category "abstract-keywords": params "max" \(whole number 1 or more\)/);
  assert.ok(prompt.includes(SLOT_USES['keywords.count']));
  assert.ok(!prompt.includes('"notes.kind"'), 'a setting not asked for is not listed');
  assert.match(prompt, /an empty list is a correct answer/);
  assert.throws(() => settingsPrompt({ docType: 'article', slots: [] }), /settings/);
  assert.throws(() => settingsPrompt({ docType: 'article', slots: ['chapters.subtitle'] }), /settings/, 'a book setting is not offered for an article');
  assert.throws(() => settingsPrompt({ docType: 'essay', slots: ['abstract.words'] }), /document type/);
  // Every offered slot can be asked for.
  for (const docType of ['article', 'monograph', 'edited-collection']) assert.doesNotThrow(() => settingsPrompt({ docType, slots: slotsFor(docType) }));
  assert.ok(slotsFor('monograph').every(id => Object.hasOwn(SLOTS, id)));
});

test('POST /api/settings sends the settings prompt and the text, and returns the content', async () => {
  const sent = [];
  const handle = createHandler({ model: 'glm-5.3', gatewayFetch: gateway({ sent }) });
  const response = await handle(await settingsRequest(body()), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, REPLY);
  assert.equal(sent.length, 1);
  const expected = settingsPayload({ model: 'glm-5.3', docType: 'article', slots: ['abstract.words', 'keywords.count'], text: GUIDELINES });
  assert.deepEqual(sent[0].messages, expected.messages);
  assert.equal(sent[0].temperature, 0);
  assert.deepEqual(sent[0].response_format, { type: 'json_object' });
});

test('POST /api/settings refuses unknown, repeated, unoffered or missing settings and bad text', async () => {
  const sent = [];
  const handle = createHandler({ model: 'glm-5.3', gatewayFetch: gateway({ sent }) });
  for (const bad of [
    body({ slots: [] }), body({ slots: 'abstract.words' }), body({ slots: ['no.such'] }), body({ slots: ['abstract.words', 'abstract.words'] }),
    body({ slots: ['chapters.subtitle'] }), body({ docType: 'essay' }), body({ text: '' }), body({ text: 'x'.repeat(60001) }),
  ]) {
    const response = await handle(await settingsRequest(bad), env);
    assert.equal(response.status, 400, JSON.stringify(bad).slice(0, 80));
    const { error } = await response.json();
    assert.ok(!JSON.stringify(error).includes(GUIDELINES), 'the text is never echoed');
  }
  assert.equal(sent.length, 0);
});

test('POST /api/settings sends the sentences no reading quoted before the text, with or without settings to ask', async () => {
  const sent = [];
  const handle = createHandler({ model: 'glm-5.3', gatewayFetch: gateway({ sent }) });
  const unreported = ['Authors should send a signed form with the manuscript.', 'Please number every page.'];
  for (const slots of [['abstract.words'], []]) {
    const response = await handle(await settingsRequest(body({ slots, unreported })), env);
    assert.equal(response.status, 200);
  }
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].messages, settingsPayload({ model: 'glm-5.3', docType: 'article', slots: ['abstract.words'], text: GUIDELINES, unreported }).messages);
  assert.match(sent[0].messages[1].content, /^Sentences from which the first reading reported no requirement:\n\[1\] Authors should send a signed form with the manuscript\.\n\[2\] Please number every page\.\n\nThe guidelines:\n/);
  assert.match(sent[0].messages[0].content, /Settings:/);
  assert.match(sent[1].messages[0].content, /give a verdict on every one of them, in "sentences"/);
  assert.doesNotMatch(sent[1].messages[0].content, /Settings:/);
  // Without sentences the prompt is the settings question alone, as before.
  assert.doesNotMatch(settingsPrompt({ docType: 'article', slots: ['abstract.words'] }), /verdict/);
});

test('a list item asked about is shown with the lead-in that introduces its list', () => {
  const text = 'Each chapter you send should include:\n\n• Chapter abstract\n• Figure captions and credits\n\nAuthors must sign the form.';
  const message = settingsPayload({ model: 'glm-5.3', docType: 'article', slots: [], text, unreported: ['• Chapter abstract', 'Authors must sign the form.'] }).messages[1].content;
  assert.match(message, /^Sentences from which the first reading reported no requirement:\n\[1\] • Chapter abstract\n    \(an item of the list introduced by: Each chapter you send should include:\)\n\[2\] Authors must sign the form\.\n\nThe guidelines:\n/);
  const prompt = settingsPrompt({ docType: 'article', slots: [], unreported: true });
  assert.match(prompt, /item of a list is read with the sentence that introduces the list/);
  assert.match(prompt, /left to the author's choice/, 'a suggestion the author may take or leave asks nothing');
});

test('POST /api/settings refuses sentences that are not a short list of short texts', async () => {
  const sent = [];
  const handle = createHandler({ model: 'glm-5.3', gatewayFetch: gateway({ sent }) });
  for (const unreported of ['one sentence', [''], [42], ['x'.repeat(601)], Array.from({ length: 31 }, () => 'A sentence.'), Array.from({ length: 12 }, () => 'y'.repeat(550))]) {
    const response = await handle(await settingsRequest(body({ unreported })), env);
    assert.equal(response.status, 400, JSON.stringify(unreported).slice(0, 60));
  }
  assert.equal(sent.length, 0);
});

test('a rate-limit refusal from the Gateway reaches the page as retryable, with its Retry-After', async () => {
  const reply = () => cailErrorResponse(429, cailErrorEnvelope({ code: 'upstream_rate_limited', type: 'rate_limit_error', message: 'Too many requests.', cail: { retry_after_seconds: 7 } }), { 'x-should-retry': 'true', 'retry-after': '7' });
  const handle = createHandler({ model: 'glm-5.3', gatewayFetch: gateway({ reply }) });
  const response = await handle(await settingsRequest(body()), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-should-retry'), 'true');
  assert.equal(response.headers.get('retry-after'), '7');
  assert.equal((await response.json()).error.code, 'upstream_rate_limited');
});
