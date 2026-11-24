// What the decide step may do with the text and with each finding, in code: the model proposes,
// these rules dispose. Text an author owns (a title, a heading, a person's name, an affiliation, an
// abstract, a keyword list, a contents line) is never changed except by the declared mechanical
// operations of mechanical.js; anything else that touches it becomes a question to the author. A
// finding of the checks leaves the author's list only when an applied operation resolves it, a
// stated default settles it, or it is a possible slip in running text, which goes to the
// copyeditor's list. Pure: no DOM, no network.

import { settlingDefault } from './defaults.js';

/** The roles whose words belong to the author: never changed by a free edit, never sent to the copyeditor. */
export const PROTECTED_ROLES = new Set(['title-block', 'title-page', 'abstract', 'keywords', 'contributor-note', 'contents-entry', 'part-title',
  'heading-1', 'heading-2', 'heading-3', 'front-matter-heading', 'bibliography-heading', 'bibliography-subheading', 'appendix-heading', 'copyright-page', 'approval-page', 'dedication', 'epigraph']);
// The roles of titles and names, whose role the decide step does not change either.
export const TITLE_ROLES = new Set(['title-block', 'title-page', 'part-title']);

/** The kinds of the reading check that are possible slips in the prose: the copyeditor's, unless the text is protected. */
export const COPYEDIT_KINDS = new Set(['typo', 'missing-spaces', 'stray-or-duplicated-text', 'wording-inconsistent']);

// Checks whose finding only reports a change the formatter made and declared; the summary says it.
const REPORT_CHECKS = new Set(['formatting-summary', 'title-split', 'heading-numbers-added']);
// Checks whose finding reports a change the formatter made that the author should look at once:
// one comment per chapter, not one per place.
export const FLAGGED_CHECKS = new Set(['quotation-lines-joined']);
// Checks whose findings in one chapter become one comment at the first place, with the count.
export const GROUPED_CHECKS = new Set(['a11y-colour', 'a11y-link-text', 'a11y-alt-text', 'a11y-image-text', 'a11y-heading-skip', 'a11y-table-header']);

/**
 * What happens to one finding before any model is asked:
 *   { choice: 'resolved', by }   an applied operation (by: its id) or the formatter's declared change
 *   { choice: 'default', by }    a stated default (by: its id)
 *   { choice: 'ask' }            a question for the author
 *   { choice: 'open', allowed }  the model chooses among `allowed` ('ask' is always one)
 * @param {object} finding a finding of the checks or the reading check
 * @param {{ roleOf: (index: number) => string | null, resolvedBy: (finding: object) => string | null }} context
 *   resolvedBy: the id of an applied operation that resolves the finding, or null
 */
export function firstDisposition(finding, { roleOf, resolvedBy }) {
  if (REPORT_CHECKS.has(finding.check)) return { choice: 'resolved', by: 'formatter' };
  const op = resolvedBy(finding);
  if (op) return { choice: 'resolved', by: op };
  const settled = settlingDefault(finding, roleOf);
  if (settled) return { choice: 'default', by: settled.id };
  if (finding.check === 'reading' && COPYEDIT_KINDS.has(finding.kind) && copyeditable(finding, roleOf)) return { choice: 'open', allowed: ['ask', 'copyedit'] };
  return { choice: 'ask' };
}

/** True when a reading finding sits in running text, and its other place too, so the copyeditor may take it. */
export function copyeditable(finding, roleOf) {
  const here = roleOf(finding.paragraphIndex);
  if (!here || PROTECTED_ROLES.has(here)) return false;
  const other = finding.other?.paragraph;
  return other === undefined || other === null || !PROTECTED_ROLES.has(roleOf(other));
}

/**
 * The model's choice for an open finding, checked: a choice outside `allowed` (or none) keeps the
 * question. Returns the disposition and whether the model's choice was refused.
 */
export function checkedChoice(open, proposed) {
  if (!proposed || typeof proposed.choice !== 'string') return { disposition: { choice: 'ask' }, refused: false };
  if (!open.allowed.includes(proposed.choice)) return { disposition: { choice: 'ask' }, refused: true };
  return { disposition: { choice: proposed.choice, ...(proposed.question ? { question: proposed.question } : {}) }, refused: false };
}

// ------------------------------------------------------------------------------------------
// The guard on edits the model proposes

const DASHES = /^[\s]*[—–\-_]{2,}/u;
const sameButCase = (a, b) => a !== b && a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * A text change the model proposes ({ paragraph, before, after }), judged before anything is made:
 *   { ok: true, kind }             one of the declared mechanical cases, verified here
 *   { ok: false, refusal, to }     refused; `refusal` names the guard, `to` says where the proposal goes:
 *                                  'question' (protected text: the author decides) or 'copyedit' (running text)
 * @param {{ text: string, role: string | null, caseRule: string | null, dashName: string | null }} place
 *   caseRule: the case a rule asks titles and headings to take; dashName: the name a dash at the
 *   start of this bibliography entry stands for (from the entry above), or null
 */
export function judgeReplace({ before, after }, { text, role, caseRule, dashName }) {
  if (typeof before !== 'string' || !before || typeof after !== 'string' || !text.includes(before)) return { ok: false, refusal: 'not-in-text', to: null };
  if (role === 'bibliography-entry' && DASHES.test(text) && text.trimStart().startsWith(before.trim()) && /^[—–\-_\s]+$/u.test(before) && dashName && after.trim() === dashName) return { ok: true, kind: 'dash' };
  if (caseRule === 'title' && (role === 'title-block' || /^heading-/u.test(role ?? '')) && sameButCase(before, after) && before === before.toLocaleUpperCase()) return { ok: true, kind: 'title-case' };
  if (role === 'title-block' && (/[:\n]/u.test(after) && !/[:\n]/u.test(before))) return { ok: false, refusal: 'divides-a-title', to: 'question' };
  if (role === 'title-block' || role === 'title-page' || role === 'part-title' || /heading/u.test(role ?? '')) return { ok: false, refusal: 'changes-a-title-or-name', to: 'question' };
  if (role === 'contributor-note') return { ok: false, refusal: 'changes-a-name-or-affiliation', to: 'question' };
  if (role === 'abstract' || role === 'keywords') return { ok: false, refusal: 'changes-an-abstract-or-keywords', to: 'question' };
  if (role === 'bibliography-entry') return { ok: false, refusal: 'changes-a-reference', to: 'question' };
  if (PROTECTED_ROLES.has(role)) return { ok: false, refusal: 'changes-protected-text', to: 'question' };
  return { ok: false, refusal: 'copyedits-the-text', to: 'copyedit' };
}

/** A role change the model proposes, judged: the title blocks and title pages keep their roles. */
export function judgeRole({ from, to }) {
  if (TITLE_ROLES.has(from) || TITLE_ROLES.has(to)) return { ok: false, refusal: 'changes-a-title-role' };
  return { ok: true };
}

/** What each refusal means, in plain words, for the "What we did" document. */
export const REFUSAL_WORDS = Object.freeze({
  'divides-a-title': 'would have divided a title (where to divide it is the author’s choice)',
  'changes-a-title-or-name': 'would have changed the words of a title, a heading or an author’s name',
  'changes-a-name-or-affiliation': 'would have changed a name or an affiliation in the notes on contributors',
  'changes-an-abstract-or-keywords': 'would have changed an abstract or a keyword list',
  'changes-a-reference': 'would have changed a bibliography entry beyond its repeated-author dash',
  'changes-protected-text': 'would have changed text the author owns',
  'copyedits-the-text': 'would have copyedited the running text (put on the copyeditor’s list instead)',
  'changes-a-title-role': 'would have changed what a title or title page line is',
  'deletes-text': 'would have deleted text that is neither an exact duplicate nor a stray character',
  'not-in-text': 'named words that are not in the paragraph',
});
