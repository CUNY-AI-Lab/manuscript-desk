// Measures how well rule extraction works on real publisher guidelines with real models. It runs the
// product's own code (readGuidelines, extractRuleSheet, the rules prompt and model controls) against
// guidelines kept outside the repository, calling the CAIL Gateway with the caller's own key, and
// scores each sheet against the rules a case's expected.json says it must contain.
//
//   CAIL_API_KEY=... npm run generality -- --models a,b,c [--only <folder>] [--all [--doc-type <type>]] [--repeat <n>] [--save <folder>] [--record <folder>] [--replay <folder>]
//
// --record writes every model answer, with the request it answered, to a JSON Lines file per case and
// run in the folder named (outside the repository: a request holds guideline text), and --replay
// scores again from such a folder without calling the Gateway, so a re-score costs nothing. With
// both, a request the replay folder does not hold is asked of the Gateway and the new recording
// holds the run's answers, replayed and new.
//
// With --repeat, each case is read n times and, per case, a table shows for each setting of the
// rule sheet in how many runs it was filled and with which values (text values only as labels).
//
// Results go to stdout: counts, calls, timings, cost and the names of missed expected rules. It never
// prints guideline text, extracted quotations or rule statements, and never prints the key. With
// --save it also writes each rule sheet, as JSON, to the folder named (keep it outside the repository:
// a sheet quotes the guidelines).

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractRuleSheet } from '../lib/rules/extract.js';
import { cleanPastedText, readGuidelines } from '../lib/guidelines/read.js';
import { pageText } from '../lib/guidelines/pdf-text.js';
import { normalizeForMatch } from '../lib/rules/quote.js';
import { DOC_TYPES } from '../lib/rules/schema.js';
import { modelControls } from '../server/model.js';
import { rulesPrompt, settingsPayload } from '../server/prompts.js';
import { retryAfterOf } from '../lib/calls/backoff.js';

const GATEWAY = 'https://tools.ailab.gc.cuny.edu';
// The expected output of one call, as the /api/rules route passes it to modelControls (server/worker.js).
const RULES_OUTPUT_TOKENS = 6000;
const REQUEST_TIMEOUT_MS = 180000;
const CATALOG_TIMEOUT_MS = 10000;
const SUPPORTED = new Set(['.pdf', '.docx', '.html', '.txt']);
export const MAX_TEXT_FILE_BYTES = 5000000;
const DEFAULT_DOC_TYPE = 'monograph';
const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));

const USAGE = `Usage: npm run generality -- --models <id>[,<id>...] [--only <folder>] [--all] [--doc-type <${DOC_TYPES.join('|')}>] [--repeat <n>]

Reads the guidelines folder named by MANUSCRIPT_DESK_GUIDELINES (default ../manuscript-desk-guidelines)
and calls the CAIL Gateway with the key in CAIL_API_KEY, which pays for every call.
  --models    model ids to measure, separated by commas
  --only      run only the cases in this subfolder
  --all       also run every other supported file as its own unscored case
  --doc-type  document type of those unscored cases (default ${DEFAULT_DOC_TYPE})
  --repeat    read each case this many times and tabulate which settings each run filled
  --save      write each rule sheet as JSON to this folder (outside the repository: sheets quote the guidelines)
  --record    write every model answer, with its request, to this folder (outside the repository)
  --replay    score again from a folder written by --record, without calling the Gateway; with
              --record too, a request not recorded there is asked of the Gateway`;

// ---------------------------------------------------------------------------------------------
// Scoring

/**
 * How many of the expected rules a sheet contains. A rule counts as found when any of its `any`
 * strings occurs, after normalizeForMatch, in some extracted rule's quote (source.quote) or statement.
 * @param {{ rules: Array<{ statement: string, source: { quote?: string } }> }} sheet
 * @param {{ rules: Array<{ name: string, any: string[] }> }} expected
 * @returns {{ found: number, of: number, missed: string[] }}
 */
export function scoreSheet(sheet, expected) {
  const texts = (sheet?.rules ?? []).flatMap(rule => [normalizeForMatch(rule?.source?.quote), normalizeForMatch(rule?.statement)]).filter(Boolean);
  const wanted = expected?.rules ?? [];
  const missed = [];
  for (const { name, any } of wanted) {
    const needles = (any ?? []).map(normalizeForMatch).filter(Boolean);
    if (!needles.some(needle => texts.some(text => text.includes(needle)))) missed.push(name);
  }
  return { found: wanted.length - missed.length, of: wanted.length, missed };
}

/**
 * One model's verdict: at least 90 percent of all expected rules found and no case below 80 percent.
 * Cases with nothing expected are ignored; no scored case at all is not a pass.
 * @param {Array<{ found: number, of: number }>} results
 */
export function passes(results) {
  const scored = results.filter(result => result.of > 0);
  if (scored.length === 0) return false;
  const found = scored.reduce((sum, result) => sum + result.found, 0);
  const of = scored.reduce((sum, result) => sum + result.of, 0);
  return found * 10 >= of * 9 && scored.every(result => result.found * 5 >= result.of * 4);
}

// ---------------------------------------------------------------------------------------------
// Stability

/**
 * For each setting (slot) any run filled: in how many of the runs it was filled, and how often each
 * value occurred, as "value xN". A slot holding rules that disagree counts its values joined by " | ".
 * Text values (a font name, a marker's example) are never shown: each distinct text is a label,
 * "text A", "text B", in order of first appearance, so the table carries no guideline text.
 * @param {Array<{ rules: Array<{ slot: string | null, params: object }> } | null>} sheets one per run
 * @returns {Array<{ slot: string, filled: number, runs: number, values: string[] }>}
 */
export function slotFills(sheets) {
  const texts = new Map();
  const label = value => {
    if (typeof value !== 'string' || /^[a-z%-]{1,20}$/.test(value)) return JSON.stringify(value)?.replace(/^"|"$/g, '') ?? String(value);
    if (!texts.has(value)) texts.set(value, `text ${String.fromCharCode(65 + (texts.size % 26))}${texts.size >= 26 ? Math.floor(texts.size / 26) : ''}`);
    return texts.get(value);
  };
  const bySlot = new Map();
  sheets.forEach(sheet => {
    const seen = new Map();
    for (const rule of sheet?.rules ?? []) {
      if (typeof rule.slot !== 'string') continue;
      const words = Object.keys(rule.params ?? {}).sort().map(name => `${name}=${label(rule.params[name])}`).join(' ');
      if (!seen.has(rule.slot)) seen.set(rule.slot, new Set());
      seen.get(rule.slot).add(words);
    }
    for (const [slot, values] of seen) {
      if (!bySlot.has(slot)) bySlot.set(slot, { filled: 0, values: new Map() });
      const entry = bySlot.get(slot);
      entry.filled += 1;
      const value = [...values].sort().join(' | ');
      entry.values.set(value, (entry.values.get(value) ?? 0) + 1);
    }
  });
  return [...bySlot].sort((a, b) => b[1].filled - a[1].filled || a[0].localeCompare(b[0])).map(([slot, { filled, values }]) => ({
    slot, filled, runs: sheets.length,
    values: [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => `${value} x${count}`),
  }));
}

// ---------------------------------------------------------------------------------------------
// HTML

const DROPPED_ELEMENTS = new Set(['script', 'style', 'nav', 'header', 'footer']);
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const NAME_CHAR = /[A-Za-z0-9]/;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', shy: '­' };

function decodeEntity(entity, body) {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

// The name of the tag opening at `at` ('<' or '</' then letters and digits, lower-cased) and
// whether it closes, or null when no name follows.
function tagAt(lower, at) {
  const closing = lower[at + 1] === '/';
  let end = at + (closing ? 2 : 1);
  const start = end;
  while (end < lower.length && NAME_CHAR.test(lower[end])) end += 1;
  return end > start ? { name: lower.slice(start, end), closing } : null;
}

// Where the element `name` whose content starts at `from` ends: just past its closing tag, or the
// end of the input when it is never closed.
function endOfElement(lower, name, from) {
  const closing = `</${name}`;
  for (let at = lower.indexOf(closing, from); at !== -1; at = lower.indexOf(closing, at + 1)) {
    if (NAME_CHAR.test(lower[at + closing.length] ?? '')) continue;
    const close = lower.indexOf('>', at + closing.length);
    return close === -1 ? lower.length : close + 1;
  }
  return lower.length;
}

/**
 * The text of an HTML page: script, style, nav, header and footer elements and comments removed,
 * block elements turned into line breaks, all other tags dropped and common entities decoded.
 * One pass, linear in the input: an unterminated tag, comment or dropped element runs to the end.
 * @param {string} html
 */
export function htmlToText(html) {
  const source = String(html);
  // Lower-cased for matching tag names; only ASCII letters change, so positions stay aligned.
  const lower = source.replace(/[A-Z]+/g, letters => letters.toLowerCase());
  const parts = [];
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open === -1) {
      parts.push(source.slice(at));
      break;
    }
    parts.push(source.slice(at, open));
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4);
      parts.push(' ');
      at = close === -1 ? source.length : close + 3;
      continue;
    }
    const close = source.indexOf('>', open + 1);
    const tagEnd = close === -1 ? source.length : close + 1;
    const tag = tagAt(lower, open);
    if (tag && !tag.closing && DROPPED_ELEMENTS.has(tag.name)) {
      parts.push(' ');
      at = tagEnd >= source.length ? source.length : endOfElement(lower, tag.name, tagEnd);
      continue;
    }
    if (tag && BLOCK_ELEMENTS.has(tag.name)) parts.push('\n');
    at = tagEnd;
  }
  return parts.join('')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, decodeEntity)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Model calls

/**
 * The chat payload for one call, exactly as the /api/rules route builds it.
 * @param {{ model: string, docType: string, group: string, text: string, row?: object }} request
 */
export function rulesPayload({ model, docType, group, text, row }) {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: rulesPrompt({ docType, group }) }, { role: 'user', content: text }],
    ...modelControls(row, RULES_OUTPUT_TOKENS),
  };
}

const coded = (code, retry, extra = {}) => Object.assign(new Error(`The model call failed: ${code}`), { code, retry, ...extra });
const countOf = value => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * A model call that goes to the Gateway directly with a CAIL API key, sending the payload
 * `payloadOf(request, row)` builds and adding the tokens of every reply to `usage`
 * ({ prompt, completion, calls, unmetered }). Resolves { content } or rejects with an Error
 * carrying { code, retry }. Shared with scripts/roles-eval.mjs.
 * @param {{ key: string, rows: Map<string, object>, usage: object, payloadOf: (request: object, row?: object) => object, fetchImpl?: typeof fetch }} options
 */
export function createGatewayCall({ key, rows, usage, payloadOf, fetchImpl = globalThis.fetch, record }) {
  return async function call(request) {
    const { signal } = request;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const body = JSON.stringify(payloadOf(request, rows.get(request.model)));
    if (record) {
      // A recorded answer (or failure) is told to `record`, which may also answer from a recording.
      const replayed = await record.before?.(request, body);
      if (replayed) {
        // A replayed call counts as the call it was, with the tokens it used then; it is not paid again.
        usage.calls += 1;
        usage.replayed = (usage.replayed ?? 0) + 1;
        usage.replayedPrompt = (usage.replayedPrompt ?? 0) + (replayed.usage?.prompt ?? 0);
        usage.replayedCompletion = (usage.replayedCompletion ?? 0) + (replayed.usage?.completion ?? 0);
        await record.after?.(request, body, replayed);
        if (replayed.code) throw coded(replayed.code, false);
        return { content: replayed.content };
      }
      try {
        const answer = await sendAndRead();
        await record.after?.(request, body, answer);
        return { content: answer.content };
      } catch (error) {
        await record.after?.(request, body, { code: error?.code ?? 'error' });
        throw error;
      }
    }
    return { content: (await sendAndRead()).content };
    // The reply's content, with the tokens it used for a recording.
    async function sendAndRead() {
      usage.calls += 1;
      let response, data;
      try {
        response = await fetchImpl(`${GATEWAY}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const raw = await response.text();
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      } catch (error) {
        const code = error?.name === 'TimeoutError' ? 'request_timeout' : error?.name === 'AbortError' ? 'request_cancelled' : 'network_error';
        throw coded(code, false);
      }
      if (!response.ok) {
        const code = typeof data?.error?.code === 'string' && /^[\w.:-]{1,80}$/.test(data.error.code) ? data.error.code : `http_${response.status}`;
        const retryAfter = retryAfterOf(response.headers.get('retry-after'));
        usage.refused = (usage.refused ?? 0) + 1;
        throw coded(code, response.headers.get('x-should-retry') === 'true', { status: response.status, ...(retryAfter ? { retryAfter } : {}) });
      }
      if (!data || typeof data !== 'object') throw coded('invalid_model_response', false);
      const prompt = countOf(data.usage?.prompt_tokens);
      const completion = countOf(data.usage?.completion_tokens);
      if (prompt === null || completion === null) usage.unmetered = (usage.unmetered ?? 0) + 1;
      usage.prompt += prompt ?? 0;
      usage.completion += completion ?? 0;
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw coded('model_output_limit', false);
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw coded('invalid_model_response', false);
      return { content, usage: { prompt, completion } };
    }
  };
}

/**
 * Recording of model answers for measure(). With `record`, every answer and failure is appended,
 * with its request, to <record>/<label>.jsonl. With `replay`, the answers of <replay>/<label>.jsonl
 * are given back by the hash of the request body (in order, for a request asked more than once)
 * and no call is made; a request not recorded there is an error, unless `record` is given too, in
 * which case it is asked of the Gateway (so a changed question costs only itself) and the run's
 * answers, replayed and new, are all written to the new recording. Shared with tests.
 */
export function createRecorder({ record, replay }) {
  let label = null;
  let answers = new Map();
  const hash = body => createHash('sha256').update(body).digest('hex');
  return {
    async start(name) {
      label = name;
      if (!replay) return;
      answers = new Map();
      let text = '';
      try {
        text = await readFile(path.join(replay, `${label}.jsonl`), 'utf8');
      } catch {
        if (!record) throw new Error(`No recorded answers for ${label} in the replay folder.`);
      }
      for (const line of text.split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (!answers.has(entry.hash)) answers.set(entry.hash, []);
        answers.get(entry.hash).push(entry);
      }
    },
    async before(request, body) {
      if (!replay) return null;
      const recorded = answers.get(hash(body));
      if (recorded?.length) return recorded.shift();
      if (record) return null;
      throw coded('not_recorded', false);
    },
    async after(request, body, answer) {
      if (!record) return;
      await mkdir(record, { recursive: true });
      const { signal, ...asked } = request;
      const entry = { hash: hash(body), request: asked, ...(answer.code ? { code: answer.code } : { content: answer.content, usage: answer.usage }) };
      await appendFile(path.join(record, `${label}.jsonl`), `${JSON.stringify(entry)}\n`);
    },
  };
}

/**
 * A callRules for extractRuleSheet that calls the Gateway directly with a CAIL API key.
 * @param {{ key: string, rows: Map<string, object>, usage: object, fetchImpl?: typeof fetch }} options
 */
export function createCallRules({ key, rows, usage, fetchImpl, record }) {
  return createGatewayCall({ key, rows, usage, fetchImpl, record, payloadOf: ({ model, docType, group, text }, row) => rulesPayload({ model, docType, group, text, row }) });
}

/**
 * A callSettings for extractRuleSheet (the focused question about settings the reading missed)
 * that calls the Gateway directly with a CAIL API key, as POST /api/settings does.
 * @param {{ key: string, rows: Map<string, object>, usage: object, fetchImpl?: typeof fetch }} options
 */
export function createCallSettings({ key, rows, usage, fetchImpl, record }) {
  return createGatewayCall({ key, rows, usage, fetchImpl, record, payloadOf: ({ model, docType, slots, text, unreported }, row) => {
    usage.settingsCalls = (usage.settingsCalls ?? 0) + 1;
    return settingsPayload({ model, docType, slots, text, unreported, row });
  } });
}

// The public catalog's rows by model id, or null when it cannot be read.
export async function readCatalog(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${GATEWAY}/v1/models`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!Array.isArray(body?.data)) return null;
    return new Map(body.data.filter(row => typeof row?.id === 'string' && Array.isArray(row.capabilities)).map(row => [row.id, row]));
  } catch {
    return null;
  }
}

const price = value => ((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null);

// US dollars for the tokens used, or null when the row has no prices.
export function costOf(usage, row) {
  const input = price(row?.pricing?.input);
  const output = price(row?.pricing?.output);
  if (input === null || output === null) return null;
  return (usage.prompt * input + usage.completion * output) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// Cases

const isText = value => typeof value === 'string' && value.trim() !== '';
const toPosix = relative => relative.split(path.sep).join('/');

// The problems of one expected.json, as short descriptions (empty when it is valid).
export function checkExpected(value, dir) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['must be a JSON object'];
  const problems = [];
  if (!DOC_TYPES.includes(value.docType)) problems.push(`docType must be one of ${DOC_TYPES.join(', ')}`);
  if (value.files !== undefined) {
    if (!Array.isArray(value.files) || value.files.length === 0 || !value.files.every(isText)) problems.push('files must be a non-empty list of paths');
    else value.files.forEach((file, index) => {
      const relative = path.relative(dir, path.resolve(dir, file));
      if (path.isAbsolute(file) || relative === '' || relative.startsWith('..')) problems.push(`files[${index}] must name a file inside the folder`);
    });
  }
  if (!Array.isArray(value.rules)) problems.push('rules must be a list');
  else value.rules.forEach((rule, index) => {
    if (!isText(rule?.name)) problems.push(`rules[${index}].name must be text`);
    if (!Array.isArray(rule?.any) || rule.any.length === 0 || !rule.any.every(isText)) problems.push(`rules[${index}].any must be a non-empty list of text`);
  });
  return problems;
}

const inFolder = (name, only) => only === undefined || name === only || name.startsWith(`${only}/`);

/**
 * The cases under `root`: one scored case per subfolder holding an expected.json, and, with `all`,
 * one unscored case per other supported file. Hidden files and folders are skipped.
 * @returns {Promise<{ cases: Array<{ name, docType, files: string[], expected?: object }>, problems: string[] }>}
 */
async function findCases(root, { all, only, docType }) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  const expectedDirs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = toPosix(path.relative(root, path.join(entry.parentPath, entry.name)));
    if (relative.split('/').some(part => part.startsWith('.'))) continue;
    if (entry.name === 'expected.json') {
      if (relative.includes('/')) expectedDirs.push(path.posix.dirname(relative));
    } else if (SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(relative);
  }
  files.sort();
  expectedDirs.sort();

  const cases = [];
  const problems = [];
  const claimed = new Set();
  for (const dir of expectedDirs) {
    let expected;
    try {
      expected = JSON.parse(await readFile(path.join(root, dir, 'expected.json'), 'utf8'));
    } catch {
      problems.push(`${dir}/expected.json: not valid JSON`);
      continue;
    }
    const found = checkExpected(expected, dir);
    if (found.length) {
      problems.push(...found.map(problem => `${dir}/expected.json: ${problem}`));
      continue;
    }
    const caseFiles = expected.files
      ? expected.files.map(file => path.posix.normalize(`${dir}/${toPosix(file)}`))
      : files.filter(file => path.posix.dirname(file) === dir);
    caseFiles.forEach(file => claimed.add(file));
    cases.push({ name: dir, docType: expected.docType, files: caseFiles, expected });
  }
  if (all) for (const file of files) if (!claimed.has(file)) cases.push({ name: file, docType, files: [file] });
  return { cases: cases.filter(entry => inFolder(entry.name, only)), problems };
}

// MuPDF and mammoth, loaded only when a case has a PDF or Word file.
let extractorsLoaded = null;
function nodeExtractors() {
  extractorsLoaded ??= Promise.all([import('mupdf'), import('mammoth')]).then(([mupdf, mammoth]) => {
    // MuPDF's warnings about damaged files would clutter the report.
    mupdf.setLog(() => {});
    return {
      extractPdf(bytes) {
        const document = mupdf.Document.openDocument(bytes, 'application/pdf');
        try {
          const pages = [];
          for (let index = 0; index < document.countPages(); index += 1) pages.push(pageText(document.loadPage(index)));
          return pages.join('\n\n');
        } finally {
          document.destroy();
        }
      },
      async extractDocx(bytes) {
        return (await mammoth.default.extractRawText({ buffer: Buffer.from(bytes) })).value;
      },
    };
  });
  return extractorsLoaded;
}

// One file's text, through the same checks the product applies, or the code of why it was not read.
// An .html or .txt file larger than MAX_TEXT_FILE_BYTES is refused before it is read.
export async function readCaseFile(file) {
  const extension = path.extname(file).toLowerCase();
  let bytes;
  try {
    if ((extension === '.html' || extension === '.txt') && (await stat(file)).size > MAX_TEXT_FILE_BYTES) return { ok: false, code: 'too_long' };
    bytes = new Uint8Array(await readFile(file));
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (extension === '.pdf' || extension === '.docx') return readGuidelines({ name: path.basename(file), bytes }, await nodeExtractors());
  const text = new TextDecoder('utf-8').decode(bytes);
  if (extension === '.html') return cleanPastedText(htmlToText(text));
  if (extension === '.txt') return cleanPastedText(text);
  return { ok: false, code: 'unsupported' };
}

// ---------------------------------------------------------------------------------------------
// Report

export function table(header, rows) {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => String(row[column]).length)));
  const line = row => row.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join('  ').trimEnd();
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

const percent = (found, of) => (of > 0 ? `${((found / of) * 100).toFixed(1)}%` : '-');
const tally = codes => Object.entries(codes.reduce((counts, code) => ({ ...counts, [code]: (counts[code] ?? 0) + 1 }), {})).map(([code, count]) => `${code} x${count}`).join(', ');

async function measure(model, cases, { key, rows, log, repeat = 1, save, recorder }) {
  const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0, settingsCalls: 0, refused: 0 };
  const callRules = createCallRules({ key, rows: rows ?? new Map(), usage, record: recorder });
  const callSettings = createCallSettings({ key, rows: rows ?? new Map(), usage, record: recorder });
  const results = [];
  for (const entry of cases) {
    if (entry.texts.length === 0) {
      results.push({ entry, skipped: true });
      continue;
    }
    for (let run = 1; run <= repeat; run += 1) {
      const named = repeat > 1 ? { ...entry, run } : entry;
      log(`${model}: reading ${entry.name}${repeat > 1 ? ` (run ${run} of ${repeat})` : ''}`);
      const start = performance.now();
      try {
        await recorder?.start(`${model}-${entry.name.replace(/[^A-Za-z0-9-]+/gu, '_')}-run${run}`);
        const calls = usage.calls;
        const { sheet, failures, asked } = await extractRuleSheet({ docType: entry.docType, model, guidelines: entry.texts, callRules, callSettings });
        results.push({ entry: named, sheet, failures, asked, calls: usage.calls - calls, seconds: (performance.now() - start) / 1000 });
        if (save) await save(named, sheet);
      } catch (error) {
        results.push({ entry: named, error: typeof error?.code === 'string' ? error.code : (error?.name ?? 'error'), seconds: (performance.now() - start) / 1000 });
      }
    }
  }
  return { usage, results };
}

function report(model, { usage, results }, row, out) {
  const scores = [];
  const rowsOut = [];
  const notes = [];
  const totals = { kept: 0, dropped: 0, failures: 0, seconds: 0 };
  for (const result of results) {
    const { entry } = result;
    const wanted = entry.expected?.rules ?? [];
    // A scored case that could not be read or run scores nothing: it was meant to be measured.
    const score = entry.expected ? (result.sheet ? scoreSheet(result.sheet, entry.expected) : { found: 0, of: wanted.length, missed: wanted.map(rule => rule.name) }) : null;
    if (score) scores.push(score);
    const found = score ? `${score.found}/${score.of}` : '-';
    const name = entry.run ? `${entry.name} (run ${entry.run})` : entry.name;
    if (result.skipped) {
      rowsOut.push([name, '-', '-', found, '-', '-', 'skipped']);
      notes.push(`${entry.name}: skipped, no readable file`);
    } else if (result.error) {
      rowsOut.push([name, '-', '-', found, '-', '-', result.seconds.toFixed(1)]);
      notes.push(`${name}: the run stopped (${result.error})`);
      totals.seconds += result.seconds;
    } else {
      rowsOut.push([name, result.sheet.rules.length, result.sheet.dropped, found, result.failures.length, result.calls, result.seconds.toFixed(1)]);
      totals.kept += result.sheet.rules.length;
      totals.dropped += result.sheet.dropped;
      totals.failures += result.failures.length;
      totals.seconds += result.seconds;
      if (result.failures.length) notes.push(`${name}: failed calls: ${tally(result.failures.map(failure => failure.code))}`);
      if (result.asked?.parts || result.asked?.sentenceParts) notes.push(`${name}: settings questions to ${result.asked.parts} parts about ${result.asked.settings.length} settings filled ${result.asked.added.length}${result.asked.added.length ? ` (${result.asked.added.join(', ')})` : ''}${result.asked.sentenceParts ? `; ${result.asked.sentenceParts} ${result.asked.sentenceParts === 1 ? 'part' : 'parts'} asked about ${result.asked.sentences} sentences no reading quoted, ${result.asked.recovered} rules from them` : ''}`);
    }
    if (score?.missed.length) notes.push(`${name}: missed ${score.missed.join('; ')}`);
  }
  const found = scores.reduce((sum, score) => sum + score.found, 0);
  const of = scores.reduce((sum, score) => sum + score.of, 0);
  rowsOut.push(['Total', totals.kept, totals.dropped, of ? `${found}/${of}` : '-', totals.failures, usage.calls, totals.seconds.toFixed(1)]);

  out(`\nModel ${model}`);
  out(table(['Case', 'Kept', 'Left out', 'Expected found', 'Failures', 'Calls', 'Seconds'], rowsOut));
  const cost = costOf(usage, row);
  const costText = cost === null ? 'unknown' : `${usage.unmetered ? 'at least ' : ''}$${cost.toFixed(4)}`;
  out(`Tokens: ${usage.prompt} in, ${usage.completion} out, over ${usage.calls} calls (${usage.settingsCalls ?? 0} of them settings questions; ${usage.refused ?? 0} refused by the Gateway, rate limits included)${usage.unmetered ? ` (${usage.unmetered} replies without token counts)` : ''}. Cost: ${costText}.`);
  if (usage.replayed) out(`Of the calls, ${usage.replayed} were replayed from a recording (${usage.replayedPrompt} tokens in, ${usage.replayedCompletion} out, not paid again; the cost above is the new calls').`);
  const verdict = passes(scores);
  const lowest = scores.filter(score => score.of > 0).reduce((low, score) => Math.min(low, score.found / score.of), Infinity);
  out(`Result: ${verdict ? 'PASS' : 'FAIL'}${of ? ` (${percent(found, of)} found overall, lowest case ${(lowest * 100).toFixed(1)}%)` : ' (no scored cases)'}`);
  for (const note of notes) out(`  ${note}`);
  const runsByCase = new Map();
  for (const result of results) if (result.entry.run) runsByCase.set(result.entry.name, [...(runsByCase.get(result.entry.name) ?? []), result.sheet ?? null]);
  for (const [name, sheets] of runsByCase) {
    out(`\nSettings filled in ${sheets.length} runs of ${name}:`);
    const fills = slotFills(sheets);
    out(table(['Setting', 'Runs filled', 'Values'], fills.map(row => [row.slot, `${row.filled}/${row.runs}`, row.values.join('; ')])));
    out(`Settings filled in all ${sheets.length} runs: ${fills.filter(row => row.filled === sheets.length).length}.`);
  }
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// Command line

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { models: { type: 'string' }, only: { type: 'string' }, all: { type: 'boolean' }, 'doc-type': { type: 'string' }, repeat: { type: 'string' }, save: { type: 'string' }, record: { type: 'string' }, replay: { type: 'string' }, help: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const models = (values.models ?? '').split(',').map(model => model.trim()).filter(Boolean);
  if (models.length === 0) {
    err(`Name at least one model with --models.\n\n${USAGE}`);
    return 1;
  }
  const repeat = values.repeat === undefined ? 1 : Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    err('--repeat must be a whole number from 1 to 20.');
    return 1;
  }
  const docType = values['doc-type'] ?? DEFAULT_DOC_TYPE;
  if (!DOC_TYPES.includes(docType)) {
    err(`--doc-type must be one of ${DOC_TYPES.join(', ')}.`);
    return 1;
  }
  const recorder = values.record !== undefined || values.replay !== undefined
    ? createRecorder({ record: values.record === undefined ? undefined : path.resolve(values.record), replay: values.replay === undefined ? undefined : path.resolve(values.replay) }) : undefined;
  const key = values.replay !== undefined && values.record === undefined ? 'replay' : environment.CAIL_API_KEY?.trim();
  if (!key) {
    err('CAIL_API_KEY is not set. Set it to your CAIL Gateway API key; every model call is charged to that key.');
    return 1;
  }
  const root = environment.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(environment.MANUSCRIPT_DESK_GUIDELINES) : DEFAULT_FOLDER;
  const only = values.only === undefined ? undefined : toPosix(path.normalize(values.only)).replace(/\/+$/, '');

  let found;
  try {
    found = await findCases(root, { all: values.all === true, only, docType });
  } catch {
    err(`Cannot read the guidelines folder ${root}. Set MANUSCRIPT_DESK_GUIDELINES to its path.`);
    return 1;
  }
  if (found.problems.length) {
    err(`Fix these expected.json files first (no model was called):\n${found.problems.map(problem => `  ${problem}`).join('\n')}`);
    return 1;
  }
  if (found.cases.length === 0) {
    err(`No case to run${only ? ` in ${only}` : ''}. A scored case is a subfolder with an expected.json; --all also runs every other file.`);
    return 1;
  }

  // Each file is read once; every model reads the same texts.
  const cases = [];
  for (const entry of found.cases) {
    const texts = [];
    for (const file of entry.files) {
      const result = await readCaseFile(path.join(root, file));
      if (result.ok) texts.push(result.text);
      else out(`Could not read ${file} (${result.code}).`);
    }
    cases.push({ ...entry, texts });
  }

  const rows = await readCatalog();
  if (!rows) out('The model catalog could not be read: calls go without model controls and cost is unknown.');
  let allPass = true;
  for (const model of models) {
    if (rows && !rows.has(model)) out(`\n${model} is not in the model catalog: calls go without its model controls and cost is unknown.`);
    const save = values.save === undefined ? undefined : async (entry, sheet) => {
      const folder = path.resolve(values.save);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `${model}-${entry.name.replace(/[^A-Za-z0-9-]+/gu, '_')}${entry.run ? `-run${entry.run}` : ''}.json`), JSON.stringify(sheet));
    };
    const measured = await measure(model, cases, { key, rows, log: err, repeat, save, recorder });
    allPass = report(model, measured, rows?.get(model), out) && allPass;
  }
  return allPass ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    code => { process.exitCode = code; },
    error => {
      console.error(`The run stopped: ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
