// Draws the term list editor in two groups, Names (people, searched for in the order the text uses)
// and Subjects (everything else, searched for as written), each with its counts, the thresholds
// that apply to it and its entries: status, heading, other forms, count in the manuscript,
// subentries and cross-references, and the controls to accept, drop, rename, merge, mark ambiguous
// and move to the other group. Proposals are ranked and those below the author's threshold
// (lib/index/rank.js) are hidden until asked for. Every text from the manuscript, a file or a model
// is set with textContent (through el). Nothing runs at import time.

import { el } from '../format/rules-view.js';
import { headingOf, variantsOf } from '../../lib/index/termlist.js';
import { reverseName } from '../../lib/index/indexer.js';
import { KINDS } from '../../lib/index/terms.js';
import { DEFAULT_FILTER, PAGE_CHOICES, passesFilter, rankEntries } from '../../lib/index/rank.js';
import { GROUPS, GROUP_LABELS, invertedSubjects } from './state.js';

export const PAGE_SIZE = 150;
const STATUS_LABELS = { proposed: 'To review', accepted: 'Accepted', dropped: 'Dropped' };
export const KIND_LABELS = Object.freeze({ person: 'person', place: 'place', organization: 'organization', work: 'title of a work', event: 'event', concept: 'concept' });
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const split = text => text.split(/[,;]/).map(part => part.trim()).filter(Boolean);
const NOUN = { names: ['name', 'names'], terms: ['subject', 'subjects'] };
const counted = (group, n) => plural(n, ...NOUN[group]);

/** The view the page starts with: shared status, search and order; per group, the threshold's toggle, the length shown and (for subjects) the kind. */
export const newView = () => ({ status: 'all', search: '', order: 'rank', mergeFrom: null, keepInverted: false, groups: { names: { below: false, limit: PAGE_SIZE }, terms: { below: false, limit: PAGE_SIZE, kind: 'all' } } });

/**
 * The entries a view shows: by group, status, kind and search, then, unless `below` asks for them,
 * without the proposals under the filter's threshold; ranked (lib/index/rank.js) or in list order.
 * @returns {{ shown: object[], below: number }} below: the proposals the threshold hides
 */
export function viewEntries(list, { status = 'all', kind = 'all', search = '', below = false, order = 'rank', group = 'all' } = {}, filter = DEFAULT_FILTER) {
  const needle = search.trim().toLowerCase();
  const matching = list.filter(entry => (group === 'all' || entry.section === group)
    && (status === 'all' || entry.status === status)
    && (kind === 'all' || (kind === 'name' ? entry.section === 'names' : entry.kind === kind))
    && (!needle || entry.text.toLowerCase().includes(needle)));
  const passing = matching.filter(entry => passesFilter(entry, filter));
  const shown = below ? matching : passing;
  return { shown: order === 'rank' ? rankEntries(shown) : shown, below: matching.length - passing.length };
}

/** The entries a view shows (the threshold aside), in list order. */
export const shownEntries = (list, view = {}) => viewEntries(list, { ...view, below: true, order: 'list' }).shown;

/** One group's view, from the page's view. */
export const groupView = (view, group) => ({ status: view.status, search: view.search, order: view.order, group, below: view.groups?.[group]?.below === true, kind: group === 'terms' ? view.groups?.terms?.kind ?? 'all' : 'all' });

function row(entry, view, on) {
  const merging = view.mergeFrom && view.mergeFrom !== entry.id;
  const isName = entry.section === 'names';
  const shownHeading = headingOf(entry.text);
  const heading = el('input', { type: 'text', value: shownHeading, 'aria-label': isName ? 'Name as the index prints it, surname first' : 'Heading as the index prints it', className: 'term-heading', onchange: event => on.edit(entry.id, { heading: event.target.value }) });
  const variants = el('input', { type: 'text', value: variantsOf(entry.text).join(', '), placeholder: 'Other forms to search for', 'aria-label': `Other forms of ${shownHeading} to search for, separated by commas`, className: 'term-variants', onchange: event => on.edit(entry.id, { variants: split(event.target.value) }) });
  const other = isName ? 'terms' : 'names';
  const move = el('button', { type: 'button', className: 'button secondary term-move', text: `Move to ${GROUP_LABELS[other]}`, 'aria-label': `Move ${shownHeading} to ${GROUP_LABELS[other]}`, onclick: () => on.move(entry.id, other) });
  const searched = isName ? reverseName(shownHeading)[0] : null;
  const facts = [
    isName && searched !== shownHeading ? `found in the text as “${searched}”` : null,
    entry.moved ? 'moved here by you' : !isName && entry.kind ? KIND_LABELS[entry.kind] ?? entry.kind : null,
    Number.isInteger(entry.count) ? `${plural(entry.count, 'time', 'times')} in the manuscript` : null,
    Number.isInteger(entry.spread) && entry.count > 0 ? `on about ${plural(entry.spread, 'page', 'pages')}` : null,
    entry.discussed > 0 ? `discussed in ${plural(entry.discussed, 'passage', 'passages')}` : null,
    entry.inHeading ? 'in a heading' : null,
    entry.count === 0 ? 'not found by its own forms: add the form the text uses' : null,
  ].filter(Boolean);
  const details = el('details', { className: 'term-details' },
    el('summary', { text: `Subentries and cross-references${entry.subentries.length || entry.see.length || entry.seeAlso.length ? ` (${entry.subentries.length + entry.see.length + entry.seeAlso.length})` : ''}` }),
    el('label', { text: 'Subentries: narrower headings printed under this one, one per line, with other forms in parentheses' }),
    el('textarea', { rows: 3, value: entry.subentries.map(sub => sub.text).join('\n'), onchange: event => on.edit(entry.id, { subentries: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) }) }),
    el('label', { text: 'See: the heading readers should look under instead of this one (separate several with semicolons)' }),
    el('input', { type: 'text', value: entry.see.join('; '), onchange: event => on.edit(entry.id, { see: event.target.value.split(';').map(part => part.trim()).filter(Boolean) }) }),
    el('label', { text: 'See also: related headings (separate several with semicolons)' }),
    el('input', { type: 'text', value: entry.seeAlso.join('; '), onchange: event => on.edit(entry.id, { seeAlso: event.target.value.split(';').map(part => part.trim()).filter(Boolean) }) }),
    ...(entry.quotes?.length ? [el('p', { className: 'help', text: 'Where the model found it:' }), el('ul', { className: 'term-quotes' }, ...entry.quotes.map(quote => el('li', { text: `“${quote}”` })))] : []));
  return el('li', { className: `term-row ${entry.status}` },
    el('div', { className: 'term-main' },
      el('span', { className: 'term-status', text: STATUS_LABELS[entry.status] ?? entry.status }),
      heading, variants,
      el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: entry.ambiguous, onchange: event => on.edit(entry.id, { ambiguous: event.target.checked }) }), 'Ambiguous')),
    facts.length ? el('p', { className: 'help term-facts', text: facts.join('; ') }) : null,
    el('div', { className: 'row-actions' },
      merging ? el('button', { type: 'button', className: 'button primary', text: 'Merge into this one', onclick: () => on.merge(view.mergeFrom, entry.id) }) : null,
      entry.status !== 'accepted' ? el('button', { type: 'button', className: 'button secondary', text: 'Accept', onclick: () => on.status([entry.id], 'accepted') }) : null,
      entry.status !== 'dropped' ? el('button', { type: 'button', className: 'button secondary', text: 'Drop', onclick: () => on.status([entry.id], 'dropped') }) : null,
      move,
      el('button', { type: 'button', className: 'text-button', text: view.mergeFrom === entry.id ? 'Cancel merging' : 'Merge…', onclick: () => on.view({ mergeFrom: view.mergeFrom === entry.id ? null : entry.id }) })),
    details);
}

const pagesSelect = (id, value, every, onchange) => el('select', { id, onchange: event => onchange(Number(event.target.value)) },
  ...PAGE_CHOICES.map(pages => el('option', { value: String(pages), text: pages === 1 ? `1 page (${every})` : `${pages} pages`, selected: value === pages })));

function thresholds(group, filter, below, groupState, on) {
  const status = below
    ? `${plural(below, 'proposal is', 'proposals are')} below this and not shown. They stay in the list.`
    : groupState.below ? 'Every proposal is shown, those below the thresholds too.' : 'Every proposal passes this.';
  const controls = group === 'names'
    ? [el('label', { for: 'threshold-people', text: 'Show proposed people named on at least' }), pagesSelect('threshold-people', filter.people ?? filter.names, 'every person', pages => on.filter({ people: pages }))]
    : [el('label', { for: 'threshold-concepts', text: 'Show proposed concepts on at least' }), pagesSelect('threshold-concepts', filter.concepts, 'every concept', pages => on.filter({ concepts: pages })),
      el('label', { for: 'threshold-names', text: 'Show proposed places, organizations, titles and events on at least' }), pagesSelect('threshold-names', filter.names, 'every one', pages => on.filter({ names: pages }))];
  return el('fieldset', { className: 'plain review-filter threshold' },
    el('legend', { text: 'Which proposals to show, by how many pages of the manuscript they are on' }),
    ...controls,
    el('p', { className: 'help', id: `threshold-status-${group}`, text: status }),
    below || groupState.below ? el('button', { type: 'button', className: 'button secondary', id: `threshold-toggle-${group}`, text: groupState.below ? 'Hide the proposals below the thresholds' : `Show the ${plural(below, 'proposal', 'proposals')} below the thresholds`, onclick: () => on.group(group, { below: !groupState.below, limit: PAGE_SIZE }) }) : null);
}

function groupSection(group, list, view, on, filter) {
  const own = list.filter(entry => entry.section === group);
  const groupState = view.groups[group];
  const counts = { proposed: 0, accepted: 0, dropped: 0 };
  for (const entry of own) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const { shown, below } = viewEntries(list, groupView(view, group), filter);
  const visible = shown.slice(0, groupState.limit ?? PAGE_SIZE);
  const titleId = `group-title-${group}`;
  const kinds = group === 'terms' ? KINDS.filter(kind => kind !== 'person' || own.some(entry => entry.kind === 'person')) : [];
  const inverted = group === 'terms' && !view.keepInverted ? invertedSubjects(list) : [];
  const children = [
    el('h3', { id: titleId, text: `${GROUP_LABELS[group]} (${own.length.toLocaleString('en-US')})` }),
    el('p', { className: 'help', text: group === 'names'
      ? 'People. The index prints each surname first; the proofs are searched for the name in the order the text uses, as in “Mary Shelley”.'
      : 'Concepts, places, organizations, events and titles of works. Each is searched for as it is written here, and by the other forms beside it.' }),
  ];
  if (!own.length) {
    children.push(el('p', { className: 'help', text: group === 'names' ? 'No names yet.' : 'No subjects yet.' }));
    return el('section', { className: 'term-group', id: `group-${group}`, 'aria-labelledby': titleId }, ...children);
  }
  children.push(el('p', { className: 'group-counts', text: `${counted(group, own.length)}: ${counts.accepted.toLocaleString('en-US')} accepted, ${counts.proposed.toLocaleString('en-US')} to review, ${counts.dropped.toLocaleString('en-US')} dropped.` }));
  if (kinds.length && own.some(entry => entry.kind)) {
    children.push(el('div', { className: 'review-filter' },
      el('label', { for: 'kind-terms', text: 'Kind of subject' }),
      el('select', { id: 'kind-terms', onchange: event => on.group('terms', { kind: event.target.value, limit: PAGE_SIZE }) },
        ...['all', ...kinds].map(value => el('option', { value, text: value === 'all' ? 'Every kind' : KIND_LABELS[value], selected: (groupState.kind ?? 'all') === value })))));
  }
  if (counts.proposed) children.push(thresholds(group, filter, below, groupState, on));
  if (inverted.length) {
    const example = headingOf(inverted[0].text);
    children.push(el('div', { className: 'notice info', id: 'inverted-notice' },
      el('p', { text: `${plural(inverted.length, 'subject reads', 'subjects read')} like a person's name written surname first, such as “${example}”. A subject is searched for exactly as it is written, so “${reverseName(example)[0]}” in the text is not found; a name is.` }),
      el('div', { className: 'row-actions' },
        el('button', { type: 'button', className: 'button secondary', text: `Move ${inverted.length === 1 ? 'it' : `these ${inverted.length.toLocaleString('en-US')}`} to Names`, onclick: () => on.moveAll(inverted.map(entry => entry.id), 'names') }),
        el('button', { type: 'button', className: 'text-button', text: 'Leave them as subjects', onclick: () => on.view({ keepInverted: true }) }))));
  }
  children.push(
    shown.length ? el('div', { className: 'row-actions' },
      el('button', { type: 'button', className: 'button secondary', text: `Accept the ${counted(group, shown.length)} shown`, onclick: () => on.status(shown.map(entry => entry.id), 'accepted') }),
      el('button', { type: 'button', className: 'button secondary', text: `Drop the ${counted(group, shown.length)} shown`, onclick: () => on.status(shown.map(entry => entry.id), 'dropped') })) : el('p', { className: 'help', text: 'None shown with these choices.' }),
    el('ul', { className: 'term-list', 'aria-labelledby': titleId }, ...visible.map(entry => row(entry, view, on))),
    shown.length > visible.length ? el('button', { type: 'button', className: 'button secondary', text: `Show ${Math.min(PAGE_SIZE, shown.length - visible.length)} more`, onclick: () => on.group(group, { limit: (groupState.limit ?? PAGE_SIZE) + PAGE_SIZE }) }) : null);
  return el('section', { className: 'term-group', id: `group-${group}`, 'aria-labelledby': titleId }, ...children);
}

/**
 * @param {HTMLElement} container
 * @param {object[]} list
 * @param {ReturnType<typeof newView>} view
 * @param {{ status: Function, edit: Function, merge: Function, move: Function, moveAll: Function, view: Function, group: Function, filter: Function }} on
 * @param {{ concepts: number, names: number, people?: number }} filter the thresholds, kept with the settings
 */
export function renderTermEditor(container, list, view, on, filter = DEFAULT_FILTER) {
  if (!list.length) {
    container.replaceChildren(el('p', { className: 'help', text: 'Nothing in the list yet. Type names and subjects in the boxes above, load a term list, or let a model propose them from your manuscript.' }));
    return;
  }
  const counts = { proposed: 0, accepted: 0, dropped: 0 };
  for (const entry of list) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const mergeName = view.mergeFrom ? headingOf(list.find(entry => entry.id === view.mergeFrom)?.text ?? '') : null;
  container.replaceChildren(
    el('h3', { text: 'Your list' }),
    el('p', { className: 'term-counts', text: `${plural(list.length, 'entry', 'entries')}: ${counts.accepted.toLocaleString('en-US')} accepted, ${counts.proposed.toLocaleString('en-US')} to review, ${counts.dropped.toLocaleString('en-US')} dropped. Only accepted entries go into the index and the downloaded list.` }),
    el('div', { className: 'review-filter' },
      el('label', { for: 'show-status', text: 'Show' }),
      el('select', { id: 'show-status', onchange: event => on.view({ status: event.target.value }) },
        ...['all', 'proposed', 'accepted', 'dropped'].map(value => el('option', { value, text: value === 'all' ? 'All' : STATUS_LABELS[value], selected: (view.status ?? 'all') === value }))),
      el('input', { type: 'search', placeholder: 'Find', 'aria-label': 'Find an entry', value: view.search ?? '', onchange: event => on.view({ search: event.target.value }) }),
      el('select', { 'aria-label': 'Order', onchange: event => on.view({ order: event.target.value }) },
        el('option', { value: 'rank', text: 'Most frequent first', selected: (view.order ?? 'rank') === 'rank' }), el('option', { value: 'list', text: 'In list order', selected: view.order === 'list' }))),
    mergeName !== null ? el('p', { className: 'notice info', text: `Choose the entry to merge “${mergeName}” into: its heading and forms become that entry's other forms.` }) : '',
    ...GROUPS.map(group => groupSection(group, list, view, on, filter)));
}
