// The Formatter page, step 6, drawn in the page: "Format the manuscript" runs buildOutputs in this
// browser on the bytes held in memory and offers the files it made for download. By default it
// runs the decide step (lib/decide/): the reading check of each chapter's opening, then the units
// of the decide step through POST /api/decide, which the page says beforehand will take about so
// many minutes; a summary says what we did, what the author must decide, the defaults applied and
// where the copyeditor's list is. Unticked, the page formats only, with a comment for every
// finding and the To-dos list. The decisions are in output-state.js; every text from the
// manuscript, the guidelines or the model is set with textContent. Nothing made here is kept in
// this browser or sent anywhere, except what those model calls send.

import { MODEL, UNAVAILABLE } from '../../lib/calls/model.js';
import { ApiError } from '../shared/api.js';
import { STALE, afterFormat, buildOutputs, decideEstimate, isStale, outputBasis, runningTitlesRule } from './output-state.js';
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

  const wantsDecide = () => $('decide-check').checked;
  const basis = () => outputBasis({ sheet: state.sheet, roles: ctx.roles(), decide: wantsDecide() });

  // One turn of one unit of the decide step. Answers are kept for this page's life, so formatting
  // again asks nothing twice.
  const decideAsked = new Map();
  const decide = async ({ kind, reading, messages, signal }) => {
    const key = JSON.stringify({ kind, reading, messages });
    if (!decideAsked.has(key)) {
      try {
        decideAsked.set(key, (await api.post('/api/decide', { kind, reading, messages }, { signal })).message);
      } catch (failure) {
        throw failure instanceof ApiError ? { code: failure.code, retry: failure.retry, status: failure.status, retryAfter: failure.retryAfter } : failure;
      }
    }
    return { message: decideAsked.get(key) };
  };

  const readText = async ({ unit }) => {
    const model = MODEL;
    const key = `${model}\u0000${unit}`;
    if (!readingAsked.has(key)) {
      try {
        readingAsked.set(key, (await api.post('/api/reading', { unit })).content);
      } catch (failure) {
        throw failure instanceof ApiError ? { code: failure.code, retry: failure.retry, status: failure.status, retryAfter: failure.retryAfter } : failure;
      }
    }
    return readingAsked.get(key);
  };

  const proposeTitles = async ({ titles, max }) => {
    const model = MODEL;
    const key = `${model}\u0000${max}\u0000${titles}`;
    if (!titlesAsked.has(key)) {
      try {
        titlesAsked.set(key, (await api.post('/api/running-titles', { titles, max })).content);
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
    if (job.unavailable && wantsDecide()) problems.push(UNAVAILABLE);
    showErrors(problems);
    if (problems.length) return;
    job.formatting = true;
    error = null;
    const deciding = wantsDecide();
    const { minutes } = deciding ? decideEstimate({ paragraphs: job.file.paragraphs, roles, sheet: state.sheet }) : { minutes: 0 };
    $('output-status').textContent = deciding ? `Formatting the manuscript, then reading each chapter's opening. This takes about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}…`
      : runningTitlesRule(state.sheet) ? 'Formatting the manuscript in this browser, then asking the model for running titles…' : 'Formatting the manuscript in this browser…';
    ctx.changed();
    // Lets the page show that work has begun before the formatter takes the main thread.
    await new Promise(resolve => setTimeout(resolve, 30));
    const made = basis();
    let result;
    try {
      result = await buildOutputs({
        bytes: job.file.bytes, paragraphs: job.file.paragraphs, roles, sheet: state.sheet, name: job.file.name, proposeTitles,
        ...(deciding ? {
          readText,
          onReading: ({ done, total }) => { $('output-status').textContent = `Reading the opening of each chapter: ${done} of ${total} done.`; },
          decide,
          onDecide: ({ done, total }) => { $('output-status').textContent = `Doing the work and sorting what is left for you: ${done} of ${total} parts done.`; },
        } : {}),
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
    if (deciding || runningTitlesRule(state.sheet)) void ctx.refreshStatus();
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
      ? (runningTitlesRule(state.sheet) ? 'The rule sheet asks for running titles, so the chapter titles are sent to the model to propose them.' : '')
      : 'This step needs the rule sheet (step 3) and the labels of the manuscript\'s paragraphs (step 5).';
    const estimate = ready ? decideEstimate({ paragraphs: job.file?.paragraphs, roles: ctx.roles(), sheet: state.sheet }) : { calls: 0, minutes: 0 };
    $('decide-check').disabled = !ready || job.formatting;
    $('decide-plan').textContent = ready
      ? `This takes about ${estimate.minutes === 1 ? 'a minute' : `${estimate.minutes} minutes`} and some ${estimate.calls.toLocaleString('en-US')} model calls from your allowance. The opening of each chapter, the queries found there with their paragraphs and the rules of the guidelines are sent to the model, which sorts them; code makes every change and refuses any to a title, a name, an abstract or keywords. Untick it to format only, with a comment for everything the checks find.`
      : '';
    const notices = [];
    if (error) notices.push(el('p', { className: 'notice error', id: 'output-error', role: 'alert', text: error }));
    if (!job.formatting && isStale(job.output, basis())) notices.push(el('p', { className: 'notice', id: 'output-stale', text: STALE }));
    $('output-notices').replaceChildren(...notices);
    const output = job.output;
    if (!output) { $('output').replaceChildren(); return; }
    const { summary, files } = output;
    const downloads = [
      el('h3', { id: 'downloads-title', text: 'Download' }),
      el('ul', { className: 'downloads', 'aria-labelledby': 'downloads-title' }, ...files.map(file => el('li', {},
        el('button', { type: 'button', className: file.id === 'manuscript' ? 'button primary' : 'button secondary', id: `download-${file.id}`, text: `Download ${file.name}`, 'aria-describedby': `download-${file.id}-what`, onclick: () => download(file) }),
        el('p', { className: 'help', id: `download-${file.id}-what`, text: file.label })))),
    ];
    if (summary.decide) {
      $('output').replaceChildren(...downloads,
        list('summary-changed', 'We made these changes', summary.changed),
        list('summary-decide', `You need to decide ${summary.counts.decide === 1 ? 'this thing' : `these ${summary.counts.decide} things`}`, summary.decide),
        list('summary-defaults', 'Defaults we applied because the guidelines do not say', summary.defaults),
        list('summary-copyedit', 'For the copyeditor', [summary.copyedit]),
        ...(summary.notes.length ? [list('summary-notes', 'Not done', summary.notes)] : []));
      return;
    }
    $('output').replaceChildren(...downloads,
      list('summary-changed', 'What was changed', summary.changed),
      list('summary-flagged', 'What was flagged, with a comment in the file and an item on the To-dos list', summary.flagged),
      list('summary-supply', 'What you still have to supply', summary.supply),
      ...(summary.notes.length ? [list('summary-notes', 'Not done', summary.notes)] : []));
  }

  $('format-button').addEventListener('click', () => void format());
  $('decide-check').addEventListener('change', () => ctx.changed());
  return { render };
}
