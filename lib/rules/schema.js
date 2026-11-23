// The rule sheet: the structured list of requirements read out of a publisher's guidelines.
// Pure data and validation; no DOM, no network. validateRule and validateSheet treat their input
// as untrusted (a model reply or an uploaded file): they never throw, never mutate it, and return
// a cleaned copy holding only known keys.

export const SHEET_VERSION = 1;
export const DOC_TYPES = Object.freeze(['article', 'monograph', 'edited-collection']);
export const MODES = Object.freeze(['fix', 'flag', 'supply']);

const ALL = DOC_TYPES;
const ARTICLE = ['article'];
const ARTICLE_COLLECTION = ['article', 'edited-collection'];
const BOOKS = ['monograph', 'edited-collection'];
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
  category('other', 'Other requirements', 'structure', ALL),
  category('abstract-keywords', 'Abstract and keywords', 'structure', ARTICLE_COLLECTION),
  category('title-page', 'Title page', 'structure', ARTICLE),
  category('anonymization', 'Anonymization', 'structure', ARTICLE),
  category('declarations', 'Declarations', 'structure', ARTICLE),
  category('front-matter', 'Front matter', 'structure', BOOKS),
  category('back-matter', 'Back matter', 'structure', BOOKS),
  category('index', 'Index', 'structure', BOOKS),
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
  'length.words': slot('length', { max: orNull(positive), min: orNull(positive) }),
  'running-title.length': slot('length', { max: positive }),
  'abstract.words': slot('abstract-keywords', { max: positive }),
  'keywords.count': slot('abstract-keywords', { min: integer(0), max: positive }),
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
  'length.words': 'the most or fewest words allowed in the whole manuscript, chapter or article',
  'running-title.length': 'the most characters (letters and spaces) allowed in a running title or running head',
  'abstract.words': 'the most words allowed in an abstract',
  'keywords.count': 'how many keywords are asked for',
  'anonymize': 'whether the manuscript must be anonymized for review',
});

const RULE_ID = /^[a-z0-9-]{1,64}$/;
export const MAX_RULES = 400;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const has = (object, key) => Object.hasOwn(object, key);
const fail = reason => ({ ok: false, reason });

function cleanSource(source) {
  if (!isObject(source)) return fail('source');
  switch (source.kind) {
    case 'guidelines':
      if (!isText(source.quote, 12, 400)) return fail('source.quote');
      if (!Number.isInteger(source.doc) || source.doc < 0) return fail('source.doc');
      return { ok: true, value: { kind: 'guidelines', quote: source.quote, doc: source.doc } };
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
  return {
    ok: true,
    sheet: {
      version: SHEET_VERSION,
      docType: value.docType,
      manual: { id: value.manual.id, named: value.manual.named },
      rules,
      dropped: value.dropped,
      created: value.created,
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
