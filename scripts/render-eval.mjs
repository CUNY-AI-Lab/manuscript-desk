// The rendered comparison: how two .docx files look to a reader, compared without Word. For every
// paragraph of the first file matched by its text to a paragraph of the second, the effective font,
// size, line spacing, space before and after, indents and alignment (resolved through the document
// defaults, the styles, numbering and direct formatting); for each chapter, the page size, margins,
// note numbering and where the page number stands; the notes' look; and the text set in a font that
// is not the body's. With --pdf it also exports both files with Microsoft Word or LibreOffice and
// reports page counts and the fonts the PDFs use.
//
//   npm run render-eval -- <tool.docx> <reference.docx> [--case <folder>] [--pdf word|soffice --pdf-dir <folder>] [--pdfs <a.pdf>,<b.pdf>] [--json <file>]
//
// With --case (a folder under manuscripts/ in MANUSCRIPT_DESK_GUIDELINES holding source.docx and
// gold-roles.json), paragraphs are counted by chapter, dev and holdout apart, through the source
// paragraph each one came from. Output is counts, style names, font names and measurements only;
// it never prints manuscript text.

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readAppearance, strayFonts } from '../lib/docx/appearance.js';
import { readDocx } from '../lib/docx/read.js';
import { alignKeys, keyOf } from './format-eval.mjs';
import { table } from './generality.mjs';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../manuscript-desk-guidelines', import.meta.url));
const USAGE = `Usage: npm run render-eval -- <tool.docx> <reference.docx> [--case <folder>] [--pdf word|soffice --pdf-dir <folder>] [--pdfs <a.pdf>,<b.pdf>] [--json <file>]

Compares how two Word files look: effective paragraph formatting of the paragraphs matched by text,
page setup and page numbers by chapter, the notes, and text in fonts other than the body's.
  --case     a case folder under manuscripts/ (source.docx, gold-roles.json) to count by chapter, dev and holdout apart
  --pdf      also export both files to PDF with Microsoft Word (word) or LibreOffice (soffice) into --pdf-dir
  --pdfs     PDFs of the two files made already, to report page counts and fonts
  --json     write the results as JSON to this file`;

export const PROPERTIES = ['font', 'size', 'line', 'before', 'after', 'left', 'right', 'firstLine', 'jc'];

/** A property's value as compared: line spacing as a multiple (1.5) or in points (exact 12pt). */
export function valueOf(look, property) {
  if (property === 'line') return look.lineRule === 'auto' || !look.lineRule ? `${Math.round((look.line / 240) * 100) / 100}` : `${look.lineRule} ${look.line / 20}pt`;
  if (property === 'size') return look.size / 2;
  return look[property] ?? null;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * Compares matched paragraphs property by property.
 * @param {Array<[object, object, string]>} pairs [tool look, reference look, group]
 * @returns {{ groups: Map<string, { pairs: number, agree: Record<string, number> }>, classes: Map<string, number> }}
 */
export function comparePairs(pairs) {
  const groups = new Map();
  const classes = new Map();
  for (const [tool, reference, group] of pairs) {
    for (const name of [group, 'all']) {
      if (!groups.has(name)) groups.set(name, { pairs: 0, agree: Object.fromEntries(PROPERTIES.map(property => [property, 0])) });
      groups.get(name).pairs += 1;
    }
    for (const property of PROPERTIES) {
      const a = valueOf(tool, property);
      const b = valueOf(reference, property);
      if (a === b) { for (const name of [group, 'all']) groups.get(name).agree[property] += 1; continue; }
      bump(classes, `${property}: ${a} -> ${b} (reference ${reference.styleName})`);
    }
  }
  return { groups, classes };
}

/** Pairs the paragraphs of two looks lists by their text. */
export function matchParagraphs(tool, reference) {
  const toolIn = tool.filter(look => keyOf(look.text) !== '');
  const referenceIn = reference.filter(look => keyOf(look.text) !== '');
  const { pairs } = alignKeys(toolIn.map(look => keyOf(look.text)), referenceIn.map(look => keyOf(look.text)));
  return { pairs: pairs.map(([i, j]) => [toolIn[i], referenceIn[j]]), tool: toolIn.length, reference: referenceIn.length };
}

/**
 * The chapter of each tool paragraph, through the source: the source's top-level paragraphs are
 * matched to the tool's by text, and each source index lies in a gold chapter or matter span.
 * @returns {Map<object, string>} look -> chapter key, 'matter' or 'outside'
 */
export function chaptersOf(toolLooks, sourceParagraphs, gold) {
  const keyed = sourceParagraphs.filter(entry => keyOf(entry.text) !== '');
  const looks = toolLooks.filter(look => keyOf(look.text) !== '');
  const { pairs } = alignKeys(keyed.map(entry => keyOf(entry.text)), looks.map(look => keyOf(look.text)));
  const spanOf = index => gold.chapters.find(chapter => index >= chapter.first && index <= chapter.last)?.key
    ?? ((gold.matter ?? []).some(span => index >= span.first && index <= span.last) ? 'matter' : 'outside');
  const out = new Map();
  for (const [i, j] of pairs) out.set(looks[j], spanOf(keyed[i].index));
  // A tool paragraph not matched to the source (a line the formatter added) takes the chapter before it.
  let current = 'outside';
  for (const look of toolLooks) {
    if (out.has(look)) current = out.get(look);
    else out.set(look, current);
  }
  return out;
}

const percent = (part, of) => (of > 0 ? `${((part / of) * 100).toFixed(1)}%` : '-');

/** The page setup by chapter: the section holding each chapter's first matched paragraph, in each file. */
export function compareSections(chapterOf, pairs, toolSections, referenceSections) {
  const firstPair = new Map();
  for (const [tool, reference] of pairs) {
    const key = chapterOf.get(tool);
    if (!firstPair.has(key)) firstPair.set(key, [tool, reference]);
  }
  const rows = [];
  for (const [key, [tool, reference]] of firstPair) {
    const a = toolSections[tool.section];
    const b = referenceSections[reference.section];
    if (!a || !b) continue;
    rows.push({ key, tool: sectionSummary(a), reference: sectionSummary(b) });
  }
  return rows;
}

export const sectionSummary = section => ({
  page: `${section.width}x${section.height}`,
  margins: ['top', 'right', 'bottom', 'left'].map(side => section.margins[side]).join('/'),
  pageNumberFirst: section.pageNumber.first?.position ?? 'none',
  pageNumberOther: section.pageNumber.other?.position ?? 'none',
  pageNumberFont: section.pageNumber.other ? `${section.pageNumber.other.font} ${section.pageNumber.other.size / 2}pt` : 'none',
  noteRestart: section.noteRestart,
});

// ---------------------------------------------------------------------------------------------
// PDFs

const run = promisify(execFile);

async function exportPdf(docx, pdf, how) {
  if (how === 'word') {
    const script = ['with timeout of 600 seconds', 'tell application "Microsoft Word"', `open POSIX file "${docx}"`, 'set d to active document', `save as d file name "${pdf}" file format format PDF`, 'close d saving no', 'end tell', 'end timeout'];
    await run('osascript', script.flatMap(line => ['-e', line]), { timeout: 700000 });
  } else {
    await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', path.dirname(pdf), docx], { timeout: 600000 });
  }
}

/** Page count and characters by font of a PDF, read with MuPDF. */
export async function pdfFacts(file) {
  const mupdf = await import('mupdf');
  const document = mupdf.Document.openDocument(await readFile(file), 'application/pdf');
  const fonts = new Map();
  const latin = new Map();
  const pages = document.countPages();
  for (let index = 0; index < pages; index += 1) {
    const text = document.loadPage(index).toStructuredText('preserve-whitespace');
    text.walk({
      onChar(character, origin, font) {
        const name = font.getName().replace(/^[A-Z]{6}\+/u, '');
        bump(fonts, name);
        if (/[\p{Script=Latin}0-9]/u.test(character)) bump(latin, name);
      },
    });
  }
  return { pages, fonts, latin };
}

// ---------------------------------------------------------------------------------------------
// Command line

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main(argv, environment, { out = console.log, err = console.error } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { case: { type: 'string' }, pdf: { type: 'string' }, 'pdf-dir': { type: 'string' }, pdfs: { type: 'string' }, json: { type: 'string' }, help: { type: 'boolean' } }, strict: true }));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 1;
  }
  if (values.help || positionals.length !== 2) { (values.help ? out : err)(USAGE); return values.help ? 0 : 1; }
  const [toolFile, referenceFile] = positionals.map(file => path.resolve(file));
  const tool = readAppearance(new Uint8Array(await readFile(toolFile)));
  const reference = readAppearance(new Uint8Array(await readFile(referenceFile)));

  // Chapters, through the case's source and gold.
  let gold = null;
  let chapterOf = null;
  if (values.case) {
    const root = environment.MANUSCRIPT_DESK_GUIDELINES ? path.resolve(environment.MANUSCRIPT_DESK_GUIDELINES) : DEFAULT_FOLDER;
    const folder = path.join(root, 'manuscripts', values.case);
    gold = await readJson(path.join(folder, 'gold-roles.json'));
    const read = readDocx(new Uint8Array(await readFile(path.join(folder, 'source.docx'))));
    if (!gold || !read.ok) { err('The case has no readable gold-roles.json or source.docx.'); return 1; }
    chapterOf = chaptersOf(tool.paragraphs.filter(look => look.part === 'body'), read.paragraphs, gold);
  }
  const groupOf = look => {
    if (!chapterOf) return 'all';
    const key = chapterOf.get(look) ?? 'outside';
    if (gold.dev.includes(key)) return 'dev';
    if (gold.holdout.includes(key)) return 'holdout';
    return key === 'matter' ? 'front and back matter' : 'outside the chapters';
  };

  const body = matchParagraphs(tool.paragraphs.filter(look => look.part === 'body'), reference.paragraphs.filter(look => look.part === 'body'));
  const bodyResult = comparePairs(body.pairs.map(([a, b]) => [a, b, groupOf(a)]));
  const notes = matchParagraphs(tool.notes.filter(look => !look.separator), reference.notes.filter(look => !look.separator));
  const notesResult = comparePairs(notes.pairs.map(([a, b]) => [a, b, 'notes']));

  const result = { tool: path.basename(toolFile), reference: path.basename(referenceFile), paragraphs: {}, notes: {}, classes: {}, noteClasses: {}, sections: {}, stray: {}, pdf: null };
  const order = ['dev', 'holdout', 'front and back matter', 'outside the chapters', 'all'];
  const rows = [];
  for (const name of order) {
    const group = bodyResult.groups.get(name);
    if (!group) continue;
    rows.push([name, group.pairs, ...PROPERTIES.map(property => percent(group.agree[property], group.pairs))]);
    result.paragraphs[name] = { pairs: group.pairs, agree: group.agree };
  }
  const noteGroup = notesResult.groups.get('all');
  if (noteGroup) {
    rows.push(['notes', noteGroup.pairs, ...PROPERTIES.map(property => percent(noteGroup.agree[property], noteGroup.pairs))]);
    result.notes = { pairs: noteGroup.pairs, agree: noteGroup.agree };
  }
  out(`\nParagraphs with text: tool ${body.tool}, reference ${body.reference}, matched ${body.pairs.length}; note paragraphs matched ${notes.pairs.length} (tool ${notes.tool}, reference ${notes.reference}).`);
  out('Agreement of the effective formatting of matched paragraphs, by property:');
  out(table(['Group', 'Pairs', ...PROPERTIES], rows));
  const sorted = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  out('Difference classes, body (property: tool -> reference, with the reference style; count), the 40 largest:');
  for (const [key, count] of sorted(bodyResult.classes).slice(0, 40)) out(`  ${key}: ${count}`);
  out('Difference classes, notes, the 10 largest:');
  for (const [key, count] of sorted(notesResult.classes).slice(0, 10)) out(`  ${key}: ${count}`);
  result.classes = Object.fromEntries(sorted(bodyResult.classes));
  result.noteClasses = Object.fromEntries(sorted(notesResult.classes));

  // Sections and page numbers.
  for (const [name, look] of [['tool', tool], ['reference', reference]]) {
    const tally = new Map();
    for (const section of look.sections) {
      const summary = (({ page, margins, pageNumberFirst, pageNumberOther, pageNumberFont, noteRestart }) => `page ${page}, margins ${margins}, page number first ${pageNumberFirst} / other ${pageNumberOther} (${pageNumberFont}), notes ${noteRestart}`)(sectionSummary(section));
      bump(tally, summary);
    }
    out(`Sections of the ${name} (${look.sections.length}):`);
    for (const [key, count] of sorted(tally)) out(`  ${count} x ${key}`);
    result.sections[name] = Object.fromEntries(tally);
  }
  if (chapterOf) {
    const bySection = compareSections(chapterOf, body.pairs, tool.sections, reference.sections).filter(row => row.key !== 'outside' && row.key !== 'matter');
    const fields = ['page', 'margins', 'pageNumberFirst', 'pageNumberOther', 'pageNumberFont', 'noteRestart'];
    const agree = Object.fromEntries(fields.map(field => [field, bySection.filter(row => row.tool[field] === row.reference[field]).length]));
    out(`Page setup of the section each chapter opens in, agreeing in ${bySection.length} chapters: ${fields.map(field => `${field} ${agree[field]}`).join(', ')}.`);
    result.sections.chapters = { count: bySection.length, agree };
  }

  // Text outside the body font.
  for (const [name, look] of [['tool', tool], ['reference', reference]]) {
    const bodyFont = mostCommonFont(look.paragraphs);
    const parts = { body: look.paragraphs, notes: look.notes, 'headers and footers': look.margins };
    const found = {};
    for (const [part, list] of Object.entries(parts)) found[part] = Object.fromEntries(sorted(strayFonts(list, bodyFont)));
    out(`Latin text of the ${name} not in its body font (${bodyFont}), characters by font: ${Object.entries(found).map(([part, fonts]) => `${part} ${Object.entries(fonts).map(([font, count]) => `${font} ${count}`).join(', ') || 'none'}`).join('; ')}.`);
    result.stray[name] = { bodyFont, ...found };
  }

  // PDFs.
  let pdfs = values.pdfs ? values.pdfs.split(',').map(file => path.resolve(file)) : null;
  if (values.pdf) {
    if (!values['pdf-dir']) { err('--pdf needs --pdf-dir, a folder for the copies and the PDFs (simple names, no spaces).'); return 1; }
    const folder = path.resolve(values['pdf-dir']);
    await mkdir(folder, { recursive: true });
    pdfs = [];
    for (const [name, file] of [['tool', toolFile], ['reference', referenceFile]]) {
      const copy = path.join(folder, `${name}.docx`);
      await copyFile(file, copy);
      const pdf = path.join(folder, `${name}.pdf`);
      try {
        await exportPdf(copy, pdf, values.pdf);
        pdfs.push(pdf);
      } catch (error) {
        out(`The ${name} file could not be exported with ${values.pdf} (${error?.code ?? 'failed'}).`);
        pdfs = null;
        break;
      }
    }
  }
  if (pdfs?.length === 2) {
    try {
      const [a, b] = [await pdfFacts(pdfs[0]), await pdfFacts(pdfs[1])];
      out(`PDF pages: tool ${a.pages}, reference ${b.pages}.`);
      const fontLine = facts => sorted(facts.fonts).map(([font, count]) => `${font} ${count}`).join(', ');
      out(`PDF fonts (characters): tool ${fontLine(a)}.`);
      out(`PDF fonts (characters): reference ${fontLine(b)}.`);
      result.pdf = { tool: { pages: a.pages, fonts: Object.fromEntries(a.fonts), latin: Object.fromEntries(a.latin) }, reference: { pages: b.pages, fonts: Object.fromEntries(b.fonts), latin: Object.fromEntries(b.latin) } };
    } catch {
      out('The PDFs could not be read (MuPDF is a development dependency: npm ci).');
    }
  }
  if (values.json) await writeFile(path.resolve(values.json), JSON.stringify(result, null, 1));
  return 0;
}

/** The font most Latin characters of the body paragraphs are set in. */
export function mostCommonFont(paragraphs) {
  const counts = new Map();
  for (const paragraph of paragraphs) for (const { slot, font } of paragraph.characters) if (slot === 'ascii' || slot === 'hAnsi') bump(counts, font);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
