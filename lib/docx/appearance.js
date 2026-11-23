// What a reader sees of a Word document, without Word: each paragraph's effective formatting
// (font, size, line spacing, space before and after, indents, alignment), resolved through the
// document defaults, the style hierarchy, numbering and direct formatting; each section's page
// size, margins and page-number position; the note settings; and the text set in a font other
// than the body's. Used by the rendered comparison (scripts/render-eval.mjs) and its tests.
// Pure: no DOM, no network.

import { readPackage, relationshipsOf, relatedPart } from './write.js';
import { elements, firstWord, isElement, isWord, parseXml, wordAttribute, WORD_NAMESPACES } from './xml.js';

const MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const THEME_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// Fonts whose use carries meaning in any text: symbols and code. Text in them is not counted as
// escaping the body font.
export const EXCEPTION_FONT = /^(?:symbol|wingdings.*|webdings|zapf ?dingbats|mt extra|marlett|courier(?: new)?|consolas|menlo|monaco|lucida (?:console|sans typewriter)|source code pro|andale mono|.*\bmono\b.*)$/iu;

// Character classes Word sets in the East Asian and complex-script fonts.
const EAST_ASIAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿＀-￯]/u;
const COMPLEX = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Khmer}]/u;
// Characters a run with the East Asian hint takes from its East Asian font: punctuation both scripts share.
const SHARED = /[‐-‧‰-⁞¡-¿×÷]/u;

/** The class of a character for font selection: 'eastAsia', 'cs', 'ascii' or 'hAnsi'. */
export function fontSlot(character, hint = null) {
  if (EAST_ASIAN.test(character)) return 'eastAsia';
  if (COMPLEX.test(character)) return 'cs';
  if (character.codePointAt(0) < 0x80) return 'ascii';
  if (hint === 'eastAsia' && SHARED.test(character)) return 'eastAsia';
  return 'hAnsi';
}

// --------------------------------------------------------------------------------------------
// Properties

const twips = value => (value === undefined || value === null || value === '' ? undefined : Number.parseInt(value, 10));

/** Paragraph properties from a w:pPr as a flat object; only what is set. */
export function paragraphProperties(pPr) {
  const out = {};
  if (!pPr) return out;
  const spacing = firstWord(pPr, 'spacing');
  if (spacing) {
    for (const name of ['before', 'after', 'line']) {
      const value = twips(wordAttribute(spacing, name));
      if (Number.isFinite(value)) out[name] = value;
    }
    const rule = wordAttribute(spacing, 'lineRule');
    if (rule) out.lineRule = rule;
    else if (out.line !== undefined) out.lineRule = 'auto';
  }
  const ind = firstWord(pPr, 'ind');
  if (ind) {
    const left = twips(wordAttribute(ind, 'left') ?? wordAttribute(ind, 'start'));
    const right = twips(wordAttribute(ind, 'right') ?? wordAttribute(ind, 'end'));
    const firstLine = twips(wordAttribute(ind, 'firstLine'));
    const hanging = twips(wordAttribute(ind, 'hanging'));
    if (Number.isFinite(left)) out.left = left;
    if (Number.isFinite(right)) out.right = right;
    // The first line's indent: positive for an indent, negative for a hanging indent.
    if (Number.isFinite(hanging)) out.firstLine = -hanging;
    else if (Number.isFinite(firstLine)) out.firstLine = firstLine;
  }
  const jc = firstWord(pPr, 'jc');
  if (jc) out.jc = normalJc(wordAttribute(jc, 'val'));
  return out;
}

const normalJc = value => ({ start: 'left', end: 'right', distribute: 'both', lowKashida: 'both', mediumKashida: 'both', highKashida: 'both', thaiDistribute: 'both' }[value] ?? value);

const OFF = new Set(['0', 'false', 'off']);

/** Run properties from a w:rPr as a flat object; only what is set. Fonts keep their slots apart. */
export function runProperties(rPr) {
  const out = {};
  if (!rPr) return out;
  const fonts = firstWord(rPr, 'rFonts');
  if (fonts) {
    // A theme font and a named font in the same slot: the theme font wins (ECMA-376 17.3.2.26).
    for (const slot of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
      const theme = wordAttribute(fonts, `${slot}Theme`);
      const named = wordAttribute(fonts, slot);
      if (theme) out[`font.${slot}`] = { theme };
      else if (named) out[`font.${slot}`] = { name: named };
    }
    const hint = wordAttribute(fonts, 'hint');
    if (hint) out.hint = hint;
  }
  const size = firstWord(rPr, 'sz');
  if (size && Number.isFinite(Number(wordAttribute(size, 'val')))) out.size = Number(wordAttribute(size, 'val'));
  for (const toggle of ['b', 'i', 'caps', 'smallCaps', 'vanish']) {
    const element = firstWord(rPr, toggle);
    if (element) out[toggle] = !OFF.has((wordAttribute(element, 'val') ?? 'true').toLowerCase());
  }
  const style = firstWord(rPr, 'rStyle');
  if (style) out.rStyle = wordAttribute(style, 'val');
  return out;
}

const merge = (...layers) => Object.assign({}, ...layers);

// --------------------------------------------------------------------------------------------
// Styles, theme and numbering

/** The styles part read for resolution: defaults, styles by id with their chains, the default paragraph style. */
export function readStyles(stylesRoot, themeRoot = null) {
  const defaults = { pPr: {}, rPr: {} };
  const styles = new Map();
  let defaultParagraph = null;
  let defaultCharacter = null;
  if (stylesRoot) {
    const docDefaults = firstWord(stylesRoot, 'docDefaults');
    if (docDefaults) {
      defaults.rPr = runProperties(firstWord(firstWord(docDefaults, 'rPrDefault') ?? { children: [] }, 'rPr'));
      defaults.pPr = paragraphProperties(firstWord(firstWord(docDefaults, 'pPrDefault') ?? { children: [] }, 'pPr'));
    }
    for (const style of elements(stylesRoot, 'style')) {
      const id = wordAttribute(style, 'styleId');
      if (!id || styles.has(id)) continue;
      const type = wordAttribute(style, 'type') ?? 'paragraph';
      const name = firstWord(style, 'name');
      const basedOn = firstWord(style, 'basedOn');
      const pPr = firstWord(style, 'pPr');
      const numPr = pPr && firstWord(pPr, 'numPr');
      styles.set(id, {
        id,
        type,
        name: name ? wordAttribute(name, 'val') : id,
        basedOn: basedOn ? wordAttribute(basedOn, 'val') : null,
        pPr: paragraphProperties(pPr),
        rPr: runProperties(firstWord(style, 'rPr')),
        numPr: numPr ? numberingReference(numPr) : null,
      });
      const isDefault = ['1', 'true', 'on'].includes(wordAttribute(style, 'default') ?? '');
      if (isDefault && type === 'paragraph' && !defaultParagraph) defaultParagraph = id;
      if (isDefault && type === 'character' && !defaultCharacter) defaultCharacter = id;
    }
  }
  return { defaults, styles, defaultParagraph, defaultCharacter, theme: themeFonts(themeRoot) };
}

function themeFonts(root) {
  const fonts = { minor: {}, major: {} };
  if (!root) return fonts;
  const walk = (node, inside) => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.uri === DRAWING_NS && (child.local === 'minorFont' || child.local === 'majorFont')) { walk(child, child.local === 'minorFont' ? 'minor' : 'major'); continue; }
      if (inside && child.uri === DRAWING_NS && ['latin', 'ea', 'cs'].includes(child.local)) {
        const face = child.attributes.find(attribute => attribute.local === 'typeface')?.value;
        if (face) fonts[inside][child.local] = face;
        continue;
      }
      walk(child, inside);
    }
  };
  walk(root, null);
  return fonts;
}

/** The font a theme reference names: minorHAnsi -> the theme's minor Latin font. */
function themeFace(theme, reference) {
  const major = /^major/i.test(reference);
  const set = major ? theme.major : theme.minor;
  if (/EastAsia$/i.test(reference)) return set.ea || set.latin || null;
  if (/Bidi$/i.test(reference)) return set.cs || set.latin || null;
  return set.latin || null;
}

function numberingReference(numPr) {
  const ilvl = firstWord(numPr, 'ilvl');
  const numId = firstWord(numPr, 'numId');
  return { ilvl: ilvl ? Number(wordAttribute(ilvl, 'val')) : 0, numId: numId ? wordAttribute(numId, 'val') : null };
}

/** The paragraph properties each (numId, level) of the numbering part sets: Map "numId:ilvl" -> pPr. */
export function readNumbering(root) {
  const levels = new Map();
  if (!root) return levels;
  const abstracts = new Map();
  for (const abstract of elements(root, 'abstractNum')) {
    const byLevel = new Map();
    for (const level of elements(abstract, 'lvl')) byLevel.set(Number(wordAttribute(level, 'ilvl')), paragraphProperties(firstWord(level, 'pPr')));
    abstracts.set(wordAttribute(abstract, 'abstractNumId'), byLevel);
  }
  for (const num of elements(root, 'num')) {
    const abstractId = firstWord(num, 'abstractNumId');
    const byLevel = abstracts.get(abstractId ? wordAttribute(abstractId, 'val') : null);
    if (!byLevel) continue;
    for (const [level, pPr] of byLevel) levels.set(`${wordAttribute(num, 'numId')}:${level}`, pPr);
  }
  return levels;
}

/** The chain of a style, from the root of its basedOn line to itself. */
function chain(styles, id) {
  const out = [];
  const seen = new Set();
  let current = id ? styles.get(id) : null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current);
    current = current.basedOn ? styles.get(current.basedOn) : null;
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// Resolution

const PARAGRAPH_DEFAULTS = { before: 0, after: 0, line: 240, lineRule: 'auto', left: 0, right: 0, firstLine: 0, jc: 'left' };

/**
 * A resolver for one package: effective paragraph and run properties.
 * @param {{ styles: object, numbering: Map<string, object> }} context
 */
export function resolver({ styles: sheet, numbering = new Map() }) {
  const { defaults, styles, defaultParagraph, theme } = sheet;
  const fontName = value => (value?.theme ? themeFace(theme, value.theme) : value?.name ?? null);
  return {
    paragraph(pPr) {
      const direct = paragraphProperties(pPr);
      const styleId = (pPr && firstWord(pPr, 'pStyle') ? wordAttribute(firstWord(pPr, 'pStyle'), 'val') : null) ?? defaultParagraph;
      const styleChain = chain(styles, styleId);
      const styleNumPr = [...styleChain].reverse().find(style => style.numPr)?.numPr ?? null;
      const directNumPr = pPr && firstWord(pPr, 'numPr') ? numberingReference(firstWord(pPr, 'numPr')) : null;
      const numPr = directNumPr?.numId ? directNumPr : styleNumPr;
      const numbered = numPr && numPr.numId && numPr.numId !== '0' ? numbering.get(`${numPr.numId}:${numPr.ilvl ?? 0}`) ?? {} : {};
      const resolved = merge(PARAGRAPH_DEFAULTS, defaults.pPr, ...styleChain.map(style => style.pPr), numbered, direct);
      return { ...resolved, styleId, styleName: styles.get(styleId)?.name ?? styleId ?? '(none)', runBase: [defaults.rPr, ...styleChain.map(style => style.rPr)] };
    },
    /** The effective run properties of a run in a paragraph resolved by paragraph(). */
    run(paragraph, rPr) {
      const direct = runProperties(rPr);
      const characterChain = direct.rStyle ? chain(styles, direct.rStyle).map(style => style.rPr) : [];
      const resolved = merge(...paragraph.runBase, ...characterChain, direct);
      const font = slot => fontName(resolved[`font.${slot}`]);
      return {
        fonts: { ascii: font('ascii'), hAnsi: font('hAnsi'), eastAsia: font('eastAsia'), cs: font('cs') },
        hint: resolved.hint ?? null,
        size: resolved.size ?? 20,
        bold: resolved.b === true,
        italic: resolved.i === true,
        hidden: resolved.vanish === true,
      };
    },
  };
}

// The text of a run, with what each character is: deleted text and field codes are not seen.
function runText(run) {
  let text = '';
  for (const child of run.children) {
    if (!isElement(child) || !WORD_NAMESPACES.has(child.uri)) continue;
    if (child.local === 't') text += child.children.map(node => node.text ?? '').join('');
    else if (child.local === 'tab') text += '\t';
  }
  return text;
}

/** The runs a paragraph shows, at any depth, not inside deletions, field codes or a fallback. */
function* visibleRuns(node) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (child.uri === MARKUP_COMPATIBILITY && child.local === 'Fallback') continue;
    if (WORD_NAMESPACES.has(child.uri)) {
      if (child.local === 'del' || child.local === 'moveFrom' || child.local === 'pPr' || child.local === 'p' || child.local === 'tbl') continue;
      if (child.local === 'r') { yield child; continue; }
    }
    yield* visibleRuns(child);
  }
}

/**
 * The effective look of a paragraph: its resolved paragraph properties and, weighted by characters,
 * the font and size most of its text is set in; and the characters set in each font, by slot.
 */
export function paragraphLook(paragraph, resolve) {
  const pPr = firstWord(paragraph, 'pPr');
  const resolved = resolve.paragraph(pPr);
  const fonts = new Map();
  const sizes = new Map();
  const characters = [];
  let text = '';
  for (const run of visibleRuns(paragraph)) {
    const value = runText(run);
    if (!value) continue;
    const look = resolve.run(resolved, firstWord(run, 'rPr'));
    if (look.hidden) continue;
    text += value;
    for (const character of value) {
      if (/\s/u.test(character)) continue;
      const slot = fontSlot(character, look.hint);
      const font = look.fonts[slot] ?? look.fonts.ascii ?? '(default)';
      characters.push({ character, slot, font });
      if (slot === 'ascii' || slot === 'hAnsi') fonts.set(font, (fonts.get(font) ?? 0) + 1);
      sizes.set(look.size, (sizes.get(look.size) ?? 0) + 1);
    }
  }
  // An empty paragraph shows its mark: the mark's run properties give its height.
  if (!characters.length) {
    const markRPr = pPr ? firstWord(pPr, 'rPr') : null;
    const look = resolve.run(resolved, markRPr);
    fonts.set(look.fonts.ascii ?? '(default)', 0);
    sizes.set(look.size, 0);
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const { runBase, ...properties } = resolved;
  return { ...properties, font: top(fonts), size: top(sizes), text, characters };
}

// --------------------------------------------------------------------------------------------
// The whole document

const partRoot = (files, name) => (name && files.has(name) ? parseXml(files.get(name)).root : null);

/** Reads a package for its appearance: paragraphs (body, notes, headers and footers), sections, notes. */
export function readAppearance(bytes) {
  const { files, main } = readPackage(bytes);
  const document = parseXml(files.get(main)).root;
  const rels = relationshipsOf(files, main);
  const themePart = rels.find(rel => rel.type === THEME_TYPE && !rel.external)?.resolved;
  const sheet = readStyles(partRoot(files, relatedPart(files, main, 'styles')), partRoot(files, themePart));
  const numbering = readNumbering(partRoot(files, relatedPart(files, main, 'numbering')));
  const resolve = resolver({ styles: sheet, numbering });
  const body = firstWord(document, 'body');

  // The body's top-level paragraphs (and the paragraphs of its tables), with their section.
  const paragraphs = [];
  const sectionProperties = [];
  let section = 0;
  for (const child of body ? elements(body) : []) {
    if (isWord(child, 'sectPr')) { sectionProperties[section] = child; continue; }
    if (isWord(child, 'p')) {
      paragraphs.push({ part: 'body', section, ...paragraphLook(child, resolve) });
      const sectPr = firstWord(firstWord(child, 'pPr') ?? { children: [] }, 'sectPr');
      if (sectPr) { sectionProperties[section] = sectPr; section += 1; }
    } else if (isWord(child, 'tbl')) {
      for (const cell of descendantParagraphs(child)) paragraphs.push({ part: 'table', section, ...paragraphLook(cell, resolve) });
    }
  }
  const sections = readSections(sectionProperties, files, main, rels, resolve);

  // Notes.
  const notes = [];
  for (const type of ['footnotes', 'endnotes']) {
    const root = partRoot(files, relatedPart(files, main, type));
    if (!root) continue;
    for (const note of elements(root)) {
      const kind = wordAttribute(note, 'type');
      for (const paragraph of elements(note, 'p')) notes.push({ part: type, separator: Boolean(kind && kind !== 'normal'), id: wordAttribute(note, 'id'), ...paragraphLook(paragraph, resolve) });
    }
  }
  // Headers and footers, each once.
  const margins = [];
  for (const rel of rels) {
    if (!/\/(header|footer)$/.test(rel.type) || rel.external || !files.has(rel.resolved)) continue;
    const root = parseXml(files.get(rel.resolved)).root;
    for (const paragraph of descendantParagraphs(root)) margins.push({ part: rel.resolved, ...paragraphLook(paragraph, resolve) });
  }
  const normalStyle = sheet.styles.get(sheet.defaultParagraph);
  const normal = resolve.run(resolve.paragraph(null), null);
  return { paragraphs, sections, notes, margins, normalFont: normal.fonts.ascii, normalStyle: normalStyle?.name ?? null, files, main };
}

function* descendantParagraphs(node) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (isWord(child, 'p')) { yield child; continue; }
    yield* descendantParagraphs(child);
  }
}

const HEADER_TYPES = ['default', 'first', 'even'];

/**
 * Each section's page and its page number: size, margins, the note settings, and where the page
 * number stands on its first page and on the others ('bottom-center', 'top-right', or null when the
 * page shows none). Headers and footers a section does not name are those of the section before.
 */
export function readSections(list, files, main, rels, resolve) {
  const byId = new Map(rels.map(rel => [rel.id, rel]));
  let inherited = { header: {}, footer: {} };
  return list.map((sectPr, index) => {
    const own = { header: { ...inherited.header }, footer: { ...inherited.footer } };
    for (const kind of ['header', 'footer']) {
      for (const reference of elements(sectPr ?? { children: [] }, `${kind}Reference`)) {
        const type = wordAttribute(reference, 'type') ?? 'default';
        const id = reference.attributes.find(attribute => attribute.local === 'id' && attribute.uri.includes('relationships'))?.value;
        if (HEADER_TYPES.includes(type) && byId.has(id)) own[kind][type] = byId.get(id).resolved;
      }
    }
    inherited = own;
    const size = sectPr && firstWord(sectPr, 'pgSz');
    const margin = sectPr && firstWord(sectPr, 'pgMar');
    const notes = sectPr && firstWord(sectPr, 'footnotePr');
    const titlePage = Boolean(sectPr && firstWord(sectPr, 'titlePg') && !OFF.has((wordAttribute(firstWord(sectPr, 'titlePg'), 'val') ?? 'true').toLowerCase()));
    const type = sectPr && firstWord(sectPr, 'type') ? wordAttribute(firstWord(sectPr, 'type'), 'val') : 'nextPage';
    const pageNumber = which => {
      for (const kind of ['header', 'footer']) {
        const part = own[kind][which];
        const found = part && files.has(part) ? pageField(parseXml(files.get(part)).root, resolve) : null;
        if (found) return { position: `${kind === 'header' ? 'top' : 'bottom'}-${found.jc === 'both' ? 'left' : found.jc}`, font: found.font, size: found.size };
      }
      return null;
    };
    const restart = notes && firstWord(notes, 'numRestart') ? wordAttribute(firstWord(notes, 'numRestart'), 'val') : 'continuous';
    const number = attribute => (margin ? twips(wordAttribute(margin, attribute)) ?? null : null);
    return {
      index,
      type,
      width: size ? twips(wordAttribute(size, 'w')) : null,
      height: size ? twips(wordAttribute(size, 'h')) : null,
      margins: { top: number('top'), right: number('right'), bottom: number('bottom'), left: number('left'), header: number('header'), footer: number('footer') },
      titlePage,
      noteRestart: restart,
      pageNumber: { first: pageNumber(titlePage ? 'first' : 'default'), other: pageNumber('default') },
    };
  });
}

// A PAGE field in a header or footer part: the alignment and look of the paragraph that holds it.
function pageField(root, resolve) {
  for (const paragraph of descendantParagraphs(root)) {
    const codes = [...walkElements(paragraph)].filter(node => isWord(node, 'instrText') || isWord(node, 'fldSimple'));
    const isPage = codes.some(node => /^\s*PAGE\b/i.test(isWord(node, 'fldSimple') ? wordAttribute(node, 'instr') ?? '' : node.children.map(child => child.text ?? '').join('')));
    if (!isPage) continue;
    const look = paragraphLook(paragraph, resolve);
    // The number is set in the look of the field's runs (its result, else its code).
    const fieldRun = [...walkElements(paragraph)].find(node => isWord(node, 'r') && [...walkElements(node)].some(child => isWord(child, 'instrText'))) ?? [...walkElements(paragraph)].find(node => isWord(node, 'r'));
    const number = fieldRun ? resolve.run(resolve.paragraph(firstWord(paragraph, 'pPr')), firstWord(fieldRun, 'rPr')) : null;
    return { jc: look.jc === 'both' ? 'left' : look.jc, font: number?.fonts.ascii ?? look.font, size: number?.size ?? look.size };
  }
  return null;
}

function* walkElements(node) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    yield child;
    yield* walkElements(child);
  }
}

/**
 * The characters of some paragraphs set in a font other than `bodyFont`, by font: Latin text
 * only (East Asian and complex-script text takes the fonts made for it), not counting the
 * symbol and code fonts in EXCEPTION_FONT.
 * @returns {Map<string, number>}
 */
export function strayFonts(paragraphs, bodyFont) {
  const out = new Map();
  for (const paragraph of paragraphs) {
    for (const { slot, font, character } of paragraph.characters) {
      if (slot !== 'ascii' && slot !== 'hAnsi') continue;
      if (!/[\p{L}\p{N}]/u.test(character) && !/[“”‘’"'.,;:()[\]—–-]/u.test(character)) continue;
      if (font === bodyFont || EXCEPTION_FONT.test(font ?? '')) continue;
      out.set(font ?? '(default)', (out.get(font ?? '(default)') ?? 0) + 1);
    }
  }
  return out;
}
