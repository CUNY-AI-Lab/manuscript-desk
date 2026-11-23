// The formatting stage: from a manuscript's .docx bytes, its paragraph roles and a rule sheet, a new
// .docx in which structure is carried by named paragraph styles instead of direct formatting. Each
// paragraph with a role gets the style for its role and loses the direct paragraph formatting the
// style now carries; character formatting that carries meaning (italics, bold inside a sentence,
// superscripts, small capitals, fonts other than the body's) is kept, and so are runs, note
// references, links, images, tables and fields. Chapters become Word sections when notes restart
// in each chapter. Every change to the text is declared, with the words it removed and added, so
// that a check can prove nothing else changed. Pure: no DOM, no network.

import { readDocx } from '../docx/read.js';
import { PPR_ORDER } from '../docx/validate.js';
import { PackageError, addRelatedPart, readPackage, relatedPart, writePackage } from '../docx/write.js';
import { cloneNode, descendants, elements, firstWord, isElement, isWord, parseXml, serializeXml, setWordAttribute, wordAttribute, wordElement, wordPrefix, WORD_NAMESPACES } from '../docx/xml.js';
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

// Direct paragraph formatting that a style carries, removed from a styled paragraph.
const STYLE_CARRIES = new Set(['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl', 'pBdr', 'shd', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'jc', 'outlineLvl']);
const OFF = new Set(['0', 'false', 'off']);
const TOGGLES = new Set(['b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'vanish', 'webHidden', 'specVanish', 'rtl', 'cs', 'noProof', 'snapToGrid']);
// Roles whose style carries bold and italics: their direct bold or italics over the whole
// paragraph is removed, because it was the source's way of marking what the style now marks.
const STYLE_CARRIES_EMPHASIS = new Set(['chapter-label', 'chapter-title', 'chapter-subtitle', 'chapter-author', 'chapter-affiliation', 'heading-1', 'heading-2', 'bibliography-heading', 'bibliography-subheading']);
// Markup an empty paragraph may hold that must not be lost when it is removed: it moves to the next paragraph.
const CARRIED = new Set(['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permStart', 'permEnd', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']);
// Content that makes a paragraph worth keeping even with no text.
const SUBSTANTIAL = new Set(['drawing', 'pict', 'object', 'footnoteReference', 'endnoteReference', 'fldChar', 'fldSimple', 'instrText', 'commentReference', 'sym', 'ptab', 'txbxContent', 'ins', 'del', 'moveFrom', 'moveTo', 'sdt']);
const TRACKED = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'numberingChange']);
const SECTION_ORDER = ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];
const SECTION_RANK = new Map(SECTION_ORDER.map((name, rank) => [name, rank]));

/**
 * @param {{ bytes: Uint8Array | ArrayBuffer, roles: Record<number, string>, sheet?: object | null }} input
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

function format({ bytes, roles = {}, sheet = null }) {
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
  const job = new Job({ prefix, paragraphs: read.paragraphs, plan, settings, sheet });
  job.measureSource(children);
  const units = job.buildBody(children);
  job.placeSections(units, body);

  // Styles, numbering and notes.
  const stylesPart = relatedPart(files, main, 'styles') ?? addRelatedPart(files, main, 'styles', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`);
  const styles = parseXml(files.get(stylesPart)).root;
  const numbering = settings.headingNumbers && job.usedStyles.has('heading-1') ? job.addHeadingNumbering(files, main) : {};
  const notesParts = ['footnotes', 'endnotes'].map(type => relatedPart(files, main, type)).filter(part => part && files.has(part));
  const notes = notesParts.map(part => ({ part, root: parseXml(files.get(part)).root }));
  for (const { root } of notes) job.restyleNotes(root);
  const { ids, duplicates } = mergeStyles(styles, { used: job.usedStyles, bodyLine: job.bodyLine, normal: { font: job.font, halfPoints: job.halfPoints }, numbering });
  job.writeStyleIds(ids);
  if (duplicates) job.declare(DECLARED.duplicateStyle, { count: duplicates });

  files.set(stylesPart, encoder.encode(serializeXml(styles)));
  for (const { part, root } of notes) files.set(part, encoder.encode(serializeXml(root)));
  files.set(main, encoder.encode(serializeXml(document)));
  const report = job.report(units);
  return { ok: true, bytes: writePackage(files), report };
}

class Job {
  constructor({ prefix, paragraphs, plan, settings, sheet }) {
    Object.assign(this, { prefix, paragraphs, plan, settings, sheet });
    this.usedStyles = new Set();
    this.styled = new Map(); // pStyle element -> style key, to receive the style id once styles are merged
    this.declared = new Map();
    this.needsAuthor = { ...plan.needsAuthor };
    this.styleCounts = {};
    this.font = null;
    this.halfPoints = null;
    this.bodyLine = null;
    this.sections = 0;
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
    if (markProperties) this.cleanRunProperties(markProperties, emphasis);
    for (const run of runsOf(paragraph)) {
      const rPr = firstWord(run, 'rPr');
      if (!rPr) continue;
      this.cleanRunProperties(rPr, emphasis);
      if (!rPr.children.some(isElement)) run.children.splice(run.children.indexOf(rPr), 1);
    }
  }

  /** Removes what is no-op or carried by the style; keeps formatting that carries meaning. */
  cleanRunProperties(rPr, emphasis) {
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
          return child.attributes.some(attribute => attribute.local !== 'hint');
        }
        default: return true;
      }
    });
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
    // Declared at the first paragraph of the quotation, where the joined lines now are.
    this.declare(DECLARED.linesJoined, { at: this.plan.decisions.get(index).joinInto });
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
    if (decision.split) {
      const split = this.splitAt(node, decision.split, emphasis, index);
      if (split) return split;
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
    trimTrailing(head);
    dropLeading(second, resume - at);
    this.restyle(first, into[0], { emphasis });
    this.restyle(second, into[1], { emphasis });
    this.declare(kind, { ...wordChange(before, `${textOf(first)} ${textOf(second)}`), at: index });
    return [first, second];
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
      paragraph.children = paragraph.children.filter(child => !isWord(child, 'r') || [...descendants(child)].some(node => SUBSTANTIAL.has(node.local)));
      for (const run of runsOf(paragraph)) run.children = run.children.filter(child => !isWord(child, 't'));
      const at = paragraph.children.findIndex(child => isWord(child, 'pPr')) + 1;
      paragraph.children.splice(at, 0, this.textRun(markerText));
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
    const marker = this.el('p', {}, [this.el('pPr'), this.textRun(markerText)]);
    this.restyle(marker, 'figure-marker');
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
    const paragraph = this.el('p', {}, [this.el('pPr'), this.textRun(text)]);
    this.restyle(paragraph, 'figure-caption');
    this.declare(DECLARED.captionAdded, { addedWords: wordsOf(text), at: index });
    return paragraph;
  }

  prefixLabel(paragraph, label, index) {
    const text = `${this.settings.figureMarker.label} ${label} `;
    const at = paragraph.children.findIndex(child => isWord(child, 'pPr')) + 1;
    paragraph.children.splice(at, 0, this.textRun(text));
    this.declare(DECLARED.captionNumbered, { addedWords: wordsOf(text), at: index });
  }

  textRun(text) {
    return this.el('r', {}, [this.el('t', { 'xml:space': 'preserve' }, [{ type: 'text', text }])]);
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
    if (restart) {
      for (const chapter of chapters) {
        const position = unitAt(chapter.first - 1);
        if (position < 0 || breaks.has(position)) continue;
        const copy = cloneNode(closing(units[position].index));
        setSectionType(copy, this.prefix, 'nextPage');
        removeStartPageNumber(copy);
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
    units.forEach((unit, position) => {
      body.push(...unit.elements);
      const sectPr = breaks.get(position);
      if (!sectPr) return;
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
    if (restart) for (const sectPr of sections) restartNotes(sectPr, this.prefix);
    this.sections = sections.length;
    body.push(final);
    bodyElement.children = body;
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

  restyleNotes(root) {
    for (const note of elements(root)) {
      const type = wordAttribute(note, 'type');
      if (type && type !== 'normal') continue;
      for (const paragraph of elements(note, 'p')) this.restyle(paragraph, 'note-text');
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

// Removes the white space at the end of a run's last text.
function trimTrailing(run) {
  const texts = run.children.filter(child => isWord(child, 't'));
  const last = texts[texts.length - 1];
  if (last) last.children = [{ type: 'text', text: last.children.map(node => node.text ?? '').join('').replace(/\s+$/u, '') }];
}

// Removes the first `count` characters of a paragraph's text (the separator of a split).
function dropLeading(paragraph, count) {
  let left = count;
  for (const run of runsOf(paragraph)) {
    for (const child of run.children) {
      if (left <= 0) return;
      if (!isWord(child, 't')) continue;
      const text = child.children.map(node => node.text ?? '').join('');
      child.children = [{ type: 'text', text: text.slice(left) }];
      left -= Math.min(left, text.length);
    }
  }
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
