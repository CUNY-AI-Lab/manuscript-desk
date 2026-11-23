// A small element tree for the XML parts of a Word package, for code that must change a part and
// write it back: parse a part into plain objects, walk and edit them, and serialize them again.
// Everything the tree does not change is written back as it was read: element and attribute names
// with their prefixes, attribute order, namespace declarations, text, comments and processing
// instructions. Pure: no DOM, no network; runs in the browser and in Node.
//
// saxes parses the XML (rejecting anything that is not well-formed or not namespace-well-formed);
// the tree is built here, so no DOM is needed.

import { SaxesParser } from 'saxes';

export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const STRICT_WORD_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
export const WORD_NAMESPACES = new Set([WORD_NS, STRICT_WORD_NS]);
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export class XmlError extends Error {}

/**
 * Parses XML text or UTF-8 bytes into { root, declared }. Throws XmlError when it is not
 * well-formed. An element is { type: 'element', name, prefix, local, uri, attributes, children };
 * an attribute is { name, prefix, local, uri, value }; other children are { type: 'text', text },
 * { type: 'comment', text } and { type: 'pi', target, body }.
 */
export function parseXml(input) {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root = null;
  let declared = false;
  let failed = null;
  const append = child => { if (stack.length) stack[stack.length - 1].children.push(child); };
  parser.on('error', error => { failed ??= error; });
  parser.on('xmldecl', () => { declared = true; });
  parser.on('opentag', node => {
    const element = {
      type: 'element',
      name: node.name,
      prefix: node.prefix,
      local: node.local,
      uri: node.uri,
      attributes: Object.values(node.attributes).map(({ name, prefix, local, uri, value }) => ({ name, prefix, local, uri, value })),
      children: [],
    };
    if (!stack.length) root = element;
    else append(element);
    stack.push(element);
  });
  parser.on('closetag', () => { stack.pop(); });
  const addText = value => {
    if (!stack.length) return; // whitespace outside the root element
    const children = stack[stack.length - 1].children;
    const last = children[children.length - 1];
    if (last?.type === 'text') last.text += value;
    else children.push({ type: 'text', text: value });
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('comment', value => append({ type: 'comment', text: value }));
  parser.on('processinginstruction', ({ target, body }) => append({ type: 'pi', target, body }));
  try {
    parser.write(text).close();
  } catch (error) {
    failed ??= error;
  }
  if (failed || !root) throw new XmlError('not well-formed XML');
  return { root, declared };
}

const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/** Serializes an element tree (with the standard declaration unless `declaration` is false). */
export function serializeXml(root, { declaration = true } = {}) {
  const out = declaration ? [XML_DECLARATION] : [];
  const write = node => {
    switch (node.type) {
      case 'text': out.push(escapeText(node.text)); return;
      case 'comment': out.push(`<!--${node.text}-->`); return;
      case 'pi': out.push(`<?${node.target}${node.body ? ` ${node.body}` : ''}?>`); return;
      default: {
        out.push(`<${node.name}`);
        for (const attribute of node.attributes) out.push(` ${attribute.name}="${escapeAttribute(attribute.value)}"`);
        if (!node.children.length) { out.push('/>'); return; }
        out.push('>');
        for (const child of node.children) write(child);
        out.push(`</${node.name}>`);
      }
    }
  };
  write(root);
  return out.join('');
}

// Building and reading elements -------------------------------------------------------------

export const isElement = node => node?.type === 'element';
/** True when `node` is the Word element with this local name (in either Word namespace). */
export const isWord = (node, local) => isElement(node) && node.local === local && WORD_NAMESPACES.has(node.uri);

/** The prefix a document uses for the Word namespace (declared on its root), or 'w'. */
export function wordPrefix(root) {
  if (WORD_NAMESPACES.has(root.uri)) return root.prefix;
  const declaration = root.attributes.find(attribute => attribute.prefix === 'xmlns' && WORD_NAMESPACES.has(attribute.value));
  return declaration ? declaration.local : 'w';
}

/**
 * A new Word element: wordElement(prefix, 'pStyle', { val: 'BodyText' }, [children]). Attribute
 * names are Word attributes (prefixed like the element) unless they hold a colon already.
 */
export function wordElement(prefix, local, attributes = {}, children = [], uri = WORD_NS) {
  const qualify = name => (prefix ? `${prefix}:${name}` : name);
  return {
    type: 'element',
    name: qualify(local),
    prefix,
    local,
    uri,
    attributes: Object.entries(attributes).map(([name, value]) => (name.includes(':')
      ? { name, prefix: name.split(':')[0], local: name.split(':')[1], uri: '', value: String(value) }
      : { name: qualify(name), prefix, local: name, uri, value: String(value) })),
    children,
  };
}

/** The value of a Word attribute by local name (w:val, w:id, ...), or undefined. */
export function wordAttribute(node, local) {
  for (const attribute of node.attributes) if (attribute.local === local && (WORD_NAMESPACES.has(attribute.uri) || attribute.uri === '')) return attribute.value;
  return undefined;
}

/** Sets a Word attribute by local name, adding it (prefixed like the element) when missing. */
export function setWordAttribute(node, local, value) {
  const found = node.attributes.find(attribute => attribute.local === local && (WORD_NAMESPACES.has(attribute.uri) || attribute.uri === ''));
  if (found) found.value = String(value);
  else node.attributes.push({ name: node.prefix ? `${node.prefix}:${local}` : local, prefix: node.prefix, local, uri: node.uri, value: String(value) });
}

/** The element children of `node`, optionally only those with a Word local name. */
export const elements = (node, local) => node.children.filter(child => (local ? isWord(child, local) : isElement(child)));
export const firstWord = (node, local) => node.children.find(child => isWord(child, local));

/** Every descendant element of `node` (depth first, document order), optionally by Word local name. */
export function* descendants(node, local) {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (!local || isWord(child, local)) yield child;
    yield* descendants(child, local);
  }
}

/** A deep copy of a node. */
export function cloneNode(node) {
  if (!isElement(node)) return { ...node };
  return { ...node, attributes: node.attributes.map(attribute => ({ ...attribute })), children: node.children.map(cloneNode) };
}
