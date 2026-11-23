// The To-dos list, as its own .docx, and the comments for the formatted file, both built from the
// findings of the To-do checks: every finding grouped by chapter and kind, each naming its rule and
// quoting the guideline sentence the rule came from; the requirements only the author can supply
// that no check could verify; and a summary of what was changed, what was flagged and what was
// skipped, and why. Pure: no DOM, no network.

import { buildDocx } from '../docx/build.js';
import { changeLines } from '../checks/summary.js';
import { activeRules, appliedByFormatter, categoryLabel, chapterName, kindLabel, ruleBlocks, ruleById, rulesOf } from './shared.js';

/**
 * The comments for the formatted file: one per paragraph that has findings, the findings' messages
 * in order, each followed by the guideline sentence its rule quotes.
 * @returns {Array<{ sourceIndex: number | null, text: string }>}
 */
export function commentsFor(findings, sheet) {
  const byPlace = new Map();
  for (const finding of findings) {
    const key = finding.paragraphIndex ?? null;
    if (!byPlace.has(key)) byPlace.set(key, []);
    const rule = finding.ruleId ? ruleById(sheet, finding.ruleId) : null;
    const quote = rule?.source?.kind === 'guidelines' ? `\nThe guidelines: “${rule.source.quote}”` : '';
    byPlace.get(key).push(`${finding.message}${quote}`);
  }
  return [...byPlace].map(([sourceIndex, texts]) => ({ sourceIndex, text: texts.join('\n\n') }));
}

/** The rules a check ran on or a finding named. */
function rulesUsed(findings, checks) {
  return new Set([...findings.map(finding => finding.ruleId), ...checks.filter(check => check.ran).map(check => check.ruleId)].filter(Boolean));
}

/** The supply rules no check verified, which go on the list as "to supply". */
export function toSupply(sheet, findings, checks) {
  const used = rulesUsed(findings, checks);
  return activeRules(sheet).filter(rule => rule.mode === 'supply' && !used.has(rule.id));
}

/**
 * @param {{ findings: Array<object>, checks: Array<object>, sheet: object | null, report: object, paragraphs: Array<object> }} input
 * @returns {{ bytes: Uint8Array, counts: { items: number, chapters: number, toSupply: number, notChecked: number } }}
 */
export function todosDocument({ findings, checks, sheet, report, paragraphs }) {
  const blocks = [];
  const items = findings.filter(finding => finding.kind !== 'formatting-summary');
  const chapters = report.chapters ?? [];
  const supply = toSupply(sheet, findings, checks);
  const used = rulesUsed(findings, checks);
  const notChecked = activeRules(sheet).filter(rule => rule.mode === 'flag' && !used.has(rule.id) && !appliedByFormatter(rule, report));
  const groups = new Map();
  for (const finding of items) {
    const key = finding.chapter ?? -1;
    if (!groups.has(key)) groups.set(key, new Map());
    const kinds = groups.get(key);
    if (!kinds.has(finding.kind)) kinds.set(finding.kind, []);
    kinds.get(finding.kind).push(finding);
  }

  blocks.push({ type: 'heading', level: 1, text: 'To-dos' });
  blocks.push({ type: 'paragraph', text: 'What is left for you after the formatting pass, chapter by chapter. Each item says what to do, names the rule it comes from and quotes the guidelines. Where an item has a place in the text, a comment from CAIL Manuscript Desk marks it in the formatted file.' });
  const chapterCount = [...groups.keys()].filter(key => key >= 0).length;
  blocks.push({ type: 'paragraph', text: `${items.length} ${items.length === 1 ? 'item' : 'items'}${chapterCount ? ` in ${chapterCount} ${chapterCount === 1 ? 'chapter' : 'chapters'}` : ''}; ${supply.length} ${supply.length === 1 ? 'requirement' : 'requirements'} to supply; a summary at the end.` });

  const keys = [...groups.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    blocks.push({ type: 'heading', level: 2, text: key < 0 ? 'The whole manuscript' : chapterName(chapters[key], paragraphs) });
    for (const [kind, list] of groups.get(key)) {
      blocks.push({ type: 'heading', level: 3, text: kindLabel(kind) });
      for (const finding of list) {
        blocks.push({ type: 'paragraph', text: finding.message });
        blocks.push(...(finding.ruleId ? ruleBlocks(ruleById(sheet, finding.ruleId)) : [{ type: 'quote', text: 'This concerns a change the formatting pass made: check it.' }]));
      }
    }
  }

  if (supply.length) {
    blocks.push({ type: 'heading', level: 2, text: 'To supply' });
    blocks.push({ type: 'paragraph', text: 'What the guidelines ask for that only you can provide, and that the tool could not find or check in the file.' });
    const byCategory = new Map();
    for (const rule of supply) {
      if (!byCategory.has(rule.category)) byCategory.set(rule.category, []);
      byCategory.get(rule.category).push(rule);
    }
    for (const [category, rules] of byCategory) {
      blocks.push({ type: 'heading', level: 3, text: categoryLabel(category) });
      for (const rule of rules) blocks.push({ type: 'paragraph', runs: [{ text: rule.statement }] }, ...ruleBlocks(rule).slice(1));
    }
  }

  blocks.push({ type: 'heading', level: 2, text: 'Summary' });
  blocks.push({ type: 'heading', level: 3, text: 'What was changed' });
  const styled = Object.values(report.styles ?? {}).reduce((sum, count) => sum + count, 0);
  blocks.push({ type: 'item', text: `${styled} paragraphs given a named style for what they are` });
  for (const line of changeLines(report)) blocks.push({ type: 'item', text: line });
  const applied = activeRules(sheet).filter(rule => appliedByFormatter(rule, report));
  if (applied.length) blocks.push({ type: 'paragraph', text: `Rules applied by the formatting pass: ${applied.map(rule => rule.statement.replace(/\.$/u, '')).join('; ')}.` });
  blocks.push({ type: 'heading', level: 3, text: 'What was flagged' });
  const tally = new Map();
  for (const finding of items) tally.set(finding.kind, (tally.get(finding.kind) ?? 0) + 1);
  if (!tally.size) blocks.push({ type: 'paragraph', text: 'Nothing.' });
  for (const [kind, count] of tally) blocks.push({ type: 'item', text: `${kindLabel(kind)}: ${count}` });
  blocks.push({ type: 'heading', level: 3, text: 'What was skipped, and why' });
  const skipped = checks.filter(check => !check.ran);
  if (skipped.length) {
    blocks.push({ type: 'paragraph', text: 'Checks that did not run, because nothing in the rule sheet or in the formatting pass called for them:' });
    for (const check of skipped) blocks.push({ type: 'item', text: `${kindLabel(check.kind)}: it needs ${check.needs}` });
  }
  const conflicts = rulesOf(sheet).filter(rule => rule.conflict === true && rule.enabled !== false);
  if (conflicts.length) {
    blocks.push({ type: 'paragraph', text: 'Rules not applied, because they disagree with another rule on the same setting (choose one on the rules page):' });
    for (const rule of conflicts) blocks.push({ type: 'item', text: rule.statement });
  }
  const off = rulesOf(sheet).filter(rule => rule.enabled === false);
  if (off.length) {
    blocks.push({ type: 'paragraph', text: 'Rules you switched off:' });
    for (const rule of off) blocks.push({ type: 'item', text: rule.statement });
  }
  if (notChecked.length) {
    blocks.push({ type: 'paragraph', text: 'Rules the tool cannot check yet, because they need someone to read the text; check them yourself:' });
    for (const rule of notChecked) blocks.push({ type: 'item', text: rule.statement });
  }
  return { bytes: buildDocx(blocks), counts: { items: items.length, chapters: chapterCount, toSupply: supply.length, notChecked: notChecked.length } };
}
