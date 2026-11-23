// The built-in rule sheets: requirements the Lab has read by hand and ships with the tool, so that
// a person can start from them without a model reading anything. Each is a rule sheet in the normal
// schema whose rules quote the published page they come from, with its address and the day it was
// read. Only one is shipped; the list is open to more (a publisher's, say). Pure: no DOM, no network.

import { validateSheet } from '../rules/schema.js';
import * as cunyGc from './cuny-gc.js';

export const PRESETS = Object.freeze([
  Object.freeze({ id: cunyGc.ID, name: cunyGc.NAME, docType: 'dissertation', sources: cunyGc.SOURCES, retrieved: cunyGc.RETRIEVED, sheet: cunyGc.SHEET,
    covers: 'dissertations, theses and capstone projects (the library gives one set of format requirements for all three)' }),
]);

/** The built-in sets offered for a document type. */
export const presetsFor = docType => PRESETS.filter(preset => preset.docType === docType);

/** A built-in set's rule sheet, validated and as a fresh copy (the same every time), or null. */
export function presetSheet(id) {
  const preset = PRESETS.find(entry => entry.id === id);
  if (!preset) return null;
  const result = validateSheet(JSON.parse(JSON.stringify(preset.sheet)));
  return result.ok ? result.sheet : null;
}
