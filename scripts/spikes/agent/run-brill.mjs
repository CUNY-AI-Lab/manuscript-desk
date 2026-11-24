// The agent spike on the Brill case: the product's pipeline runs first (its own labels and rule
// sheet from the round-6 page run, the reading check from the cache), then a tool-calling model
// works on what the pipeline hands back, "decide and do, then tell", through the tools in
// tools.mjs; code applies the spec (execute.mjs), the pipeline's checks run again on the result, a
// second round decides the findings that are new, and the result is scored against the hand job:
// questions left, roles and styles against the gold and the reference, words, validity.
//
//   CAIL_API_KEY=... node scripts/spikes/agent/run-brill.mjs --model <id> [--thinking off|on] [--tag <name>] [--turns 40] [--only-chapters <keys>]
//
// Prints counts only. The formatted file, the spec, the decisions and the summary go to the case's
// private work/bakeoff/ folder (they hold manuscript text).

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { matchComments, placesOf, ranker } from '../../todos-eval.mjs';
import { addRows, compare, readUnits } from '../../format-eval.mjs';
import { scoreRoles } from '../../roles-eval.mjs';
import { SLOTS } from '../../../lib/rules/schema.js';
import { runChecks } from '../../../lib/checks/run.js';
import { readingFindings, withoutRepeats } from '../../../lib/checks/reading.js';
import { commentsFor } from '../../../lib/todos/todos.js';
import { activeRules } from '../../../lib/todos/shared.js';
import { PRIVATE_ROOT, caseFolder, spentSoFar } from '../gateway.mjs';
import { checkedSheet, finishFile, readJson, runPipeline } from './pipeline.mjs';
import { applyTextOps, formatWith } from './execute.mjs';
import { TOOLS, createSession } from './tools.mjs';
import { AGENT_SYSTEM } from './prompt.mjs';
import { runAgent } from './loop.mjs';
import { classOf } from './questions.mjs';

const cut = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);

export async function loadCase(name) {
  const folder = await caseFolder(name);
  const work = path.join(folder, 'work');
  const referenceName = (await readdir(path.join(folder, 'reference'))).find(file => /formatted manuscript.*\.docx$/iu.test(file));
  return {
    folder, work,
    source: new Uint8Array(await readFile(path.join(folder, 'source.docx'))),
    gold: await readJson(path.join(folder, 'gold-roles.json')),
    key: await readJson(path.join(work, 'comments-key.json')),
    reference: new Uint8Array(await readFile(path.join(folder, 'reference', referenceName))),
    styleMap: (await readJson(new URL('../../../docs/eval/brill-style-map.json', import.meta.url).pathname)).map,
    roles: (await readJson(path.join(work, 'page-run-6', 'roles.json'))).roles,
    sheet: checkedSheet(await readJson(path.join(work, 'page-run-6', 'rule-sheet.json'))),
  };
}

/** What the agent is told first: the book's shape, the settings, the findings, the rules to triage. */
export function briefing({ run, sheet, findings, rules, round }) {
  const { paragraphs } = run.read;
  const chapters = run.report.chapters.map((chapter, n) => {
    const head = paragraphs.slice(chapter.first, chapter.first + 6).filter(entry => !entry.hints.empty).slice(0, 4).map(entry => `[${entry.index}] ${cut(entry.text, 140)}`).join(' | ');
    return `chapter ${n}: paragraphs ${chapter.first}-${chapter.last}: ${head}`;
  });
  const firstChapter = run.report.chapters[0]?.first ?? 0;
  const settings = sheet.rules.filter(rule => rule.slot).map(rule => `${rule.slot} = ${JSON.stringify(rule.params)}${rule.source?.kind === 'guidelines' ? ` (guidelines: "${cut(rule.source.quote, 160)}")` : ''}`);
  const silent = Object.keys(SLOTS).filter(slot => ['layout.spacing', 'layout.margins', 'layout.page-numbers', 'chapters.label', 'references.hanging-indent'].includes(slot) && !sheet.rules.some(rule => rule.slot === slot));
  return [
    round === 1 ? `An edited volume for a publisher, read from a Word file with ${paragraphs.length} paragraphs (0 to ${paragraphs.length - 1}); the front matter is paragraphs 0-${firstChapter - 1}. A labelling model gave each paragraph a role and the formatter will style it by role; the checks then produced the findings below. Do the work: fix roles, make the formatting-level fixes, decide every finding and every rule.` : 'The formatting ran again with your operations. These findings are new or changed: decide them, then call finish.',
    ...(round === 1 ? ['', 'Chapters (title block lines):', ...chapters, '', 'Settings the rule sheet sets:', ...settings, `The guidelines are silent on: ${silent.join(', ') || 'none of the usual layout settings'}.`] : []),
    '', `Findings (${findings.length}):`,
    ...findings.map(finding => `${finding.id} (${finding.kind}) at paragraph ${finding.paragraph ?? '-'}: ${cut(finding.message.replace(/\s+/gu, ' '), 320)}`),
    ...(rules.length ? ['', `Rules of the guidelines to triage (${rules.length}):`, ...rules.map(rule => `${rule.id} (${rule.mode}, ${rule.category}): ${cut(rule.statement, 160)}`)] : []),
  ].join('\n');
}

const UNIT_NOTE = 'This message is one part of the job. Do this part completely with the context given (read more only when you must), decide every item it lists, then call finish with one line on what you did.';

// The tools of a unit: the settings only in the settings unit, the rules' triage only in theirs.
const UNIT_TOOLS = ['read_paragraphs', 'find_text', 'set_roles', 'replace_text', 'delete_paragraphs', 'resolve_findings', 'ask_author', 'finish'];
const textLine = (paragraphs, roles, index, n = 300) => { const entry = paragraphs[index]; return entry ? `[${index}] (${roles[index] ?? (entry.hints.empty ? 'empty' : 'none')})${entry.hints.footnote ? ' (has a note)' : ''} ${cut(entry.text, n)}` : ''; };
const nonEmptyNear = (paragraphs, index, step) => { for (let at = index + step; at >= 0 && at < paragraphs.length; at += step) if (!paragraphs[at].hints.empty) return at; return null; };

/** The units of work: the settings, the front matter, the findings chapter by chapter, the rules. */
export function workUnits({ run, roles, sheet, findings, rules, settingsUnit = true }) {
  const { paragraphs } = run.read;
  const chapters = run.report.chapters;
  const firstChapter = chapters[0]?.first ?? 0;
  const chapterOf = index => (index === null || index === undefined || index < firstChapter ? -1 : chapters.findIndex(chapter => index >= chapter.first && index <= chapter.last));
  const withContext = finding => {
    const lines = [`${finding.id} (${finding.kind}) at paragraph ${finding.paragraph ?? '-'}: ${cut(finding.message.replace(/\s+/gu, ' '), 360)}`];
    if (Number.isInteger(finding.paragraph)) {
      const before = nonEmptyNear(paragraphs, finding.paragraph, -1), after = nonEmptyNear(paragraphs, finding.paragraph, 1);
      if (['repeated-author-dash', 'stray-or-duplicated-text', 'quotation-lines-joined'].includes(finding.kind) && before !== null) lines.push(`    before: ${textLine(paragraphs, roles, before, 220)}`);
      lines.push(`    here:   ${textLine(paragraphs, roles, finding.paragraph, finding.kind === 'contents-mismatch' ? 200 : 420)}`);
      if (['stray-or-duplicated-text'].includes(finding.kind) && after !== null) lines.push(`    after:  ${textLine(paragraphs, roles, after, 220)}`);
    }
    return lines.join('\n');
  };
  const units = [];
  if (settingsUnit) {
    const settings = sheet.rules.filter(rule => rule.slot).map(rule => `${rule.slot} = ${JSON.stringify(rule.params)}${rule.source?.kind === 'guidelines' ? ` (guidelines: "${cut(rule.source.quote, 200)}")` : ''}`);
    const silent = ['layout.spacing', 'layout.margins', 'layout.page-numbers', 'chapters.label', 'references.hanging-indent'].filter(slot => !sheet.rules.some(rule => rule.slot === slot));
    units.push({ name: 'settings', turns: 6, tools: ['set_setting', 'clear_setting', 'finish'], user: [`An edited volume of ${chapters.length} chapters for a publisher. The settings the rule sheet read from the guidelines are below, each with the sentence it came from. Check each against its sentence: clear a setting that was misread (a sentence about something else). The guidelines are silent on: ${silent.join(', ') || 'none'}; choose a sensible submission default for each that a publisher would expect (set_setting with source "default"). Then finish.`, '', ...settings].join('\n') });
  }
  // The front matter, with its findings.
  const front = findings.filter(finding => chapterOf(finding.paragraph) === -1);
  const frontLines = paragraphs.slice(0, firstChapter).filter(entry => !entry.hints.empty).map(entry => textLine(paragraphs, roles, entry.index, 200));
  if (settingsUnit || front.length) units.push({ name: 'front', turns: 8, tools: [...UNIT_TOOLS, 'insert_contents'], user: [`The front matter of the book (paragraphs 0-${firstChapter - 1}), then its findings. The chapters' titles as the title pages give them: ${chapters.map((chapter, n) => `ch ${n} [${chapter.first}] ${cut(paragraphs[chapter.first]?.text ?? '', 90)}`).join(' | ')}. A typed contents list that does not match the chapters is replaced by a generated one (delete the typed entry lines, insert_contents where they stood, keep the heading); fix wrong roles; decide every finding.`, '', ...(settingsUnit ? frontLines : []), '', `Findings (${front.length}):`, ...front.map(withContext)].join('\n') });
  // The chapters' findings, at most 18 a unit.
  chapters.forEach((chapter, n) => {
    const own = findings.filter(finding => chapterOf(finding.paragraph) === n);
    for (let at = 0; at < own.length; at += 18) {
      const batch = own.slice(at, at + 18);
      units.push({ name: `ch${n}${at ? `-${at / 18 + 1}` : ''}`, turns: 8, user: [`Chapter ${n} (paragraphs ${chapter.first}-${chapter.last}). Its title block: ${paragraphs.slice(chapter.first, chapter.first + 5).filter(entry => !entry.hints.empty).map(entry => textLine(paragraphs, roles, entry.index, 160)).join(' | ')}`, '', `Findings (${batch.length}), each with its paragraph:`, ...batch.map(withContext)].join('\n') });
    }
  });
  for (let at = 0; at < rules.length; at += 50) {
    const batch = rules.slice(at, at + 50);
    units.push({ name: `rules${at / 50 + 1}`, turns: 5, tools: ['triage_rules', 'finish'], user: [`Rules of the publisher's guidelines that no check verified (${batch.length} of ${rules.length}). The formatting already sets styles, numbering and the settings; the tool also writes an abstracts-and-keywords file, a running-titles file and an alt-text template. Triage every rule.`, '', ...batch.map(rule => `${rule.id} (${rule.mode}, ${rule.category}): ${cut(rule.statement, 180)}`)].join('\n') });
  }
  return units;
}

function mergeStats(list) {
  const total = { turns: 0, calls: 0, cached: 0, prompt: 0, completion: 0, cost: 0, seconds: 0, toolCalls: 0, malformed: 0, unknownTool: 0, byTool: {} };
  for (const entry of list) { for (const field of Object.keys(total)) if (typeof total[field] === 'number') total[field] += entry[field] ?? 0; for (const [name, count] of Object.entries(entry.byTool ?? {})) total.byTool[name] = (total.byTool[name] ?? 0) + count; }
  return total;
}

const findingKey = finding => `${finding.kind}\u0000${finding.paragraphIndex ?? null}`;

async function main() {
  const { values } = parseArgs({ options: { model: { type: 'string' }, thinking: { type: 'string', default: 'off' }, tag: { type: 'string', default: '' }, turns: { type: 'string', default: '40' }, 'round2-turns': { type: 'string', default: '15' }, budget: { type: 'string', default: '3' } } });
  const model = values.model;
  if (!model) throw new Error('Name the model with --model.');
  const tag = `${model}-${values.thinking}${values.tag ? `-${values.tag}` : ''}`;
  const out = path.join(PRIVATE_ROOT, 'work', 'bakeoff', `agent-${tag}`);
  await mkdir(out, { recursive: true });
  const c = await loadCase();
  const started = performance.now();
  const spentBefore = await spentSoFar();

  // The product's pipeline, as the page runs it.
  const base = await runPipeline({ source: c.source, roles: c.roles, sheet: c.sheet, work: c.work });
  const baseScore = await score({ c, run: base, roles: c.roles, bytes: base.formatted.bytes, label: 'pipeline' });

  // Round 1: the agent on the pipeline's findings and the rules it left open.
  const ids = new Map();
  const findings1 = base.findings.map((finding, at) => { const id = `F${at + 1}`; ids.set(finding, id); return { id, kind: finding.kind, paragraph: finding.paragraphIndex ?? null, message: finding.message ?? '' }; });
  const statuses = new Map(base.statuses.map(entry => [entry.rule?.id ?? entry.id, entry.status]));
  const openRules = activeRules(c.sheet).filter(rule => ['supply', 'unchecked', 'flagged', 'conflict'].includes(statuses.get(rule.id)));
  const ruleIds = new Map(openRules.map((rule, at) => [`R${at + 1}`, rule]));
  const state = {
    paragraphs: base.read.paragraphs.map(entry => ({ index: entry.index, text: entry.text, empty: entry.hints.empty, note: Boolean(entry.hints.footnote) })),
    roles: { ...c.roles }, findings: findings1,
    rules: [...ruleIds].map(([id, rule]) => ({ id, mode: rule.mode, category: rule.category, statement: rule.statement })),
    settings: Object.fromEntries(c.sheet.rules.filter(rule => rule.slot).map(rule => [rule.slot, rule.params])),
  };
  const { session, handlers } = createSession(state);
  const log = line => console.error(`${model}: ${line}`);
  // The work in units, each a short conversation of its own with the context it needs attached, so
  // that a model does not spend its turns reading the whole book first (the first measured run, with
  // one conversation for everything, read for 40 turns and decided nothing).
  const notes = [];
  const allStats = [];
  const runUnits = async (units, unitHandlers, round) => {
    for (const unit of units) {
      const spentNow = allStats.reduce((sum, entry) => sum + entry.cost, 0);
      if (spentNow >= Number(values.budget)) { log(`budget reached before ${unit.name}`); break; }
      session.finished = null;
      const tools = TOOLS.filter(tool => (unit.tools ?? UNIT_TOOLS).includes(tool.function.name));
      const { stats } = await runAgent({ model, thinking: values.thinking, system: `${AGENT_SYSTEM}\n\n${UNIT_NOTE}`, user: unit.user, tools, handlers: unitHandlers, maxTurns: unit.turns ?? Number(values.turns), tag: `agent-brill:${tag}`, salt: `${tag}-${round}-${unit.name}`, readTurns: unit.readTurns ?? 2, log: line => log(`${unit.name}: ${line}`), budget: Number(values.budget) - spentNow });
      allStats.push(stats);
      if (session.finished) notes.push(`${unit.name}: ${session.finished}`);
      if (stats.stopped === 'spend_cap') break;
    }
  };
  await runUnits(workUnits({ run: base, roles: session.roles, sheet: c.sheet, findings: findings1, rules: state.rules }), handlers, 'r1');

  // Apply roles and settings, run the checks again.
  const formatted1 = formatWith({ source: c.source, roles: session.roles, sheet: c.sheet, settings: session.settings });
  const again = runChecks({ paragraphs: base.read.paragraphs, roles: session.roles, report: formatted1.report, sheet: formatted1.sheet });
  // The reading check's findings are the pipeline's (the agent changed no text the reader reads,
  // except its own declared fixes); they carry over with the agent's decisions.
  const readingKept = base.findings.filter(finding => finding.check === 'reading');
  const decidedByKey = new Map();
  for (const [finding, id] of ids) if (session.decisions.has(id)) decidedByKey.set(findingKey(finding), session.decisions.get(id));
  const after = [...again.findings, ...readingKept];
  const newOnes = after.filter(finding => !decidedByKey.has(findingKey(finding)) && finding.kind !== 'formatting-summary');

  // Round 2: the findings the first round did not decide (new ones, and any it left).
  const ids2 = new Map();
  if (newOnes.length && !allStats.some(entry => entry.stopped === 'spend_cap')) {
    const findings2 = newOnes.map((finding, at) => { const id = `G${at + 1}`; ids2.set(finding, id); return { id, kind: finding.kind, paragraph: finding.paragraphIndex ?? null, message: finding.message ?? '' }; });
    const state2 = { ...state, findings: [...findings1, ...findings2] };
    const handlers2 = createSessionContinuing(session, state2, handlers);
    await runUnits(workUnits({ run: { ...base, report: formatted1.report }, roles: session.roles, sheet: formatted1.sheet, findings: findings2, rules: [], settingsUnit: false }), handlers2, 'r2');
    for (const [finding, id] of ids2) if (session.decisions.has(id)) decidedByKey.set(findingKey(finding), session.decisions.get(id));
  }
  session.finished = notes.join('\n');
  const round1 = { stats: mergeStats(allStats) };
  const round2 = null;

  // The final file: roles and settings formatted (again, with any round-2 changes), text operations
  // as tracked changes, the findings the agent kept as comments, its questions, its summary.
  const formatted = formatWith({ source: c.source, roles: session.roles, sheet: c.sheet, settings: session.settings });
  const finalChecks = runChecks({ paragraphs: base.read.paragraphs, roles: session.roles, report: formatted.report, sheet: formatted.sheet });
  const allFindings = [...finalChecks.findings, ...readingKept];
  const decisionOf = finding => decidedByKey.get(findingKey(finding)) ?? null;
  const kept = allFindings.filter(finding => finding.kind !== 'formatting-summary' && (decisionOf(finding)?.decision ?? 'ask') === 'ask');
  const copyedit = allFindings.filter(finding => decisionOf(finding)?.decision === 'dismiss' && /copyedit/iu.test(decisionOf(finding).reason));
  const undecided = allFindings.filter(finding => finding.kind !== 'formatting-summary' && !decisionOf(finding));
  const ops = applyTextOps({ bytes: formatted.bytes, map: [...formatted.report.map], spec: session.spec });
  const report = { ...formatted.report, map: ops.map };
  const questionFindings = kept.map(finding => ({ ...finding, message: decisionOf(finding)?.question ? `${decisionOf(finding).question}\n\n(${finding.message})` : finding.message }));
  const summaryText = `What the agent did and decided (${model}):\n${session.finished ?? '(no summary: the agent did not call finish)'}\n\nDefaults chosen where the guidelines are silent: ${Object.entries(session.settings).filter(([, entry]) => entry.source === 'default').map(([slot, entry]) => `${slot} ${JSON.stringify(entry.params)}`).join('; ') || 'none'}.\nText changes made (tracked): ${ops.applied.filter(op => op.op !== 'insert_contents').length}. Possible slips left for the copyeditor: ${copyedit.length}.`;
  const comments = [{ sourceIndex: null, text: summaryText }, ...commentsFor(questionFindings, formatted.sheet), ...session.asks.map(ask => ({ sourceIndex: ask.paragraph, text: ask.question }))];
  const file = finishFile({ source: c.source, bytes: ops.bytes, report, comments, declared: ops.declared });
  await writeFile(path.join(out, 'formatted.docx'), file.bytes);
  await writeFile(path.join(out, 'spec.json'), JSON.stringify({ model, thinking: values.thinking, spec: session.spec, settings: session.settings, decisions: [...session.decisions], triage: [...session.triage].map(([id, entry]) => [id, ruleIds.get(id)?.id, entry]), asks: session.asks, refused: session.refused, textRefused: ops.refused.map(entry => ({ op: entry.op.op, paragraph: entry.op.paragraph ?? entry.op.from, reason: entry.reason })), summary: session.finished, copyedit: copyedit.map(finding => ({ kind: finding.kind, paragraph: finding.paragraphIndex, message: finding.message })) }, null, 1));

  const agentScore = await score({ c, run: { read: base.read, report, findings: [...kept, ...session.asks.map(ask => ({ kind: 'agent-question', paragraphIndex: ask.paragraph }))] }, roles: session.roles, bytes: file.bytes, label: 'agent' });
  const triage = [...session.triage.values()].reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] ?? 0) + 1 }), {});
  const seconds = (performance.now() - started) / 1000;
  const stats = allStats;
  const sum = field => stats.reduce((total, entry) => total + entry[field], 0);
  const result = {
    model, thinking: values.thinking, seconds, spent: (await spentSoFar()) - spentBefore,
    calls: sum('calls'), cost: sum('cost'), prompt: sum('prompt'), completion: sum('completion'), toolCalls: sum('toolCalls'), malformed: sum('malformed'), unknownTool: sum('unknownTool'), modelSeconds: sum('seconds'),
    units: stats.length, stopped: stats.reduce((counts, entry) => ({ ...counts, [entry.stopped]: (counts[entry.stopped] ?? 0) + 1 }), {}), byTool: round1.stats.byTool,
    ops: session.spec.reduce((counts, op) => ({ ...counts, [op.op]: (counts[op.op] ?? 0) + 1 }), {}),
    refused: session.refused.length, textRefused: ops.refused.length, textApplied: ops.applied.length,
    defaults: Object.entries(session.settings).map(([slot, entry]) => `${slot}=${JSON.stringify(entry.params)} (${entry.source})`),
    decisions: [...session.decisions.values()].reduce((counts, entry) => ({ ...counts, [entry.decision]: (counts[entry.decision] ?? 0) + 1 }), {}),
    findings: { first: findings1.length - 0, second: ids2.size, final: allFindings.length, kept: kept.length, copyedit: copyedit.length, undecidedLeftAsQuestions: undecided.length },
    rules: { open: openRules.length, triage, untriaged: openRules.length - session.triage.size },
    asks: session.asks.length, comments: comments.length,
    words: file.words, rejectGivesSource: file.rejectGivesSource, wordCounts: file.wordCounts, valid: file.validity.ok, problems: file.validity.ok ? [] : file.validity.problems.map(problem => `${problem.code} x${problem.count}`),
    pipeline: baseScore, agent: agentScore,
    handOps: await scoreOps({ c, session }),
  };
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
}

/** The agent's operations against the hand job's (work/bakeoff-hand-ops.json, private): counts only. */
async function scoreOps({ c, session }) {
  const hand = await readJson(path.join(c.work, 'bakeoff-hand-ops.json'));
  if (!hand) return null;
  const deletes = session.spec.filter(op => op.op === 'delete');
  const replaces = session.spec.filter(op => op.op === 'replace_text');
  const overlaps = (op, [from, to]) => !(op.to < from || op.from > to);
  const [cFrom, cTo] = hand.contents;
  const contentsDeleted = deletes.filter(op => overlaps(op, [cFrom, cTo])).reduce((sum, op) => sum + Math.min(op.to, cTo) - Math.max(op.from, cFrom) + 1, 0);
  const handRanges = [...hand.drops, hand.contents];
  const wrongDeletes = deletes.filter(op => !handRanges.some(range => overlaps(op, range)));
  const dashRight = hand.dash.filter(index => replaces.some(op => op.paragraph === index && !/[—–]{2,}/u.test(op.after) && op.after.trim().startsWith(hand.dashAfter[index].replace(/\.$/u, ''))));
  const dashTried = hand.dash.filter(index => replaces.some(op => op.paragraph === index));
  const titleCaps = hand.titleCaps.filter(index => replaces.some(op => op.paragraph === index));
  const handReplaceAt = new Set([...hand.dash, ...hand.titleCaps]);
  // The setting in force: the agent's, else the rule sheet's.
  const effective = slot => (session.settings[slot] ? session.settings[slot].params : c.sheet.rules.find(rule => rule.slot === slot)?.params ?? null);
  const settings = Object.entries(hand.settings).map(([slot, params]) => ({ slot, agent: effective(slot), same: JSON.stringify(effective(slot)) === JSON.stringify(params) }));
  // A deletion next to a hand drop of the same length removes the other copy of a duplicate.
  const otherCopy = deletes.filter(op => !handRanges.some(range => overlaps(op, range)) && hand.drops.some(([from, to]) => op.to - op.from === to - from && Math.abs(op.from - (to + 1)) <= 1));
  return {
    drops: `${hand.drops.filter(range => deletes.some(op => overlaps(op, range))).length}/${hand.drops.length}`, otherCopyDeleted: otherCopy.length,
    contentsDeleted: `${contentsDeleted}/${cTo - cFrom + 1} paragraphs of the typed contents range`, contentsField: session.spec.some(op => op.op === 'insert_contents'),
    wrongDeletes: wrongDeletes.length, wrongDeletedWords: wrongDeletes.reduce((sum, op) => sum + op.words, 0),
    dash: `${dashRight.length}/${hand.dash.length} as the hand job (${dashTried.length} tried)`,
    titleCaps: `${titleCaps.length}/${hand.titleCaps.length}`,
    otherReplacements: replaces.filter(op => !handReplaceAt.has(op.paragraph)).length,
    settingsSameAsHand: `${settings.filter(entry => entry.same).length}/${settings.length}`, settings: settings.map(entry => `${entry.slot}: ${entry.same ? 'same' : entry.agent ? `different (${JSON.stringify(entry.agent)})` : 'not set'}`),
  };
}

// Round 2 reuses the session (its spec, roles and settings) with the new findings known.
function createSessionContinuing(session, state, handlers) {
  const fresh = createSession({ ...state, roles: session.roles });
  // Decisions and asks recorded by round 2 land in the same session.
  fresh.session.decisions = session.decisions; fresh.session.asks = session.asks; fresh.session.spec = session.spec; fresh.session.refused = session.refused; fresh.session.triage = session.triage; fresh.session.settings = session.settings;
  Object.defineProperty(fresh.session, 'finished', { get: () => session.finished, set: value => { session.finished = value; } });
  return fresh.handlers;
}

/** The scores against the hand job: questions, roles, styles. */
async function score({ c, run, roles, bytes, label }) {
  const { gold, key } = c;
  const chapterOf = index => (index === null || index === undefined ? null : gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key ?? null);
  const rankOf = ranker(run.read.paragraphs);
  const places = placesOf(run.findings);
  const { matched } = matchComments(key.comments, places, chapterOf, rankOf);
  // Any kind at the same place: an agent's own question has no kind of the key's.
  const near = key.comments.filter(comment => places.some(place => chapterOf(place.paragraphIndex) === (comment.chapter ?? null) && (comment.paragraph === null || comment.paragraph === undefined || (place.paragraphIndex !== null && place.paragraphIndex !== undefined && Math.abs(rankOf(place.paragraphIndex) - rankOf(comment.paragraph)) <= 2)))).length;
  const classes = {};
  for (const place of places) {
    const there = [...matched.values()].includes(place);
    const messages = run.findings.filter(finding => finding.kind === place.kind && (finding.paragraphIndex ?? null) === (place.paragraphIndex ?? null)).map(finding => finding.message ?? '');
    const cls = place.kind === 'formatting-summary' ? 'report' : there ? 'hand' : place.kind === 'agent-question' ? 'agent-question' : classOf(place, messages);
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  const all = [...gold.chapters, ...(gold.matter ?? [])];
  const rolesScore = scoreRoles({ gold: gold.gold, predicted: roles, paragraphs: run.read.paragraphs, chapters: all });
  // The hand job's questions (not its reports) with a comment of the tool at the same place.
  const keyClasses = await readJson(path.join(c.work, 'bakeoff-key-classes.json'));
  const isQuestion = comment => keyClasses?.questions.map(String).includes(String(comment.id));
  const nearPlace = comment => places.some(place => chapterOf(place.paragraphIndex) === (comment.chapter ?? null) && (comment.paragraph === null || comment.paragraph === undefined || (place.paragraphIndex !== null && place.paragraphIndex !== undefined && Math.abs(rankOf(place.paragraphIndex) - rankOf(comment.paragraph)) <= 2)));
  const keyQuestions = key.comments.filter(isQuestion);
  // The tool's places at which the hand job asked something (any kind, within two paragraphs).
  const placesAtHandQuestion = places.filter(place => keyQuestions.some(comment => chapterOf(place.paragraphIndex) === (comment.chapter ?? null) && (comment.paragraph === null || comment.paragraph === undefined || (place.paragraphIndex !== null && place.paragraphIndex !== undefined && Math.abs(rankOf(place.paragraphIndex) - rankOf(comment.paragraph)) <= 2)))).length;
  const result = { places: places.length, keyQuestions: keyQuestions.length, keyQuestionsCovered: keyQuestions.filter(nearPlace).length, placesAtHandQuestion, keyMatchedSameKind: matched.size, keyWithCommentNear: near, keyComments: key.comments.length, classes, roles: { scored: rolesScore.scored, correct: rolesScore.correct, structural: rolesScore.structural, structuralCorrect: rolesScore.structuralCorrect } };
  if (bytes) {
    const output = readUnits(bytes).units;
    const reference = readUnits(c.reference).units;
    const formattedChapter = index => run.report.chapters.some(chapter => index >= chapter.first && index <= chapter.last);
    const chapterOfOutput = unit => { const source = run.report.map[unit.position]?.source; if (source === undefined || source === null || source < 0 || !formattedChapter(source)) return null; return chapterOf(source) ?? gold.chapters.filter(chapter => chapter.first <= source).pop()?.key ?? null; };
    const chapterTitle = c.styleMap['heading 1'];
    const referenceRead = readUnits(c.reference);
    const firstChapterUnit = referenceRead.units.find(unit => unit.styleId === chapterTitle);
    const referenceStart = firstChapterUnit ? referenceRead.units.find(unit => unit.section === firstChapterUnit.section).position : 0;
    const { rows } = compare({ output, reference, map: c.styleMap, chapterOfOutput, referenceStart });
    const total = addRows([...rows.values()]);
    result.styles = { reference: total.reference, output: total.output, matched: total.exact + total.near, near: total.near, agree: total.agree, titleBlock: `${total.titleBlockAgree}/${total.titleBlock}` };
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(`The run stopped: ${error?.stack ?? error}`); process.exitCode = 1; });
