// The Formatter page, step 6, drawn in the page: "Format the manuscript" runs buildOutputs in this
// browser on the bytes held in memory and offers the files it made for download; a summary says
// what was changed, flagged and left to supply. The decisions are in output-state.js; every text
// from the manuscript, the guidelines or the model is set with textContent. Nothing made here is
// kept in this browser or sent anywhere, except the chapter titles sent to propose running titles
// and, when the scholar ticks the reading check (which states its number of calls first), each
// chapter's opening.

import { ApiError } from '../shared/api.js';
import { STALE, afterFormat, buildOutputs, isStale, outputBasis, readingPlan, runningTitlesRule } from './output-state.js';
import { el } from './rules-view.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * @param {{ $: Function, api: object, job: object, state: object, announce: Function, showErrors: Function,
 *   roles: () => Record<number, string> | null, changed: Function, refreshStatus: Function }} ctx
 */
export function createOutputStep(ctx) {
  const { $, api, job, state, announce, showErrors } = ctx;
  // Running-title and reading answers by request, for this page's life only: formatting again does
  // not pay twice.
  const titlesAsked = new Map();
  const readingAsked = new Map();
  let error = null;

  const wantsReading = () => $('reading-check').checked;
  const basis = () => outputBasis({ sheet: state.sheet, roles: ctx.roles(), reading: wantsReading() });

  const readText = async ({ unit }) => {
    const model = $('roles-model-select').value;
    const key = `${model}\u0000${unit}`;
    if (!readingAsked.has(key)) {
      try {
        readingAsked.set(key, (await api.post('/api/reading', { model, unit })).content);
      } catch (failure) {
        throw failure instanceof ApiError ? { code: failure.code, retry: failure.retry, status: failure.status, retryAfter: failure.retryAfter } : failure;
      }
    }
    return readingAsked.get(key);
  };

  const proposeTitles = async ({ titles, max }) => {
    const model = $('roles-model-select').value;
    const key = `${model}\u0000${max}\u0000${titles}`;
    if (!titlesAsked.has(key)) {
      try {
        titlesAsked.set(key, (await api.post('/api/running-titles', { model, titles, max })).content);
      } catch (failure) {
        throw failure instanceof ApiError ? { code: failure.code, message: failure.message } : failure;
      }
    }
    return titlesAsked.get(key);
  };

  async function format() {
    const roles = ctx.roles();
    const problems = [
      !state.sheet && 'Read the guidelines or load a rule sheet in step 3 first.',
      !roles && 'Read the manuscript in step 5 first, so that each paragraph has a label.',
    ].filter(Boolean);
    showErrors(problems);
    if (problems.length) return;
    job.formatting = true;
    error = null;
    const reading = wantsReading();
    $('output-status').textContent = reading ? 'Formatting the manuscript in this browser, then reading the opening of each chapter with the model…'
      : runningTitlesRule(state.sheet) ? 'Formatting the manuscript in this browser, then asking the model for running titles…' : 'Formatting the manuscript in this browser…';
    ctx.changed();
    // Lets the page show that work has begun before the formatter takes the main thread.
    await new Promise(resolve => setTimeout(resolve, 30));
    const made = basis();
    let result;
    try {
      result = await buildOutputs({
        bytes: job.file.bytes, paragraphs: job.file.paragraphs, roles, sheet: state.sheet, name: job.file.name, proposeTitles,
        ...(reading ? { readText, onReading: ({ done, total }) => { $('output-status').textContent = `Reading the opening of each chapter: ${done} of ${total} done.`; } } : {}),
      });
    } catch {
      result = { ok: false, message: 'The manuscript could not be formatted. Try again.' };
    }
    const next = afterFormat(job.output, result, made);
    job.output = next.output;
    error = next.error;
    job.formatting = false;
    $('output-status').textContent = result.ok ? result.summary.headline : '';
    ctx.changed({ focusId: 'output-title' });
    announce(result.ok ? `${result.summary.headline} The files are ready to download.` : next.error);
    if (reading || runningTitlesRule(state.sheet)) void ctx.refreshStatus();
  }

  function download(file) {
    const url = URL.createObjectURL(new Blob([file.bytes], { type: DOCX }));
    const link = el('a', { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`${file.name} was downloaded.`);
  }

  const list = (id, title, lines) => el('section', { className: 'summary-part', 'aria-labelledby': id },
    el('h3', { id, text: title }), el('ul', { className: 'summary-list' }, ...lines.map(line => el('li', { text: line }))));

  function render() {
    const ready = Boolean(state.sheet && ctx.roles());
    $('format-button').disabled = !ready || job.formatting || job.labelling !== null;
    $('output-plan').textContent = ready
      ? (runningTitlesRule(state.sheet) ? 'The rule sheet asks for running titles, so the chapter titles are sent to the model to propose them.' : 'Unless you choose the reading check below, nothing is sent to a model in this step.')
      : 'This step needs the rule sheet (step 3) and the labels of the manuscript\'s paragraphs (step 5).';
    const calls = ready ? readingPlan({ paragraphs: job.file?.paragraphs, roles: ctx.roles(), sheet: state.sheet }) : 0;
    $('reading-check').disabled = !ready || calls === 0 || job.formatting;
    $('reading-plan').textContent = ready
      ? `Optional, ${calls === 1 ? 'one model call' : `${calls.toLocaleString('en-US')} model calls`}, one per chapter: the title block, abstract, keywords, headings and the first pages of each chapter's text are sent to the model, which proposes queries an editor would make (the same thing named two ways, an affiliation that differs, missing spaces, typing slips). Only queries whose quoted words are found in the text are kept; they become comments and To-dos, never changes.`
      : '';
    const notices = [];
    if (error) notices.push(el('p', { className: 'notice error', id: 'output-error', role: 'alert', text: error }));
    if (!job.formatting && isStale(job.output, basis())) notices.push(el('p', { className: 'notice', id: 'output-stale', text: STALE }));
    $('output-notices').replaceChildren(...notices);
    const output = job.output;
    if (!output) { $('output').replaceChildren(); return; }
    const { summary, files } = output;
    $('output').replaceChildren(
      el('h3', { id: 'downloads-title', text: 'Download' }),
      el('ul', { className: 'downloads', 'aria-labelledby': 'downloads-title' }, ...files.map(file => el('li', {},
        el('button', { type: 'button', className: file.id === 'manuscript' ? 'button primary' : 'button secondary', id: `download-${file.id}`, text: `Download ${file.name}`, 'aria-describedby': `download-${file.id}-what`, onclick: () => download(file) }),
        el('p', { className: 'help', id: `download-${file.id}-what`, text: file.label })))),
      list('summary-changed', 'What was changed', summary.changed),
      list('summary-flagged', 'What was flagged, with a comment in the file and an item on the To-dos list', summary.flagged),
      list('summary-supply', 'What you still have to supply', summary.supply),
      ...(summary.notes.length ? [list('summary-notes', 'Not done', summary.notes)] : []));
  }

  $('format-button').addEventListener('click', () => void format());
  $('reading-check').addEventListener('change', () => ctx.changed());
  return { render };
}
