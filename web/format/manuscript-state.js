// The Formatter page, steps 4 and 5: the manuscript and what each paragraph is. The decisions are
// here, as pure functions that load under Node: the manuscript's size, the labelling plan, what is
// kept in this browser (the roles keyed by a hash of the file, the scholar's corrections, never the
// file or its text) and how it is restored, and what the review shows. manuscript-step.js draws them.

import { buildPassages } from '../../lib/roles/passages.js';
import { MATTER, ROLE_IDS, STRUCTURAL, isRole } from '../../lib/roles/roles.js';

// Each role in plain words, as the review's menus show it.
export const ROLE_LABELS = Object.freeze({
  'title-block': 'Chapter title block (title, subtitle, author, affiliation)',
  epigraph: 'Epigraph',
  abstract: 'Abstract',
  keywords: 'Keywords',
  'heading-1': 'Section heading',
  'heading-2': 'Subsection heading',
  'bibliography-heading': 'Bibliography heading',
  'bibliography-entry': 'Bibliography entry',
  'block-quotation': 'Block quotation (prose)',
  verse: 'Verse',
  figure: 'Figure, marker or caption',
  'list-item': 'List item',
  table: 'Table',
  body: 'Body text',
  'title-page': 'Book title page (title, editors or authors)',
  'front-matter-heading': 'Heading of a front or back matter section (Contents, Abbreviations…)',
  'contents-entry': 'Line of the contents list',
  'contributor-note': 'Note on a contributor',
  'part-title': 'Part title',
});
export const MATTER_GROUP = 'Front or back matter';
export const roleLabel = role => ROLE_LABELS[role] ?? 'Not labelled';

export const EXCERPT_CHARS = 120;
export const SAVED_KEY = 'manuscript';
export const DAMAGING = 'A wrong label is the most damaging mistake this tool can make: a paragraph of running text marked as a heading or a quotation is restyled as one. Please look through this list before you format the manuscript.';

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;

/** A paragraph with nothing to label: no text and no image. */
export const isEmptyParagraph = entry => entry?.hints?.empty === true || ((entry?.text ?? '').trim() === '' && entry?.hints?.image !== true);

/** The SHA-256 of bytes or text, in hexadecimal. */
export async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The manuscript's size in words, in plain words: "78,623 words in 1,398 paragraphs". */
export function manuscriptSize(paragraphs) {
  const withText = paragraphs.filter(entry => !isEmptyParagraph(entry));
  const words = withText.reduce((sum, entry) => sum + (entry.text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0), 0);
  return { words, paragraphs: withText.length, text: `${plural(words, 'word', 'words')} in ${plural(withText.length, 'paragraph', 'paragraphs')}` };
}

/** What labelling will do, said before it starts: the number of model calls in the first pass. */
export function labellingPlan(paragraphs, { only } = {}) {
  const passages = buildPassages(paragraphs, only ? { only: new Set(only), overlap: 0, overlapShare: 0 } : {});
  const asked = new Set(passages.flatMap(passage => passage.asked)).size;
  return {
    calls: passages.length,
    text: `Labelling sends ${plural(asked, 'paragraph', 'paragraphs')} to the model in ${plural(passages.length, 'passage', 'passages')}, one model call each, and a few more if the model leaves some out. It uses your shared CUNY AI Lab allowance.`,
  };
}

/** A new, empty record of labels for one file. */
export const newLabels = ({ hash, name, paragraphs, model }) => ({ hash, name, paragraphs, model, roles: null, corrections: {}, failures: [], replies: {} });

// Roles by paragraph index, as untrusted input: integer keys from 0 to `count`, known roles only.
function cleanRoles(value, count) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [key, role] of Object.entries(value)) {
    if (!/^\d{1,7}$/.test(key) || Number(key) >= count || !isRole(role)) continue;
    out[Number(key)] = role;
  }
  return out;
}

/**
 * A model's reply to one labelling passage, reduced to the roles it gives, by index, so that only
 * roles and never any text of the reply is kept. Null when it holds none.
 */
export function rolesOfReply(content, count = Number.MAX_SAFE_INTEGER) {
  let data;
  try {
    const fenced = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/.exec(content);
    data = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return null;
  }
  const roles = isObject(data?.roles) ? cleanRoles(data.roles, count) : null;
  return roles && Object.keys(roles).length ? roles : null;
}

const isLabelFailure = (entry, count) => isObject(entry) && typeof entry.code === 'string' && entry.code.length > 0 && entry.code.length <= 100
  && Array.isArray(entry.unlabelled) && entry.unlabelled.every(index => Number.isInteger(index) && index >= 0 && index < count);

/** The record to keep in this browser: roles, corrections and failures by index; no text at all. */
export function savedLabels(labels) {
  if (!labels) return null;
  const { hash, name, paragraphs, model, roles, corrections, failures, replies } = labels;
  return { hash, name, paragraphs, model, roles, corrections, failures: failures.map(({ code, message, unlabelled }) => ({ code, ...(message ? { message } : {}), unlabelled })), replies };
}

/** The saved record, checked as untrusted; null when it is not a usable one. */
export function restoredLabels(saved) {
  if (!isObject(saved) || !HEX64.test(saved.hash ?? '') || !Number.isInteger(saved.paragraphs) || saved.paragraphs < 0) return null;
  const count = saved.paragraphs;
  const replies = {};
  if (isObject(saved.replies)) for (const [key, value] of Object.entries(saved.replies)) if (HEX64.test(key)) replies[key] = cleanRoles(value, count);
  return {
    hash: saved.hash,
    name: typeof saved.name === 'string' ? saved.name.slice(0, 255) : 'the manuscript',
    paragraphs: count,
    model: typeof saved.model === 'string' ? saved.model.slice(0, 200) : '',
    roles: isObject(saved.roles) ? cleanRoles(saved.roles, count) : null,
    corrections: cleanRoles(saved.corrections, count),
    failures: Array.isArray(saved.failures) ? saved.failures.filter(entry => isLabelFailure(entry, count)).map(({ code, message, unlabelled }) => ({
      code, ...(typeof message === 'string' && message ? { message: message.slice(0, 300) } : {}), unlabelled: [...new Set(unlabelled)],
    })) : [],
    replies,
  };
}

/**
 * What a chosen file means for the labels kept in this browser: 'same' (the same file: its labels
 * are used and nothing is labelled again), 'other' (labels kept for another file, which stay until
 * this one is labelled), or 'none'. With a sentence to show for 'same' and 'other'.
 */
export function matchFile(labels, file) {
  if (!labels) return { kind: 'none', message: null };
  if (labels.hash === file.hash && labels.paragraphs === file.paragraphs.length) {
    if (labels.roles) return { kind: 'same', message: `This is the file labelled before, ${labels.name}. Its labels and your corrections were kept in this browser, so it is not labelled again.` };
    const done = Object.keys(labels.replies ?? {}).length;
    return { kind: 'same', message: done ? `Labelling this file stopped before it finished. ${plural(done, 'passage', 'passages')} already labelled ${done === 1 ? 'is' : 'are'} kept in this browser and ${done === 1 ? 'is' : 'are'} not paid for again: choose Read the manuscript to finish.` : null };
  }
  return {
    kind: 'other',
    message: `The labels kept in this browser are for another file, ${labels.name}. This file is not the same one (its contents differ), so its paragraphs are labelled from the start when you choose Read the manuscript. Choose ${labels.name} instead to use the labels you have.`,
  };
}

/** The roles the formatter uses: the model's labels with the scholar's corrections over them. */
export function effectiveRoles(labels) {
  return { ...(labels?.roles ?? {}), ...(labels?.corrections ?? {}) };
}

/** A correction to one paragraph's role; choosing the model's own label again removes the correction. */
export function correctRole(labels, index, role) {
  if (!isRole(role)) return labels;
  const corrections = { ...labels.corrections };
  if (labels.roles?.[index] === role) delete corrections[index];
  else corrections[index] = role;
  return { ...labels, corrections };
}

/**
 * The labels after a labelling run. A first run sets the roles; a second try (only the paragraphs
 * left unlabelled) fills gaps and never replaces a label. The failures are those of the latest run.
 * The replies cache is no longer needed once a run has finished.
 */
export function afterLabelling(labels, result, { retry = false } = {}) {
  const roles = retry ? { ...result.roles, ...(labels.roles ?? {}) } : { ...result.roles };
  // Overlapping passages can name the same paragraph twice; each is listed once, under the first.
  const listed = new Set();
  const failures = [];
  for (const { code, message, unlabelled } of result.failures) {
    const list = unlabelled.filter(index => !(index in roles) && !listed.has(index));
    for (const index of list) listed.add(index);
    if (list.length) failures.push({ code, ...(message ? { message } : {}), unlabelled: list });
  }
  return { ...labels, roles, failures, replies: {} };
}

/** The paragraphs with text the model has not labelled and the scholar has not either. */
export function unlabelledParagraphs(paragraphs, labels) {
  const roles = effectiveRoles(labels);
  return paragraphs.filter(entry => !isEmptyParagraph(entry) && !(entry.index in roles)).map(entry => entry.index);
}

// Why paragraphs could not be labelled, in plain words.
export function labelFailureSentence({ code, message } = {}) {
  if (code === 'model_output_limit') return 'The model ran out of room on them, even in smaller passages. Choose another model and try again.';
  if (code === 'incomplete_reply') return 'The model\'s answer left them out.';
  if (typeof code === 'string' && code.includes('quota')) return 'Your model allowance is used up.';
  if (['request_timeout', 'upstream_timeout', 'network_error'].includes(code)) return 'The model service did not answer in time. Try again in a minute.';
  if (code === 'invalid_model_response') return 'The model\'s answer could not be used. Try again, or choose another model.';
  if (typeof message === 'string' && message.trim()) return message.trim();
  return 'They could not be labelled. Try again.';
}

/** One line per kind of failure: "12 paragraphs were not labelled: the model's answer left them out." */
export function labelFailureLines(failures) {
  const byReason = new Map();
  for (const failure of failures) {
    const reason = labelFailureSentence(failure);
    byReason.set(reason, (byReason.get(reason) ?? 0) + failure.unlabelled.length);
  }
  return [...byReason].map(([reason, count]) => `${plural(count, 'paragraph was', 'paragraphs were')} not labelled. ${reason}`);
}

/** The first 120 characters of a paragraph's text, on one line, with "…" when it goes on. */
export function excerpt(entry) {
  const text = (entry?.text ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return entry?.hints?.image ? '(an image, with no text)' : '(no text)';
  const characters = Array.from(text);
  return characters.length <= EXCERPT_CHARS ? text : `${characters.slice(0, EXCERPT_CHARS).join('').trimEnd()}…`;
}

/** The paragraphs with text just before and after one, with their roles: the neighbours on demand. */
export function neighbours(paragraphs, labels, index, around = 2) {
  const roles = effectiveRoles(labels);
  const list = paragraphs.filter(entry => !isEmptyParagraph(entry));
  const at = list.findIndex(entry => entry.index === index);
  if (at === -1) return [];
  return [...list.slice(Math.max(0, at - around), at).map(entry => ({ entry, side: 'before' })), ...list.slice(at + 1, at + 1 + around).map(entry => ({ entry, side: 'after' }))]
    .map(({ entry, side }) => ({ index: entry.index, side, excerpt: excerpt(entry), role: roleLabel(roles[entry.index]) }));
}

export const FILTERS = Object.freeze({ check: 'Paragraphs to check: everything but body text and bibliography entries', all: 'Every paragraph' });

/**
 * What the review shows. filter: 'check' (the default: paragraphs whose role is not body text or a
 * bibliography entry, those corrected, and those not labelled), 'all', or a role id. Paragraphs the
 * model could not label come first, in a group of their own; the rest are grouped by chapter, a
 * chapter starting at a title block.
 * @returns {{ counts: Array<{ role: string, label: string, count: number }>, unlabelled: Array<object>,
 *   chapters: Array<{ key: number, title: string, items: Array<object>, total: number }>, shown: number, total: number }}
 */
export function reviewModel(paragraphs, labels, filter = 'check') {
  const roles = effectiveRoles(labels);
  const corrections = labels?.corrections ?? {};
  const withText = paragraphs.filter(entry => !isEmptyParagraph(entry));
  const counts = new Map(ROLE_IDS.map(role => [role, 0]));
  const item = entry => ({ index: entry.index, excerpt: excerpt(entry), role: roles[entry.index] ?? null, modelRole: labels?.roles?.[entry.index] ?? null, corrected: entry.index in corrections });
  const wanted = entry => {
    const role = roles[entry.index];
    if (filter === 'all') return true;
    if (filter === 'check') return !role || STRUCTURAL.has(role) || entry.index in corrections;
    return role === filter;
  };
  const unlabelled = [];
  const chapters = [];
  let chapter = { key: -1, title: 'Before the first chapter', items: [], total: 0 };
  let previous = null;
  for (const entry of withText) {
    const role = roles[entry.index];
    if (role) counts.set(role, counts.get(role) + 1);
    if (role === 'title-block' && previous !== 'title-block') {
      if (chapter.total) chapters.push(chapter);
      chapter = { key: entry.index, title: excerpt(entry), items: [], total: 0 };
    } else if (MATTER.has(role) && chapter.key !== -1 && !chapter.matter) {
      // Front or back matter after a chapter (notes on contributors, say) is a group of its own.
      if (chapter.total) chapters.push(chapter);
      chapter = { key: entry.index, title: MATTER_GROUP, items: [], total: 0, matter: true };
    }
    previous = role ?? null;
    chapter.total += 1;
    if (!role) { unlabelled.push(item(entry)); continue; }
    if (wanted(entry)) chapter.items.push(item(entry));
  }
  if (chapter.total) chapters.push(chapter);
  const shown = unlabelled.length + chapters.reduce((sum, entry) => sum + entry.items.length, 0);
  return {
    counts: [...counts].filter(([, count]) => count > 0).map(([role, count]) => ({ role, label: ROLE_LABELS[role], count })),
    unlabelled,
    chapters: chapters.filter(entry => entry.items.length > 0).map(({ matter, ...entry }) => entry),
    shown,
    total: withText.length,
  };
}

/** The sentence above the review: how many paragraphs it shows, of how many. */
export function reviewHeadline(model, filter) {
  const what = filter === 'check' ? 'to check' : filter === 'all' ? 'in all' : `labelled ${roleLabel(filter).toLowerCase()}`;
  return `${plural(model.shown, 'paragraph', 'paragraphs')} ${what}, of ${plural(model.total, 'paragraph', 'paragraphs')} with text.`;
}
