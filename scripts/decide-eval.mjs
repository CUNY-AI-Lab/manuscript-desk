// Measures the decide step against the pipeline alone and the hand job, on a private case, running
// the Formatter page's own code (buildOutputs in web/format/output-state.js) with its own labels and
// rule sheet, the reading check from the case's cache, and the decide step's units sent to the
// Gateway exactly as POST /manuscript/api/decide sends them (decidePayload in
// server/decide-prompts.js). It prints counts only; the formatted files and the per-run details go
// to the case's private work/decide/ folder.
//
//   CAIL_API_KEY=... npm run decide-eval -- [--case brill-dante] [--runs 2] [--no-render]
//   CAIL_API_KEY=... npm run decide-eval -- --dissertation owner-phd [--runs 1]
//
// What it reports, per run: comments in the file; of the hand job's questions, how many have a
// comment of the tool near (any comment, and question comments only); refusals by kind (the guards'
// count of what would have been wrong text changes) and text changes outside the declared
// mechanical kinds (must be 0); the operations against the hand job's; checklist rows; copyedit
// queries moved; undeclared word changes (0) and whether rejecting every change gives the source;
// the validator; appearance against the hand-formatted file through render-eval with LibreOffice;
// model calls, cost and minutes. Every answer is cached (work/decide/answers.json, keyed by the whole
// request and the run) and every paid call is entered in work/decide/ledger.jsonl; no call starts
// once the ledger reaches DECIDE_CAP dollars (default 8). The key is read only from CAIL_API_KEY.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { MODEL } from '../lib/calls/model.js';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { DECLARED } from '../lib/format/declared.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { presetSheet } from '../lib/presets/index.js';
import { validateSheet } from '../lib/rules/schema.js';
import { READING_THINKING, readingPayload, readingPrompt } from '../server/prompts.js';
import { decidePayload } from '../server/decide-prompts.js';
import { buildOutputs } from '../web/format/output-state.js';
import { costOf, readCatalog, table } from './generality.mjs';
import { ranker } from './todos-eval.mjs';

const GATEWAY = 'https://tools.ailab.gc.cuny.edu';
const PRIVATE = process.env.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(process.env.MANUSCRIPT_DESK_GUIDELINES) : fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));
const CAP = Number(process.env.DECIDE_CAP ?? 8);
const TIMEOUT_MS = 180000;
const run = promisify(execFile);
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };
const err = line => process.stderr.write(`${line}\n`);

// ---- The metered, cached Gateway ----

function createGateway({ folder }) {
  const cacheFile = path.join(folder, 'answers.json');
  const ledgerFile = path.join(folder, 'ledger.jsonl');
  let cache = null;
  let spent = 0;
  let rows = null;
  let writing = Promise.resolve();
  const meter = { calls: 0, cached: 0, cost: 0, prompt: 0, completion: 0, seconds: 0, refused: 0 };
  async function load() {
    if (cache) return;
    await mkdir(folder, { recursive: true });
    cache = (await readJson(cacheFile)) ?? {};
    for (const line of ((await readFile(ledgerFile, 'utf8').catch(() => '')).split('\n').filter(Boolean))) spent += JSON.parse(line).cost ?? 0;
    rows = (await readCatalog()) ?? new Map();
  }
  async function send(payload, { tag, salt }) {
    await load();
    const id = createHash('sha256').update(JSON.stringify({ salt, payload })).digest('hex');
    if (cache[id]) { meter.cached += 1; return cache[id]; }
    const key = process.env.CAIL_API_KEY?.trim();
    if (!key) throw Object.assign(new Error('no key'), { code: 'no_key' });
    if (spent >= CAP) throw Object.assign(new Error('spend cap'), { code: 'spend_cap' });
    const start = performance.now();
    let response, data;
    try {
      response = await fetch(`${GATEWAY}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
      data = await response.json().catch(() => null);
    } catch (error) {
      throw Object.assign(new Error('network'), { code: error?.name === 'TimeoutError' ? 'request_timeout' : 'network_error', retry: true });
    }
    const seconds = (performance.now() - start) / 1000;
    if (!response.ok) {
      meter.refused += 1;
      const retryAfter = Number(response.headers.get('retry-after')) || undefined;
      throw Object.assign(new Error('refused'), { code: typeof data?.error?.code === 'string' ? data.error.code : `http_${response.status}`, status: response.status, retry: response.headers.get('x-should-retry') === 'true', retryAfter });
    }
    const usage = { prompt: data?.usage?.prompt_tokens ?? 0, completion: data?.usage?.completion_tokens ?? 0 };
    const cost = costOf(usage, rows.get(payload.model)) ?? 0;
    const choice = data?.choices?.[0];
    const answer = { message: choice?.message ?? null, finish: choice?.finish_reason ?? null };
    cache[id] = answer;
    spent += cost;
    Object.assign(meter, { calls: meter.calls + 1, cost: meter.cost + cost, prompt: meter.prompt + usage.prompt, completion: meter.completion + usage.completion, seconds: meter.seconds + seconds });
    writing = writing.then(async () => {
      await writeFile(cacheFile, JSON.stringify(cache));
      await appendFile(ledgerFile, `${JSON.stringify({ at: new Date().toISOString(), tag, model: payload.model, cost, prompt: usage.prompt, completion: usage.completion, seconds })}\n`);
    });
    await writing;
    return answer;
  }
  return { send, meter, spent: async () => { await load(); return spent; }, rows: async () => { await load(); return rows; } };
}

// ---- A case ----

async function loadCase({ name, dissertation }) {
  if (dissertation) {
    const folder = path.join(PRIVATE, '.dissertation-manuscripts', dissertation);
    const labels = await readJson(path.join(folder, 'work', 'roles-r2.json'));
    return { folder, work: path.join(folder, 'work'), source: new Uint8Array(await readFile(path.join(folder, 'source.docx'))), roles: labels.roles, sheet: presetSheet('cuny-gc'), key: null, hand: null, reference: null };
  }
  const folder = path.join(PRIVATE, 'manuscripts', name);
  const work = path.join(folder, 'work');
  const sheet = validateSheet((await readJson(path.join(work, 'page-run-6', 'rule-sheet.json')))?.sheet ?? (await readJson(path.join(work, 'page-run-6', 'rule-sheet.json'))));
  if (!sheet.ok) throw new Error('The case\'s rule sheet is not valid.');
  const referenceName = (await readdir(path.join(folder, 'reference'))).find(file => /formatted manuscript.*\.docx$/iu.test(file));
  return {
    folder, work, name,
    source: new Uint8Array(await readFile(path.join(folder, 'source.docx'))),
    roles: (await readJson(path.join(work, 'page-run-6', 'roles.json'))).roles,
    sheet: sheet.sheet,
    gold: await readJson(path.join(folder, 'gold-roles.json')),
    key: await readJson(path.join(work, 'comments-key.json')),
    keyClasses: await readJson(path.join(work, 'bakeoff-key-classes.json')),
    hand: await readJson(path.join(work, 'bakeoff-hand-ops.json')),
    reference: referenceName ? path.join(folder, 'reference', referenceName) : null,
  };
}

/** The reading check from the case's cache (as todos-eval keeps it), asked of the Gateway when missing. */
function cachedReading({ c, gateway }) {
  const file = path.join(c.work, 'reading-answers.json');
  let cache = null;
  return async ({ unit }) => {
    cache ??= (await readJson(file))?.answers ?? {};
    const id = `${MODEL}\u0000${READING_THINKING}\u0000${readingPrompt()}\u0000${unit}`;
    if (typeof cache[id] === 'string' && !cache[id].startsWith('\u0000')) return cache[id];
    if (typeof cache[id] === 'string') throw Object.assign(new Error('model_output_limit'), { code: 'model_output_limit' });
    const rows = await gateway.rows();
    const answer = await gateway.send(readingPayload({ model: MODEL, unit, row: rows.get(MODEL) }), { tag: 'reading', salt: '' });
    if (answer.finish === 'length') throw Object.assign(new Error('model_output_limit'), { code: 'model_output_limit' });
    const content = answer.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('invalid'), { code: 'invalid_model_response', retry: true });
    cache[id] = content;
    await writeFile(file, JSON.stringify({ answers: cache }));
    return content;
  };
}

// ---- Scores ----

/** Of the hand job's questions, those with a place of the tool near: same chapter, within two paragraphs with text. */
function handQuestions({ c, paragraphs, places }) {
  if (!c.key || !c.keyClasses) return null;
  const chapterOf = index => (index === null || index === undefined ? null : c.gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key ?? null);
  const rankOf = ranker(paragraphs);
  const questions = c.key.comments.filter(comment => c.keyClasses.questions.map(String).includes(String(comment.id)));
  const near = comment => places.some(place => chapterOf(place) === (comment.chapter ?? null) && (comment.paragraph === null || comment.paragraph === undefined || (place !== null && Math.abs(rankOf(place) - rankOf(comment.paragraph)) <= 2)));
  const kept = questions.filter(near);
  return { of: questions.length, kept: kept.length, missed: questions.filter(comment => !near(comment)).map(comment => comment.id) };
}

/** The decide step's operations against the hand job's (work/bakeoff-hand-ops.json): counts only. */
function handOps({ c, measures }) {
  const hand = c.hand;
  if (!hand) return null;
  const edits = measures.report.edits?.applied ?? [];
  const deletes = edits.filter(edit => edit.op === 'delete');
  const replaces = edits.filter(edit => edit.op === 'replace');
  const overlaps = (edit, [from, to]) => !(edit.to < from || edit.from > to);
  const [cFrom, cTo] = hand.contents;
  const contentsDeleted = deletes.filter(edit => edit.kind === DECLARED.contentsReplaced && overlaps(edit, hand.contents)).length;
  const handRanges = [...hand.drops, hand.contents];
  const dash = hand.dash.filter(index => replaces.some(edit => edit.paragraph === index && edit.after.trim().startsWith(hand.dashAfter[index].replace(/\.$/u, ''))));
  const titleCaps = hand.titleCaps.filter(index => replaces.some(edit => edit.paragraph === index && edit.kind === DECLARED.titleCase));
  const effective = slot => (measures.finalSheet.rules.find(rule => rule.slot === slot && rule.enabled !== false && rule.conflict !== true)?.params ?? null);
  const settings = Object.entries(hand.settings).map(([slot, params]) => ({ slot, same: JSON.stringify(effective(slot)) === JSON.stringify(params), ours: effective(slot) }));
  return {
    contents: `${contentsDeleted} of ${cTo - cFrom + 1} typed contents paragraphs deleted; field ${edits.some(edit => edit.op === 'insert' && edit.field === 'contents') ? 'yes' : 'no'}`,
    drops: `${hand.drops.filter(range => deletes.some(edit => overlaps(edit, range))).length}/${hand.drops.length}`,
    deletionsOutsideHand: deletes.filter(edit => !handRanges.some(range => overlaps(edit, range))).length,
    dash: `${dash.length}/${hand.dash.length}`,
    titleCaps: `${titleCaps.length}/${hand.titleCaps.length}`,
    replacesOutsideHand: replaces.filter(edit => !hand.dash.includes(edit.paragraph) && !hand.titleCaps.includes(edit.paragraph)).length,
    settingsSameAsHand: `${settings.filter(entry => entry.same).length}/${settings.length}`,
    settings: settings.map(entry => `${entry.slot}: ${entry.same ? 'same' : JSON.stringify(entry.ours)}`),
  };
}

function words(source, bytes, declared) {
  const before = readPackage(source);
  const after = readPackage(bytes);
  const check = compareWords(documentWords(before.files, before.main), documentWords(after.files, after.main), declared);
  const rejected = documentWords(after.files, after.main, { rejected: true });
  const original = documentWords(before.files, before.main);
  return { undeclared: check.undeclaredRemoved + check.undeclaredAdded, rejectGivesSource: rejected.body.join(' ') === original.body.join(' ') && rejected.notes.join(' ') === original.notes.join(' ') };
}

async function appearance({ c, file, out }) {
  if (!c.reference) return null;
  const json = path.join(out, `${path.basename(file, '.docx')}-render.json`);
  const pdfDir = path.join(out, `${path.basename(file, '.docx').replace(/\W+/gu, '-')}-pdf`);
  try {
    await run(process.execPath, [fileURLToPath(new URL('./render-eval.mjs', import.meta.url)), file, c.reference, '--case', c.name, '--pdf', 'soffice', '--pdf-dir', pdfDir, '--json', json], { maxBuffer: 1 << 26, timeout: 900000 });
  } catch (error) {
    return { failed: error?.code ?? 'failed' };
  }
  const result = await readJson(json);
  const all = result?.paragraphs?.all;
  const pct = property => (all ? Math.round((1000 * (all.agree[property] ?? 0)) / all.pairs) / 10 : null);
  return { pairs: all?.pairs ?? null, line: pct('line'), indentLeft: pct('indentLeft'), indentFirst: pct('indentFirst'), font: pct('font'), size: pct('size'), chapterPageSetup: result?.sections?.chapters ? `${Math.min(result.sections.chapters.agree.margins, result.sections.chapters.agree.pageNumberOther)}/${result.sections.chapters.count}` : null, pages: result?.pdf ? `${result.pdf.tool.pages} (reference ${result.pdf.reference.pages})` : null };
}

// ---- The runs ----

async function measureRun({ c, label, decide, readText, gateway, out, render, paragraphs }) {
  const before = { ...gateway.meter };
  const started = performance.now();
  const result = await buildOutputs({ bytes: c.source, paragraphs, roles: c.roles, sheet: c.sheet, name: 'source.docx', readText, ...(decide ? { decide } : {}), date: '2026-11-23T12:00:00Z' });
  if (!result.ok) throw new Error(`${label}: ${result.message}`);
  const minutes = (performance.now() - started) / 60000;
  const { measures } = result;
  const manuscript = result.files.find(file => file.id === 'manuscript');
  const file = path.join(out, `${label}.docx`);
  await writeFile(file, manuscript.bytes);
  for (const companion of result.files.slice(1)) await writeFile(path.join(out, `${label} ${companion.name.replace(/^source /u, '')}`), companion.bytes);
  const firstSource = measures.report.map?.[0]?.source ?? 0;
  const places = measures.commentPlaces.map(index => index ?? firstSource);
  const row = {
    label,
    comments: measures.comments,
    handQuestions: handQuestions({ c, paragraphs, places }),
    handQuestionsByQuestions: measures.questionPlaces ? handQuestions({ c, paragraphs, places: [...measures.questionPlaces.map(index => index ?? firstSource), firstSource] }) : null,
    words: words(c.source, manuscript.bytes, measures.report.declared),
    valid: result.files.every(entry => validateDocx(entry.bytes).ok),
    minutes: Math.round(minutes * 10) / 10,
    calls: gateway.meter.calls - before.calls,
    cachedCalls: gateway.meter.cached - before.cached,
    cost: Math.round((gateway.meter.cost - before.cost) * 1000) / 1000,
  };
  if (decide) {
    const refusals = {};
    for (const entry of measures.plan.refusals) refusals[entry.refusal] = (refusals[entry.refusal] ?? 0) + 1;
    const endTally = {};
    for (const entry of measures.triage) endTally[entry.end] = (endTally[entry.end] ?? 0) + 1;
    const mechanical = new Set([DECLARED.authorDash, DECLARED.titleCase]);
    Object.assign(row, {
      questions: measures.questions,
      questionPlaces: measures.places,
      checklistRows: measures.checklistRows,
      copyedit: measures.copyedit,
      refusals,
      refusedChoices: measures.disposed.refusedChoices,
      textChangesOutsideMechanical: (measures.report.edits?.applied ?? []).filter(edit => edit.op === 'replace' && !mechanical.has(edit.kind)).length,
      editsRefusedByFormatter: (measures.report.edits?.refused ?? []).length,
      operations: Object.fromEntries(Object.entries(measures.disposed.applied.reduce((tally, op) => ({ ...tally, [op.kind]: (tally[op.kind] ?? 0) + (op.count ?? 1) }), {}))),
      defaults: measures.defaults.map(entry => entry.id),
      cleared: measures.plan.cleared.size,
      roleChanges: measures.plan.roleChanges.length,
      triage: endTally,
      units: measures.answers.stats.units,
      modelCalls: measures.answers.stats.calls,
      unitStops: measures.answers.stats.stopped,
      malformed: measures.answers.stats.malformed,
      handOps: handOps({ c, measures }),
      // Where the questions are: by check (or reading kind) and the role of their paragraph.
      askedBy: measures.disposed.asked.reduce((tally, finding) => { const key = `${finding.check === 'reading' ? `reading:${finding.kind}` : finding.check} @${c.roles[finding.paragraphIndex] ?? 'none'}`; return { ...tally, [key]: (tally[key] ?? 0) + 1 }; }, {}),
      clearedSlots: [...measures.plan.cleared.keys()].map(id => measures.finalSheet.rules.find(rule => rule.id === id)?.slot ?? id),
      deliverables: measures.triage.filter(entry => entry.end === 'deliver').reduce((tally, entry) => ({ ...tally, [entry.deliverable]: (tally[entry.deliverable] ?? 0) + 1 }), {}),
    });
  } else {
    Object.assign(row, { todos: measures.todos, supply: measures.supply, checklistRows: measures.checklistRows });
  }
  if (render) row.appearance = await appearance({ c, file, out });
  // Private: every comment's place and what it holds (kinds only), for reading the run.
  if (decide) await writeFile(path.join(out, `${label}-places.json`), JSON.stringify({ comments: measures.commentPlaces, asked: measures.disposed.asked.map(finding => ({ at: finding.paragraphIndex, role: c.roles[finding.paragraphIndex] ?? null, check: finding.check, kind: finding.kind })), copyedit: measures.disposed.copyedit.map(finding => ({ at: finding.paragraphIndex, kind: finding.kind })), triage: measures.triage.map(entry => ({ id: entry.rule.id, end: entry.end, deliverable: entry.deliverable ?? null, why: entry.why })) }, null, 1));
  await writeFile(path.join(out, `${label}.json`), JSON.stringify(row, null, 1));
  return row;
}

async function main() {
  const { values } = parseArgs({ options: { case: { type: 'string', default: 'brill-dante' }, dissertation: { type: 'string' }, runs: { type: 'string', default: '2' }, 'no-render': { type: 'boolean' }, tag: { type: 'string', default: '' }, 'no-pipeline': { type: 'boolean' } } });
  const c = await loadCase({ name: values.case, dissertation: values.dissertation });
  const out = path.join(c.work, 'decide', values.tag || 'latest');
  await mkdir(out, { recursive: true });
  const gateway = createGateway({ folder: path.join(PRIVATE, 'work', 'decide') });
  const paragraphs = readDocx(c.source).paragraphs;
  const readText = cachedReading({ c, gateway });
  const render = !values['no-render'] && Boolean(c.reference);
  const rows = [];
  if (!values['no-pipeline']) {
    err('pipeline (the page with the decide step unticked, reading check on)');
    rows.push(await measureRun({ c, label: 'pipeline', readText, gateway, out, render, paragraphs }));
  }
  for (let n = 1; n <= Number(values.runs); n += 1) {
    err(`decide run ${n}`);
    const decide = async ({ kind, reading, messages, signal }) => {
      const rowsNow = await gateway.rows();
      const answer = await gateway.send(decidePayload({ model: MODEL, kind, reading, messages, row: rowsNow.get(MODEL) }), { tag: `decide:${kind}`, salt: `${values.tag}#${n}` });
      if (answer.finish === 'length') throw Object.assign(new Error('length'), { code: 'model_output_limit' });
      const message = answer.message ?? {};
      return { message: { content: typeof message.content === 'string' ? message.content : '', ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}) } };
    };
    rows.push(await measureRun({ c, label: `decide-${n}`, decide, readText, gateway, out, render, paragraphs }));
  }
  console.log(JSON.stringify(rows, null, 1));
  const cell = (row, field) => { const value = field.split('.').reduce((at, key) => at?.[key], row); return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); };
  const fields = ['comments', 'handQuestions.kept', 'handQuestionsByQuestions.kept', 'questions', 'checklistRows', 'copyedit', 'textChangesOutsideMechanical', 'refusals', 'words.undeclared', 'words.rejectGivesSource', 'valid', 'calls', 'cost', 'minutes'];
  console.log(table(['Run', ...fields], rows.map(row => [row.label, ...fields.map(field => cell(row, field))])));
  console.log(`Spent so far in this ledger: $${(await gateway.spent()).toFixed(3)} of $${CAP}.`);
}

main().catch(error => { console.error(`The run stopped: ${error?.stack ?? error}`); process.exitCode = 1; });
