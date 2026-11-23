// Measures the formatting stage against a formatting job done by hand. It runs the product's reader
// (readDocx) and formatter (formatDocx) on a case's source.docx with paragraph roles and a rule
// sheet, checks the output with the structural validator and the word check, and compares it with
// the hand-formatted reference, paragraph by paragraph, through an explicit map from the
// formatter's style names to the reference's.
//
//   npm run format-eval -- [--case <folder>] [--predicted | --roles <file>] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all|<keys>] [--score <file>] [--pdf]
//
// With --score, an output made elsewhere (by the Formatter page, say) is measured instead of the
// script's own: the script formats the source with the same roles and sheet to learn where each
// output paragraph came from, checks that the given file has the same paragraphs in the same order
// with the same text, and then measures the given file.
//
// A case is a folder under manuscripts/ in MANUSCRIPT_DESK_GUIDELINES (default
// ../manuscript-desk-guidelines) holding source.docx, gold-roles.json and reference/ with the
// formatted .docx. Working files go to the case's work/ folder: the output .docx, and cached model
// answers (predicted roles, the extracted rule sheet), so nothing is paid for twice. Model calls,
// made only when a cache is missing, go to the CAIL Gateway with the key in CAIL_API_KEY. Results go
// to stdout: counts, percentages, style and role names. It never prints manuscript text.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readDocx } from '../lib/docx/read.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { elements, firstWord, isWord, parseXml, wordAttribute } from '../lib/docx/xml.js';
import { formatDocx } from '../lib/format/format.js';
import { compareWords, documentWords, textOf } from '../lib/format/words.js';
import { labelRoles } from '../lib/roles/label.js';
import { extractRuleSheet } from '../lib/rules/extract.js';
import { validateSheet } from '../lib/rules/schema.js';
import { rolesPayload } from '../server/prompts.js';
import { checkGold, selectChapters } from './roles-eval.mjs';
import { costOf, createCallRules, createCallSettings, createGatewayCall, readCaseFile, readCatalog, table } from './generality.mjs';

const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));
const DEFAULT_MAP = fileURLToPath(new URL('../docs/eval/brill-style-map.json', import.meta.url));

const USAGE = `Usage: npm run format-eval -- [--case <folder>] [--predicted | --roles <file>] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all|<keys>] [--map <file>] [--guidelines <folder>] [--score <file>] [--pdf]

Formats manuscripts/<case>/source.docx in MANUSCRIPT_DESK_GUIDELINES (default ../manuscript-desk-guidelines)
and compares it with the formatted .docx in its reference/ folder.
  --predicted   roles from the labelling stage (cached in work/predicted-roles.json) instead of gold-roles.json
  --sheet       hand (work/hand-sheet.json, the default), extracted (the product's extraction from the
                guidelines, cached in work/extracted-sheet.json) or a sheet file
  --chapters    the chapters to report: dev (the default), holdout, all, or keys separated by commas
  --map         the style map (default docs/eval/brill-style-map.json)
  --guidelines  the guidelines folder for --sheet extracted (default brill)
  --roles       roles from a file ({"roles": {"<index>": "<role>"}}, as the Formatter page keeps them)
  --score       measure this formatted .docx (made with the same roles and sheet) instead of the script's own output
  --pdf         also convert the output to PDF with LibreOffice (soffice), if installed, to see that it opens
Model calls are made only when a cache is missing, with the key in CAIL_API_KEY, which pays for them.`;

// ---------------------------------------------------------------------------------------------
// Reading a .docx for the comparison

/**
 * The top-level children of a .docx body as comparison units: kind, text, style id and name, and
 * the section each is in.
 */
export function readUnits(bytes) {
  const { files, main } = readPackage(bytes);
  const { root } = parseXml(files.get(main));
  const names = new Map();
  const stylesName = [...files.keys()].find(name => /(^|\/)styles\.xml$/.test(name) && name.startsWith(main.slice(0, main.lastIndexOf('/') + 1)));
  if (stylesName) {
    for (const style of elements(parseXml(files.get(stylesName)).root, 'style')) {
      const name = firstWord(style, 'name');
      names.set(wordAttribute(style, 'styleId'), name ? wordAttribute(name, 'val') : wordAttribute(style, 'styleId'));
    }
  }
  const body = firstWord(root, 'body');
  const units = [];
  let section = 0;
  for (const child of elements(body)) {
    if (isWord(child, 'sectPr')) continue;
    const pPr = isWord(child, 'p') ? firstWord(child, 'pPr') : null;
    const pStyle = pPr && firstWord(pPr, 'pStyle');
    const styleId = pStyle ? wordAttribute(pStyle, 'val') : null;
    const kind = isWord(child, 'p') ? 'paragraph' : isWord(child, 'tbl') ? 'table' : 'other';
    units.push({ position: units.length, kind, text: textOf(child), styleId: kind === 'table' ? '(table)' : styleId ?? '(none)', styleName: kind === 'table' ? '(table)' : styleId ? names.get(styleId) ?? styleId : '(none)', section });
    if (pPr && firstWord(pPr, 'sectPr')) section += 1;
  }
  return { units, sections: section + 1, files, main };
}

/** The text a paragraph is matched by: letters and digits only, lower case, a leading section number left out. */
export function keyOf(text) {
  return text.normalize('NFKC').replace(/^\s*\d{1,3}(?:\.\d{1,3})*\.?\s+/u, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Similarity of two keys: the share of character pairs they have in common (Dice).
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = text => {
    const counts = new Map();
    for (let at = 0; at < text.length - 1; at += 1) { const pair = text.slice(at, at + 2); counts.set(pair, (counts.get(pair) ?? 0) + 1); }
    return counts;
  };
  const left = pairs(a);
  let shared = 0;
  for (const [pair, count] of pairs(b)) shared += Math.min(count, left.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * Pairs output and reference paragraphs by their text: the longest common subsequence of keys, then,
 * between those anchors, near matches (similar text of similar length).
 * @param {string[]} a output keys
 * @param {string[]} b reference keys
 * @returns {{ pairs: Array<[number, number, 'exact'|'near']> }}
 */
export function alignKeys(a, b, { near = 0.85 } = {}) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lengths = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const exact = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { exact.push([i, j]); i += 1; j += 1; } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i += 1; else j += 1;
  }
  const pairs = [];
  let lastA = -1;
  let lastB = -1;
  const gap = (endA, endB) => {
    // Near matches in a gap, in order: each output paragraph takes the first similar reference paragraph after the last one taken.
    let from = lastB + 1;
    for (let i = lastA + 1; i < endA; i += 1) {
      for (let j = from; j < endB; j += 1) {
        const ratio = Math.min(a[i].length, b[j].length) / Math.max(a[i].length, b[j].length);
        if (ratio >= 0.8 && similarity(a[i], b[j]) >= near) { pairs.push([i, j, 'near']); from = j + 1; break; }
      }
    }
  };
  for (const [i, j] of exact) {
    gap(i, j);
    pairs.push([i, j, 'exact']);
    lastA = i;
    lastB = j;
  }
  gap(n, m);
  return { pairs: pairs.sort((x, y) => x[0] - y[0]) };
}

/**
 * Compares output units with reference units. Output units outside every chapter and reference
 * units before the first chapter (the reference's built front matter) are left out; so are units
 * without text, which cannot be matched by text.
 */
export function compare({ output, reference, map, chapterOfOutput, referenceStart }) {
  const outputIn = output.filter(unit => chapterOfOutput(unit) !== null && keyOf(unit.text) !== '');
  const referenceIn = reference.filter(unit => unit.position >= referenceStart && keyOf(unit.text) !== '');
  const emptyReference = reference.filter(unit => unit.position >= referenceStart && keyOf(unit.text) === '').length;
  const { pairs } = alignKeys(outputIn.map(unit => keyOf(unit.text)), referenceIn.map(unit => keyOf(unit.text)));
  const matchedOutput = new Set(pairs.map(([i]) => i));
  const matchedReference = new Map(pairs.map(([i, j]) => [j, i]));
  // A reference unit belongs to the chapter of the output unit it is matched with, or of the matched one before it.
  const referenceChapter = [];
  let current = outputIn.length ? chapterOfOutput(outputIn[0]) : null;
  referenceIn.forEach((unit, j) => {
    if (matchedReference.has(j)) current = chapterOfOutput(outputIn[matchedReference.get(j)]);
    referenceChapter.push(current);
  });
  const rows = new Map();
  const row = key => {
    if (!rows.has(key)) rows.set(key, { reference: 0, output: 0, exact: 0, near: 0, agree: 0, disagreements: new Map(), unmatchedReference: new Map(), unmatchedOutput: new Map(), titleBlock: 0, titleBlockAgree: 0 });
    return rows.get(key);
  };
  referenceIn.forEach((unit, j) => { row(referenceChapter[j]).reference += 1; if (!matchedReference.has(j)) bump(row(referenceChapter[j]).unmatchedReference, unit.styleId); });
  outputIn.forEach((unit, i) => { row(chapterOfOutput(unit)).output += 1; if (!matchedOutput.has(i)) bump(row(chapterOfOutput(unit)).unmatchedOutput, unit.styleName); });
  const titleTargets = new Set(['heading 1', 'Chapter Subtitle', 'Chapter Author', 'Chapter Affiliation', 'Chapter Label'].map(name => map[name]).filter(Boolean));
  for (const [i, j, how] of pairs) {
    const unit = outputIn[i];
    const target = referenceIn[j];
    const entry = row(chapterOfOutput(unit));
    entry[how] += 1;
    const mapped = map[unit.styleName] ?? `(unmapped ${unit.styleName})`;
    const agree = mapped === target.styleId;
    if (agree) entry.agree += 1;
    else bump(entry.disagreements, `${target.styleId} -> ${unit.styleName}`);
    if (titleTargets.has(target.styleId)) { entry.titleBlock += 1; if (agree) entry.titleBlockAgree += 1; }
  }
  return { rows, emptyReference };
}

const bump = (counts, key, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);

/** Adds the rows of several chapters into one. */
export function addRows(list) {
  const total = { reference: 0, output: 0, exact: 0, near: 0, agree: 0, disagreements: new Map(), unmatchedReference: new Map(), unmatchedOutput: new Map(), titleBlock: 0, titleBlockAgree: 0 };
  for (const entry of list) {
    for (const field of ['reference', 'output', 'exact', 'near', 'agree', 'titleBlock', 'titleBlockAgree']) total[field] += entry[field];
    for (const field of ['disagreements', 'unmatchedReference', 'unmatchedOutput']) for (const [key, count] of entry[field]) bump(total[field], key, count);
  }
  return total;
}

const percent = (part, of) => (of > 0 ? `${((part / of) * 100).toFixed(1)}%` : '-');
const tallyText = counts => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => `${key}: ${count}`);

// The things the formatter must carry over exactly, counted in the main document and the notes.
const KEPT = { 'note references': ['footnoteReference', 'endnoteReference'], links: ['hyperlink'], images: ['drawing', 'pict', 'object'], fields: ['fldChar', 'fldSimple'], tables: ['tbl'], 'content controls': ['sdt'], bookmarks: ['bookmarkStart'], 'comment marks': ['commentReference'] };

/** Counts of the elements in KEPT in a package's main document and notes. */
export function keptCounts(files, main) {
  const counts = Object.fromEntries(Object.keys(KEPT).map(name => [name, 0]));
  const kindOf = new Map(Object.entries(KEPT).flatMap(([name, locals]) => locals.map(local => [local, name])));
  const parts = [main, ...[...files.keys()].filter(name => /(^|\/)(footnotes|endnotes)\.xml$/.test(name))];
  for (const part of parts) {
    const walk = node => {
      for (const child of node.children) {
        if (child.type !== 'element') continue;
        if (isWord(child, child.local) && kindOf.has(child.local)) counts[kindOf.get(child.local)] += 1;
        walk(child);
      }
    };
    walk(parseXml(files.get(part)).root);
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Cases and caches

async function findCase(root, name) {
  const base = path.join(root, 'manuscripts');
  if (name) return path.join(base, name);
  const folders = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
  if (folders.length !== 1) throw new Error(folders.length ? `Name the case with --case (one of ${folders.length} folders).` : 'There is no case folder under manuscripts/.');
  return path.join(base, folders[0]);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`${path.basename(file)} could not be read as JSON`);
  }
}

function gatewayKey(environment) {
  const key = environment.CAIL_API_KEY?.trim();
  if (!key) throw new Error('A model answer is not cached and CAIL_API_KEY is not set; set it to your CAIL Gateway key (it pays for the call).');
  return key;
}

async function predictedRoles({ work, paragraphs, environment, usage, rows, log }) {
  const file = path.join(work, 'predicted-roles.json');
  const cached = await readJson(file);
  if (cached?.roles) return cached;
  const key = gatewayKey(environment);
  const callRoles = createGatewayCall({ key, rows, usage, payloadOf: ({ model, passage }, row) => rolesPayload({ model, passage, row }) });
  log(`${DEFAULT_MODEL}: labelling ${paragraphs.length} paragraphs (cached afterwards)`);
  const result = await labelRoles({ paragraphs, model: DEFAULT_MODEL, callRoles });
  const value = { model: DEFAULT_MODEL, created: new Date().toISOString(), roles: result.roles, failures: result.failures.map(({ passage, code, unlabelled }) => ({ passage, code, unlabelled: unlabelled.length })) };
  await writeFile(file, JSON.stringify(value));
  return value;
}

async function extractedSheet({ work, root, guidelines, environment, usage, rows, log }) {
  const file = path.join(work, 'extracted-sheet.json');
  const cached = await readJson(file);
  if (cached?.sheet) return cached.sheet;
  const folder = path.join(root, guidelines);
  const expected = await readJson(path.join(folder, 'expected.json'));
  if (!expected?.docType) throw new Error(`The guidelines folder has no expected.json with a docType (--guidelines ${guidelines}).`);
  const names = expected.files ?? (await readdir(folder)).filter(name => /\.(pdf|docx|html|txt)$/i.test(name));
  const texts = [];
  for (const name of names) {
    const result = await readCaseFile(path.join(folder, name));
    if (result.ok) texts.push(result.text);
  }
  if (!texts.length) throw new Error('No guidelines file could be read.');
  const key = gatewayKey(environment);
  log(`${DEFAULT_MODEL}: reading the guidelines into a rule sheet (cached afterwards)`);
  const { sheet, failures } = await extractRuleSheet({ docType: expected.docType, model: DEFAULT_MODEL, guidelines: texts, callRules: createCallRules({ key, rows, usage }), callSettings: createCallSettings({ key, rows, usage }) });
  await writeFile(file, JSON.stringify({ model: DEFAULT_MODEL, failures: failures.map(({ group, code }) => ({ group, code })), sheet }));
  return sheet;
}

const run = promisify(execFile);

// Converts the output to PDF with LibreOffice in a folder of its own inside work/ (removed after),
// to see that the file opens. Manuscript files are never written outside the case folder.
async function pdfSmoke(file) {
  const folder = await mkdtemp(path.join(path.dirname(file), 'pdf-check-'));
  try {
    await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', folder, file], { timeout: 300000 });
    const made = (await readdir(folder)).some(name => name.endsWith('.pdf'));
    return made ? 'converted to PDF' : 'LibreOffice ran but wrote no PDF';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'not possible: soffice is not installed' : 'LibreOffice could not convert the file';
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Command line

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { case: { type: 'string' }, predicted: { type: 'boolean' }, roles: { type: 'string' }, sheet: { type: 'string' }, chapters: { type: 'string' }, map: { type: 'string' }, guidelines: { type: 'string' }, score: { type: 'string' }, pdf: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) { out(USAGE); return 0; }
  const root = environment.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(environment.MANUSCRIPT_DESK_GUIDELINES) : DEFAULT_FOLDER;
  const folder = await findCase(root, values.case);
  const work = path.join(folder, 'work');
  await mkdir(work, { recursive: true });
  const gold = await readJson(path.join(folder, 'gold-roles.json'));
  const problems = gold ? checkGold(gold) : ['gold-roles.json is missing'];
  if (problems.length) { err(`Fix gold-roles.json first:\n${problems.map(problem => `  ${problem}`).join('\n')}`); return 1; }
  const selected = selectChapters(gold, values.chapters ?? 'dev');
  if (selected.error) { err(selected.error); return 1; }
  const map = (await readJson(values.map ? path.resolve(values.map) : DEFAULT_MAP))?.map;
  if (!map) { err('The style map could not be read.'); return 1; }
  const source = new Uint8Array(await readFile(path.join(folder, 'source.docx')));
  const referenceName = (await readdir(path.join(folder, 'reference'))).find(name => /formatted manuscript.*\.docx$/i.test(name));
  if (!referenceName) { err('reference/ holds no formatted manuscript .docx.'); return 1; }
  const referenceBytes = new Uint8Array(await readFile(path.join(folder, 'reference', referenceName)));

  const read = readDocx(source);
  if (!read.ok) { err(`The reader could not open source.docx (${read.code}).`); return 1; }
  const usage = { prompt: 0, completion: 0, calls: 0, unmetered: 0 };
  let rows = null;
  const catalog = async () => (rows ??= (await readCatalog()) ?? new Map());

  // Roles.
  let roles = gold.gold;
  let rolesNote = 'gold roles';
  if (values.roles) {
    const given = await readJson(path.resolve(values.roles));
    if (!given?.roles || typeof given.roles !== 'object') { err('The roles file holds no roles.'); return 1; }
    roles = given.roles;
    rolesNote = 'roles from the given file';
  } else if (values.predicted) {
    const needsCall = !(await readJson(path.join(work, 'predicted-roles.json')))?.roles;
    const predicted = await predictedRoles({ work, paragraphs: read.paragraphs, environment, usage, rows: needsCall ? await catalog() : new Map(), log: err });
    roles = predicted.roles;
    rolesNote = `predicted roles (${predicted.model}${predicted.failures?.length ? `, ${predicted.failures.length} failed passages` : ''})`;
  }
  // Rule sheet.
  const sheetChoice = values.sheet ?? 'hand';
  let sheet;
  if (sheetChoice === 'hand') sheet = await readJson(path.join(work, 'hand-sheet.json'));
  else if (sheetChoice === 'extracted') {
    const needsCall = !(await readJson(path.join(work, 'extracted-sheet.json')))?.sheet;
    sheet = await extractedSheet({ work, root, guidelines: values.guidelines ?? 'brill', environment, usage, rows: needsCall ? await catalog() : new Map(), log: err });
  } else sheet = await readJson(path.resolve(sheetChoice));
  const checked = validateSheet(sheet);
  if (!checked.ok) { err(`The rule sheet is not valid (${checked.reason}).`); return 1; }

  // Format, check, compare.
  const start = performance.now();
  const formatted = formatDocx({ bytes: source, roles, sheet: checked.sheet });
  if (!formatted.ok) { err(`The formatter stopped: ${formatted.code}.`); return 1; }
  const seconds = (performance.now() - start) / 1000;
  const { report } = formatted;
  let measured = formatted.bytes;
  let outputFile;
  if (values.score) {
    outputFile = path.resolve(values.score);
    measured = new Uint8Array(await readFile(outputFile));
    // The given file must be this formatting: the same paragraphs, in the same order, with the same text.
    const ours = readUnits(formatted.bytes).units;
    const theirs = readUnits(measured).units;
    const same = ours.length === theirs.length && ours.every((unit, at) => unit.text === theirs[at].text && unit.styleName === theirs[at].styleName);
    if (!same) { err(`The file to score is not this formatting of the source (${theirs.length} paragraphs against ${ours.length}, or different text or styles); give the same roles and sheet.`); return 1; }
    out(`Scoring ${path.basename(outputFile)}: the same ${theirs.length} paragraphs, text and styles as the script's own formatting with these roles and this sheet.`);
  } else {
    outputFile = path.join(work, `output-${values.predicted ? 'predicted' : values.roles ? 'given' : 'gold'}-${sheetChoice === 'hand' || sheetChoice === 'extracted' ? sheetChoice : 'sheet'}.docx`);
    await writeFile(outputFile, formatted.bytes);
  }
  const validity = validateDocx(measured);

  const sourcePackage = readPackage(source);
  const sourceWords = documentWords(sourcePackage.files, sourcePackage.main);
  const outputRead = readUnits(measured);
  const referenceRead = readUnits(referenceBytes);
  const outputWords = documentWords(outputRead.files, outputRead.main);
  const referenceWords = documentWords(referenceRead.files, referenceRead.main);
  const words = compareWords(sourceWords, outputWords, report.declared);

  // Which gold chapter an output unit belongs to: by the source paragraph it came from, if that
  // lies in one of the chapters the formatter found.
  const goldChapterOf = index => gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key ?? null;
  const formattedChapter = index => report.chapters.some(chapter => index >= chapter.first && index <= chapter.last);
  const chapterOfOutput = unit => {
    const source = report.map[unit.position]?.source;
    if (source === undefined || source === null || !formattedChapter(source)) return null;
    return goldChapterOf(source) ?? gold.chapters.filter(chapter => chapter.first <= source).pop()?.key ?? null;
  };
  const chapterTitle = Object.entries(map).find(([name]) => name === 'heading 1')?.[1];
  const firstChapterUnit = referenceRead.units.find(unit => unit.styleId === chapterTitle);
  const referenceStart = firstChapterUnit ? referenceRead.units.find(unit => unit.section === firstChapterUnit.section).position : 0;
  const { rows: chapterRows, emptyReference } = compare({ output: outputRead.units, reference: referenceRead.units, map, chapterOfOutput, referenceStart });

  // Report.
  const split = key => (gold.dev.includes(key) ? 'dev' : gold.holdout.includes(key) ? 'holdout' : '-');
  const wanted = selected.chapters.map(chapter => chapter.key);
  const line = (name, entry) => {
    const matched = entry.exact + entry.near;
    return [name, entry.reference, entry.output, `${matched} (${entry.near} near)`, entry.reference - matched, entry.output - matched, percent(entry.agree, matched), `${entry.titleBlockAgree}/${entry.titleBlock}`];
  };
  const tableRows = wanted.map(key => line(`${key} (${split(key)})`, chapterRows.get(key) ?? addRows([])));
  const dev = wanted.filter(key => split(key) === 'dev').map(key => chapterRows.get(key) ?? addRows([]));
  const holdout = wanted.filter(key => split(key) === 'holdout').map(key => chapterRows.get(key) ?? addRows([]));
  if (dev.length) tableRows.push(line('Dev', addRows(dev)));
  if (holdout.length) tableRows.push(line('Holdout', addRows(holdout)));
  const total = addRows(wanted.map(key => chapterRows.get(key) ?? addRows([])));
  tableRows.push(line('Total', total));

  out(`\nFormatting with ${rolesNote} and the ${sheetChoice === 'hand' || sheetChoice === 'extracted' ? sheetChoice : 'given'} rule sheet (${checked.sheet.rules.length} rules), chapters ${values.chapters ?? 'dev'}; ${seconds.toFixed(1)} s.`);
  out(`Settings applied: ${Object.entries(report.settings).filter(([, value]) => value).map(([name]) => name).join(', ') || 'none'}.`);
  out(table(['Chapter', 'Ref. paras', 'Out paras', 'Matched', 'Ref. unmatched', 'Out unmatched', 'Style agrees', 'Title block'], tableRows));
  out(`Reference paragraphs without text (not matched by text): ${emptyReference}.`);
  out(`Style disagreements (reference style -> tool style: count), ${[...total.disagreements.values()].reduce((sum, count) => sum + count, 0)} in all:`);
  for (const entry of tallyText(total.disagreements)) out(`  ${entry}`);
  out('Unmatched reference paragraphs by reference style:');
  for (const entry of tallyText(total.unmatchedReference)) out(`  ${entry}`);
  out('Unmatched output paragraphs by tool style:');
  for (const entry of tallyText(total.unmatchedOutput)) out(`  ${entry}`);
  for (const key of wanted) {
    const entry = chapterRows.get(key);
    if (!entry) continue;
    const parts = [];
    if (entry.disagreements.size) parts.push(`disagree ${tallyText(entry.disagreements).join(', ')}`);
    if (entry.unmatchedReference.size) parts.push(`reference unmatched ${tallyText(entry.unmatchedReference).join(', ')}`);
    if (entry.unmatchedOutput.size) parts.push(`output unmatched ${tallyText(entry.unmatchedOutput).join(', ')}`);
    if (parts.length) out(`  in ${key}: ${parts.join('; ')}`);
  }
  const chaptersFound = report.chapters.length;
  out(`Sections: output ${validity.counts.sections} (${validity.counts.sectionsRestartingNotes} restart note numbers), reference ${referenceRead.sections}; ${chaptersFound} chapters found; every output section restarts notes: ${validity.counts.sections === validity.counts.sectionsRestartingNotes ? 'yes' : 'no'}.`);
  out(`Words (body + notes): source ${sourceWords.body.length} + ${sourceWords.notes.length}, output ${outputWords.body.length} + ${outputWords.notes.length}, reference ${referenceWords.body.length} + ${referenceWords.notes.length}.`);
  const keptBefore = keptCounts(sourcePackage.files, sourcePackage.main);
  const keptAfter = keptCounts(outputRead.files, outputRead.main);
  out(`Carried over (source -> output): ${Object.keys(keptBefore).map(name => `${name} ${keptBefore[name]}${keptAfter[name] === keptBefore[name] ? '' : ` -> ${keptAfter[name]} CHANGED`}`).join(', ')}.`);
  out(`Word check: ${words.comparable ? 'sequence compared' : 'too many differences for a sequence; compared as a bag'}; removed ${words.removed}, added ${words.added}; declared removed ${words.declaredRemoved}, added ${words.declaredAdded}; UNDECLARED removed ${words.undeclaredRemoved}, added ${words.undeclaredAdded}.`);
  out('Declared transformations:');
  for (const entry of report.declared) out(`  ${entry.kind}: ${entry.count}${entry.removedWords.length || entry.addedWords.length ? ` (words -${entry.removedWords.length} +${entry.addedWords.length})` : ''}`);
  out(`Needs the author: ${Object.entries(report.needsAuthor).map(([kind, count]) => `${kind} ${count}`).join('; ') || 'none'}.`);
  const rejected = compareWords(sourceWords, documentWords(outputRead.files, outputRead.main, { rejected: true }), []);
  out(`Tracked changes: ${validity.counts.revisions}; with all of them rejected, words differing from the source: removed ${rejected.removed}, added ${rejected.added}.`);
  out(`Validity: ${validity.ok ? 'valid' : `INVALID (${validity.problems.map(problem => `${problem.code} in ${problem.part} x${problem.count}`).join(', ')})`}; ${validity.counts.parts} parts, ${validity.counts.footnoteReferences} note references.`);
  out(values.score ? `Scored ${path.basename(outputFile)}.` : `Output written to the case's work/ folder as ${path.basename(outputFile)}.`);
  if (values.pdf) out(`LibreOffice: ${await pdfSmoke(outputFile)}.`);
  if (usage.calls) {
    const cost = costOf(usage, rows?.get(DEFAULT_MODEL));
    out(`Model calls: ${usage.calls}, tokens ${usage.prompt} in, ${usage.completion} out; cost ${cost === null ? 'unknown' : `$${cost.toFixed(4)}`}.`);
  }
  return words.undeclaredRemoved || words.undeclaredAdded || !validity.ok ? 2 : 0;
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
