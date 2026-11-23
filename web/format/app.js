// The Formatter page, steps 1 to 3: what is being submitted, the guidelines, and the review of the
// rule sheet read out of them. The functions exported at the top are pure, so tests load this module
// under Node; the page itself starts only where there is a document.

import { DOC_TYPES, MAX_RULES, SHEET_VERSION, newSheet, validateRule, validateSheet } from '../../lib/rules/schema.js';
import { extractRuleSheet } from '../../lib/rules/extract.js';
import { splitGuidelines } from '../../lib/rules/chunk.js';
import { normalizeForMatch } from '../../lib/rules/quote.js';
import { cleanPastedText, readGuidelines } from '../../lib/guidelines/read.js';
import { ApiError, createApi } from '../shared/api.js';
import { chooseModel, modelMenu } from '../shared/models.js';
import { createStore } from '../shared/store.js';
import { el, plainReason, renderAddRule, renderRules } from './rules-view.js';

const MAX_SHEET_FILE_CHARS = 2000000;
const NOT_A_SHEET = 'This is not a rule sheet file.';
const OTHER_VERSION = 'This rule sheet was made by a different version of the tool.';
const DAMAGED = 'This rule sheet file is damaged and cannot be used.';
const FULL = `A rule sheet can hold at most ${MAX_RULES} rules. Remove a rule before adding another.`;
const GROUP_LABELS = { style: 'spelling, punctuation and style', references: 'citations, references and notes', structure: 'structure, layout and other requirements' };
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

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
export function removeGuideline(guidelines, sheet, index) {
  const rest = guidelines.filter((_, i) => i !== index);
  if (!sheet) return { guidelines: rest, sheet };
  const rules = sheet.rules
    .filter(rule => !(rule.source.kind === 'guidelines' && rule.source.doc === index))
    .map(rule => (rule.source.kind === 'guidelines' && rule.source.doc > index ? { ...rule, source: { ...rule.source, doc: rule.source.doc - 1 } } : rule));
  return { guidelines: rest, sheet: { ...sheet, rules } };
}

const rulesFromGuideline = (sheet, index) => (sheet?.rules ?? []).filter(rule => rule.source.kind === 'guidelines' && rule.source.doc === index).length;

// The work saved in this browser, checked as untrusted: anything malformed is left out.
export function restoredState(saved) {
  const sheet = isObject(saved) ? validateSheet(saved.sheet) : { ok: false };
  const guidelines = isObject(saved) && Array.isArray(saved.guidelines)
    ? saved.guidelines.filter(entry => isObject(entry) && typeof entry.name === 'string' && typeof entry.text === 'string' && cleanPastedText(entry.text).ok)
      .map(entry => ({ name: entry.name, text: entry.text }))
    : [];
  const docType = sheet.ok ? sheet.sheet.docType : DOC_TYPES.includes(saved?.docType) ? saved.docType : null;
  return { docType, guidelines, sheet: sheet.ok ? sheet.sheet : null };
}

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const state = { docType: null, guidelines: [], sheet: null, failures: [], editingId: null, adding: false, running: null };
  let store = null;
  try {
    if (globalThis.indexedDB) store = createStore({ indexedDB: globalThis.indexedDB });
  } catch {}
  let restored = false;
  let saving = Promise.resolve();
  const queue = work => {
    saving = saving.then(work).catch(() => { $('storage-note').hidden = false; });
    return saving;
  };
  // Saves the work so far (never the files themselves); before the saved copy is read back, nothing
  // is written, so an early save cannot overwrite it.
  const save = () => (store && restored ? queue(() => store.saveJob('format', structuredClone({ docType: state.docType, guidelines: state.guidelines, sheet: state.sheet }))) : saving);
  const api = createApi({ onLostSession: save });
  let extractors = null;
  // The PDF and Word readers (mammoth is large) load only when the first file is added.
  const loadExtractors = () => {
    extractors ??= import('../shared/guidelines-extractors.js').catch(error => { extractors = null; throw error; });
    return extractors;
  };

  const announce = message => { $('announcer').textContent = message; };
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
    $('no-sources').hidden = state.guidelines.length > 0;
    $('sources').replaceChildren(...state.guidelines.map((entry, index) => el('li', {},
      el('span', { className: 'source-name', text: entry.name }),
      el('span', { className: 'help', text: plural(entry.text.length, 'character', 'characters') }),
      el('button', { type: 'button', className: 'text-button danger', text: 'Remove', 'aria-label': `Remove ${entry.name}`, onclick: () => removeSource(index) }))));
    renderSheet();
  }

  function renderSheet() {
    const sheet = state.sheet;
    $('sheet-work').inert = state.running !== null;
    $('sheet-empty').hidden = Boolean(sheet?.rules.length);
    const notices = [];
    if (sheet?.manual.named) notices.push(el('p', { className: 'notice info', text: `Style manual named in the guidelines: ${sheet.manual.named}` }));
    if (sheet?.dropped > 0) {
      notices.push(el('p', { className: 'notice', text: sheet.dropped === 1
        ? '1 rule was left out because the tool could not find its wording in the guidelines.'
        : `${sheet.dropped.toLocaleString('en-US')} rules were left out because the tool could not find their wording in the guidelines.` }));
    }
    if (state.failures.length) {
      const groups = [...new Set(state.failures.map(failure => failure.group))].map(group => GROUP_LABELS[group] ?? group);
      notices.push(el('div', { className: 'notice' },
        el('p', { text: `Some parts of the guidelines could not be read, so rules may be missing about ${groups.join('; ')}. Try again, or add the missing rules yourself.` }),
        el('button', { type: 'button', className: 'button secondary', id: 'retry-button', text: 'Try again', onclick: () => void read({ retry: true }) })));
    }
    $('sheet-notices').replaceChildren(...notices);
    renderRules($('rules'), { sheet, editingId: state.editingId }, ruleActions);
    renderAddRule($('add-rule-area'), { docType: state.docType, open: state.adding }, addActions);
    $('download-sheet').disabled = !sheet;
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
    if (state.sheet && state.sheet.docType !== value) Object.assign(state, { sheet: null, failures: [], editingId: null });
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
    const count = rulesFromGuideline(state.sheet, index);
    if (count && !confirm(`Remove ${name}? The ${plural(count, 'rule', 'rules')} read from it will be removed from the rule sheet too.`)) return;
    ({ guidelines: state.guidelines, sheet: state.sheet } = removeGuideline(state.guidelines, state.sheet, index));
    state.failures = [];
    changed({ focusId: 'guidelines-title' });
    announce(`${name} removed.`);
  }

  const callRules = ({ model, docType, group, text, signal }) => api.post('/api/rules', { model, docType, group, text }, { signal })
    .catch(error => { throw error instanceof ApiError ? { code: error.code, retry: error.retry } : error; });
  const partKey = (group, text) => `${group}\u0000${text}`;

  async function read({ retry = false } = {}) {
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
    // A second try asks only for the parts that failed; the others answer at once with no rules.
    const failed = retry ? new Set(state.failures.map(({ group, doc, part }) => partKey(group, splitGuidelines(texts[doc])[part]))) : null;
    const calls = args => (failed && !failed.has(partKey(args.group, args.text)) ? Promise.resolve({ content: '{"rules":[]}' }) : callRules(args));
    const controller = new AbortController();
    state.running = controller;
    state.editingId = null;
    $('progress').value = 0;
    $('progress-text').textContent = 'Reading the guidelines…';
    render();
    try {
      const { sheet, failures } = await extractRuleSheet({
        docType: state.docType, model, guidelines: texts, callRules: calls, signal: controller.signal,
        onProgress: ({ done, total }) => {
          $('progress').max = total;
          $('progress').value = done;
          $('progress-text').textContent = `Reading the guidelines: ${done} of ${plural(total, 'part', 'parts')} done.`;
        },
      });
      state.sheet = retry && state.sheet ? mergeRetry(state.sheet, sheet) : sheet;
      state.failures = failures;
      announce(`Finished reading the guidelines. The rule sheet has ${plural(state.sheet.rules.length, 'rule', 'rules')}.`);
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
    if (state.sheet?.rules.length && !confirm('Loading a rule sheet replaces the rule sheet below. Continue?')) return;
    showErrors([]);
    Object.assign(state, { sheet: result.sheet, docType: result.sheet.docType, failures: [], editingId: null, adding: false });
    changed({ focusId: 'sheet-title' });
    announce(`Rule sheet loaded, with ${plural(result.sheet.rules.length, 'rule', 'rules')}.`);
  }

  function startOver() {
    if ((state.guidelines.length || state.sheet) && !confirm('Start over? This clears the guidelines and the rule sheet from this browser.')) return;
    state.running?.abort();
    Object.assign(state, { docType: null, guidelines: [], sheet: null, failures: [], editingId: null, adding: false });
    $('paste-box').value = '';
    showErrors([]);
    render();
    if (store) void queue(() => store.clearJob('format'));
    focus('doc-type-title');
    announce('Started over. Your work was cleared from this browser.');
  }

  // The account panel, as in the Lab's other tools: CUNY session and shared allowance.
  async function refreshStatus() {
    $('refresh-quota').disabled = true;
    try {
      await api.get('/api/session');
      $('session-status').textContent = 'Signed in with CUNY';
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
    } catch {
      $('session-status').textContent = 'The CUNY AI Lab service cannot be reached right now.';
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
    } catch {
      $('model-help').textContent = 'The list of models could not be loaded. Reload the page to try again.';
    }
  }

  for (const input of document.querySelectorAll('input[name="doc-type"]')) input.addEventListener('change', () => chooseDocType(input.value));
  $('guideline-files').addEventListener('change', async event => {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length) await addFiles(files);
  });
  $('add-pasted').addEventListener('click', addPasted);
  $('model-select').addEventListener('change', () => { $('model-select').dataset.chosen = 'true'; });
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
  $('refresh-quota').addEventListener('click', () => void refreshStatus());

  (async () => {
    render();
    try {
      if (store) Object.assign(state, restoredState(await store.loadJob('format')));
    } catch {}
    restored = true;
    render();
    void refreshStatus();
    void loadModels();
  })();
}
