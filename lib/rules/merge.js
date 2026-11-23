// Merging and layering rules. mergeExtracted turns the candidate rules a model read out of the
// guidelines (untrusted) into the validated rule list of a rule sheet: every quotation checked
// against the guidelines, duplicates (also across passes) removed, conflicts marked, ids assigned. layerSheet puts a
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

// Validation failures that concern only how a rule would be applied, not what it requires.
const SETTING_FAILURE = /^(?:slot|params|mode)\b/;
// The mode of a comment-only retry: a fix cannot be applied without a slot, so it is left as a comment.
const commentMode = mode => (mode === 'flag' || mode === 'supply' ? mode : 'flag');

// A validated rule from one candidate, or null if it is malformed, invalid, or its quotation is
// not in the guidelines. A candidate with a verified quotation that fails only on its slot, params
// or mode (a fix with no slot, a slot with wrong params or of another category) is retried once as
// a comment-only rule: no slot, no params, and a fix turned into a flag.
function checkCandidate(candidate, guidelines) {
  if (!isPlainObject(candidate)) return null;
  const source = isPlainObject(candidate.source) ? candidate.source : {};
  const quote = candidate.quote !== undefined ? candidate.quote : source.quote;
  if (typeof quote !== 'string') return null;
  const doc = resolveDoc(quote, candidate.doc !== undefined ? candidate.doc : source.doc, guidelines);
  if (doc === -1) return null;
  const rule = {
    id: PROVISIONAL_ID,
    category: candidate.category,
    slot: candidate.slot === undefined ? null : candidate.slot,
    statement: candidate.statement,
    mode: candidate.mode,
    source: { kind: 'guidelines', quote, doc },
    params: candidate.params === undefined ? {} : candidate.params,
    enabled: true,
  };
  const result = validateRule(rule);
  if (result.ok) return result.rule;
  if (!SETTING_FAILURE.test(result.reason)) return null;
  const retry = validateRule({ ...rule, slot: null, params: {}, mode: commentMode(rule.mode) });
  return retry.ok ? retry.rule : null;
}

function sameParams(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

const quoteKey = rule => normalizeForMatch(rule.source.quote).replace(QUOTE_EDGES, '');

// Adds a slotted rule to `kept`: a duplicate of a kept rule (same slot, same params) is skipped;
// a rule that disagrees with kept rules in its slot is added and marks them all as conflicting.
function addSlotted(kept, rule) {
  const rivals = kept.filter(other => other.slot === rule.slot);
  if (rivals.some(other => sameParams(other.params, rule.params))) return;
  if (rivals.length > 0) for (const other of [...rivals, rule]) other.conflict = true;
  kept.push(rule);
}

// Adds a slot-less rule to `kept`. It duplicates a kept slot-less rule only when both have the same
// category, the same mode and the same quotation (normalized, edges trimmed); containment does not
// count, since one guideline sentence often carries two requirements. Of a duplicate pair the one
// with the longer statement stays (the earlier on a tie), in the earlier one's place.
function addSlotless(kept, rule, keys) {
  const key = quoteKey(rule);
  keys.set(rule, key);
  const place = kept.findIndex(other => other.slot === null && other.category === rule.category
    && other.mode === rule.mode && keys.get(other) === key);
  if (place === -1) kept.push(rule);
  else if (rule.statement.length > kept[place].statement.length) kept[place] = rule;
}

// The rules of `kept` that are not a cross-pass duplicate. The passes read the same text for
// different categories, and a pass sometimes reports a requirement outside its own under the only
// category it has that fits (often `other`). Of two rules with the same quotation (normalized, edges
// trimmed) the one in `other` goes when the other rule is in a specific category, and a slot-less
// rule goes when a rule of its category has a slot. The rules that cause a removal (specific, or
// slotted) are never removed themselves, so the result does not depend on order. Rules with the
// same quotation in two specific categories stay: one sentence can carry two requirements.
function withoutCrossPassDuplicates(kept) {
  const byKey = new Map();
  for (const rule of kept) {
    const key = quoteKey(rule);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rule);
  }
  return kept.filter(rule => {
    const same = byKey.get(quoteKey(rule));
    if (rule.category === 'other' && same.some(other => other.category !== 'other')) return false;
    if (rule.slot === null && same.some(other => other.category === rule.category && other.slot !== null)) return false;
    return true;
  });
}

// A copy of an array argument, or [] if it is not an array or cannot be read (a throwing Proxy).
function readArray(value) {
  try {
    return Array.isArray(value) ? Array.from(value) : [];
  } catch {
    return [];
  }
}

// checkCandidate, with a candidate whose inspection throws (a getter or Proxy) treated as invalid.
function safeCheck(candidate, guidelines) {
  try {
    return checkCandidate(candidate, guidelines);
  } catch {
    return null;
  }
}

export function mergeExtracted(candidates, guidelines) {
  const list = readArray(candidates);
  const documents = readArray(guidelines);
  const kept = [];
  const keys = new Map();
  let dropped = 0;
  for (const candidate of list) {
    const rule = safeCheck(candidate, documents);
    if (rule === null) dropped += 1;
    else if (rule.slot === null) addSlotless(kept, rule, keys);
    else addSlotted(kept, rule);
  }
  // Within a category, rules keep the order they were kept in: first appearance in the input.
  const ordered = withoutCrossPassDuplicates(kept)
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
