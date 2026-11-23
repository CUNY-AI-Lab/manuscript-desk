// The formatting decisions, made on the reader's paragraph model and the paragraph roles before any
// XML is touched: where chapters begin and end, which style each paragraph gets, which empty
// paragraphs go, which titles are split, how figures are numbered. format.js applies them. Pure:
// no DOM, no network.

import { DECLARED } from './declared.js';
import { namesThenInstitution, titleParts } from './titles.js';
import { MATTER } from '../roles/roles.js';

// The settings the formatter reads from a rule sheet, with what applies when the sheet is silent.
export const DEFAULT_SETTINGS = Object.freeze({ notesRestart: false, headingNumbers: false, splitTitles: false, figureMarker: null, figuresPerChapter: true, chapterLabel: null, headingsCase: null, pageNumbers: null, margins: null });

const enabled = (sheet, slot) => (Array.isArray(sheet?.rules) ? sheet.rules.filter(rule => rule.slot === slot && rule.enabled !== false && rule.conflict !== true) : []);
const param = (sheet, slot, name) => enabled(sheet, slot).map(rule => rule.params?.[name]).find(value => value !== undefined && value !== null);

/** The formatter's settings from a (validated) rule sheet. Rules in conflict are not applied. */
export function settingsFrom(sheet) {
  const marker = param(sheet, 'figures.markers', 'example');
  const per = param(sheet, 'figures.numbering', 'per');
  return {
    notesRestart: param(sheet, 'notes.restart', 'per') === 'chapter',
    headingNumbers: param(sheet, 'headings.numbering', 'scheme') === 'decimal',
    splitTitles: param(sheet, 'chapters.subtitle', 'split') === true,
    figureMarker: typeof marker === 'string' ? markerForm(marker) : null,
    figuresPerChapter: per ? per === 'chapter' : typeof marker === 'string' ? /\d+\s*[.\-–]\s*\d+/.test(marker) || !/\d/.test(marker) : true,
    chapterLabel: param(sheet, 'chapters.label', 'example') ?? null,
    headingsCase: param(sheet, 'headings.case', 'case') ?? null,
    pageNumbers: param(sheet, 'layout.page-numbers', 'position') ?? null,
    margins: param(sheet, 'layout.margins', 'inches') ?? null,
  };
}

/** A chapter's label line in the form of the guidelines' example: "Chapter 3" -> "Chapter 7". */
export function labelText(example, number) {
  const trimmed = example.trim();
  return /\d+/u.test(trimmed) ? trimmed.replace(/\d+/u, String(number)) : `${trimmed} ${number}`;
}

/**
 * The form of a figure's placement marker and caption label, from the example the guidelines give:
 * "[insert Fig. 5.3 here]" -> { before: '[insert Fig. ', after: ' here]', label: 'Fig.', separator: '.' }.
 * The first number in the example is where the figure's number goes.
 */
export function markerForm(example) {
  const match = /(\d+)(?:\s*([.\-–])\s*(\d+))?/.exec(example);
  if (!match) return { before: `${example.trimEnd()} `, after: '', label: example.replace(/[[\]<>()]/g, '').trim().split(/\s+/).pop() || 'Figure', separator: '.' };
  const before = example.slice(0, match.index);
  const label = before.replace(/[[\]<>(){}]/g, ' ').trim().split(/\s+/).pop() || 'Figure';
  return { before, after: example.slice(match.index + match[0].length), label, separator: match[2] ?? '.' };
}

// Roles after which a body paragraph starts flush, without a first-line indent.
const FLUSH_AFTER = new Set(['title-block', 'heading-1', 'heading-2', 'bibliography-heading', 'block-quotation', 'verse', 'epigraph', 'abstract', 'keywords', 'figure', 'table', 'list-item', ...MATTER]);
const HEADING_ROLES = new Set(['heading-1', 'heading-2']);
// A heading that already carries its number as typed text: "2", "2.1", "II." followed by words.
export const TYPED_NUMBER = /^\s*(?:\d{1,3}(?:\.\d{1,3})*\.?|[IVXLC]{1,6}\.)\s+\S/u;
// Chapters that books leave unnumbered, so a chapter-based figure number skips them.
const UNNUMBERED = /^\s*(?:introduction|introduzione|introducción|introdução|einleitung|einführung|inleiding|wstęp|preface|prefazione|prefacio|préface|vorwort|foreword|prologue|prologo|prólogo|epilogue|epilogo|epílogo|afterword|postface|acknowledg(?:e)?ments?|ringraziamenti|agradecimientos)\b/iu;
const PLACEHOLDER = /^\s*[[<{(].{0,160}[\]>})]\s*$/u;

const isEmpty = entry => entry?.hints?.empty === true;
// An empty paragraph that only spaces the text: no image and no note reference (a paragraph that
// holds only a note reference reads as empty but must stay).
const isSpacer = entry => entry?.kind === 'paragraph' && isEmpty(entry) && !entry.hints.footnote && !entry.hints.image;

/**
 * @param {Array<object>} paragraphs the reader's paragraph model (readDocx), in order
 * @param {Record<number, string>} roles roles by paragraph index; paragraphs without one are left as they are
 * @param {object} settings from settingsFrom
 * @returns {{ chapters: Array<object>, decisions: Map<number, object>, removed: Set<number>, stanzaBreaks: Set<number>, needsAuthor: Record<string, number> }}
 */
export function planFormatting(paragraphs, roles, settings = DEFAULT_SETTINGS) {
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const decisions = new Map();
  const needsAuthor = {};
  const need = kind => { if (kind) needsAuthor[kind] = (needsAuthor[kind] ?? 0) + 1; };

  // Chapters: each begins at the first paragraph of a run of title-block paragraphs and ends at the
  // last paragraph with a role before the next one, or before the front or back matter (a title
  // page, a contents list, notes on contributors, a part title), which belongs to no chapter; what
  // follows a matter heading belongs to none either until the next title block.
  const roled = paragraphs.filter(entry => !isEmpty(entry) && roleOf(entry.index));
  const chapters = [];
  const chapterOf = new Map();
  let inBlock = false;
  let open = false;
  for (const entry of roled) {
    const role = roleOf(entry.index);
    if (role === 'title-block' && !inBlock) { chapters.push({ first: entry.index, last: entry.index, titleBlock: [] }); open = true; }
    inBlock = role === 'title-block';
    if (MATTER.has(role)) open = false;
    const chapter = chapters[chapters.length - 1];
    if (!chapter || !open) continue;
    chapter.last = entry.index;
    if (inBlock) chapter.titleBlock.push(entry.index);
    chapterOf.set(entry.index, chapters.length - 1);
  }

  // The title block: its parts, and a title split at a colon when the sheet asks for it. A
  // chapter's number is the one its label gives, or its place among the chapters that books
  // number (not an introduction or a preface).
  let numbered = 0;
  for (const chapter of chapters) {
    const block = chapter.titleBlock.map(index => byIndex.get(index));
    const parts = titleParts(block);
    chapter.parts = parts;
    chapter.titleBlock.forEach((index, position) => decisions.set(index, { style: `chapter-${parts[position]}` }));
    joinSubtitleLines(block, parts, decisions);
    const titleAt = parts.indexOf('title');
    const title = titleAt >= 0 ? block[titleAt].text : '';
    const label = parts.indexOf('label') >= 0 ? /\d{1,3}/.exec(block[parts.indexOf('label')].text) : null;
    chapter.unnumbered = !label && UNNUMBERED.test(title);
    if (!chapter.unnumbered) numbered += 1;
    chapter.number = label ? Number(label[0]) : chapter.unnumbered ? null : numbered;
    chapter.labelled = Boolean(label);
    if (settings.splitTitles && titleAt >= 0 && !parts.includes('subtitle')) {
      const index = chapter.titleBlock[titleAt];
      const colon = /:\s+/u.exec(title);
      if (colon && title.slice(0, colon.index).trim() && title.slice(colon.index + colon[0].length).trim()) {
        decisions.get(index).split = { at: colon.index, resume: colon.index + colon[0].length, into: ['chapter-title', 'chapter-subtitle'], kind: DECLARED.titleSplit, need: 'title to split by hand (its colon is inside a link or field)' };
      }
    }
    // With a chapter label asked for, a numbered chapter without one gets a label line before its title.
    if (settings.chapterLabel && !chapter.labelled && chapter.number) decisions.get(chapter.titleBlock[0]).labelBefore = labelText(settings.chapterLabel, chapter.number);
    // An author line that also names the institution, "Name (Institution)" or "Name, Institution",
    // is split into the author line and the affiliation.
    parts.forEach((part, position) => {
      if (part !== 'author' || parts[position + 1] === 'affiliation') return;
      const text = block[position].text;
      const split = affiliationSplit(text);
      if (split) decisions.get(chapter.titleBlock[position]).split = { ...split, into: ['chapter-author', 'chapter-affiliation'], kind: DECLARED.authorSplit, need: 'author line to split from its affiliation by hand' };
    });
  }

  // Typed heading numbers, chapter by chapter: when most of a chapter's headings carry one, Word
  // numbering is not added to that chapter.
  for (const chapter of chapters) {
    const headings = roled.filter(entry => entry.index >= chapter.first && entry.index <= chapter.last && HEADING_ROLES.has(roleOf(entry.index)));
    const typed = headings.filter(entry => TYPED_NUMBER.test(entry.text)).length;
    chapter.typedNumbers = headings.length > 0 && typed * 2 >= headings.length;
  }

  // A book's title page: each run of title-page paragraphs is read into its parts as a chapter's
  // title block is, and styled as the book's.
  const titlePages = [];
  for (const entry of roled) {
    if (roleOf(entry.index) !== 'title-page') continue;
    const last = titlePages[titlePages.length - 1];
    const previousRoled = roled[roled.indexOf(entry) - 1];
    if (last && previousRoled && roleOf(previousRoled.index) === 'title-page') last.push(entry);
    else titlePages.push([entry]);
  }
  for (const page of titlePages) {
    const parts = titleParts(page);
    page.forEach((entry, position) => decisions.set(entry.index, { style: `book-${parts[position]}` }));
    parts.forEach((part, position) => {
      if (part !== 'author' || parts[position + 1] === 'affiliation') return;
      const split = affiliationSplit(page[position].text);
      if (split) decisions.get(page[position].index).split = { ...split, into: ['book-author', 'book-affiliation'], kind: DECLARED.authorSplit, need: 'author line to split from its affiliation by hand' };
    });
    joinSubtitleLines(page, parts, decisions);
  }

  // Each paragraph with a role, in order.
  let previous = null; // the role of the previous paragraph with a role, in the same chapter
  let chapterNumber = -1;
  let bibliographyHeadings = 0;
  let figureInChapter = 0;
  let figureInWork = 0;
  let epigraphGroup = [];
  const closeEpigraphs = () => {
    // In a group of epigraph lines not parted by an empty paragraph, a short last line or one that
    // starts with a dash is the source line.
    if (epigraphGroup.length > 1) {
      const last = byIndex.get(epigraphGroup[epigraphGroup.length - 1]);
      if (Array.from(last.text.trim()).length <= 120 || /^\s*[—–-]/u.test(last.text)) decisions.get(last.index).style = 'epigraph-source';
    }
    epigraphGroup = [];
  };
  let figure = null; // the figure being read: { head, last, captioned }
  const closeFigure = () => {
    // A figure that is only an image gets a caption line after it; a placeholder marker gets one from format.js.
    if (figure && !figure.captioned && !figure.head.figure.placeholder) figure.last.appendCaption = figure.head.figure.label;
    figure = null;
  };
  for (let position = 0; position < paragraphs.length; position += 1) {
    const entry = paragraphs[position];
    if (isEmpty(entry)) {
      if (isSpacer(entry)) closeEpigraphs();
      continue;
    }
    const role = roleOf(entry.index);
    if (!role) { closeEpigraphs(); closeFigure(); continue; }
    const number = chapterOf.get(entry.index) ?? -1;
    if (number !== chapterNumber) {
      closeFigure();
      chapterNumber = number;
      previous = null;
      bibliographyHeadings = 0;
      figureInChapter = 0;
    }
    const chapter = chapters[number];
    if (role !== 'epigraph') closeEpigraphs();
    if (role !== 'figure') closeFigure();
    switch (role) {
      case 'title-block':
        if (!decisions.has(entry.index)) decisions.set(entry.index, { style: 'chapter-title' });
        break;
      case 'title-page':
        if (!decisions.has(entry.index)) decisions.set(entry.index, { style: 'book-title' });
        break;
      case 'epigraph':
        decisions.set(entry.index, { style: 'epigraph' });
        epigraphGroup.push(entry.index);
        break;
      case 'heading-1':
      case 'heading-2':
        decisions.set(entry.index, { style: role, typedNumber: chapter?.typedNumbers === true });
        break;
      case 'bibliography-heading':
        decisions.set(entry.index, { style: bibliographyHeadings === 0 ? 'bibliography-heading' : 'bibliography-subheading' });
        bibliographyHeadings += 1;
        break;
      case 'table':
        decisions.set(entry.index, { style: 'table-text' });
        break;
      case 'figure': {
        const decision = { style: entry.hints.image ? 'figure' : 'figure-caption' };
        decisions.set(entry.index, decision);
        if (!settings.figureMarker) break;
        if (!figure) {
          // The first paragraph of a figure: it gets the marker, and the figure its number.
          figureInChapter += 1;
          figureInWork += 1;
          // A chapter number worked out from the chapter's place, not read from a label, is a guess
          // the author confirms (whether an introduction counts, say).
          if (settings.figuresPerChapter && figureInChapter === 1) need(chapter?.number && chapter.labelled ? null : 'chapter number for figure numbers to confirm (no chapter label)');
          const label = settings.figuresPerChapter && chapter?.number ? `${chapter.number}${settings.figureMarker.separator}${figureInChapter}` : String(figureInWork);
          decision.figure = { label, placeholder: PLACEHOLDER.test(entry.text) && !entry.hints.image, captionAt: null };
          figure = { head: decision, last: decision, captioned: decision.style === 'figure-caption' && !decision.figure.placeholder };
        } else {
          // A later paragraph of the same figure: the first one with text is its caption.
          figure.last = decision;
          if (!figure.captioned && !entry.hints.image) {
            decision.captionLabel = figure.head.figure.label;
            figure.head.figure.captionAt = entry.index;
            figure.captioned = true;
          }
        }
        break;
      }
      case 'body':
        decisions.set(entry.index, { style: previous === null || FLUSH_AFTER.has(previous) ? 'body-first' : 'body' });
        break;
      default:
        decisions.set(entry.index, { style: role });
    }
    previous = role;
  }
  closeEpigraphs();
  closeFigure();

  // Empty paragraphs from the first chapter's start to the last chapter's end are removed, except
  // a stanza break: one empty paragraph between two lines of verse is kept as a verse line.
  const removed = new Set();
  const stanzaBreaks = new Set();
  if (chapters.length || roled.some(entry => MATTER.has(roleOf(entry.index)))) {
    // From the last paragraph before the first chapter, so the spacers that push the first
    // title down a page go too, or from the first paragraph of the front matter when it has a
    // role; to the end of the last chapter or of the back matter.
    const before = chapters.length ? paragraphs.filter(entry => entry.index < chapters[0].first && !isEmpty(entry)).pop() : null;
    const matter = roled.filter(entry => MATTER.has(roleOf(entry.index)));
    const from = Math.min(chapters.length ? (before ? before.index + 1 : chapters[0].first) : Infinity, matter.length ? matter[0].index : Infinity);
    const to = Math.max(chapters.length ? chapters[chapters.length - 1].last : -1, matter.length ? matter[matter.length - 1].index : -1);
    let lastRole = null;
    let pending = [];
    for (const entry of paragraphs) {
      if (entry.index < from || entry.index > to) continue;
      if (isSpacer(entry)) { pending.push(entry.index); continue; }
      if (isEmpty(entry)) continue; // a bookmark or other markup between paragraphs, or a note-only paragraph
      const role = roleOf(entry.index);
      if (pending.length) {
        const keep = lastRole === 'verse' && role === 'verse' ? pending[0] : null;
        for (const index of pending) (index === keep ? stanzaBreaks : removed).add(index);
        pending = [];
      }
      lastRole = role;
    }
    for (const index of pending) removed.add(index);
  }
  joinPastedLines(paragraphs, roleOf, decisions);
  return { chapters, decisions, removed, stanzaBreaks, needsAuthor };
}

/** Where an author line that names its institution splits, or null: { at, resume } offsets. */
export const affiliationSplit = namesThenInstitution;

/**
 * A subtitle broken over two lines: a subtitle line that does not end a sentence or clause is
 * joined by the subtitle line after it (marked with `joinInto` and `subtitle`).
 */
function joinSubtitleLines(block, parts, decisions) {
  let root = null;
  parts.forEach((part, position) => {
    if (part !== 'subtitle') { root = null; return; }
    const entry = block[position];
    const previous = block[position - 1];
    if (root && parts[position - 1] === 'subtitle' && entry.index === previous.index + 1 && !/[.?!:;…]["'”’»)\]]*\s*$/u.test(previous.text)) {
      decisions.get(entry.index).joinInto = root;
      decisions.get(entry.index).subtitle = true;
      return;
    }
    root = entry.index;
  });
}

// A sentence ends with . ? ! or …, perhaps followed by closing quotation marks or brackets.
const ENDS_SENTENCE = /[.?!…]["'”’»)\]]*$/u;
const STARTS_LOWER = /^["'“‘«(\[]*\p{Ll}/u;

/**
 * A prose quotation pasted with a break at the end of every printed line of its source arrives as
 * a run of block-quotation paragraphs, each one line long. Such lines are joined back into
 * paragraphs: a line joins the next when it stops in the middle of a sentence and the next goes on
 * in lower case, or, in a run of lines of about one printed line each, when it is as long as a full
 * line (so it ended at the margin, not at the end of a paragraph). Lines parted by an empty
 * paragraph are not joined. Marks decisions with `joinInto` (the first paragraph of the group).
 */
export function joinPastedLines(paragraphs, roleOf, decisions) {
  const runs = [];
  let current = [];
  for (const entry of paragraphs) {
    if (!isEmpty(entry) && roleOf(entry.index) === 'block-quotation' && entry.kind === 'paragraph' && !entry.hints.image) { current.push(entry); continue; }
    if (current.length) runs.push(current);
    current = [];
  }
  if (current.length) runs.push(current);
  for (const run of runs) {
    if (run.length < 2) continue;
    const lengths = run.map(entry => Array.from(entry.text.trim()).length);
    const sorted = [...lengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const midSentence = run.slice(0, -1).filter(entry => !ENDS_SENTENCE.test(entry.text.trim())).length;
    // A run of lines of about one printed line each, most of them stopping mid-sentence.
    const lineByLine = run.length >= 3 && median >= 30 && median <= 110 && midSentence >= 0.4 * (run.length - 1);
    const full = 0.95 * sorted[Math.floor(sorted.length * 0.75)];
    let root = run[0];
    for (let position = 0; position + 1 < run.length; position += 1) {
      const line = run[position];
      const next = run[position + 1];
      const text = line.text.trim();
      const length = lengths[position];
      const join = next.index === line.index + 1 && (ENDS_SENTENCE.test(text)
        ? lineByLine && length >= full
        : STARTS_LOWER.test(next.text.trim()) || (lineByLine && length >= full));
      if (join) decisions.get(next.index).joinInto = root.index;
      else root = next;
    }
  }
}
