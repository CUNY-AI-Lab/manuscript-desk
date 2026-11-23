// The rules behind the To-do checks. A check runs only when a rule in the sheet asks for what it
// checks (or when it concerns a change the formatter made); these find that rule. Rules switched
// off or in conflict ask for nothing. Pure: no DOM, no network.

const active = rule => rule !== null && typeof rule === 'object' && rule.enabled !== false && rule.conflict !== true;

/**
 * The sheet's active rules that match: by slot, by category, and by a test of their params.
 * @param {object | null} sheet a validated rule sheet
 * @param {{ slot?: string, category?: string, mode?: string, where?: (params: object) => boolean }} need
 */
export function rulesWith(sheet, { slot, category, mode, where } = {}) {
  const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
  return rules.filter(rule => active(rule)
    && (slot === undefined || rule.slot === slot)
    && (category === undefined || rule.category === category)
    && (mode === undefined || rule.mode === mode)
    && (!where || where(rule.params ?? {})));
}

/** The one rule to name for a need: the first that quotes the guidelines, else the first; or null. */
export function ruleWith(sheet, need) {
  const rules = rulesWith(sheet, need);
  return rules.find(rule => rule.source?.kind === 'guidelines') ?? rules[0] ?? null;
}

/** The first of several needs that a rule meets, as that rule; or null. */
export function firstRule(sheet, needs) {
  for (const need of needs) {
    const rule = ruleWith(sheet, need);
    if (rule) return rule;
  }
  return null;
}
