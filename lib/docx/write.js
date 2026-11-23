// Reading a whole Word package into its parts and writing it back, for the stages that produce a
// new .docx. Parts that a stage does not change are written back byte for byte. Pure: no DOM, no
// network; runs in the browser and in Node. fflate unzips and zips.

import { strToU8, unzipSync, zipSync } from 'fflate';
import { MAX_DOCX_BYTES } from './read.js';
import { parseXml, serializeXml } from './xml.js';

const MAX_PART_BYTES = 200 * 1024 * 1024;
const MAX_PARTS = 4000;
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const CONTENT_TYPES = '[Content_Types].xml';
const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
export const RELATIONSHIP_TYPES = Object.freeze({
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
});
export const PART_CONTENT_TYPES = Object.freeze({
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
});

export class PackageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/**
 * Every part of a .docx, by name, and the name of its main document part. Throws PackageError
 * with code not_docx, too_large or unreadable.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{ files: Map<string, Uint8Array>, main: string }}
 */
export function readPackage(input) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.length < 4 || !ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new PackageError('not_docx');
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new PackageError('too_large');
  let oversized = false;
  let count = 0;
  let unzipped;
  try {
    unzipped = unzipSync(bytes, {
      filter(file) {
        count += 1;
        if (file.originalSize > MAX_PART_BYTES || count > MAX_PARTS) { oversized = true; return false; }
        return true;
      },
    });
  } catch {
    throw new PackageError('unreadable');
  }
  if (oversized) throw new PackageError('too_large');
  const files = new Map(Object.entries(unzipped).filter(([name]) => !name.endsWith('/')));
  const main = mainPart(files);
  if (!files.has(main)) throw new PackageError('not_docx');
  return { files, main };
}

/** The .docx bytes for a map of parts; [Content_Types].xml is written first. */
export function writePackage(files) {
  const entries = {};
  const names = [...files.keys()].sort((a, b) => (a === CONTENT_TYPES ? -1 : b === CONTENT_TYPES ? 1 : 0));
  for (const name of names) {
    const data = files.get(name);
    const text = /\.(xml|rels)$/i.test(name);
    entries[name] = [data, { level: text ? 6 : 0 }];
  }
  return zipSync(entries);
}

/** The relationships part that belongs to a part: word/document.xml -> word/_rels/document.xml.rels. */
export function relsPartOf(part) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolves a relationship target against the part that holds the relationship. */
export function resolveTarget(source, target) {
  if (target.startsWith('/')) return target.slice(1);
  const base = source.includes('/') ? source.slice(0, source.lastIndexOf('/')).split('/') : [];
  for (const segment of target.split('/')) {
    if (segment === '..') base.pop();
    else if (segment !== '.' && segment !== '') base.push(segment);
  }
  return base.join('/');
}

/** The relationships of a part: [{ id, type, target, external, resolved }]. */
export function relationshipsOf(files, part) {
  const rels = files.get(relsPartOf(part));
  if (!rels) return [];
  const { root } = parseXml(rels);
  return root.children
    .filter(child => child.type === 'element' && child.local === 'Relationship' && child.uri === RELATIONSHIPS_NS)
    .map(child => {
      const get = name => child.attributes.find(attribute => attribute.local === name && attribute.uri === '')?.value;
      const external = get('TargetMode') === 'External';
      const target = get('Target') ?? '';
      return { id: get('Id'), type: get('Type') ?? '', target, external, resolved: external ? null : resolveTarget(part, target) };
    });
}

function mainPart(files) {
  const rels = relationshipsOf(files, '');
  return rels.find(rel => rel.type === OFFICE_DOCUMENT && !rel.external)?.resolved ?? 'word/document.xml';
}

/** The part the main document reaches by relationship type (styles, footnotes, ...), or null. */
export function relatedPart(files, main, type) {
  return relationshipsOf(files, main).find(rel => rel.type === RELATIONSHIP_TYPES[type] && !rel.external)?.resolved ?? null;
}

/**
 * Adds a part to the package with its relationship from the main part and its content type
 * override; returns the new part's name. Used when the source has no styles, numbering or comments part.
 */
export function addRelatedPart(files, main, type, xml) {
  const folder = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const name = `${folder}${type}.xml`;
  files.set(name, strToU8(xml));
  const relsName = relsPartOf(main);
  const rels = files.has(relsName)
    ? parseXml(files.get(relsName)).root
    : parseXml(`<Relationships xmlns="${RELATIONSHIPS_NS}"/>`).root;
  const ids = new Set(rels.children.filter(child => child.type === 'element').map(child => child.attributes.find(attribute => attribute.local === 'Id')?.value));
  let number = 1;
  while (ids.has(`rIdMd${number}`)) number += 1;
  rels.children.push({ type: 'element', name: 'Relationship', prefix: '', local: 'Relationship', uri: RELATIONSHIPS_NS, children: [], attributes: [
    { name: 'Id', prefix: '', local: 'Id', uri: '', value: `rIdMd${number}` },
    { name: 'Type', prefix: '', local: 'Type', uri: '', value: RELATIONSHIP_TYPES[type] },
    { name: 'Target', prefix: '', local: 'Target', uri: '', value: `${type}.xml` },
  ] });
  files.set(relsName, strToU8(serializeXml(rels)));
  const types = parseXml(files.get(CONTENT_TYPES)).root;
  types.children.push({ type: 'element', name: 'Override', prefix: '', local: 'Override', uri: CONTENT_TYPES_NS, children: [], attributes: [
    { name: 'PartName', prefix: '', local: 'PartName', uri: '', value: `/${name}` },
    { name: 'ContentType', prefix: '', local: 'ContentType', uri: '', value: PART_CONTENT_TYPES[type] },
  ] });
  files.set(CONTENT_TYPES, strToU8(serializeXml(types)));
  return name;
}
