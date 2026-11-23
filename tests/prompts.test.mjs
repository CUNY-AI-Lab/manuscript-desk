import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DOC_TYPES, SLOTS, categoriesFor } from '../lib/rules/schema.js';
import { rulesPrompt } from '../server/prompts.js';

// The category lines of a prompt, as [id, label] pairs.
const listedCategories = prompt => [...prompt.matchAll(/^- "([^"]+)" \(([^)]+)\)$/gm)].map(match => [match[1], match[2]]);
const expectedCategories = (docType, group) => categoriesFor(docType).filter(entry => entry.group === group).map(entry => [entry.id, entry.label]);

test('style group for an article lists spelling and quotations and not notes or front-matter', () => {
  const prompt = rulesPrompt({ docType: 'article', group: 'style' });
  const listed = listedCategories(prompt);
  assert.deepEqual(listed, expectedCategories('article', 'style'));
  assert.ok(listed.some(([id, label]) => id === 'spelling' && label === 'Spelling'));
  assert.ok(listed.some(([id, label]) => id === 'quotations' && label === 'Quotations'));
  assert.equal(prompt.includes('"notes"'), false);
  assert.equal(prompt.includes('"front-matter"'), false);
});

test('structure group for an article lists anonymization; for a monograph lists front-matter and not anonymization', () => {
  const article = rulesPrompt({ docType: 'article', group: 'structure' });
  assert.deepEqual(listedCategories(article), expectedCategories('article', 'structure'));
  assert.ok(article.includes('- "anonymization" (Anonymization)'));
  assert.equal(article.includes('"front-matter"'), false);
  const monograph = rulesPrompt({ docType: 'monograph', group: 'structure' });
  assert.deepEqual(listedCategories(monograph), expectedCategories('monograph', 'structure'));
  assert.ok(monograph.includes('- "front-matter" (Front matter)'));
  assert.equal(monograph.includes('"anonymization"'), false);
  assert.equal(monograph.includes('"anonymize"'), false, 'nor the slot of a category that does not apply');
});

test('every document type and group lists exactly its categories', () => {
  for (const docType of DOC_TYPES) {
    for (const group of new Set(CATEGORIES.map(entry => entry.group))) {
      assert.deepEqual(listedCategories(rulesPrompt({ docType, group })), expectedCategories(docType, group), `${docType} ${group}`);
    }
  }
});

test('lists each slot of the group with its allowed values', () => {
  const prompt = rulesPrompt({ docType: 'article', group: 'style' });
  assert.ok(prompt.includes('"quotes.primary"'));
  assert.ok(prompt.includes('"double"'));
  assert.ok(prompt.includes('"single"'));
  const styleIds = new Set(expectedCategories('article', 'style').map(([id]) => id));
  for (const [slotId, spec] of Object.entries(SLOTS)) {
    if (!styleIds.has(spec.category)) {
      assert.equal(prompt.includes(`"${slotId}"`), false, `${slotId} belongs to another group`);
      continue;
    }
    assert.ok(prompt.includes(`- "${slotId}" in "${spec.category}": `), slotId);
    for (const [name, check] of Object.entries(spec.params)) assert.ok(prompt.includes(`"${name}" (${check.allowed})`), `${slotId}.${name}`);
  }
  assert.ok(prompt.includes('"slot": null'));
  assert.ok(prompt.includes('"params": {}'));
});

test('states the task, the reply shape and the verbatim-quote rule', () => {
  const prompt = rulesPrompt({ docType: 'monograph', group: 'references' });
  assert.ok(prompt.includes('{"rules":[{"category","slot","statement","quote","mode","params"}],"manual":{"named": string|null}}'));
  assert.match(prompt, /JSON only/);
  assert.match(prompt, /every distinct requirement the author must meet/);
  assert.match(prompt, /Do not add requirements the guidelines do not state/);
  assert.match(prompt, /Ignore greetings, offers of help, and advice that asks for nothing specific/);
  assert.match(prompt, /character for character/);
  assert.match(prompt, /at most 400 characters/);
  assert.match(prompt, /If no sentence in the guidelines supports a rule, leave the rule out/);
  assert.match(prompt, /"fix": mechanical, applied as a tracked change/);
  assert.match(prompt, /"flag": needs judgment, left as a comment/);
  assert.match(prompt, /"supply": something only the author can provide, goes on the To-dos list/);
  assert.match(prompt, /"manual\.named": the style manual and edition the guidelines tell the author to follow, copied verbatim, or null/);
  assert.match(prompt, /a monograph/);
});

test('refuses an unknown document type or group', () => {
  assert.throws(() => rulesPrompt({ docType: 'novel', group: 'style' }), /document type/);
  assert.throws(() => rulesPrompt({ docType: 'article', group: 'layout' }), /group/);
  assert.throws(() => rulesPrompt({ docType: 'article', group: 'constructor' }), /group/);
});
