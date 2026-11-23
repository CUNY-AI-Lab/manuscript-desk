// The companion documents the guidelines ask for, each produced only when a rule in the sheet asks
// for it: abstracts and keywords per chapter (filled from the manuscript where a chapter has them, a
// marked gap where it does not), an alt-text template listing every figure by its number, a
// checklist of the rule sheet's requirements with a status for each, and running titles (the title
// itself where it is short enough, otherwise a blank to fill; a model's proposals when given). Pure:
// no DOM, no network.

import { buildDocx } from '../docx/build.js';
import { ruleWith } from '../checks/rules.js';
import { activeRules, appliedByFormatter, categoryLabel, chapterName, rulesOf, sourceBlocks } from './shared.js';

const LABEL = /^\s*[\p{L}][\p{L}\p{M}'’-]*(?:\s[\p{L}][\p{L}\p{M}'’-]*)?\s*[:：.—–-]\s*/u;
const withoutLabel = text => {
  const match = LABEL.exec(text);
  return (match && match[0].length <= 30 ? text.slice(match[0].length) : text).trim();
};
const length = text => Array.from(text).length;

function parts(chapter, paragraphs, roles) {
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const inChapter = role => paragraphs.filter(entry => entry.index >= chapter.first && entry.index <= chapter.last && entry.hints?.empty === false && roleOf(entry.index) === role);
  const lines = part => (chapter.parts ?? []).flatMap((name, at) => (name === part ? [byIndex.get(chapter.titleBlock[at])?.text.trim() ?? ''] : [])).filter(Boolean);
  return { abstract: inChapter('abstract'), keywords: inChapter('keywords'), authors: lines('author'), title: lines('title')[0] ?? '', subtitles: lines('subtitle') };
}

/** Abstracts and keywords per chapter, or null when no rule asks for them. */
export function abstractsDocument({ sheet, report, paragraphs, roles }) {
  const rule = ruleWith(sheet, { category: 'abstract-keywords' });
  if (!rule) return null;
  const words = ruleWith(sheet, { slot: 'abstract.words' })?.params?.max;
  const count = ruleWith(sheet, { slot: 'keywords.count' })?.params;
  const blocks = [{ type: 'heading', level: 1, text: 'Abstracts and keywords' }, { type: 'paragraph', text: 'Collected from the chapters, as the guidelines ask. A marked gap is a chapter that has none in the manuscript yet.' }, ...sourceBlocks(rule)];
  const entries = [];
  for (const chapter of report.chapters ?? []) {
    const found = parts(chapter, paragraphs, roles);
    blocks.push({ type: 'heading', level: 2, text: chapterName(chapter, paragraphs) });
    if (found.authors.length) blocks.push({ type: 'paragraph', runs: [{ text: found.authors.join(', '), italic: true }] });
    const abstract = found.abstract.map((entry, at) => (at === 0 ? withoutLabel(entry.text) : entry.text.trim())).join('\n');
    const keywords = found.keywords.map(entry => withoutLabel(entry.text)).join(' ');
    blocks.push({ type: 'paragraph', runs: [{ text: 'Abstract: ', bold: true }, abstract ? { text: abstract } : { text: `[to write: an abstract${words ? ` of about ${words} words` : ''}]`, gap: true }] });
    blocks.push({ type: 'paragraph', runs: [{ text: 'Keywords: ', bold: true }, keywords ? { text: keywords } : { text: `[to write: keywords${count ? ` (${count.min ? `${count.min} to ` : 'at most '}${count.max})` : ''}]`, gap: true }] });
    entries.push({ chapter: chapter.first, abstract: Boolean(abstract), keywords: Boolean(keywords) });
  }
  return { name: 'Abstracts and Keywords', bytes: buildDocx(blocks), entries };
}

/**
 * An alt-text template, or null. With the formatted file's pictures (`accessibility`, the facts the
 * accessibility check reads), it lists exactly those pictures, each with the alt text it has now,
 * and is made when a rule asks for alt texts or when a picture has none; without them, it lists
 * every figure by its number when a rule asks.
 */
export function altTextsDocument({ sheet, report, paragraphs, roles, accessibility = null }) {
  const rule = ruleWith(sheet, { category: 'alt-text' });
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const chapterOf = index => (report.chapters ?? []).find(chapter => index >= chapter.first && index <= chapter.last) ?? null;
  const chapterCell = index => (chapterOf(index) ? chapterName(chapterOf(index), paragraphs) : '');
  if (accessibility) {
    const pictures = accessibility.pictures.filter(picture => !picture.decorative && !picture.hidden);
    if (!pictures.length || (!rule && pictures.every(picture => picture.descr || picture.title))) return null;
    const figures = report.figures ?? [];
    const entries = pictures.map((picture, at) => {
      const source = report.map?.[picture.position]?.source ?? null;
      // The figure a picture belongs to: the formatter's figure starting at or just before its paragraph.
      const figure = source === null ? null : [...figures].reverse().find(entry => entry.index <= source && source - entry.index <= 3) ?? null;
      const caption = figure?.captionAt !== null && figure?.captionAt !== undefined ? byIndex.get(figure.captionAt)?.text.trim() : null;
      return { index: source, label: figure ? figure.label : `Picture ${at + 1}`, caption, alt: picture.descr || picture.title || null };
    });
    const blocks = [
      { type: 'heading', level: 1, text: 'Alt texts' },
      { type: 'paragraph', text: `The ${entries.length === 1 ? 'picture' : `${entries.length} pictures`} in the formatted file, in order, with the alternative text each has now. Describe what each shows as it bears on the text, in a sentence or two, without restating the caption, and enter it on the picture itself (in Word, right-click > View Alt Text; in Google Docs, Image options > Alt text). Pictures marked as decorative are left out.` },
      ...(rule ? sourceBlocks(rule) : []),
      { type: 'table', header: ['Figure', 'Chapter', 'Caption (from the manuscript)', 'Alt text now', 'Alt text'], widths: [1, 2, 3, 3, 3], rows: entries.map(entry => [entry.label, entry.index === null ? '' : chapterCell(entry.index), entry.caption ? entry.caption : [{ text: '[no caption found]', gap: true }], entry.alt ? entry.alt : [{ text: '[none]', gap: true }], entry.alt ? '' : [{ text: '[to write]', gap: true }]]) },
    ];
    return { name: 'Alt Texts (template)', bytes: buildDocx(blocks), entries: entries.map(entry => ({ index: entry.index, label: entry.label, alt: Boolean(entry.alt) })) };
  }
  if (!rule) return null;
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  // The figures: those the formatter numbered, or else each run of figure paragraphs, numbered in order.
  let figures = (report.figures ?? []).map(figure => ({ index: figure.index, label: figure.label, caption: figure.captionAt === null ? null : byIndex.get(figure.captionAt)?.text.trim() }));
  if (!figures.length) {
    let previous = false;
    for (const entry of paragraphs) {
      if (entry.hints?.empty) continue;
      const isFigure = roleOf(entry.index) === 'figure';
      if (isFigure && !previous) figures.push({ index: entry.index, label: String(figures.length + 1), caption: entry.hints?.image ? null : entry.text.trim() || null });
      previous = isFigure;
    }
  }
  const blocks = [
    { type: 'heading', level: 1, text: 'Alt texts' },
    { type: 'paragraph', text: 'An alt text for every figure, for readers who use a screen reader. Describe the content of the image as it bears on the chapter, in a sentence or two, without restating the caption. Whoever holds the image files is best placed to write them.' },
    ...sourceBlocks(rule),
    { type: 'table', header: ['Figure', 'Chapter', 'Caption (from the manuscript)', 'Alt text'], widths: [1, 2, 3, 4], rows: figures.map(figure => [figure.label, chapterCell(figure.index), figure.caption ? figure.caption : [{ text: '[no caption in the text yet]', gap: true }], [{ text: '[to write]', gap: true }]]) },
  ];
  if (!figures.length) blocks.push({ type: 'paragraph', text: 'The manuscript has no figures, so there is nothing to describe.' });
  return { name: 'Alt Texts (template)', bytes: buildDocx(blocks), entries: figures.map(figure => ({ index: figure.index, label: figure.label })) };
}

/**
 * Running titles: the title itself where it fits the length the rule gives, a model's proposal
 * where one is given, otherwise a blank to fill. Null when no rule asks for running titles.
 * @param {{ proposals?: Map<number, string> }} input proposals by chapter start, already checked for length
 */
export function runningTitlesDocument({ sheet, report, paragraphs, roles, proposals = new Map() }) {
  const rule = ruleWith(sheet, { slot: 'running-title.length' });
  if (!rule) return null;
  const max = rule.params.max;
  const entries = [];
  const rows = (report.chapters ?? []).map(chapter => {
    const found = parts(chapter, paragraphs, roles);
    const main = found.title.split(/:\s+/u)[0].trim();
    const proposal = proposals.get(chapter.first) ?? (length(main) <= max ? main : null);
    entries.push({ chapter: chapter.first, proposed: Boolean(proposal), source: proposals.has(chapter.first) ? 'model' : proposal ? 'title' : null });
    return [chapterName(chapter, paragraphs), proposal ? proposal : [{ text: `[to write: at most ${max} characters]`, gap: true }], proposal ? String(length(proposal)) : ''];
  });
  const blocks = [
    { type: 'heading', level: 1, text: 'Running titles' },
    { type: 'paragraph', text: `One running title per chapter, no longer than ${max} characters (spaces and punctuation count). ${proposals.size ? 'The proposals are drafts from the chapter titles: confirm or replace each one.' : 'Where a chapter’s main title is short enough it is proposed as it stands; write the others.'}` },
    ...sourceBlocks(rule),
    { type: 'table', header: ['Chapter', 'Proposed running title', 'Characters'], widths: [5, 4, 1], rows },
  ];
  return { name: proposals.size ? 'Running Titles (proposals)' : 'Running Titles (template)', bytes: buildDocx(blocks), entries };
}

const STATUS = { done: 'done by the tool', flagged: 'flagged', clear: 'checked: nothing found', supply: 'to supply', unchecked: 'not checked', conflict: 'not applied: in conflict', off: 'switched off' };

/** The status of each rule of the sheet: what the tool did with it. */
export function ruleStatuses({ sheet, report, findings, checks }) {
  const flagged = new Map();
  for (const finding of findings) if (finding.ruleId) flagged.set(finding.ruleId, (flagged.get(finding.ruleId) ?? 0) + 1);
  const checkedClear = new Set(checks.filter(check => check.ran && check.ruleId && !flagged.has(check.ruleId)).map(check => check.ruleId));
  return rulesOf(sheet).map(rule => {
    let status;
    if (rule.enabled === false) status = 'off';
    else if (rule.conflict === true) status = 'conflict';
    else if (appliedByFormatter(rule, report)) status = flagged.has(rule.id) ? 'flagged' : 'done';
    else if (flagged.has(rule.id)) status = 'flagged';
    else if (checkedClear.has(rule.id)) status = 'clear';
    else status = rule.mode === 'supply' ? 'supply' : 'unchecked';
    return { rule, status, count: flagged.get(rule.id) ?? 0 };
  });
}

/** The checklist of the sheet's requirements with a status for each, or null for a sheet with no rules. */
export function checklistDocument({ sheet, report, findings, checks }) {
  if (!activeRules(sheet).length) return null;
  const statuses = ruleStatuses({ sheet, report, findings, checks });
  const notes = { done: 'Applied in the formatted file.', flagged: null, clear: 'The tool found nothing to report.', supply: 'Only you can provide this.', unchecked: 'Needs someone to read the text.', conflict: 'Choose between the rules that disagree.', off: '' };
  const rows = statuses.map(({ rule, status, count }) => [
    [{ text: `${categoryLabel(rule.category)}: `, bold: true }, { text: rule.statement }],
    STATUS[status],
    status === 'flagged' ? `${count} ${count === 1 ? 'place' : 'places'}: see the To-dos and the comments.` : notes[status],
  ]);
  const blocks = [
    { type: 'heading', level: 1, text: 'Checklist' },
    { type: 'paragraph', text: 'Every requirement in the rule sheet, with what the tool did about it. “Done by the tool” is applied in the formatted file; “flagged” has comments and To-dos; “to supply” is for you to provide; “not checked” needs someone to read the text.' },
    { type: 'table', header: ['Requirement', 'Status', 'Notes'], widths: [6, 2, 3], rows },
  ];
  const tally = {};
  for (const { status } of statuses) tally[status] = (tally[status] ?? 0) + 1;
  return { name: 'Checklist', bytes: buildDocx(blocks), entries: statuses.map(({ rule, status }) => ({ ruleId: rule.id, status })), tally };
}

/** Every companion document a rule asks for, in a fixed order. */
export function companionDocuments(input) {
  return [abstractsDocument(input), altTextsDocument(input), runningTitlesDocument(input), checklistDocument(input)].filter(Boolean);
}
