// Renders the rule sheet's rules: the conflicts, then the rules under their category headings, each
// with its settings, mode menu, on/off switch, Edit and Remove; and the "Add a rule" form. Every text from the
// sheet (model output or an uploaded file) is set with textContent. Nothing here runs at import
// time, so the module also loads under Node.

import { CATEGORIES, SLOTS, categoriesFor } from '../../lib/rules/schema.js';

export const MODE_LABELS = Object.freeze({ fix: 'Fix automatically', flag: 'Leave a comment', supply: 'Add to my To-dos' });

// Plain words for each setting a rule can carry, and for the values of the fixed lists.
const SETTINGS = {
  'quotes.primary': { style: ['Quotation marks', { double: 'Double (“ ”)', single: 'Single (‘ ’)' }] },
  'quotes.punctuation': { inside: ['Commas and periods go inside closing quotation marks'] },
  'blockquote.threshold': { words: ['Set off quotations longer than this many words'], lines: ['Set off quotations longer than this many lines'] },
  'dash.ranges': { dash: ['Mark in number ranges', { en: 'En dash (–)', hyphen: 'Hyphen (-)' }] },
  'comma.serial': { use: ['Use the serial (Oxford) comma'] },
  'ellipsis.form': { form: ['Ellipsis', { character: 'One character (…)', 'three-dots': 'Three periods (...)', spaced: 'Spaced periods (. . .)' }] },
  'spelling.variety': { variety: ['Spelling', { us: 'American', uk: 'British', oxford: 'British with -ize (Oxford)', ca: 'Canadian', au: 'Australian' }] },
  'numbers.spellout': { below: ['Spell out numbers below'] },
  'percent.form': { form: ['Percentages', { percent: '“percent”', 'per cent': '“per cent”', '%': 'The % sign' }] },
  'centuries.form': { form: ['Centuries', { spelled: 'In words (twentieth century)', numeral: 'In figures (20th century)' }] },
  'headings.case': { case: ['Capitals in headings', { title: 'Title case', sentence: 'Sentence case' }] },
  'headings.numbering': { scheme: ['Section headings', { decimal: 'Numbered (1, 1.1)', none: 'Not numbered' }] },
  'titles.quotes': { allowed: ['Quotation marks allowed in chapter titles'] },
  'chapters.subtitle': { split: ['Split a long chapter title into a title and a subtitle'] },
  'figures.numbering': { per: ['Figure numbers', { chapter: 'By chapter (2.1, 2.2)', document: 'Through the whole work' }] },
  'figures.markers': { example: ['Placement marker for each figure, as the guidelines show it'] },
  'figures.files': { separate: ['Each figure supplied as a separate image file'] },
  'figures.callouts': { required: ['Every figure and table referred to in the text (see Fig. 1)'] },
  'notes.kind': { kind: ['Notes', { footnotes: 'Footnotes', endnotes: 'Endnotes' }] },
  'notes.restart': { per: ['Note numbers', { chapter: 'Start again in each chapter', none: 'Run through the whole work' }] },
  'notes.titles': { allowed: ['Notes allowed on chapter titles and author names'] },
  'references.repeated-author': { form: ['A repeated author in the reference list', { name: 'The full name every time', dash: 'A dash after the first entry' }] },
  'citations.system': { system: ['Citation style', { 'notes-bibliography': 'Notes and bibliography', 'author-date': 'Author-date', mla: 'MLA', apa: 'APA', numbered: 'Numbered', other: 'Another style' }] },
  'layout.font': { family: ['Font'], sizePt: ['Font size in points'] },
  'layout.spacing': { line: ['Line spacing (1 is single, 2 is double)'] },
  'layout.margins': { inches: ['Margins in inches'] },
  'length.words': { max: ['Most words allowed'], min: ['Fewest words allowed'] },
  'running-title.length': { max: ['Most characters in a running title'] },
  'abstract.words': { max: ['Most words in the abstract'] },
  'keywords.count': { min: ['Fewest keywords'], max: ['Most keywords'] },
  'contributors.words': { max: ['About how many words in a note on a contributor'] },
  'anonymize': { required: ['Remove the authors’ names for anonymous review'] },
};

export const settingLabel = (slot, name) => SETTINGS[slot]?.[name]?.[0] ?? name;
export const valueLabel = (slot, name, value) => SETTINGS[slot]?.[name]?.[1]?.[value] ?? String(value);

// A rule's settings as its row shows them, one line each, with the Edit form's labels:
// "Quotation marks: Single (‘ ’)", "Use the serial (Oxford) comma: Yes", "Font: not given".
export function settingsInWords(slot, params) {
  if (slot === null || !SLOTS[slot]) return [];
  return Object.keys(SLOTS[slot].params).map(name => {
    const value = params?.[name];
    const words = value === null || value === undefined ? 'not given'
      : typeof value === 'boolean' ? (value ? 'Yes' : 'No')
        : typeof value === 'number' ? value.toLocaleString('en-US') : valueLabel(slot, name, value);
    return `${settingLabel(slot, name)}: ${words}`;
  });
}

function settingsList(rule) {
  const lines = settingsInWords(rule.slot, rule.params);
  return lines.length ? el('ul', { className: 'rule-settings', 'aria-label': 'Settings' }, ...lines.map(line => el('li', { text: line }))) : null;
}

// What kind of control a setting needs, read from its validator's `allowed` description.
export function fieldKind(validator) {
  let allowed = validator.allowed;
  const nullable = allowed.endsWith(', or null');
  if (nullable) allowed = allowed.slice(0, -', or null'.length);
  if (allowed === 'true | false') return { type: 'boolean', nullable };
  if (allowed.startsWith('"')) return { type: 'list', nullable, values: allowed.split(' | ').map(value => JSON.parse(value)) };
  let match = /^whole number (\d+)(?: to (\d+)| or more)$/.exec(allowed);
  if (match) return { type: 'number', nullable, whole: true, min: Number(match[1]), max: match[2] === undefined ? null : Number(match[2]) };
  match = /^number ([\d.]+) to ([\d.]+)$/.exec(allowed);
  if (match) return { type: 'number', nullable, whole: false, min: Number(match[1]), max: Number(match[2]) };
  match = /^text of (\d+) to (\d+) characters$/.exec(allowed);
  if (match) return { type: 'text', nullable, min: Number(match[1]), max: Number(match[2]) };
  return { type: 'text', nullable, min: 0, max: Infinity };
}

function kindInWords(kind) {
  const range = kind.max === null ? `${kind.min} or more` : `from ${kind.min} to ${kind.max}`;
  const base = kind.type === 'number' ? `${kind.whole ? 'a whole number' : 'a number'} ${range}`
    : kind.type === 'text' ? `between ${kind.min} and ${kind.max} characters` : 'one of the choices';
  return kind.nullable ? `${base}, or leave it empty` : base;
}

// A validateRule reason in plain words.
export function plainReason(reason, slot) {
  if (reason === 'statement') return 'Write the rule in 1 to 500 characters.';
  if (reason === 'mode: fix needs a slot') return 'Only rules with settings can be fixed automatically. Choose another option.';
  if (reason === 'params: words or lines') return 'Fill in at least one of the two numbers.';
  const match = /^params\.([A-Za-z]+): /.exec(reason);
  if (match && SLOTS[slot]?.params[match[1]]) {
    return `${settingLabel(slot, match[1])}: enter ${kindInWords(fieldKind(SLOTS[slot].params[match[1]]))}.`;
  }
  return 'This change could not be made. Check the rule and try again.';
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

// Category headings in table order, with `other` ("Other requirements") always last.
export function orderedCategories(docType) {
  const list = docType ? categoriesFor(docType) : [...CATEGORIES];
  return [...list.filter(entry => entry.id !== 'other'), ...list.filter(entry => entry.id === 'other')];
}

function sourceLine(source) {
  // A quotation is shown exactly as stored, "…" and all, so skipped words are visible.
  if (source.kind === 'guidelines') return el('p', { className: 'rule-source', text: `“${source.quote}”` });
  if (source.kind === 'manual') return el('p', { className: 'rule-source', text: `From ${source.manual}, section ${source.section}` });
  return el('p', { className: 'rule-source', text: 'Added by you' });
}

function modeMenu(rule, id, onChange) {
  const canFix = rule.slot !== null && rule.category !== 'other';
  const select = el('select', { id, onchange: () => onChange(select.value) },
    ...Object.entries(MODE_LABELS).map(([value, label]) => el('option', { value, text: label, disabled: value === 'fix' && !canFix })));
  select.value = rule.mode;
  return select;
}

// The edit form: the rule's wording and, for a rule with settings, one control per setting.
function editForm(rule, actions) {
  const base = `edit-${rule.id}`;
  const error = el('p', { className: 'field-error', id: `${base}-error`, role: 'alert' });
  const statement = el('textarea', { id: `${base}-statement`, rows: 3, maxLength: 500 });
  statement.value = rule.statement;
  const reads = [];
  const fields = Object.entries(rule.slot === null ? {} : SLOTS[rule.slot].params).map(([name, validator]) => {
    const kind = fieldKind(validator);
    const id = `${base}-${name}`;
    const current = rule.params[name];
    if (kind.type === 'boolean') {
      const box = el('input', { type: 'checkbox', id, checked: current === true });
      reads.push(() => [name, box.checked]);
      return el('div', { className: 'check' }, box, el('label', { for: id, text: settingLabel(rule.slot, name) }));
    }
    let control;
    if (kind.type === 'list') {
      control = el('select', { id }, ...kind.values.map(value => el('option', { value, text: valueLabel(rule.slot, name, value) })));
      control.value = current;
      reads.push(() => [name, control.value]);
    } else {
      control = el('input', { id, type: kind.type === 'number' ? 'number' : 'text', ...(kind.type === 'number' ? { min: kind.min, max: kind.max ?? undefined, step: kind.whole ? 1 : 'any' } : {}) });
      control.value = current === null || current === undefined ? '' : String(current);
      reads.push(() => {
        const raw = control.value.trim();
        if (raw === '' && kind.nullable) return [name, null];
        return [name, kind.type === 'number' ? (raw === '' ? NaN : Number(raw)) : raw];
      });
    }
    const help = kind.nullable ? el('p', { className: 'help', id: `${id}-help`, text: 'Leave it empty if the guidelines do not say.' }) : null;
    if (help) control.setAttribute('aria-describedby', help.id);
    return el('div', { className: 'field' }, el('label', { for: id, text: settingLabel(rule.slot, name) }), control, help);
  });
  const save = () => {
    const message = actions.saveEdit(rule.id, { statement: statement.value.trim(), params: Object.fromEntries(reads.map(read => read())) });
    error.textContent = message ?? '';
  };
  return el('div', { className: 'rule-edit' },
    el('label', { for: statement.id, text: 'Rule' }), statement, ...fields, error,
    el('div', { className: 'row-actions' },
      el('button', { type: 'button', className: 'button primary', text: 'Save', onclick: save }),
      el('button', { type: 'button', className: 'button secondary', text: 'Cancel', onclick: () => actions.cancelEdit(rule.id) })));
}

function ruleRow(rule, view, actions) {
  const statementId = `rule-${rule.id}-statement`;
  const switchId = `rule-${rule.id}-on`;
  const modeId = `rule-${rule.id}-mode`;
  const row = el('li', { className: rule.enabled ? 'rule' : 'rule off', id: `rule-${rule.id}` });
  const toggle = el('input', { type: 'checkbox', role: 'switch', id: switchId, checked: rule.enabled, 'aria-describedby': statementId,
    onchange: () => { row.classList.toggle('off', !toggle.checked); actions.toggle(rule.id, toggle.checked); } });
  row.append(
    el('p', { className: 'rule-statement', id: statementId, text: rule.statement }),
    sourceLine(rule.source),
    ...[settingsList(rule)].filter(Boolean),
    el('div', { className: 'rule-controls' },
      el('div', { className: 'field mode-field' }, el('label', { for: modeId, text: 'What to do' }), modeMenu(rule, modeId, mode => actions.setMode(rule.id, mode))),
      el('div', { className: 'check switch' }, toggle, el('label', { for: switchId, text: 'Use this rule' })),
      el('div', { className: 'row-actions' },
        el('button', { type: 'button', className: 'text-button', id: `rule-${rule.id}-edit`, text: 'Edit', 'aria-describedby': statementId, 'aria-expanded': String(view.editingId === rule.id), onclick: () => actions.startEdit(rule.id) }),
        el('button', { type: 'button', className: 'text-button danger', text: 'Remove', 'aria-describedby': statementId, onclick: () => actions.remove(rule.id) }))));
  if (view.editingId === rule.id) row.append(editForm(rule, actions));
  return row;
}

// The sheet's rules as the page draws them, each exactly once: rules that disagree, grouped by
// setting (only rules with a setting can be marked so); then the rest under their category headings,
// in table order with "Other requirements" last. A rule whose category the sheet's document type does
// not offer is shown under "Other requirements", so no rule in the sheet is ever out of sight.
export function groupRules(sheet) {
  const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
  const categories = orderedCategories(sheet?.docType);
  const offered = new Set(categories.map(entry => entry.id));
  const bySlot = new Map();
  const byCategory = new Map();
  for (const rule of rules) {
    if (rule.conflict === true && typeof rule.slot === 'string') bySlot.set(rule.slot, [...(bySlot.get(rule.slot) ?? []), rule]);
    else {
      const category = offered.has(rule.category) ? rule.category : 'other';
      byCategory.set(category, [...(byCategory.get(category) ?? []), rule]);
    }
  }
  return {
    conflicts: [...bySlot.entries()].map(([slot, group]) => ({ slot, rules: group })),
    sections: categories.filter(entry => byCategory.has(entry.id)).map(category => ({ category, rules: byCategory.get(category.id) })),
  };
}

function conflictBlock(conflicts, actions) {
  return el('section', { className: 'conflicts', 'aria-labelledby': 'conflicts-title' },
    el('h3', { id: 'conflicts-title', text: 'The guidelines say two different things' }),
    el('p', { className: 'help', text: 'Choose the rule to keep in each case. The others are removed.' }),
    ...conflicts.map(({ slot, rules }) => {
      const title = `conflict-${String(slot).replace(/[^a-z0-9]+/g, '-')}`;
      return el('div', { className: 'conflict', role: 'group', 'aria-labelledby': title },
        el('h4', { id: title, text: SETTINGS[slot] ? Object.values(SETTINGS[slot])[0][0] : 'Settings that disagree' }),
        el('ul', { className: 'rule-list' }, ...rules.map(rule => el('li', { className: 'rule' },
          el('p', { className: 'rule-statement', id: `rule-${rule.id}-statement`, text: rule.statement }),
          sourceLine(rule.source),
          settingsList(rule),
          el('button', { type: 'button', className: 'button secondary', text: 'Keep this rule', 'aria-describedby': `rule-${rule.id}-statement`, onclick: () => actions.keep(rule.id) })))));
    }));
}

// Fills `container` with the sheet's rules. view: { sheet, editingId }.
export function renderRules(container, view, actions) {
  const { conflicts, sections } = groupRules(view.sheet);
  container.replaceChildren(
    ...(conflicts.length ? [conflictBlock(conflicts, actions)] : []),
    ...sections.map(({ category, rules }) => el('section', { className: 'category', 'aria-labelledby': `category-${category.id}` },
      el('h3', { id: `category-${category.id}`, text: category.label }),
      el('ul', { className: 'rule-list' }, ...rules.map(rule => ruleRow(rule, view, actions))))));
}

// The "Add a rule" form for the given document type. The new rule has no settings, so it is a
// comment or a To-do, never fixed automatically.
export function renderAddRule(container, { docType, open }, actions) {
  if (!open) {
    container.replaceChildren(el('button', { type: 'button', className: 'button secondary', id: 'add-rule-button', text: 'Add a rule', onclick: actions.open }));
    return;
  }
  const category = el('select', { id: 'add-rule-category' }, ...orderedCategories(docType).map(entry => el('option', { value: entry.id, text: entry.label })));
  const statement = el('textarea', { id: 'add-rule-statement', rows: 3, maxLength: 500 });
  const mode = el('select', { id: 'add-rule-mode' }, ...Object.entries(MODE_LABELS).map(([value, label]) => el('option', { value, text: label, disabled: value === 'fix' })));
  mode.value = 'flag';
  const error = el('p', { className: 'field-error', role: 'alert' });
  const add = () => { error.textContent = actions.add({ category: category.value, statement: statement.value.trim(), mode: mode.value }) ?? ''; };
  container.replaceChildren(el('div', { className: 'add-rule', role: 'group', 'aria-labelledby': 'add-rule-title' },
    el('h3', { id: 'add-rule-title', text: 'Add a rule' }),
    el('div', { className: 'field' }, el('label', { for: category.id, text: 'Kind of rule' }), category),
    el('div', { className: 'field' }, el('label', { for: statement.id, text: 'Rule' }), statement),
    el('div', { className: 'field' }, el('label', { for: mode.id, text: 'What to do' }), mode),
    error,
    el('div', { className: 'row-actions' },
      el('button', { type: 'button', className: 'button primary', text: 'Add', onclick: add }),
      el('button', { type: 'button', className: 'button secondary', text: 'Cancel', onclick: actions.close }))));
  category.focus();
}

