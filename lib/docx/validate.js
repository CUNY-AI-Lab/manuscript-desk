// A structural check of a Word package, used by the tests and the formatting evaluation on every
// file the formatter writes: every XML part parses, content types and relationships are
// consistent, every style, numbering, note and comment a part refers to is defined (and every
// comment is anchored, its range closed), and section properties sit where Word expects them. It reports problem codes with counts, never document text. Pure: no
// DOM, no network.

import { CONTENT_TYPES, readPackage, relatedPart, relationshipsOf } from './write.js';
import { REL_NS, WORD_NAMESPACES, descendants, elements, firstWord, isElement, isWord, parseXml, wordAttribute } from './xml.js';

const WORD = node => isElement(node) && WORD_NAMESPACES.has(node.uri);

const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const STORY_TYPES = new Set(['header', 'footer', 'footnotes', 'endnotes', 'comments']);
const STYLE_KIND = { pStyle: 'paragraph', rStyle: 'character', tblStyle: 'table' };

// The order of the children of w:pPr (CT_PPr), so a rewritten paragraph can be checked.
export const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const PPR_RANK = new Map(PPR_ORDER.map((name, rank) => [name, rank]));

// Whether a node lies inside a tracked deletion (w:del or w:moveFrom), found by walking down from the root.
const insideDeletion = new WeakMap();
function descendantOfDeletion(root, target) {
  if (!insideDeletion.has(root)) {
    const set = new WeakSet();
    const walk = (node, deleted) => {
      for (const child of node.children) {
        if (!isElement(child)) continue;
        const here = deleted || (WORD(child) && (child.local === 'del' || child.local === 'moveFrom'));
        if (here) set.add(child);
        walk(child, here);
      }
    };
    walk(root, false);
    insideDeletion.set(root, set);
  }
  return insideDeletion.get(root).has(target);
}

/**
 * @param {Uint8Array | ArrayBuffer} input the .docx bytes
 * @returns {{ ok: boolean, problems: Array<{ code: string, part: string, count: number }>, counts: object }}
 */
export function validateDocx(input) {
  const found = new Map();
  const problem = (code, part) => {
    const key = `${code}\u0000${part}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  };
  const counts = { parts: 0, sections: 0, sectionsRestartingNotes: 0, footnoteReferences: 0, paragraphs: 0, comments: 0, revisions: 0 };
  const result = () => ({
    ok: found.size === 0,
    problems: [...found].map(([key, count]) => { const [code, part] = key.split('\u0000'); return { code, part, count }; }),
    counts,
  });

  let files, main;
  try {
    ({ files, main } = readPackage(input));
  } catch (error) {
    problem(error?.code ?? 'unreadable', '(package)');
    return result();
  }
  counts.parts = files.size;

  // Every XML part parses.
  const trees = new Map();
  for (const [name, bytes] of files) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    try {
      trees.set(name, parseXml(bytes).root);
    } catch {
      problem('xml_not_well_formed', name);
    }
  }

  // Content types.
  const types = trees.get(CONTENT_TYPES);
  if (!types) problem('content_types_missing', CONTENT_TYPES);
  else {
    const defaults = new Set();
    const overrides = new Set();
    for (const child of types.children) {
      if (!isElement(child) || child.uri !== CONTENT_TYPES_NS) continue;
      const get = name => child.attributes.find(attribute => attribute.local === name && attribute.uri === '')?.value;
      if (child.local === 'Default') defaults.add((get('Extension') ?? '').toLowerCase());
      else if (child.local === 'Override') {
        const part = (get('PartName') ?? '').replace(/^\//, '');
        overrides.add(part.toLowerCase());
        if (!files.has(part)) problem('content_type_override_without_part', part);
      }
    }
    for (const name of files.keys()) {
      if (name === CONTENT_TYPES) continue;
      const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!overrides.has(name.toLowerCase()) && !defaults.has(extension)) problem('content_type_missing', name);
    }
  }

  // Relationships: every internal target exists, ids are unique.
  const relsByPart = new Map();
  for (const name of files.keys()) {
    if (!name.endsWith('.rels')) continue;
    const source = name === '_rels/.rels' ? '' : name.replace(/_rels\/([^/]+)\.rels$/, '$1');
    if (source && !files.has(source)) problem('relationships_without_part', name);
    let rels;
    try {
      rels = relationshipsOf(files, source);
    } catch {
      continue; // already reported as not well-formed
    }
    relsByPart.set(source, rels);
    const ids = new Set();
    for (const rel of rels) {
      if (ids.has(rel.id)) problem('relationship_id_duplicate', name);
      ids.add(rel.id);
      if (!rel.external && !files.has(rel.resolved)) problem('relationship_target_missing', name);
    }
  }
  const rootRels = trees.get('_rels/.rels');
  if (rootRels && !elements(rootRels).every(child => child.uri === RELATIONSHIPS_NS)) problem('relationships_namespace', '_rels/.rels');

  const document = trees.get(main);
  if (!document) {
    if (!files.has(main)) problem('main_part_missing', main);
    return result();
  }

  // Styles.
  const stylesPart = relatedPart(files, main, 'styles');
  const styles = { paragraph: new Set(), character: new Set(), table: new Set(), numbering: new Set() };
  const allStyles = new Set();
  const stylesTree = stylesPart ? trees.get(stylesPart) : null;
  if (stylesTree) {
    for (const style of elements(stylesTree, 'style')) {
      const id = wordAttribute(style, 'styleId');
      const kind = wordAttribute(style, 'type') ?? 'paragraph';
      if (id === undefined) { problem('style_without_id', stylesPart); continue; }
      if (allStyles.has(id)) problem('style_id_duplicate', stylesPart);
      allStyles.add(id);
      styles[kind]?.add(id);
    }
    for (const style of elements(stylesTree, 'style')) {
      for (const link of ['basedOn', 'next', 'link']) {
        const target = firstWord(style, link);
        if (target && !allStyles.has(wordAttribute(target, 'val'))) problem(`style_${link}_undefined`, stylesPart);
      }
    }
  }

  // Numbering.
  const numberingPart = relatedPart(files, main, 'numbering');
  const numbering = new Set();
  const numberingTree = numberingPart ? trees.get(numberingPart) : null;
  if (numberingTree) {
    const abstracts = new Set(elements(numberingTree, 'abstractNum').map(node => wordAttribute(node, 'abstractNumId')));
    for (const num of elements(numberingTree, 'num')) {
      numbering.add(wordAttribute(num, 'numId'));
      const abstract = firstWord(num, 'abstractNumId');
      if (!abstract || !abstracts.has(wordAttribute(abstract, 'val'))) problem('numbering_abstract_undefined', numberingPart);
    }
  }

  // Notes.
  const noteIds = type => {
    const part = relatedPart(files, main, type);
    const tree = part ? trees.get(part) : null;
    const ids = new Set();
    if (tree) for (const note of elements(tree, type === 'footnotes' ? 'footnote' : 'endnote')) ids.add(wordAttribute(note, 'id'));
    return ids;
  };
  const footnotes = noteIds('footnotes');
  const endnotes = noteIds('endnotes');

  // Comments: unique ids, each with an author.
  const commentsPart = relatedPart(files, main, 'comments');
  const commentsTree = commentsPart ? trees.get(commentsPart) : null;
  const commentIds = new Set();
  if (commentsTree) {
    for (const comment of elements(commentsTree, 'comment')) {
      const id = wordAttribute(comment, 'id');
      if (commentIds.has(id)) problem('comment_id_duplicate', commentsPart);
      commentIds.add(id);
      if (!wordAttribute(comment, 'author')) problem('comment_without_author', commentsPart);
      counts.comments += 1;
    }
  }
  const commentReferences = new Set();
  const revisionIds = new Set();

  // The parts that hold text: the main part and the stories it reaches.
  const stories = [main, ...(relsByPart.get(main) ?? []).filter(rel => !rel.external && STORY_TYPES.has(rel.type.slice(rel.type.lastIndexOf('/') + 1))).map(rel => rel.resolved)];
  for (const part of stories) {
    const tree = trees.get(part);
    if (!tree) continue;
    const relIds = new Set((relsByPart.get(part) ?? []).map(rel => rel.id));
    const rangeStarts = new Set();
    const rangeEnds = new Set();
    for (const node of descendants(tree)) {
      for (const attribute of node.attributes) {
        if (attribute.uri === REL_NS && ['id', 'embed', 'link', 'pict'].includes(attribute.local) && !relIds.has(attribute.value)) problem('relationship_id_unknown', part);
      }
      if (!WORD(node)) continue;
      const kind = STYLE_KIND[node.local];
      if (kind && stylesTree && !styles[kind].has(wordAttribute(node, 'val'))) problem(`${node.local}_undefined`, part);
      if (node.local === 'numPr') {
        const numId = firstWord(node, 'numId');
        const value = numId ? wordAttribute(numId, 'val') : undefined;
        if (value !== undefined && value !== '0' && !numbering.has(value)) problem('numbering_undefined', part);
      }
      if (node.local === 'footnoteReference') {
        if (part === main) counts.footnoteReferences += 1;
        if (!footnotes.has(wordAttribute(node, 'id'))) problem('footnote_missing', part);
      }
      if (node.local === 'endnoteReference' && !endnotes.has(wordAttribute(node, 'id'))) problem('endnote_missing', part);
      // Tracked changes: each with an author, a date and an id of its own.
      if (node.local === 'ins' || node.local === 'del') {
        const id = wordAttribute(node, 'id');
        if (id === undefined || revisionIds.has(`${part}\u0000${id}`)) problem('revision_id_duplicate_or_missing', part);
        revisionIds.add(`${part}\u0000${id}`);
        if (!wordAttribute(node, 'author')) problem('revision_without_author', part);
        if (part === main) counts.revisions += 1;
      }
      if (node.local === 'delText' && !descendantOfDeletion(tree, node)) problem('deleted_text_outside_deletion', part);
      if (node.local === 't' && descendantOfDeletion(tree, node)) problem('text_inside_deletion', part);
      if (node.local === 'commentRangeStart' || node.local === 'commentRangeEnd' || node.local === 'commentReference') {
        const id = wordAttribute(node, 'id');
        if (!commentIds.has(id)) problem('comment_undefined', part);
        if (node.local === 'commentRangeStart') rangeStarts.add(id);
        else if (node.local === 'commentRangeEnd') rangeEnds.add(id);
        else commentReferences.add(id);
      }
      if (node.local === 'pPr') {
        let last = -1;
        for (const child of elements(node)) {
          if (!WORD(child)) continue;
          const rank = PPR_RANK.get(child.local);
          if (rank === undefined) continue;
          if (rank < last) { problem('paragraph_properties_out_of_order', part); break; }
          last = rank;
        }
      }
    }
    for (const id of new Set([...rangeStarts, ...rangeEnds])) if (rangeStarts.has(id) !== rangeEnds.has(id)) problem('comment_range_unpaired', part);
  }

  for (const id of commentIds) if (!commentReferences.has(id)) problem('comment_unreferenced', commentsPart);

  // Sections: the body ends with its section properties; any other sectPr is in the properties of
  // a paragraph directly in the body.
  const body = firstWord(document, 'body');
  if (!body) problem('body_missing', main);
  else {
    const children = elements(body);
    const last = children[children.length - 1];
    if (!isWord(last, 'sectPr')) problem('body_section_missing', main);
    const allowed = new Set();
    for (const child of children) {
      if (isWord(child, 'p')) {
        counts.paragraphs += 1;
        const properties = firstWord(child, 'pPr');
        const sectPr = properties && firstWord(properties, 'sectPr');
        if (sectPr) allowed.add(sectPr);
      }
    }
    if (isWord(last, 'sectPr')) allowed.add(last);
    for (const sectPr of descendants(document, 'sectPr')) {
      if (!allowed.has(sectPr)) { problem('section_properties_misplaced', main); continue; }
      counts.sections += 1;
      const notes = firstWord(sectPr, 'footnotePr');
      const restart = notes && firstWord(notes, 'numRestart');
      if (restart && wordAttribute(restart, 'val') === 'eachSect') counts.sectionsRestartingNotes += 1;
    }
  }
  return result();
}
