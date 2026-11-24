// The agent's tools over a manuscript's document model (spike, not product code). The model never
// writes XML: it inspects paragraphs and records operations in a spec; code validates every
// operation here, and scripts/spikes/agent/execute.mjs applies the spec to the .docx. Words change
// only through replace_text and delete_paragraphs, each declared with what it removes and adds, so
// the formatter's guarantee (no word changes unless declared) still holds and is checked after.
//
// The state is plain data: { paragraphs: [{ index, text, empty }], roles: { index: role },
// findings: [{ id, kind, paragraph, chapter, message }], rules: [{ id, statement, mode, slot }],
// settings: { slot: params } (what the sheet sets), chapters: [...] }. A session records:
// spec (the operations accepted), refused (with the reason), and stats for scoring.

import { ROLE_IDS } from '../../../lib/roles/roles.js';
import { SLOTS } from '../../../lib/rules/schema.js';

const MAX_READ = 60;
const MAX_TEXT = 400;
// Settings the agent may set: the ones the formatter applies. Others are not offered.
export const AGENT_SLOTS = ['notes.restart', 'headings.numbering', 'headings.case', 'chapters.subtitle', 'chapters.label', 'figures.markers', 'figures.numbering', 'references.repeated-author', 'references.hanging-indent', 'layout.spacing', 'layout.margins', 'layout.page-numbers', 'layout.font', 'chapters.new-page'];

const fn = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const int = { type: 'integer' };
const str = { type: 'string' };

export const TOOLS = [
  fn('read_paragraphs', `Read paragraphs from..to (at most ${MAX_READ}): each line is [index] (role) text, text cut at ${MAX_TEXT} characters.`, { from: int, to: int }),
  fn('find_text', 'List the paragraphs (at most 20) whose text contains these characters, ignoring case.', { text: str }),
  fn('set_roles', 'Change the role of paragraphs. The formatter styles each paragraph by its role.', { changes: { type: 'array', items: { type: 'object', properties: { paragraph: int, role: { type: 'string', enum: ROLE_IDS } }, required: ['paragraph', 'role'] } }, reason: str }),
  fn('set_setting', `Set a formatting setting the formatter applies. Use source "guidelines" when the guidelines state it, "default" when they are silent and you choose a sensible submission default. Settings: ${AGENT_SLOTS.map(id => `${id} (${Object.entries(SLOTS[id].params).map(([name, check]) => `${name}: ${check.allowed}`).join('; ')})`).join(', ')}.`, { slot: { type: 'string', enum: AGENT_SLOTS }, params: { type: 'object' }, source: { type: 'string', enum: ['guidelines', 'default'] }, reason: str }),
  fn('clear_setting', 'Remove a setting the rule sheet holds when it was misread from the guidelines (say why).', { slot: { type: 'string', enum: AGENT_SLOTS }, reason: str }),
  fn('replace_text', 'A formatting-level text fix in one paragraph, made as a tracked change and listed for the author: "before" must occur exactly once in the paragraph, as it stands. Never use it to copyedit the authors\' prose.', { paragraph: int, before: str, after: str, reason: str }),
  fn('delete_paragraphs', 'Delete paragraphs from..to as a tracked deletion listed for the author (a typed contents list that a generated one replaces, a stray duplicate, a stray character).', { from: int, to: int, reason: str }),
  fn('insert_contents', 'Insert a generated table of contents (a Word TOC field built from the chapter titles) before this paragraph. Use it with delete_paragraphs on a typed contents list.', { before: int, reason: str }),
  fn('resolve_findings', 'Decide what happens to findings of the checks: "done" (you made the change it asks for, or it only reports a change made), "dismiss" (noise, a duplicate of another finding, or settled by a default you applied), or "ask" (a real decision only the author can take: it stays as a comment, with your question if you give one).', { items: { type: 'array', items: { type: 'object', properties: { id: str, decision: { type: 'string', enum: ['done', 'dismiss', 'ask'] }, reason: str, question: str }, required: ['id', 'decision', 'reason'] } } }),
  fn('triage_rules', 'Decide what each guideline rule needs from the author: "done" (the formatting or your operations meet it), "not-applicable" (it does not concern this manuscript or this delivery), "checklist" (something to hand in, which goes on the delivery checklist, not a question), or "ask" (the author must decide or answer).', { items: { type: 'array', items: { type: 'object', properties: { id: str, status: { type: 'string', enum: ['done', 'not-applicable', 'checklist', 'ask'] }, reason: str }, required: ['id', 'status'] } } }),
  fn('ask_author', 'Add a comment for the author at a paragraph: only for a real decision you cannot take yourself.', { paragraph: int, question: str }),
  fn('finish', 'Stop. Give a short summary of what you decided and did, for the author.', { summary: str }),
];

const isInt = value => Number.isInteger(value);

/**
 * The tool handlers over `state`. Each returns the text the model sees; a refused operation says
 * why and is counted. Nothing here touches the file.
 */
export function createSession(state) {
  const byIndex = new Map(state.paragraphs.map(entry => [entry.index, entry]));
  const findings = new Map(state.findings.map(entry => [entry.id, entry]));
  const rules = new Map(state.rules.map(entry => [entry.id, entry]));
  const roles = { ...state.roles };
  const session = { spec: [], refused: [], decisions: new Map(), triage: new Map(), asks: [], settings: {}, roles, finished: null, calls: {} };
  const refuse = (tool, reason, args) => { session.refused.push({ tool, reason, args }); return `REFUSED: ${reason}`; };
  const accept = (op, text = 'OK') => { session.spec.push(op); return text; };
  const textOf = index => byIndex.get(index)?.text ?? null;
  const line = entry => `[${entry.index}] (${roles[entry.index] ?? (entry.empty ? 'empty' : 'none')})${entry.note ? ' (has a note)' : ''} ${entry.text.length > MAX_TEXT ? `${entry.text.slice(0, MAX_TEXT)}…` : entry.text}`;

  const handlers = {
    read_paragraphs({ from, to }) {
      if (!isInt(from) || !isInt(to) || to < from) return refuse('read_paragraphs', 'from and to must be whole numbers, from <= to', { from, to });
      const last = Math.min(to, from + MAX_READ - 1);
      const lines = state.paragraphs.filter(entry => entry.index >= from && entry.index <= last && !entry.empty).map(line);
      return lines.length ? `${lines.join('\n')}${last < to ? `\n(stopped at ${last}; ask again from ${last + 1})` : ''}` : '(no paragraphs with text there)';
    },
    find_text({ text }) {
      if (typeof text !== 'string' || text.length < 2) return refuse('find_text', 'give at least two characters', { text });
      const needle = text.toLowerCase();
      const hits = state.paragraphs.filter(entry => entry.text.toLowerCase().includes(needle)).slice(0, 20);
      return hits.length ? hits.map(line).join('\n') : '(not found)';
    },
    set_roles({ changes, reason }) {
      if (!Array.isArray(changes) || !changes.length) return refuse('set_roles', 'changes must be a non-empty list', { changes });
      const bad = changes.filter(change => !byIndex.has(change?.paragraph) || byIndex.get(change.paragraph).empty || !ROLE_IDS.includes(change?.role));
      if (bad.length) return refuse('set_roles', `unknown or empty paragraph, or unknown role, in ${bad.length} of ${changes.length} changes (nothing changed)`, { changes });
      for (const { paragraph, role } of changes) {
        session.spec.push({ op: 'set_role', paragraph, from: roles[paragraph] ?? null, role, reason });
        roles[paragraph] = role;
      }
      return `OK: ${changes.length} roles set`;
    },
    set_setting({ slot, params, source, reason }) {
      const spec = SLOTS[slot];
      if (!spec || !AGENT_SLOTS.includes(slot)) return refuse('set_setting', `unknown setting ${slot}`, { slot });
      if (!params || typeof params !== 'object') return refuse('set_setting', 'params must be an object', { slot, params });
      const problems = Object.entries(spec.params).filter(([name, check]) => !check(params[name])).map(([name, check]) => `${name} must be ${check.allowed}`);
      if (problems.length) return refuse('set_setting', problems.join('; '), { slot, params });
      const clean = Object.fromEntries(Object.keys(spec.params).map(name => [name, params[name]]));
      session.settings[slot] = { params: clean, source: source === 'guidelines' ? 'guidelines' : 'default', reason };
      return accept({ op: 'set_setting', slot, params: clean, source: source === 'guidelines' ? 'guidelines' : 'default', reason, sheetHad: state.settings[slot] ?? null });
    },
    clear_setting({ slot, reason }) {
      if (!AGENT_SLOTS.includes(slot)) return refuse('clear_setting', `unknown setting ${slot}`, { slot });
      if (!state.settings[slot] && !session.settings[slot]) return refuse('clear_setting', `the sheet does not set ${slot}`, { slot });
      session.settings[slot] = { params: null, source: 'cleared', reason };
      return accept({ op: 'clear_setting', slot, reason, sheetHad: state.settings[slot] ?? null });
    },
    replace_text({ paragraph, before, after, reason }) {
      const text = textOf(paragraph);
      if (text === null) return refuse('replace_text', `no paragraph ${paragraph}`, { paragraph });
      if (typeof before !== 'string' || !before || typeof after !== 'string') return refuse('replace_text', 'before must be text and after a string', { paragraph, before, after });
      if (before === after) return refuse('replace_text', 'before and after are the same', { paragraph, before });
      const at = text.indexOf(before);
      if (at === -1) return refuse('replace_text', 'before is not in the paragraph as it stands (copy it exactly)', { paragraph, before });
      if (text.indexOf(before, at + 1) !== -1) return refuse('replace_text', 'before occurs more than once in the paragraph; give more of the words around it', { paragraph, before });
      if (session.spec.some(op => (op.op === 'replace_text' && op.paragraph === paragraph && rangesOverlap(op, at, before.length)) || (op.op === 'delete' && paragraph >= op.from && paragraph <= op.to))) return refuse('replace_text', 'it overlaps an operation already in the spec', { paragraph, before });
      return accept({ op: 'replace_text', paragraph, start: at, before, after, reason }, 'OK: recorded as a tracked change');
    },
    delete_paragraphs({ from, to, reason }) {
      if (!isInt(from) || !isInt(to) || to < from || !byIndex.has(from) || !byIndex.has(to)) return refuse('delete_paragraphs', 'from and to must be paragraph indices, from <= to', { from, to });
      if (to - from > 80) return refuse('delete_paragraphs', 'at most 81 paragraphs in one deletion', { from, to });
      if (session.spec.some(op => op.op === 'delete' && !(to < op.from || from > op.to))) return refuse('delete_paragraphs', 'it overlaps a deletion already in the spec', { from, to });
      // A paragraph that holds a note reference is never deleted: its note would be left without a place.
      const noted = state.paragraphs.filter(entry => entry.index >= from && entry.index <= to && entry.note).map(entry => entry.index);
      if (noted.length) return refuse('delete_paragraphs', `paragraph ${noted.join(', ')} holds a note reference; a deletion would orphan the note (of two copies, delete the one without it)`, { from, to });
      const words = state.paragraphs.filter(entry => entry.index >= from && entry.index <= to).reduce((sum, entry) => sum + (entry.text.match(/\S+/gu) ?? []).length, 0);
      return accept({ op: 'delete', from, to, words, reason }, `OK: ${to - from + 1} paragraphs (${words} words) recorded as a tracked deletion`);
    },
    insert_contents({ before, reason }) {
      if (!byIndex.has(before)) return refuse('insert_contents', `no paragraph ${before}`, { before });
      if (session.spec.some(op => op.op === 'insert_contents')) return refuse('insert_contents', 'a contents field is already in the spec', { before });
      return accept({ op: 'insert_contents', before, reason });
    },
    resolve_findings({ items }) {
      if (!Array.isArray(items) || !items.length) return refuse('resolve_findings', 'items must be a non-empty list', { items });
      const unknown = items.filter(item => !findings.has(item?.id) || !['done', 'dismiss', 'ask'].includes(item?.decision));
      for (const item of items) if (findings.has(item?.id) && ['done', 'dismiss', 'ask'].includes(item?.decision)) session.decisions.set(item.id, { decision: item.decision, reason: item.reason ?? '', question: typeof item.question === 'string' ? item.question : null });
      if (unknown.length) session.refused.push({ tool: 'resolve_findings', reason: `${unknown.length} unknown ids or decisions`, args: unknown.map(item => item?.id) });
      return `OK: ${items.length - unknown.length} decided${unknown.length ? `; ${unknown.length} ignored (unknown id or decision)` : ''}; ${state.findings.length - session.decisions.size} findings still undecided`;
    },
    triage_rules({ items }) {
      if (!Array.isArray(items) || !items.length) return refuse('triage_rules', 'items must be a non-empty list', { items });
      let ignored = 0;
      for (const item of items) {
        if (!rules.has(item?.id) || !['done', 'not-applicable', 'checklist', 'ask'].includes(item?.status)) { ignored += 1; continue; }
        session.triage.set(item.id, { status: item.status, reason: item.reason ?? '' });
      }
      if (ignored) session.refused.push({ tool: 'triage_rules', reason: `${ignored} unknown ids or statuses`, args: [] });
      return `OK: ${items.length - ignored} triaged${ignored ? `; ${ignored} ignored` : ''}; ${state.rules.length - session.triage.size} rules still untriaged`;
    },
    ask_author({ paragraph, question }) {
      if (!byIndex.has(paragraph)) return refuse('ask_author', `no paragraph ${paragraph}`, { paragraph });
      if (typeof question !== 'string' || question.trim().length < 10) return refuse('ask_author', 'give the question', { paragraph });
      session.asks.push({ paragraph, question: question.trim().slice(0, 600) });
      return 'OK: comment recorded';
    },
    finish({ summary }) {
      session.finished = typeof summary === 'string' ? summary.slice(0, 4000) : '';
      return 'OK';
    },
  };
  return { session, handlers };
}

const rangesOverlap = (op, start, length) => !(start + length <= op.start || start >= op.start + op.before.length);
