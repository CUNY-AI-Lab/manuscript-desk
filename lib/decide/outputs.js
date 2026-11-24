// What the decide step hands the author: the comments in the formatted file (one summary at the
// top, then only the real questions, a flag where a change made needs one look, and at most one
// line per chapter pointing to the copyeditor's list), the "Queries for the copyeditor" document,
// the "What we did" document (operations, defaults, what was not done and why, every rule's end)
// and a checklist of the decisions and the things to hand in. Plain words for non-technical
// readers. Pure: no DOM, no network.

import { buildDocx } from '../docx/build.js';
import { changeLines } from '../checks/summary.js';
import { DECLARED } from '../format/declared.js';
import { categoryLabel, chapterName, kindLabel, ruleById } from '../todos/shared.js';
import { SETTLING_DEFAULTS } from './defaults.js';
import { GROUPED_CHECKS, REFUSAL_WORDS } from './policy.js';
import { DELIVERABLES } from './tools.js';

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const cut = (text, n) => { const one = String(text ?? '').replace(/\s+/gu, ' ').trim(); return one.length > n ? `${one.slice(0, n)}…` : one; };
const READING_PREFIX = /^Query from a model's reading of the text, for you to check: /u;
export const COPYEDIT_NAME = 'Queries for the copyeditor';
export const DID_NAME = 'What we did';

const OP_WORDS = {
  contents: 'Replaced the typed contents list with one Word builds from the chapter titles',
  dash: 'Wrote out repeated authors in the bibliographies where a dash stood for them',
  'title-case': 'Retyped titles and headings typed in capitals in title case',
  duplicate: 'Removed one copy of a passage typed twice in a row',
  stray: 'Removed stray characters standing on a line of their own',
};

// The kinds of change the decide step's operations declare: said once, as operations, not again among the formatter's.
const DECIDE_KINDS = new Set([DECLARED.contentsReplaced, DECLARED.contentsInserted, DECLARED.authorDash, DECLARED.titleCase, DECLARED.duplicateRemoved, DECLARED.strayRemoved, DECLARED.illustrationsList]);
/** The formatter's own changes, one line each, without the decide step's operations. */
export const formatterLines = report => changeLines({ ...report, declared: (report.declared ?? []).filter(entry => !DECIDE_KINDS.has(entry.kind)) });

const chapterIndex = (chapters, index) => (Number.isInteger(index) ? chapters.findIndex(chapter => index >= chapter.first && index <= chapter.last) : -1);
const placeName = (chapters, paragraphs, index) => { const at = chapterIndex(chapters, index); return at >= 0 ? chapterName(chapters[at], paragraphs) : 'Front and back matter'; };

/** The plain text of a finding for the author, with what the decide step adds to it. */
function questionText(finding, { sheet, contentsReplaced }) {
  let text = finding.message;
  if (finding.check === 'contents-against-chapters' && contentsReplaced) text += ' We replaced the typed contents list with one Word builds from the chapter titles, so the contents will show this title as its title page gives it: check that this wording is the right one.';
  if (finding.check === 'note-on-title') text += ' Proposed: move what the note says into a short “Note on the text” at the end of the chapter, then delete the note here. We did not move it.';
  if (finding.disposition?.question) text = `${finding.disposition.question}\n\n${text}`;
  const rule = finding.ruleId ? ruleById(sheet, finding.ruleId) : null;
  return rule?.source?.kind === 'guidelines' ? `${text}\nThe guidelines: “${rule.source.quote}”` : text;
}

/**
 * The comments for the formatted file, merged by place: { sourceIndex, text } as addComments takes them.
 * @returns {{ comments: Array<{ sourceIndex: number | null, text: string }>, questions: number, places: number }}
 */
export function decideComments({ summary, asked, flagged, copyedit, extraQuestions, applied, chapters, paragraphs, sheet }) {
  const byPlace = new Map();
  const add = (index, text) => { const key = Number.isInteger(index) ? index : null; byPlace.set(key, [...(byPlace.get(key) ?? []), text]); };
  const contentsReplaced = applied.some(op => op.kind === 'contents');
  // Questions; a grouped check gives one comment a chapter, at its first place.
  const groups = new Map();
  for (const finding of asked) {
    if (GROUPED_CHECKS.has(finding.check)) {
      const key = `${finding.check}\u0000${chapterIndex(chapters, finding.paragraphIndex)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(finding);
      continue;
    }
    add(finding.paragraphIndex, questionText(finding, { sheet, contentsReplaced }));
  }
  for (const list of groups.values()) add(list[0].paragraphIndex, `${questionText(list[0], { sheet, contentsReplaced })}${list.length > 1 ? `\n\nThe same in ${plural(list.length - 1, 'more place', 'more places')} in this part of the manuscript.` : ''}`);
  for (const proposal of extraQuestions) {
    add(proposal.paragraphIndex, proposal.deleteTo !== undefined
      ? `A model proposed deleting this paragraph${proposal.deleteTo > proposal.paragraphIndex ? ' and the next ones' : ''}${proposal.reason ? ` (${cut(proposal.reason, 200)})` : ''}. We did not: only you can decide it.`
      : `A model proposed changing “${cut(proposal.before, 200)}” to “${cut(proposal.after, 200)}”${proposal.reason ? ` (${cut(proposal.reason, 200)})` : ''}. We did not make the change: these are words only you can decide on.`);
  }
  const questionPlaces = new Set(byPlace.keys());
  // Flags: what a change made needs one look at.
  const flaggedChapters = new Set();
  for (const finding of flagged) {
    const at = chapterIndex(chapters, finding.paragraphIndex);
    if (flaggedChapters.has(`${finding.check}\u0000${at}`)) continue;
    flaggedChapters.add(`${finding.check}\u0000${at}`);
    add(finding.paragraphIndex, finding.message);
  }
  for (const op of applied) {
    if (op.kind === 'contents') add(op.flag, 'We deleted the typed contents list and put in its place a contents list Word builds from the chapter titles (a tracked change). To add the page numbers, right-click the list in Word and choose Update Field; Word may also offer to update it when the file opens.');
    if (op.kind === 'duplicate') add(op.flag, 'This passage was typed twice in a row. We removed the other copy, as a tracked deletion: check that the copy kept is the one you want.');
  }
  // One pointer per chapter with copyedit queries, in a comment already there if the chapter has one.
  const counts = new Map();
  for (const finding of copyedit) { const at = chapterIndex(chapters, finding.paragraphIndex); counts.set(at, (counts.get(at) ?? 0) + 1); }
  for (const [at, count] of counts) {
    const line = `${plural(count, 'possible slip', 'possible slips')} in the text of this ${at >= 0 ? 'chapter' : 'part'} (typing, spacing, wording) ${count === 1 ? 'is' : 'are'} on the list “${COPYEDIT_NAME}”, not marked here.`;
    const first = at >= 0 ? chapters[at].first : null;
    const inside = [...byPlace.keys()].filter(key => key !== null && chapterIndex(chapters, key) === at).sort((a, b) => a - b)[0];
    if (inside !== undefined) byPlace.get(inside).push(line);
    else add(at >= 0 ? first : copyedit.find(finding => chapterIndex(chapters, finding.paragraphIndex) === at)?.paragraphIndex ?? null, line);
  }
  const comments = [{ sourceIndex: null, text: summary }, ...[...byPlace].sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1)).map(([sourceIndex, texts]) => ({ sourceIndex, text: texts.join('\n\n') }))];
  // The summary goes first; a comment at no place joins it.
  const merged = comments.filter(comment => comment.sourceIndex !== null);
  const top = comments.filter(comment => comment.sourceIndex === null).map(comment => comment.text).join('\n\n');
  return { comments: [{ sourceIndex: null, text: top }, ...merged], questions: asked.length + extraQuestions.length, places: questionPlaces.size };
}

/** The summary comment at the top of the file, in plain words. */
export function summaryComment({ applied, report, defaults, settled, decisions, copyedit, refusals }) {
  const lines = ['What we did. CAIL Manuscript Desk formatted this file to the guidelines and did the work they settle; every change to the words is a tracked change you can accept or reject.'];
  const done = applied.map(op => op.words);
  if (done.length) lines.push(`Done: ${done.join('; ')}.`);
  const layout = formatterLines(report).slice(0, 8);
  if (layout.length) lines.push(`Also: ${layout.join('; ')}.`);
  const used = [...defaults.map(entry => entry.words), ...SETTLING_DEFAULTS.filter(entry => settled.some(finding => finding.disposition?.by === entry.id)).map(entry => entry.words)];
  if (used.length) lines.push(`Defaults we applied because the guidelines do not say: ${used.join('; ')}.`);
  lines.push(decisions ? `You need to decide ${plural(decisions, 'thing', 'things')}: each has a comment of its own in the file, and the checklist lists what to hand in.` : 'Nothing in the text needs a decision from you; the checklist lists what to hand in.');
  if (copyedit) lines.push(`${plural(copyedit, 'possible slip', 'possible slips')} in the running text (typing, spacing, wording) ${copyedit === 1 ? 'is' : 'are'} in a separate document, “${COPYEDIT_NAME}”, for whoever copyedits the book; they are not marked here.`);
  if (refusals) lines.push(`${plural(refusals, 'change', 'changes')} a model proposed ${refusals === 1 ? 'was' : 'were'} not made, because ${refusals === 1 ? 'it' : 'they'} would have touched words only you can decide on, or copyedited the text: see “${DID_NAME}”.`);
  return lines.join('\n\n');
}

/** "Queries for the copyeditor": the possible slips, by chapter, and the rules that concern the prose. */
export function copyeditDocument({ copyedit, extraCopyedit, rules, chapters, paragraphs }) {
  const blocks = [
    { type: 'heading', level: 1, text: COPYEDIT_NAME },
    { type: 'paragraph', text: 'Possible slips in the running text that a model’s reading of the manuscript noticed: typing slips, missing spaces, stray characters, a word given two ways. Each quotes the words where it is; whether it is a slip is for the copyeditor to judge. None of them was changed or marked in the manuscript.' },
  ];
  if (rules.length) {
    blocks.push({ type: 'heading', level: 2, text: 'What the guidelines ask of the prose' });
    for (const rule of rules) blocks.push({ type: 'item', text: rule.statement });
  }
  const items = [
    ...copyedit.map(finding => ({ index: finding.paragraphIndex, kind: kindLabel(finding.kind), text: finding.message.replace(READING_PREFIX, '') })),
    ...extraCopyedit.map(proposal => ({ index: proposal.paragraphIndex, kind: 'A change a model proposed', text: proposal.deleteTo !== undefined ? `Delete this paragraph${proposal.reason ? ` (${proposal.reason})` : ''}? Paragraph: “${cut(paragraphs.find(entry => entry.index === proposal.paragraphIndex)?.text, 200)}”` : `“${cut(proposal.before, 200)}” → “${cut(proposal.after, 200)}”${proposal.reason ? ` (${proposal.reason})` : ''}` })),
  ].sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  if (!items.length) blocks.push({ type: 'paragraph', text: 'Nothing: no possible slip was noticed.' });
  let current = null;
  for (const item of items) {
    const where = placeName(chapters, paragraphs, item.index);
    if (where !== current) { blocks.push({ type: 'heading', level: 2, text: where }); current = where; }
    blocks.push({ type: 'paragraph', runs: [{ text: `${item.kind}: `, bold: true }, { text: item.text }] });
  }
  return { name: COPYEDIT_NAME, bytes: buildDocx(blocks), count: items.length };
}

const END_WORDS = { done: 'Done by the tool', default: 'Settled by a default', 'not-applicable': 'Not for this manuscript', copyedit: 'For the copyeditor', deliver: 'For you to hand in', decision: 'For you to decide' };

/** "What we did": the operations, the defaults, what was not done and why, and every rule's end. */
export function whatWeDidDocument({ applied, report, defaults, settled, cleared, sheet, roleChanges, refusals, asked, copyeditCount, triage, chapters, paragraphs }) {
  const blocks = [{ type: 'heading', level: 1, text: DID_NAME }, { type: 'paragraph', text: 'What CAIL Manuscript Desk did to the manuscript, what it left for you, and why. Every change to the words is a tracked change in the formatted file, which you can accept or reject in Word.' }];
  blocks.push({ type: 'heading', level: 2, text: 'We made these changes' });
  const byKind = new Map();
  for (const op of applied) byKind.set(op.kind, [...(byKind.get(op.kind) ?? []), op]);
  for (const [kind, ops] of byKind) blocks.push({ type: 'item', text: `${OP_WORDS[kind] ?? kind}: ${ops.reduce((sum, op) => sum + (op.count ?? 1), 0)}` });
  for (const line of formatterLines(report)) blocks.push({ type: 'item', text: line });
  if (roleChanges.length) blocks.push({ type: 'item', text: `${plural(roleChanges.length, 'paragraph', 'paragraphs')} given another role (a heading taken for text, say), so the style follows` });
  blocks.push({ type: 'heading', level: 2, text: 'Defaults we applied because the guidelines do not say' });
  const used = [...defaults.map(entry => entry.words), ...SETTLING_DEFAULTS.filter(entry => settled.some(finding => finding.disposition?.by === entry.id)).map(entry => `${entry.words} (${plural(settled.filter(finding => finding.disposition?.by === entry.id).length, 'place', 'places')})`)];
  if (!used.length) blocks.push({ type: 'paragraph', text: 'None.' });
  for (const line of used) blocks.push({ type: 'item', text: line });
  if (cleared.size) {
    blocks.push({ type: 'heading', level: 2, text: 'Settings we did not apply' });
    blocks.push({ type: 'paragraph', text: 'These were read out of the guidelines but concern something else, or are advice rather than a requirement for the text:' });
    for (const [id, reason] of cleared) blocks.push({ type: 'item', text: `${ruleById(sheet, id)?.statement ?? id}${reason ? ` (${reason})` : ''}` });
  }
  if (refusals.length) {
    blocks.push({ type: 'heading', level: 2, text: 'Changes we did not make' });
    blocks.push({ type: 'paragraph', text: 'A model proposed these, and code refused them: the words of titles, names, affiliations, abstracts and keyword lists are yours to decide, and the running text is the copyeditor’s. Each became a question in the file or a query on the copyeditor’s list.' });
    const tally = new Map();
    for (const entry of refusals) tally.set(entry.refusal, (tally.get(entry.refusal) ?? 0) + 1);
    for (const [refusal, count] of tally) blocks.push({ type: 'item', text: `${plural(count, 'proposal', 'proposals')} that ${REFUSAL_WORDS[refusal] ?? refusal}` });
  }
  blocks.push({ type: 'heading', level: 2, text: `You need to decide these ${asked.length} things` });
  if (!asked.length) blocks.push({ type: 'paragraph', text: 'Nothing.' });
  let current = null;
  for (const finding of [...asked].sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1))) {
    const where = placeName(chapters, paragraphs, finding.paragraphIndex);
    if (where !== current) { blocks.push({ type: 'heading', level: 3, text: where }); current = where; }
    blocks.push({ type: 'paragraph', runs: [{ text: `${kindLabel(finding.kind)}: `, bold: true }, { text: cut(finding.message.replace(READING_PREFIX, ''), 400) }] });
  }
  blocks.push({ type: 'heading', level: 2, text: 'For the copyeditor' });
  blocks.push({ type: 'paragraph', text: copyeditCount ? `${plural(copyeditCount, 'possible slip', 'possible slips')} in the running text, in a separate document: “${COPYEDIT_NAME}”.` : 'Nothing was noticed for the copyeditor.' });
  blocks.push({ type: 'heading', level: 2, text: 'Every rule in the guidelines, and what became of it' });
  blocks.push({ type: 'table', header: ['Rule', 'What became of it', 'Why'], widths: [6, 2, 3], rows: triage.map(entry => [[{ text: `${categoryLabel(entry.rule.category)}: `, bold: true }, { text: entry.rule.statement }], entry.end === 'deliver' ? `${END_WORDS.deliver}: ${DELIVERABLES[entry.deliverable] ?? DELIVERABLES.other}` : END_WORDS[entry.end], entry.question ? `${entry.why}: ${entry.question}` : entry.why]) });
  return { name: DID_NAME, bytes: buildDocx(blocks) };
}

/** The checklist: only the decisions and the things to hand in (one row per kind), and a count line for the rest. */
export function decideChecklist({ triage }) {
  const decisions = triage.filter(entry => entry.end === 'decision');
  const deliver = new Map();
  for (const entry of triage.filter(item => item.end === 'deliver')) deliver.set(entry.deliverable, [...(deliver.get(entry.deliverable) ?? []), entry]);
  const rows = [
    ...decisions.map(entry => [[{ text: `${categoryLabel(entry.rule.category)}: `, bold: true }, { text: entry.rule.statement }], 'To decide', entry.question ?? entry.why]),
    ...[...deliver].map(([kind, entries]) => [[{ text: `${DELIVERABLES[kind] ?? DELIVERABLES.other}: `, bold: true }, { text: entries.map(entry => entry.rule.statement.replace(/\.$/u, '')).join('; ') }], 'To hand in', plural(entries.length, 'rule asks for it', 'rules ask for it')]),
  ];
  const tally = end => triage.filter(entry => entry.end === end).length;
  const rest = `The other rules of the guidelines: ${plural(tally('done'), 'done by the tool', 'done by the tool')}, ${plural(tally('default'), 'settled by a default', 'settled by defaults')}, ${plural(tally('not-applicable'), 'not for this manuscript', 'not for this manuscript')}, ${plural(tally('copyedit'), 'for the copyeditor', 'for the copyeditor')}. Each is listed, with why, in “${DID_NAME}”.`;
  const blocks = [
    { type: 'heading', level: 1, text: 'Checklist' },
    { type: 'paragraph', text: 'What is left for you before you submit: the decisions the guidelines leave to you, and what to hand in with the manuscript. The questions about particular places are comments in the formatted file.' },
    rows.length ? { type: 'table', header: ['What', 'Status', 'Notes'], widths: [6, 2, 3], rows } : { type: 'paragraph', text: 'Nothing: no decision is left and nothing more is to be handed in.' },
    { type: 'paragraph', text: rest },
  ];
  return { name: 'Checklist', bytes: buildDocx(blocks), rows: rows.length, decisions: decisions.length, deliverables: deliver.size };
}
