// Chapter titles from the file's own structure. A model reading a passage of a book or dissertation
// by one author often takes a chapter's title, standing alone in Word's Heading 1 style, for a
// section heading (docs/eval/dissertation-loop.md, round 2): with no chapter found, nothing that
// works by chapter can be done. This pass runs after the labelling, on a single-author long work
// only (a monograph, a dissertation or thesis), and uses what the file itself says about a
// paragraph rather than its words: its outline level and style, whether it starts a new page, the
// level of its entry in the contents list, a "Chapter 3" label. A paragraph the model called a
// heading becomes a chapter's title block when that evidence marks it as a top-level division of
// the work, and the headings of a chapter so found are levelled again under its title. The model's
// label decides wherever the evidence is silent: a paragraph it read as front or back matter, a
// title page, body text or anything else is left alone, and so is a file in which the model found
// chapters at another level. Pure: no DOM, no network.

import { isLabel } from '../format/titles.js';
import { frontMatterPart } from '../checks/parts.js';

// The document types written by one author from start to end, whose chapters have no author lines.
export const SINGLE_AUTHOR = new Set(['monograph', 'dissertation']);

const HEADINGS = new Set(['heading-1', 'heading-2']);
// Labels of paragraphs that head a division of the whole work, in the front or back matter or a chapter.
const DIVISIONS = new Set(['title-block', 'front-matter-heading', 'bibliography-heading', 'appendix-heading', 'part-title']);
const MATTER_HEADINGS = new Set(['front-matter-heading', 'bibliography-heading', 'appendix-heading']);
// Roles that end a chapter for the levelling below.
const ENDS_CHAPTER = new Set(['title-block', 'front-matter-heading', 'bibliography-heading', 'appendix-heading', 'part-title', 'title-page', 'contents-entry', 'contributor-note', 'copyright-page', 'approval-page', 'dedication']);
const BIBLIOGRAPHY = /^\s*(?:bibliography|select(?:ed)? bibliography|references|works cited|works consulted|sources|literature cited|bibliografia|bibliografía|bibliographie|literaturverzeichnis|riferimenti bibliografici)\s*$/iu;
const APPENDIX = /^\s*(?:appendi(?:x|ces)|annex|allegat)/iu;

const isEmpty = entry => entry?.hints?.empty === true || (entry?.text ?? '').trim() === '';
const evidenceOf = entry => entry?.structure ?? {};
const firstLine = text => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';

/**
 * The roles with the chapter titles the file's structure shows.
 * @param {Array<object>} paragraphs the reader's paragraph model (readDocx), with `structure`
 * @param {Record<number, string>} roles the model's roles by paragraph index
 * @param {{ docType?: string }} options
 * @returns {{ roles: Record<number, string>, changes: Array<{ index: number, from: string, to: string, evidence: string[] }> }}
 */
export function structureRoles(paragraphs, roles, { docType } = {}) {
  const out = { ...roles };
  const changes = [];
  if (!SINGLE_AUTHOR.has(docType) || !Array.isArray(paragraphs)) return { roles: out, changes };
  const roleOf = index => out[index] ?? null;
  const text = paragraphs.filter(entry => !isEmpty(entry) && roleOf(entry.index));
  const outlineOf = entry => evidenceOf(entry).outline ?? null;

  // The top outline level among the paragraphs labelled as headings or divisions, and the top
  // level of the contents list among those the model did not read as front or back matter.
  const headed = text.filter(entry => HEADINGS.has(roleOf(entry.index)) || DIVISIONS.has(roleOf(entry.index)));
  const levels = headed.map(outlineOf).filter(level => level !== null);
  if (!levels.length && !headed.some(entry => evidenceOf(entry).toc)) return { roles: out, changes };
  const top = levels.length ? Math.min(...levels) : null;
  const tocLevels = headed.filter(entry => !MATTER_HEADINGS.has(roleOf(entry.index))).map(entry => evidenceOf(entry).toc).filter(Boolean);
  const tocTop = tocLevels.length ? Math.min(...tocLevels) : null;
  // The top level divides the whole work when the model read front or back matter headings there.
  const matterAtTop = top !== null && headed.some(entry => MATTER_HEADINGS.has(roleOf(entry.index)) && outlineOf(entry) === top);

  // Chapters the model found itself, at the top level or elsewhere. When most of them, two or more,
  // stand at another level than the top one, the top headings are not the chapters (a book whose
  // chapter titles have a style of their own and whose sections use Heading 1), and the pass leaves
  // the file alone.
  const atTop = entry => (top !== null && outlineOf(entry) === top) || (tocTop !== null && evidenceOf(entry).toc === tocTop);
  const found = text.filter((entry, at) => roleOf(entry.index) === 'title-block' && roleOf(text[at - 1]?.index) !== 'title-block');
  const foundAtTop = found.filter(atTop);
  const foundElsewhere = found.length - foundAtTop.length;
  if (foundElsewhere >= 2 && foundElsewhere > foundAtTop.length) return { roles: out, changes };

  const evidenceFor = (entry, at) => {
    const { newPage, toc } = evidenceOf(entry);
    const reasons = [];
    if (top !== null && outlineOf(entry) === top) reasons.push('top outline level');
    if (matterAtTop && outlineOf(entry) === top) reasons.push('front or back matter at the same level');
    if (newPage) reasons.push('starts a new page');
    if (tocTop !== null && toc === tocTop) reasons.push('top level of the contents list');
    const previous = text[at - 1];
    if (isLabel(firstLine(entry.text)) || (previous && isLabel(previous.text) && previous.index >= entry.index - 3)) reasons.push('chapter label');
    return reasons;
  };

  const candidates = [];
  text.forEach((entry, at) => {
    if (!HEADINGS.has(roleOf(entry.index))) return;
    const evidence = evidenceFor(entry, at);
    // One sign is not enough: a section heading can start a page or carry the top outline level. Of
    // two, one marks a level (the outline, the contents list, a label) and one is not the outline
    // level again (a new page, the contents list, a label).
    const levelled = ['top outline level', 'top level of the contents list', 'chapter label'].some(reason => evidence.includes(reason));
    const beyondStyle = ['starts a new page', 'top level of the contents list', 'chapter label'].some(reason => evidence.includes(reason));
    if (evidence.length >= 2 && levelled && beyondStyle) candidates.push({ entry, at, evidence });
  });
  // A long work has more than one chapter; a single heading so marked is left to the model.
  if (candidates.length + foundAtTop.length < 2) return { roles: out, changes };

  const set = (index, to, evidence) => {
    const from = out[index];
    if (from === to) return;
    out[index] = to;
    changes.push({ index, from, to, evidence });
  };
  const promoted = [];
  for (const { entry, at, evidence } of candidates) {
    const words = firstLine(entry.text);
    // A top-level heading that names a part of the front or back matter heads that part.
    if (BIBLIOGRAPHY.test(words)) { set(entry.index, 'bibliography-heading', evidence); continue; }
    if (APPENDIX.test(words)) { set(entry.index, 'appendix-heading', evidence); continue; }
    if (frontMatterPart(words) && frontMatterPart(words) !== 'appendix') { set(entry.index, 'front-matter-heading', evidence); continue; }
    // A label line just before the title ("Chapter 3"), read as a heading, belongs to the title block.
    const previous = text[at - 1];
    if (previous && isLabel(previous.text) && HEADINGS.has(roleOf(previous.index)) && previous.index >= entry.index - 3) {
      set(previous.index, 'title-block', ['chapter label']);
      promoted.push(previous.index);
    }
    set(entry.index, 'title-block', evidence);
    promoted.push(entry.index);
  }

  // A run of title-block lines before the first chapter, right after the abstract's heading, is the
  // abstract page's own title, author and advisor lines (a dissertation repeats them there), not a chapter.
  const firstChapter = Math.min(...promoted, ...foundAtTop.map(entry => entry.index));
  let heading = null;
  for (const entry of text) {
    if (entry.index >= firstChapter) break;
    const role = roleOf(entry.index);
    if (role !== 'title-block') { heading = role === 'front-matter-heading' ? entry : null; continue; }
    if (heading && frontMatterPart(firstLine(heading.text)) === 'abstract') set(entry.index, 'abstract', ['under the abstract heading, before the first chapter']);
  }

  // The headings of each chapter at the top level are levelled again under its title, by the
  // evidence when every heading of the chapter has some (the contents list's level, else the
  // outline level). In a chapter whose title the pass found, the model read the title as a heading
  // and its headings one level down, so with no such evidence they move up when none is at the top.
  const promotedSet = new Set(promoted);
  const chapters = [];
  let chapter = null;
  let previousRole = null;
  for (const entry of text) {
    const role = roleOf(entry.index);
    // A title block's further lines continue it.
    if (role === 'title-block' && previousRole === 'title-block') continue;
    previousRole = role;
    if (ENDS_CHAPTER.has(role)) {
      const promotedHere = promotedSet.has(entry.index);
      chapter = role === 'title-block' && (promotedHere || atTop(entry)) ? { headings: [], promoted: promotedHere } : null;
      if (chapter) chapters.push(chapter);
    } else if (chapter && HEADINGS.has(role)) chapter.headings.push(entry);
  }
  for (const { headings, promoted: foundHere } of chapters) {
    if (!headings.length) continue;
    const keys = headings.map(entry => evidenceOf(entry).toc ?? (outlineOf(entry) !== null ? outlineOf(entry) + 1 : null));
    if (keys.every(key => key !== null)) {
      const first = Math.min(...keys);
      headings.forEach((entry, position) => set(entry.index, keys[position] === first ? 'heading-1' : 'heading-2', ['level under the chapter title']));
    } else if (foundHere && !headings.some(entry => roleOf(entry.index) === 'heading-1')) {
      for (const entry of headings) set(entry.index, 'heading-1', ['level under the chapter title']);
    }
  }
  return { roles: out, changes };
}
