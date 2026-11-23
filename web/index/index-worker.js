// Web Worker of the Index Builder page: reads the proofs' PDF with MuPDF and matches the term list,
// off the page's main thread (book-index measured about 3 s for 1,800 terms on 372 pages). The PDF
// stays in the browser.
// Protocol, each message with an id:
//   { id, type: 'read', pdf: ArrayBuffer }  -> { id, type: 'progress', done, total } per page, then
//      { id, type: 'read-done', texts, labels } or { id, type: 'error', name, message }
//   { id, type: 'match', pages, entries, matchCase } -> { id, type: 'match-done', index,
//      byEntry: [[entryId, found]], reasons: [[entryId, [reason]]] } or { id, type: 'error', ... }
// MuPDF is loaded from the vendored copy (dist/vendor/mupdf), never a CDN; the import is dynamic so
// that messages sent while it loads are not missed.
import { extractPdf } from '../../lib/index/extract.js';
import { detectAmbiguous, findHits } from '../../lib/index/hits.js';

const loading = import('../vendor/mupdf/mupdf.js').catch(() => null);
const fail = (id, error) => self.postMessage({ id, type: 'error', name: error?.name || 'Error', message: error?.message || String(error) });

self.addEventListener('message', async ({ data }) => {
  const { id, type } = data ?? {};
  try {
    if (type === 'read') {
      const mupdf = await loading;
      if (!mupdf) throw Object.assign(new Error('The PDF reader could not be loaded.'), { name: 'ReaderError' });
      const { texts, labels } = extractPdf(mupdf, new Uint8Array(data.pdf), (done, total) => self.postMessage({ id, type: 'progress', done, total }));
      if (!texts.length) throw Object.assign(new Error('The PDF has no pages.'), { name: 'InvalidPDFException' });
      if (!texts.some(text => text.trim())) throw Object.assign(new Error('The PDF has no selectable text.'), { name: 'NoTextError' });
      self.postMessage({ id, type: 'read-done', texts, labels });
    } else if (type === 'match') {
      // The words around each hit are kept only for the entries a helper may read: those that look
      // ambiguous and those with subentries.
      const matchCase = Boolean(data.matchCase);
      const first = findHits(data.pages, data.entries, { matchCase, contextFor: new Set() });
      const reasons = detectAmbiguous(data.entries, first.byEntry);
      const wanted = new Set([...reasons.keys(), ...data.entries.filter(entry => entry.subentries?.length).map(entry => entry.id)]);
      const { index, byEntry } = wanted.size ? findHits(data.pages, data.entries, { matchCase, contextFor: wanted }) : first;
      self.postMessage({ id, type: 'match-done', index, byEntry: [...byEntry], reasons: [...reasons] });
    }
  } catch (error) {
    fail(id, error);
  }
});
