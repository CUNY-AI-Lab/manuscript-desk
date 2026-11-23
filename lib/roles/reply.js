// Reading a model's reply to one passage, and reconciling the answers of passages that asked for
// the same paragraph. Pure: no DOM, no network.

import { isRole } from './roles.js';

// A whole reply wrapped in a Markdown code fence, with or without a language tag.
const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
// "Heading 1", "heading_1" and " BODY " are read as the role ids they plainly mean.
const normalRole = value => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : null);

/**
 * The roles a reply gives to the paragraphs that were asked, or null when it does not parse.
 * Accepts {"roles": {"12": "body", ...}} and {"roles": [{"index": 12, "role": "body"}, ...]}.
 * Only asked indices and known roles are kept; `missing` lists asked indices left without one.
 * @param {unknown} content
 * @param {number[]} asked
 * @returns {{ labels: Map<number, string>, missing: number[] } | null}
 */
export function parseRolesReply(content, asked) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return null;
  }
  const roles = isObject(data) ? data.roles : undefined;
  let pairs;
  if (isObject(roles)) pairs = Object.entries(roles);
  else if (Array.isArray(roles)) pairs = roles.filter(isObject).map(item => [item.index ?? item.i, item.role]);
  else return null;
  const wanted = new Set(asked);
  const labels = new Map();
  for (const [key, value] of pairs) {
    const index = typeof key === 'number' ? key : /^\s*\d+\s*$/.test(String(key)) ? Number(key) : NaN;
    const role = normalRole(value);
    if (!wanted.has(index) || !isRole(role) || labels.has(index)) continue;
    labels.set(index, role);
  }
  return { labels, missing: asked.filter(index => !labels.has(index)) };
}

/**
 * One role per paragraph from the answers of several passages. When passages overlap, the answer
 * of the passage in which the paragraph lies furthest from an edge wins (it was read with the most
 * context on both sides); on a tie, the earlier passage.
 * @param {Array<{ asked: number[], labels?: Map<number, string> }>} answers
 * @returns {Map<number, string>}
 */
export function reconcile(answers) {
  const best = new Map();
  for (const { asked, labels } of answers) {
    if (!labels) continue;
    asked.forEach((index, position) => {
      const role = labels.get(index);
      if (role === undefined) return;
      const depth = Math.min(position, asked.length - 1 - position);
      const held = best.get(index);
      if (!held || depth > held.depth) best.set(index, { role, depth });
    });
  }
  return new Map([...best].map(([index, { role }]) => [index, role]));
}
