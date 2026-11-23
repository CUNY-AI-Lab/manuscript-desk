import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGold, scoreRoles, selectChapters, spansFor } from '../scripts/roles-eval.mjs';

// A gold file written for these tests: two chapters of an invented manuscript.
const GOLD = {
  roles: ['title-block', 'body', 'verse', 'bibliography-heading', 'bibliography-entry'],
  chapters: [{ key: 'one', first: 5, last: 9 }, { key: 'two', first: 12, last: 16 }],
  dev: ['one'],
  holdout: ['two'],
  gold: { 5: 'title-block', 6: 'body', 7: 'verse', 8: 'body', 9: 'bibliography-entry', 12: 'title-block', 13: 'body', 14: 'body', 15: 'bibliography-heading', 16: 'bibliography-entry' },
};
const paragraph = (index, empty = false) => ({ index, kind: 'paragraph', text: empty ? '' : 'x', hints: { empty } });

test('checkGold accepts a well-formed file and names the problems of a bad one', () => {
  assert.deepEqual(checkGold(GOLD), []);
  assert.deepEqual(checkGold([]), ['must be a JSON object']);
  const problems = checkGold({ ...GOLD, roles: ['body', 'poem'], gold: { a: 'body' }, chapters: [{ key: 'one', first: 9, last: 5 }], dev: 'one' });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /poem/);
});

test('selectChapters reads dev, holdout, all and keys', () => {
  assert.deepEqual(selectChapters(GOLD, 'dev').chapters.map(chapter => chapter.key), ['one']);
  assert.deepEqual(selectChapters(GOLD, 'holdout').chapters.map(chapter => chapter.key), ['two']);
  assert.deepEqual(selectChapters(GOLD, 'all').chapters.map(chapter => chapter.key), ['one', 'two']);
  assert.deepEqual(selectChapters(GOLD, 'two, one').chapters.map(chapter => chapter.key), ['two', 'one']);
  assert.match(selectChapters(GOLD, 'three').error, /Unknown chapters: three/);
  assert.match(selectChapters(GOLD, ',').error, /Unknown chapters/);
});

test('spansFor adds lead paragraphs before each chapter and merges spans that touch', () => {
  assert.deepEqual(spansFor(GOLD.chapters, 2), [[3, 16]]);
  assert.deepEqual(spansFor(GOLD.chapters, 1), [[4, 9], [11, 16]]);
  assert.deepEqual(spansFor([{ first: 3, last: 4 }], 10), [[0, 4]]);
});

test('scoreRoles counts accuracy, structural accuracy, body given a structural role, and confusions', () => {
  const paragraphs = Array.from({ length: 20 }, (_, index) => paragraph(index, index === 14));
  const predicted = { 5: 'title-block', 6: 'verse', 7: 'body', 8: 'body', 9: 'bibliography-entry', 12: 'body', 13: 'body', 16: 'bibliography-entry' };
  const one = scoreRoles({ gold: GOLD.gold, predicted, paragraphs, chapters: [GOLD.chapters[0]] });
  assert.equal(one.scored, 5);
  assert.equal(one.correct, 3);
  assert.equal(one.structural, 2);
  assert.equal(one.structuralCorrect, 1);
  assert.equal(one.bodyAsStructural, 1);
  assert.deepEqual([...one.confusions].sort(), [['body->verse', 1], ['verse->body', 1]]);
  const two = scoreRoles({ gold: GOLD.gold, predicted, paragraphs, chapters: [GOLD.chapters[1]] });
  assert.equal(two.scored, 4, 'an empty paragraph is not scored');
  assert.equal(two.emptySkipped, 1);
  assert.equal(two.correct, 2);
  assert.deepEqual([...two.confusions].sort(), [['bibliography-heading->(none)', 1], ['title-block->body', 1]]);
});
