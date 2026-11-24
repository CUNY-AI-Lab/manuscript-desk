// Builds an invented edited volume as a .docx, typed with direct formatting and no styles, with what
// the decide step works on: a typed contents list (calling the introduction "Introduction" while its
// title page gives only its own title), notes on contributors, a chapter title typed in capitals, a
// note on an author's line, keywords with mixed separators, a bibliography with a repeated-author
// dash and a stray letter on a line of its own, a passage of verse typed twice, a quotation pasted
// one line per paragraph, and a typing slip in running text. All text is invented for the tests.
// `volume()` returns { bytes, roles, sheet, count, at } (`at` names the paragraphs the tests use).
import { strToU8, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style></w:styles>`;
const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/></w:settings>`;
const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`
  + '<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> This chapter was first given as a talk.</w:t></w:r></w:p></w:footnote>'
  + '<w:footnote w:id="2"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> A note in the running text.</w:t></w:r></w:p></w:footnote></w:footnotes>';

const RUN = '<w:rFonts w:ascii="Book Serif" w:hAnsi="Book Serif"/><w:sz w:val="24"/><w:szCs w:val="24"/>';
const BODY = '<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:firstLine="720"/>';
const CENTRED = '<w:spacing w:line="480" w:lineRule="auto"/><w:jc w:val="center"/>';
const INDENTED = '<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:left="1440"/>';
const HANGING = '<w:ind w:left="720" w:hanging="720"/>';
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const run = (text, extra = '') => `<w:r><w:rPr>${RUN}${extra}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const note = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const p = (content, pPr = BODY) => `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`;
const line = (text, role, pPr = BODY, extra = '') => [p(run(text, extra) , pPr), role, text];
const empty = () => [`<w:p><w:pPr>${BODY}</w:pPr></w:p>`, null, ''];

function children() {
  return [
    line('Lanterns and Bells', 'title-page', CENTRED, '<w:b/>'),
    line('Edited by Ada Placeholder', 'title-page', CENTRED),
    empty(),
    line('Contents', 'front-matter-heading', CENTRED, '<w:b/>'),
    line('Introduction: Why We Read Lanterns 1', 'contents-entry'),
    line('BEN EXAMPLE - Institute of Nowhere', 'contents-entry'),
    line('Glass Bells and Other Things 9', 'contents-entry'),
    line('Paper Ships Afloat 21', 'contents-entry'),
    empty(),
    line('Notes on Contributors', 'front-matter-heading', CENTRED, '<w:b/>'),
    line('Ben Example teaches the history of sound at the Institute of Nowhere and writes about bells.', 'contributor-note'),
    line('Cy Sample writes about paper, folding and the boats children make from newspaper.', 'contributor-note'),
    empty(),
    // The introduction: its title page gives only its own title.
    line('Why We Read Lanterns', 'title-block', CENTRED, '<w:b/>'),
    line('Ada Placeholder', 'title-block', CENTRED),
    line('An introduction opens the volume and says what each chapter does.', 'body'),
    line('It names the chapters in the order they come.', 'body'),
    // Chapter 1: a title in capitals, a note on the author's line.
    line('GLASS BELLS AND OTHER THINGS', 'title-block', CENTRED, '<w:b/>'),
    [p(run('Ben Example') + note(1), CENTRED), 'title-block', 'Ben Example'],
    line('Institute of Nowhere', 'title-block', CENTRED),
    line('This chapter listens to glass bells and asks what they are for.', 'abstract', INDENTED),
    line('Keywords: bells; glass, sound', 'keywords', INDENTED),
    line('The Sound', 'heading-1', BODY, '<w:i/>'),
    [p(run('Bells ring tehm out over the water') + note(2) + run(' every evening.')), 'body', 'Bells ring tehm out over the water every evening.'],
    line('Bibliography', 'bibliography-heading', BODY, '<w:b/>'),
    line('Example, Ben. Bells. Nowhere: Press, 2001.', 'bibliography-entry', HANGING),
    line('———. Glass. Nowhere: Press, 2003.', 'bibliography-entry', HANGING),
    line('s', 'bibliography-entry', HANGING),
    line('Sample, Cy, and J. M. Writer. Paper. Elsewhere: Press, 2004.', 'bibliography-entry', HANGING),
    line('——. Boats. Elsewhere: Press, 2006.', 'bibliography-entry', HANGING),
    empty(),
    // Chapter 2: verse typed twice, a quotation pasted one line per paragraph.
    line('Paper Ships', 'title-block', CENTRED, '<w:b/>'),
    line('Cy Sample', 'title-block', CENTRED),
    line('University of Elsewhere', 'title-block', CENTRED),
    line('Ships of paper sail on every pond in the town.', 'body'),
    line('A paper ship sets out at dawn,', 'verse', INDENTED),
    line('and the water takes it home.', 'verse', INDENTED),
    line('A paper ship sets out at dawn,', 'verse', INDENTED),
    line('and the water takes it home. ', 'verse', INDENTED),
    line('The quotation came in as one paragraph per line, and the', 'block-quotation', INDENTED),
    line('reader is asked to check how it was joined.', 'block-quotation', INDENTED),
    line('The end of the chapter.', 'body'),
  ];
}

/** A rule sheet for the volume, written by hand, with guidelines' quotations invented for the tests. */
export function volumeSheet() {
  const rule = (id, category, slot, params, statement, mode = 'fix') => ({ id, category, slot, statement, mode, source: { kind: 'guidelines', quote: `An invented guideline sentence: ${statement}`, doc: 0 }, params, enabled: true });
  return {
    version: 1,
    docType: 'edited-collection',
    manual: { id: null, named: null },
    rules: [
      rule('notes-1', 'notes', 'notes.restart', { per: 'chapter' }, 'Note numbers start again in each chapter.'),
      rule('headings-1', 'headings', 'headings.case', { case: 'title' }, 'Titles and headings take title case.'),
      rule('references-1', 'references', 'references.repeated-author', { form: 'name' }, 'Give the full name of a repeated author, never a dash.'),
      rule('notes-2', 'notes', 'notes.titles', { allowed: false }, 'No notes on chapter titles or authors’ names.'),
      rule('abstract-1', 'abstract-keywords', 'abstract.words', { max: 200 }, 'Each chapter has an abstract of about 200 words.', 'flag'),
      rule('files-1', 'files', null, {}, 'Send each image as a separate file at 300 dpi.', 'supply'),
      rule('files-2', 'files', null, {}, 'Send the signed permission form for every image.', 'supply'),
      rule('files-3', 'files', null, {}, 'Send a cover image suggestion.', 'supply'),
      rule('other-1', 'other', null, {}, 'Consider whether the volume needs an index of names.', 'flag'),
      rule('other-2', 'other', null, {}, 'The front matter includes a list of illustrations.', 'flag'),
    ],
    dropped: 0,
    created: '2026-11-23T12:00:00Z',
  };
}

export function volume() {
  const list = children();
  const body = `${list.map(([xml]) => xml).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
  const roles = {};
  const at = {};
  list.forEach(([, role, text], index) => { if (role) roles[index] = role; if (text) at[text.trim()] = index; });
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/styles.xml': strToU8(STYLES),
    'word/settings.xml': strToU8(SETTINGS),
    'word/footnotes.xml': strToU8(FOOTNOTES),
  });
  return { bytes, roles, sheet: volumeSheet(), count: list.length, at };
}

/** A scripted model for the decide step's units: the settings stay, every running-text query goes to
 * the copyeditor, a title change is proposed first (and must be refused), and the rules are triaged. */
export function scriptedModel(log = []) {
  return async ({ kind, reading, messages }) => {
    log.push({ kind, reading });
    const text = messages[0].content;
    const tool = (name, args) => ({ message: { content: '', tool_calls: [{ id: `${name}-${messages.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
    if (kind === 'settings') return tool('clear_settings', { items: [] });
    if (kind === 'findings') {
      if (messages.length === 1) return { message: { content: '', tool_calls: [{ id: 'p', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify({ paragraph: 13, before: 'Why We Read Lanterns', after: 'Why We Read: Lanterns', reason: 'divide the title' }) } }] } };
      return tool('decide_findings', { items: [...text.matchAll(/^(F\d+) /gmu)].map(match => ({ id: match[1], choice: 'copyedit' })) });
    }
    const ids = [...text.matchAll(/^([a-z0-9-]+) \((?:to supply|flag|fix)/gmu)].map(match => match[1]);
    return tool('triage_rules', { items: ids.map(id => (/image|permission|cover/iu.test(text.split('\n').find(line => line.startsWith(`${id} `))) ? { id, status: 'deliver', deliverable: /permission/iu.test(text.split('\n').find(line => line.startsWith(`${id} `))) ? 'permissions' : 'image-files' } : { id, status: 'decision', question: 'Does the volume need this?' })) });
  };
}
/** A scripted reading check: one typing slip in chapter 1's running text. */
export const scriptedReading = async ({ unit }) => JSON.stringify({ findings: unit.includes('tehm') ? [{ kind: 'typo', paragraph: 23, quote: 'Bells ring tehm out', note: 'Perhaps “them”.' }] : [] });

