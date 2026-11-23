// Web Worker that reads a PDF's text with MuPDF, off the page's main thread; the file stays in the browser.
// Protocol: the page posts { id, bytes } (a Uint8Array, its buffer transferred). The worker replies
// { id, ok: true, text } with the pages' text joined by blank lines, or { id, ok: false } when MuPDF
// cannot load or cannot open the file.
// MuPDF is loaded from the vendored copy next to this file (dist/vendor/mupdf), never from a CDN. The
// import is dynamic so the message listener exists from the start and no message is missed while
// MuPDF's WebAssembly loads. pageText (lib/) is bundled into this file by scripts/build.mjs.
import { pageText } from '../../lib/guidelines/pdf-text.js';

const loading = import('../vendor/mupdf/mupdf.js').catch(() => null);

function pdfText(mupdf, bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const texts = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        texts.push(pageText(page));
      } finally {
        page.destroy();
      }
    }
    return texts.join('\n\n');
  } finally {
    doc.destroy();
  }
}

self.addEventListener('message', async ({ data }) => {
  const id = data?.id;
  try {
    const mupdf = await loading;
    if (!mupdf || !(data.bytes instanceof Uint8Array)) throw new Error('cannot read');
    self.postMessage({ id, ok: true, text: pdfText(mupdf, data.bytes) });
  } catch {
    self.postMessage({ id, ok: false });
  }
});
