import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';
import mammoth from 'mammoth';
import { readGuidelines, cleanPastedText, MAX_GUIDELINES_CHARS, MIN_GUIDELINES_CHARS } from '../lib/guidelines/read.js';
import { pageText } from '../lib/guidelines/pdf-text.js';

// MuPDF's warnings about the deliberately damaged files would clutter the test output.
mupdf.setLog(() => {});

const SENTENCE = 'Use double quotation marks throughout the manuscript.';
const fixture = async name => new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)));

// Node stand-ins for the browser extractors: MuPDF and mammoth used directly.
const extractors = {
  async extractPdf(bytes) {
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
  },
  async extractDocx(bytes) {
    return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  },
};

const MESSAGES = {
  unsupported: 'Upload a PDF or Word (.docx) file, or paste the guidelines as text.',
  no_text: 'This PDF has no readable text. It is probably a scan. Paste the guidelines as text instead.',
  too_long: 'These guidelines are too long to read in one go. Upload only the part about preparing the manuscript.',
  unreadable: 'This file could not be opened. Try saving it again, or paste the guidelines as text.',
  too_short: 'Paste the full guidelines. This is too short to contain any.',
};
const failed = code => ({ ok: false, code, message: MESSAGES[code] });

test('exports the limits', () => {
  assert.equal(MAX_GUIDELINES_CHARS, 600000);
  assert.equal(MIN_GUIDELINES_CHARS, 200);
});

test('reads a docx by content, whatever its name', async () => {
  const bytes = await fixture('guidelines.docx');
  for (const name of ['guidelines.docx', 'x.bin', 'guidelines.pdf']) {
    const result = await readGuidelines({ name, bytes }, extractors);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes(SENTENCE), result.text);
  }
});

test('reads a text pdf', async () => {
  const result = await readGuidelines({ name: 'guidelines.pdf', bytes: await fixture('guidelines.pdf') }, extractors);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes(SENTENCE), result.text);
  assert.ok(result.text.includes('Number the notes from 1 in each chapter'), result.text);
});

test('reports no_text for an image-only pdf with the exact message', async () => {
  const bytes = await fixture('scanned.pdf');
  // The fixture really is an image: MuPDF sees an image block and no text on its one page.
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const blocks = JSON.parse(doc.loadPage(0).toStructuredText('preserve-images').asJSON()).blocks;
  assert.equal(doc.countPages(), 1);
  assert.deepEqual(blocks.map(b => b.type), ['image']);
  doc.destroy();
  assert.deepEqual(await readGuidelines({ name: 'scanned.pdf', bytes }, extractors), failed('no_text'));
});

test('reports no_text when a pdf yields fewer than 200 non-whitespace characters', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7');
  const short = { extractPdf: async () => 'x '.repeat(199) + '\n\n\n', extractDocx: () => assert.fail('not a docx') };
  assert.deepEqual(await readGuidelines({ name: 'a.pdf', bytes }, short), failed('no_text'));
  const enough = { ...short, extractPdf: async () => '  ' + 'x '.repeat(200) };
  assert.deepEqual(await readGuidelines({ name: 'a.pdf', bytes }, enough), { ok: true, text: 'x '.repeat(200).trim() });
});

test('reports unsupported for a png', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const never = { extractPdf: () => assert.fail('not a pdf'), extractDocx: () => assert.fail('not a docx') };
  assert.deepEqual(await readGuidelines({ name: 'guidelines.pdf', bytes: png }, never), failed('unsupported'));
  for (const bytes of [new Uint8Array(0), new Uint8Array([0x25, 0x50, 0x44]), new TextEncoder().encode(SENTENCE), undefined, 'PK\x03\x04']) {
    assert.deepEqual(await readGuidelines({ name: 'g.docx', bytes }, never), failed('unsupported'));
  }
  assert.deepEqual(await readGuidelines(undefined, never), failed('unsupported'));
});

test('reports unreadable for a truncated docx', async () => {
  const bytes = await fixture('guidelines.docx');
  assert.deepEqual(await readGuidelines({ name: 'g.docx', bytes: bytes.subarray(0, bytes.length >> 1) }, extractors), failed('unreadable'));
});

test('reports unreadable when an extractor throws, rejects, returns no string or is missing', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 truncated');
  assert.deepEqual(await readGuidelines({ name: 'g.pdf', bytes: pdf }, extractors), failed('unreadable'));
  for (const extractPdf of [() => { throw new Error('boom'); }, async () => { throw new Error('boom'); }, async () => undefined, async () => 42]) {
    assert.deepEqual(await readGuidelines({ name: 'g.pdf', bytes: pdf }, { extractPdf }), failed('unreadable'));
  }
  assert.deepEqual(await readGuidelines({ name: 'g.pdf', bytes: pdf }, {}), failed('unreadable'));
  assert.deepEqual(await readGuidelines({ name: 'g.pdf', bytes: pdf }), failed('unreadable'));
});

test('reports too_long above 600000 characters', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7');
  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const returning = text => ({ extractPdf: async () => text, extractDocx: async () => text });
  for (const bytes of [pdf, docx]) {
    assert.deepEqual(await readGuidelines({ name: 'g', bytes }, returning('a'.repeat(600001))), failed('too_long'));
    assert.deepEqual(await readGuidelines({ name: 'g', bytes }, returning(`\n ${'a'.repeat(600000)} \n`)), { ok: true, text: 'a'.repeat(600000) });
  }
});

test('cleanPastedText trims, rejects under 200 characters, rejects over the limit', () => {
  const body = `${SENTENCE} ${'Cite sources in the author-date style. '.repeat(5)}`.trim();
  assert.ok(body.length >= 200);
  assert.deepEqual(cleanPastedText(`\n\t  ${body}  \n\n`), { ok: true, text: body });
  assert.deepEqual(cleanPastedText('x'.repeat(200)), { ok: true, text: 'x'.repeat(200) });
  assert.deepEqual(cleanPastedText(`   ${'x'.repeat(199)}        `), failed('too_short'));
  for (const bad of ['', '   ', undefined, null, 42, {}]) assert.deepEqual(cleanPastedText(bad), failed('too_short'));
  assert.deepEqual(cleanPastedText('x'.repeat(600000)), { ok: true, text: 'x'.repeat(600000) });
  assert.deepEqual(cleanPastedText('x'.repeat(600001)), failed('too_long'));
});

test('the fixtures are small', async () => {
  for (const name of ['guidelines.docx', 'guidelines.pdf', 'scanned.pdf', 'tight.pdf']) assert.ok((await fixture(name)).length < 50_000, name);
});

// The browser's PDF worker, run in Node against the vendored MuPDF (npm run vendor; npm run check runs it first).
test('the PDF worker replies with the pages\' text, or ok: false for a file MuPDF cannot open', async t => {
  const replies = [];
  let onMessage;
  globalThis.self = { addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; }, postMessage: reply => replies.push(reply) };
  t.after(() => delete globalThis.self);
  await import('../web/shared/pdf-worker.js');
  (await import('../web/vendor/mupdf/mupdf.js')).setLog(() => {}); // the worker's own MuPDF instance
  const ask = async (id, bytes) => {
    const before = replies.length;
    await onMessage({ data: { id, bytes } });
    assert.equal(replies.length, before + 1);
    return replies.at(-1);
  };
  const pdf = await fixture('guidelines.pdf');
  const reply = await ask(7, pdf);
  assert.deepEqual(reply, { id: 7, ok: true, text: await extractors.extractPdf(pdf) });
  assert.match(reply.text, /\n\n/);
  const tight = await fixture('tight.pdf');
  const tightReply = await ask(10, tight);
  assert.deepEqual(tightReply, { id: 10, ok: true, text: await extractors.extractPdf(tight) });
  assert.ok(tightReply.text.startsWith('When applicable the volume includes a list of abbreviations\n'), tightReply.text);
  assert.deepEqual(await ask(8, new TextEncoder().encode('%PDF-1.7 truncated')), { id: 8, ok: false });
  assert.deepEqual(await ask(9, undefined), { id: 9, ok: false });
});
