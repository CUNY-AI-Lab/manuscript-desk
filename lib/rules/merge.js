// Merging and layering rules. mergeExtracted turns the candidate rules a model read out of the
// guidelines (untrusted) into the validated rule list of a rule sheet: every quotation checked
// against the guidelines, duplicates removed, conflicts marked, ids assigned. layerSheet puts a
// manual's baseline rules under the sheet's own.
// Pure: no DOM, no network. Neither function throws or mutates its arguments.

import { CATEGORIES, validateRule } from './schema.js';
import { findQuote, normalizeForMatch } from './quote.js';

const PROVISIONAL_ID = 'candidate';
// Quotation marks and the punctuation .,;: at either end do not change what a quotation says.
const QUOTE_EDGES = /^["'«»‹›.,;:\s]+|["'«»‹›.,;:\s]+$/g;

// Output order: the order of CATEGORIES, except that `other` always comes last.
const CATEGORY_ORDER = new Map(
  [...CATEGORIES.map(entry => entry.id).filter(id => id !== 'other'), 'other'].map((id, index) => [id, index]),
);

const isPlainObject = value => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The index of the document that contains the quotation: the one the candidate names if the
// quotation is there, else the first that contains it, else -1.
function resolveDoc(quote, doc, guidelines) {
  if (Number.isInteger(doc) && doc >= 0 && doc < guidelines.length && findQuote(quote, guidelines[doc])) return doc;
  return guidelines.findIndex(text => findQuote(quote, text));
}

// A validated rule from one candidate, or null if it is malformed, invalid, or its quotation is
// not in the guidelines.
function checkCandidate(candidate, guidelines) {
  if (!isPlainObject(candidate)) return null;
  const source = isPlainObject(candidate.source) ? candidate.source : {};
  const quote = candidate.quote !== undefined ? candidate.quote : source.quote;
  if (typeof quote !== 'string') return null;
  const doc = resolveDoc(quote, candidate.doc !== undefined ? candidate.doc : source.doc, guidelines);
  if (doc === -1) return null;
  const result = validateRule({
    id: PROVISIONAL_ID,
    category: candidate.category,
    slot: candidate.slot === undefined ? null : candidate.slot,
    statement: candidate.statement,
    mode: candidate.mode,
    source: { kind: 'guidelines', quote, doc },
    params: candidate.params === undefined ? {} : candidate.params,
    enabled: true,
  });
  return result.ok ? result.rule : null;
}

function sameParams(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

const quoteKey = rule => normalizeForMatch(rule.source.quote).replace(QUOTE_EDGES, '');
const overlaps = (a, b) => a.includes(b) || b.includes(a);

// Adds a slotted rule to `kept`: a duplicate of a kept rule (same slot, same params) is skipped;
// a rule that disagrees with kept rules in its slot is added and marks them all as conflicting.
function addSlotted(kept, rule) {
  const rivals = kept.filter(other => other.slot === rule.slot);
  if (rivals.some(other => sameParams(other.params, rule.params))) return;
  if (rivals.length > 0) for (const other of [...rivals, rule]) other.conflict = true;
  kept.push(rule);
}

// Adds a slot-less rule to `kept`: of this rule and the kept slot-less rules whose quotations
// overlap it, only the one with the longest statement stays (the earliest on a tie), in the place
// of the earliest of them.
function addSlotless(kept, rule, keys) {
  const key = quoteKey(rule);
  const matches = kept.filter(other => other.slot === null && overlaps(keys.get(other), key));
  keys.set(rule, key);
  if (matches.length === 0) {
    kept.push(rule);
    return;
  }
  const winner = [...matches, rule].reduce((best, other) => (other.statement.length > best.statement.length ? other : best));
  const place = kept.indexOf(matches[0]);
  const later = new Set(matches.slice(1));
  const merged = kept.map((other, index) => (index === place ? winner : other)).filter((other, index) => index === place || !later.has(other));
  kept.splice(0, kept.length, ...merged);
}

export function mergeExtracted(candidates, guidelines) {
  const list = Array.isArray(candidates) ? candidates : [];
  const documents = Array.isArray(guidelines) ? guidelines : [];
  const kept = [];
  const keys = new Map();
  let dropped = 0;
  for (const candidate of list) {
    const rule = checkCandidate(candidate, documents);
    if (rule === null) dropped += 1;
    else if (rule.slot === null) addSlotless(kept, rule, keys);
    else addSlotted(kept, rule);
  }
  // Within a category, rules keep the order they were kept in: first appearance in the input.
  const ordered = kept
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => CATEGORY_ORDER.get(a.rule.category) - CATEGORY_ORDER.get(b.rule.category) || a.index - b.index)
    .map(entry => entry.rule);
  const counts = new Map();
  for (const rule of ordered) {
    const n = (counts.get(rule.category) ?? 0) + 1;
    counts.set(rule.category, n);
    rule.id = `${rule.category}-${n}`;
  }
  return { rules: ordered, dropped };
}

const copyRule = rule => ({ ...rule, source: { ...rule.source }, params: { ...rule.params } });

export function layerSheet(sheet, baseline) {
  const own = Array.isArray(sheet?.rules) ? sheet.rules : [];
  const base = Array.isArray(baseline) ? baseline : [];
  const occupied = new Set(own.map(rule => rule.slot).filter(slot => slot !== null));
  const fromBaseline = base.filter(rule => rule.slot === null || !occupied.has(rule.slot));
  return [...own, ...fromBaseline].map(copyRule);
}
