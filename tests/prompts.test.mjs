import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DOC_TYPES, SLOTS, SLOT_USES, categoriesFor } from '../lib/rules/schema.js';
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
  assert.match(prompt, /a monograph/);
});

// The labels of the categories read in the other passes, for one document type: every category of
// another group except the catch-all, which is never a topic of its own.
const otherTopics = (docType, group) => categoriesFor(docType).filter(entry => entry.group !== group && entry.id !== 'other').map(entry => entry.label);

test('each pass reports only its own categories and names the other passes topics as left out', () => {
  for (const docType of DOC_TYPES) {
    for (const group of new Set(CATEGORIES.map(entry => entry.group))) {
      const prompt = rulesPrompt({ docType, group });
      assert.match(prompt, /Report only requirements that belong to the categories listed below/, `${docType} ${group}`);
      const sentence = prompt.match(/Leave out requirements about these topics, which are read in a separate pass: ([^\n]*)\./);
      assert.ok(sentence, `${docType} ${group}`);
      assert.deepEqual(sentence[1].split(', '), otherTopics(docType, group), `${docType} ${group}`);
    }
  }
});

test('the style prompt excludes the references and structure topics and does not offer them as categories', () => {
  const prompt = rulesPrompt({ docType: 'article', group: 'style' });
  const listed = new Set(listedCategories(prompt).map(([id]) => id));
  for (const label of ['Citations', 'References', 'Notes', 'Figures and tables', 'Title page', 'Anonymization']) {
    assert.ok(otherTopics('article', 'style').includes(label), label);
    const entry = CATEGORIES.find(item => item.label === label);
    assert.equal(listed.has(entry.id), false, `${label} is not offered`);
  }
  assert.match(prompt, /which are read in a separate pass: [^\n]*\bCitations\b[^\n]*\bNotes\b[^\n]*\bAnonymization\b/);
  assert.equal(prompt.includes('Front matter'), false, 'a category the document type does not have is not named');
  assert.equal(prompt.includes('"other"'), false, 'the catch-all is not offered outside the structure pass');
  assert.match(prompt, /Also leave out any requirement that fits none of the categories listed below/);
});

test('the structure prompt says other is only for requirements that fit no category of any pass', () => {
  const prompt = rulesPrompt({ docType: 'monograph', group: 'structure' });
  assert.ok(prompt.includes('- "other" (Other requirements)'));
  assert.match(prompt, /Use "other" only for a requirement that fits none of the categories listed below and none of the topics read in the other passes/);
  assert.equal(/Also leave out any requirement that fits none/.test(prompt), false);
});

test('manual.named is the citation or editorial style manual, never a dictionary', () => {
  const prompt = rulesPrompt({ docType: 'article', group: 'style' });
  const line = prompt.split('\n').find(text => text.startsWith('"manual.named":'));
  assert.ok(line);
  assert.match(line, /the citation or editorial style manual the guidelines tell the author to follow/);
  for (const example of ['The Chicago Manual of Style', 'MLA Handbook', 'APA Publication Manual', 'Harvard', 'OSCOLA', "a publisher's own named house style guide"]) {
    assert.ok(line.includes(example), example);
  }
  assert.match(line, /with its edition if the guidelines state one, copied verbatim/);
  assert.match(line, /A dictionary or spelling reference[^.]* is not a style manual/);
  assert.match(line, /null if the guidelines name no style manual/);
});

test('refuses an unknown document type or group', () => {
  assert.throws(() => rulesPrompt({ docType: 'novel', group: 'style' }), /document type/);
  assert.throws(() => rulesPrompt({ docType: 'article', group: 'layout' }), /group/);
  assert.throws(() => rulesPrompt({ docType: 'article', group: 'constructor' }), /group/);
});

test('every slot has a line saying when it applies, and the prompt of its group gives it', () => {
  assert.deepEqual(Object.keys(SLOT_USES).sort(), Object.keys(SLOTS).sort());
  for (const [id, spec] of Object.entries(SLOTS)) {
    const docType = DOC_TYPES.find(type => categoriesFor(type).some(entry => entry.id === spec.category));
    const group = CATEGORIES.find(entry => entry.id === spec.category).group;
    assert.ok(rulesPrompt({ docType, group }).includes(`"${id}" in "${spec.category}"`) && rulesPrompt({ docType, group }).includes(`Use it for ${SLOT_USES[id]}.`), id);
  }
});

test('the index conventions are offered for books, in the structure pass, and not for articles', async () => {
  const { rulesPrompt: prompt } = await import('../server/prompts.js');
  const book = prompt({ docType: 'monograph', group: 'structure' });
  for (const slot of ['index.layout', 'index.page-ranges', 'index.sorting']) assert.ok(book.includes(`- "${slot}" in "index"`), slot);
  assert.equal(prompt({ docType: 'article', group: 'structure' }).includes('index.layout'), false);
});
