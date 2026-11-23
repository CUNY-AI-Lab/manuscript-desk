// The Index Builder page: the term list (loaded, pasted, or proposed from the manuscript and edited
// here), the proofs read and matched in a Web Worker with no model, the three optional model
// helpers (pages the index does not cover, ambiguous hits, subentries), and the index set to the
// press's conventions and downloaded. The decisions are pure functions in state.js and lib/index/;
// this module draws them. Every text from a file or a model is set with textContent (through el).

import { readDocx } from '../../lib/docx/read.js';
import { validateDocx } from '../../lib/docx/validate.js';
import { pageNumbering } from '../../lib/index/indexer.js';
import { headingOf, newEntry } from '../../lib/index/termlist.js';
import { KIND_LABELS, applyExclusions, buildWindows, findMatter, firstPageCut, parseManualRanges } from '../../lib/index/matter.js';
import { judgePlan, runJudge } from '../../lib/index/judge.js';
import { buildTermPassages, countAndDrop, leftOutParagraphs, mergeProposals, proposeTerms } from '../../lib/index/terms.js';
import { formatIndex, indexDocx } from '../../lib/index/format.js';
import { ApiError, createApi } from '../shared/api.js';
import { chooseModel, modelMenu } from '../shared/models.js';
import { createStore, watchExpiry } from '../shared/store.js';
import { SAVED_KEY as FORMATTER_LABELS } from '../format/manuscript-state.js';
import { el } from '../format/rules-view.js';
import { renderTermEditor, PAGE_SIZE } from './terms-view.js';
import {
  DEFAULT_SETTINGS, SAVED_KEY, STORE_NAME, addEntries, editEntry, entriesFromText, indexEntries, mergeEntries, restoredState,
  savedState, setStatus, settingsFromSheet, termListFile, termsPlan, workingList,
} from './state.js';

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const MAX_LIST_FILE_CHARS = 2000000;

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// --- The PDF worker ---

function createReader() {
  let worker = null;
  let lastId = 0;
  const pending = new Map();
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./index-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data }) => {
      const job = pending.get(data?.id);
      if (!job) return;
      if (data.type === 'progress') { job.onProgress?.(data.done, data.total); return; }
      pending.delete(data.id);
      if (data.type === 'error') job.reject(Object.assign(new Error(data.message), { name: data.name }));
      else job.resolve(data);
    });
    worker.addEventListener('error', () => {
      for (const job of pending.values()) job.reject(new Error('The PDF reader stopped. Reload the page and try again.'));
      pending.clear();
      worker.terminate();
      worker = null;
    });
    return worker;
  };
  const ask = (message, transfer = [], onProgress) => new Promise((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, { resolve, reject, onProgress });
    try { start().postMessage({ id, ...message }, transfer); } catch (error) { pending.delete(id); reject(error); }
  });
  return {
    read: (pdf, onProgress) => ask({ type: 'read', pdf }, [pdf], onProgress),
    match: message => ask({ type: 'match', ...message }),
  };
}

function friendlyPdfError(error) {
  switch (error?.name) {
    case 'PasswordException': return 'This PDF is password-protected. Remove the password and try again.';
    case 'InvalidPDFException': return 'This file is not a readable PDF. Export the book as a PDF again and retry.';
    case 'NoTextError': return 'This PDF has no selectable text, so it is probably a scan. Run OCR on it first, then try again.';
    default: return `This PDF could not be read (${error?.message || error}).`;
  }
}

if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const state = {
    entries: [], settings: { ...DEFAULT_SETTINGS }, proposing: null, pdf: null, ranges: [], manualRanges: '',
    decisions: {}, overrides: {}, appliedJudge: {}, assignments: {}, appliedSorting: {},
    running: null,
  };
  // Held in memory only: the manuscript's paragraphs, the PDF's page texts, the match.
  const job = { manuscript: null, texts: null, labels: null, match: null, failures: { propose: [], ranges: [], judge: [], sort: [] }, view: { status: 'all', kind: 'all', search: '', limit: PAGE_SIZE, mergeFrom: null } };
  const reader = createReader();
  let store = null;
  try { if (globalThis.indexedDB) store = createStore({ indexedDB: globalThis.indexedDB, name: STORE_NAME }); } catch {}
  let formatterStore = null;
  try { if (globalThis.indexedDB) formatterStore = createStore({ indexedDB: globalThis.indexedDB }); } catch {}
  let restored = false;
  let keeping = true;
  let saving = Promise.resolve();
  let expiry = null;
  let lookTimer = null;
  const lookSoon = () => { clearTimeout(lookTimer); lookTimer = setTimeout(() => void expiry?.check(), 2000); };
  const queue = work => { saving = saving.then(work).then(lookSoon).catch(() => { $('storage-note').hidden = false; }); return saving; };
  const canSave = () => Boolean(store && restored && keeping);
  const save = () => (canSave() ? queue(() => store.saveJob(SAVED_KEY, structuredClone(savedState(state)))) : saving);
  let sessionStore = null;
  try { sessionStore = globalThis.sessionStorage; } catch {}
  const client = createApi({ storage: sessionStore, onLostSession: () => save() });
  const signInLink = url => el('a', { className: 'button secondary', href: url, text: 'Sign in with CUNY' });
  const offered = error => {
    if (error instanceof ApiError && error.signInUrl) {
      $('signin-notice').replaceChildren(el('p', { text: 'Your CUNY session has ended, so nothing more can be sent to the models. Sign in again to go on.' }), el('p', {}, signInLink(error.signInUrl)));
      $('signin-notice').hidden = false;
      $('session-status').replaceChildren(signInLink(error.signInUrl));
    }
    throw error;
  };
  const api = { get: (path, options) => client.get(path, options).catch(offered), post: (path, body, options) => client.post(path, body, options).catch(offered) };
  // A refusal reaches the runs as plain data, as in the Formatter.
  const refusal = error => { throw error instanceof ApiError ? { code: error.code, retry: error.retry, status: error.status, retryAfter: error.retryAfter, message: error.message } : error; };
  const callTerms = ({ model, passage, signal }) => api.post('/api/index/terms', { model, passage }, { signal }).catch(refusal);
  const callJudge = ({ model, task, text, signal }) => api.post('/api/index/judge', { model, task, text }, { signal }).catch(refusal);
  const callRanges = ({ model, pages, signal }) => api.post('/api/index/ranges', { model, pages }, { signal }).catch(refusal);

  const announce = message => { $('announcer').textContent = message; };
  const showErrors = messages => { $('error-banner').replaceChildren(...messages.map(message => el('p', { text: message }))); $('error-banner').hidden = messages.length === 0; };
  const showWorkNotice = message => { $('work-notice').textContent = message; $('work-notice').hidden = false; };
  const model = () => $('model-select').value;
  const changed = () => { render(); void save(); };
  const failureLine = failure => `${failure.message ?? failure.code}`;

  // --- Rendering ---

  function render() {
    const running = state.running !== null;
    renderTermEditor($('term-editor'), state.entries, job.view, {
      status: (ids, status) => { state.entries = setStatus(state.entries, ids, status); stale(); changed(); },
      edit: (id, changes) => { state.entries = editEntry(state.entries, id, changes); forget(id); stale(); changed(); },
      merge: (from, into) => { state.entries = mergeEntries(state.entries, from, into); job.view.mergeFrom = null; forget(from); forget(into); stale(); changed(); announce('Entries merged.'); },
      add: ({ heading, variants, section }) => {
        if (!heading.trim()) { showErrors(['Type a heading for the new entry.']); return; }
        const taken = new Set(state.entries.map(entry => entry.id));
        const added = addEntries(state.entries, [newEntry({ section, text: [heading, ...(variants.length ? [`(${variants.join(', ')})`] : [])].join(' '), taken, status: 'accepted' })]);
        state.entries = added.list;
        stale();
        changed();
        announce(added.added ? 'Entry added.' : 'That entry is already in the list.');
      },
      view: change => { Object.assign(job.view, change); render(); },
    });
    $('download-list').disabled = !workingList(state.entries).length;
    $('propose-button').disabled = running || !job.manuscript || !model();
    $('propose-stop').hidden = state.running?.kind !== 'propose';
    $('build-button').disabled = running || !job.texts || !workingList(state.entries).length;
    $('ranges-button').disabled = running || !job.texts || !model();
    $('ranges-stop').hidden = state.running?.kind !== 'ranges';
    $('judge-stop').hidden = state.running?.kind !== 'judge';
    $('sort-stop').hidden = state.running?.kind !== 'sort';
    for (const id of ['page-one', 'match-case', 'manual-ranges', 'pdf-file', 'manuscript-file', 'load-list', 'add-pasted']) $(id).disabled = running;
    $('page-one').value = state.settings.pageOne;
    $('match-case').checked = state.settings.matchCase;
    $('manual-ranges').value = state.manualRanges;
    $('layout-select').value = state.settings.layout;
    $('style-select').value = state.settings.style;
    $('sorting-select').value = state.settings.sorting;
    $('collapse').checked = state.settings.collapse;
    renderManuscript();
    renderRanges();
    renderJudge();
    renderSort();
    renderOutput();
  }

  function renderManuscript() {
    const notices = [];
    if (job.manuscript) {
      const plan = termsPlan(job.manuscript.paragraphs, job.manuscript.left);
      const answered = state.proposing?.hash === job.manuscript.hash ? Object.keys(state.proposing.answered).length : 0;
      $('manuscript-status').textContent = `${job.manuscript.name}: ${plan.text} Bibliographies found ${job.manuscript.by === 'roles' ? 'by the Formatter’s paragraph labels' : 'by their headings'}.${answered ? ` ${plural(answered, 'passage was', 'passages were')} answered before and will not be asked again.` : ''}`;
    } else if (state.proposing) {
      $('manuscript-status').textContent = `Proposals from ${state.proposing.name} are kept from before. Choose the same file to go on where it stopped.`;
    } else $('manuscript-status').textContent = '';
    if (job.failures.propose.length) {
      notices.push(el('div', { className: 'notice error' }, el('p', { text: `${plural(job.failures.propose.length, 'passage', 'passages')} could not be read: ${[...new Set(job.failures.propose.map(failureLine))].join(' ')}` }),
        el('button', { type: 'button', className: 'button secondary', text: 'Try again', onclick: () => void propose({ only: job.failures.propose.map(failure => failure.key) }) })));
    }
    $('propose-notices').replaceChildren(...notices);
  }

  function renderRanges() {
    const pageCount = job.texts?.length ?? 0;
    const manual = state.manualRanges.trim() ? parseManualRanges(state.manualRanges, pageCount || Infinity) : [];
    $('manual-ranges-help').textContent = manual === null ? `Write PDF page numbers from 1 to ${pageCount || 'the last'}, as 1-12, 280-300.` : '';
    if (job.texts) {
      const windows = buildWindows(job.texts.map((text, at) => ({ text, label: job.labels[at] }))).length;
      $('ranges-button').textContent = `Find these pages with a model (${plural(windows, 'call', 'calls')})`;
    }
    const children = [];
    if (state.ranges.length) {
      children.push(el('p', { className: 'help', text: 'Proposed by the model. Tick a range to leave its pages out of the index.' }));
      children.push(el('ul', { className: 'review-list' }, ...state.ranges.map((range, at) => el('li', { className: 'review-item' },
        el('label', { className: 'check' },
          el('input', { type: 'checkbox', checked: range.on, onchange: event => { state.ranges[at] = { ...range, on: event.target.checked }; stale(); changed(); } }),
          `${KIND_LABELS[range.kind] ?? range.kind}: PDF pages ${range.first}${range.last > range.first ? `–${range.last}` : ''}${job.labels ? ` (printed ${job.labels[range.first - 1] || range.first}${range.last > range.first ? `–${job.labels[range.last - 1] || range.last}` : ''})` : ''}`),
        range.heading ? el('p', { className: 'review-excerpt', text: `Heading on its first page: “${range.heading}”${Number.isInteger(range.cut) ? '; the text above it stays in the index' : ''}` }) : null))));
    }
    if (job.failures.ranges.length) children.push(el('div', { className: 'notice error' }, el('p', { text: `${plural(job.failures.ranges.length, 'part', 'parts')} of the PDF could not be read: ${[...new Set(job.failures.ranges.map(failureLine))].join(' ')}` }), el('button', { type: 'button', className: 'button secondary', text: 'Try again', onclick: () => void findRanges({ only: job.failures.ranges.map(failure => failure.key) }) })));
    $('ranges-area').replaceChildren(...children);
  }

  // The entries the judge reads: those the matcher marked, with the reasons.
  const ambiguousEntries = () => (job.match ? workingList(state.entries).filter(entry => job.match.reasons.has(entry.id) && (job.match.byEntry.get(entry.id)?.hits.length ?? 0) > 0) : []);
  const subentryEntries = () => (job.match ? workingList(state.entries).filter(entry => entry.subentries.length && (job.match.byEntry.get(entry.id)?.hits.length ?? 0) > 0) : []);

  function renderJudge() {
    const entries = ambiguousEntries();
    const running = state.running !== null;
    const plan = job.match ? judgePlan('ambiguous', entries, job.match.byEntry, entry => ({ reasons: job.match.reasons.get(entry.id) })) : { hits: 0, calls: 0 };
    $('judge-button').disabled = running || !plan.calls || !model();
    $('judge-button').textContent = plan.calls ? `Judge ${plural(plan.hits, 'hit', 'hits')} of ${plural(entries.length, 'entry', 'entries')} in context (${plural(plan.calls, 'call', 'calls')})` : 'Judge the hits in context';
    if (!job.match) { $('judge-area').replaceChildren(); return; }
    if (!entries.length) { $('judge-area').replaceChildren(el('p', { className: 'help', text: 'No entry looks ambiguous.' })); return; }
    const items = entries.map(entry => {
      const found = job.match.byEntry.get(entry.id);
      const decided = found.hits.filter(hit => state.decisions[hit.id]);
      const drops = decided.filter(hit => state.decisions[hit.id].keep === false);
      const applied = state.appliedJudge[entry.id] === true;
      const hitItems = decided.map(hit => {
        const keep = hit.id in state.overrides ? state.overrides[hit.id] : !(applied && state.decisions[hit.id].keep === false);
        return el('li', { className: 'review-item' },
          el('p', { className: 'review-excerpt' }, `p. ${hit.page}: ${hit.context?.before ?? ''}`, el('mark', { text: hit.context?.match ?? hit.matched }), hit.context?.after ?? ''),
          el('p', { className: 'review-note', text: `Model: ${state.decisions[hit.id].keep ? 'keep' : 'drop'}${state.decisions[hit.id].reason ? ` (${state.decisions[hit.id].reason})` : ''}` }),
          el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: keep, onchange: event => { state.overrides[hit.id] = event.target.checked; changed(); } }), 'Keep this hit'));
      });
      return el('details', { className: 'review-chapter' },
        el('summary', { text: `${headingOf(entry.text)}: ${plural(found.hits.length, 'hit', 'hits')}; ${job.match.reasons.get(entry.id).join('; ')}${decided.length ? `; the model proposes dropping ${drops.length}` : ''}${applied ? ' (applied)' : ''}` }),
        decided.length ? el('div', { className: 'row-actions' },
          el('button', { type: 'button', className: 'button secondary', text: applied ? 'Undo the model’s decisions' : 'Apply the model’s decisions', onclick: () => { state.appliedJudge[entry.id] = !applied; for (const hit of found.hits) delete state.overrides[hit.id]; changed(); } })) : null,
        el('ul', { className: 'review-list' }, ...hitItems));
    });
    const failures = job.failures.judge.length ? [el('div', { className: 'notice error' }, el('p', { text: `${plural(job.failures.judge.length, 'group', 'groups')} of hits could not be judged: ${[...new Set(job.failures.judge.map(failureLine))].join(' ')}` }), el('button', { type: 'button', className: 'button secondary', text: 'Try again', onclick: () => void judge({ only: job.failures.judge.map(failure => failure.key) }) }))] : [];
    $('judge-area').replaceChildren(...failures, ...items);
  }

  function renderSort() {
    const entries = subentryEntries();
    const running = state.running !== null;
    const plan = job.match ? judgePlan('subentries', entries, job.match.byEntry) : { hits: 0, calls: 0 };
    $('sort-button').disabled = running || !plan.calls || !model();
    $('sort-button').textContent = plan.calls ? `Sort ${plural(plan.hits, 'hit', 'hits')} into subentries (${plural(plan.calls, 'call', 'calls')})` : 'Sort hits into subentries';
    if (!job.match || !entries.length) { $('sort-area').replaceChildren(); return; }
    const items = entries.filter(entry => job.match.byEntry.get(entry.id).hits.some(hit => hit.id in state.assignments)).map(entry => {
      const found = job.match.byEntry.get(entry.id);
      const applied = state.appliedSorting[entry.id] === true;
      const counts = entry.subentries.map((sub, at) => `${headingOf(sub.text)}: ${found.hits.filter(hit => state.assignments[hit.id] === at).length}`);
      const none = found.hits.filter(hit => state.assignments[hit.id] === null).length;
      return el('details', { className: 'review-chapter' },
        el('summary', { text: `${headingOf(entry.text)}: ${counts.join('; ')}; none ${none}${applied ? ' (applied)' : ''}` }),
        el('div', { className: 'row-actions' }, el('button', { type: 'button', className: 'button secondary', text: applied ? 'Undo the sorting' : 'Apply the sorting', onclick: () => { state.appliedSorting[entry.id] = !applied; changed(); } })),
        el('ul', { className: 'review-list' }, ...found.hits.filter(hit => hit.id in state.assignments).map(hit => el('li', { className: 'review-item' },
          el('p', { className: 'review-excerpt' }, `p. ${hit.page}: ${hit.context?.before ?? ''}`, el('mark', { text: hit.context?.match ?? hit.matched }), hit.context?.after ?? ''),
          el('label', { text: 'Subentry' }),
          el('select', { onchange: event => { state.assignments[hit.id] = event.target.value === '' ? null : Number(event.target.value); changed(); } },
            el('option', { value: '', text: 'None', selected: state.assignments[hit.id] === null }),
            ...entry.subentries.map((sub, at) => el('option', { value: String(at), text: headingOf(sub.text), selected: state.assignments[hit.id] === at })))))));
    });
    const failures = job.failures.sort.length ? [el('div', { className: 'notice error' }, el('p', { text: `${plural(job.failures.sort.length, 'group', 'groups')} of hits could not be sorted: ${[...new Set(job.failures.sort.map(failureLine))].join(' ')}` }), el('button', { type: 'button', className: 'button secondary', text: 'Try again', onclick: () => void sortHits({ only: job.failures.sort.map(failure => failure.key) }) }))] : [];
    $('sort-area').replaceChildren(...failures, ...items);
  }

  function currentIndex() {
    if (!job.match) return null;
    const list = workingList(state.entries).filter(entry => job.match.byEntry.has(entry.id));
    const entries = indexEntries(list, job.match.byEntry, state);
    return formatIndex(entries, state.settings);
  }

  function renderOutput() {
    const formatted = currentIndex();
    for (const id of ['download-text', 'download-docx', 'download-plain']) $(id).disabled = !formatted?.count;
    if (!formatted) { $('output-status').textContent = 'The index appears here once the terms are found in the proofs.'; $('index-preview').replaceChildren(); return; }
    $('output-status').textContent = `${plural(formatted.count, 'entry', 'entries')} in the index; ${plural(job.match.index.notFound.length, 'term was', 'terms were')} not found in the proofs${job.match.index.notFound.length ? `: ${job.match.index.notFound.slice(0, 30).join('; ')}${job.match.index.notFound.length > 30 ? '…' : ''}` : ''}.`;
    $('index-preview').replaceChildren(...formatted.lines.map(line => el('p', { className: line.startsWith('    ') ? 'index-line sub' : line.length === 1 || line === '0–9' ? 'index-letter' : 'index-line', text: line.trim() || ' ' })));
  }

  // --- The match ---

  // Anything that changes what the index holds makes the match stale until the terms are found again.
  function stale() {
    if (job.match) { job.match = null; $('match-status').textContent = 'The list or the pages changed. Find the terms in the proofs again.'; }
  }
  // A changed or merged entry's decisions are about hits that are no longer the same.
  function forget(id) {
    for (const key of Object.keys(state.decisions)) if (key.startsWith(`${id}:`)) { delete state.decisions[key]; delete state.overrides[key]; }
    for (const key of Object.keys(state.assignments)) if (key.startsWith(`${id}:`)) delete state.assignments[key];
    delete state.appliedJudge[id];
    delete state.appliedSorting[id];
  }

  function exclusions() {
    const pageCount = job.texts.length;
    const manual = parseManualRanges(state.manualRanges, pageCount) ?? [];
    return [...manual, ...state.ranges.filter(range => range.on)];
  }

  async function match() {
    if (!job.texts) return;
    const pageOne = state.settings.pageOne ? Number.parseInt(state.settings.pageOne, 10) : null;
    if (pageOne !== null && !(pageOne >= 1 && pageOne <= job.texts.length)) { showErrors([`“Book page 1 is PDF page” must be a whole number from 1 to ${job.texts.length}.`]); return; }
    if (state.manualRanges.trim() && parseManualRanges(state.manualRanges, job.texts.length) === null) { showErrors([`Write the pages to leave out as PDF page numbers from 1 to ${job.texts.length}, as 1-12, 280-300.`]); return; }
    showErrors([]);
    const { numbers, source } = pageNumbering(job.texts.length, job.labels, pageOne);
    const { pages } = applyExclusions(job.texts.map((text, at) => ({ number: numbers[at], text })), exclusions());
    const list = workingList(state.entries);
    $('match-status').textContent = 'Finding the terms…';
    const started = performance.now();
    try {
      const answer = await reader.match({ pages, entries: list, matchCase: state.settings.matchCase });
      job.match = { index: answer.index, byEntry: new Map(answer.byEntry), reasons: new Map(answer.reasons) };
      const left = pages.filter(page => page.number === null).length;
      $('match-status').textContent = `${plural(answer.index.entries.length, 'entry', 'entries')} found on ${plural(job.texts.length - left, 'page', 'pages')} in ${((performance.now() - started) / 1000).toFixed(1)} s${left ? `, ${plural(left, 'page', 'pages')} left out` : ''}. ${source === 'labels' ? 'Page numbers come from the numbering stored in the PDF.' : source === 'offset' ? `PDF page ${pageOne} is counted as page 1.` : 'Page numbers are counted from the first page of the PDF.'}`;
      announce(`${plural(answer.index.entries.length, 'entry', 'entries')} found.`);
    } catch (error) {
      $('match-status').textContent = '';
      showErrors([`The terms could not be found: ${error.message}`]);
    }
    render();
  }

  // --- Running a helper ---

  async function running(kind, progressArea, work) {
    const controller = new AbortController();
    state.running = Object.assign(controller, { kind });
    $(`${progressArea}-area`).hidden = false;
    $(progressArea).value = 0;
    render();
    const onProgress = ({ done, total }) => { $(progressArea).max = total; $(progressArea).value = done; $(`${progressArea}-text`).textContent = `${done.toLocaleString('en-US')} of ${plural(total, 'call', 'calls')} done`; };
    try {
      await work(controller.signal, onProgress);
    } catch (error) {
      if (controller.signal.aborted) announce('Stopped. What was answered is kept.');
      else showErrors([error?.message ?? String(error)]);
    } finally {
      state.running = null;
      $(`${progressArea}-area`).hidden = true;
      void refreshStatus();
      changed();
    }
  }

  async function propose({ only } = {}) {
    if (!job.manuscript) return;
    const { hash, name, paragraphs, left } = job.manuscript;
    if (state.proposing?.hash !== hash) state.proposing = { hash, name, answered: {} };
    const answered = state.proposing.answered;
    // A passage answered before (in one piece or in two halves) is not asked again.
    const done = key => key in answered || (`${key}.0` in answered && `${key}.1` in answered);
    const keys = only ?? buildTermPassages(paragraphs, { left }).map(passage => passage.key).filter(key => !done(key));
    if (!keys.length) { applyProposals(); changed(); announce('Every passage was answered before.'); return; }
    if (!confirm(`Propose terms from ${name}? This makes ${plural(keys.length, 'model call', 'model calls')}, one per passage of about 9,000 characters.`)) return;
    showErrors([]);
    await running('propose', 'propose-progress', async (signal, onProgress) => {
      $('propose-progress-text').textContent = 'Reading the manuscript…';
      try {
        const result = await proposeTerms({ paragraphs, left, model: model(), signal, onProgress, only: keys, callTerms, onResult: (passage, parsed) => { answered[passage.key] = parsed; void save(); } });
        job.failures.propose = result.failures;
      } finally {
        // What was answered before a Stop is kept and merged too.
        applyProposals();
      }
      announce(`Terms proposed: ${plural(state.entries.filter(entry => entry.status === 'proposed').length, 'entry', 'entries')} to review.`);
    });
  }

  // Merges every answer so far into the list: the proposals replace earlier proposals not yet
  // reviewed, and leave alone what the author accepted, dropped or typed.
  function applyProposals() {
    if (!job.manuscript || !state.proposing) return;
    const proposals = Object.values(state.proposing.answered).flatMap(answer => answer.proposals);
    const merged = mergeProposals(proposals);
    const { entries } = countAndDrop(merged, job.manuscript.paragraphs, job.manuscript.left);
    const kept = state.entries.filter(entry => entry.status !== 'proposed');
    const result = addEntries(kept, entries);
    state.entries = result.list;
    stale();
  }

  async function findRanges({ only } = {}) {
    if (!job.texts) return;
    const pages = job.texts.map((text, at) => ({ text, label: job.labels[at] }));
    await running('ranges', 'helper-progress', async (signal, onProgress) => {
      const found = await findMatter({ pages, model: model(), callRanges, signal, onProgress, only });
      job.failures.ranges = found.failures;
      const fresh = found.ranges.map(range => ({ ...range, on: false, cut: firstPageCut(range.heading, job.texts[range.first - 1] ?? '') }));
      state.ranges = only ? [...state.ranges, ...fresh] : fresh;
      announce(`${plural(found.ranges.length, 'range', 'ranges')} proposed. Tick the ones to leave out.`);
    });
  }

  async function judge({ only } = {}) {
    const entries = ambiguousEntries();
    const plan = judgePlan('ambiguous', entries, job.match.byEntry, entry => ({ reasons: job.match.reasons.get(entry.id) }));
    if (!only && !confirm(`Judge ${plural(plan.hits, 'hit', 'hits')} in context? This makes ${plural(plan.calls, 'model call', 'model calls')}.`)) return;
    await running('judge', 'helper-progress', async (signal, onProgress) => {
      const result = await runJudge({ task: 'ambiguous', entries, byEntry: job.match.byEntry, model: model(), callJudge, reasons: job.match.reasons, only, signal, onProgress, onResult: (_, parsed) => { for (const [id, answer] of parsed) state.decisions[id] = answer; } });
      job.failures.judge = result.failures;
      announce('The model’s decisions are shown under each entry. Apply them entry by entry.');
    });
  }

  async function sortHits({ only } = {}) {
    const entries = subentryEntries();
    const plan = judgePlan('subentries', entries, job.match.byEntry);
    if (!only && !confirm(`Sort ${plural(plan.hits, 'hit', 'hits')} into subentries? This makes ${plural(plan.calls, 'model call', 'model calls')}.`)) return;
    await running('sort', 'helper-progress', async (signal, onProgress) => {
      const result = await runJudge({ task: 'subentries', entries, byEntry: job.match.byEntry, model: model(), callJudge, only, signal, onProgress, onResult: (_, parsed) => { for (const [id, at] of parsed) state.assignments[id] = at; } });
      job.failures.sort = result.failures;
      announce('The proposed subentries are shown under each entry. Apply them entry by entry.');
    });
  }

  // --- Files ---

  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function chooseManuscript(file) {
    showErrors([]);
    const bytes = await file.arrayBuffer().then(buffer => new Uint8Array(buffer), () => null);
    const read = bytes ? readDocx(bytes) : { ok: false, message: 'This file could not be opened.' };
    if (!read.ok) { showErrors([`${file.name}: ${read.message}`]); return; }
    const hash = await sha256(bytes);
    // The Formatter's paragraph labels for the same file, when this browser keeps them.
    let roles = null;
    try {
      const labels = await formatterStore?.loadJob(FORMATTER_LABELS);
      if (labels?.hash === hash && labels.roles) roles = { ...labels.roles, ...labels.corrections };
    } catch {}
    const { left, by } = leftOutParagraphs(read.paragraphs, roles);
    job.manuscript = { name: file.name, hash, paragraphs: read.paragraphs, left, by };
    if (state.proposing?.hash === hash) applyProposals();
    changed();
    announce(`${file.name} read.`);
  }

  async function choosePdf(file) {
    showErrors([]);
    $('read-progress-area').hidden = false;
    $('read-progress-text').textContent = 'Loading the PDF reader…';
    try {
      const buffer = await file.arrayBuffer();
      const hash = await sha256(new Uint8Array(buffer));
      const read = await reader.read(buffer, (done, total) => { $('read-progress').max = total; $('read-progress').value = done; $('read-progress-text').textContent = `Reading page ${done} of ${total}`; });
      job.texts = read.texts;
      job.labels = read.labels;
      job.match = null;
      // Another PDF: ranges and decisions about the old one's pages do not apply.
      if (state.pdf?.hash !== hash) Object.assign(state, { ranges: [], decisions: {}, overrides: {}, appliedJudge: {}, assignments: {}, appliedSorting: {} });
      state.pdf = { name: file.name, hash, pages: read.texts.length };
      $('match-status').textContent = `${file.name}: ${plural(read.texts.length, 'page', 'pages')} read.`;
      announce(`${file.name} read.`);
      changed();
      if (workingList(state.entries).length) await match();
    } catch (error) {
      showErrors([friendlyPdfError(error)]);
    } finally {
      $('read-progress-area').hidden = true;
    }
  }

  async function loadList(file) {
    const text = await file.text().catch(() => null);
    if (text === null || text.length > MAX_LIST_FILE_CHARS) { showErrors(['This term list file could not be read.']); return; }
    addText(text, file.name);
  }

  function addText(text, from) {
    const { entries, problems } = entriesFromText(text, state.entries);
    if (!entries.length) { showErrors(['No terms were found there. Put one term or name per line.', ...problems]); return; }
    const result = addEntries(state.entries, entries);
    state.entries = result.list;
    showErrors(problems);
    stale();
    changed();
    announce(`${plural(result.added, 'entry', 'entries')} added from ${from}${result.skipped ? `; ${result.skipped} already in the list` : ''}.`);
  }

  async function loadSheet(file) {
    const text = await file.text().catch(() => null);
    const result = text === null ? { ok: false, message: 'This file could not be read.' } : settingsFromSheet(text);
    if (!result.ok) { $('sheet-status').textContent = result.message; return; }
    Object.assign(state.settings, result.settings);
    $('sheet-status').textContent = result.found.length ? `Set from the rule sheet: ${result.found.map(slot => ({ 'index.layout': 'layout', 'index.page-ranges': 'page ranges', 'index.sorting': 'order' })[slot]).join(', ')}.` : 'The rule sheet says nothing about the index, so nothing was changed.';
    changed();
  }

  function downloadIndex(kind) {
    const formatted = currentIndex();
    if (!formatted) return;
    if (kind === 'text') download('index.txt', new TextEncoder().encode(`${formatted.lines.join('\n')}\n`), 'text/plain;charset=utf-8');
    else if (kind === 'plain') download('index-book-index.txt', new TextEncoder().encode(`${job.match.index.index}\n`), 'text/plain;charset=utf-8');
    else {
      const bytes = indexDocx(formatted, { note: 'Made with the CUNY AI Lab Index Builder. Check every entry against the proofs.' });
      const report = validateDocx(bytes);
      if (!report.ok) { showErrors(['The Word file did not pass the check of its structure, so it is not offered. Download the plain text instead.']); return; }
      download('index.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    }
  }

  // --- Clearing ---

  function clearWork() {
    state.running?.abort();
    Object.assign(state, { entries: [], settings: { ...DEFAULT_SETTINGS }, proposing: null, pdf: null, ranges: [], manualRanges: '', decisions: {}, overrides: {}, appliedJudge: {}, assignments: {}, appliedSorting: {} });
    Object.assign(job, { manuscript: null, texts: null, labels: null, match: null, failures: { propose: [], ranges: [], judge: [], sort: [] } });
    $('paste-box').value = '';
    $('pdf-file').value = '';
    $('manuscript-file').value = '';
    $('match-status').textContent = '';
    showErrors([]);
    render();
    if (store) void queue(() => store.clearAll());
  }

  function startOver() {
    if ((state.entries.length || job.texts || job.manuscript) && !confirm('Start over? This clears the term list, the manuscript, the proofs and every decision from this page and this browser.')) return;
    clearWork();
    $('work-notice').hidden = true;
    announce('Started over. Your work was cleared from this browser.');
  }

  function expired() {
    clearWork();
    const message = 'Your work was deleted from this page and this browser because 24 hours passed since your last change.';
    showWorkNotice(message);
    announce(message);
  }

  async function deleteSaved() {
    if (!confirm('Delete the work kept in this browser now? The work on this page stays until you close or reload it, but nothing more is kept in this browser while it is open.')) return;
    keeping = false;
    expiry?.stop();
    $('delete-saved').disabled = true;
    if (store) await queue(() => store.clearAll());
    const message = 'The work kept in this browser was deleted, and nothing more is kept in it while this page is open. Download the term list to keep it.';
    showWorkNotice(message);
    announce(message);
  }

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
        $('quota-content').replaceChildren(
          el('p', { className: 'quota-number', text: `${money(quota.estimated_remaining)} remaining` }),
          el('meter', { min: 0, max: 100, value: quota.used_percent, 'aria-label': `${quota.used_percent}% of your shared allowance used` }),
          el('p', { className: 'help', text: `${money(quota.estimated_used)} used of ${money(quota.limit)}.` }));
      } catch {
        $('quota-content').replaceChildren(el('p', { className: 'help', text: 'Your usage estimate is unavailable right now.' }));
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
      $('model-help').textContent = menu.length ? 'Used by every model helper on this page; each uses your shared CUNY AI Lab allowance and says how many calls it makes first.' : 'No model is available right now. Reload the page later.';
    } catch {
      $('model-help').textContent = 'The list of models could not be loaded. Reload the page to try again.';
    }
    render();
  }

  // --- Events ---

  $('load-list').addEventListener('click', () => $('list-file').click());
  $('list-file').addEventListener('change', async event => { const [file] = event.target.files; event.target.value = ''; if (file) await loadList(file); });
  $('add-pasted').addEventListener('click', () => { const text = $('paste-box').value; if (text.trim()) { addText(text, 'the pasted text'); $('paste-box').value = ''; } });
  $('download-list').addEventListener('click', () => { const file = termListFile(state.entries); download(file.name, new TextEncoder().encode(file.text), 'text/plain;charset=utf-8'); });
  $('manuscript-file').addEventListener('change', async event => { const [file] = event.target.files; if (file) await chooseManuscript(file); });
  $('model-select').addEventListener('change', () => { $('model-select').dataset.chosen = 'true'; render(); });
  $('propose-button').addEventListener('click', () => void propose());
  $('propose-stop').addEventListener('click', () => state.running?.abort());
  $('pdf-file').addEventListener('change', async event => { const [file] = event.target.files; if (file) await choosePdf(file); });
  $('page-one').addEventListener('change', event => { state.settings.pageOne = event.target.value.trim(); stale(); changed(); });
  $('match-case').addEventListener('change', event => { state.settings.matchCase = event.target.checked; stale(); changed(); });
  $('manual-ranges').addEventListener('change', event => { state.manualRanges = event.target.value.slice(0, 200); stale(); changed(); });
  $('build-button').addEventListener('click', () => void match());
  $('ranges-button').addEventListener('click', () => void findRanges());
  for (const kind of ['ranges', 'judge', 'sort']) $(`${kind}-stop`).addEventListener('click', () => state.running?.abort());
  $('judge-button').addEventListener('click', () => void judge());
  $('sort-button').addEventListener('click', () => void sortHits());
  $('load-sheet').addEventListener('click', () => $('sheet-file').click());
  $('sheet-file').addEventListener('change', async event => { const [file] = event.target.files; event.target.value = ''; if (file) await loadSheet(file); });
  for (const [id, key] of [['layout-select', 'layout'], ['style-select', 'style'], ['sorting-select', 'sorting']]) $(id).addEventListener('change', event => { state.settings[key] = event.target.value; changed(); });
  $('collapse').addEventListener('change', event => { state.settings.collapse = event.target.checked; changed(); });
  $('download-text').addEventListener('click', () => downloadIndex('text'));
  $('download-docx').addEventListener('click', () => downloadIndex('docx'));
  $('download-plain').addEventListener('click', () => downloadIndex('plain'));
  $('start-over').addEventListener('click', startOver);
  $('delete-saved').addEventListener('click', () => void deleteSaved());
  $('refresh-quota').addEventListener('click', () => void refreshStatus());

  (async () => {
    render();
    try { if (store) Object.assign(state, restoredState(await store.loadJob(SAVED_KEY))); } catch {}
    restored = true;
    if (state.pdf) $('match-status').textContent = `Your work on ${state.pdf.name} is kept from before. Choose the same PDF to find the terms again.`;
    if (store) {
      expiry = watchExpiry({ store, onExpired: expired, busy: () => Boolean(state.running) });
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
