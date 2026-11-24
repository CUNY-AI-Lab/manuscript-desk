// The tools the decide step offers a model, in the OpenAI "tools" shape the Gateway passes through,
// by kind of unit. The Worker builds each request's tool list from these (a request names only its
// kind and whether reading is still open); the page runs every tool on its own copy of the
// manuscript and code judges every answer (policy.js). Pure data and small checks.

import { ROLE_IDS } from '../roles/roles.js';

export const UNIT_KINDS = Object.freeze(['settings', 'findings', 'rules']);
// The reading tools, offered for the first READING_TURNS turns of a findings unit only.
export const READING_TOOLS = Object.freeze(['read_paragraphs', 'find_text']);
export const READING_TURNS = 2;
// The kinds of thing an author hands in, one checklist row each.
export const DELIVERABLES = Object.freeze({
  'image-files': 'Image files for the figures',
  permissions: 'Permissions to reproduce material',
  'alt-texts': 'Alternative texts for the figures',
  cover: 'A cover image or cover copy',
  forms: 'Forms, contract and questionnaires',
  'final-files': 'The final files (Word, PDF, other formats)',
  'separate-files': 'Separate documents the guidelines ask for (abstracts, running titles, lists)',
  'author-details': 'Details about the authors and editors (notes on contributors, addresses)',
  index: 'The index',
  other: 'Other things to hand in',
});
export const TRIAGE_STATUSES = Object.freeze(['done', 'not-applicable', 'copyedit', 'deliver', 'decision']);

const fn = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const int = { type: 'integer' };
const str = { type: 'string' };

const TOOLS = {
  read_paragraphs: fn('read_paragraphs', 'Read the paragraphs from..to (at most 40), each as [number] (role) text.', { from: int, to: int }),
  find_text: fn('find_text', 'List the paragraphs (at most 15) whose text contains these words, ignoring case.', { text: str }),
  clear_settings: fn('clear_settings', 'Switch off settings of the rule sheet that were misread from the guidelines: a sentence about something else (the text inside illustrations, say), or mere advice read as a requirement. Give the rule id and why. Leave every correct setting alone; an empty list is a correct answer.', { items: { type: 'array', items: { type: 'object', properties: { id: str, reason: str }, required: ['id', 'reason'], additionalProperties: false } } }),
  decide_findings: fn('decide_findings', 'Decide every query listed: "copyedit" for a possible slip in the running text (a typo, missing spaces, a stray character, a word given two ways in the prose), which goes on one list for the copyeditor and is not marked in the manuscript; "ask" for a real question only the author can answer, which stays as a comment (give a short plain question if the query does not already say it).', { items: { type: 'array', items: { type: 'object', properties: { id: str, choice: { type: 'string', enum: ['copyedit', 'ask'] }, question: str }, required: ['id', 'choice'], additionalProperties: false } } }),
  propose_edit: fn('propose_edit', 'Propose a change to the words of one paragraph: "before" copied exactly from it, "after" what it becomes. Code makes only the mechanical changes the guidelines settle and turns any other into a question for the author or a query for the copyeditor; do not copyedit.', { paragraph: int, before: str, after: str, reason: str }),
  delete_paragraphs: fn('delete_paragraphs', 'Propose deleting paragraphs from..to: only a passage typed twice in a row (one copy) or a stray character on a line of its own. Code checks it and refuses anything else.', { from: int, to: int, reason: str }),
  set_role: fn('set_role', 'Change what a paragraph is (its role), when the labels got it wrong; the formatter styles it by its role. Title blocks and title pages keep theirs.', { paragraph: int, role: { type: 'string', enum: ROLE_IDS }, reason: str }),
  triage_rules: fn('triage_rules', `Say for every rule listed what it asks of this manuscript: "done" (the formatting or the manuscript as it stands already meets it), "not-applicable" (it does not concern this manuscript, or only a later stage such as proofs), "copyedit" (a matter of the prose for the copyeditor: spelling, punctuation, quotation marks, the form of citations), "deliver" (something the author must hand in; give "deliverable": one of ${Object.keys(DELIVERABLES).join(', ')}), or "decision" (a real choice the guidelines leave to the author or editor that must be made before the manuscript goes in; give a short plain question). General advice or an obligation with nothing to do now ("meet the deadlines", "keep titles short") is "done" when the manuscript meets it and "not-applicable" otherwise.`, { items: { type: 'array', items: { type: 'object', properties: { id: str, status: { type: 'string', enum: TRIAGE_STATUSES }, deliverable: { type: 'string', enum: Object.keys(DELIVERABLES) }, question: str }, required: ['id', 'status'], additionalProperties: false } } }),
};

// The decision tools of each kind of unit.
const DECISION_TOOLS = { settings: ['clear_settings'], findings: ['decide_findings', 'propose_edit', 'delete_paragraphs', 'set_role'], rules: ['triage_rules'] };
// The tool whose call ends a unit.
export const FINAL_TOOL = { settings: 'clear_settings', findings: 'decide_findings', rules: 'triage_rules' };

/** The tools a request of this kind offers: the decision tools, and the reading tools while reading is open. */
export function toolsFor(kind, reading = false) {
  if (!UNIT_KINDS.includes(kind)) throw new Error(`Unknown unit kind: ${kind}`);
  const names = [...(reading && kind === 'findings' ? READING_TOOLS : []), ...DECISION_TOOLS[kind]];
  return names.map(name => TOOLS[name]);
}

/** Every tool name any unit offers, for checking a conversation's tool calls. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));
