import test from 'node:test';
import assert from 'node:assert/strict';
import { matchComments, placesOf, ranker } from '../scripts/todos-eval.mjs';

const paragraphs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => ({ index, hints: { empty: index === 3 || index === 4 } }));
const rankOf = ranker(paragraphs);
const chapterOf = index => (index === null ? null : index < 6 ? 'one' : 'two');

test('distances count paragraphs with text only', () => {
  assert.equal(rankOf(5) - rankOf(2), 1, 'two empty paragraphs between do not count');
  assert.equal(rankOf(9) - rankOf(0), 7);
});

test('a comment is produced by a place of the same kind, in the same chapter, within two paragraphs; each place counts once', () => {
  const comments = [
    { id: 'a', chapter: 'one', paragraph: 1, kind: 'chapter-title' },
    { id: 'b', chapter: 'one', paragraph: 2, kind: 'chapter-title' },
    { id: 'c', chapter: 'two', paragraph: 6, kind: 'note-on-title' },
    { id: 'd', chapter: null, paragraph: 0, kind: 'formatting-summary' },
    { id: 'e', chapter: 'two', paragraph: 9, kind: 'chapter-title' },
  ];
  const places = placesOf([
    { kind: 'chapter-title', paragraphIndex: 5 }, // the next paragraph with text after 2 (3 and 4 are empty)
    { kind: 'chapter-title', paragraphIndex: 5 }, // the same place again
    { kind: 'note-on-title', paragraphIndex: 9 }, // three from 6: too far
    { kind: 'formatting-summary', paragraphIndex: null },
    { kind: 'chapter-title', paragraphIndex: 6 }, // the wrong chapter for a and b, three from 9
  ]);
  assert.equal(places.length, 4);
  const { matched, extra } = matchComments(comments, places, chapterOf, rankOf);
  assert.deepEqual([...matched.keys()].sort(), ['b'], 'b takes the place at 5; a has none left; the summary at no paragraph is not near paragraph 0');
  assert.deepEqual(extra.map(place => place.kind).sort(), ['chapter-title', 'formatting-summary', 'note-on-title']);
  const anywhere = matchComments([{ id: 'f', chapter: 'two', paragraph: null, kind: 'note-on-title' }], places, chapterOf, rankOf);
  assert.deepEqual([...anywhere.matched.keys()], ['f'], 'a comment with no paragraph matches by kind and chapter');
});
