// Writes the guidelines test fixtures next to this script. Run once (node tests/fixtures/make-fixtures.mjs)
// and commit the output. All text is invented for the tests.
//   guidelines.docx  a minimal Word file (a zip of three XML parts, stored uncompressed)
//   guidelines.pdf   a two-page PDF with a text layer
//   scanned.pdf      a one-page PDF holding only an image, no text layer
import { writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import * as mupdf from 'mupdf';

const here = name => new URL(name, import.meta.url);

const PAGES = [
  [
    'Manuscript preparation',
    'Use double quotation marks throughout the manuscript.',
    'Single quotation marks are kept for quotations within quotations.',
    'Set the whole text, notes included, in one 12-point font,',
    'double spaced, with margins of at least one inch.',
  ],
  [
    'Notes and references',
    'Number the notes from 1 in each chapter and place them as endnotes.',
    'Cite sources in the author-date style and list every work cited',
    'in a reference list at the end of each chapter.',
  ],
];

// A zip with every entry stored (method 0), which is all a .docx needs.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paragraphs = PAGES.flat().map(line => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('');

const docx = zip([
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'],
  ['word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paragraphs}</w:body></w:document>`],
]);
writeFileSync(here('guidelines.docx'), docx);

const LETTER = [0, 0, 612, 792];
const pdfString = s => `(${s.replace(/[\\()]/g, c => `\\${c}`)})`;

const textPdf = new mupdf.PDFDocument();
const font = textPdf.addSimpleFont(new mupdf.Font('Helvetica'));
for (const lines of PAGES) {
  const contents = `BT /F1 11 Tf 16 TL 72 720 Td ${lines.map(line => `${pdfString(line)} Tj T*`).join(' ')} ET`;
  textPdf.insertPage(-1, textPdf.addPage(LETTER, 0, { Font: { F1: font } }, contents));
}
writeFileSync(here('guidelines.pdf'), textPdf.saveToBuffer('compress,garbage').asUint8Array());

// A 120 x 60 grey image of horizontal bands, like a photographed page; drawn full width, no text.
const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 120, 60], false);
const pixels = pixmap.getPixels();
for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) pixels[y * pixmap.getStride() + x] = y % 6 < 2 && x > 8 && x < 112 ? 40 : 235;
const scannedPdf = new mupdf.PDFDocument();
const image = scannedPdf.addImage(new mupdf.Image(pixmap));
scannedPdf.insertPage(-1, scannedPdf.addPage(LETTER, 0, { XObject: { Im0: image } }, 'q 468 0 0 234 72 486 cm /Im0 Do Q'));
writeFileSync(here('scanned.pdf'), scannedPdf.saveToBuffer('compress,garbage').asUint8Array());

console.log('Wrote guidelines.docx, guidelines.pdf and scanned.pdf');
