// The rule sheet: the structured list of requirements read out of a publisher's guidelines.
// Pure data and validation; no DOM, no network. validateRule and validateSheet treat their input
// as untrusted (a model reply or an uploaded file): they never throw, never mutate it, and return
// a cleaned copy holding only known keys.

export const SHEET_VERSION = 1;
export const DOC_TYPES = Object.freeze(['article', 'monograph', 'edited-collection', 'dissertation']);
export const MODES = Object.freeze(['fix', 'flag', 'supply']);

const ALL = DOC_TYPES;
const ARTICLE = ['article'];
const ABSTRACTS = ['article', 'edited-collection', 'dissertation'];
const BOOKS = ['monograph', 'edited-collection', 'dissertation'];
const ARTICLE_DISSERTATION = ['article', 'dissertation'];
const COLLECTION = ['edited-collection'];

const category = (id, label, group, docTypes) => Object.freeze({ id, label, group, docTypes: Object.freeze([...docTypes]) });

export const CATEGORIES = Object.freeze([
  category('spelling', 'Spelling', 'style', ALL),
  category('quotations', 'Quotations', 'style', ALL),
  category('punctuation', 'Punctuation', 'style', ALL),
  category('numbers', 'Numbers', 'style', ALL),
  category('abbreviations', 'Abbreviations', 'style', ALL),
  category('italics', 'Italics', 'style', ALL),
  category('headings', 'Headings', 'style', ALL),
  category('citations', 'Citations', 'references', ALL),
  category('references', 'References', 'references', ALL),
  category('notes', 'Notes', 'references', ALL),
  category('figures-tables', 'Figures and tables', 'structure', ALL),
  category('alt-text', 'Alt text', 'structure', ALL),
  category('permissions', 'Permissions', 'structure', ALL),
  category('layout', 'Layout', 'structure', ALL),
  category('length', 'Length', 'structure', ALL),
  category('files', 'Files', 'structure', ALL),
  category('statements', 'Statements', 'structure', ALL),
  category('accessibility', 'Accessibility', 'structure', ALL),
  category('other', 'Other requirements', 'structure', ALL),
  category('abstract-keywords', 'Abstract and keywords', 'structure', ABSTRACTS),
  category('title-page', 'Title page', 'structure', ARTICLE_DISSERTATION),
  category('anonymization', 'Anonymization', 'structure', ARTICLE),
  category('declarations', 'Declarations', 'structure', ARTICLE),
  category('front-matter', 'Front matter', 'structure', BOOKS),
  category('back-matter', 'Back matter', 'structure', BOOKS),
  category('index', 'Index', 'structure', ['monograph', 'edited-collection']),
  category('chapters', 'Chapters', 'structure', BOOKS),
  category('contributors', 'Contributors', 'structure', COLLECTION),
  category('consistency', 'Consistency', 'structure', COLLECTION),
]);
const CATEGORY_IDS = new Set(CATEGORIES.map(entry => entry.id));
// The groups the categories are read in, one model call each: the distinct `group` values in table order.
export const GROUPS = Object.freeze([...new Set(CATEGORIES.map(entry => entry.group))]);

export function categoriesFor(docType) {
  return CATEGORIES.filter(entry => entry.docTypes.includes(docType));
}

/** The settings (slot ids) a document type offers, in table order. Defined after SLOTS below. */
export function slotsFor(docType) {
  const offered = new Set(categoriesFor(docType).map(entry => entry.id));
  return Object.keys(SLOTS).filter(id => offered.has(SLOTS[id].category));
}

// Param validators. Each is a predicate carrying `allowed`, a short description of the values it
// accepts, so prompts can list them without restating the schema.
const validator = (test, allowed) => Object.freeze(Object.assign(test, { allowed }));
const oneOf = (...values) => validator(value => values.includes(value), values.map(value => JSON.stringify(value)).join(' | '));
const bool = validator(value => typeof value === 'boolean', 'true | false');
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const integer = (min, max = Infinity) => validator(
  value => Number.isInteger(value) && value >= min && value <= max,
  max === Infinity ? `whole number ${min} or more` : `whole number ${min} to ${max}`,
);
const number = (min, max) => validator(value => isNumber(value) && value >= min && value <= max, `number ${min} to ${max}`);
const orNull = inner => validator(value => value === null || inner(value), `${inner.allowed}, or null`);
const text = (min, max) => validator(value => typeof value === 'string' && value.length >= min && value.length <= max, `text of ${min} to ${max} characters`);
const positive = integer(1);

// The parts of a dissertation or book in the order a guide can give them, and what a title page
// holds. A setting names some of them in order, separated by ">", as "title-page > abstract > contents".
export const MATTER_PARTS = Object.freeze(['title-page', 'copyright', 'approval', 'abstract', 'dedication', 'epigraph', 'foreword', 'preface', 'acknowledgments', 'contents', 'list-of-tables', 'list-of-figures', 'list-of-abbreviations', 'body', 'appendix', 'notes', 'glossary', 'bibliography', 'vita']);
export const TITLE_PAGE_ELEMENTS = Object.freeze(['title', 'author', 'statement', 'degree', 'program', 'institution', 'year', 'month', 'advisor']);
export const partsOf = value => value.split('>').map(part => part.trim());
const partsList = (known, what) => validator(
  value => typeof value === 'string' && value.length <= 400 && partsOf(value).length > 0
    && partsOf(value).every(part => known.includes(part)) && new Set(partsOf(value)).size === partsOf(value).length,
  `${what} separated by ">", each once, from: ${known.join(', ')}`,
);
const matterParts = partsList(MATTER_PARTS, 'parts in order');
const titleElements = partsList(TITLE_PAGE_ELEMENTS, 'elements');
const inches = orNull(number(0.25, 3));
const lineOrNull = orNull(number(1, 3));
const someSet = names => params => (names.every(name => params[name] === null) ? `params: ${names.join(' or ')}` : null);

const slot = (categoryId, params, check) => Object.freeze({ category: categoryId, params: Object.freeze(params), ...(check ? { check } : {}) });

// `check`, where present, is a constraint across params; it returns the failing field or null.
export const SLOTS = Object.freeze({
  'quotes.primary': slot('quotations', { style: oneOf('double', 'single') }),
  'quotes.punctuation': slot('quotations', { inside: bool }),
  'blockquote.threshold': slot('quotations', { words: orNull(positive), lines: orNull(positive) },
    params => (params.words === null && params.lines === null ? 'params: words or lines' : null)),
  'dash.ranges': slot('punctuation', { dash: oneOf('en', 'hyphen') }),
  'comma.serial': slot('punctuation', { use: bool }),
  'ellipsis.form': slot('punctuation', { form: oneOf('character', 'three-dots', 'spaced') }),
  'spelling.variety': slot('spelling', { variety: oneOf('us', 'uk', 'oxford', 'ca', 'au') }),
  'numbers.spellout': slot('numbers', { below: integer(2, 1001) }),
  'percent.form': slot('numbers', { form: oneOf('percent', 'per cent', '%') }),
  'centuries.form': slot('numbers', { form: oneOf('spelled', 'numeral') }),
  'headings.case': slot('headings', { case: oneOf('title', 'sentence') }),
  'headings.numbering': slot('headings', { scheme: oneOf('decimal', 'none') }),
  'titles.quotes': slot('headings', { allowed: bool }),
  'chapters.subtitle': slot('chapters', { split: bool }),
  'chapters.label': slot('chapters', { example: text(3, 40) }),
  'figures.numbering': slot('figures-tables', { per: oneOf('chapter', 'document') }),
  'figures.markers': slot('figures-tables', { example: text(3, 80) }),
  'figures.files': slot('figures-tables', { separate: bool }),
  'figures.callouts': slot('figures-tables', { required: bool }),
  'notes.kind': slot('notes', { kind: oneOf('footnotes', 'endnotes') }),
  'notes.restart': slot('notes', { per: oneOf('chapter', 'none') }),
  'notes.titles': slot('notes', { allowed: bool }),
  'references.repeated-author': slot('references', { form: oneOf('name', 'dash') }),
  'citations.system': slot('citations', { system: oneOf('notes-bibliography', 'author-date', 'mla', 'apa', 'numbered', 'other') }),
  'layout.font': slot('layout', { family: orNull(text(1, 80)), sizePt: orNull(number(6, 30)) }),
  'layout.spacing': slot('layout', { line: number(1, 3) }),
  'layout.margins': slot('layout', { inches: number(0.25, 3) }),
  'layout.page-numbers': slot('layout', { position: oneOf('top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right') }),
  'layout.paper': slot('layout', { size: oneOf('letter', 'a4') }),
  'layout.margin-sides': slot('layout', { top: inches, right: inches, bottom: inches, left: inches }, someSet(['top', 'right', 'bottom', 'left'])),
  'layout.element-spacing': slot('layout', { notes: lineOrNull, quotations: lineOrNull, bibliography: lineOrNull, captions: lineOrNull }, someSet(['notes', 'quotations', 'bibliography', 'captions'])),
  'layout.page-sequences': slot('layout', { preliminary: oneOf('lower-roman', 'arabic', 'none'), restart: bool, titlePage: oneOf('counted-not-shown', 'shown') }),
  'matter.order': slot('front-matter', { order: matterParts, required: orNull(matterParts) }),
  'title-page.elements': slot('title-page', { elements: titleElements }),
  'chapters.new-page': slot('chapters', { required: bool }),
  'captions.position': slot('figures-tables', { tables: orNull(oneOf('above', 'below')), figures: orNull(oneOf('above', 'below')) }, someSet(['tables', 'figures'])),
  'length.words': slot('length', { max: orNull(positive), min: orNull(positive) }),
  'running-title.length': slot('length', { max: positive }),
  'abstract.words': slot('abstract-keywords', { max: positive }),
  'keywords.count': slot('abstract-keywords', { min: integer(0), max: positive }),
  'contributors.words': slot('contributors', { max: positive }),
  'anonymize': slot('anonymization', { required: bool }),
});

// When each slot applies, in one line the rules prompt gives the model with the slot, so that a
// requirement a slot describes is given that slot on every reading and not left as a plain rule.
export const SLOT_USES = Object.freeze({
  'quotes.primary': 'whether quotations take double or single quotation marks',
  'quotes.punctuation': 'whether commas and full stops go inside or outside closing quotation marks',
  'blockquote.threshold': 'how long a quotation must be (in words or lines) to be set off as a block quotation',
  'dash.ranges': 'whether number and date ranges take an en dash or a hyphen',
  'comma.serial': 'whether to use the serial (Oxford) comma',
  'ellipsis.form': 'how an ellipsis is typed',
  'spelling.variety': 'which variety of English spelling to use (American, British, British with -ize, Canadian, Australian), including when it is given by naming a dictionary of that variety',
  'numbers.spellout': 'below which number numbers are spelled out in words',
  'percent.form': 'how percentages are written',
  'centuries.form': 'whether centuries are written in words or figures',
  'headings.case': 'whether headings take title case or sentence case capitals',
  'headings.numbering': 'whether section headings are numbered (decimal: 1, 1.1) or not numbered',
  'titles.quotes': 'whether quotation marks may be used in chapter or article titles',
  'chapters.subtitle': 'whether a long chapter title is to be divided into a short main title and a subtitle (split true), for instance at a colon, or must not be (split false)',
  'chapters.label': 'a label line with the chapter\'s number set above each chapter title, such as "Chapter 3"; "example" copies the guidelines\' own form of the label exactly',
  'figures.numbering': 'whether figures are numbered by chapter (2.1, 2.2) or through the whole work',
  'figures.markers': 'the placement marker or call-out an author types in the text where a figure goes; "example" copies the guidelines\' own example of the marker exactly, such as a bracketed line with a figure number',
  'figures.files': 'whether figures must be supplied as separate image files rather than embedded in the text',
  'figures.callouts': 'whether every figure or table must be referred to in the text',
  'notes.kind': 'whether notes are footnotes or endnotes',
  'notes.restart': 'whether note numbers start again in each chapter or run through the whole work',
  'notes.titles': 'whether a note may be attached to a chapter title, a heading or an author\'s name',
  'references.repeated-author': 'whether a repeated author in a reference list is written in full each time or replaced by a dash',
  'citations.system': 'which citation system the text uses (notes and bibliography, author-date, MLA, APA, numbered, or another)',
  'layout.font': 'the font family or font size of the text',
  'layout.spacing': 'the line spacing of the text',
  'layout.margins': 'the page margins',
  'layout.page-numbers': 'where on the page the page numbers go (top or bottom, left, centre or right)',
  'layout.paper': 'the paper size of the pages (US Letter, 8.5 by 11 inches, or A4)',
  'layout.margin-sides': 'page margins that differ by side (a wider left margin for binding, say), in inches per side; a side the guidelines do not set is null. Margins the same on every side take "layout.margins"',
  'layout.element-spacing': 'the line spacing of particular elements rather than the running text: notes, block quotations, bibliography entries, captions (1 is single, 2 is double); an element the guidelines do not set is null',
  'layout.page-sequences': 'how the pages are numbered: the preliminary pages before the first chapter in lower-case roman numerals, in arabic numerals, or not at all; whether the arabic numbers start again at 1 on the first page of the first chapter (restart); whether the title page is counted but shows no number',
  'matter.order': 'the order the parts of the work must come in (title page, copyright page, approval page, abstract, dedication, acknowledgments, preface, contents, lists of tables and figures, body, appendix, bibliography, vita), as the parts named below in that order; "required" names the parts that must be there, or null',
  'title-page.elements': 'what the title page must state: the full title, the author\'s name, the submission statement, the degree, the program, the institution, the year, the month, the advisor',
  'chapters.new-page': 'whether each chapter or major section must begin on a new page',
  'captions.position': 'whether the caption or title of a table, and of a figure, goes above it or below it; a kind the guidelines do not set is null',
  'length.words': 'the most or fewest words allowed in the whole manuscript, chapter or article',
  'running-title.length': 'the most characters (letters and spaces) allowed in a running title or running head',
  'abstract.words': 'the most words allowed in an abstract',
  'keywords.count': 'how many keywords are asked for',
  'contributors.words': 'how long each note on a contributor (a contributor\'s biography in the notes on contributors) may be, in words',
  'anonymize': 'whether the manuscript must be anonymized for review',
});

const RULE_ID = /^[a-z0-9-]{1,64}$/;
export const MAX_RULES = 400;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const has = (object, key) => Object.hasOwn(object, key);
const fail = reason => ({ ok: false, reason });

const isPublicUrl = value => typeof value === 'string' && value.length <= 300 && /^https:\/\/[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$/u.test(value);
const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && isDateTime(`${value}T00:00:00Z`);

function cleanSource(source) {
  if (!isObject(source)) return fail('source');
  switch (source.kind) {
    case 'guidelines':
      if (!isText(source.quote, 12, 400)) return fail('source.quote');
      if (!Number.isInteger(source.doc) || source.doc < 0) return fail('source.doc');
      // A rule of a built-in set also says where its quotation was published and when it was read.
      if (source.url !== undefined && !isPublicUrl(source.url)) return fail('source.url');
      if (source.retrieved !== undefined && !isDay(source.retrieved)) return fail('source.retrieved');
      if (source.set !== undefined && !(typeof source.set === 'string' && RULE_ID.test(source.set))) return fail('source.set');
      return { ok: true, value: { kind: 'guidelines', quote: source.quote, doc: source.doc, ...(source.url !== undefined ? { url: source.url } : {}), ...(source.retrieved !== undefined ? { retrieved: source.retrieved } : {}), ...(source.set !== undefined ? { set: source.set } : {}) } };
    case 'manual':
      if (!isText(source.manual, 1, 80)) return fail('source.manual');
      if (!isText(source.section, 1, 80)) return fail('source.section');
      return { ok: true, value: { kind: 'manual', manual: source.manual, section: source.section } };
    case 'author':
      return { ok: true, value: { kind: 'author' } };
    default:
      return fail('source.kind');
  }
}

function cleanParams(slotId, params) {
  if (slotId === null) {
    if (params === undefined) return { ok: true, value: {} };
    if (!isObject(params) || Object.keys(params).length > 0) return fail('params: a rule without a slot has none');
    return { ok: true, value: {} };
  }
  if (!isObject(params)) return fail('params');
  const spec = SLOTS[slotId];
  const names = Object.keys(spec.params);
  const extra = Object.keys(params).find(name => !has(spec.params, name));
  if (extra !== undefined) return fail(`params: unknown ${JSON.stringify(extra)}`);
  const value = {};
  for (const name of names) {
    if (!has(params, name)) return fail(`params.${name}: missing`);
    if (!spec.params[name](params[name])) return fail(`params.${name}: expected ${spec.params[name].allowed}`);
    value[name] = params[name];
  }
  const crossField = spec.check ? spec.check(value) : null;
  return crossField ? fail(crossField) : { ok: true, value };
}

function checkRule(rule) {
  if (!isObject(rule)) return fail('rule');
  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) return fail('id');
  if (!CATEGORY_IDS.has(rule.category)) return fail('category');
  const slotId = rule.slot;
  if (slotId !== null && !(typeof slotId === 'string' && has(SLOTS, slotId))) return fail('slot');
  if (slotId !== null && SLOTS[slotId].category !== rule.category) return fail(`slot: belongs to ${SLOTS[slotId].category}`);
  if (!isText(rule.statement, 1, 500)) return fail('statement');
  if (!MODES.includes(rule.mode)) return fail('mode');
  if (rule.mode === 'fix' && (slotId === null || rule.category === 'other')) return fail('mode: fix needs a slot');
  const source = cleanSource(rule.source);
  if (!source.ok) return source;
  const params = cleanParams(slotId, rule.params);
  if (!params.ok) return params;
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') return fail('enabled');
  if (rule.conflict !== undefined && rule.conflict !== true) return fail('conflict');
  // Only rules with a setting can disagree with one another.
  if (rule.conflict === true && slotId === null) return fail('conflict: needs a slot');
  const clean = {
    id: rule.id,
    category: rule.category,
    slot: slotId,
    statement: rule.statement,
    mode: rule.mode,
    source: source.value,
    params: params.value,
    enabled: rule.enabled ?? true,
  };
  if (rule.conflict === true) clean.conflict = true;
  return { ok: true, rule: clean };
}

export function validateRule(rule) {
  try {
    return checkRule(rule);
  } catch {
    return fail('rule');
  }
}

function isDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHours = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinutes = match[10] === undefined ? 0 : Number(match[10]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// A sheet that began as a built-in set names it: its id, name, the pages it quotes and when they were read.
function cleanPreset(preset) {
  if (!isObject(preset)) return fail('preset');
  if (typeof preset.id !== 'string' || !RULE_ID.test(preset.id)) return fail('preset.id');
  if (!isText(preset.name, 1, 120)) return fail('preset.name');
  if (!Array.isArray(preset.sources) || preset.sources.length < 1 || preset.sources.length > 20 || !preset.sources.every(isPublicUrl)) return fail('preset.sources');
  if (!isDay(preset.retrieved)) return fail('preset.retrieved');
  return { ok: true, value: { id: preset.id, name: preset.name, sources: [...preset.sources], retrieved: preset.retrieved } };
}

const isManualField = value => value === null || isText(value, 1, 120);

function checkSheet(value) {
  if (!isObject(value)) return fail('sheet');
  if (value.version !== SHEET_VERSION) return fail('version');
  if (!DOC_TYPES.includes(value.docType)) return fail('docType');
  if (!isObject(value.manual)) return fail('manual');
  if (!isManualField(value.manual.id)) return fail('manual.id');
  if (!isManualField(value.manual.named)) return fail('manual.named');
  if (!Array.isArray(value.rules)) return fail('rules');
  if (value.rules.length > MAX_RULES) return fail(`rules: more than ${MAX_RULES}`);
  const rules = [];
  for (let index = 0; index < value.rules.length; index += 1) {
    const result = checkRule(value.rules[index]);
    if (!result.ok) return fail(`rules[${index}].${result.reason}`);
    rules.push(result.rule);
  }
  if (!Number.isInteger(value.dropped) || value.dropped < 0) return fail('dropped');
  if (!isDateTime(value.created)) return fail('created');
  const preset = value.preset === undefined ? null : cleanPreset(value.preset);
  if (preset && !preset.ok) return preset;
  return {
    ok: true,
    sheet: {
      version: SHEET_VERSION,
      docType: value.docType,
      manual: { id: value.manual.id, named: value.manual.named },
      rules,
      dropped: value.dropped,
      created: value.created,
      ...(preset ? { preset: preset.value } : {}),
    },
  };
}

export function validateSheet(value) {
  try {
    return checkSheet(value);
  } catch {
    return fail('sheet');
  }
}

export function newSheet(docType) {
  if (!DOC_TYPES.includes(docType)) throw new TypeError(`Unknown document type: ${docType}`);
  return {
    version: SHEET_VERSION,
    docType,
    manual: { id: null, named: null },
    rules: [],
    dropped: 0,
    created: new Date().toISOString(),
  };
}
