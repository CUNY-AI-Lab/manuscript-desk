// The model menu, built from the CAIL catalog (GET /manuscript/api/catalog). Pure, so it is tested
// without a DOM. Only Gateway-recommended, active text-generation rows with room for a part of the
// guidelines plus the reply are offered, in catalog order.
export const DEFAULT_MODEL = 'glm-5.3';
// A part of the guidelines is up to about 42,000 characters (some 10,000 tokens) and the reply up to
// 6,000 tokens; 32,000 tokens of context holds both.
export const MIN_CONTEXT_TOKENS = 32000;
// Safety classifiers answer "safe" or "unsafe", not rules, even when tagged text-generation.
const CLASSIFIER = /guard|safeguard/i;

const offered = row => typeof row?.id === 'string' && row.recommended === true
  && (row.status === undefined || row.status === 'active')
  && Array.isArray(row.capabilities) && row.capabilities.includes('text-generation')
  && Number.isInteger(row.context_length) && row.context_length >= MIN_CONTEXT_TOKENS
  && !CLASSIFIER.test(row.id) && !CLASSIFIER.test(typeof row.name === 'string' ? row.name : '');

export function modelMenu(catalog) {
  const rows = Array.isArray(catalog?.data) ? catalog.data : [];
  return rows
    .filter(offered)
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.order ?? 0) - (b.row.order ?? 0) || a.index - b.index)
    .map(({ row }) => ({ id: row.id, label: (typeof row.name === 'string' && row.name) || row.id }));
}

// The chosen model while the menu still offers it, else the default if offered, else the first row
// ('' for an empty menu).
export function chooseModel(chosen, menu) {
  const ids = menu.map(entry => entry.id);
  if (ids.includes(chosen)) return chosen;
  if (ids.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return ids[0] ?? '';
}
