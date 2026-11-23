import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { XmlError, descendants, parseXml, serializeXml, setWordAttribute, wordAttribute, wordElement, wordPrefix } from '../lib/docx/xml.js';
import { PackageError, addRelatedPart, readPackage, relatedPart, relationshipsOf, relsPartOf, resolveTarget, writePackage } from '../lib/docx/write.js';
import { validateDocx } from '../lib/docx/validate.js';
import { manuscript } from './manuscript-fixture.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

test('a part is written back as it was read: prefixes, attribute order, declarations, text, comments', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><!-- a comment --><w:body><w:p w:rsidR="00A1" w:rsidRDefault="00B2"><w:r><w:t xml:space="preserve"> a &amp; b &lt; c &gt; d "e" </w:t></w:r></w:p><?pi some body?><w:sectPr/></w:body></w:document>`;
  const { root, declared } = parseXml(xml);
  assert.equal(declared, true);
  assert.equal(serializeXml(root), xml.replace('"e"', '"e"'));
  assert.equal(wordPrefix(root), 'w');
  const paragraph = [...descendants(root, 'p')][0];
  assert.equal(wordAttribute(paragraph, 'rsidR'), '00A1');
  setWordAttribute(paragraph, 'rsidR', '00C3');
  setWordAttribute(paragraph, 'rsidP', '00D4');
  assert.match(serializeXml(root), /<w:p w:rsidR="00C3" w:rsidRDefault="00B2" w:rsidP="00D4">/);
});

test('attribute values keep tabs and line breaks, and quotes are escaped', () => {
  const { root } = parseXml(`<a b="x&#9;y&#10;z &quot;q&quot; &amp; &lt;"/>`);
  assert.equal(serializeXml(root, { declaration: false }), '<a b="x&#9;y&#10;z &quot;q&quot; &amp; &lt;"/>');
});

test('XML that is not well-formed is refused', () => {
  assert.throws(() => parseXml('<a><b></a>'), XmlError);
  assert.throws(() => parseXml('<w:a/>'), XmlError, 'an unbound prefix');
  assert.throws(() => parseXml(''), XmlError);
});

test('a new Word element uses the part\'s prefix', () => {
  const element = wordElement('x', 'pStyle', { val: 'Body' });
  assert.equal(serializeXml(element, { declaration: false }), '<x:pStyle x:val="Body"/>');
  assert.equal(serializeXml(wordElement('w', 't', { 'xml:space': 'preserve' }, [{ type: 'text', text: 'a' }]), { declaration: false }), '<w:t xml:space="preserve">a</w:t>');
});

test('a package is read whole and written back with its parts unchanged', () => {
  const { bytes } = manuscript();
  const { files, main } = readPackage(bytes);
  assert.equal(main, 'word/document.xml');
  assert.equal(files.size, 6);
  const again = readPackage(writePackage(files));
  assert.deepEqual([...again.files.keys()].sort(), [...files.keys()].sort());
  for (const [name, data] of files) assert.deepEqual(again.files.get(name), data, name);
  assert.equal(Object.keys(unzipSync(writePackage(files)))[0], '[Content_Types].xml');
  assert.throws(() => readPackage(new Uint8Array([1, 2, 3, 4])), error => error instanceof PackageError && error.code === 'not_docx');
});

test('relationships resolve against the part that holds them', () => {
  assert.equal(relsPartOf('word/document.xml'), 'word/_rels/document.xml.rels');
  assert.equal(relsPartOf(''), '_rels/.rels');
  assert.equal(resolveTarget('word/document.xml', 'media/image1.png'), 'word/media/image1.png');
  assert.equal(resolveTarget('word/document.xml', '../customXml/item1.xml'), 'customXml/item1.xml');
  assert.equal(resolveTarget('word/document.xml', '/word/styles.xml'), 'word/styles.xml');
  const { files } = readPackage(manuscript().bytes);
  assert.equal(relatedPart(files, 'word/document.xml', 'footnotes'), 'word/footnotes.xml');
  assert.equal(relatedPart(files, 'word/document.xml', 'numbering'), null);
  assert.equal(relationshipsOf(files, 'word/document.xml').find(rel => rel.external).resolved, null);
});

test('a new part gets its relationship and its content type', () => {
  const { files, main } = readPackage(manuscript().bytes);
  const name = addRelatedPart(files, main, 'numbering', `<w:numbering xmlns:w="${W}"/>`);
  assert.equal(name, 'word/numbering.xml');
  assert.equal(relatedPart(files, main, 'numbering'), 'word/numbering.xml');
  assert.match(strFromU8(files.get('[Content_Types].xml')), /PartName="\/word\/numbering.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.numbering\+xml"/);
  assert.deepEqual(validateDocx(writePackage(files)).problems.map(problem => problem.code), ['style_id_duplicate'], 'only the invented source\'s own duplicate');
});

test('the validator passes a sound file and names each kind of damage', () => {
  const { bytes } = manuscript();
  const sound = validateDocx(bytes);
  assert.deepEqual(sound.problems.map(problem => problem.code), ['style_id_duplicate'], 'the invented source has a duplicate table style, as exports do');
  const files = unzipSync(bytes);
  const broken = (name, change) => {
    const copy = { ...files, [name]: strToU8(change(strFromU8(files[name]))) };
    return validateDocx(zipSync(copy)).problems.map(problem => problem.code).filter(code => code !== 'style_id_duplicate');
  };
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Missing"/></w:pPr>')), ['pStyle_undefined']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('w:footnoteReference w:id="1"', 'w:footnoteReference w:id="9"')), ['footnote_missing']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('<w:tc><w:tcPr>', '<w:tc><w:sectPr/><w:tcPr>')), ['section_properties_misplaced']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('<w:body>', '<w:body><w:p><w:pPr><w:jc w:val="left"/><w:pStyle w:val="Normal"/></w:pPr></w:p>')), ['paragraph_properties_out_of_order']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('</w:body>', '<w:p/></w:body>')), ['body_section_missing', 'section_properties_misplaced']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('r:id="rId3"', 'r:id="rId99"')), ['relationship_id_unknown']);
  assert.deepEqual(broken('word/document.xml', xml => xml.replace('</w:body>', '')), ['xml_not_well_formed']);
  assert.deepEqual(broken('word/_rels/document.xml.rels', xml => xml.replace('Target="styles.xml"', 'Target="nowhere.xml"')), ['relationship_target_missing']);
  assert.deepEqual(broken('[Content_Types].xml', xml => xml.replace('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>', '').replace('<Default Extension="xml" ContentType="application/xml"/>', '')), ['content_type_missing'], 'the notes part has neither an override nor a default');
  assert.equal(validateDocx(new Uint8Array([0])).problems[0].code, 'not_docx');
});
