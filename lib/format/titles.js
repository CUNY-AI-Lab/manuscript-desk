// Telling apart the parts of a chapter's title block: a chapter label ("Chapter 3"), the title, a
// subtitle, the author line and the affiliation. Decided in code from position, length, wording and
// formatting, without a model; docs/eval/brill-loop.md (round 2) records the measurement behind
// that choice. Pure: no DOM, no network.

export const TITLE_PARTS = Object.freeze(['label', 'title', 'subtitle', 'author', 'affiliation', 'statement']);

// A chapter or part label on a line of its own, in the languages scholarly books are most often
// written in, or a bare number.
const LABEL = /^\s*(?:(?:chapter|part|section|chapitre|partie|capitolo|parte|cap[ií]tulo|kapitel|teil|hoofdstuk|deel|rozdzia[łl]|глава)\s+)?(?:\d{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*[.:]?\s*$/iu;
const LABEL_WORD = /^\s*(?:chapter|part|chapitre|partie|capitolo|parte|cap[ií]tulo|kapitel|teil|hoofdstuk|deel)\b/iu;
// Words that name an institution, in the same languages; an e-mail address also marks an affiliation line.
const INSTITUTION = /\b(?:universit\w*|universidad\w*|universidade\w*|univ\.|college|coll[eè]ge|institut\w*|istituto|instituto|school|[ée]cole|escuela|scuola|academ\w*|accademia|akademie|center|centre|centro|zentrum|department|dept\.|dipartimento|departamento|d[ée]partement|faculty|facolt[àa]|facultad|facult[ée]|fakult[äa]t|laborator\w*|hochschule|polytechnic|politecnico|museum|museo|library|biblioteca|foundation|fondazione|seminary|cuny|suny)\b/iu;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/iu;
// A line that introduces the editors of a book: "Edited by", in the same languages.
const EDITED_BY = /^\s*(?:by|edited\s+by|ed(?:s)?\.\s+by|a\s+cura\s+di|herausgegeben\s+von|hrsg\.\s+von|sous\s+la\s+direction\s+de|edici[oó]n\s+de|editado\s+por|organizado\s+por|onder\s+redactie\s+van|pod\s+redakcj[aą])\s*:?\s*$/iu;
// Lower-case words a person's name may hold; any other lower-case word marks a phrase, not a name.
const NAME_PARTICLES = new Set(['and', 'et', 'e', 'y', 'und', 'en', 'de', 'di', 'da', 'del', 'della', 'dello', 'dei', 'degli', 'des', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ten', 'ter', 'dos', 'das', 'do', 'bin', 'ibn', 'al', 'el', 'zu', 'af', 'with']);

const words = text => text.trim().split(/\s+/u).filter(Boolean);

// A dissertation's or thesis's title page also states what the work is, for which degree and when:
// a submission statement, a degree line, a date (a year, or a month or season and a year), an
// advisor or committee line. In the languages above where the words are common.
const STATEMENT = /\b(?:dissertation|thesis|th[eè]se|tesi|tesis|doktorarbeit|capstone|submitted|presented\s+to|in\s+partial\s+fulfil+ment|requirements\s+for\s+the\s+degree|degree\s+of|doctor\s+of|master\s+of|candidacy|graduate\s+faculty|graduate\s+school)\b/iu;
const DATE_LINE = /^\s*(?:(?:january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|autumn|winter)\s+)?(?:19|20)\d{2}\s*$/iu;
const ROLE_LINE = /^\s*(?:advis[eo]r|supervisor|committee|dissertation\s+director|director|chair|mentor)s?\b/iu;

/** True when a title-page line states what the work is, for which degree, when, or under whom. */
export const isStatement = text => DATE_LINE.test(text) || ROLE_LINE.test(text) || (STATEMENT.test(text) && words(text).length >= 3);

/** True when the text reads as a chapter or part label on a line of its own. */
export const isLabel = text => LABEL.test(text) || (LABEL_WORD.test(text) && words(text).length <= 3 && !/[a-z]{4,}\s+[a-z]{4,}/u.test(text.replace(LABEL_WORD, '')));

/** True when the text only introduces the editors ("Edited by"). */
export const isEditedBy = text => EDITED_BY.test(text);

/** True when the text names an institution or holds an e-mail address. */
export const isAffiliation = text => INSTITUTION.test(text) || EMAIL.test(text);

/**
 * True when the text reads as one or more personal names: short, no digits or sentence
 * punctuation, every word capitalized except the particles names hold.
 */
export function isNames(text) {
  const list = words(text.replace(/[,;&]/gu, ' '));
  if (list.length === 0 || list.length > 14 || /\d|[:?!]/u.test(text) || Array.from(text).length > 120) return false;
  return list.every(word => NAME_PARTICLES.has(word.toLowerCase()) || /^[\p{Lu}\p{Lt}]/u.test(word) || /^\p{Lu}?\.$/u.test(word) || /^[('"‘“]?\p{Lu}/u.test(word));
}

// A phrase in title case holds short lower-case function words; a list of names does not.
const looksLikePhrase = text => words(text).some(word => /^\p{Ll}/u.test(word) && !NAME_PARTICLES.has(word.toLowerCase()));

/**
 * The part of each paragraph of one title block, in order.
 * @param {Array<{ text: string, hints?: object }>} block the block's non-empty paragraphs, in order
 * @returns {string[]} one of TITLE_PARTS per paragraph
 */
/**
 * Where a line of names followed by their institution splits, or null: "Name (Institution)" or
 * "Name, Institution" -> { at, resume } offsets (the separator lies between them).
 */
export function namesThenInstitution(text) {
  const trimmed = text.trimEnd();
  const bracket = /\s+\(([^()]+)\)$/u.exec(trimmed);
  if (bracket && isAffiliation(bracket[1]) && isNames(trimmed.slice(0, bracket.index))) return { at: bracket.index, resume: bracket.index + bracket[0].length - bracket[1].length - 2 };
  const comma = /,\s+/u.exec(trimmed);
  if (comma && isAffiliation(trimmed.slice(comma.index)) && !isAffiliation(trimmed.slice(0, comma.index)) && isNames(trimmed.slice(0, comma.index))) return { at: comma.index, resume: comma.index + comma[0].length };
  return null;
}

export function titleParts(block, { statements = false } = {}) {
  if (!statements) return readParts(block);
  // On a whole work's title page, statement lines at the end (a submission statement, a date) are
  // set aside before the people are found, and any other statement line after the title is one too.
  let end = block.length;
  while (end > 1 && isStatement(block[end - 1].text)) end -= 1;
  const parts = readParts(block.slice(0, end));
  for (let index = parts.indexOf('title') + 1; index > 0 && index < parts.length; index += 1) if (parts[index] !== 'label' && isStatement(block[index].text)) parts[index] = 'statement';
  return [...parts, ...Array(block.length - end).fill('statement')];
}

function readParts(block) {
  const parts = [];
  let at = 0;
  while (at < block.length - 1 && isLabel(block[at].text)) { parts.push('label'); at += 1; }
  if (at >= block.length) return parts;
  parts.push('title');
  const person = text => isEditedBy(text) || isAffiliation(text) || (isNames(text) && !looksLikePhrase(text));
  // A line of people's names followed by their institution ("Name, Institution") is an author line.
  const kindOf = text => (isEditedBy(text) ? 'label' : isAffiliation(text) && !namesThenInstitution(text) ? 'affiliation' : 'author');
  // The people are the longest run at the end of the block in which every line reads as names or
  // as an affiliation; the lines between the title and them are subtitles.
  let people = block.length;
  while (people - 1 > at && person(block[people - 1].text)) people -= 1;
  // Lines before an "Edited by" line are the title's, however they read.
  const editedBy = block.findIndex((entry, index) => index > at && isEditedBy(entry.text));
  if (editedBy > at) people = Math.max(people, editedBy);
  // An author line comes before its affiliation: a run that starts with an affiliation takes the
  // line before it as the author line, if there is one after the title.
  if (people < block.length && kindOf(block[people].text) === 'affiliation' && people - 1 > at) people -= 1;
  // More author lines before the first affiliation than there are affiliations: the first of
  // them, right after the title, is a subtitle in title case (two authors sharing one affiliation
  // line is the rarer layout).
  const kinds = block.slice(people).map(entry => kindOf(entry.text));
  const firstAffiliation = kinds.indexOf('affiliation');
  const affiliations = kinds.filter(kind => kind === 'affiliation').length;
  if (people === at + 1 && firstAffiliation > affiliations) people += firstAffiliation - affiliations;
  for (let index = at + 1; index < people; index += 1) parts.push('subtitle');
  const rest = block.slice(people).map(entry => kindOf(entry.text));
  // A block whose people lines all name an institution still has an author line: the first.
  if (rest.length && !rest.includes('author')) rest[rest[0] === 'label' && rest.length > 1 ? 1 : 0] = 'author';
  parts.push(...rest);
  return parts;
}
