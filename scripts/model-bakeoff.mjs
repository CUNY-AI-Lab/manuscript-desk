// The model bake-off: runs every model the Formatter's own menu offers (modelMenu over the Gateway
// catalog) through an elimination ladder, cheap stages first, and drops a model at the first stage
// it fails, recording why. Each stage reuses the product's code and the existing measurements'
// scoring: extractRuleSheet and scoreSheet (scripts/generality.mjs) for the guidelines, labelRoles
// and scoreRoles (scripts/roles-eval.mjs) for the roles, and the agent spike's tools for driving an
// agent (scripts/spikes/agent/). The thresholds are fixed below, before any run, and written to
// docs/eval/model-bakeoff.md with the results.
//
//   CAIL_API_KEY=... npm run bakeoff -- [--models a,b] [--stages answers,agent,extraction,roles] [--repeat-agent 2]
//
// Every answer is cached in the private folder (work/bakeoff/answers.json, keyed by model, thinking
// setting and the whole payload) and every paid call is entered in work/bakeoff/ledger.jsonl at
// catalog prices; no call starts once the ledger reaches the cap (scripts/spikes/gateway.mjs). Prints
// counts, scores, costs and seconds only; never guideline or manuscript text, never the key.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractRuleSheet } from '../lib/rules/extract.js';
import { readDocx } from '../lib/docx/read.js';
import { labelRoles } from '../lib/roles/label.js';
import { modelMenu } from '../web/shared/models.js';
import { rolesPayload, settingsPayload, ROLES_OUTPUT_TOKENS, SETTINGS_WITH_SENTENCES_OUTPUT_TOKENS } from '../server/prompts.js';
import { readCaseFile, rulesPayload, scoreSheet, table } from './generality.mjs';
import { scoreRoles, selectChapters, spansFor } from './roles-eval.mjs';
import { BAKEOFF_DIR, CAP_DOLLARS, PRIVATE_ROOT, caseFolder, catalogRows, contentCall, createMeter, spentSoFar } from './spikes/gateway.mjs';
import { TOOLS, createSession } from './spikes/agent/tools.mjs';
import { AGENT_SYSTEM } from './spikes/agent/prompt.mjs';
import { probeMessage, probeState, scoreProbe } from './spikes/agent/probe.mjs';
import { runAgent } from './spikes/agent/loop.mjs';

const BASELINE = 'deepseek-v4.1-flash-1017';
const STAGES = ['answers', 'agent', 'extraction', 'roles'];

// Thresholds, fixed before the runs.
export const THRESHOLDS = Object.freeze({
  // 1. A rule sheet from the public fixture with no failed call, at least one rule kept, and every
  //    kept rule's quotation verified by code (extractRuleSheet drops the others), within 180 s a call.
  answers: { maxSeconds: 180 },
  // 2. The invented document: finish called, at least 90% of tool calls valid, no harmful operation,
  //    at least 5 of the 6 tasks right, in every run.
  agent: { runs: 2, maxTurns: 16 },
  // 3. Five guideline cases (named in the private work/bakeoff/extraction-cases.json: the Brill
  //    guidelines, a university's dissertation guide, a journal's article guide, a monograph guide
  //    that was hard before and an edited-collection guide): expected rules found at least 90% of the
  //    baseline's count and no case below 70%; quotations verified (kept of kept and left out) at least 90%.
  extraction: { casesFile: 'extraction-cases.json', relative: 0.9, caseFloor: 0.7, verified: 0.9 },
  // 4. The Brill manuscript's dev chapters with the product's settings: structural accuracy no more
  //    than 3 points below the baseline's, body paragraphs given a structural role no more than 3 above.
  roles: { points: 3, bodyAsStructural: 3 },
});

const percent = (part, of) => (of > 0 ? `${((part / of) * 100).toFixed(1)}%` : '-');

// --- Stage 1: an answer in the required shape ------------------------------------------------

async function stageAnswers(model) {
  const read = await readCaseFile(new URL('../tests/fixtures/guidelines.docx', import.meta.url).pathname);
  if (!read.ok) throw new Error('The public fixture could not be read.');
  const result = {};
  for (const thinking of ['product', 'on']) {
    const { meter, tick } = createMeter();
    const callRules = contentCall({ payloadOf: (request, row) => rulesPayload({ ...request, row }), thinking, expected: 6000, tag: `answers:${thinking}`, meter: tick });
    const start = performance.now();
    let outcome;
    try {
      const { sheet, failures } = await extractRuleSheet({ docType: 'article', model, guidelines: [read.text], callRules });
      outcome = { kept: sheet.rules.length, dropped: sheet.dropped, failures: failures.map(failure => failure.code) };
    } catch (error) {
      outcome = { kept: 0, dropped: 0, failures: [error.code ?? 'error'] };
    }
    const slowest = meter.calls ? meter.seconds / meter.calls : 0;
    result[thinking] = { ...outcome, calls: meter.calls, cost: meter.cost, seconds: (performance.now() - start) / 1000, meanCallSeconds: slowest, failed: meter.failures };
  }
  const product = result.product;
  const pass = product.failures.length === 0 && product.kept > 0 && product.meanCallSeconds <= THRESHOLDS.answers.maxSeconds;
  return { pass, why: pass ? null : `product settings: ${product.failures.length} failed calls (${[...new Set(product.failures)].join(', ') || 'none'}), ${product.kept} rules kept`, product, thinkingOn: result.on, thinkingOnAnswers: result.on.failures.length === 0 && result.on.kept > 0 };
}

// --- Stage 2: driving the agent's tools ------------------------------------------------------

async function stageAgent(model) {
  const runs = [];
  for (let run = 1; run <= THRESHOLDS.agent.runs; run += 1) {
    const state = probeState();
    const { session, handlers } = createSession(state);
    const { stats } = await runAgent({ model, thinking: 'off', system: AGENT_SYSTEM, user: probeMessage(state), tools: TOOLS, handlers, maxTurns: THRESHOLDS.agent.maxTurns, tag: 'agent-probe', salt: `probe-run${run}` });
    runs.push({ ...scoreProbe(session, stats), turns: stats.turns, toolCalls: stats.toolCalls, cost: stats.cost, seconds: stats.seconds, stopped: stats.stopped, failures: stats.failures });
  }
  const pass = runs.every(run => run.pass);
  return { pass, why: pass ? null : runs.map((run, at) => `run ${at + 1}: ${run.right}/6 tasks, ${run.harmful} harmful, ${(run.valid * 100).toFixed(0)}% valid, stopped ${run.stopped}`).join('; '), runs };
}

// --- Stage 3: guideline extraction on five cases ---------------------------------------------

async function loadCases() {
  const cases = [];
  const names = JSON.parse(await readFile(path.join(BAKEOFF_DIR, THRESHOLDS.extraction.casesFile), 'utf8')).cases;
  for (const [n, name] of names.entries()) {
    const dir = path.join(PRIVATE_ROOT, name);
    const expected = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8'));
    const files = expected.files ?? (await import('node:fs/promises')).readdir(dir).then(list => list.filter(file => /\.(pdf|docx|html|txt)$/iu.test(file)));
    const texts = [];
    for (const file of await files) { const read = await readCaseFile(path.join(dir, file)); if (read.ok) texts.push(read.text); }
    // Reported by position only: the folder names are publishers' names, which stay private.
    cases.push({ name, label: name === 'brill' ? 'brill' : `case ${n + 1}`, expected, texts });
  }
  return cases;
}

// The hand-made sheet's settings for the Brill case: slot and params, compared with a sheet's.
async function brillSettingsKey() {
  const hand = JSON.parse(await readFile(path.join(await caseFolder(), 'work', 'hand-sheet.json'), 'utf8'));
  return (hand.sheet ?? hand).rules.filter(rule => rule.slot).map(rule => ({ slot: rule.slot, params: rule.params }));
}
const sameParams = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

async function stageExtraction(model, cases, key) {
  const rows = [];
  let cost = 0, seconds = 0, calls = 0;
  for (const entry of cases) {
    const { meter, tick } = createMeter();
    const callRules = contentCall({ payloadOf: (request, row) => rulesPayload({ ...request, row }), expected: 6000, tag: 'extraction', meter: tick });
    const callSettings = contentCall({ payloadOf: (request, row) => settingsPayload({ ...request, row }), expected: SETTINGS_WITH_SENTENCES_OUTPUT_TOKENS, tag: 'extraction', meter: tick });
    const start = performance.now();
    let sheet = null, failures = [];
    try { ({ sheet, failures } = await extractRuleSheet({ docType: entry.expected.docType, model, guidelines: entry.texts, callRules, callSettings })); } catch (error) { failures = [{ code: error.code ?? 'error' }]; }
    const score = sheet ? scoreSheet(sheet, entry.expected) : { found: 0, of: entry.expected.rules.length };
    const settings = entry.name === 'brill' && sheet ? key.filter(want => sheet.rules.some(rule => rule.slot === want.slot && sameParams(rule.params, want.params))).length : null;
    rows.push({ name: entry.name, label: entry.label, found: score.found, of: score.of, kept: sheet?.rules.length ?? 0, dropped: sheet?.dropped ?? 0, failures: failures.length, settings, calls: meter.calls, cost: meter.cost, seconds: (performance.now() - start) / 1000 });
    cost += meter.cost; seconds += meter.seconds; calls += meter.calls;
  }
  return { rows, cost, seconds, calls, found: rows.reduce((sum, row) => sum + row.found, 0), of: rows.reduce((sum, row) => sum + row.of, 0), kept: rows.reduce((sum, row) => sum + row.kept, 0), dropped: rows.reduce((sum, row) => sum + row.dropped, 0), settingsOf: key.length };
}

// --- Stage 4: paragraph roles on the Brill dev chapters --------------------------------------

async function stageRoles(model) {
  const folder = await caseFolder();
  const gold = JSON.parse(await readFile(path.join(folder, 'gold-roles.json'), 'utf8'));
  const read = readDocx(new Uint8Array(await readFile(path.join(folder, 'source.docx'))));
  const { chapters } = selectChapters(gold, 'dev');
  const { meter, tick } = createMeter();
  const callRoles = contentCall({ payloadOf: (request, row) => rolesPayload({ ...request, row }), expected: ROLES_OUTPUT_TOKENS, tag: 'roles', meter: tick });
  const predicted = {};
  let failures = 0;
  const start = performance.now();
  for (const [from, to] of spansFor(chapters)) {
    const result = await labelRoles({ paragraphs: read.paragraphs.slice(from, to + 1), model, callRoles, passageOptions: { total: read.paragraphs.length } });
    Object.assign(predicted, result.roles);
    failures += result.failures.length;
  }
  const score = scoreRoles({ gold: gold.gold, predicted, paragraphs: read.paragraphs, chapters });
  await writeFile(path.join(BAKEOFF_DIR, `roles-dev-${model}.json`), JSON.stringify({ model, roles: predicted }));
  return { scored: score.scored, correct: score.correct, structural: score.structural, structuralCorrect: score.structuralCorrect, bodyAsStructural: score.bodyAsStructural, failures, calls: meter.calls, cost: meter.cost, seconds: (performance.now() - start) / 1000, callSeconds: meter.seconds };
}

// --- The ladder -------------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({ options: { models: { type: 'string' }, stages: { type: 'string' } } });
  const stages = (values.stages ?? STAGES.join(',')).split(',');
  const catalog = await catalogRows();
  const menu = modelMenu({ data: [...catalog.values()] }).map(entry => entry.id);
  const models = values.models ? values.models.split(',') : menu;
  console.log(`Candidates (the Formatter's model menu from the Gateway catalog): ${menu.join(', ')}. Spent before this run: $${(await spentSoFar()).toFixed(4)} of the $${CAP_DOLLARS} cap.`);
  const results = Object.fromEntries(models.map(model => [model, { alive: true, stages: {} }]));
  const eliminate = (model, stage, why) => { results[model].alive = false; results[model].eliminated = { stage, why }; console.log(`  ${model}: eliminated at ${stage}: ${why}`); };
  // The baseline runs every stage so that relative floors have something to stand on.
  const order = [BASELINE, ...models.filter(model => model !== BASELINE)].filter(model => models.includes(model));

  if (stages.includes('answers')) {
    console.log('\nStage 1: answers in the required JSON shape (public fixture)');
    for (const model of order) {
      const outcome = await stageAnswers(model);
      results[model].stages.answers = outcome;
      console.log(`  ${model}: product settings ${outcome.product.kept} rules kept, ${outcome.product.dropped} left out, ${outcome.product.failures.length} failed, ${outcome.product.calls} calls, ${outcome.product.meanCallSeconds.toFixed(1)} s a call; thinking on: ${outcome.thinkingOnAnswers ? 'answers' : `does not answer (${[...new Set(outcome.thinkingOn.failures)].join(', ')})`} (${outcome.thinkingOn.meanCallSeconds.toFixed(1)} s a call)`);
      if (!outcome.pass) eliminate(model, 'answers', outcome.why);
    }
  }
  if (stages.includes('agent')) {
    console.log('\nStage 2: driving the agent tools on an invented document (two runs)');
    for (const model of order.filter(model => results[model].alive)) {
      const outcome = await stageAgent(model);
      results[model].stages.agent = outcome;
      for (const [at, run] of outcome.runs.entries()) console.log(`  ${model} run ${at + 1}: ${run.right}/6 tasks (${Object.entries(run.tasks).filter(([, ok]) => !ok).map(([name]) => name).join(', ') || 'all'} ${Object.values(run.tasks).every(Boolean) ? '' : 'missed'}), ${run.harmful} harmful, ${run.refused} refused, ${(run.valid * 100).toFixed(0)}% valid of ${run.toolCalls} calls, ${run.turns} turns, stopped ${run.stopped}, $${run.cost.toFixed(4)}, ${run.seconds.toFixed(0)} s`);
      if (!outcome.pass) eliminate(model, 'agent', outcome.why);
    }
  }
  if (stages.includes('extraction')) {
    console.log('\nStage 3: guideline extraction on five cases');
    const cases = await loadCases();
    const key = await brillSettingsKey();
    let base = null;
    for (const model of order.filter(model => results[model].alive || model === BASELINE)) {
      const outcome = await stageExtraction(model, cases, key);
      results[model].stages.extraction = outcome;
      if (model === BASELINE) base = outcome;
      console.log(`  ${model}: found ${outcome.found}/${outcome.of} (${percent(outcome.found, outcome.of)}), quotations verified ${percent(outcome.kept, outcome.kept + outcome.dropped)}, Brill settings ${outcome.rows.find(row => row.name === 'brill')?.settings}/${outcome.settingsOf}, ${outcome.calls} calls, $${outcome.cost.toFixed(4)}`);
      console.log(table(['Case', 'Found', 'Kept', 'Left out', 'Failures', 'Calls', 'Cost', 'Seconds'], outcome.rows.map(row => [row.label, `${row.found}/${row.of}`, row.kept, row.dropped, row.failures, row.calls, `$${row.cost.toFixed(4)}`, row.seconds.toFixed(0)])).split('\n').map(line => `    ${line}`).join('\n'));
      if (model === BASELINE || !results[model].alive) continue;
      const lowCase = outcome.rows.find(row => row.found < row.of * THRESHOLDS.extraction.caseFloor);
      const verified = outcome.kept / Math.max(1, outcome.kept + outcome.dropped);
      if (outcome.found < base.found * THRESHOLDS.extraction.relative) eliminate(model, 'extraction', `found ${outcome.found}, under ${Math.ceil(base.found * THRESHOLDS.extraction.relative)} (90% of the baseline's ${base.found})`);
      else if (lowCase) eliminate(model, 'extraction', `${lowCase.label} at ${percent(lowCase.found, lowCase.of)}`);
      else if (verified < THRESHOLDS.extraction.verified) eliminate(model, 'extraction', `quotations verified ${percent(outcome.kept, outcome.kept + outcome.dropped)}`);
    }
  }
  if (stages.includes('roles')) {
    console.log('\nStage 4: paragraph roles on the Brill dev chapters');
    let base = null;
    for (const model of order.filter(model => results[model].alive || model === BASELINE)) {
      const outcome = await stageRoles(model);
      results[model].stages.roles = outcome;
      if (model === BASELINE) base = outcome;
      console.log(`  ${model}: accuracy ${percent(outcome.correct, outcome.scored)} of ${outcome.scored}, structural ${outcome.structuralCorrect}/${outcome.structural} (${percent(outcome.structuralCorrect, outcome.structural)}), body as structural ${outcome.bodyAsStructural}, ${outcome.failures} failed passages, ${outcome.calls} calls, $${outcome.cost.toFixed(4)}, ${outcome.seconds.toFixed(0)} s`);
      if (model === BASELINE || !results[model].alive) continue;
      const points = 100 * (base.structuralCorrect / base.structural - outcome.structuralCorrect / outcome.structural);
      if (points > THRESHOLDS.roles.points) eliminate(model, 'roles', `structural accuracy ${points.toFixed(1)} points below the baseline`);
      else if (outcome.bodyAsStructural > base.bodyAsStructural + THRESHOLDS.roles.bodyAsStructural) eliminate(model, 'roles', `${outcome.bodyAsStructural} body paragraphs given a structural role (baseline ${base.bodyAsStructural})`);
    }
  }
  console.log(`\nSurvivors: ${models.filter(model => results[model].alive).join(', ') || 'none'}. Spent so far: $${(await spentSoFar()).toFixed(4)} of the $${CAP_DOLLARS} cap.`);
  await writeFile(path.join(BAKEOFF_DIR, `results-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`), JSON.stringify({ thresholds: THRESHOLDS, results }, null, 1));
}

main().catch(error => { console.error(`The run stopped: ${error?.message ?? error}`); process.exitCode = 1; });
