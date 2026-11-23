// How much of a part of the guidelines a reading reported. One reading of a part lists the
// requirements of a group of categories, and on a long list a model sometimes stops before it has
// gone through every sentence (round 6 measured this: the same part gave 28 to 33 rules on one
// guide and 35 to 67 on another, with plain requirements left out of the shorter answers). Here the
// part is cut into sentences, the sentences that read as requirements are picked out by their
// wording, and each is checked against the quotations every reading of that part gave. The
// sentences no quotation covers can then be asked about in one short question. Pure: no DOM, no
// network.

import { normalizeForMatch } from './quote.js';

// Wording that asks something of the author: a modal or a word of obligation, or a sentence that
// begins with a verb in the imperative.
const ASKS = /\b(?:must|should|shall|please|required?|requires|requirements?|need(?:s)? to|ensure|make sure|expected to|do not|don't|never|always|avoid|may not|cannot|can not|is to be|are to be|has to|have to|only|no more than|at least|at most|up to|maximum|minimum|limit(?:ed)?)\b/iu;
const IMPERATIVE = /^["'“‘(]?(?:use|include|submit|provide|send|supply|give|list|number|place|put|write|indicate|check|follow|mark|keep|insert|add|type|refer|obtain|spell|cite|capitali[sz]e|italici[sz]e|do|leave|set|save|name|label|prepare|format|return|sign|complete|attach|state|identify|note|remember|contact|consult|clear|seek|request)\b/iu;
const BULLET = /^\s*(?:[•▪●◦·‣∙*]|[-–—]\s|\(?[0-9]{1,2}[.)]\s|\(?[a-z][.)]\s)/u;
const MIN_SENTENCE = 25;
const MAX_SENTENCE = 600;
// The run of normalized characters two texts must share to overlap.
const OVERLAP = 30;

/**
 * The sentences of a text, each as it stands (lines of a paragraph joined), in order: paragraphs
 * part at blank lines, list items at their bullets, sentences at a full stop, question or
 * exclamation mark followed by a capital or a digit.
 * @param {string} text
 * @returns {string[]}
 */
export function sentencesOf(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const paragraph of text.split(/\n[ \t]*\n/u)) {
    const items = [];
    for (const line of paragraph.split('\n')) {
      if (!items.length || BULLET.test(line)) items.push(line.trim());
      else items[items.length - 1] = `${items[items.length - 1]}\n${line.trim()}`;
    }
    for (const item of items) {
      const flat = item.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/gu, ' ').trim();
      for (const sentence of flat.split(/(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘(]?[\p{Lu}\d])/u)) if (sentence.trim()) out.push(sentence.trim());
    }
  }
  return out;
}

/** True when a sentence reads as asking something of the author. */
export const asksSomething = sentence => {
  const length = Array.from(sentence).length;
  return length >= MIN_SENTENCE && length <= MAX_SENTENCE && (ASKS.test(sentence) || IMPERATIVE.test(sentence.replace(BULLET, '').trim()));
};

// Two texts overlap when they share a run of OVERLAP characters, or of three fifths of the shorter
// when it is shorter than that (a short sentence a quotation runs into).
function overlaps(a, b) {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return true;
  const run = Math.min(OVERLAP, Math.ceil(short.length * 0.6));
  for (let at = 0; at + run <= short.length; at += 5) if (long.includes(short.slice(at, at + run))) return true;
  return long.includes(short.slice(-run));
}

/**
 * The sentences of a part that read as requirements and that no quotation of a reading covers.
 * @param {string} text the part
 * @param {string[]} quotes every quotation the readings of that part gave
 * @returns {{ asked: number, uncovered: string[] }} asked: the sentences that read as requirements
 */
export function uncoveredSentences(text, quotes) {
  const covered = quotes.filter(quote => typeof quote === 'string').map(normalizeForMatch).filter(Boolean);
  const asking = sentencesOf(text).filter(asksSomething);
  const uncovered = asking.filter(sentence => {
    const normal = normalizeForMatch(sentence);
    return !covered.some(quote => overlaps(normal, quote));
  });
  return { asked: asking.length, uncovered };
}
