// The decide step: after the pipeline has formatted the manuscript and run its checks, it does the
// work the guidelines settle and hands the author only the real decisions. Code plans the
// mechanical operations (mechanical.js); a model, through `call`, answers small units (units.js,
// loop.js): which settings were misread, which queries in the running text are the copyeditor's,
// what each unverified rule asks; code judges every answer (policy.js) and then decides what happens
// to every finding and rule: a finding leaves the author's list only when an applied operation
// resolves it, a stated default settles it, or it is a slip for the copyeditor. Pure apart from the
// injected `call`.

import { DECLARED } from '../format/declared.js';
import { isElementFont } from '../rules/merge.js';
import { validateSheet } from '../rules/schema.js';
import { SETTLING_DEFAULTS, isDefaultRule } from './defaults.js';
import { appliedOps, authorOf, mechanicalOps } from './mechanical.js';
import { FLAGGED_CHECKS, GROUPED_CHECKS, PROTECTED_ROLES, checkedChoice, firstDisposition, judgeReplace, judgeRole } from './policy.js';
import { DELIVERABLES, TRIAGE_STATUSES } from './tools.js';
import { OUTPUT_LIMIT, runUnit } from './loop.js';
import { CLEARABLE_SLOTS, FINDINGS_PER_UNIT, RULES_PER_UNIT, findingUnits, ruleUnits, settingsUnit } from './units.js';

// Two units at a time: the Gateway refuses bursts of short calls for its rate limit.
const MAX_IN_FLIGHT = 2;
const findingKey = finding => `${finding.check}\u0000${finding.kind}\u0000${finding.paragraphIndex ?? ''}\u0000${finding.message}`;

/**
 * The sheet as the decide step uses it: a font rule about the text inside illustrations loses its
 * slot (as extraction now does, for sheets read before that), and slots left with one active rule
 * are no longer in conflict.
 */
export function preparedSheet(sheet, cleared = new Map()) {
  if (!sheet || !Array.isArray(sheet.rules)) return sheet;
  const rules = sheet.rules.map(rule => {
    if (cleared.has(rule.id)) return { ...rule, enabled: false };
    if (rule.slot === 'layout.font' && rule.source?.kind === 'guidelines' && isElementFont(rule.source.quote, rule.statement)) { const { conflict, ...rest } = rule; return { ...rest, slot: null, params: {}, mode: rule.mode === 'fix' ? 'flag' : rule.mode }; }
    return rule;
  });
  const bySlot = new Map();
  for (const rule of rules) if (rule.slot && rule.enabled !== false) bySlot.set(rule.slot, [...(bySlot.get(rule.slot) ?? []), rule]);
  const settled = rules.map(rule => {
    if (!rule.slot || !rule.conflict) return rule;
    const rivals = bySlot.get(rule.slot) ?? [];
    const differ = rivals.some(other => JSON.stringify(other.params) !== JSON.stringify(rivals[0].params));
    if (differ) return rule;
    const { conflict, ...rest } = rule;
    return rest;
  });
  const checked = validateSheet({ ...sheet, rules: settled });
  return checked.ok ? checked.sheet : sheet;
}

async function inPool(tasks, size) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) { const at = next; next += 1; results[at] = await tasks[at](); }
  }));
  return results;
}

/** How many model calls the decide step will make, roughly, and how long it takes: said before it starts. */
export function decidePlan({ chapters = 0, openRules = 0, readingUnits = 0 }) {
  const units = 1 + Math.max(1, chapters) + Math.ceil(openRules / RULES_PER_UNIT);
  const calls = readingUnits + Math.round(units * 1.6);
  // About 8 seconds a call, three at a time, plus the formatting itself.
  const minutes = Math.max(1, Math.round((calls * 8) / MAX_IN_FLIGHT / 60 + 0.5));
  return { calls, minutes };
}

/**
 * Asks the model. Returns its proposals, unjudged, and counts.
 * @param {{ paragraphs: Array<object>, roles: object, sheet: object, report: object, findings: Array<object>, statuses: Array<object>,
 *   made?: string[], call: Function, signal?: AbortSignal, onProgress?: Function, wait?: Function }} input
 *   findings: the pipeline's, with the reading check's; statuses: ruleStatuses of the pipeline run
 */
export async function askModel({ paragraphs, roles, sheet, report, findings, statuses, made = [], call, signal, onProgress, wait }) {
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const ops = mechanicalOps({ paragraphs, roles, chapters: report.chapters, sheet, figures: report.figures ?? [] });
  const resolvedBy = finding => ops.find(op => op.resolves(finding))?.id ?? null;
  const ids = findings.map((finding, at) => ({ id: `F${at + 1}`, finding }));
  const open = ids.filter(({ finding }) => firstDisposition(finding, { roleOf, resolvedBy }).choice === 'open');
  const openRules = statuses.filter(entry => ['supply', 'unchecked'].includes(entry.status) && !isDefaultRule(entry.rule)).map(entry => entry.rule);

  const units = [];
  const settings = settingsUnit(sheet);
  if (settings) units.push(settings);
  units.push(...findingUnits({ open, paragraphs, roleOf, chapters: report.chapters ?? [] }));
  units.push(...ruleUnits({ rules: openRules, docType: sheet?.docType, made }));

  const total = units.length;
  let done = 0;
  const results = [];
  const run = async unit => {
    const result = await runUnit({ unit, paragraphs, roleOf, call, signal, wait });
    // A reply that ran out of room: the unit again in two halves, once.
    if (result.stats.stopped === OUTPUT_LIMIT && unit.items.length > 1 && !unit.half) {
      const half = Math.ceil(unit.items.length / 2);
      const parts = unit.kind === 'findings'
        ? [open.filter(item => unit.items.slice(0, half).includes(item.id)), open.filter(item => unit.items.slice(half).includes(item.id))].map(items => findingUnits({ open: items, paragraphs, roleOf, chapters: report.chapters ?? [] })[0])
        : unit.kind === 'rules' ? [unit.items.slice(0, half), unit.items.slice(half)].map(items => ruleUnits({ rules: openRules.filter(rule => items.includes(rule.id)), docType: sheet?.docType, made })[0]) : [];
      for (const part of parts.filter(Boolean)) results.push({ unit: part, ...(await runUnit({ unit: { ...part, half: true }, paragraphs, roleOf, call, signal, wait })) });
    }
    results.push({ unit, ...result });
    done += 1;
    try { onProgress?.({ done, total }); } catch {}
  };
  await inPool(units.map(unit => () => run(unit)), MAX_IN_FLIGHT);

  const cleared = new Map();
  const choices = new Map();
  const triage = new Map();
  const proposals = { edits: [], deletions: [], roles: [] };
  const stats = { units: results.length, calls: 0, toolCalls: 0, malformed: 0, readRefused: 0, stopped: {} };
  for (const { record, stats: unitStats } of results) {
    for (const [id, reason] of record.cleared) cleared.set(id, reason);
    for (const [id, choice] of record.decided) choices.set(id, choice);
    for (const [id, entry] of record.triage) triage.set(id, entry);
    proposals.edits.push(...record.edits);
    proposals.deletions.push(...record.deletions);
    proposals.roles.push(...record.roles);
    for (const field of ['calls', 'toolCalls', 'malformed', 'readRefused']) stats[field] += unitStats[field];
    stats.stopped[unitStats.stopped] = (stats.stopped[unitStats.stopped] ?? 0) + 1;
  }
  return { ops, ids, cleared, choices, triage, proposals, stats, openRules };
}

/**
 * Judges the model's proposals and plans the final formatting: the roles, the sheet and the
 * declared edits, with every refusal counted and turned into a question or a copyedit query.
 */
export function planDecisions({ paragraphs, roles, sheet, answers }) {
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const refusals = [];
  const extraQuestions = [];
  const extraCopyedit = [];
  const ops = [...answers.ops];
  const covered = new Set(ops.flatMap(op => op.paragraphs));
  const caseRule = (sheet?.rules ?? []).find(rule => rule.slot === 'headings.case' && rule.enabled !== false && rule.conflict !== true)?.params?.case ?? null;
  // The name a dash at the start of an entry stands for: the author of the nearest entry above without one.
  const dashName = index => {
    for (let at = index - 1; at >= 0; at -= 1) {
      const entry = byIndex.get(at);
      if (!entry || entry.hints?.empty) continue;
      if (roleOf(at) !== 'bibliography-entry') return null;
      const name = authorOf(entry.text);
      if (name) return name;
    }
    return null;
  };
  for (const edit of answers.proposals.edits) {
    const entry = byIndex.get(edit.paragraph);
    const verdict = judgeReplace(edit, { text: entry?.text ?? '', role: roleOf(edit.paragraph), caseRule, dashName: dashName(edit.paragraph) });
    if (verdict.ok) {
      if (covered.has(edit.paragraph)) continue;
      covered.add(edit.paragraph);
      ops.push({ id: `op-${ops.length + 1}`, kind: verdict.kind, model: true, edits: [{ op: 'replace', paragraph: edit.paragraph, before: edit.before, after: edit.after, kind: verdict.kind === 'dash' ? DECLARED.authorDash : DECLARED.titleCase }], paragraphs: [edit.paragraph], count: 1, words: verdict.kind === 'dash' ? 'a repeated-author dash written as the name' : 'a title retyped in title case', resolves: finding => finding.paragraphIndex === edit.paragraph && (finding.check === 'repeated-author-dash' || finding.check === 'title-capitals') });
      continue;
    }
    refusals.push({ refusal: verdict.refusal, paragraph: edit.paragraph });
    const proposal = { paragraphIndex: edit.paragraph, before: edit.before, after: edit.after, reason: edit.reason };
    if (verdict.to === 'question') extraQuestions.push(proposal); else if (verdict.to === 'copyedit') extraCopyedit.push(proposal);
  }
  for (const deletion of answers.proposals.deletions) {
    let all = true;
    for (let at = deletion.from; at <= deletion.to; at += 1) if (byIndex.get(at) && !byIndex.get(at).hints?.empty && !covered.has(at)) all = false;
    if (all) continue;
    refusals.push({ refusal: 'deletes-text', paragraph: deletion.from });
    const protectedText = [...Array(deletion.to - deletion.from + 1).keys()].some(offset => PROTECTED_ROLES.has(roleOf(deletion.from + offset)));
    (protectedText ? extraQuestions : extraCopyedit).push({ paragraphIndex: deletion.from, deleteTo: deletion.to, reason: deletion.reason });
  }
  const nextRoles = { ...roles };
  const roleChanges = [];
  for (const change of answers.proposals.roles) {
    const verdict = judgeRole(change);
    if (!verdict.ok) { refusals.push({ refusal: verdict.refusal, paragraph: change.paragraph }); continue; }
    if (change.from === change.role) continue;
    nextRoles[change.paragraph] = change.role;
    roleChanges.push(change);
  }
  // Only a layout setting the unit showed may be switched off: the guard, whatever the model said.
  const cleared = new Map([...answers.cleared].filter(([id]) => (sheet?.rules ?? []).some(rule => rule.id === id && rule.source?.kind === 'guidelines' && CLEARABLE_SLOTS.has(rule.slot))));
  return { ops, edits: ops.flatMap(op => op.edits), roles: nextRoles, roleChanges, sheet: preparedSheet(sheet, cleared), cleared, refusals, extraQuestions, extraCopyedit };
}

/**
 * Every finding's disposition after the final formatting: the pipeline's findings (by their ids, with
 * the model's choices for the open ones) and any new ones the final checks made.
 * @returns {{ asked: Array<object>, resolved: Array<object>, settled: Array<object>, copyedit: Array<object>, flagged: Array<object>, refusedChoices: number }}
 */
export function disposeFindings({ roles, answers, plan, finalFindings, edits }) {
  const roleOf = index => plan.roles[index] ?? plan.roles[String(index)] ?? roles[index] ?? null;
  const applied = appliedOps(plan.ops, edits);
  const resolvedBy = finding => applied.find(op => op.resolves(finding))?.id ?? null;
  const out = { asked: [], resolved: [], settled: [], copyedit: [], flagged: [], refusedChoices: 0 };
  const seen = new Set();
  const place = (finding, disposition) => {
    const entry = { ...finding, disposition };
    if (FLAGGED_CHECKS.has(finding.check)) { out.flagged.push(entry); return; }
    if (disposition.choice === 'resolved') out.resolved.push(entry);
    else if (disposition.choice === 'default') out.settled.push(entry);
    else if (disposition.choice === 'copyedit') out.copyedit.push(entry);
    else out.asked.push(entry);
  };
  const dispose = (finding, choice) => {
    const first = firstDisposition(finding, { roleOf, resolvedBy });
    if (first.choice !== 'open') return first;
    const checked = checkedChoice(first, choice);
    if (checked.refused) out.refusedChoices += 1;
    return checked.disposition;
  };
  for (const { id, finding } of answers.ids) {
    seen.add(findingKey(finding));
    place(finding, dispose(finding, answers.choices.get(id)));
  }
  for (const finding of finalFindings) {
    if (seen.has(findingKey(finding)) || finding.check === 'reading') continue;
    seen.add(findingKey(finding));
    // A finding the final run made that the pipeline did not (no model has seen it): forced, or asked.
    const first = firstDisposition(finding, { roleOf, resolvedBy });
    place(finding, first.choice === 'open' ? { choice: 'ask' } : first);
  }
  // A summary of the formatting is replaced by the decide step's own.
  out.resolved.push(...out.asked.filter(entry => entry.check === 'formatting-summary'));
  out.asked = out.asked.filter(entry => entry.check !== 'formatting-summary');
  return { ...out, applied };
}

/**
 * Every rule's end: done by the tool; settled by a default (which); not applicable; for the
 * copyeditor; for the author to deliver (by kind); or a real decision.
 * @param {{ statuses: Array<{ rule, status }>, answers: object, asked: Array<object>, settled: Array<object> }} input
 */
export function triageRules({ statuses, answers, asked, settled }) {
  const askedRules = new Map();
  for (const finding of asked) if (finding.ruleId) askedRules.set(finding.ruleId, (askedRules.get(finding.ruleId) ?? 0) + 1);
  const settledBy = new Map(settled.filter(finding => finding.ruleId).map(finding => [finding.ruleId, finding.disposition.by]));
  const deliverKind = value => (Object.hasOwn(DELIVERABLES, value) ? value : 'other');
  return statuses.map(({ rule, status }) => {
    const base = { rule };
    if (status === 'off') return { ...base, end: 'not-applicable', why: 'switched off in the rule sheet' };
    if (isDefaultRule(rule)) return { ...base, end: 'default', why: 'applied because the guidelines do not say' };
    if (status === 'index') return { ...base, end: 'done', why: 'set in the Index Builder from this rule sheet' };
    if (status === 'done' || status === 'clear') return { ...base, end: 'done', why: status === 'clear' ? 'checked: nothing to report' : 'applied in the formatted file' };
    if (status === 'conflict') return { ...base, end: 'decision', why: 'the guidelines say two different things about this setting', question: 'The guidelines give two different values for this setting. Which applies?' };
    if (status === 'flagged') {
      if (askedRules.has(rule.id)) return { ...base, end: 'decision', asked: askedRules.get(rule.id), why: `asked in ${askedRules.get(rule.id)} ${askedRules.get(rule.id) === 1 ? 'comment' : 'comments'} in the file` };
      if (settledBy.has(rule.id)) return { ...base, end: 'default', why: `settled by a default (${SETTLING_DEFAULTS.find(entry => entry.id === settledBy.get(rule.id))?.words ?? settledBy.get(rule.id)})` };
      return { ...base, end: 'done', why: 'what the checks found was done by the tool or put on the copyeditor’s list' };
    }
    const answer = answers.triage.get(rule.id);
    if (!answer || !TRIAGE_STATUSES.includes(answer.status)) return { ...base, end: rule.mode === 'supply' ? 'deliver' : 'decision', deliverable: 'other', why: 'not triaged', question: null };
    if (answer.status === 'deliver') return { ...base, end: 'deliver', deliverable: deliverKind(answer.deliverable), why: 'to hand in' };
    if (answer.status === 'decision') return { ...base, end: 'decision', why: 'a choice for the author or editor', question: answer.question ?? null };
    if (answer.status === 'copyedit') return { ...base, end: 'copyedit', why: 'for the copyeditor' };
    if (answer.status === 'not-applicable') return { ...base, end: 'not-applicable', why: 'does not concern this manuscript or this stage' };
    return { ...base, end: 'done', why: 'the formatting or the manuscript already meets it (the tool’s reading)' };
  });
}

export { GROUPED_CHECKS, FINDINGS_PER_UNIT };
