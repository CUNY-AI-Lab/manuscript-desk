// The formatting stage: from a manuscript's .docx bytes, its paragraph roles and a rule sheet, a new
// .docx in which structure is carried by named paragraph styles instead of direct formatting. Each
// paragraph with a role gets the style for its role and loses the direct paragraph formatting the
// style now carries; character formatting that carries meaning (italics, bold inside a sentence,
// superscripts, small capitals, fonts other than the body's) is kept, and so are runs, note
// references, links, images, tables and fields. Chapters become Word sections when notes restart
// in each chapter. Every change to the text is declared, with the words it removed and added, so
// that a check can prove nothing else changed; the changes to words (a title split, a rewritten
// figure marker, an added caption line) are written as tracked insertions and deletions by
// "CAIL Manuscript Desk", which the author can accept or reject, while style changes stay direct.
// Pure: no DOM, no network.

import { readDocx } from '../docx/read.js';
import { PPR_ORDER } from '../docx/validate.js';
import { PackageError, addRelatedPart, readPackage, relatedPart, relationshipsOf, writePackage } from '../docx/write.js';
import { cloneNode, descendants, elements, firstWord, isElement, isWord, nextAnnotationId, parseXml, REL_NS, serializeXml, setWordAttribute, wordAttribute, wordElement, wordPrefix, WORD_NAMESPACES } from '../docx/xml.js';
import { EXCEPTION_FONT, fontSlot, readAppearance } from '../docx/appearance.js';
import { coreTitle, DC_NS, tableFacts } from '../docx/accessibility.js';
import { DECLARED } from './declared.js';
import { planFormatting, settingsFrom } from './plan.js';
import { mergeStyles, parseFragment } from './styles.js';
import { textOf, wordsOf } from './words.js';

const MESSAGES = {
  not_docx: 'This is not a Word (.docx) file.',
  unreadable: 'This Word file could not be read.',
  too_large: 'This file is too large to format here (the limit is 50 MB).',
  tracked_changes: 'This file has tracked changes. Accept or reject them in Word first, then choose the file again.',
};
const failure = code => ({ ok: false, code, message: MESSAGES[code] });
const encoder = new TextEncoder();
const PPR_RANK = new Map(PPR_ORDER.map((name, rank) => [name, rank]));
export const REVISION_AUTHOR = 'CAIL Manuscript Desk';

// Direct paragraph formatting that a style carries, removed from a styled paragraph.
const STYLE_CARRIES = new Set(['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'pBdr', 'shd', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'jc', 'outlineLvl']);
const OFF = new Set(['0', 'false', 'off']);
const TOGGLES = new Set(['b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'vanish', 'webHidden', 'specVanish', 'rtl', 'cs', 'noProof', 'snapToGrid']);
// Roles whose style carries bold and italics: their direct bold or italics over the whole
// paragraph is removed, because it was the source's way of marking what the style now marks.
const STYLE_CARRIES_EMPHASIS = new Set(['chapter-label', 'chapter-title', 'chapter-subtitle', 'chapter-author', 'chapter-affiliation', 'heading-1', 'heading-2', 'bibliography-heading', 'bibliography-subheading', 'book-label', 'book-title', 'book-subtitle', 'book-author', 'book-affiliation', 'front-matter-heading', 'part-title', 'appendix-heading']);
// Markup an empty paragraph may hold that must not be lost when it is removed: it moves to the next paragraph.
const CARRIED = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permStart', 'permEnd', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);
// Content that makes a paragraph worth keeping even with no text.
const SUBSTANTIAL = new Set(['drawing', 'pict', 'object', 'footnoteReference', 'endnoteReference', 'fldChar', 'fldSimple', 'instrText', 'commentReference', 'sym', 'ptab', 'txbxContent', 'ins', 'del', 'moveFrom', 'moveTo', 'sdt']);
const TRACKED = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'numberingChange']);
const SECTION_ORDER = ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];
const SECTION_RANK = new Map(SECTION_ORDER.map((name, rank) => [name, rank]));
// The font slots Latin text is set in.
const LATIN_FONT_SLOTS = new Set(['ascii', 'hAnsi', 'asciiTheme', 'hAnsiTheme']);
// Letters a body font may not have: any script but Latin, Greek and Cyrillic (and the shared signs).
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const needsOwnFont = text => [...text].some(character => OTHER_SCRIPT.test(character) && (fontSlot(character) === 'ascii' || fontSlot(character) === 'hAnsi'));

// Headings whose ends are tidied of spaces and line breaks.
const TIDY_HEADINGS = new Set(['heading-1', 'heading-2', 'bibliography-heading', 'bibliography-subheading', 'front-matter-heading', 'part-title', 'appendix-heading']);
// Opening quotation marks and the marks that close them.
const QUOTE_PAIRS = { '“': '”', '‘': '’', '«': '»', '„': '“', '"': '"', '‹': '›' };
// Words title case leaves in lower case inside a title.
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'of', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as', 'into', 'upon', 'via', 'per', 'vs']);

/** True when a heading's capitals follow the case: title (every main word capitalized) or sentence (only the first). */
export function followsCase(text, kind) {
  const words = text.split(/\s+/u).filter(word => /\p{L}/u.test(word));
  const capital = word => /^[^\p{L}]*\p{Lu}/u.test(word);
  if (kind === 'title') return words.every((word, position) => capital(word) || (position > 0 && position < words.length - 1 && MINOR_WORDS.has(word.toLocaleLowerCase())));
  if (kind === 'sentence') return words.length > 0 && capital(words[0]) && words.slice(1).every(word => !capital(word) || word === word.toLocaleUpperCase());
  return false;
}

/**
 * @param {{ bytes: Uint8Array | ArrayBuffer, roles: Record<number, string>, sheet?: object | null, date?: string }} input
 *   date: the time the tracked changes carry (ISO, without fractions of a second); now by default
 * @returns {{ ok: true, bytes: Uint8Array, report: object } | { ok: false, code: string, message: string }}
 */
export function formatDocx(input = {}) {
  try {
    return format(input);
  } catch {
    // A part the stage cannot work with is a failure to report, never an exception.
    return failure('unreadable');
  }
}

function format({ bytes, roles = {}, sheet = null, date = new Date().toISOString().replace(/\.\d+Z$/u, 'Z') }) {
  const read = readDocx(bytes);
  if (!read.ok) return failure(read.code);
  let files, main;
  try {
    ({ files, main } = readPackage(bytes));
  } catch (error) {
    return failure(error instanceof PackageError ? error.code : 'unreadable');
  }
  let document;
  try {
    document = parseXml(files.get(main)).root;
  } catch {
    return failure('unreadable');
  }
  const body = firstWord(document, 'body');
  if (!body) return failure('unreadable');
  if ([...descendants(body)].some(node => WORD_NAMESPACES.has(node.uri) && TRACKED.has(node.local))) return failure('tracked_changes');
  const children = elements(body);
  if (children.length !== read.paragraphs.length) return failure('unreadable');

  const settings = settingsFrom(sheet);
  const plan = planFormatting(read.paragraphs, roles, settings);
  const prefix = wordPrefix(document);
  const notesParts = ['footnotes', 'endnotes'].map(type => relatedPart(files, main, type)).filter(part => part && files.has(part));
  const notes = notesParts.map(part => ({ part, root: parseXml(files.get(part)).root }));
  // Revision ids above every annotation's in the parts that get tracked changes.
  const firstRevision = Math.max(nextAnnotationId(document), ...notes.map(({ root }) => nextAnnotationId(root)));
  const job = new Job({ prefix, paragraphs: read.paragraphs, plan, settings, sheet, date, firstRevision });
  job.measureSource(children);
  const units = job.buildBody(children);
  job.tidy(units);
  job.placeSections(units, body);
  if (settings.chapterNewPage) job.pageBreaks(units);
  job.pageMargins(files, main, document);
  if (settings.pageSequences) job.pageSequences(files, main, document);
  job.accessibilityFixes(files, body);

  // Styles, numbering and notes.
  const stylesPart = relatedPart(files, main, 'styles') ?? addRelatedPart(files, main, 'styles', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  const styles = parseXml(files.get(stylesPart)).root;
  const numbering = settings.headingNumbers && job.usedStyles.has('heading-1') ? job.addHeadingNumbering(files, main) : {};
  for (const { part, root } of notes) job.restyleNotes(root, /endnotes\.xml$/u.test(part) ? 'endnoteRef' : 'footnoteRef');
  job.cleanMarginFonts(files, main);
  // A line-spacing rule is for the text as a whole: the front matter's running text (an abstract, a
  // dedication, a contents list) takes it too, unless the sheet sets that element apart.
  const lines = { ...(job.spacingRule ? Object.fromEntries(['abstract', 'dedication', 'contents-entry', 'contributor-note'].map(key => [key, job.bodyLine])) : {}), ...elementLines(settings.elementSpacing) };
  const { ids, duplicates, defaultsChanged } = mergeStyles(styles, { used: job.usedStyles, bodyLine: job.bodyLine, normal: { font: job.font, halfPoints: job.halfPoints }, numbering, lines });
  const spaced = Object.keys(elementLines(settings.elementSpacing)).filter(key => job.usedStyles.has(key)).length;
  if (spaced) job.declare(DECLARED.elementSpacing, { count: spaced });
  if (defaultsChanged) job.declare(DECLARED.defaultFont);
  if (job.fontsRemoved) job.declare(DECLARED.fontRemoved, { count: job.fontsRemoved });
  job.writeStyleIds(ids);
  if (duplicates) job.declare(DECLARED.duplicateStyle, { count: duplicates });

  files.set(stylesPart, encoder.encode(serializeXml(styles)));
  for (const { part, root } of notes) files.set(part, encoder.encode(serializeXml(root)));
  files.set(main, encoder.encode(serializeXml(document)));
  const report = job.report(units);
  report.accessibility = { title: job.titleSet ?? null, headerRows: job.headerRows ?? 0 };
  report.layout = { line: job.bodyLine, lineSet: Boolean(job.spacingRule), pageNumbersSet: Boolean(settings.pageNumbers || settings.pageSequences), pageNumbers: sourcePageNumbers(bytes), marginsSet: Boolean(settings.margins || settings.marginSides), fontSet: Boolean(job.ruleFont), font: job.font };
  return { ok: true, bytes: writePackage(files), report };
}

class Job {
  constructor({ prefix, paragraphs, plan, settings, sheet, date, firstRevision = 1 }) {
    Object.assign(this, { prefix, paragraphs, plan, settings, sheet, date });
    this.nextRevision = firstRevision;
    this.revisions = 0;
    this.usedStyles = new Set();
    this.styled = new Map(); // pStyle element -> style key, to receive the style id once styles are merged
    this.declared = new Map();
    this.needsAuthor = { ...plan.needsAuthor };
    this.styleCounts = {};
    this.font = null;
    this.halfPoints = null;
    this.bodyLine = null;
    this.sections = 0;
    this.splitSubtitles = new Set();
    this.fontsRemoved = 0;
  }

  el(local, attributes = {}, children = []) { return wordElement(this.prefix, local, attributes, children); }

  /** Declares a change: its kind, how many, the words it removed and added, and where (source indices). */
  declare(kind, { count = 1, removedWords = [], addedWords = [], at = [] } = {}) {
    const entry = this.declared.get(kind) ?? { kind, count: 0, removedWords: [], addedWords: [], places: [] };
    entry.count += count;
    entry.removedWords.push(...removedWords);
    entry.addedWords.push(...addedWords);
    entry.places.push(...[at].flat());
    this.declared.set(kind, entry);
  }

  need(kind, count = 1) { this.needsAuthor[kind] = (this.needsAuthor[kind] ?? 0) + count; }

  // The body's font, size and line spacing: those of most of the text in paragraphs with a role,
  // so text that loses its direct formatting keeps its look through the Normal and body styles.
  measureSource(children) {
    const fonts = new Map();
    const sizes = new Map();
    const lines = new Map();
    const add = (map, key, weight) => { if (key) map.set(key, (map.get(key) ?? 0) + weight); };
    this.plan.decisions.forEach((decision, index) => {
      const node = children[index];
      if (!node) return;
      for (const run of descendants(node, 'r')) {
        const length = textOf(run).length;
        if (!length) continue;
        const rPr = firstWord(run, 'rPr');
        const rFonts = rPr && firstWord(rPr, 'rFonts');
        add(fonts, rFonts && (wordAttribute(rFonts, 'ascii') ?? wordAttribute(rFonts, 'hAnsi')), length);
        const size = rPr && firstWord(rPr, 'sz');
        add(sizes, size && wordAttribute(size, 'val'), length);
      }
      if (decision.style === 'body' || decision.style === 'body-first') {
        const spacing = firstWord(firstWord(node, 'pPr') ?? { children: [] }, 'spacing');
        const line = spacing && wordAttribute(spacing, 'line');
        if (line && (wordAttribute(spacing, 'lineRule') ?? 'auto') === 'auto') add(lines, line, 1);
      }
    });
    const top = map => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    this.font = top(fonts);
    this.halfPoints = top(sizes);
    const spacingRule = this.sheet?.rules?.find(rule => rule.slot === 'layout.spacing' && rule.enabled !== false && rule.conflict !== true);
    this.spacingRule = spacingRule ?? null;
    this.bodyLine = spacingRule ? String(Math.round(spacingRule.params.line * 240)) : top(lines);
    const fontRule = this.sheet?.rules?.find(rule => rule.slot === 'layout.font' && rule.enabled !== false && rule.conflict !== true);
    this.ruleFont = fontRule?.params?.family ?? null;
    this.ruleHalfPoints = fontRule?.params?.sizePt ? String(Math.round(fontRule.params.sizePt * 2)) : null;
    // The direct font and size that equal the body's are removed from runs; Normal takes the rule's
    // values when the sheet sets them, otherwise the body's.
    this.sourceFont = this.font;
    this.font = this.ruleFont ?? this.font;
    this.halfPoints = this.ruleHalfPoints ?? this.halfPoints;
  }

  // ------------------------------------------------------------------------------------------
  // Paragraph properties and runs

  pStyle(key) {
    this.usedStyles.add(key);
    this.styleCounts[key] = (this.styleCounts[key] ?? 0) + 1;
    const element = this.el('pStyle', { val: key });
    this.styled.set(element, key);
    return element;
  }

  writeStyleIds(ids) {
    for (const [element, key] of this.styled) setWordAttribute(element, 'val', ids[key]);
  }

  /** Gives a paragraph a style: the style carries what its direct paragraph formatting did. */
  restyle(paragraph, key, { emphasis = null, suppressNumber = false } = {}) {
    let pPr = firstWord(paragraph, 'pPr');
    if (!pPr) {
      pPr = this.el('pPr');
      paragraph.children.unshift(pPr);
    }
    const kept = pPr.children.filter(child => !(isElement(child) && WORD_NAMESPACES.has(child.uri) && STYLE_CARRIES.has(child.local)) && child.type !== 'text');
    pPr.children = [this.pStyle(key), ...kept];
    if (suppressNumber && !firstWord(pPr, 'numPr')) insertOrdered(pPr, this.el('numPr', {}, [this.el('numId', { val: '0' })]), PPR_RANK);
    const markProperties = firstWord(pPr, 'rPr');
    if (markProperties) this.cleanRunProperties(markProperties, emphasis, '');
    for (const run of runsOf(paragraph)) {
      const rPr = firstWord(run, 'rPr');
      if (!rPr) continue;
      this.cleanRunProperties(rPr, emphasis, textOf(run));
      if (!rPr.children.some(isElement)) run.children.splice(run.children.indexOf(rPr), 1);
    }
  }

  /** Removes what is no-op or carried by the style; keeps formatting that carries meaning. */
  cleanRunProperties(rPr, emphasis, text = '') {
    rPr.children = rPr.children.filter(child => {
      if (!isElement(child)) return false;
      if (!WORD_NAMESPACES.has(child.uri)) return true;
      const value = wordAttribute(child, 'val');
      const local = child.local;
      if (TOGGLES.has(local)) {
        if (value !== undefined && OFF.has(value.toLowerCase())) return false;
        if (emphasis?.bold && (local === 'b' || local === 'bCs')) return false;
        if (emphasis?.italic && (local === 'i' || local === 'iCs')) return false;
        return true;
      }
      switch (local) {
        case 'sz': case 'szCs': return false;
        case 'u': return value !== undefined && value !== 'none';
        case 'vertAlign': return value !== 'baseline';
        case 'color': return !isPlainColor(child);
        case 'highlight': return value !== 'none' && value !== 'white';
        case 'shd': return !isPlainShading(child);
        case 'rFonts': {
          const dropped = new Set(['ascii', 'hAnsi', 'cs', 'eastAsia']);
          child.attributes = child.attributes.filter(attribute => !(dropped.has(attribute.local) && attribute.value === this.sourceFont));
          return this.cleanFonts(child, text);
        }
        default: return true;
      }
    });
  }

  /**
   * Latin text set in a font other than the body's, by direct formatting, is text escaping the
   * styles: the run's Latin fonts go (and an East Asian hint on a run without East Asian text),
   * so it takes the body font. Kept: symbol and code fonts, East Asian and complex-script fonts
   * (which Latin text does not use), and the font of a run holding letters of another script.
   * Returns whether the element still sets anything.
   */
  cleanFonts(rFonts, text) {
    if (this.font) {
      const latin = attribute => LATIN_FONT_SLOTS.has(attribute.local) && WORD_NAMESPACES.has(attribute.uri);
      const foreign = child => latin(child) && child.value !== this.font;
      const exception = rFonts.attributes.some(attribute => latin(attribute) && EXCEPTION_FONT.test(attribute.value));
      if (!exception && !needsOwnFont(text) && rFonts.attributes.some(foreign)) {
        rFonts.attributes = rFonts.attributes.filter(attribute => !foreign(attribute));
        this.fontsRemoved += 1;
      }
      const hint = rFonts.attributes.find(attribute => attribute.local === 'hint');
      if (hint?.value === 'eastAsia' && ![...text].some(character => fontSlot(character) === 'eastAsia')) rFonts.attributes = rFonts.attributes.filter(attribute => attribute !== hint);
    }
    return rFonts.attributes.some(attribute => attribute.local !== 'hint');
  }

  // ------------------------------------------------------------------------------------------
  // The body

  /** Rebuilds the body's children; returns the units, one per kept source child, in order. */
  buildBody(children) {
    const { plan } = this;
    const body = [];
    const units = [];
    let carried = [];
    this.sourceBreaks = new Map();
    this.finalSection = null;
    this.joinRoots = new Map();
    children.forEach((node, index) => {
      // Section properties are taken out here and put back by placeSections.
      if (isWord(node, 'sectPr')) { this.finalSection = node; return; }
      const pPr = isWord(node, 'p') ? firstWord(node, 'pPr') : null;
      const sectPr = pPr && firstWord(pPr, 'sectPr');
      if (sectPr) {
        this.sourceBreaks.set(index, sectPr);
        pPr.children.splice(pPr.children.indexOf(sectPr), 1);
      }
      if (plan.removed.has(index) && isRemovable(node)) {
        carried.push(...node.children.filter(child => isElement(child) && WORD_NAMESPACES.has(child.uri) && CARRIED.has(child.local)));
        this.declare(DECLARED.emptyRemoved, { at: index });
        return;
      }
      if (plan.removed.has(index)) this.declare(DECLARED.emptyKept, { at: index });
      const joinInto = plan.decisions.get(index)?.joinInto;
      if (joinInto !== undefined && this.joinRoots.has(joinInto)) {
        this.join(this.joinRoots.get(joinInto), node, index);
        return;
      }
      const produced = this.produce(node, index);
      if (isWord(node, 'p')) this.joinRoots.set(index, node);
      if (carried.length) {
        const target = produced.find(element => isWord(element, 'p'));
        if (target) {
          const at = target.children.findIndex(child => isWord(child, 'pPr')) + 1;
          target.children.splice(at, 0, ...carried);
          carried = [];
        }
      }
      units.push({ index, elements: produced });
      body.push(...produced);
    });
    // Markup carried past the last paragraph goes into the last one.
    if (carried.length) {
      const last = [...body].reverse().find(element => isWord(element, 'p'));
      if (last) last.children.push(...carried);
      else units.push({ index: children.length, elements: [this.el('p', {}, carried)] });
    }
    return units;
  }

  /** Joins a line of a pasted quotation to the paragraph it continues, with one space between. */
  join(root, node, index) {
    this.restyle(node, this.plan.decisions.get(index).style);
    const content = node.children.filter(child => !isWord(child, 'pPr'));
    const before = textOf(root);
    const after = textOf({ type: 'element', children: content });
    const space = /\s$/u.test(before) || /^\s/u.test(after) ? [] : [this.textRun(' ')];
    root.children.push(...space, ...content);
    // Declared at the first paragraph of the quotation (or subtitle), where the joined lines now are.
    const decision = this.plan.decisions.get(index);
    this.declare(decision.subtitle ? DECLARED.subtitleJoined : DECLARED.linesJoined, { at: decision.joinInto });
  }

  /** The elements a source child becomes (usually itself, restyled). */
  produce(node, index) {
    const decision = this.plan.decisions.get(index);
    if (this.plan.stanzaBreaks.has(index)) {
      this.restyle(node, 'verse');
      this.declare(DECLARED.stanzaBreak, { at: index });
      return [node];
    }
    if (!decision) return [node];
    const entry = this.paragraphs[index];
    if (isWord(node, 'tbl')) {
      for (const paragraph of descendants(node, 'p')) this.restyle(paragraph, 'table-text');
      return [node];
    }
    if (!isWord(node, 'p')) return [node];
    const key = decision.style;
    const emphasis = STYLE_CARRIES_EMPHASIS.has(key) ? { bold: entry.hints.bold, italic: entry.hints.italic } : null;
    const label = decision.labelBefore ? [this.labelParagraph(decision.labelBefore, index)] : [];
    if (decision.split) {
      const split = this.splitAt(node, decision.split, emphasis, index);
      if (split) return [...label, ...split];
    }
    if (label.length) {
      this.restyle(node, key, { emphasis });
      return [...label, node];
    }
    if (decision.figure) return this.figure(node, decision, emphasis, index);
    if (decision.captionLabel) {
      this.restyle(node, 'figure-caption', { emphasis });
      this.prefixLabel(node, decision.captionLabel, index);
      return [node, ...this.appendedCaption(decision, index)];
    }
    const typed = (key === 'heading-1' || key === 'heading-2') && decision.typedNumber && this.settings.headingNumbers;
    this.restyle(node, key, { emphasis, suppressNumber: typed });
    return [node, ...this.appendedCaption(decision, index)];
  }

  // ------------------------------------------------------------------------------------------
  // Titles

  /** A new chapter label line ("Chapter 3"), as a tracked insertion. */
  labelParagraph(text, index) {
    const paragraph = this.el('p', {}, [this.el('pPr'), this.inserted(this.textRun(text))]);
    this.restyle(paragraph, 'chapter-label');
    this.insertedMark(paragraph);
    this.declare(DECLARED.labelAdded, { addedWords: wordsOf(text), at: index });
    return paragraph;
  }

  /**
   * Splits a paragraph in two at a text offset: the text from `at` to `resume` (a colon and its
   * spaces, say) goes, the first part takes style `into[0]` and the second `into[1]`. Null when the
   * offset falls inside a link, field or content control, which is left whole.
   */
  splitAt(paragraph, { at, resume, into, kind, need }, emphasis, index) {
    const before = textOf(paragraph);
    let offset = 0;
    let found = null;
    for (const [position, child] of paragraph.children.entries()) {
      if (!isElement(child) || isWord(child, 'pPr')) continue;
      const length = textOf(child).length;
      if (offset + length > at) {
        if (isWord(child, 'r')) found = { position, local: at - offset };
        break;
      }
      offset += length;
    }
    if (!found) {
      this.need(need);
      return null;
    }
    const run = paragraph.children[found.position];
    const [head, tail] = splitRun(run, found.local);
    const first = { ...paragraph, children: [...paragraph.children.slice(0, found.position), head] };
    const second = { ...paragraph, children: [cloneNode(firstWord(paragraph, 'pPr') ?? this.el('pPr')), tail, ...paragraph.children.slice(found.position + 1)] };
    if (!firstWord(first, 'pPr')) first.children.unshift(this.el('pPr'));
    const cut = trimTrailing(head) + dropLeading(second, resume - at);
    this.restyle(first, into[0], { emphasis });
    this.restyle(second, into[1], { emphasis });
    if (into[1].endsWith('-subtitle')) this.splitSubtitles.add(second);
    // Tracked: the separator is deleted at the end of the first part, whose paragraph mark is new.
    if (cut) first.children.push(this.deletedRun(cut, firstWord(head, 'rPr')));
    this.insertedMark(first);
    this.declare(kind, { ...wordChange(before, `${textOf(first)} ${textOf(second)}`), at: index });
    return [first, second];
  }

  // ------------------------------------------------------------------------------------------
  // Tidying titles, headings and note marks

  /**
   * The tidy-ups right for any publisher, each a tracked change: in a chapter's title block and a
   * book's title page, spaces and line breaks at the ends of a line, quotation marks that open the
   * title and close the last subtitle, a colon ending a title that a subtitle follows, a full stop
   * ending a title or subtitle, a lower-case first letter of a subtitle split from its title, and
   * brackets around a whole affiliation line; spaces and line breaks at the ends of a heading;
   * the capitals of a heading repeated in every chapter (the bibliography's), made the same; and a
   * typed copy of a note's number next to its automatic mark.
   */
  tidy(units) {
    const entries = [];
    for (const unit of units) for (const element of unit.elements) if (isWord(element, 'p')) entries.push({ element, key: styleKeyOf(element, this.styled), at: unit.index });
    // Title blocks: runs of paragraphs in the chapter-* or book-* styles, one title each.
    const blocks = [];
    let block = null;
    for (const entry of entries) {
      const family = /^chapter-/u.test(entry.key ?? '') ? 'chapter' : /^book-/u.test(entry.key ?? '') ? 'book' : null;
      const isTitle = entry.key === `${family}-title`;
      if (family && block?.family === family && !(isTitle && block.items.some(item => item.key === entry.key))) block.items.push(entry);
      else if (family) { block = { family, items: [entry] }; blocks.push(block); } else block = null;
    }
    for (const { family, items } of blocks) this.tidyTitleBlock(family, items);
    for (const entry of entries) {
      if (TIDY_HEADINGS.has(entry.key)) this.trimEnds(entry.element, entry.at);
      this.typedNoteNumbers(entry.element, 'footnoteReference', entry.at);
      this.typedNoteNumbers(entry.element, 'endnoteReference', entry.at);
    }
    this.sameHeadingCase(entries.filter(entry => entry.key === 'bibliography-heading'));
  }

  tidyTitleBlock(family, items) {
    for (const item of items) this.trimEnds(item.element, item.at);
    const title = items.find(item => item.key === `${family}-title`);
    const subtitles = items.filter(item => item.key === `${family}-subtitle`);
    const last = subtitles[subtitles.length - 1];
    if (title && last) {
      // Quotation marks that open the title and close the last subtitle enclose no quotation of their own.
      const head = plainText(title.element);
      const tail = plainText(last.element);
      const close = QUOTE_PAIRS[head[0]];
      const opens = text => [...text].filter(character => character === head[0]).length;
      const closes = text => [...text].filter(character => character === close).length;
      if (close && tail.endsWith(close) && (close === head[0] ? opens(head) === 1 && opens(tail) === 1 : closes(head) === 0 && opens(tail) === 0)) {
        this.editText(last.element, tail.length - 1, tail.length, '', DECLARED.titleQuotes, last.at);
        this.editText(title.element, 0, 1, '', DECLARED.titleQuotes, title.at);
      }
      // A colon ending the title, before or after a closing quotation mark.
      const text = plainText(title.element);
      const colon = /\s*:(\s*[”’»"']?)\s*$/u.exec(text);
      if (colon) this.editText(title.element, colon.index, colon.index + colon[0].length - colon[1].length, '', DECLARED.titleColon, title.at);
    }
    for (const item of [title, ...subtitles].filter(Boolean)) {
      const text = plainText(item.element);
      if (/[^.\s]\.$/u.test(text) && !/(?:^|[\s.])\p{L}{1,3}\.$/u.test(text)) this.editText(item.element, text.length - 1, text.length, '', DECLARED.titleStop, item.at);
    }
    for (const item of subtitles) {
      if (!this.splitSubtitles.has(item.element)) continue;
      const text = plainText(item.element);
      const first = /^["'“‘«(]*(\p{Ll})/u.exec(text);
      if (first) this.editText(item.element, first[0].length - 1, first[0].length, first[1].toLocaleUpperCase(), DECLARED.subtitleCapital, item.at);
    }
    for (const item of items.filter(entry => entry.key === `${family}-affiliation`)) {
      const text = plainText(item.element);
      if (!/^\([^()]*\)$/u.test(text)) continue;
      this.editText(item.element, text.length - 1, text.length, '', DECLARED.affiliationBrackets, item.at);
      this.editText(item.element, 0, 1, '', DECLARED.affiliationBrackets, item.at);
    }
  }

  /** Removes white space and line breaks at the start and end of a paragraph, as tracked deletions. */
  trimEnds(paragraph, at) {
    const text = plainText(paragraph);
    const trailing = /\s+$/u.exec(text);
    if (trailing && trailing.index > 0) this.editText(paragraph, trailing.index, text.length, '', DECLARED.titleSpaces, at);
    const now = plainText(paragraph);
    const leading = /^\s+/u.exec(now);
    if (leading && leading[0].length < now.length) this.editText(paragraph, 0, leading[0].length, '', DECLARED.titleSpaces, at);
  }

  /**
   * A heading repeated in every chapter (the bibliography's) typed with different capitals: each
   * is made like the variant that follows the rule sheet's heading case, or, with no rule, like
   * the variant most of them use; with no such variant they are left and the author is asked.
   */
  sameHeadingCase(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const text = plainText(entry.element).trim();
      if (!text) continue;
      const key = text.toLocaleLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...entry, text });
    }
    for (const group of groups.values()) {
      const variants = new Map();
      for (const entry of group) variants.set(entry.text, (variants.get(entry.text) ?? 0) + 1);
      if (variants.size < 2) continue;
      const byRule = this.settings.headingsCase ? [...variants.keys()].filter(variant => followsCase(variant, this.settings.headingsCase)) : [];
      const [top, second] = [...variants].sort((a, b) => b[1] - a[1]);
      const target = byRule.length === 1 ? byRule[0] : byRule.length === 0 && top[1] > second[1] ? top[0] : null;
      if (!target) { this.need('repeated heading typed with different capitals to make the same'); continue; }
      const targetWords = target.split(/(\s+)/u);
      for (const entry of group) {
        if (entry.text === target) continue;
        // Word by word, at the word's place in the paragraph's text.
        let offset = plainText(entry.element).indexOf(entry.text);
        const changes = [];
        entry.text.split(/(\s+)/u).forEach((word, position) => {
          if (word !== targetWords[position] && word.toLocaleLowerCase() === targetWords[position]?.toLocaleLowerCase()) changes.push([offset, offset + word.length, targetWords[position]]);
          offset += word.length;
        });
        for (const [start, end, word] of changes.reverse()) this.editText(entry.element, start, end, word, DECLARED.headingCase, entry.at);
      }
    }
  }

  /**
   * A note's number typed by hand next to its automatic mark (a superscript run of digits right
   * after the reference in the text, or right after the mark in the note): the typed copy goes.
   * In a note, a space stays between the mark and the text.
   */
  typedNoteNumbers(paragraph, mark, at) {
    let pieces = textPieces(paragraph);
    for (let position = 0; position + 1 < pieces.length; position += 1) {
      const { run, parent } = pieces[position];
      if (![...descendants(run)].some(node => isWord(node, mark))) continue;
      const next = pieces[position + 1];
      if (next.parent !== parent || parent.children.indexOf(next.run) !== parent.children.indexOf(run) + 1) continue;
      const digits = /^(\s*)(\d{1,3})(\s*)$/u.exec(textOf(next.run));
      const properties = firstWord(next.run, 'rPr');
      const align = properties && firstWord(properties, 'vertAlign');
      if (!digits || !align || wordAttribute(align, 'val') !== 'superscript') continue;
      const after = plainText(paragraph).slice(next.end);
      const space = mark === 'footnoteRef' && !digits[1] && !digits[3] && after && !/^\s/u.test(after) ? ' ' : '';
      this.editText(paragraph, next.start + digits[1].length, next.start + digits[1].length + digits[2].length, space, DECLARED.typedNoteNumber, at);
      pieces = textPieces(paragraph);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Figures

  figure(paragraph, decision, emphasis, index) {
    const { label, placeholder } = decision.figure;
    const form = this.settings.figureMarker;
    const markerText = `${form.before}${label}${form.after}`;
    const out = [];
    if (placeholder) {
      // The paragraph is already a placement marker: its text becomes the marker the rule asks for.
      const before = textOf(paragraph);
      // Tracked: the old marker's text is deleted (a note reference in it stays), the new one inserted.
      this.deleteAllText(paragraph);
      const at = paragraph.children.findIndex(child => isWord(child, 'pPr')) + 1;
      paragraph.children.splice(at, 0, this.inserted(this.textRun(markerText)));
      this.restyle(paragraph, 'figure-marker');
      this.declare(DECLARED.markerRewritten, { ...wordChange(before, markerText), at: index });
      out.push(paragraph);
      if (!decision.figure.captionAt) {
        out.push(this.captionParagraph(label, index));
        // A marker that carries a note often holds its caption there; moving it is the author's call.
        this.need([...descendants(paragraph)].some(node => isWord(node, 'footnoteReference') || isWord(node, 'endnoteReference')) ? 'figure caption to write (the marker\'s note may hold it)' : 'figure caption to write');
      }
      return out;
    }
    const marker = this.el('p', {}, [this.el('pPr'), this.inserted(this.textRun(markerText))]);
    this.restyle(marker, 'figure-marker');
    this.insertedMark(marker);
    this.declare(DECLARED.markerAdded, { addedWords: wordsOf(markerText), at: index });
    out.push(marker);
    if (decision.style === 'figure') {
      this.restyle(paragraph, 'figure');
      out.push(paragraph);
    } else {
      this.restyle(paragraph, 'figure-caption', { emphasis });
      this.prefixLabel(paragraph, label, index);
      out.push(paragraph);
    }
    out.push(...this.appendedCaption(decision, index));
    return out;
  }

  appendedCaption(decision, index) {
    if (!decision.appendCaption) return [];
    this.need('figure caption to write');
    return [this.captionParagraph(decision.appendCaption, index)];
  }

  captionParagraph(label, index) {
    const text = `${this.settings.figureMarker.label} ${label}`;
    const paragraph = this.el('p', {}, [this.el('pPr'), this.inserted(this.textRun(text))]);
    this.restyle(paragraph, 'figure-caption');
    this.insertedMark(paragraph);
    this.declare(DECLARED.captionAdded, { addedWords: wordsOf(text), at: index });
    return paragraph;
  }

  prefixLabel(paragraph, label, index) {
    const text = `${this.settings.figureMarker.label} ${label} `;
    const at = paragraph.children.findIndex(child => isWord(child, 'pPr')) + 1;
    paragraph.children.splice(at, 0, this.inserted(this.textRun(text)));
    this.declare(DECLARED.captionNumbered, { addedWords: wordsOf(text), at: index });
  }

  textRun(text) {
    return this.el('r', {}, [this.el('t', { 'xml:space': 'preserve' }, [{ type: 'text', text }])]);
  }

  // ------------------------------------------------------------------------------------------
  // Tracked changes

  revision() {
    this.revisions += 1;
    const id = String(this.nextRevision);
    this.nextRevision += 1;
    return { id, author: REVISION_AUTHOR, date: this.date };
  }

  /** A run wrapped as a tracked insertion. */
  inserted(run) { return this.el('ins', this.revision(), [run]); }

  /** A tracked deletion of some text, with the run properties of the text it was. */
  deletedRun(text, properties) {
    const run = this.el('r', {}, [...(properties ? [cloneNode(properties)] : []), this.el('delText', { 'xml:space': 'preserve' }, [{ type: 'text', text }])]);
    return this.el('del', this.revision(), [run]);
  }

  /**
   * A run's text as a tracked deletion: the whole run when it holds only text, otherwise its text
   * in a deleted copy before it and the rest (a note reference, say) kept.
   */
  deleteText(run) {
    const texts = run.children.filter(child => isWord(child, 't'));
    if (!texts.length) return [run];
    const text = texts.map(node => node.children.map(part => part.text ?? '').join('')).join('');
    const rest = run.children.filter(child => !isWord(child, 't'));
    const kept = rest.some(child => isElement(child) && !isWord(child, 'rPr'));
    const deleted = this.deletedRun(text, firstWord(run, 'rPr'));
    return kept ? [deleted, { ...run, children: rest }] : [deleted];
  }

  /** Every run's text in a paragraph as a tracked deletion, at any depth (inside a link, say). */
  deleteAllText(node) {
    node.children = node.children.flatMap(child => {
      if (isWord(child, 'r')) return this.deleteText(child);
      if (isElement(child) && !isWord(child, 'pPr') && !isWord(child, 'del')) this.deleteAllText(child);
      return [child];
    });
  }

  /**
   * Replaces the visible text from `start` to `end` (offsets in textOf's terms, a break or a tab
   * counting one) with `insert`, as a tracked deletion and insertion, and declares the words it
   * changed under `kind` at source paragraph `at`. Runs are split at the edges; the inserted run
   * takes the properties of the first deleted one, or of the run before the place. Returns the
   * text removed, or null when the range falls inside a link, field or other markup that is not a
   * plain run (left as it is).
   */
  editText(paragraph, start, end, insert, kind, at) {
    const before = plainText(paragraph);
    if (start < 0 || end > before.length || start > end || (start === end && !insert)) return null;
    for (const offset of [start, end]) {
      const piece = textPieces(paragraph).find(entry => entry.start < offset && entry.end > offset);
      if (!piece) continue;
      if (!isWord(piece.run, 'r')) return null;
      const [head, tail] = splitRun(piece.run, offset - piece.start);
      piece.parent.children.splice(piece.parent.children.indexOf(piece.run), 1, head, tail);
    }
    const pieces = textPieces(paragraph);
    const covered = pieces.filter(entry => entry.start >= start && entry.end <= end && entry.end > entry.start);
    if (covered.some(entry => entry.parent !== covered[0].parent)) return null;
    if (covered.some(entry => [...descendants(entry.run)].some(node => isWord(node, 'footnoteReference') || isWord(node, 'endnoteReference') || isWord(node, 'fldChar') || isWord(node, 'instrText') || isWord(node, 'drawing')))) return null;
    const removed = covered.map(entry => textOf(entry.run)).join('');
    const deletions = covered.map(entry => {
      const deletion = this.deletedCopy(entry.run);
      entry.parent.children.splice(entry.parent.children.indexOf(entry.run), 1, deletion);
      return deletion;
    });
    if (insert) {
      const model = covered[0]?.run ?? [...pieces].reverse().find(entry => entry.end <= start)?.run ?? pieces.find(entry => entry.start >= end)?.run;
      const run = this.textRun(insert);
      const properties = model && firstWord(model, 'rPr');
      if (properties) run.children.unshift(cloneNode(properties));
      const inserted = this.inserted(run);
      if (covered.length) {
        const { parent } = covered[covered.length - 1];
        parent.children.splice(parent.children.indexOf(deletions[deletions.length - 1]) + 1, 0, inserted);
      } else {
        const next = pieces.find(entry => entry.start >= start);
        const parent = next?.parent ?? paragraph;
        const index = next ? parent.children.indexOf(next.run) : parent.children.length;
        parent.children.splice(index, 0, inserted);
      }
    }
    this.declare(kind, { ...wordChange(before, plainText(paragraph)), at });
    return removed;
  }

  /** A run as a tracked deletion: its text becomes deleted text. */
  deletedCopy(run) {
    const copy = cloneNode(run);
    for (const node of descendants(copy)) {
      if (!isWord(node, 't')) continue;
      node.name = node.name.replace(/t$/u, 'delText');
      node.local = 'delText';
    }
    return this.el('del', this.revision(), [copy]);
  }

  /** Marks a paragraph's mark as a tracked insertion: the paragraph is new, or split from the next. */
  insertedMark(paragraph) {
    let pPr = firstWord(paragraph, 'pPr');
    if (!pPr) { pPr = this.el('pPr'); paragraph.children.unshift(pPr); }
    let rPr = firstWord(pPr, 'rPr');
    if (!rPr) { rPr = this.el('rPr'); insertOrdered(pPr, rPr, PPR_RANK); }
    rPr.children = [this.el('ins', this.revision()), ...rPr.children.filter(child => !isWord(child, 'ins'))];
  }

  // ------------------------------------------------------------------------------------------
  // Sections

  /**
   * Puts the section breaks back. With notes restarting in each chapter, every chapter is a
   * section of its own and a break inside a chapter is removed; otherwise the source's breaks stay
   * where they were (one in a removed empty paragraph moves to the paragraph before it).
   */
  placeSections(units, bodyElement) {
    const { chapters } = this.plan;
    const restart = this.settings.notesRestart;
    const insideChapter = index => chapters.some(chapter => index >= chapter.first && index < chapter.last);
    const sourceIndices = [...this.sourceBreaks.keys()];
    // The source break that closes the section holding a source index.
    const closing = index => {
      const at = sourceIndices.find(breakIndex => breakIndex >= index);
      return at === undefined ? this.finalSection : this.sourceBreaks.get(at);
    };
    const unitAt = index => {
      let found = -1;
      for (let position = 0; position < units.length && units[position].index <= index; position += 1) found = position;
      return found;
    };
    // Where breaks go: after a unit, with the properties to use.
    const breaks = new Map();
    for (const [index, sectPr] of this.sourceBreaks) {
      if (restart && insideChapter(index)) { this.declare(DECLARED.breakInsideRemoved, { at: index }); continue; }
      const position = unitAt(index);
      if (position < 0) { this.declare(DECLARED.emptySectionRemoved, { at: index }); continue; }
      if (breaks.has(position)) { this.declare(DECLARED.emptySectionRemoved, { at: index }); continue; }
      breaks.set(position, sectPr);
    }
    // Numbering the front matter apart takes a section break before the first chapter.
    if (this.settings.pageSequences && chapters.length) {
      const position = unitAt(chapters[0].first - 1);
      if (position >= 0 && !breaks.has(position)) {
        const copy = cloneNode(closing(units[position].index));
        setSectionType(copy, this.prefix, 'nextPage');
        removeStartPageNumber(copy);
        breaks.set(position, copy);
        this.declare(DECLARED.breakAdded, { at: chapters[0].first });
      }
      this.frontPosition = position;
    }
    if (restart) {
      for (const chapter of chapters) {
        const position = unitAt(chapter.first - 1);
        if (position < 0 || breaks.has(position)) continue;
        const copy = cloneNode(closing(units[position].index));
        setSectionType(copy, this.prefix, 'nextPage');
        removeStartPageNumber(copy);
        // A chapter's new section shows the page number on its first page as on the others: a
        // different first page copied from the source's section would hide it on every chapter.
        if (dropFirstPage(copy)) this.declare(DECLARED.firstPageDropped, { at: chapter.first });
        breaks.set(position, copy);
        this.declare(DECLARED.breakAdded, { at: chapter.first });
      }
    }
    // A break on the last unit would leave the body's own section empty: its properties become the
    // body's, as they are the ones of the section that holds the last text.
    let final = this.finalSection ?? this.el('sectPr');
    if (breaks.has(units.length - 1)) {
      final = breaks.get(units.length - 1);
      breaks.delete(units.length - 1);
      this.declare(DECLARED.emptySectionRemoved);
    }
    const body = [];
    const weights = new Map();
    let paragraphsSince = 0;
    units.forEach((unit, position) => {
      body.push(...unit.elements);
      paragraphsSince += unit.elements.length;
      const sectPr = breaks.get(position);
      if (!sectPr) return;
      weights.set(sectPr, paragraphsSince);
      paragraphsSince = 0;
      let last = unit.elements[unit.elements.length - 1];
      if (!isWord(last, 'p')) {
        last = this.el('p', {}, [this.el('pPr')]);
        body.push(last);
        unit.elements.push(last);
        this.declare(DECLARED.carrierAdded, { at: unit.index });
      }
      let pPr = firstWord(last, 'pPr');
      if (!pPr) { pPr = this.el('pPr'); last.children.unshift(pPr); }
      insertOrdered(pPr, sectPr, PPR_RANK);
    });
    const sections = [...breaks.values(), final];
    weights.set(final, paragraphsSince);
    // The sections in document order, and how many of them hold the front matter.
    const ordered = [...breaks.entries()].sort((a, b) => a[0] - b[0]);
    this.sectionsInOrder = [...ordered.map(([, sectPr]) => sectPr), final];
    this.frontSections = this.frontPosition === undefined || this.frontPosition < 0 ? 0 : ordered.filter(([position]) => position <= this.frontPosition).length;
    if (restart) for (const sectPr of sections) restartNotes(sectPr, this.prefix);
    this.sections = sections.length;
    this.sectionList = sections;
    this.sectionWeights = weights;
    body.push(final);
    bodyElement.children = body;
  }

  /**
   * The page: with a margins rule, every section takes it; without one, a section whose page size
   * or margins differ from those of most of the text (by paragraphs) takes theirs, unless it is
   * turned the other way (a landscape page for a wide table). With a page-number rule, each section
   * shows the page number where it asks, replacing headers and footers that hold nothing else.
   */
  pageMargins(files, main, document) {
    const sections = this.sectionList ?? [];
    const setup = sectPr => {
      const size = firstWord(sectPr, 'pgSz');
      const margin = firstWord(sectPr, 'pgMar');
      return { size, margin, key: JSON.stringify([size?.attributes.map(a => [a.local, a.value]).sort(), margin?.attributes.map(a => [a.local, a.value]).sort()]), landscape: Boolean(size && (wordAttribute(size, 'orient') === 'landscape' || Number(wordAttribute(size, 'w')) > Number(wordAttribute(size, 'h')))) };
    };
    let changed = 0;
    let ruled = 0;
    const sides = ['top', 'right', 'bottom', 'left'];
    // The margin of each side the sheet sets: by side when it gives sides, else the one margin.
    const target = Object.fromEntries(sides.map(side => [side, this.settings.marginSides?.[side] ?? this.settings.margins ?? null]));
    if (this.settings.paper) {
      const [width, height] = this.settings.paper === 'a4' ? ['11906', '16838'] : ['12240', '15840'];
      let sized = 0;
      for (const sectPr of sections) {
        let size = firstWord(sectPr, 'pgSz');
        if (!size) { size = this.el('pgSz'); insertOrdered(sectPr, size, SECTION_RANK); }
        const landscape = setup(sectPr).landscape;
        const [w, h] = landscape ? [height, width] : [width, height];
        if (wordAttribute(size, 'w') !== w || wordAttribute(size, 'h') !== h) sized += 1;
        setWordAttribute(size, 'w', w);
        setWordAttribute(size, 'h', h);
      }
      if (sized) this.declare(DECLARED.paper, { count: sized });
    }
    if (sides.some(side => target[side] !== null)) {
      for (const sectPr of sections) {
        let margin = firstWord(sectPr, 'pgMar');
        if (!margin) { margin = this.el('pgMar', { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708, gutter: 0 }); insertOrdered(sectPr, margin, SECTION_RANK); }
        let differs = false;
        for (const side of sides) {
          if (target[side] === null) continue;
          const twips = String(Math.round(target[side] * 1440));
          if (wordAttribute(margin, side) !== twips) differs = true;
          setWordAttribute(margin, side, twips);
        }
        if (differs) ruled += 1;
      }
      if (ruled) this.declare(DECLARED.margins, { count: ruled });
    }
    // The sides the sheet leaves unset, and the page size when it sets none, follow most of the text.
    if (!sides.every(side => target[side] !== null) || !this.settings.paper) {
      const tally = new Map();
      for (const sectPr of sections) {
        const look = setup(sectPr);
        if (!look.size || !look.margin || look.landscape) continue;
        tally.set(look.key, { look, weight: (tally.get(look.key)?.weight ?? 0) + (this.sectionWeights?.get(sectPr) ?? 0) });
      }
      const top = [...tally.values()].sort((a, b) => b.weight - a.weight)[0];
      if (top && tally.size > 1) {
        for (const sectPr of sections) {
          const look = setup(sectPr);
          if (look.landscape || look.key === top.look.key || !look.size || !look.margin) continue;
          if (!this.settings.paper) sectPr.children.splice(sectPr.children.indexOf(look.size), 1, cloneNode(top.look.size));
          // Only the sides the sheet does not set are taken from most of the text.
          for (const side of sides) if (target[side] === null && wordAttribute(top.look.margin, side) !== undefined) setWordAttribute(look.margin, side, wordAttribute(top.look.margin, side));
          for (const name of ['header', 'footer', 'gutter']) if (wordAttribute(top.look.margin, name) !== undefined) setWordAttribute(look.margin, name, wordAttribute(top.look.margin, name));
          changed += 1;
        }
      }
    }
    if (changed) this.declare(DECLARED.pageSetup, { count: changed });
    if (this.settings.pageNumbers) this.placePageNumbers(files, main, document, sections);
  }

  /**
   * The accessibility fixes that are safe: the document title in the file's properties, from the
   * book's or the first chapter's title, when the file has none; and the first row of a table marked
   * as a header row when it is set apart as one (all bold, or shaded unlike the row below).
   */
  accessibilityFixes(files, body) {
    this.headerRows = 0;
    for (const table of elements(body, 'tbl')) {
      const facts = tableFacts(table);
      if (facts.header || !facts.looksLikeHeader || !facts.firstRow) continue;
      const row = facts.firstRow;
      let trPr = firstWord(row, 'trPr');
      if (!trPr) {
        trPr = this.el('trPr');
        const at = row.children.findIndex(child => isElement(child) && !isWord(child, 'tblPrEx'));
        row.children.splice(at < 0 ? row.children.length : at, 0, trPr);
      }
      trPr.children = [...trPr.children.filter(child => !isWord(child, 'tblHeader')), this.el('tblHeader')];
      this.headerRows += 1;
    }
    if (this.headerRows) this.declare(DECLARED.tableHeader, { count: this.headerRows });
    const core = coreTitle(files);
    if (!core.part || core.title) return;
    let source = null;
    for (const key of ['book-title', 'chapter-title']) {
      this.plan.decisions.forEach((decision, index) => { if (source === null && decision.style === key) source = index; });
      if (source !== null) break;
    }
    const title = source === null ? '' : (this.paragraphs[source]?.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 250);
    if (!title) return;
    let element = core.element;
    if (!element) {
      const declared = core.root.attributes.find(attribute => attribute.prefix === 'xmlns' && attribute.value === DC_NS);
      const prefix = declared ? declared.local : 'dc';
      if (!declared) core.root.attributes.push({ name: 'xmlns:dc', prefix: 'xmlns', local: 'dc', uri: 'http://www.w3.org/2000/xmlns/', value: DC_NS });
      element = { type: 'element', name: `${prefix}:title`, prefix, local: 'title', uri: DC_NS, attributes: [], children: [] };
      core.root.children.unshift(element);
    }
    element.children = [{ type: 'text', text: title }];
    files.set(core.part, encoder.encode(serializeXml(core.root)));
    this.titleSet = title;
    this.declare(DECLARED.docTitle, { at: source });
  }

  /** Headers and footers: Latin text set in another font by direct formatting takes the body font. */
  cleanMarginFonts(files, main) {
    for (const rel of relationshipsOf(files, main)) {
      if (!/\/(header|footer)$/u.test(rel.type) || rel.external || !files.has(rel.resolved)) continue;
      const root = parseXml(files.get(rel.resolved)).root;
      const before = this.fontsRemoved;
      for (const paragraph of descendants(root, 'p')) {
        const mark = firstWord(firstWord(paragraph, 'pPr') ?? { children: [] }, 'rPr');
        const runs = [...runsOf(paragraph)].map(run => [firstWord(run, 'rPr'), textOf(run)]);
        for (const [rPr, text] of [[mark, ''], ...runs]) {
          const fonts = rPr && firstWord(rPr, 'rFonts');
          if (fonts && !this.cleanFonts(fonts, text)) rPr.children.splice(rPr.children.indexOf(fonts), 1);
        }
      }
      if (this.fontsRemoved !== before) files.set(rel.resolved, encoder.encode(serializeXml(root)));
    }
  }

  placePageNumbers(files, main, document, sections, position = this.settings.pageNumbers, kindDeclared = DECLARED.pageNumbers) {
    const [where, side] = position.split('-');
    const kind = where === 'top' ? 'header' : 'footer';
    // Headers and footers that hold text other than a page number are the author's to move.
    const parts = relationshipsOf(files, main).filter(rel => /\/(header|footer)$/u.test(rel.type) && !rel.external && files.has(rel.resolved));
    const holdsText = parts.some(rel => {
      const root = parseXml(files.get(rel.resolved)).root;
      return [...descendants(root, 'p')].some(paragraph => textOf(paragraph).trim() !== '');
    });
    if (holdsText) { this.need('page numbers to place by hand (the headers or footers hold other text)'); return false; }
    const jc = side === 'center' ? 'center' : side === 'left' ? 'left' : 'right';
    const element = kind === 'header' ? 'hdr' : 'ftr';
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${element} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:${element}>`;
    const name = addRelatedPart(files, main, kind, xml);
    const id = relationshipsOf(files, main).find(rel => rel.resolved === name)?.id;
    if (!id) return false;
    const relPrefix = relationshipPrefix(document);
    for (const sectPr of sections) {
      sectPr.children = sectPr.children.filter(child => !(isWord(child, 'headerReference') || isWord(child, 'footerReference') || isWord(child, 'titlePg')));
      sectPr.children.unshift(this.partReference(`${kind}Reference`, 'default', id, relPrefix));
    }
    this.declare(kindDeclared, { count: sections.length });
    return true;
  }

  partReference(local, type, id, relPrefix) {
    const reference = this.el(local, { type });
    reference.attributes.push({ name: `${relPrefix}:id`, prefix: relPrefix, local: 'id', uri: REL_NS, value: id });
    return reference;
  }

  /**
   * Two page-number sequences: the sections before the first chapter numbered in lower-case roman
   * (or arabic) from 1, the first chapter's section from arabic 1 when the sheet restarts there, the
   * others continuing; the title page counted but showing no number (a different first page with an
   * empty header and footer). Every page shows a number: where the file and the sheet give no place
   * for it, it goes at the bottom centre and the summary says so.
   */
  pageSequences(files, main, document) {
    const sequences = this.settings.pageSequences;
    const sections = this.sectionsInOrder ?? this.sectionList ?? [];
    if (!sections.length) return;
    const front = this.frontSections ?? 0;
    if (!front) this.need('front matter to number apart from the chapters (no first chapter was found, so no section break could be placed)');
    // Page numbers in the file, from the sheet's place or the source's own.
    const parts = relationshipsOf(files, main).filter(rel => /\/(header|footer)$/u.test(rel.type) && !rel.external && files.has(rel.resolved));
    const hasPage = parts.some(rel => /\bPAGE\b/u.test(new TextDecoder().decode(files.get(rel.resolved))));
    if (!this.settings.pageNumbers && !hasPage && sequences.preliminary !== 'none') this.placePageNumbers(files, main, document, sections, 'bottom-center', DECLARED.pageNumbersAdded);
    const format = sequences.preliminary === 'lower-roman' ? 'lowerRoman' : 'decimal';
    let numbered = 0;
    sections.forEach((sectPr, at) => {
      let numbers = firstWord(sectPr, 'pgNumType');
      if (!numbers) { numbers = this.el('pgNumType'); insertOrdered(sectPr, numbers, SECTION_RANK); }
      const isFront = at < front;
      setWordAttribute(numbers, 'fmt', isFront ? format : 'decimal');
      numbers.attributes = numbers.attributes.filter(attribute => attribute.local !== 'start');
      // The first section starts at 1; so does the first chapter's when the sheet restarts there.
      if (at === 0 || (at === front && (sequences.restart || format !== 'decimal'))) setWordAttribute(numbers, 'start', '1');
      // A different first page hides a number; only the title page's section keeps one, when asked.
      if (at > 0) sectPr.children = sectPr.children.filter(child => !isWord(child, 'titlePg') && !((isWord(child, 'headerReference') || isWord(child, 'footerReference')) && wordAttribute(child, 'type') === 'first'));
      numbered += 1;
    });
    if (front) this.declare(DECLARED.pageSequences, { count: numbered });
    if (sequences.titlePage === 'counted-not-shown' && front) {
      const first = sections[0];
      const relPrefix = relationshipPrefix(document);
      first.children = first.children.filter(child => !isWord(child, 'titlePg') && !((isWord(child, 'headerReference') || isWord(child, 'footerReference')) && wordAttribute(child, 'type') === 'first'));
      for (const [kind, element] of [['header', 'hdr'], ['footer', 'ftr']]) {
        const name = addRelatedPart(files, main, kind, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${element} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:${element}>`);
        const id = relationshipsOf(files, main).find(rel => rel.resolved === name)?.id;
        if (id) first.children.unshift(this.partReference(`${kind}Reference`, 'first', id, relPrefix));
      }
      // The references come first, headers before footers, as Word writes them.
      const references = first.children.filter(child => isWord(child, 'headerReference') || isWord(child, 'footerReference'));
      first.children = [...references.filter(child => isWord(child, 'headerReference')), ...references.filter(child => isWord(child, 'footerReference')), ...first.children.filter(child => !references.includes(child))];
      insertOrdered(first, this.el('titlePg'), SECTION_RANK);
      this.declare(DECLARED.titlePageUnnumbered);
    }
  }

  /**
   * Each chapter, and each major section outside the chapters (a front- or back-matter heading, an
   * appendix, the copyright, approval and dedication pages, a single bibliography), starts on a new
   * page: its first paragraph gets "page break before", unless a section break already starts one.
   */
  pageBreaks(units) {
    const starts = new Set(this.plan.chapters.map(chapter => chapter.first));
    let previousRole = null;
    let bibliographies = 0;
    this.plan.decisions.forEach(decision => { if (decision.style === 'bibliography-heading') bibliographies += 1; });
    const decisionRole = index => this.plan.decisions.get(index)?.style ?? null;
    for (const unit of units) {
      const key = decisionRole(unit.index);
      // A page of its own (copyright, approval, dedication) starts with its first line, unless its heading went before.
      const runStart = ['copyright-page', 'approval-page', 'dedication'].includes(key) && previousRole !== key && previousRole !== 'front-matter-heading';
      if (key) previousRole = key;
      const major = starts.has(unit.index) || key === 'front-matter-heading' || key === 'appendix-heading' || runStart || (key === 'bibliography-heading' && bibliographies === 1);
      if (!major || unit === units[0]) continue;
      const paragraph = unit.elements.find(element => isWord(element, 'p'));
      if (!paragraph) continue;
      // A paragraph right after a section break of type "next page" already starts a page.
      const before = units[units.indexOf(unit) - 1];
      const last = before?.elements[before.elements.length - 1];
      const sectPr = last && isWord(last, 'p') ? firstWord(firstWord(last, 'pPr') ?? { children: [] }, 'sectPr') : null;
      const type = sectPr && firstWord(sectPr, 'type') ? wordAttribute(firstWord(sectPr, 'type'), 'val') : sectPr ? 'nextPage' : null;
      if (type && type !== 'continuous') continue;
      let pPr = firstWord(paragraph, 'pPr');
      if (!pPr) { pPr = this.el('pPr'); paragraph.children.unshift(pPr); }
      if (firstWord(pPr, 'pageBreakBefore')) continue;
      insertOrdered(pPr, this.el('pageBreakBefore'), PPR_RANK);
      this.declare(DECLARED.pageBreakBefore, { at: unit.index });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Numbering and notes

  /** Adds Word numbering for section headings; returns the numbering by style key. */
  addHeadingNumbering(files, main) {
    const part = relatedPart(files, main, 'numbering') ?? addRelatedPart(files, main, 'numbering', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
    const root = parseXml(files.get(part)).root;
    const prefix = root.prefix ?? 'w';
    // New ids above the document's own, as whole numbers; any other value in the part is ignored.
    const wholeNumbers = values => values.filter(value => /^\d{1,9}$/.test(value ?? '')).map(Number);
    const abstractId = String(Math.max(-1, ...wholeNumbers(elements(root, 'abstractNum').map(node => wordAttribute(node, 'abstractNumId')))) + 1);
    const numId = String(Math.max(0, ...wholeNumbers(elements(root, 'num').map(node => wordAttribute(node, 'numId')))) + 1);
    const level = (ilvl, format, text, suffix, indent) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${suffix ? `<w:suff w:val="${suffix}"/>` : ''}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr>${indent}</w:pPr></w:lvl>`;
    // Level 0 is the chapter title, unnumbered, so the section numbers start again in each chapter.
    const abstract = parseFragment(prefix, '<w:abstractNum><w:multiLevelType w:val="multilevel"/>'
      + level(0, 'none', '', 'nothing', '<w:ind w:left="0" w:firstLine="0"/>')
      + level(1, 'decimal', '%2', null, '<w:ind w:left="567" w:hanging="567"/>')
      + level(2, 'decimal', '%2.%3', null, '<w:ind w:left="567" w:hanging="567"/>')
      + '</w:abstractNum>');
    const num = parseFragment(prefix, '<w:num><w:abstractNumId/></w:num>');
    // The ids are set as attributes, like every value worked out from the document.
    setWordAttribute(abstract, 'abstractNumId', abstractId);
    setWordAttribute(num, 'numId', numId);
    setWordAttribute(firstWord(num, 'abstractNumId'), 'val', abstractId);
    // Every w:abstractNum comes before the first w:num.
    const firstNum = root.children.findIndex(child => isWord(child, 'num') || isWord(child, 'numIdMacAtCleanup'));
    if (firstNum < 0) root.children.push(abstract);
    else root.children.splice(firstNum, 0, abstract);
    const cleanup = root.children.findIndex(child => isWord(child, 'numIdMacAtCleanup'));
    if (cleanup < 0) root.children.push(num);
    else root.children.splice(cleanup, 0, num);
    files.set(part, encoder.encode(serializeXml(root)));
    const added = this.numberedHeadings();
    if (added.length) this.declare(DECLARED.headingNumbers, { count: added.length, at: added });
    return { 'chapter-title': { numId, ilvl: 0 }, 'heading-1': { numId, ilvl: 1 }, 'heading-2': { numId, ilvl: 2 } };
  }

  /** The headings that Word numbering numbers: every heading except those of chapters with typed numbers. */
  numberedHeadings() {
    const indices = [];
    this.plan.decisions.forEach((decision, index) => { if (!decision.typedNumber && (decision.style === 'heading-1' || decision.style === 'heading-2')) indices.push(index); });
    return indices.sort((a, b) => a - b);
  }

  /** Every figure the formatter numbered: its first paragraph, number, and whether it was a placeholder marker. */
  figures() {
    const figures = [];
    this.plan.decisions.forEach((decision, index) => {
      if (decision.figure) figures.push({ index, label: decision.figure.label, placeholder: decision.figure.placeholder, captionAt: decision.figure.captionAt });
    });
    return figures.sort((a, b) => a.index - b.index);
  }

  restyleNotes(root, mark = 'footnoteRef') {
    for (const note of elements(root)) {
      const type = wordAttribute(note, 'type');
      if (type && type !== 'normal') continue;
      for (const paragraph of elements(note, 'p')) {
        this.restyle(paragraph, 'note-text');
        this.typedNoteNumbers(paragraph, mark, []);
      }
    }
  }

  report(units) {
    const map = [];
    for (const unit of units) for (const element of unit.elements) map.push({ source: unit.index, style: styleKeyOf(element, this.styled) });
    return {
      settings: this.settings,
      chapters: this.plan.chapters.map(({ first, last, number, parts, typedNumbers, titleBlock }) => ({ first, last, number, parts, titleBlock, typedNumbers })),
      styles: { ...this.styleCounts },
      declared: [...this.declared.values()],
      figures: this.figures(),
      needsAuthor: { ...this.needsAuthor },
      sections: this.sections,
      revisions: this.revisions,
      map,
    };
  }
}

// ------------------------------------------------------------------------------------------
// Helpers

function styleKeyOf(element, styled) {
  if (!isWord(element, 'p')) return null;
  const pStyle = firstWord(firstWord(element, 'pPr') ?? { children: [] }, 'pStyle');
  return pStyle ? styled.get(pStyle) ?? null : null;
}

/**
 * The visible pieces of a paragraph's text, in order: each run (at any depth, not inside a
 * deletion) with the element that holds it and its offsets in textOf's terms.
 */
function textPieces(paragraph) {
  const out = [];
  let offset = 0;
  const walk = node => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (isWord(child, 'pPr') || isWord(child, 'del') || isWord(child, 'moveFrom') || isWord(child, 'p') || isWord(child, 'tbl')) continue;
      if (isWord(child, 'r')) {
        const length = textOf(child).length;
        out.push({ run: child, parent: node, start: offset, end: offset + length });
        offset += length;
        continue;
      }
      walk(child);
    }
  };
  walk(paragraph);
  return out;
}

/** A paragraph's visible text without its properties (whose tab stops textOf counts as spaces). */
const plainText = paragraph => textPieces(paragraph).map(piece => textOf(piece.run)).join('');

/** The runs of a paragraph, at any depth (inside links, content controls and smart tags). */
function* runsOf(node) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (isWord(child, 'r')) { yield child; continue; }
    if (isWord(child, 'pPr') || isWord(child, 'p') || isWord(child, 'tbl')) continue;
    yield* runsOf(child);
  }
}

function isRemovable(paragraph) {
  if (!isWord(paragraph, 'p')) return false;
  if (textOf(paragraph).trim() !== '') return false;
  for (const node of descendants(paragraph)) {
    if (node.local === 'oMath' || node.local === 'oMathPara') return false;
    if (WORD_NAMESPACES.has(node.uri) && SUBSTANTIAL.has(node.local)) return false;
  }
  return true;
}

function isPlainColor(node) {
  const value = (wordAttribute(node, 'val') ?? '').toLowerCase();
  const theme = wordAttribute(node, 'themeColor');
  if (theme) return theme === 'text1' || theme === 'dark1';
  if (value === 'auto' || value === '') return true;
  if (!/^[0-9a-f]{6}$/.test(value)) return false;
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(value.slice(at, at + 2), 16));
  // Black and the near-black greys that pasted text brings with it.
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24 && Math.max(r, g, b) <= 0x40;
}

function isPlainShading(node) {
  const value = wordAttribute(node, 'val') ?? 'clear';
  const fill = (wordAttribute(node, 'fill') ?? 'auto').toLowerCase();
  return (value === 'clear' || value === 'nil') && (fill === 'auto' || fill === 'ffffff');
}

function insertOrdered(parent, element, ranks) {
  const rank = ranks.get(element.local) ?? Infinity;
  const existing = parent.children.findIndex(child => isElement(child) && child.local === element.local && WORD_NAMESPACES.has(child.uri));
  if (existing >= 0) { parent.children.splice(existing, 1, element); return; }
  const at = parent.children.findIndex(child => isElement(child) && (ranks.get(child.local) ?? -1) > rank);
  if (at < 0) parent.children.push(element);
  else parent.children.splice(at, 0, element);
}

function setSectionType(sectPr, prefix, value) {
  const type = firstWord(sectPr, 'type');
  if (type) setWordAttribute(type, 'val', value);
  else insertOrdered(sectPr, wordElement(prefix, 'type', { val: value }), SECTION_RANK);
}

/** Where the source shows its page numbers, in words: "top right", "top right, none on a section's first page", or null. */
function sourcePageNumbers(bytes) {
  try {
    const { sections } = readAppearance(bytes);
    const words = position => (position ? position.replace('-', ' ').replace('center', 'centre') : null);
    const other = [...new Set(sections.map(section => words(section.pageNumber.other?.position)).filter(Boolean))];
    if (!other.length) return null;
    const hidden = sections.some(section => section.pageNumber.other && !section.pageNumber.first);
    return `${other.join(' or ')}${hidden ? ', none on the first page of some sections' : ''}`;
  } catch {
    return null;
  }
}

/** Removes a section's different first page and its first-page header and footer; true when it had one. */
function dropFirstPage(sectPr) {
  const had = sectPr.children.some(child => isWord(child, 'titlePg'));
  sectPr.children = sectPr.children.filter(child => !isWord(child, 'titlePg') && !((isWord(child, 'headerReference') || isWord(child, 'footerReference')) && wordAttribute(child, 'type') === 'first'));
  return had;
}

/** The line spacing (in 240ths) of the styles the sheet's spacing by element sets, by style key. */
function elementLines(spacing) {
  if (!spacing) return {};
  const line = value => (typeof value === 'number' ? String(Math.round(value * 240)) : null);
  const out = {};
  const set = (keys, value) => { if (line(value)) for (const key of keys) out[key] = line(value); };
  set(['note-text'], spacing.notes);
  set(['block-quotation', 'verse', 'epigraph', 'epigraph-source'], spacing.quotations);
  set(['bibliography-entry'], spacing.bibliography);
  set(['figure-caption'], spacing.captions);
  return out;
}

/** The prefix the document declares for the relationships namespace, declared as r when it has none. */
function relationshipPrefix(document) {
  const found = document.attributes.find(attribute => attribute.prefix === 'xmlns' && attribute.value === REL_NS);
  if (found) return found.local;
  document.attributes.push({ name: 'xmlns:r', prefix: 'xmlns', local: 'r', uri: 'http://www.w3.org/2000/xmlns/', value: REL_NS });
  return 'r';
}

function removeStartPageNumber(sectPr) {
  const numbers = firstWord(sectPr, 'pgNumType');
  if (numbers) numbers.attributes = numbers.attributes.filter(attribute => attribute.local !== 'start');
}

function restartNotes(sectPr, prefix) {
  let notes = firstWord(sectPr, 'footnotePr');
  if (!notes) {
    notes = wordElement(prefix, 'footnotePr');
    insertOrdered(sectPr, notes, SECTION_RANK);
  }
  insertOrdered(notes, wordElement(prefix, 'numRestart', { val: 'eachSect' }), new Map([['pos', 0], ['numFmt', 1], ['numStart', 2], ['numRestart', 3]]));
}

// Splits a run at a text offset into two runs with the same properties.
function splitRun(run, offset) {
  const properties = firstWord(run, 'rPr');
  const head = { ...run, children: properties ? [cloneNode(properties)] : [] };
  const tail = { ...run, children: properties ? [cloneNode(properties)] : [] };
  let seen = 0;
  for (const child of run.children) {
    if (child === properties) continue;
    const length = isElement(child) ? textOf({ type: 'element', children: [child] }).length : 0;
    if (seen + length <= offset) head.children.push(child);
    else if (seen >= offset) tail.children.push(child);
    else {
      // A w:t that holds the offset is cut in two.
      const text = child.children.map(node => node.text ?? '').join('');
      const cut = offset - seen;
      head.children.push({ ...child, attributes: withPreserve(child), children: [{ type: 'text', text: text.slice(0, cut) }] });
      tail.children.push({ ...child, attributes: withPreserve(child), children: [{ type: 'text', text: text.slice(cut) }] });
    }
    seen += length;
  }
  return [head, tail];
}

const withPreserve = node => (node.attributes.some(attribute => attribute.name === 'xml:space')
  ? node.attributes.map(attribute => ({ ...attribute }))
  : [...node.attributes.map(attribute => ({ ...attribute })), { name: 'xml:space', prefix: 'xml', local: 'space', uri: 'http://www.w3.org/XML/1998/namespace', value: 'preserve' }]);

// Removes the white space at the end of a run's last text; returns what it removed.
function trimTrailing(run) {
  const texts = run.children.filter(child => isWord(child, 't'));
  const last = texts[texts.length - 1];
  if (!last) return '';
  const text = last.children.map(node => node.text ?? '').join('');
  const kept = text.replace(/\s+$/u, '');
  last.children = [{ type: 'text', text: kept }];
  return text.slice(kept.length);
}

// Removes the first `count` characters of a paragraph's text (the separator of a split); returns
// what it removed.
function dropLeading(paragraph, count) {
  let left = count;
  let removed = '';
  for (const run of runsOf(paragraph)) {
    for (const child of run.children) {
      if (left <= 0) return removed;
      if (!isWord(child, 't')) continue;
      const text = child.children.map(node => node.text ?? '').join('');
      removed += text.slice(0, left);
      child.children = [{ type: 'text', text: text.slice(left) }];
      left -= Math.min(left, text.length);
    }
  }
  return removed;
}

/** The words a change to a paragraph's text removed and added. */
function wordChange(before, after) {
  const a = wordsOf(before);
  const b = wordsOf(after);
  const counts = new Map();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  const addedWords = [];
  for (const word of b) {
    if ((counts.get(word) ?? 0) > 0) counts.set(word, counts.get(word) - 1);
    else addedWords.push(word);
  }
  const removedWords = [...counts].flatMap(([word, count]) => Array(count).fill(word));
  return { removedWords, addedWords };
}
