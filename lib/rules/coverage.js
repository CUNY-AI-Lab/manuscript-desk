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

// A list item is often a bare noun phrase ("Chapter abstract") that asks nothing in its own words:
// it asks what the sentence introducing the list asks ("Each chapter you send should include:"). Such an item counts
// as a requirement when that lead-in, the sentence ending in a colon just before the list, asks
// something, here also when it says what the author is responsible for. An item that short needs
// only as many characters as a quotation needs to be checked against the guidelines (quote.js).
const RESPONSIBLE = /\b(?:responsible for|responsibilit(?:y|ies))\b/iu;
const MIN_ITEM = 12;
const LEAD_IN = /:["'”’)\]]*$/u;

const words = sentence => sentence.replace(BULLET, '').trim();
const leadInAsks = sentence => ASKS.test(sentence) || IMPERATIVE.test(words(sentence)) || RESPONSIBLE.test(sentence);

/**
 * The sentences of a text in order, each as it stands (lines of a paragraph joined), with what
 * introduces it when it is in a list: paragraphs part at blank lines, list items at their bullets,
 * sentences at a full stop, question or exclamation mark followed by a capital or a digit. A
 * sentence of a bulleted item has `item: true` and, when a sentence ending in a colon comes just
 * before the list (in the same paragraph or the one before it), that sentence as `leadIn`.
 * @param {string} text
 * @returns {Array<{ sentence: string, item: boolean, leadIn: string | null }>}
 */
export function sentenceEntries(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  let leadIn = null;
  for (const paragraph of text.split(/\n[ \t]*\n/u)) {
    const items = [];
    for (const line of paragraph.split('\n')) {
      if (!items.length || BULLET.test(line)) items.push(line.trim());
      else items[items.length - 1] = `${items[items.length - 1]}\n${line.trim()}`;
    }
    for (const item of items) {
      const bulleted = BULLET.test(item);
      const flat = item.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/gu, ' ').trim();
      for (const piece of flat.split(/(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘(]?[\p{Lu}\d])/u)) {
        const sentence = piece.trim();
        if (!sentence) continue;
        if (bulleted) {
          out.push({ sentence, item: true, leadIn });
          continue;
        }
        out.push({ sentence, item: false, leadIn: null });
        leadIn = LEAD_IN.test(sentence) ? sentence : null;
      }
    }
  }
  return out;
}

/**
 * The sentences of a text, in order, as sentenceEntries cuts them.
 * @param {string} text
 * @returns {string[]}
 */
export const sentencesOf = text => sentenceEntries(text).map(entry => entry.sentence);

/** True when a sentence reads as asking something of the author. */
export const asksSomething = sentence => {
  const length = Array.from(sentence).length;
  return length >= MIN_SENTENCE && length <= MAX_SENTENCE && (ASKS.test(sentence) || IMPERATIVE.test(words(sentence)));
};

/**
 * True when an entry of sentenceEntries reads as a requirement: its own words ask something, or it
 * is a list item, however short, under a lead-in that asks something.
 * @param {{ sentence: string, item?: boolean, leadIn?: string | null }} entry
 */
export function entryAsks({ sentence, item = false, leadIn = null }) {
  if (asksSomething(sentence)) return true;
  if (!item || !leadIn || !leadInAsks(leadIn)) return false;
  const length = Array.from(words(sentence)).length;
  return length >= MIN_ITEM && length <= MAX_SENTENCE;
}

/**
 * The lead-ins that ask something, by the sentence of each list item under one: what the question
 * about the sentences no reading quoted shows beside such an item, so that an item is read with
 * what introduces it.
 * @param {string} text the part
 * @returns {Map<string, string>}
 */
export function leadInsOf(text) {
  const out = new Map();
  for (const entry of sentenceEntries(text)) if (entry.item && entry.leadIn && leadInAsks(entry.leadIn) && !out.has(entry.sentence)) out.set(entry.sentence, entry.leadIn);
  return out;
}

// Two texts overlap when they share a run of OVERLAP characters, or of three fifths of the shorter
// when it is shorter than that (a short sentence a quotation runs into). A text shorter than
// SHORT, such as a list item of two words, is covered only by a quotation that holds all of it: a
// few shared characters there are a shared word, not a shared sentence.
const SHORT = 25;
function overlaps(a, b) {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return true;
  if (short.length < SHORT) return false;
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
  const asking = sentenceEntries(text).filter(entryAsks).map(entry => entry.sentence);
  const uncovered = asking.filter(sentence => {
    const normal = normalizeForMatch(words(sentence));
    return !covered.some(quote => overlaps(normal, quote));
  });
  return { asked: asking.length, uncovered };
}
