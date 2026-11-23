// The To-do checks: each takes the paragraph model, the roles, the formatter's report (with its
// declared changes) and the rule sheet, and returns findings, written for a scholar in plain words,
// that say what is left to do. A check runs only when a rule in the sheet asks for what it checks
// or when it concerns a change the formatter made that the author must verify. Pure: no DOM, no
// network.

import { checkContext } from './context.js';
import { DISPLAY_CHECKS } from './displays.js';
import { FRONT_CHECKS } from './front.js';
import { MATTER_CHECKS } from './matter.js';
import { SECTION_CHECKS } from './sections.js';
import { SUMMARY_CHECKS } from './summary.js';
import { TITLE_CHECKS } from './titles.js';

// In the order their findings are listed at one place.
export const CHECKS = Object.freeze([...SUMMARY_CHECKS, ...TITLE_CHECKS, ...MATTER_CHECKS, ...SECTION_CHECKS, ...DISPLAY_CHECKS, ...FRONT_CHECKS]);

/**
 * @param {{ paragraphs: Array<object>, roles: Record<number, string>, report: object, sheet: object | null }} input
 * @returns {{ findings: Array<{ kind: string, chapter: number | null, paragraphIndex: number | null, ruleId: string | null, message: string, check: string }>,
 *   checks: Array<{ id: string, kind: string, ran: boolean, basis?: 'rule' | 'formatter', ruleId?: string | null, count?: number, needs: string }> }}
 */
export function runChecks(input) {
  const context = checkContext(input);
  const findings = [];
  const checks = [];
  CHECKS.forEach((check, order) => {
    const basis = check.basis(context);
    if (!basis) { checks.push({ id: check.id, kind: check.kind, ran: false, needs: check.needs }); return; }
    const found = check.run(context, basis.rule ?? null);
    for (const finding of found) {
      const rule = finding.rule === undefined ? basis.rule : finding.rule;
      const paragraphIndex = Number.isInteger(finding.paragraphIndex) ? finding.paragraphIndex : null;
      findings.push({ kind: finding.kind ?? check.kind, chapter: context.chapterOf(paragraphIndex), paragraphIndex, ruleId: rule?.id ?? null, message: finding.message, check: check.id, order });
    }
    checks.push({ id: check.id, kind: check.kind, ran: true, basis: basis.rule ? 'rule' : 'formatter', ruleId: basis.rule?.id ?? null, count: found.length, needs: check.needs });
  });
  findings.sort((a, b) => (a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1) || a.order - b.order);
  return { findings: findings.map(({ order, ...finding }) => finding), checks };
}
