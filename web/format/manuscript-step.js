// The Formatter page, steps 4 and 5, drawn in the page: choosing the manuscript (read in this
// browser, never uploaded), labelling its paragraphs through POST /manuscript/api/roles, and the
// review of the labels. The decisions are in manuscript-state.js; every text from the manuscript or
// the model is set with textContent. The file's bytes and text stay in memory (job.file); what is
// kept in this browser is savedLabels(job.labels), which holds no text.

import { readDocx } from '../../lib/docx/read.js';
import { labelRoles } from '../../lib/roles/label.js';
import { ROLE_IDS } from '../../lib/roles/roles.js';
import { ApiError } from '../shared/api.js';
import {
  DAMAGING, FILTERS, ROLE_LABELS, SAVED_KEY, afterLabelling, correctRole, effectiveRoles, labelFailureLines, labellingPlan,
  manuscriptSize, matchFile, neighbours, newLabels, restoredLabels, reviewHeadline, reviewModel, roleLabel, rolesOfReply,
  savedLabels, sha256, unlabelledParagraphs,
} from './manuscript-state.js';
import { el } from './rules-view.js';

// Above this many paragraphs shown, chapters start closed and are drawn when opened.
const OPEN_LIMIT = 400;
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * @param {{ $: Function, api: object, store: object | null, queue: Function, canSave: () => boolean, announce: Function,
 *   showErrors: Function, job: object, changed: Function, refreshStatus: Function }} ctx
 */
export function createManuscriptStep(ctx) {
  const { $, api, job, announce, showErrors } = ctx;
  let filter = 'check';
  let fileNotice = null;

  const save = () => (ctx.canSave() ? ctx.queue(() => (job.labels ? ctx.store.saveJob(SAVED_KEY, structuredClone(savedLabels(job.labels))) : ctx.store.clearJob(SAVED_KEY))) : Promise.resolve());
  const sameFile = () => Boolean(job.file && job.labels && matchFile(job.labels, job.file).kind === 'same');
  const labelled = () => sameFile() && job.labels.roles !== null;

  async function chooseFile(file) {
    showErrors([]);
    announce(`Reading ${file.name}…`);
    const bytes = await file.arrayBuffer().then(buffer => new Uint8Array(buffer), () => null);
    const read = bytes ? readDocx(bytes) : { ok: false, message: 'This file could not be opened. Save the manuscript again as a Word file and choose it again.' };
    if (!read.ok) {
      showErrors([`${file.name}: ${read.message}`]);
      announce('The manuscript could not be read.');
      return;
    }
    job.file = { name: file.name, bytes, paragraphs: read.paragraphs, hash: await sha256(bytes) };
    job.output = null;
    fileNotice = matchFile(job.labels, job.file).message;
    filter = 'check';
    ctx.changed();
    announce(`${file.name} read: ${manuscriptSize(read.paragraphs).text}.`);
  }

  const callRoles = async ({ model, passage, signal }) => {
    const key = await sha256(`${model}\u0000${passage}`);
    const cached = job.labels.replies[key];
    if (cached) return { content: JSON.stringify({ roles: cached }) };
    let reply;
    try {
      reply = await api.post('/api/roles', { model, passage }, { signal });
    } catch (error) {
      throw error instanceof ApiError ? { code: error.code, retry: error.retry, status: error.status, retryAfter: error.retryAfter, message: error.message } : error;
    }
    const roles = rolesOfReply(reply?.content, job.file.paragraphs.length);
    // Kept as roles only, so a reload, a sign-in or a Stop does not pay for this passage again.
    if (roles) { job.labels.replies[key] = roles; void save(); }
    return reply;
  };

  async function label({ retry = false } = {}) {
    const model = $('roles-model-select').value;
    const problems = [!job.file && 'Choose the manuscript in step 4 first.', !model && 'No model is available right now. Reload the page to try again.'].filter(Boolean);
    showErrors(problems);
    if (problems.length) return;
    const match = matchFile(job.labels, job.file);
    if (!retry && match.kind === 'other' && job.labels.roles && !confirm(`Reading this manuscript replaces the labels kept for ${job.labels.name}. Continue?`)) return;
    if (!retry && match.kind === 'same' && job.labels.roles && !confirm('Reading the manuscript again replaces its labels and your corrections. Continue?')) return;
    // A run that was stopped is finished from its saved replies; anything else starts afresh.
    const resume = retry || (match.kind === 'same' && job.labels.roles === null);
    if (!resume) job.labels = newLabels({ hash: job.file.hash, name: job.file.name, paragraphs: job.file.paragraphs.length, model });
    void save();
    const only = retry ? unlabelledParagraphs(job.file.paragraphs, job.labels) : null;
    const controller = new AbortController();
    job.labelling = controller;
    fileNotice = null;
    $('roles-progress').value = 0;
    $('roles-progress-text').textContent = 'Reading the manuscript…';
    ctx.changed();
    try {
      const result = await labelRoles({
        paragraphs: job.file.paragraphs, model, callRoles, signal: controller.signal,
        ...(only ? { passageOptions: { only: new Set(only), overlap: 0, overlapShare: 0 } } : {}),
        onProgress: ({ done, total }) => {
          $('roles-progress').max = total;
          $('roles-progress').value = done;
          $('roles-progress-text').textContent = `Reading the manuscript: ${done} of ${plural(total, 'passage', 'passages')} done.`;
        },
      });
      job.labels = afterLabelling(job.labels, result, { retry });
      job.labels.model = model;
      const left = unlabelledParagraphs(job.file.paragraphs, job.labels).length;
      announce(`Finished reading the manuscript.${left ? ` ${plural(left, 'paragraph was', 'paragraphs were')} not labelled; they are listed first.` : ''} Check the labels below.`);
    } catch {
      if (controller.signal.aborted) announce('Stopped. The passages labelled so far are kept in this browser and are not paid for again when you read the manuscript again.');
      else showErrors(['The manuscript could not be read. Try again.']);
    } finally {
      job.labelling = null;
      void save();
      ctx.changed({ focusId: 'roles-title' });
      void ctx.refreshStatus();
    }
  }

  function setRole(index, role, row) {
    job.labels = correctRole(job.labels, index, role);
    void save();
    const corrected = index in job.labels.corrections;
    row.classList.toggle('corrected', corrected);
    row.querySelector('.review-note').textContent = noteFor(job.labels, index);
    renderCounts();
    ctx.renderOutput();
    announce(corrected ? `Changed to ${roleLabel(role)}.` : `Back to the model's label, ${roleLabel(role)}.`);
  }

  const noteFor = (labels, index) => (index in labels.corrections ? `Changed by you. The model said: ${roleLabel(labels.roles?.[index])}.` : '');

  function itemRow(item) {
    const id = `para-${item.index}`;
    const row = el('li', { className: item.corrected ? 'review-item corrected' : 'review-item', id });
    const select = el('select', { id: `${id}-role`, 'aria-describedby': `${id}-text ${id}-note`, onchange: () => setRole(item.index, select.value, row) },
      ...(item.role ? [] : [el('option', { value: '', text: 'Not labelled: choose what it is', disabled: true })]),
      ...ROLE_IDS.map(role => el('option', { value: role, text: ROLE_LABELS[role] })));
    select.value = item.role ?? '';
    const near = el('div', { className: 'review-near', id: `${id}-near`, hidden: true });
    const toggle = el('button', { type: 'button', className: 'text-button', text: 'Show neighbours', 'aria-expanded': 'false', 'aria-controls': near.id, 'aria-describedby': `${id}-text`,
      onclick: () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide neighbours' : 'Show neighbours';
        if (open) near.replaceChildren(el('ul', {}, ...neighbours(job.file.paragraphs, job.labels, item.index).map(entry => el('li', { className: entry.side },
          el('span', { className: 'near-role', text: `${entry.side === 'before' ? 'Before' : 'After'}, ${entry.role}: ` }), el('span', { text: entry.excerpt })))));
        near.hidden = !open;
      } });
    row.append(
      el('p', { className: 'review-excerpt', id: `${id}-text`, text: item.excerpt }),
      el('div', { className: 'review-controls' },
        el('div', { className: 'field' }, el('label', { for: select.id, text: 'What it is' }), select),
        toggle),
      el('p', { className: 'review-note help', id: `${id}-note`, text: noteFor(job.labels, item.index) }),
      near);
    return row;
  }

  function renderCounts() {
    const model = reviewModel(job.file.paragraphs, job.labels, filter);
    $('role-counts').replaceChildren(...model.counts.map(entry => el('li', { text: `${entry.label}: ${entry.count.toLocaleString('en-US')}` })));
  }

  function renderReview() {
    const area = $('review');
    if (!labelled()) { area.replaceChildren(); return; }
    const model = reviewModel(job.file.paragraphs, job.labels, filter);
    const all = reviewModel(job.file.paragraphs, job.labels, 'all');
    const menu = el('select', { id: 'review-filter', onchange: () => { filter = menu.value; renderReview(); $('review-filter').focus(); } },
      ...Object.entries(FILTERS).map(([value, text]) => el('option', { value, text })),
      ...all.counts.map(entry => el('option', { value: entry.role, text: `${entry.label} only (${entry.count.toLocaleString('en-US')})` })));
    menu.value = filter;
    const groups = [];
    if (model.unlabelled.length) {
      groups.push(el('section', { className: 'review-group unlabelled', 'aria-labelledby': 'review-unlabelled' },
        el('h3', { id: 'review-unlabelled', text: `Not labelled by the model (${model.unlabelled.length.toLocaleString('en-US')})` }),
        el('p', { className: 'help', text: 'Choose what each of these is, or use Try again above. A paragraph left without a label keeps its formatting as it is.' }),
        el('ol', { className: 'review-list' }, ...model.unlabelled.map(itemRow))));
    }
    const open = model.shown <= OPEN_LIMIT;
    for (const chapter of model.chapters) {
      const list = el('ol', { className: 'review-list' });
      const details = el('details', { className: 'review-chapter', open },
        el('summary', { text: `${chapter.key === -1 ? chapter.title : `Chapter: ${chapter.title}`} (${plural(chapter.items.length, 'paragraph', 'paragraphs')} shown of ${chapter.total.toLocaleString('en-US')})` }), list);
      const fill = () => { if (!list.childElementCount) list.append(...chapter.items.map(itemRow)); };
      if (open) fill();
      else details.addEventListener('toggle', () => { if (details.open) fill(); });
      groups.push(details);
    }
    area.replaceChildren(
      el('p', { className: 'notice', id: 'damaging-notice', text: DAMAGING }),
      el('h3', { id: 'counts-title', text: 'Paragraphs by what they are' }),
      el('ul', { className: 'role-counts', id: 'role-counts', 'aria-labelledby': 'counts-title' }),
      el('div', { className: 'field review-filter' }, el('label', { for: 'review-filter', text: 'Show' }), menu),
      el('p', { className: 'help', id: 'review-headline', text: reviewHeadline(model, filter) }),
      ...(open ? [] : [el('p', { className: 'help', text: 'Open a chapter to see its paragraphs.' })]),
      ...groups);
    renderCounts();
  }

  function render() {
    const running = job.labelling !== null || job.formatting;
    $('manuscript-controls').disabled = running;
    const status = [];
    if (job.file) {
      status.push(el('p', { className: 'source-name', text: job.file.name }), el('p', { className: 'help', text: manuscriptSize(job.file.paragraphs).text }));
      if (fileNotice) status.push(el('p', { className: 'notice info', id: 'file-notice', text: fileNotice }));
    } else if (job.labels) {
      status.push(el('p', { className: 'notice info', id: 'file-notice', text: `Labels for ${job.labels.name} are kept in this browser. Choose that file again to go on; it is not labelled again.` }));
    } else status.push(el('p', { className: 'help', text: 'No manuscript chosen yet.' }));
    $('manuscript-status').replaceChildren(...status);

    $('roles-controls').disabled = running || !job.file;
    $('label-button').hidden = job.labelling !== null;
    $('label-button').textContent = labelled() ? 'Read the manuscript again' : 'Read the manuscript';
    $('label-stop').hidden = job.labelling === null;
    $('roles-progress-area').hidden = job.labelling === null;
    $('roles-plan').textContent = job.file && !labelled() ? labellingPlan(job.file.paragraphs).text : '';
    const notices = [];
    if (labelled() && job.labels.failures.length) {
      notices.push(el('div', { className: 'notice', id: 'roles-failure-notice' },
        el('p', { text: 'Some paragraphs could not be labelled. Try again for those alone, or choose their labels yourself below.' }),
        el('ul', { className: 'failure-list' }, ...labelFailureLines(job.labels.failures).map(line => el('li', { text: line }))),
        el('button', { type: 'button', className: 'button secondary', id: 'roles-retry', text: 'Try again', onclick: () => void label({ retry: true }) })));
    }
    $('roles-notices').replaceChildren(...notices);
    $('review').inert = job.labelling !== null;
    renderReview();
  }

  function startOver() {
    job.labelling?.abort();
    Object.assign(job, { file: null, labels: null, output: null });
    fileNotice = null;
    filter = 'check';
    $('manuscript-file').value = '';
    if (ctx.store) void ctx.queue(() => ctx.store.clearJob(SAVED_KEY));
  }

  async function restore() {
    try {
      if (ctx.store) job.labels = restoredLabels(await ctx.store.loadJob(SAVED_KEY));
    } catch {}
  }

  $('manuscript-file').addEventListener('change', async event => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) await chooseFile(file);
  });
  $('label-button').addEventListener('click', () => void label());
  $('label-stop').addEventListener('click', () => job.labelling?.abort());

  return { render, save, startOver, restore, roles: () => (labelled() ? effectiveRoles(job.labels) : null) };
}
