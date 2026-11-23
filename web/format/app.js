// The Formatter page. This module holds steps 1 to 3 (what is being submitted, the guidelines, and
// the review of the rule sheet read out of them) and starts the page; steps 4 and 5 (the manuscript
// and its paragraph labels) are in manuscript-step.js and step 6 (format and download) in
// output-step.js. The functions exported at the top are pure, so tests load this module under Node;
// the page itself starts only where there is a document.

import { DOC_TYPES, GROUPS, MAX_RULES, SHEET_VERSION, newSheet, validateRule, validateSheet } from '../../lib/rules/schema.js';
import { SETTINGS_GROUP, extractRuleSheet } from '../../lib/rules/extract.js';
import { splitGuidelines } from '../../lib/rules/chunk.js';
import { normalizeForMatch } from '../../lib/rules/quote.js';
import { cleanPastedText, readGuidelines } from '../../lib/guidelines/read.js';
import { ApiError, createApi } from '../shared/api.js';
import { chooseModel, modelMenu } from '../shared/models.js';
import { createStore, watchExpiry } from '../shared/store.js';
import { el, plainReason, renderAddRule, renderRules } from './rules-view.js';
import { createManuscriptStep } from './manuscript-step.js';
import { createOutputStep } from './output-step.js';
import { presetSheet, presetsFor } from '../../lib/presets/index.js';

const MAX_SHEET_FILE_CHARS = 2000000;
const NOT_A_SHEET = 'This is not a rule sheet file.';
const OTHER_VERSION = 'This rule sheet was made by a different version of the tool.';
const DAMAGED = 'This rule sheet file is damaged and cannot be used.';
const FULL = `A rule sheet can hold at most ${MAX_RULES} rules. Remove a rule before adding another.`;
const GROUP_LABELS = { style: 'spelling, punctuation and style', references: 'citations, references and notes', structure: 'structure, layout and other requirements', [SETTINGS_GROUP]: 'settings the first reading did not find' };
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export const LOADED_NOTICE = 'This rule sheet was loaded from a file. Its quotations have not been checked against any guidelines.';
const NOT_CHANGED = 'The guidelines could not be read, so the rule sheet below was not changed.';

export function sheetToFile(sheet) {
  return { name: 'rule-sheet.json', text: `${JSON.stringify(sheet, null, 2)}\n` };
}

export function sheetFromFile(text) {
  if (typeof text !== 'string' || text.length > MAX_SHEET_FILE_CHARS) return { ok: false, message: NOT_A_SHEET };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: NOT_A_SHEET };
  }
  if (!isObject(data) || !Object.hasOwn(data, 'version')) return { ok: false, message: NOT_A_SHEET };
  if (data.version !== SHEET_VERSION) return { ok: false, message: OTHER_VERSION };
  const result = validateSheet(data);
  if (!result.ok || new Set(result.sheet.rules.map(rule => rule.id)).size !== result.sheet.rules.length) return { ok: false, message: DAMAGED };
  return { ok: true, sheet: result.sheet };
}

export const normaliseLineEndings = text => text.replace(/\r\n?/g, '\n');

// An unused id `<category>-<prefix><n>`: prefix 'a' for rules the author adds, '' for read ones.
function unusedId(rules, category, prefix) {
  const pattern = new RegExp(`^${category}-${prefix}(\\d+)$`);
  const taken = rules.map(rule => pattern.exec(rule.id)).filter(Boolean).map(match => Number(match[1]));
  return `${category}-${prefix}${Math.max(0, ...taken) + 1}`;
}

export function addAuthorRule(sheet, { category, statement, mode }) {
  if (sheet.rules.length >= MAX_RULES) return { ok: false, message: FULL };
  const result = validateRule({ id: unusedId(sheet.rules, category, 'a'), category, slot: null, statement, mode, source: { kind: 'author' }, params: {}, enabled: true });
  if (!result.ok) return { ok: false, message: plainReason(result.reason, null) };
  return { ok: true, sheet: { ...sheet, rules: [...sheet.rules, result.rule] } };
}

// Applies changes to one rule; a change that fails validateRule is not applied.
export function updateRule(sheet, id, changes) {
  const index = sheet.rules.findIndex(rule => rule.id === id);
  if (index === -1) return { ok: false, message: 'This rule is no longer in the rule sheet.' };
  const current = sheet.rules[index];
  const result = validateRule({ ...current, ...changes, params: { ...current.params, ...changes.params } });
  if (!result.ok) return { ok: false, message: plainReason(result.reason, current.slot) };
  const rules = [...sheet.rules];
  rules[index] = result.rule;
  return { ok: true, sheet: { ...sheet, rules } };
}

// Keeps one of a set of conflicting rules and removes the others in its slot.
export function keepRule(sheet, id) {
  const kept = sheet.rules.find(rule => rule.id === id);
  if (!kept || kept.slot === null) return sheet;
  const rules = sheet.rules
    .filter(rule => rule === kept || !(rule.conflict && rule.slot === kept.slot))
    .map(rule => {
      if (rule !== kept) return rule;
      const { conflict, ...rest } = rule;
      return rest;
    });
  return { ...sheet, rules };
}

const sameParams = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
const quoteKey = rule => (rule.source.kind === 'guidelines' ? normalizeForMatch(rule.source.quote).trim() : null);

// Adds the rules a second reading of the failed parts found to the sheet the author is reviewing:
// duplicates are skipped, a different value for a setting the sheet already has is marked as a
// conflict, and each added rule gets an unused id.
export function mergeRetry(sheet, extra) {
  const rules = sheet.rules.map(rule => ({ ...rule }));
  let dropped = sheet.dropped + extra.dropped;
  for (const rule of extra.rules) {
    const rivals = rule.slot === null ? [] : rules.filter(other => other.slot === rule.slot);
    const duplicate = rule.slot === null
      ? rules.some(other => other.slot === null && other.category === rule.category && other.mode === rule.mode && quoteKey(other) === quoteKey(rule))
      : rivals.some(other => sameParams(other.params, rule.params));
    if (duplicate) continue;
    if (rules.length >= MAX_RULES) { dropped += 1; continue; }
    for (const other of rivals) other.conflict = true;
    rules.push({ ...rule, ...(rivals.length ? { conflict: true } : {}), id: unusedId(rules, rule.category, '') });
  }
  return { ...sheet, manual: { ...sheet.manual, named: sheet.manual.named ?? extra.manual.named }, rules, dropped };
}

// Removes a guidelines document and the rules quoted from it, and renumbers the later documents.
// A sheet loaded from a file was not read from these documents, so it is left as it is.
export function removeGuideline(guidelines, sheet, index, { loadedFromFile = false } = {}) {
  const rest = guidelines.filter((_, i) => i !== index);
  if (!sheet || loadedFromFile) return { guidelines: rest, sheet };
  const rules = sheet.rules
    .filter(rule => !(rule.source.kind === 'guidelines' && rule.source.doc === index))
    .map(rule => (rule.source.kind === 'guidelines' && rule.source.doc > index ? { ...rule, source: { ...rule.source, doc: rule.source.doc - 1 } } : rule));
  return { guidelines: rest, sheet: { ...sheet, rules } };
}

const rulesFromGuideline = (sheet, index, loadedFromFile) => (loadedFromFile ? 0
  : (sheet?.rules ?? []).filter(rule => rule.source.kind === 'guidelines' && rule.source.doc === index).length);

// Loading a sheet from a file: its quotations point at documents this page does not have, so the
// guidelines on the page are cleared and the sheet is marked as loaded until the next reading.
export function loadedSheetState(sheet) {
  return { sheet, docType: sheet.docType, guidelines: [], failures: [], loadedFromFile: true };
}

// Built-in requirements. For a document type with a built-in set, step 2 offers it, chosen by
// default, beside the upload of another institution's requirements; using it reads nothing with a
// model. `source` is 'built-in' or 'upload'.
export const BUILT_IN_CHECK = 'These are the requirements as the Lab read them on the date shown. Check the current requirements before you deposit, and tell the CUNY AI Lab if something has changed.';

/** What step 2 offers: the built-in set for this document type, if any, and which choice is on. */
export function guidelineChoice(docType, source) {
  const preset = presetsFor(docType)[0] ?? null;
  return { preset, builtIn: Boolean(preset) && source !== 'upload' };
}

/** The page's state once a built-in set is used: its sheet, no guidelines, nothing read by a model. */
export function builtInState(id) {
  const sheet = presetSheet(id);
  if (!sheet) return null;
  return { sheet, docType: sheet.docType, guidelines: [], failures: [], loadedFromFile: false, source: 'built-in' };
}

/** A notice for a sheet that began as a built-in set: its name, where it comes from and when it was read. */
export function presetNotice(sheet) {
  if (!sheet?.preset) return null;
  return `This rule sheet is the built-in set “${sheet.preset.name}”, read by hand from the published requirements on ${sheet.preset.retrieved}. No model read anything. ${BUILT_IN_CHECK}`;
}

// The question to ask before loading a sheet, or null when nothing would be lost.
export function loadSheetQuestion({ sheet, guidelines }) {
  const replaces = Boolean(sheet?.rules.length);
  const clears = guidelines.length > 0;
  if (!replaces && !clears) return null;
  const what = [replaces && 'replaces the rule sheet below', clears && 'clears the guidelines you added, because its rules were not read from them'].filter(Boolean);
  return `Loading a rule sheet ${what.join(' and ')}. Continue?`;
}

// What a finished reading leaves on the page. A reading that found no rules and failed somewhere
// (allowance used up, service down, timeouts) keeps the sheet already there, edits and all; on a
// second try its failures are those of the parts tried again. Otherwise a second try is merged into
// the sheet, and a first reading replaces it (and with it any mark that it came from a file).
export function afterRead(current, result, { retry = false } = {}) {
  if (current.sheet && result.sheet.rules.length === 0 && result.failures.length > 0) {
    return { sheet: current.sheet, failures: retry ? result.failures : current.failures, loadedFromFile: current.loadedFromFile, kept: true };
  }
  const sheet = retry && current.sheet ? mergeRetry(current.sheet, result.sheet) : result.sheet;
  return { sheet, failures: result.failures, loadedFromFile: retry ? current.loadedFromFile : false, kept: false };
}

// What happened to a part that could not be read, in plain words: a sentence for each known kind
// of failure, else the Worker's own message, else a general sentence.
export function failureSentence({ code, message } = {}) {
  if (code === 'model_output_limit') return 'The model ran out of room on this part. Choose another model and try again.';
  if (typeof code === 'string' && code.includes('quota')) return 'Your model allowance is used up, so this part was not read.';
  if (['request_timeout', 'upstream_timeout', 'network_error'].includes(code)) return 'The model service did not answer in time. Try again in a minute.';
  if (code === 'invalid_model_response') return 'The model\'s answer could not be used. Try again, or choose another model.';
  if (typeof message === 'string' && message.trim()) return message.trim();
  return 'This part could not be read. Try again.';
}

const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1);

// One line per failed part: which rules, from which document (and part, when it has several), and why.
export function failureLines(failures, guidelines) {
  const parts = new Map();
  const partCount = doc => {
    if (!parts.has(doc)) parts.set(doc, guidelines[doc] ? splitGuidelines(guidelines[doc].text).length : 1);
    return parts.get(doc);
  };
  return failures.map(failure => {
    const name = guidelines[failure.doc]?.name ?? 'the guidelines';
    const count = partCount(failure.doc);
    const half = failure.half === 0 ? 'the first half of ' : failure.half === 1 ? 'the second half of ' : '';
    const where = count > 1 ? `${half}${name}, part ${failure.part + 1} of ${count}` : `${half}${name}`;
    return `${capitalise(GROUP_LABELS[failure.group] ?? 'some rules')} in ${where}: ${failureSentence(failure)}`;
  });
}

// The named manual, said to come from the file while the sheet is one loaded from a file, since
// nothing checked it against the guidelines then; null when the sheet names none.
export function manualNotice(sheet, { loadedFromFile }) {
  if (!sheet?.manual.named) return null;
  return `Style manual named in ${loadedFromFile ? 'the rule sheet file' : 'the guidelines'}: ${sheet.manual.named}`;
}

export const droppedNotice = n => (n === 1
  ? '1 rule was left out because the tool could not confirm it against the guidelines.'
  : `${n.toLocaleString('en-US')} rules were left out because the tool could not confirm them against the guidelines.`);

// The work to keep in this browser: never the files, and nothing about the page's controls.
export const savedState = state => ({ docType: state.docType, guidelines: state.guidelines, sheet: state.sheet, failures: state.failures, loadedFromFile: state.loadedFromFile, source: state.source ?? null });

const isFailure = (entry, guidelines) => isObject(entry) && (GROUPS.includes(entry.group) || entry.group === SETTINGS_GROUP)
  && Number.isInteger(entry.doc) && entry.doc >= 0 && entry.doc < guidelines.length
  && Number.isInteger(entry.part) && entry.part >= 0
  && (entry.half === undefined || entry.half === 0 || entry.half === 1)
  && typeof entry.code === 'string' && entry.code.length > 0 && entry.code.length <= 100;

// The work saved in this browser, checked as untrusted: anything malformed is left out.
export function restoredState(saved) {
  const sheet = isObject(saved) ? validateSheet(saved.sheet) : { ok: false };
  const guidelines = isObject(saved) && Array.isArray(saved.guidelines)
    ? saved.guidelines.filter(entry => isObject(entry) && typeof entry.name === 'string' && typeof entry.text === 'string' && cleanPastedText(entry.text).ok)
      .map(entry => ({ name: entry.name, text: entry.text }))
    : [];
  const docType = sheet.ok ? sheet.sheet.docType : DOC_TYPES.includes(saved?.docType) ? saved.docType : null;
  const failures = isObject(saved) && Array.isArray(saved.failures)
    ? saved.failures.filter(entry => isFailure(entry, guidelines)).map(({ group, doc, part, half, code, message }) => ({
      group, doc, part, ...(half === undefined ? {} : { half }), code, ...(typeof message === 'string' && message ? { message: message.slice(0, 300) } : {}),
    }))
    : [];
  const source = isObject(saved) && (saved.source === 'built-in' || saved.source === 'upload') ? saved.source : null;
  return { docType, guidelines, sheet: sheet.ok ? sheet.sheet : null, failures, loadedFromFile: sheet.ok && saved.loadedFromFile === true, source };
}

if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const state = { docType: null, guidelines: [], sheet: null, failures: [], loadedFromFile: false, source: null, editingId: null, adding: false, running: null };
  let store = null;
  try {
    if (globalThis.indexedDB) store = createStore({ indexedDB: globalThis.indexedDB });
  } catch {}
  let restored = false;
  // False once the person has chosen "Delete saved work now": nothing more is kept for this page.
  let keeping = true;
  let saving = Promise.resolve();
  let expiry = null;
  // A save moves the deletion time on. The watch looks again a little after the last of a burst of
  // saves (labelling saves after every passage), so its reads do not hold up the saves and clears.
  let lookTimer = null;
  const lookSoon = () => {
    clearTimeout(lookTimer);
    lookTimer = setTimeout(() => void expiry?.check(), 2000);
  };
  const queue = work => {
    saving = saving.then(work).then(lookSoon).catch(() => { $('storage-note').hidden = false; });
    return saving;
  };
  // Saves may be written once the saved copy has been read back (so an early save cannot overwrite
  // it) and while the person has not asked for nothing to be kept.
  const canSave = () => Boolean(store && restored && keeping);
  // Saves the work so far (never the files themselves).
  const save = () => (canSave() ? queue(() => store.saveJob('format', structuredClone(savedState(state)))) : saving);
  // sessionStorage records an automatic sign-in restart, so it happens at most once a minute; where
  // it cannot be read, the page never restarts sign-in on its own and offers the link instead.
  let sessionStore = null;
  try { sessionStore = globalThis.sessionStorage; } catch {}
  // A lost sign-in saves everything first: the rule sheet and the paragraph labels done so far.
  const client = createApi({ storage: sessionStore, onLostSession: () => Promise.all([save(), manuscript.save()]) });
  // Shown with every lost-session error the page did not answer by restarting sign-in itself (it did
  // so in the last minute, or sessionStorage is unavailable), so a person can always sign in again.
  // Same-origin only: the client resolves signInUrl to a /launch/ path on this site.
  const signInLink = url => el('a', { className: 'button secondary', href: url, text: 'Sign in with CUNY' });
  const offerSignIn = url => {
    $('signin-notice').replaceChildren(el('p', { text: 'Your CUNY session has ended, so nothing more can be sent to the models. Sign in again to go on.' }), el('p', {}, signInLink(url)));
    $('signin-notice').hidden = false;
    $('session-status').replaceChildren(signInLink(url));
  };
  const offered = error => {
    if (error instanceof ApiError && error.signInUrl) offerSignIn(error.signInUrl);
    throw error;
  };
  const api = {
    get: (path, options) => client.get(path, options).catch(offered),
    post: (path, body, options) => client.post(path, body, options).catch(offered),
  };
  // Steps 4 to 6 share the manuscript, held in memory only, and its labels.
  const job = { file: null, labels: null, labelling: null, formatting: false, output: null };
  let extractors = null;
  // The PDF and Word readers (mammoth is large) load only when the first file is added.
  const loadExtractors = () => {
    extractors ??= import('../shared/guidelines-extractors.js').catch(error => { extractors = null; throw error; });
    return extractors;
  };

  const announce = message => { $('announcer').textContent = message; };
  const showWorkNotice = message => {
    $('work-notice').textContent = message;
    $('work-notice').hidden = false;
  };
  const showErrors = messages => {
    $('error-banner').replaceChildren(...messages.map(message => el('p', { text: message })));
    $('error-banner').hidden = messages.length === 0;
  };
  const focus = id => $(id)?.focus();

  function changed({ focusId } = {}) {
    render();
    void save();
    if (focusId) focus(focusId);
  }

  function render() {
    for (const input of document.querySelectorAll('input[name="doc-type"]')) input.checked = input.value === state.docType;
    const running = state.running !== null;
    $('doc-type-controls').disabled = running;
    $('guidelines-controls').disabled = running;
    $('read-button').hidden = running;
    $('stop-button').hidden = !running;
    $('progress-area').hidden = !running;
    // A document type with built-in requirements offers them first; the upload stays one choice away.
    const choice = guidelineChoice(state.docType, state.source);
    $('built-in-controls').hidden = !choice.preset;
    $('built-in-controls').disabled = running;
    if (choice.preset) {
      $('built-in-name').textContent = `${choice.preset.name} (built in)`;
      $('built-in-about').replaceChildren(
        `Covers ${choice.preset.covers}. Read by hand on ${choice.preset.retrieved} from `,
        ...choice.preset.sources.flatMap((url, at) => [at ? (at === choice.preset.sources.length - 1 ? ' and ' : ', ') : '', el('a', { href: url, text: new URL(url).pathname.replace(/^\/+/u, '') || url, target: '_blank', rel: 'noopener' })]),
        `. No model is used and nothing is charged. ${BUILT_IN_CHECK}`);
      for (const input of document.querySelectorAll('input[name="guideline-source"]')) input.checked = input.value === (choice.builtIn ? 'built-in' : 'upload');
    }
    $('guidelines-controls').hidden = choice.builtIn;
    $('read-button').textContent = choice.builtIn ? 'Use these requirements' : 'Read the guidelines';
    $('no-sources').hidden = state.guidelines.length > 0;
    $('sources').replaceChildren(...state.guidelines.map((entry, index) => el('li', {},
      el('span', { className: 'source-name', text: entry.name }),
      el('span', { className: 'help', text: plural(entry.text.length, 'character', 'characters') }),
      el('button', { type: 'button', className: 'text-button danger', text: 'Remove', 'aria-label': `Remove ${entry.name}`, onclick: () => removeSource(index) }))));
    renderSheet();
    manuscript.render();
    output.render();
  }

  function renderSheet() {
    const sheet = state.sheet;
    $('sheet-work').inert = state.running !== null;
    $('sheet-empty').hidden = Boolean(sheet?.rules.length);
    const notices = [];
    if (sheet && state.loadedFromFile) notices.push(el('p', { className: 'notice', id: 'loaded-notice', text: LOADED_NOTICE }));
    const fromPreset = presetNotice(sheet);
    if (fromPreset) notices.push(el('p', { className: 'notice info', id: 'preset-notice', text: fromPreset }));
    const manual = manualNotice(sheet, state);
    if (manual) notices.push(el('p', { className: 'notice info', text: manual }));
    if (sheet?.dropped > 0) notices.push(el('p', { className: 'notice', id: 'dropped-notice', text: droppedNotice(sheet.dropped) }));
    if (state.failures.length) {
      const groups = [...new Set(state.failures.map(failure => failure.group))].map(group => GROUP_LABELS[group] ?? group);
      notices.push(el('div', { className: 'notice', id: 'failure-notice' },
        el('p', { text: `Some parts of the guidelines could not be read, so rules may be missing about ${groups.join('; ')}. Try again, or add the missing rules yourself.` }),
        el('ul', { className: 'failure-list' }, ...failureLines(state.failures, state.guidelines).map(line => el('li', { text: line }))),
        el('button', { type: 'button', className: 'button secondary', id: 'retry-button', text: 'Try again', onclick: () => void read({ retry: true }) })));
    }
    $('sheet-notices').replaceChildren(...notices);
    renderRules($('rules'), { sheet, editingId: state.editingId }, ruleActions);
    renderAddRule($('add-rule-area'), { docType: state.docType, open: state.adding }, addActions);
    $('download-sheet').disabled = !sheet;
    output.render();
  }

  // Applies a sheet change; `quiet` leaves the page as the control already shows it, so focus stays.
  function apply(result, { quiet = false, focusId } = {}) {
    if (!result.ok) { showErrors([result.message]); renderSheet(); return false; }
    state.sheet = result.sheet;
    if (quiet) void save();
    else changed({ focusId });
    return true;
  }
  const ruleActions = {
    toggle(id, on) { if (apply(updateRule(state.sheet, id, { enabled: on }), { quiet: true })) announce(on ? 'Rule switched on.' : 'Rule switched off.'); },
    setMode(id, mode) { apply(updateRule(state.sheet, id, { mode }), { quiet: true }); },
    startEdit(id) { state.editingId = id; changed({ focusId: `edit-${id}-statement` }); },
    cancelEdit(id) { state.editingId = null; changed({ focusId: `rule-${id}-edit` }); },
    saveEdit(id, changes) {
      const result = updateRule(state.sheet, id, changes);
      if (!result.ok) return result.message;
      state.editingId = null;
      apply(result, { focusId: `rule-${id}-edit` });
      announce('Rule saved.');
      return null;
    },
    remove(id) {
      if (state.editingId === id) state.editingId = null;
      apply({ ok: true, sheet: { ...state.sheet, rules: state.sheet.rules.filter(rule => rule.id !== id) } }, { focusId: 'sheet-title' });
      announce('Rule removed.');
    },
    keep(id) { apply({ ok: true, sheet: keepRule(state.sheet, id) }, { focusId: 'sheet-title' }); announce('Rule kept. The others were removed.'); },
  };
  const addActions = {
    open() {
      if (!state.docType) { showErrors(['Choose what you are submitting first.']); focus('doc-type-title'); return; }
      state.adding = true;
      renderSheet();
    },
    close() { state.adding = false; changed({ focusId: 'add-rule-button' }); },
    add(rule) {
      const result = addAuthorRule(state.sheet ?? newSheet(state.docType), rule);
      if (!result.ok) return result.message;
      state.adding = false;
      apply(result, { focusId: 'add-rule-button' });
      announce('Rule added.');
      return null;
    },
  };

  function chooseDocType(value) {
    if (value === state.docType) return;
    if (state.sheet?.rules.length && state.sheet.docType !== value
      && !confirm('Changing what you are submitting clears the rule sheet below. Continue?')) { render(); return; }
    state.docType = value;
    if (state.sheet && state.sheet.docType !== value) Object.assign(state, { sheet: null, failures: [], loadedFromFile: false, editingId: null });
    changed();
  }

  // Every text, from a file or pasted, has its line endings normalised and must pass the length checks.
  function addGuideline(name, text) {
    const checked = cleanPastedText(normaliseLineEndings(text));
    if (!checked.ok) return checked.message;
    state.guidelines = [...state.guidelines, { name, text: checked.text }];
    state.failures = [];
    return null;
  }

  async function addFiles(files) {
    showErrors([]);
    let reader;
    try {
      reader = await loadExtractors();
    } catch {
      showErrors(['The file reader could not be loaded. Reload the page, or paste the guidelines as text.']);
      return;
    }
    const errors = [];
    for (const file of files) {
      announce(`Reading ${file.name}…`);
      // Fresh bytes for each reading: the PDF reader takes over the buffer it is given.
      const bytes = await file.arrayBuffer().then(buffer => new Uint8Array(buffer), () => null);
      const result = bytes ? await readGuidelines({ name: file.name, bytes }, reader) : { ok: false, message: 'This file could not be opened. Try saving it again, or paste the guidelines as text.' };
      const error = result.ok ? addGuideline(file.name, result.text) : result.message;
      if (error) errors.push(`${file.name}: ${error}`);
    }
    showErrors(errors);
    changed();
    announce(errors.length ? 'Some guidelines could not be added.' : `${plural(files.length, 'file', 'files')} added.`);
  }

  function addPasted() {
    let n = 1;
    while (state.guidelines.some(entry => entry.name === `Pasted text ${n}`)) n += 1;
    const error = addGuideline(`Pasted text ${n}`, $('paste-box').value);
    showErrors(error ? [error] : []);
    if (error) return;
    $('paste-box').value = '';
    changed();
    announce('Pasted text added.');
  }

  function removeSource(index) {
    const { name } = state.guidelines[index];
    const count = rulesFromGuideline(state.sheet, index, state.loadedFromFile);
    if (count && !confirm(`Remove ${name}? The ${plural(count, 'rule', 'rules')} read from it will be removed from the rule sheet too.`)) return;
    ({ guidelines: state.guidelines, sheet: state.sheet } = removeGuideline(state.guidelines, state.sheet, index, { loadedFromFile: state.loadedFromFile }));
    state.failures = [];
    changed({ focusId: 'guidelines-title' });
    announce(`${name} removed.`);
  }

  // A refusal reaches extractRuleSheet as plain data: its code, whether and when to ask again, and the Worker's message.
  const refusal = error => { throw error instanceof ApiError ? { code: error.code, retry: error.retry, status: error.status, retryAfter: error.retryAfter, message: error.message } : error; };
  const callRules = ({ model, docType, group, text, signal }) => api.post('/api/rules', { model, docType, group, text }, { signal }).catch(refusal);
  const callSettings = ({ model, docType, slots, text, unreported, signal }) => api.post('/api/settings', { model, docType, slots, text, ...(unreported ? { unreported } : {}) }, { signal }).catch(refusal);

  // Uses the built-in requirements: their rule sheet, as shipped, with no model call.
  function useBuiltIn() {
    const { preset } = guidelineChoice(state.docType, state.source);
    if (!preset) return;
    if (state.sheet?.rules.length && !confirm('Using the built-in requirements replaces the rule sheet below, with any changes you made. Continue?')) return;
    const next = builtInState(preset.id);
    if (!next) { showErrors(['The built-in requirements could not be loaded. Reload the page.']); return; }
    showErrors([]);
    Object.assign(state, next, { editingId: null, adding: false });
    changed({ focusId: 'sheet-title' });
    announce(`The built-in requirements are in the rule sheet: ${plural(state.sheet.rules.length, 'rule', 'rules')}. No model was used.`);
  }

  function chooseSource(value) {
    state.source = value === 'upload' ? 'upload' : 'built-in';
    changed();
  }

  async function read({ retry = false } = {}) {
    if (!retry && guidelineChoice(state.docType, state.source).builtIn) { useBuiltIn(); return; }
    const model = $('model-select').value;
    const problems = [
      !state.docType && 'Choose what you are submitting first.',
      !state.guidelines.length && 'Add the guidelines first: upload a file or paste the text.',
      !model && 'No model is available right now. Reload the page to try again.',
    ].filter(Boolean);
    showErrors(problems);
    if (problems.length) return;
    if (!retry && state.sheet?.rules.length && !confirm('Reading the guidelines again replaces the rule sheet below, with any changes you made. Continue?')) return;
    const texts = state.guidelines.map(entry => entry.text);
    // A second try asks only for the parts (or halves of parts) that failed.
    const only = retry ? state.failures.map(({ group, doc, part, half }) => ({ group, doc, part, ...(half === undefined ? {} : { half }) })) : undefined;
    const controller = new AbortController();
    state.running = controller;
    state.editingId = null;
    $('progress').value = 0;
    $('progress-text').textContent = 'Reading the guidelines…';
    render();
    try {
      const result = await extractRuleSheet({
        docType: state.docType, model, guidelines: texts, callRules, callSettings, only, signal: controller.signal,
        // A second try does not ask again for settings the sheet already has.
        known: retry ? [...new Set((state.sheet?.rules ?? []).map(rule => rule.slot).filter(Boolean))] : [],
        onProgress: ({ done, total }) => {
          $('progress').max = total;
          $('progress').value = done;
          $('progress-text').textContent = `Reading the guidelines: ${done} of ${plural(total, 'call', 'calls')} done.`;
        },
      });
      const next = afterRead(state, result, { retry });
      Object.assign(state, { sheet: next.sheet, failures: next.failures, loadedFromFile: next.loadedFromFile });
      if (next.kept) {
        // The sheet on the page is left as it was, so the copy kept in this browser stays the same.
        // The error banner is an alert, so it is announced.
        showErrors([NOT_CHANGED, ...new Set(result.failures.map(failureSentence))]);
      } else {
        announce(`Finished reading the guidelines. The rule sheet has ${plural(state.sheet.rules.length, 'rule', 'rules')}.`);
      }
    } catch {
      if (controller.signal.aborted) announce('Stopped. The rule sheet was not changed.');
      else showErrors(['The guidelines could not be read. Try again.']);
    } finally {
      state.running = null;
      changed({ focusId: 'sheet-title' });
      void refreshStatus();
    }
  }

  function downloadSheet() {
    if (!state.sheet) return;
    const file = sheetToFile(state.sheet);
    const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
    const link = el('a', { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('The rule sheet was downloaded.');
  }

  async function loadSheet(file) {
    // Characters take up to 4 bytes, so a file larger than this cannot be a rule sheet.
    const text = file.size > MAX_SHEET_FILE_CHARS * 4 ? null : await file.text().catch(() => null);
    const result = text === null ? { ok: false, message: NOT_A_SHEET } : sheetFromFile(text);
    if (!result.ok) { showErrors([result.message]); return; }
    const question = loadSheetQuestion(state);
    if (question && !confirm(question)) return;
    showErrors([]);
    Object.assign(state, loadedSheetState(result.sheet), { editingId: null, adding: false });
    changed({ focusId: 'sheet-title' });
    announce(`Rule sheet loaded, with ${plural(result.sheet.rules.length, 'rule', 'rules')}. ${LOADED_NOTICE}`);
  }

  // Clears the work from the page and from this browser.
  function clearWork() {
    state.running?.abort();
    manuscript.startOver();
    Object.assign(state, { docType: null, guidelines: [], sheet: null, failures: [], loadedFromFile: false, source: null, editingId: null, adding: false });
    $('paste-box').value = '';
    showErrors([]);
    render();
    if (store) void queue(() => store.clearAll());
  }

  function startOver() {
    if ((state.guidelines.length || state.sheet || job.labels || job.file) && !confirm('Start over? This clears the guidelines, the rule sheet, the manuscript and its paragraph labels and your corrections from this page and this browser.')) return;
    clearWork();
    $('work-notice').hidden = true;
    focus('doc-type-title');
    announce('Started over. Your work was cleared from this browser.');
  }

  // 24 hours after the last change, the saved work is deleted from this browser, also while the page
  // stays open; the work on the page goes with it, so a later change cannot write it back.
  function expired() {
    clearWork();
    const message = 'Your work was deleted from this page and this browser because 24 hours passed since your last change. Start again from step 1.';
    showWorkNotice(message);
    announce(message);
  }

  // Deletes what this browser keeps and keeps nothing more while this page is open. The work on the
  // page stays until the page is closed or reloaded.
  async function deleteSaved() {
    if (!confirm('Delete the work kept in this browser now? The work on this page stays until you close or reload it, but nothing more is kept in this browser while it is open.')) return;
    keeping = false;
    expiry?.stop();
    $('delete-saved').disabled = true;
    if (store) await queue(() => store.clearAll());
    const message = 'The work kept in this browser was deleted, and nothing more is kept in it while this page is open. The work on this page stays until you close or reload it. If the page has to send you to sign in again, that work is lost.';
    showWorkNotice(message);
    announce(message);
  }

  // The account panel, as in the Lab's other tools: CUNY session and shared allowance.
  async function refreshStatus() {
    $('refresh-quota').disabled = true;
    try {
      await api.get('/api/session');
      $('session-status').textContent = 'Signed in with CUNY';
      $('signin-notice').hidden = true;
      try {
        const quota = await api.get('/api/quota');
        if (![quota.estimated_remaining, quota.estimated_used, quota.limit, quota.used_percent].every(Number.isFinite)) throw new Error('quota');
        const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 1000000);
        const details = [`${money(quota.estimated_used)} used of ${money(quota.limit)}.`];
        if (Number.isFinite(quota.window_seconds)) details.push(`The allowance covers ${Math.round(quota.window_seconds / 86400)} days.`);
        if (Number.isFinite(quota.calculated_at)) details.push(`Estimated ${new Date(quota.calculated_at * 1000).toLocaleString()}; updates may be delayed.`);
        $('quota-content').replaceChildren(
          el('p', { className: 'quota-number', text: `${money(quota.estimated_remaining)} remaining` }),
          el('meter', { min: 0, max: 100, value: quota.used_percent, 'aria-label': `${quota.used_percent}% of your shared allowance used` }),
          el('p', { className: 'help', text: details.join(' ') }));
      } catch (error) {
        $('quota-content').replaceChildren(el('p', { className: 'help', text: 'Your usage estimate is unavailable right now. You can still read the guidelines.' }),
          ...(error instanceof ApiError && error.requestId ? [el('p', { className: 'help', text: `Support reference: ${error.requestId}` })] : []));
      }
    } catch (error) {
      if (error instanceof ApiError && error.signInUrl) $('session-status').replaceChildren(signInLink(error.signInUrl));
      else $('session-status').textContent = 'The CUNY AI Lab service cannot be reached right now.';
      $('quota-content').replaceChildren();
    } finally {
      $('refresh-quota').disabled = false;
    }
  }

  async function loadModels() {
    const select = $('model-select');
    try {
      const menu = modelMenu(await api.get('/api/catalog'));
      const chosen = select.dataset.chosen === 'true' ? select.value : '';
      select.replaceChildren(...menu.map(entry => el('option', { value: entry.id, text: entry.label })));
      select.value = chooseModel(chosen, menu);
      $('model-help').textContent = menu.length ? 'Reading the guidelines uses your shared CUNY AI Lab allowance.' : 'No model is available right now. Reload the page later.';
      const roles = $('roles-model-select');
      const rolesChosen = roles.dataset.chosen === 'true' ? roles.value : '';
      roles.replaceChildren(...menu.map(entry => el('option', { value: entry.id, text: entry.label })));
      roles.value = chooseModel(rolesChosen, menu);
    } catch {
      $('model-help').textContent = 'The list of models could not be loaded. Reload the page to try again.';
    }
  }

  for (const input of document.querySelectorAll('input[name="doc-type"]')) input.addEventListener('change', () => chooseDocType(input.value));
  for (const input of document.querySelectorAll('input[name="guideline-source"]')) input.addEventListener('change', () => chooseSource(input.value));
  $('guideline-files').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) await addFiles(files);
  });
  $('add-pasted').addEventListener('click', addPasted);
  $('model-select').addEventListener('change', () => { $('model-select').dataset.chosen = 'true'; });
  $('roles-model-select').addEventListener('change', () => { $('roles-model-select').dataset.chosen = 'true'; });
  $('read-button').addEventListener('click', () => void read());
  $('stop-button').addEventListener('click', () => state.running?.abort());
  $('download-sheet').addEventListener('click', downloadSheet);
  $('load-sheet').addEventListener('click', () => $('sheet-file').click());
  $('sheet-file').addEventListener('change', async event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) await loadSheet(file);
  });
  $('start-over').addEventListener('click', startOver);
  $('delete-saved').addEventListener('click', () => void deleteSaved());
  $('refresh-quota').addEventListener('click', () => void refreshStatus());

  const stepContext = {
    $, api, store, queue, job, state, announce, showErrors, canSave,
    changed: ({ focusId } = {}) => { render(); if (focusId) focus(focusId); },
    refreshStatus: () => refreshStatus(),
    roles: () => manuscript.roles(),
    renderOutput: () => output.render(),
  };
  const manuscript = createManuscriptStep(stepContext);
  const output = createOutputStep(stepContext);

  (async () => {
    render();
    try {
      if (store) Object.assign(state, restoredState(await store.loadJob('format')));
    } catch {}
    await manuscript.restore();
    restored = true;
    if (store) {
      expiry = watchExpiry({ store, onExpired: expired, busy: () => Boolean(state.running || job.labelling || job.formatting) });
      // Timers are late or do not run while a computer sleeps, so look again when the page comes back.
      const look = () => { if (document.visibilityState !== 'hidden') void expiry.check(); };
      document.addEventListener('visibilitychange', look);
      globalThis.addEventListener('focus', look);
      globalThis.addEventListener('pageshow', look);
      void expiry.check();
    }
    render();
    void refreshStatus();
    void loadModels();
  })();
}
