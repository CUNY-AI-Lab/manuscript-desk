// Accessibility checks, for every document type, whether or not a rule asks for them: publishers
// and repositories now require accessible files. Each reads the formatted file's facts
// (lib/docx/accessibility.js, mapped back to source paragraphs through the formatter's map) and
// gives findings with a severity: "must" (a reader using assistive technology loses content),
// "should" (they lose structure or context) and "check" (probably a problem; a person decides).
// Each message names the principle and says how to fix it in Word and in Google Docs, not in one
// vendor's PDF editor. When the rule sheet has an accessibility rule on the matter, the finding
// names it. Pure: no DOM, no network.

import { plural } from './context.js';
import { rulesWith } from './rules.js';

export const SEVERITY_WORDS = Object.freeze({ must: 'Must fix', should: 'Should fix', check: 'Check' });

// Link text that says nothing about where the link goes, in English and the languages scholars write in most.
const EMPTY_LINK = /^(?:click here|click|here|this|this link|link|more|read more|learn more|see here|this page|this site|website|web page|url|go|qui|clicca qui|aquí|haga clic aquí|ici|cliquez ici|hier)$/iu;
const BARE_URL = /^(?:https?:\/\/|www\.)\S+$/iu;
// Words in a picture's name, file name or description that say it is a capture of text.
const CAPTURE = /screen ?shot|screen ?capture|bildschirmfoto|captura|schermata|capture d.?écran|scan(?:ned)?\b|snapshot/iu;
// Alternative text a tool wrote, not a person.
const MACHINE_ALT = /description automatically generated|a picture containing|^(?:picture|image|img|figure|photo|graphic|chart)\s*\d*(?:\.\w{2,4})?$|\.(?:png|jpe?g|gif|tiff?|bmp|emf|wmf|svg)$/iu;
const EMU_PER_INCH = 914400;

/** The rule an accessibility finding is tied to: one of the sheet's accessibility (or alt-text) rules that speaks of it, else the first. */
function ruleFor(sheet, words, categories = ['accessibility']) {
  const rules = categories.flatMap(category => rulesWith(sheet, { category }));
  const speaks = rule => words.test(`${rule.statement} ${rule.source?.quote ?? ''}`);
  return rules.find(rule => speaks(rule) && rule.source?.kind === 'guidelines') ?? rules.find(speaks) ?? rulesWith(sheet, { category: 'accessibility' })[0] ?? null;
}

const sourceAt = (context, position) => {
  const entry = context.report.map?.[position];
  return Number.isInteger(entry?.source) ? entry.source : null;
};

const finding = (severity, paragraphIndex, message, rule) => ({ severity, paragraphIndex, message: `Accessibility (${SEVERITY_WORDS[severity].toLowerCase()}): ${message}`, rule });

const ALT_HOW = 'In Word, right-click the picture and choose View Alt Text (or Edit Alt Text) and write one or two sentences on what it shows and why it is there; mark it as decorative if it adds nothing. In Google Docs, select it and choose Image options, then Alt text (Ctrl+Alt+Y; Cmd+Option+Y on a Mac).';

export const ACCESSIBILITY_CHECKS = [
  {
    id: 'a11y-alt-text',
    kind: 'a11y-alt-text',
    needs: 'pictures in the file',
    basis: context => (context.a11y?.pictures.length ? { rule: ruleFor(context.sheet, /alt|image|picture|figure|visual/iu, ['alt-text', 'accessibility']) } : null),
    run: (context, rule) => {
      const out = [];
      for (const picture of context.a11y.pictures) {
        if (picture.decorative || picture.hidden) continue;
        const at = sourceAt(context, picture.position);
        const alt = picture.descr || picture.title;
        if (!alt) out.push(finding('must', at, `this picture has no alternative text, so a screen reader announces only that there is an image (WCAG 1.1.1, non-text content). ${ALT_HOW}`, rule));
        else if (MACHINE_ALT.test(alt)) out.push(finding('check', at, `this picture's alternative text (“${alt.slice(0, 80)}”) looks written by a program or is a file name. Replace it with what the picture shows and why it matters here. ${ALT_HOW}`, rule));
      }
      return out;
    },
  },
  {
    id: 'a11y-image-text',
    kind: 'a11y-image-text',
    needs: 'pictures in the file',
    basis: context => (context.a11y?.pictures.length ? { rule: ruleFor(context.sheet, /screenshot|image of text|text.based|scan/iu) } : null),
    run: (context, rule) => context.a11y.pictures.flatMap(picture => {
      if (picture.decorative) return [];
      const wide = picture.width && picture.height && picture.width / picture.height >= 5 && picture.width >= 3 * EMU_PER_INCH;
      const named = CAPTURE.test(`${picture.name} ${picture.file ?? ''} ${picture.descr} ${picture.title}`);
      const inTable = picture.inTable || context.roleOf(sourceAt(context, picture.position)) === 'table';
      if (!wide && !named && !inTable) return [];
      const why = named ? 'its name or description says it is a screenshot or scan' : inTable ? 'it stands where a table is' : 'it is a long thin strip, the shape of a line of text';
      return [finding('check', sourceAt(context, picture.position), `this picture may be an image of text (${why}). Text in a picture cannot be read aloud, searched or enlarged (WCAG 1.4.5, images of text): if it holds words or a table, type them into the document (as a real table for tabular data); if it must stay a picture, give it alternative text that carries the words.`, rule)];
    }),
  },
  {
    id: 'a11y-heading-skip',
    kind: 'a11y-heading-skip',
    needs: 'headings in the file',
    basis: context => (context.a11y?.headings.length ? { rule: ruleFor(context.sheet, /heading|structure/iu, ['accessibility', 'headings']) } : null),
    run: (context, rule) => {
      const out = [];
      let previous = -1;
      for (const heading of context.a11y.headings) {
        if (heading.level > previous + 1) {
          const where = previous < 0 ? `it is the first heading in the file, at level ${heading.level + 1} rather than level 1` : `it is at level ${heading.level + 1} right after a heading at level ${previous + 1}`;
          out.push(finding('should', sourceAt(context, heading.position), `this heading skips a level: ${where}. People who move through a document by its headings lose their place (WCAG 1.3.1, info and relationships). Give it the next level down from the heading above (in Word, Home > Styles; in Google Docs, Format > Paragraph styles), or check whether a heading is missing above it.`, rule));
        }
        previous = heading.level;
      }
      return out;
    },
  },
  {
    id: 'a11y-table-header',
    kind: 'a11y-table-header',
    needs: 'tables in the file',
    basis: context => (context.a11y?.tables.length ? { rule: ruleFor(context.sheet, /table/iu) } : null),
    run: (context, rule) => context.a11y.tables.flatMap(table => {
      if (table.header || table.rows < 2 || table.columns < 2) return [];
      return [finding('must', sourceAt(context, table.position), `this table has no header row marked as one, so a screen reader cannot say which column a cell belongs to (WCAG 1.3.1, info and relationships). Mark its first row as a header row: in Word, click in the first row, then Table Properties > Row > “Repeat as header row at the top of each page”; in Google Docs, Format > Table > Table properties > Pin header rows. If the table is used only for layout, set its contents as ordinary text instead.`, rule)];
    }),
  },
  {
    id: 'a11y-link-text',
    kind: 'a11y-link-text',
    needs: 'links in the file',
    basis: context => (context.a11y?.links.length ? { rule: ruleFor(context.sheet, /link/iu) } : null),
    run: (context, rule) => context.a11y.links.flatMap(link => {
      const at = sourceAt(context, link.position);
      const text = link.text.replace(/[.,;:!?)\]]+$/u, '').trim();
      if (!text && !link.internal) return [finding('should', at, 'a link here holds no words (often a space or a punctuation mark left linked when text was copied), so a screen reader announces a link with its address and nothing else (WCAG 2.4.4, link purpose). Remove the link from it (in Word, right-click > Remove Hyperlink; in Google Docs, click it and choose Remove link), or put the link on words that say where it goes.', rule)];
      if (EMPTY_LINK.test(text)) return [finding('should', at, `the link text “${text}” does not say where the link goes, and people who list a document's links hear it with nothing around it (WCAG 2.4.4, link purpose). Rewrite it to name the destination (in Word, right-click the link > Edit Link > Text to display; in Google Docs, click the link and choose Edit).`, rule)];
      const role = context.roleOf(at);
      if (BARE_URL.test(text) && role !== 'bibliography-entry' && role !== 'contents-entry') return [finding('check', at, `the link text is a bare web address (${text.length > 60 ? `${text.slice(0, 57)}…` : text}), which a screen reader spells out character by character. Unless the address itself matters here (as in a citation), give the link a few words that name the destination.`, rule)];
      return [];
    }),
  },
  {
    id: 'a11y-colour',
    kind: 'a11y-colour',
    needs: 'highlighted or coloured text in the file',
    basis: context => (context.a11y?.marked.length ? { rule: ruleFor(context.sheet, /colou?r|highlight/iu) } : null),
    run: (context, rule) => {
      // One finding per paragraph, highlight first.
      const byPlace = new Map();
      for (const mark of context.a11y.marked) {
        const at = sourceAt(context, mark.position);
        const role = context.roleOf(at);
        // A figure marker is the formatter's own red line for the typesetter; it goes before typesetting.
        if (context.report.map?.[mark.position]?.style === 'figure-marker') continue;
        if (!byPlace.has(at)) byPlace.set(at, { at, role, kinds: new Set(), characters: 0 });
        byPlace.get(at).kinds.add(mark.kind);
        byPlace.get(at).characters += mark.characters;
      }
      return [...byPlace.values()].map(place => finding('should', place.at, `${plural(place.characters, 'character')} here ${place.characters === 1 ? 'is' : 'are'} ${place.kinds.has('highlight') ? 'highlighted' : 'in colour'}${place.kinds.size > 1 ? ' or in colour' : ''}. Colour alone cannot carry meaning: people who cannot see it, or print in black and white, miss the distinction (WCAG 1.4.1, use of colour). If it marks something for a reader, mark it another way too (words, italics, a symbol); if it was a note to yourself, remove it (in Word, Home > Text Highlight Color > No Color; in Google Docs, Highlight color > None).`, rule));
    },
  },
  {
    id: 'a11y-properties',
    kind: 'a11y-properties',
    needs: 'the file itself',
    basis: context => (context.a11y ? { rule: ruleFor(context.sheet, /title|language/iu) } : null),
    run: (context, rule) => {
      const out = [];
      const { a11y } = context;
      if (!a11y.title && !context.report.accessibility?.title) out.push(finding('must', null, 'the file has no document title in its properties, so a screen reader and a browser show its file name instead (WCAG 2.4.2, page titled). Set it: in Word, File > Info > Properties > Title; in Google Docs the file’s name is its title. When you save as PDF, keep it (in Word’s PDF options, tick Document structure tags for accessibility).', rule));
      if (!a11y.language) out.push(finding('must', null, 'the file does not say what language its text is in, so a screen reader may read it with the wrong pronunciation (WCAG 3.1.1, language of page). Set it: in Word, select all, then Review > Language > Set Proofing Language; in Google Docs, File > Language. Mark passages in another language the same way.', rule));
      return out;
    },
  },
];
