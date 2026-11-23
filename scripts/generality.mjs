// Measures how well rule extraction works on real publisher guidelines with real models. It runs the
// product's own code (readGuidelines, extractRuleSheet, the rules prompt and model controls) against
// guidelines kept outside the repository, calling the CAIL Gateway with the caller's own key, and
// scores each sheet against the rules a case's expected.json says it must contain.
//
//   CAIL_API_KEY=... npm run generality -- --models a,b,c [--only <folder>] [--all [--doc-type <type>]]
//
// Results go to stdout only: counts, timings, cost and the names of missed expected rules. It never
// prints or writes guideline text, extracted quotations or rule statements, and never prints the key.

import { readdir, readFile, stat } from 'node:fs/promises';
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
import { rulesPrompt } from '../server/prompts.js';

const GATEWAY = 'https://tools.ailab.gc.cuny.edu';
// The expected output of one call, as the /api/rules route passes it to modelControls (server/worker.js).
const RULES_OUTPUT_TOKENS = 6000;
const REQUEST_TIMEOUT_MS = 180000;
const CATALOG_TIMEOUT_MS = 10000;
const SUPPORTED = new Set(['.pdf', '.docx', '.html', '.txt']);
export const MAX_TEXT_FILE_BYTES = 5000000;
const DEFAULT_DOC_TYPE = 'monograph';
const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));

const USAGE = `Usage: npm run generality -- --models <id>[,<id>...] [--only <folder>] [--all] [--doc-type <${DOC_TYPES.join('|')}>]

Reads the guidelines folder named by MANUSCRIPT_DESK_GUIDELINES (default ../manuscript-desk-guidelines)
and calls the CAIL Gateway with the key in CAIL_API_KEY, which pays for every call.
  --models    model ids to measure, separated by commas
  --only      run only the cases in this subfolder
  --all       also run every other supported file as its own unscored case
  --doc-type  document type of those unscored cases (default ${DEFAULT_DOC_TYPE})`;

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

const coded = (code, retry) => Object.assign(new Error(`The model call failed: ${code}`), { code, retry });
const countOf = value => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * A callRules for extractRuleSheet that calls the Gateway directly with a CAIL API key, adding the
 * tokens of every reply to `usage` ({ prompt, completion, calls, unmetered }).
 * Resolves { content } or rejects with an Error carrying { code, retry }.
 * @param {{ key: string, rows: Map<string, object>, usage: object, fetchImpl?: typeof fetch }} options
 */
export function createCallRules({ key, rows, usage, fetchImpl = globalThis.fetch }) {
  return async function callRules({ model, docType, group, text, signal }) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const body = JSON.stringify(rulesPayload({ model, docType, group, text, row: rows.get(model) }));
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
      throw coded(code, response.headers.get('x-should-retry') === 'true');
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
    return { content };
  };
}

// The public catalog's rows by model id, or null when it cannot be read.
async function readCatalog(fetchImpl = globalThis.fetch) {
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
function costOf(usage, row) {
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

function table(header, rows) {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => String(row[column]).length)));
  const line = row => row.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join('  ').trimEnd();
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

const percent = (found, of) => (of > 0 ? `${((found / of) * 100).toFixed(1)}%` : '-');
const tally = codes => Object.entries(codes.reduce((counts, code) => ({ ...counts, [code]: (counts[code] ?? 0) + 1 }), {})).map(([code, count]) => `${code} x${count}`).join(', ');

async function measure(model, cases, { key, rows, log }) {
  const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0 };
  const callRules = createCallRules({ key, rows: rows ?? new Map(), usage });
  const results = [];
  for (const entry of cases) {
    if (entry.texts.length === 0) {
      results.push({ entry, skipped: true });
      continue;
    }
    log(`${model}: reading ${entry.name}`);
    const start = performance.now();
    try {
      const { sheet, failures } = await extractRuleSheet({ docType: entry.docType, model, guidelines: entry.texts, callRules });
      results.push({ entry, sheet, failures, seconds: (performance.now() - start) / 1000 });
    } catch (error) {
      results.push({ entry, error: typeof error?.code === 'string' ? error.code : (error?.name ?? 'error'), seconds: (performance.now() - start) / 1000 });
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
    if (result.skipped) {
      rowsOut.push([entry.name, '-', '-', found, '-', 'skipped']);
      notes.push(`${entry.name}: skipped, no readable file`);
    } else if (result.error) {
      rowsOut.push([entry.name, '-', '-', found, '-', result.seconds.toFixed(1)]);
      notes.push(`${entry.name}: the run stopped (${result.error})`);
      totals.seconds += result.seconds;
    } else {
      rowsOut.push([entry.name, result.sheet.rules.length, result.sheet.dropped, found, result.failures.length, result.seconds.toFixed(1)]);
      totals.kept += result.sheet.rules.length;
      totals.dropped += result.sheet.dropped;
      totals.failures += result.failures.length;
      totals.seconds += result.seconds;
      if (result.failures.length) notes.push(`${entry.name}: failed calls: ${tally(result.failures.map(failure => failure.code))}`);
    }
    if (score?.missed.length) notes.push(`${entry.name}: missed ${score.missed.join('; ')}`);
  }
  const found = scores.reduce((sum, score) => sum + score.found, 0);
  const of = scores.reduce((sum, score) => sum + score.of, 0);
  rowsOut.push(['Total', totals.kept, totals.dropped, of ? `${found}/${of}` : '-', totals.failures, totals.seconds.toFixed(1)]);

  out(`\nModel ${model}`);
  out(table(['Case', 'Kept', 'Left out', 'Expected found', 'Failures', 'Seconds'], rowsOut));
  const cost = costOf(usage, row);
  const costText = cost === null ? 'unknown' : `${usage.unmetered ? 'at least ' : ''}$${cost.toFixed(4)}`;
  out(`Tokens: ${usage.prompt} in, ${usage.completion} out, over ${usage.calls} calls${usage.unmetered ? ` (${usage.unmetered} replies without token counts)` : ''}. Cost: ${costText}.`);
  const verdict = passes(scores);
  const lowest = scores.filter(score => score.of > 0).reduce((low, score) => Math.min(low, score.found / score.of), Infinity);
  out(`Result: ${verdict ? 'PASS' : 'FAIL'}${of ? ` (${percent(found, of)} found overall, lowest case ${(lowest * 100).toFixed(1)}%)` : ' (no scored cases)'}`);
  for (const note of notes) out(`  ${note}`);
  return verdict;
}

// ---------------------------------------------------------------------------------------------
// Command line

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { models: { type: 'string' }, only: { type: 'string' }, all: { type: 'boolean' }, 'doc-type': { type: 'string' }, help: { type: 'boolean' } }, strict: true }));
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
  const docType = values['doc-type'] ?? DEFAULT_DOC_TYPE;
  if (!DOC_TYPES.includes(docType)) {
    err(`--doc-type must be one of ${DOC_TYPES.join(', ')}.`);
    return 1;
  }
  const key = environment.CAIL_API_KEY?.trim();
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
    const measured = await measure(model, cases, { key, rows, log: err });
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
