// Turns a publisher's guidelines, uploaded as a PDF or Word file or pasted as text, into plain text.
// Pure: the extractors are injected (web/shared/guidelines-extractors.js in the browser, where the
// file is read and never uploaded; MuPDF and mammoth directly in Node tests).

export const MAX_GUIDELINES_CHARS = 600000;
export const MIN_GUIDELINES_CHARS = 200;

const MESSAGES = {
  unsupported: 'Upload a PDF or Word (.docx) file, or paste the guidelines as text.',
  no_text: 'This PDF has no readable text. It is probably a scan. Paste the guidelines as text instead.',
  too_long: 'These guidelines are too long to read in one go. Upload only the part about preparing the manuscript.',
  unreadable: 'This file could not be opened. Try saving it again, or paste the guidelines as text.',
  too_short: 'Paste the full guidelines. This is too short to contain any.',
};

const failure = code => ({ ok: false, code, message: MESSAGES[code] });

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04, which a .docx starts with

const startsWith = (bytes, signature) => bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

/**
 * Reads an uploaded guidelines file. The type comes from the file's first bytes, not its name.
 * Each extractor takes the file's bytes and returns (or resolves to) its plain text. Never throws.
 * @param {{ name?: string, bytes: Uint8Array }} file
 * @param {{ extractPdf: (bytes: Uint8Array) => string | Promise<string>, extractDocx: (bytes: Uint8Array) => string | Promise<string> }} extractors
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: 'unsupported'|'no_text'|'too_long'|'unreadable', message: string }>}
 */
export async function readGuidelines(file, extractors) {
  const bytes = file?.bytes;
  if (!(bytes instanceof Uint8Array)) return failure('unsupported');
  const isPdf = startsWith(bytes, PDF_SIGNATURE);
  if (!isPdf && !startsWith(bytes, ZIP_SIGNATURE)) return failure('unsupported');

  let text;
  try {
    text = await (isPdf ? extractors.extractPdf(bytes) : extractors.extractDocx(bytes));
  } catch {
    return failure('unreadable');
  }
  if (typeof text !== 'string') return failure('unreadable');

  text = text.trim();
  if (isPdf && text.replace(/\s+/g, '').length < MIN_GUIDELINES_CHARS) return failure('no_text');
  if (text.length > MAX_GUIDELINES_CHARS) return failure('too_long');
  return { ok: true, text };
}

/**
 * Checks guidelines pasted as text.
 * @param {string} text
 * @returns {{ ok: true, text: string } | { ok: false, code: 'too_short'|'too_long', message: string }}
 */
export function cleanPastedText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length < MIN_GUIDELINES_CHARS) return failure('too_short');
  if (trimmed.length > MAX_GUIDELINES_CHARS) return failure('too_long');
  return { ok: true, text: trimmed };
}
