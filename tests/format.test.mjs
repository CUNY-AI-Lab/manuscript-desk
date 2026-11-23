import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { formatDocx } from '../lib/format/format.js';
import { validateDocx } from '../lib/docx/validate.js';
import { readPackage } from '../lib/docx/write.js';
import { compareWords, documentWords } from '../lib/format/words.js';
import { readUnits } from '../scripts/format-eval.mjs';
import { RULES, manuscript, sheetWith } from './manuscript-fixture.mjs';

const format = (rules = [], options = {}) => {
  const { bytes, roles } = manuscript(options);
  const result = formatDocx({ bytes, roles, sheet: rules.length ? sheetWith(rules) : null });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { result, source: bytes, roles };
};
const units = bytes => readUnits(bytes).units;
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);
const declared = (result, kind) => result.report.declared.find(entry => entry.kind === kind)?.count ?? 0;
const wordCheck = ({ result, source }) => {
  const words = part => { const { files, main } = readPackage(part); return documentWords(files, main); };
  return compareWords(words(source), words(result.bytes), result.report.declared);
};
const unitWith = (bytes, text) => units(bytes).find(unit => unit.text.includes(text));

test('each paragraph with a role gets the style for its role; paragraphs without one keep theirs', () => {
  const { result } = format();
  const byText = text => unitWith(result.bytes, text).styleName;
  assert.equal(byText('Paper Lanterns'), 'heading 1');
  assert.equal(byText('Ada Placeholder'), 'Chapter Author');
  assert.equal(byText('University of Elsewhere'), 'Chapter Affiliation');
  assert.equal(byText('This chapter asks'), 'Abstract');
  assert.equal(byText('Keywords:'), 'Keywords');
  assert.equal(byText('Opening the Box'), 'heading 2');
  assert.equal(byText('A quotation set off'), 'Block Quotation');
  assert.equal(byText('A line of verse that rises'), 'Verse');
  assert.equal(byText('Bibliography'), 'Bibliography Heading');
  assert.equal(byText('Writer, Some.'), 'Bibliography');
  assert.equal(byText('Glass Bells'), 'heading 1');
  assert.equal(byText('Sounding Invented Objects'), 'Chapter Subtitle');
  assert.equal(byText('Ben Example and Cy Sample'), 'Chapter Author');
  assert.equal(byText('Institute of Nowhere'), 'Chapter Affiliation');
  assert.equal(byText('A Volume of Invented Essays'), '(none)', 'front matter without roles is left as it was');
  assert.equal(unitWith(result.bytes, 'Left cell').styleName, '(table)');
  assert.match(part(result.bytes, 'word/document.xml'), /<w:tc><w:tcPr>[^]*?<w:p><w:pPr><w:pStyle w:val="TableText"\/>/);
});

test('the first body paragraph after a heading, a quotation, verse or the title block has no indent', () => {
  const { result } = format();
  const byText = text => unitWith(result.bytes, text).styleName;
  assert.equal(byText('The first paragraph after a heading'), 'Body Text First');
  assert.equal(byText('A second paragraph'), 'Body Text');
  assert.equal(byText('The paragraph after a quotation'), 'Body Text First');
  assert.equal(byText('Then the text resumes'), 'Body Text First');
  assert.equal(byText('The second chapter opens'), 'Body Text First');
  assert.equal(byText('Its second paragraph'), 'Body Text');
});

test('direct paragraph formatting goes; character formatting that carries meaning stays', () => {
  const { result } = format();
  const xml = part(result.bytes, 'word/document.xml');
  const body = xml.slice(xml.indexOf('Paper Lanterns'));
  for (const gone of ['<w:spacing w:line="480"', '<w:jc w:val="both"/>', '<w:ind w:firstLine="720"/>', '<w:widowControl', '<w:b w:val="0"/>', '<w:sz w:val="24"/>', '<w:color w:val="000000"/>', '<w:u w:val="none"/>', '<w:vertAlign w:val="baseline"/>', '<w:rtl w:val="0"/>', 'w:ascii="Book Serif"']) {
    assert.ok(!body.slice(0, body.lastIndexOf('</w:body>')).includes(gone), gone);
  }
  assert.match(xml, /<w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">italics<\/w:t>/, 'italics inside a sentence stay');
  assert.match(xml, /<w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteReference w:id="1"\/>/, 'note references stay');
  assert.match(xml, /<w:hyperlink r:id="rId3">/, 'links stay');
  assert.match(xml, /<w:sdt><w:sdtPr><w:tag w:val="x"\/><\/w:sdtPr><w:sdtContent>/, 'content controls stay');
  // The whole-paragraph bold of a title and the italics of a heading are the style's now.
  const title = xml.slice(xml.indexOf('Glass Bells') - 200, xml.indexOf('Glass Bells'));
  assert.doesNotMatch(title, /<w:b\/>/);
  const heading = xml.slice(xml.indexOf('Opening the Box') - 200, xml.indexOf('Opening the Box'));
  assert.doesNotMatch(heading, /<w:i\/>/);
  // The body's font and size move to Normal, so the text keeps its look.
  const styles = part(result.bytes, 'word/styles.xml');
  assert.match(styles, /<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"\/><w:rPr><w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif" w:eastAsia="Book Serif" w:cs="Book Serif"\/><w:sz w:val="24"\/><w:szCs w:val="24"\/><\/w:rPr>/);
  assert.match(styles, /w:styleId="BodyText"><w:name w:val="Body Text"\/>[^]*?<w:spacing w:before="0" w:after="0" w:line="480" w:lineRule="auto"\/>/, 'the body keeps its line spacing');
});

test('every style a paragraph names is defined, an existing style keeps its id, and a duplicate definition goes', () => {
  const { result } = format();
  const styles = part(result.bytes, 'word/styles.xml');
  assert.equal(styles.match(/w:styleId="Heading1"/g).length, 1, 'heading 1 is redefined in place');
  assert.equal(styles.match(/w:styleId="TableNormal"/g).length, 1);
  assert.equal(declared(result, 'duplicate style definition removed'), 1);
  const validity = validateDocx(result.bytes);
  assert.deepEqual(validity.problems, []);
});

test('the words of the output are the words of the source', () => {
  const run = format();
  const check = wordCheck(run);
  assert.equal(check.comparable, true);
  assert.equal(check.removed, 0);
  assert.equal(check.added, 0);
});

test('empty spacer paragraphs from the first chapter on go and are counted; a stanza break and a bookmark stay', () => {
  const { result, source } = format();
  const before = units(source).filter(unit => unit.kind === 'paragraph' && unit.text === '').length;
  const after = units(result.bytes).filter(unit => unit.kind === 'paragraph' && unit.text === '').length;
  // The spacer before the first title, the one holding a bookmark, and three inside or between chapters.
  assert.equal(declared(result, 'empty paragraph removed'), 5);
  assert.equal(declared(result, 'empty paragraph kept as a stanza break'), 1);
  assert.equal(before - after, 5);
  const xml = part(result.bytes, 'word/document.xml');
  assert.match(xml, /<w:bookmarkStart w:id="7" w:name="here"\/><w:bookmarkEnd w:id="7"\/><w:r><w:t xml:space="preserve">This chapter asks/, 'the bookmark of a removed paragraph moves to the next one');
  assert.match(xml, /<w:p><w:pPr><w:pStyle w:val="Verse"\/><\/w:pPr><\/w:p>/, 'the stanza break is an empty verse line');
});

test('with notes restarting in each chapter, each chapter is a section of its own that restarts note numbers', () => {
  const { result } = format([RULES.restart]);
  const validity = validateDocx(result.bytes);
  assert.equal(validity.ok, true, JSON.stringify(validity.problems));
  assert.equal(validity.counts.sections, 3, 'the front matter, then one section per chapter');
  assert.equal(validity.counts.sectionsRestartingNotes, 3);
  const xml = part(result.bytes, 'word/document.xml');
  // The break before chapter two is a copy of the properties of the section it falls in, a new page.
  const before = xml.slice(0, xml.indexOf('Glass Bells'));
  assert.match(before, /<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"\/><\/w:footnotePr><w:type w:val="nextPage"\/><w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.equal(declared(result, 'section break added at the start of a chapter'), 1, 'the first chapter already starts after a break');
  assert.match(xml, /<\/w:p><w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"\/><\/w:footnotePr><w:pgSz/, 'the body keeps its own section properties last');
});

test('without that rule no section break is added', () => {
  const { result } = format();
  const validity = validateDocx(result.bytes);
  assert.equal(validity.counts.sections, 2, 'the source front-matter break and the body');
  assert.equal(validity.counts.sectionsRestartingNotes, 0);
  assert.equal(result.report.declared.some(entry => /section/.test(entry.kind)), false);
});

test('a title is split at its colon only when the sheet asks, as a declared change', () => {
  const plain = format();
  assert.equal(unitWith(plain.result.bytes, 'Paper Lanterns').text, 'Paper Lanterns: How Invented Things Are Read');
  const split = format([RULES.split]);
  const title = unitWith(split.result.bytes, 'Paper Lanterns');
  const subtitle = unitWith(split.result.bytes, 'How Invented Things');
  assert.equal(title.text, 'Paper Lanterns');
  assert.equal(title.styleName, 'heading 1');
  assert.equal(subtitle.text, 'How Invented Things Are Read');
  assert.equal(subtitle.styleName, 'Chapter Subtitle');
  assert.equal(unitWith(split.result.bytes, 'Glass Bells').text, 'Glass Bells', 'a title that has a subtitle line is not split');
  assert.equal(declared(split.result, 'title split at a colon into a title and a subtitle'), 1);
  const check = wordCheck(split);
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0);
  assert.equal(check.removed, 1, 'the word that carried the colon');
  assert.equal(validateDocx(split.result.bytes).ok, true);
});

test('numbered headings use Word numbering, not typed text, and typed numbers are left alone', () => {
  const { result } = format([RULES.numbered]);
  const numbering = part(result.bytes, 'word/numbering.xml');
  assert.match(numbering, /<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"\/><w:lvl w:ilvl="0">[^]*<w:lvlText w:val="%2"\/>[^]*<w:lvlText w:val="%2.%3"\/>/);
  assert.match(numbering, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/><\/w:num>/);
  const styles = part(result.bytes, 'word/styles.xml');
  assert.match(styles, /w:styleId="Heading2"><w:name w:val="heading 2"\/>[^]*?<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr>/);
  assert.equal(unitWith(result.bytes, 'Opening the Box').text, 'Opening the Box', 'no number is typed');
  const files = unzipSync(result.bytes);
  assert.ok(files['word/numbering.xml'] && strFromU8(files['[Content_Types].xml']).includes('/word/numbering.xml'));
  assert.equal(validateDocx(result.bytes).ok, true);
  assert.equal(declared(result, 'heading numbers added through Word numbering (no typed text)'), 2);

  const typed = format([RULES.numbered], { typedNumbers: true });
  const xml = part(typed.result.bytes, 'word/document.xml');
  assert.match(xml, /<w:pStyle w:val="Heading2"\/><w:numPr><w:numId w:val="0"\/><\/w:numPr>[^]*?1 Opening the Box/, 'a chapter whose headings carry typed numbers gets no Word numbering');
});

test('a figure becomes a placement marker and a caption line when the sheet asks for markers', () => {
  const { result } = format([RULES.markers]);
  const list = units(result.bytes);
  const marker = list.find(unit => unit.text.includes('about here]'));
  assert.equal(marker.text, '[Figure 1.1 about here]');
  assert.equal(marker.styleName, 'Figure Marker');
  const caption = list[list.indexOf(marker) + 1];
  assert.equal(caption.text, 'Figure 1.1');
  assert.equal(caption.styleName, 'Figure Caption');
  assert.equal(result.report.needsAuthor['figure caption to write'], 1);
  const check = wordCheck({ result, source: manuscript().bytes });
  assert.equal(check.undeclaredRemoved + check.undeclaredAdded, 0);

  const plain = format();
  assert.equal(unitWith(plain.result.bytes, '[FIGURE 1 HERE]').styleName, 'Figure Caption', 'without the rule the paragraph is only restyled');
});

test('note paragraphs take the note style and lose their direct formatting; the notes stay whole', () => {
  const { result } = format([RULES.restart]);
  const notes = part(result.bytes, 'word/footnotes.xml');
  assert.match(notes, /<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"\/><\/w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteRef\/><\/w:r>/);
  assert.match(notes, /<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator\/>/);
  assert.equal(validateDocx(result.bytes).counts.footnoteReferences, 2);
});

test('refuses a file with tracked changes, and a file that is not a .docx', () => {
  const { bytes, roles } = manuscript();
  const files = unzipSync(bytes);
  const document = strFromU8(files['word/document.xml']).replace('A second paragraph', '</w:t></w:r><w:ins w:id="9" w:author="a"><w:r><w:t>new</w:t></w:r></w:ins><w:r><w:t>A second paragraph');
  const tracked = zipSync({ ...files, 'word/document.xml': new TextEncoder().encode(document) });
  assert.equal(formatDocx({ bytes: tracked, roles }).code, 'tracked_changes');
  assert.equal(formatDocx({ bytes: new Uint8Array([1, 2, 3]), roles }).code, 'not_docx');
});

test('the lines of a quotation pasted one per paragraph are joined back into its paragraphs', () => {
  const { result } = format();
  const quotation = units(result.bytes).filter(unit => unit.styleName === 'Block Quotation').map(unit => unit.text);
  assert.deepEqual(quotation.slice(1), ['The lantern was not lit when we came in, and the room was as dark as the street outside, where nobody waited. We sat down.', 'Then a second paragraph of the quotation begins.']);
  assert.equal(declared(result, 'lines of a quotation pasted one per paragraph joined into its paragraph'), 2);
  assert.equal(wordCheck({ result, source: manuscript().bytes }).added, 0);
});

test('an author line that names the institution in brackets is split from it', () => {
  const run = format([], { authorWithAffiliation: true });
  assert.equal(unitWith(run.result.bytes, 'Ada Placeholder').text, 'Ada Placeholder');
  assert.equal(unitWith(run.result.bytes, 'Ada Placeholder').styleName, 'Chapter Author');
  assert.equal(unitWith(run.result.bytes, 'University of Elsewhere').text, '(University of Elsewhere)');
  assert.equal(unitWith(run.result.bytes, 'University of Elsewhere').styleName, 'Chapter Affiliation');
  const check = wordCheck(run);
  assert.equal(check.removed + check.added, 0, 'the words are the same, now in two paragraphs');
});

test('style ids, names and values from the document that hold " < & \' > are escaped, never written as markup', () => {
  const { bytes, roles } = manuscript({ hostile: true });
  const result = formatDocx({ bytes, roles, sheet: sheetWith([RULES.restart, RULES.numbered]) });
  assert.equal(result.ok, true);
  assert.deepEqual(validateDocx(result.bytes).problems, [], 'every style reference still resolves');
  const hostile = 'Bo"<&\'>dy';
  const styles = part(result.bytes, 'word/styles.xml');
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="Bo&quot;&lt;&amp;&apos;&gt;dy"><w:name w:val="Body Text"\/><w:basedOn w:val="Nor&quot;&lt;&amp;&apos;&gt;mal"\/>/, 'the existing Body Text keeps its id; Normal is its base');
  assert.doesNotMatch(styles, /w:line="480/, 'a line spacing that is not a number is not copied');
  const body = units(result.bytes).find(unit => unit.text.startsWith('A second paragraph'));
  assert.equal(body.styleId, hostile);
  assert.equal(body.styleName, 'Body Text');
});

test('a part the stage cannot work with is a typed failure, not an exception', () => {
  const { bytes, roles } = manuscript();
  const files = unzipSync(bytes);
  const broken = zipSync({ ...files, 'word/styles.xml': new TextEncoder().encode('<w:styles xmlns:w="x"><unclosed></w:styles>') });
  assert.deepEqual(Object.keys(formatDocx({ bytes: broken, roles })), ['ok', 'code', 'message']);
  assert.equal(formatDocx({ bytes: broken, roles }).code, 'unreadable');
  assert.equal(formatDocx().code, 'not_docx');
});
