// Draws the term list editor: a filter, the entries with their status, heading, other forms, kind,
// count in the manuscript, subentries and cross-references, and the controls to accept, drop,
// rename, merge, mark ambiguous and add. Every text from the manuscript, a file or a model is set
// with textContent (through el). Nothing runs at import time.

import { el } from '../format/rules-view.js';
import { headingOf, variantsOf } from '../../lib/index/termlist.js';
import { KINDS } from '../../lib/index/terms.js';

export const PAGE_SIZE = 150;
const STATUS_LABELS = { proposed: 'To review', accepted: 'Accepted', dropped: 'Dropped' };
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const split = text => text.split(/[,;]/).map(part => part.trim()).filter(Boolean);

/** The entries a view shows, in list order. */
export function shownEntries(list, { status = 'all', kind = 'all', search = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return list.filter(entry => (status === 'all' || entry.status === status)
    && (kind === 'all' || (kind === 'name' ? entry.section === 'names' : entry.kind === kind))
    && (!needle || entry.text.toLowerCase().includes(needle)));
}

function row(entry, view, on) {
  const merging = view.mergeFrom && view.mergeFrom !== entry.id;
  const heading = el('input', { type: 'text', value: headingOf(entry.text), 'aria-label': 'Heading', className: 'term-heading', onchange: event => on.edit(entry.id, { heading: event.target.value }) });
  const variants = el('input', { type: 'text', value: variantsOf(entry.text).join(', '), 'aria-label': `Other forms of ${headingOf(entry.text)}, separated by commas`, className: 'term-variants', onchange: event => on.edit(entry.id, { variants: split(event.target.value) }) });
  const section = el('select', { 'aria-label': 'Searched as', onchange: event => on.edit(entry.id, { section: event.target.value }) },
    el('option', { value: 'terms', text: 'Term', selected: entry.section === 'terms' }), el('option', { value: 'names', text: 'Name (Last, First)', selected: entry.section === 'names' }));
  const facts = [entry.kind, Number.isInteger(entry.count) ? `${plural(entry.count, 'time', 'times')} in the manuscript` : null, entry.count === 0 ? 'not found by its own forms: add the form the text uses' : null].filter(Boolean);
  const details = el('details', { className: 'term-details' },
    el('summary', { text: `Subentries and cross-references${entry.subentries.length || entry.see.length || entry.seeAlso.length ? ` (${entry.subentries.length + entry.see.length + entry.seeAlso.length})` : ''}` }),
    el('label', { text: 'Subentries, one per line, with other forms in parentheses' }),
    el('textarea', { rows: 3, value: entry.subentries.map(sub => sub.text).join('\n'), onchange: event => on.edit(entry.id, { subentries: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }) }),
    el('label', { text: 'See (instead of this heading), separated by semicolons' }),
    el('input', { type: 'text', value: entry.see.join('; '), onchange: event => on.edit(entry.id, { see: event.target.value.split(';').map(part => part.trim()).filter(Boolean) }) }),
    el('label', { text: 'See also, separated by semicolons' }),
    el('input', { type: 'text', value: entry.seeAlso.join('; '), onchange: event => on.edit(entry.id, { seeAlso: event.target.value.split(';').map(part => part.trim()).filter(Boolean) }) }),
    ...(entry.quotes?.length ? [el('p', { className: 'help', text: 'Where the model found it:' }), el('ul', { className: 'term-quotes' }, ...entry.quotes.map(quote => el('li', { text: `“${quote}”` })))] : []));
  return el('li', { className: `term-row ${entry.status}` },
    el('div', { className: 'term-main' },
      el('span', { className: 'term-status', text: STATUS_LABELS[entry.status] ?? entry.status }),
      heading, variants, section,
      el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: entry.ambiguous, onchange: event => on.edit(entry.id, { ambiguous: event.target.checked }) }), 'Ambiguous')),
    facts.length ? el('p', { className: 'help', text: facts.join('; ') }) : null,
    el('div', { className: 'row-actions' },
      merging ? el('button', { type: 'button', className: 'button primary', text: 'Merge into this one', onclick: () => on.merge(view.mergeFrom, entry.id) }) : null,
      entry.status !== 'accepted' ? el('button', { type: 'button', className: 'button secondary', text: 'Accept', onclick: () => on.status([entry.id], 'accepted') }) : null,
      entry.status !== 'dropped' ? el('button', { type: 'button', className: 'button secondary', text: 'Drop', onclick: () => on.status([entry.id], 'dropped') }) : null,
      el('button', { type: 'button', className: 'text-button', text: view.mergeFrom === entry.id ? 'Cancel merging' : 'Merge…', onclick: () => on.view({ mergeFrom: view.mergeFrom === entry.id ? null : entry.id }) })),
    details);
}

/**
 * @param {HTMLElement} container
 * @param {object[]} list
 * @param {{ status, kind, search, limit, mergeFrom }} view
 * @param {{ status: Function, edit: Function, merge: Function, add: Function, view: Function }} on
 */
export function renderTermEditor(container, list, view, on) {
  if (!list.length) {
    container.replaceChildren(el('p', { className: 'help', text: 'No terms yet. Load a term list, paste one, or propose terms from the manuscript.' }), addForm(on));
    return;
  }
  const counts = { proposed: 0, accepted: 0, dropped: 0 };
  for (const entry of list) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const shown = shownEntries(list, view);
  const visible = shown.slice(0, view.limit ?? PAGE_SIZE);
  const mergeName = view.mergeFrom ? headingOf(list.find(entry => entry.id === view.mergeFrom)?.text ?? '') : null;
  container.replaceChildren(
    el('p', { className: 'term-counts', text: `${plural(list.length, 'entry', 'entries')}: ${counts.accepted.toLocaleString('en-US')} accepted, ${counts.proposed.toLocaleString('en-US')} to review, ${counts.dropped.toLocaleString('en-US')} dropped. The index and the downloaded list hold the accepted entries.` }),
    el('div', { className: 'review-filter' },
      el('label', { text: 'Show' }),
      el('select', { 'aria-label': 'Show entries', onchange: event => on.view({ status: event.target.value, limit: PAGE_SIZE }) },
        ...['all', 'proposed', 'accepted', 'dropped'].map(value => el('option', { value, text: value === 'all' ? 'All' : STATUS_LABELS[value], selected: (view.status ?? 'all') === value }))),
      el('select', { 'aria-label': 'Kind', onchange: event => on.view({ kind: event.target.value, limit: PAGE_SIZE }) },
        ...['all', 'name', ...KINDS].map(value => el('option', { value, text: value === 'all' ? 'Every kind' : value === 'name' ? 'Names' : value, selected: (view.kind ?? 'all') === value }))),
      el('input', { type: 'search', placeholder: 'Find', 'aria-label': 'Find an entry', value: view.search ?? '', onchange: event => on.view({ search: event.target.value, limit: PAGE_SIZE }) })),
    el('div', { className: 'row-actions' },
      el('button', { type: 'button', className: 'button secondary', text: `Accept the ${plural(shown.length, 'entry', 'entries')} shown`, onclick: () => on.status(shown.map(entry => entry.id), 'accepted') }),
      el('button', { type: 'button', className: 'button secondary', text: `Drop the ${plural(shown.length, 'entry', 'entries')} shown`, onclick: () => on.status(shown.map(entry => entry.id), 'dropped') })),
    mergeName !== null ? el('p', { className: 'notice info', text: `Choose the entry to merge “${mergeName}” into: its heading and forms become that entry's other forms.` }) : '',
    el('ul', { className: 'term-list' }, ...visible.map(entry => row(entry, view, on))),
    shown.length > visible.length ? el('button', { type: 'button', className: 'button secondary', text: `Show ${Math.min(PAGE_SIZE, shown.length - visible.length)} more`, onclick: () => on.view({ limit: (view.limit ?? PAGE_SIZE) + PAGE_SIZE }) }) : '',
    addForm(on));
}

function addForm(on) {
  const heading = el('input', { type: 'text', id: 'add-heading' });
  const variants = el('input', { type: 'text', id: 'add-variants' });
  const section = el('select', { id: 'add-section' }, el('option', { value: 'terms', text: 'Term' }), el('option', { value: 'names', text: 'Name (Last, First)' }));
  return el('form', { className: 'add-rule', onsubmit: event => { event.preventDefault(); on.add({ heading: heading.value, variants: split(variants.value), section: section.value }); } },
    el('h3', { text: 'Add an entry' }),
    el('label', { for: 'add-heading', text: 'Heading' }), heading,
    el('label', { for: 'add-variants', text: 'Other forms to search for, separated by commas' }), variants,
    el('label', { for: 'add-section', text: 'Searched as' }), section,
    el('div', { className: 'row-actions' }, el('button', { type: 'submit', className: 'button secondary', text: 'Add' })));
}
