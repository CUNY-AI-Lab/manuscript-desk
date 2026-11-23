// The browser's extractors for lib/guidelines/read.js: PDFs are read by MuPDF in web/shared/pdf-worker.js,
// Word files by mammoth on the page. The file is read here and never uploaded.
import mammoth from 'mammoth';

let worker = null;
let lastId = 0;
const pending = new Map();

function pdfWorker() {
  if (worker) return worker;
  // '../shared/' names this directory whether this module is served from shared/ or bundled into a
  // page script in a sibling directory such as format/.
  worker = new Worker(new URL('../shared/pdf-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    const job = pending.get(data?.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.ok && typeof data.text === 'string') job.resolve(data.text);
    else job.reject(new Error('MuPDF could not read the PDF.'));
  });
  // The worker script failed to load or the worker died: fail what is waiting and start afresh next time.
  worker.addEventListener('error', () => {
    for (const job of pending.values()) job.reject(new Error('The PDF worker stopped.'));
    pending.clear();
    worker.terminate();
    worker = null;
  });
  return worker;
}

/**
 * Resolves to the PDF's text, its pages joined by blank lines. The bytes' buffer is transferred to
 * the worker, so the caller's array is empty afterwards.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export function extractPdf(bytes) {
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, { resolve, reject });
    try {
      pdfWorker().postMessage({ id, bytes }, [bytes.buffer]);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/**
 * Resolves to the Word file's text.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function extractDocx(bytes) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return (await mammoth.extractRawText({ arrayBuffer })).value;
}
