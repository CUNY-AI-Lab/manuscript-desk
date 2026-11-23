import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUSY, FILE_KINDS, STRAY_HINT, acceptList, checkFiles, dropLabel, draggingFiles, fileAccepted, sizeText } from '../web/shared/drop.js';

const WEB = new URL('../web/', import.meta.url).pathname;
const file = (name, size = 1000, type = '') => ({ name, size, type });
const DOCX = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('an accept attribute is read as extensions, types and families', () => {
  assert.deepEqual(acceptList('.PDF, application/pdf,text/*'), { extensions: ['.pdf'], types: ['application/pdf'], families: ['text/'] });
  assert.equal(fileAccepted(file('Book.DOCX'), DOCX), true, 'by the extension, whatever its case');
  assert.equal(fileAccepted(file('book', 1, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), DOCX), true, 'by the type when the name has no extension');
  assert.equal(fileAccepted(file('book.doc', 1, 'application/msword'), DOCX), false);
  assert.equal(fileAccepted(file('notes.md', 1, 'text/markdown'), 'text/*'), true);
  assert.equal(fileAccepted(file('anything.bin'), ''), true, 'an input without accept takes anything');
  assert.equal(fileAccepted(file('docx'), DOCX), false, 'a name is not its extension');
});

test('chosen or dropped, files are checked the same way, with plain messages', () => {
  const manuscript = { accept: DOCX, multiple: false, kind: 'manuscript' };
  assert.deepEqual(checkFiles([file('book.docx')], manuscript), { ok: true, files: [file('book.docx')] });
  assert.deepEqual(checkFiles([file('book.pdf', 10, 'application/pdf')], manuscript), { ok: false, message: 'book.pdf is not a Word file (.docx).' });
  assert.deepEqual(checkFiles([file('a.docx'), file('b.docx')], manuscript), { ok: false, message: 'This takes one file at a time, and 2 were given. Drag a Word file (.docx) on its own.' });
  assert.deepEqual(checkFiles([file('huge.docx', 250e6)], manuscript), { ok: false, message: 'huge.docx is too large (250 MB). The largest file this takes is 200 MB.' });
  assert.deepEqual(checkFiles([], manuscript), { ok: false, message: 'No file was found there. Drag a Word file (.docx) itself, not a folder.' });
  const guidelines = { accept: '.pdf,.docx,application/pdf', multiple: true, kind: 'guidelines' };
  assert.equal(checkFiles([file('a.pdf'), file('b.docx')], guidelines).ok, true, 'several where several are taken');
  assert.deepEqual(checkFiles([file('a.pdf'), file('b.txt')], guidelines), { ok: false, message: 'b.txt is not a PDF or Word file (.pdf or .docx).' });
  assert.deepEqual(checkFiles([file('list.json')], { accept: '.txt,text/plain', kind: 'term-list' }), { ok: false, message: 'list.json is not a plain text file (.txt).' });
  assert.deepEqual(checkFiles([file('sheet.json', 9e6)], { accept: '.json', kind: 'rule-sheet' }), { ok: false, message: 'sheet.json is too large (9 MB). The largest file this takes is 8 MB.' });
});

test('sizes, labels and hints in words', () => {
  assert.equal(sizeText(512), '512 bytes');
  assert.equal(sizeText(350e3), '350 KB');
  assert.equal(sizeText(1.5e6), '1.5 MB');
  assert.equal(sizeText(12.4e6), '12 MB');
  assert.equal(sizeText(500e6), '500 MB');
  assert.equal(sizeText(1.25e9), '1.3 GB');
  assert.equal(dropLabel(false), 'Drag a file here, or choose one');
  assert.equal(dropLabel(true), 'Drag files here, or choose them');
  assert.match(STRAY_HINT, /^To add a file, drop it on one of the boxes marked “Drag a file here”\.$/);
  assert.match(BUSY, /^This cannot take a file right now\./);
  assert.equal(draggingFiles({ types: ['Files'] }), true);
  assert.equal(draggingFiles({ types: ['text/plain'] }), false, 'text dragged within the page is left alone');
  assert.equal(draggingFiles(null), false);
});

// Every file input of every page sits in a drop area, says what it takes, and is wired to it.
test('every file input on every page has a drop area and goes through fileInput', async () => {
  const pages = { 'format/index.html': ['format/app.js', 'format/manuscript-step.js'], 'index/index.html': ['index/app.js'] };
  const found = [];
  for (const [page, scripts] of Object.entries(pages)) {
    const html = await readFile(join(WEB, page), 'utf8');
    const code = (await Promise.all(scripts.map(script => readFile(join(WEB, script), 'utf8')))).join('\n');
    for (const match of html.matchAll(/<input\b[^>]*type="file"[^>]*>/g)) {
      const tag = match[0];
      const id = /id="([^"]+)"/.exec(tag)?.[1];
      const kind = /data-file-kind="([^"]+)"/.exec(tag)?.[1];
      found.push(`${page}#${id}`);
      assert.ok(kind in FILE_KINDS, `${page}#${id} says what it takes (${kind})`);
      // The nearest drop area opened before the input (written <div class="drop-zone…" id="…">) is not closed before it.
      const before = html.slice(0, match.index);
      const zones = [...before.matchAll(/<div class="drop-zone[^"]*" id="([^"]+)"/g)];
      assert.ok(zones.length, `${page}#${id} is in a drop area`);
      const last = zones[zones.length - 1];
      const opened = last.index;
      const zone = last[1];
      const between = before.slice(opened);
      assert.ok((between.match(/<div\b/g) ?? []).length > (between.match(/<\/div>/g) ?? []).length, `${page}#${id} is inside ${zone}`);
      assert.match(code, new RegExp(`fileInput\\(\\{ input: \\$\\('${id}'\\), zone: \\$\\('${zone}'\\)`), `${page}#${id} is wired to ${zone}`);
      assert.match(html.slice(opened, match.index + 400), /class="drop-label"[^>]*>Drag (a file here, or choose one|files here, or choose them)</, `${page}#${id}'s drop area says what to do`);
    }
  }
  assert.deepEqual(found.sort(), ['format/index.html#guideline-files', 'format/index.html#manuscript-file', 'format/index.html#sheet-file', 'index/index.html#list-file', 'index/index.html#manuscript-file', 'index/index.html#pdf-file', 'index/index.html#sheet-file'].sort());
  // No page builds a file input in its script, where this check would not see it.
  for (const entry of await readdir(WEB, { recursive: true })) {
    if (!entry.endsWith('.js') || entry.startsWith('vendor')) continue;
    assert.doesNotMatch(await readFile(join(WEB, entry), 'utf8'), /type: 'file'|type: "file"|\.type = 'file'/, entry);
  }
});
