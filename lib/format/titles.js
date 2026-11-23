// Telling apart the parts of a chapter's title block: a chapter label ("Chapter 3"), the title, a
// subtitle, the author line and the affiliation. Decided in code from position, length, wording and
// formatting, without a model; docs/eval/brill-loop.md (round 2) records the measurement behind
// that choice. Pure: no DOM, no network.

export const TITLE_PARTS = Object.freeze(['label', 'title', 'subtitle', 'author', 'affiliation']);

// A chapter or part label on a line of its own, in the languages scholarly books are most often
// written in, or a bare number.
const LABEL = /^\s*(?:(?:chapter|part|section|chapitre|partie|capitolo|parte|cap[ií]tulo|kapitel|teil|hoofdstuk|deel|rozdzia[łl]|глава)\s+)?(?:\d{1,3}|[ivxlcdm]{1,8}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*[.:]?\s*$/iu;
const LABEL_WORD = /^\s*(?:chapter|part|chapitre|partie|capitolo|parte|cap[ií]tulo|kapitel|teil|hoofdstuk|deel)\b/iu;
// Words that name an institution, in the same languages; an e-mail address also marks an affiliation line.
const INSTITUTION = /\b(?:universit\w*|universidad\w*|universidade\w*|univ\.|college|coll[eè]ge|institut\w*|istituto|instituto|school|[ée]cole|escuela|scuola|academ\w*|accademia|akademie|center|centre|centro|zentrum|department|dept\.|dipartimento|departamento|d[ée]partement|faculty|facolt[àa]|facultad|facult[ée]|fakult[äa]t|laborator\w*|hochschule|polytechnic|politecnico|museum|museo|library|biblioteca|foundation|fondazione|seminary|cuny|suny)\b/iu;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/iu;
// Lower-case words a person's name may hold; any other lower-case word marks a phrase, not a name.
const NAME_PARTICLES = new Set(['and', 'et', 'e', 'y', 'und', 'en', 'de', 'di', 'da', 'del', 'della', 'dello', 'dei', 'degli', 'des', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ten', 'ter', 'dos', 'das', 'do', 'bin', 'ibn', 'al', 'el', 'zu', 'af', 'with']);

const words = text => text.trim().split(/\s+/u).filter(Boolean);

/** True when the text reads as a chapter or part label on a line of its own. */
export const isLabel = text => LABEL.test(text) || (LABEL_WORD.test(text) && words(text).length <= 3 && !/[a-z]{4,}\s+[a-z]{4,}/u.test(text.replace(LABEL_WORD, '')));

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
export function titleParts(block) {
  const parts = [];
  let at = 0;
  while (at < block.length - 1 && isLabel(block[at].text)) { parts.push('label'); at += 1; }
  if (at >= block.length) return parts;
  parts.push('title');
  const person = text => isAffiliation(text) || (isNames(text) && !looksLikePhrase(text));
  // The people are the longest run at the end of the block in which every line reads as names or
  // as an affiliation; the lines between the title and them are subtitles.
  let people = block.length;
  while (people - 1 > at && person(block[people - 1].text)) people -= 1;
  // An author line comes before its affiliation: a run that starts with an affiliation takes the
  // line before it as the author line, if there is one after the title.
  if (people < block.length && isAffiliation(block[people].text) && people - 1 > at) people -= 1;
  // More author lines before the first affiliation than there are affiliations: the first of
  // them, right after the title, is a subtitle in title case (two authors sharing one affiliation
  // line is the rarer layout).
  const kinds = block.slice(people).map(entry => (isAffiliation(entry.text) ? 'affiliation' : 'author'));
  const firstAffiliation = kinds.indexOf('affiliation');
  const affiliations = kinds.filter(kind => kind === 'affiliation').length;
  if (people === at + 1 && firstAffiliation > affiliations) people += firstAffiliation - affiliations;
  for (let index = at + 1; index < people; index += 1) parts.push('subtitle');
  const rest = block.slice(people).map(entry => (isAffiliation(entry.text) ? 'affiliation' : 'author'));
  // A block whose people lines all name an institution still has an author line: the first.
  if (rest.length && !rest.includes('author')) rest[0] = 'author';
  parts.push(...rest);
  return parts;
}
