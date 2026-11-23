// To-do checks on the front and back matter against the chapters: the manuscript's own contents
// list compared with the chapter titles and authors actually present (an entry missing, an entry
// that matches nothing, a title or a name worded differently, authors in another order), and the
// notes on contributors compared with the chapters' authors (an author with no note, a note on no
// author, a name spelled differently, an affiliation the note does not give, a note far from the
// length asked). Code compares words; nothing is changed. Pure: no DOM, no network.

import { affiliationSplit } from '../format/plan.js';
import { isAffiliation } from '../format/titles.js';
import { listed, plural } from './context.js';
import { rulesWith, ruleWith } from './rules.js';
import { frontMatterPart } from './parts.js';

// ---------------------------------------------------------------------------------------------
// Words

const fold = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** The words of a text as { norm, surface }: diacritics folded, lower case, apostrophes dropped. */
export function tokens(text) {
  const out = [];
  for (const match = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’‘`´]*/gu, found = String(text ?? '').matchAll(match); ;) {
    const next = found.next();
    if (next.done) break;
    const surface = next.value[0].replace(/['’‘`´]+$/u, '');
    const norm = fold(surface).replace(/['’‘`´]/gu, '');
    if (norm) out.push({ norm, surface });
  }
  return out;
}
const normsOf = text => tokens(text).map(token => token.norm);
// All the letters and digits of a text in one string, for comparing names however they are spaced.
const lettersOf = text => normsOf(text).join('');

// Words a contents line holds besides a title: a label (chapter, part and the like) and numbers.
const LABEL_WORDS = new Set(['introduction', 'chapter', 'part', 'section', 'conclusion', 'preface', 'foreword', 'afterword', 'epilogue', 'prologue', 'appendix', 'capitolo', 'parte', 'chapitre', 'partie', 'capitulo', 'kapitel', 'teil', 'introduzione', 'introduccion', 'einleitung']);
const ROMAN = /^[ivxlcdm]{1,7}$/u;
// How many words may differ between two titles before they count as two different titles.
const MANY_WORDS = 6;
const NUMBER = /^\d{1,4}$/u;
// Words an institution's name holds that do not tell one institution from another in a phrase match.
const LINKING = new Set(['the', 'of', 'at', 'de', 'del', 'della', 'degli', 'di', 'du', 'des', 'la', 'le', 'and', 'und', 'for', 'in']);
// What joins two names on one author line.
const NAME_SEPARATOR = /\s*(?:[,;&]|\band\b|\bet\b|\bund\b|\bwith\b)\s*/iu;

const share = (a, b) => {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return (2 * common) / (a.size + b.size);
};

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const quoted = text => `“${String(text).replace(/\s+/gu, ' ').trim()}”`;
const surfaces = (list, norms) => {
  const out = [];
  for (const norm of norms) {
    const token = list.find(entry => entry.norm === norm);
    if (token && !out.includes(token.surface)) out.push(token.surface);
  }
  return out.map(quoted);
};

// ---------------------------------------------------------------------------------------------
// The chapters' titles and people, and the matter's paragraphs

/**
 * Each chapter's title, authors (with the line that names them) and affiliations, read from the
 * formatter's title-block parts. An author line that also names the institution is cut where the
 * formatter cuts it.
 */
export function chapterPeople(context) {
  return context.chapters.map((chapter, at) => {
    const lines = (chapter.parts ?? []).map((part, position) => ({ part, index: chapter.titleBlock[position], text: context.textOf(chapter.titleBlock[position]) }));
    const title = lines.filter(line => line.part === 'title' || line.part === 'subtitle');
    const authors = [];
    const affiliations = [];
    for (const line of lines) {
      if (line.part === 'affiliation') affiliations.push({ index: line.index, text: line.text.replace(/^[\s([{]+|[\s)\]}]+$/gu, '') });
      if (line.part !== 'author') continue;
      const split = affiliationSplit(line.text);
      const names = split ? line.text.slice(0, split.at) : line.text;
      if (split) affiliations.push({ index: line.index, text: line.text.slice(split.resume).replace(/^[\s([{,]+|[\s)\]}]+$/gu, '') });
      for (const name of names.split(NAME_SEPARATOR).map(part => part.trim()).filter(part => /\p{L}/u.test(part))) {
        if (isAffiliation(name)) { affiliations.push({ index: line.index, text: name }); continue; }
        const words = tokens(name);
        authors.push({ name, line: line.index, words, surname: words[words.length - 1]?.norm ?? '' });
      }
    }
    return {
      chapter: at,
      titleIndex: context.titleOf(chapter),
      title: title.map(line => line.text.trim()).join(': '),
      titleWords: tokens(title.map(line => line.text).join(' ')),
      authors,
      affiliations,
    };
  });
}

const withText = (context, role) => context.paragraphs.filter(entry => entry.hints?.empty === false && entry.text.trim() && context.roleOf(entry.index) === role);

// ---------------------------------------------------------------------------------------------
// The contents list against the chapters

// A contents line's words without a page number at its end, unless the title it is matched with
// ends with that number too.
function bare(words, title) {
  const last = words[words.length - 1];
  if (!last || !(NUMBER.test(last.norm) || ROMAN.test(last.norm))) return words;
  if (title.length && title[title.length - 1].norm === last.norm) return words;
  return words.slice(0, -1);
}

// A surname as letters: with a particle written apart before it ("O' Name", "van Name") joined on,
// so it is found however the particle is spaced.
const PARTICLE = /^(?:o|d|l|mc|mac|van|von|de|di|da|du|le|la|del|della|ter|ten)$/u;
function surnameLetters(author) {
  const words = author.words.map(word => word.norm);
  let at = words.length - 1;
  while (at > 1 && PARTICLE.test(words[at - 1])) at -= 1;
  return words.slice(at).join('');
}
// Whether a contents line names an author: the surname's letters in the line's letters (a short
// surname only as a word of its own).
function names(line, author) {
  const surname = surnameLetters(author);
  if (surname.length < 4) return line.words.some(word => word.norm === surname);
  return line.words.map(word => word.norm).join('').includes(surname);
}
const endsWithNumber = line => {
  const last = line.words[line.words.length - 1]?.norm ?? '';
  return NUMBER.test(last) || ROMAN.test(last);
};

/**
 * The comparison of the contents list with the text: for each chapter, the contents lines matched
 * to it and what differs; the lines that match nothing; the chapters the list leaves out.
 * @returns {{ entries: Array<object>, chapters: Array<object>, unmatched: Array<object>, sections: Array<object> }}
 */
export function compareContents(context) {
  // Each line of the list: a contents list kept as one block (a Word table of contents in a content
  // control) holds all its lines in one paragraph, each on a line of its own.
  const lines = [];
  // The lines under a list of tables or figures belong to that list, not to the contents.
  const lists = new Set();
  let underList = false;
  for (const entry of context.paragraphs) {
    const role = context.roleOf(entry.index);
    if (role === 'front-matter-heading') underList = ['list-of-tables', 'list-of-figures'].includes(frontMatterPart(entry.text));
    else if (role !== 'contents-entry' && role) underList = false;
    if (underList && role === 'contents-entry') lists.add(entry.index);
  }
  for (const entry of withText(context, 'contents-entry').filter(entry => !lists.has(entry.index))) {
    const texts = entry.text.split('\n').map(text => text.trim()).filter(Boolean);
    texts.forEach((text, sub) => lines.push({ position: lines.length, index: entry.index, sub, last: sub === texts.length - 1, text, words: tokens(text) }));
  }
  const people = chapterPeople(context);
  const used = new Set();
  // Two lines in a row are one window when no empty paragraph parts them (a title wrapped onto a
  // second line, or an author line before its title).
  const adjacent = (a, b) => (b.index === a.index && b.sub === a.sub + 1) || (b.index === a.index + 1 && a.last && b.sub === 0);
  const windows = [];
  lines.forEach((line, position) => {
    windows.push([position]);
    if (lines[position + 1] && adjacent(line, lines[position + 1])) windows.push([position, position + 1]);
  });
  const ownWords = person => new Set([...person.authors.flatMap(author => author.words.map(word => word.norm)), ...person.affiliations.flatMap(entry => normsOf(entry.text))]);
  const windowWords = (window, person) => {
    const words = window.flatMap((position, at) => (at === window.length - 1 ? bare(lines[position].words, person.titleWords) : lines[position].words));
    const own = ownWords(person);
    const titleSet = new Set(person.titleWords.map(word => word.norm));
    return words.filter(word => titleSet.has(word.norm) || (!own.has(word.norm) && !LABEL_WORDS.has(word.norm) && !NUMBER.test(word.norm)));
  };
  const scored = [];
  for (const person of people) {
    const title = new Set(person.titleWords.map(word => word.norm));
    for (const window of windows) scored.push({ person, window, score: share(title, new Set(windowWords(window, person).map(word => word.norm))) });
  }
  scored.sort((a, b) => b.score - a.score || a.window.length - b.window.length);
  const matched = new Map();
  for (const { person, window, score } of scored) {
    if (score < 0.5) break;
    if (matched.has(person.chapter) || window.some(position => used.has(position))) continue;
    matched.set(person.chapter, window);
    window.forEach(position => used.add(position));
  }
  // A title wrapped onto the next line: a matched window whose last line has no page number takes
  // the line after it when that line ends with one and nothing else took it.
  for (const [chapter, window] of matched) {
    const last = window[window.length - 1];
    const next = last + 1;
    if (next < lines.length && !used.has(next) && !endsWithNumber(lines[last]) && endsWithNumber(lines[next]) && adjacent(lines[last], lines[next])
      && !people.some(person => person.authors.some(author => names(lines[next], author)))) {
      matched.set(chapter, [...window, next]);
      used.add(next);
    }
  }
  const hasSurnames = (line, person) => person.authors.length > 0 && person.authors.every(author => names(line, author));
  // A chapter whose title matched no line: the line after the one that names all its authors.
  for (const person of people) {
    if (matched.has(person.chapter)) continue;
    const at = lines.findIndex((line, position) => !used.has(position) && hasSurnames(line, person));
    if (at < 0) continue;
    used.add(at);
    const next = at + 1 < lines.length && !used.has(at + 1) && !people.some(other => other !== person && hasSurnames(lines[at + 1], other)) ? [at + 1] : [];
    next.forEach(position => used.add(position));
    matched.set(person.chapter, next.length ? next : [at]);
    person.authorLine = at;
  }
  // Each matched chapter's author lines: unused lines next to its title lines that name an author.
  for (const person of people) {
    const window = matched.get(person.chapter);
    if (!window) continue;
    const near = [window[0] - 2, window[0] - 1, window[window.length - 1] + 1, window[window.length - 1] + 2].filter(position => position >= 0 && position < lines.length);
    person.authorLines = [...(person.authorLine !== undefined ? [person.authorLine] : []), ...near.filter(position => !used.has(position) && person.authors.some(author => names(lines[position], author)))];
    person.authorLines.forEach(position => used.add(position));
  }

  // The headings of front and back matter, part titles and, for a contents list that also lists
  // them (a monograph's or dissertation's), the chapters' headings and the bibliography's and the
  // appendices' headings, against the lines left.
  const sections = ['front-matter-heading', 'part-title', 'bibliography-heading', 'appendix-heading', 'heading-1', 'heading-2'].flatMap(role => withText(context, role))
    .sort((a, b) => a.index - b.index).map(entry => ({ index: entry.index, text: entry.text, words: tokens(entry.text) }));
  const sectionMatches = [];
  for (const section of sections) {
    const target = new Set(section.words.map(word => word.norm).filter(word => !LABEL_WORDS.has(word) && !NUMBER.test(word)));
    let best = null;
    lines.forEach((line, position) => {
      if (used.has(position)) return;
      const words = bare(line.words, section.words).filter(word => !LABEL_WORDS.has(word.norm) && !NUMBER.test(word.norm));
      const score = share(target, new Set(words.map(word => word.norm)));
      if (score >= 0.5 && (!best || score > best.score)) best = { position, score, words };
    });
    if (!best) continue;
    used.add(best.position);
    const missing = [...target].filter(word => !best.words.some(token => token.norm === word));
    const extra = best.words.map(word => word.norm).filter(word => !target.has(word));
    sectionMatches.push({ section, line: lines[best.position], missing: surfaces(section.words, missing), extra: surfaces(best.words, extra) });
  }

  const chapters = people.map(person => {
    const window = matched.get(person.chapter);
    if (!window) return { person, missing: true };
    const entryLines = [...new Set([...(person.authorLines ?? []), ...window])].sort((a, b) => a - b).map(position => lines[position]);
    const words = windowWords(window, person);
    const title = new Set(person.titleWords.map(word => word.norm));
    const got = new Set(words.map(word => word.norm));
    const titleMissing = [...title].filter(word => !got.has(word) && !LABEL_WORDS.has(word));
    const titleExtra = [...got].filter(word => !title.has(word));
    // The authors: every surname present, in the chapter's order, and no other words beside names and affiliations.
    const authorWords = entryLines.filter(line => !window.includes(line.position) || hasSurnames(line, person)).flatMap(line => line.words);
    const authorLetters = authorWords.map(word => word.norm).join('');
    const absent = person.authors.filter(author => !authorLetters.includes(surnameLetters(author)));
    const places = person.authors.map(author => authorLetters.indexOf(surnameLetters(author))).filter(at => at >= 0);
    const reordered = absent.length === 0 && places.some((place, at) => at > 0 && place < places[at - 1]);
    const known = new Set([...ownWords(person), ...title, ...LABEL_WORDS]);
    // A word of an author's name written with its particle joined ("O'Name") is still the name.
    const nameLetters = person.authors.map(author => author.words.map(word => word.norm).join('')).join(' ');
    const peopleExtra = (person.authorLines ?? []).flatMap(position => lines[position].words).map(word => word.norm).filter(word => !known.has(word) && !NUMBER.test(word) && !(word.length >= 3 && nameLetters.includes(word)));
    return {
      person,
      lines: entryLines,
      titleMissing: surfaces(person.titleWords, titleMissing),
      titleExtra: surfaces(window.flatMap(position => lines[position].words), titleExtra),
      absent: absent.map(author => author.name),
      reordered,
      peopleExtra: surfaces((person.authorLines ?? []).flatMap(position => lines[position].words), [...new Set(peopleExtra)]),
    };
  });
  const unmatched = lines.filter(line => !used.has(line.position) && line.words.some(word => /\p{L}/u.test(word.norm)));
  return { lines, chapters, unmatched, sections: sectionMatches };
}

// What differs between a chapter and its contents entry, in words, or null when nothing does.
function chapterDifferences(entry) {
  if (entry.missing) return null;
  const parts = [];
  // More than a few words apart is another title, not a slip: say so rather than list them.
  if (entry.titleMissing.length + entry.titleExtra.length > MANY_WORDS) parts.push('the contents gives another title');
  else if (entry.titleMissing.length && entry.titleExtra.length) parts.push(`the contents has ${listed(entry.titleExtra)} where the chapter has ${listed(entry.titleMissing)}`);
  else if (entry.titleMissing.length) parts.push(`the contents leaves out ${listed(entry.titleMissing)}`);
  else if (entry.titleExtra.length) parts.push(`the contents adds ${listed(entry.titleExtra)}`);
  if (entry.absent.length) parts.push(`the contents does not name ${listed(entry.absent)}`);
  if (entry.reordered) parts.push('the contents gives the authors in another order');
  if (entry.peopleExtra.length) parts.push(`beside the authors' names the contents has ${listed(entry.peopleExtra)}, which the chapter's title page does not`);
  return parts.length ? { parts, people: entry.absent.length > 0 || entry.reordered || entry.peopleExtra.length > 0, title: entry.titleMissing.length > 0 || entry.titleExtra.length > 0 } : null;
}

const shortTitle = text => {
  const words = text.replace(/\s+/gu, ' ').trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/gu, '').split(' ');
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : words.join(' ');
};

// ---------------------------------------------------------------------------------------------
// The notes on contributors against the chapters' authors

/**
 * Which note on a contributor belongs to which chapter author: a note whose opening words spell the
 * author's name (however it is spaced), or nearly (a letter or two apart, which is reported), or
 * whose first words hold the author's surname.
 * @returns {{ pairs: Array<{ author, person, note, exact: boolean }>, unmatchedAuthors: Array<object>, unmatchedNotes: Array<object> }}
 */
export function matchNotes(context, people = chapterPeople(context)) {
  const notes = withText(context, 'contributor-note').map(entry => ({ index: entry.index, text: entry.text, letters: lettersOf(entry.text.slice(0, 200)), opening: tokens(entry.text).slice(0, 15) }));
  const candidates = [];
  for (const person of people) {
    for (const author of person.authors) {
      const key = author.words.map(word => word.norm).join('');
      if (key.length < 3) continue;
      notes.forEach((note, at) => {
        if (note.letters.startsWith(key)) { candidates.push({ person, author, at, rank: 0, exact: true }); return; }
        const near = Math.min(...[-2, -1, 0, 1, 2].map(change => distance(key, note.letters.slice(0, key.length + change))));
        if (near <= 2 && key.length >= 8) { candidates.push({ person, author, at, rank: near, exact: false }); return; }
        const words = note.opening.map(word => word.norm);
        if (author.surname.length >= 3 && words.includes(author.surname) && author.words.every(word => words.includes(word.norm))) candidates.push({ person, author, at, rank: 3, exact: true });
      });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const taken = new Set();
  const placed = new Set();
  const pairs = [];
  for (const { person, author, at, exact } of candidates) {
    if (taken.has(at) || placed.has(author)) continue;
    taken.add(at);
    placed.add(author);
    pairs.push({ person, author, note: notes[at], exact });
  }
  return {
    pairs,
    unmatchedAuthors: people.flatMap(person => person.authors.filter(author => !placed.has(author)).map(author => ({ person, author }))),
    unmatchedNotes: notes.filter((note, at) => !taken.has(at)),
  };
}

/** The notes on contributors that go with each chapter (by chapter number in the report), and the rest. */
export function notesByChapter(context) {
  const { pairs, unmatchedNotes } = matchNotes(context);
  const byChapter = new Map();
  for (const { person, note } of pairs) byChapter.set(person.chapter, [...(byChapter.get(person.chapter) ?? []), note.index]);
  return { byChapter, rest: unmatchedNotes.map(note => note.index) };
}

// An institution's words without the linking ones, and whether they stand in a row in a note.
const institutionWords = text => normsOf(text).filter(word => !LINKING.has(word));
function namesInstitution(institution, noteWords) {
  const wanted = institutionWords(institution);
  if (!wanted.length) return true;
  for (let at = 0; at + wanted.length <= noteWords.length; at += 1) if (wanted.every((word, offset) => noteWords[at + offset] === word)) return true;
  return false;
}
const institutions = text => text.split(/\s*[/;]\s*/u).map(part => part.trim()).filter(part => /\p{L}/u.test(part));
const wordCount = text => text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;

// The rule to name for a check of the matter: the first in these categories whose words mention
// what the check compares, else the first in them.
function ruleAbout(sheet, categories, pattern) {
  const rules = categories.flatMap(category => rulesWith(sheet, { category }));
  return rules.find(rule => pattern.test(`${rule.statement} ${rule.source?.quote ?? ''}`)) ?? rules[0] ?? null;
}
const CONTENTS_WORDS = /\bcontents\b|\btoc\b|\bsommario\b|\bindice\b|\binhalt/iu;
const CONTRIBUTOR_WORDS = /contributor|\bbio(?:s|graph\w*)?\b|\bnotes? on\b|\bauthors?\b|\bnames?\b/iu;

export const FRONT_CHECKS = [
  {
    id: 'contents-against-chapters',
    kind: 'contents-mismatch',
    needs: 'a contents list in the manuscript and a rule on the front matter or on consistency',
    basis: context => {
      if (!withText(context, 'contents-entry').length || !context.chapters.length) return null;
      const rule = ruleAbout(context.sheet, ['front-matter', 'consistency'], CONTENTS_WORDS);
      return rule ? { rule } : null;
    },
    run: context => {
      const result = compareContents(context);
      const findings = [];
      const summary = [];
      for (const entry of result.chapters) {
        const name = shortTitle(entry.person.title || context.textOf(entry.person.titleIndex));
        if (entry.missing) {
          summary.push(`${quoted(name)} is not in the list`);
          findings.push({ paragraphIndex: entry.person.titleIndex, message: 'This chapter is not in the contents list at the start of the manuscript. Add it there, with its title and authors as they stand here.' });
          continue;
        }
        const differs = chapterDifferences(entry);
        if (!differs) continue;
        const text = entry.lines.map(line => line.text.trim()).join(' / ');
        summary.push(`${quoted(name)}: ${differs.parts.join('; ')}`);
        const at = differs.people && !differs.title ? entry.person.authors[0]?.line ?? entry.person.titleIndex : entry.person.titleIndex;
        findings.push({
          paragraphIndex: at,
          message: `The contents list gives this chapter as ${quoted(text)}, which differs from its title page: ${differs.parts.join('; ')}. Check which is right and make the two agree.`,
        });
      }
      for (const match of result.sections) {
        if (!match.missing.length && !match.extra.length) continue;
        summary.push(`the section ${quoted(match.section.text)} is listed as ${quoted(match.line.text)}`);
      }
      if (result.unmatched.length) summary.push(`${plural(result.unmatched.length, 'line matches', 'lines match')} nothing in the text: ${listed(result.unmatched.slice(0, 8).map(line => quoted(shortTitle(line.text))))}${result.unmatched.length > 8 ? ' and others' : ''}`);
      if (summary.length) {
        const first = result.lines[0].index;
        const heading = context.paragraphs.filter(entry => entry.index < first && entry.hints?.empty === false && entry.text.trim()).pop();
        findings.unshift({
          paragraphIndex: heading && context.roleOf(heading.index) === 'front-matter-heading' ? heading.index : first,
          message: `This contents list does not match the text in ${plural(summary.length, 'place')}:\n${summary.map(line => `- ${line};`).join('\n').replace(/;$/u, '.')}\nThe publisher usually rebuilds the contents from the chapters' own title pages: correct whichever of the two is wrong.`,
        });
      }
      return findings;
    },
  },
  {
    id: 'contributors-against-chapters',
    kind: 'contributor-bio',
    needs: 'notes on contributors in the manuscript and a rule on contributors or on consistency',
    basis: context => {
      if (!withText(context, 'contributor-note').length || !context.chapters.length) return null;
      const rule = ruleWith(context.sheet, { slot: 'contributors.words' }) ?? ruleAbout(context.sheet, ['contributors', 'consistency'], CONTRIBUTOR_WORDS);
      return rule ? { rule } : null;
    },
    run: (context, rule) => {
      const people = chapterPeople(context);
      const { pairs, unmatchedAuthors, unmatchedNotes } = matchNotes(context, people);
      const notes = withText(context, 'contributor-note');
      const findings = [];
      if (unmatchedAuthors.length) {
        const heading = context.paragraphs.filter(entry => entry.index < notes[0].index && entry.hints?.empty === false && entry.text.trim()).pop();
        findings.push({
          paragraphIndex: heading && context.roleOf(heading.index) === 'front-matter-heading' ? heading.index : notes[0].index,
          message: `The notes on contributors have no note on ${listed(unmatchedAuthors.map(({ author }) => author.name.trim()))}, ${unmatchedAuthors.length === 1 ? 'who is named' : 'who are named'} as ${unmatchedAuthors.length === 1 ? 'an author' : 'authors'} of a chapter. Add a note for each, or check how the name is written in both places.`,
        });
      }
      for (const note of unmatchedNotes) {
        findings.push({ paragraphIndex: note.index, message: 'This note on a contributor names no one given as an author of a chapter. Check the name against the chapters\' title pages, or whether the note belongs in the book.' });
      }
      for (const { author, note, exact } of pairs) {
        if (exact) continue;
        const shown = note.text.trim().split(/\s+/u).slice(0, author.words.length).join(' ');
        findings.push({ paragraphIndex: note.index, message: `This note gives the name as ${quoted(shown)}, and the chapter's title page as ${quoted(author.name)}. Check the spelling and use the same form in both places.` });
      }
      // An affiliation the author's note does not give: one finding per affiliation line.
      const byLine = new Map();
      for (const { person, author, note } of pairs) {
        if (!person.affiliations.length) continue;
        const own = person.affiliations.length === person.authors.length ? [person.affiliations[person.authors.indexOf(author)]] : person.affiliations;
        const noteWords = normsOf(note.text).filter(word => !LINKING.has(word));
        if (own.some(entry => institutions(entry.text).some(institution => namesInstitution(institution, noteWords)))) continue;
        const line = own[0];
        if (!byLine.has(line.index)) byLine.set(line.index, { line, authors: [] });
        byLine.get(line.index).authors.push(author.name.trim());
      }
      for (const { line, authors } of byLine.values()) {
        findings.push({
          kind: 'affiliation-inconsistent',
          paragraphIndex: line.index,
          message: `The note on ${listed(authors)} in the notes on contributors does not give the affiliation this title page gives, ${quoted(line.text)}. Check each author's affiliation and give the same one in both places.`,
        });
      }
      if (rule?.slot === 'contributors.words') {
        const max = rule.params.max;
        for (const note of notes) {
          const words = wordCount(note.text);
          if (words >= max / 2 && words <= max * 1.5) continue;
          findings.push({ paragraphIndex: note.index, message: `This note has ${plural(words, 'word')}; the guidelines ask for about ${max}. ${words < max ? 'Lengthen it' : 'Shorten it'}, or check with the editors how strictly the length applies.` });
        }
      }
      return findings;
    },
  },
];
