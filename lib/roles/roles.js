// The roles a manuscript paragraph can have, each with the one-line definition the model is given.
// Later stages apply a style and structure by role. Pure data.

export const ROLES = [
  { id: 'title-block', definition: 'the title, subtitle, author names and affiliations at the start of a chapter, article or book' },
  { id: 'epigraph', definition: 'a short quotation, with its attribution line, placed after a title and before the text begins' },
  { id: 'abstract', definition: 'a summary of the chapter or article placed before its text, including a label such as "Abstract"' },
  { id: 'keywords', definition: 'a list of keywords, including a label such as "Keywords"' },
  { id: 'heading-1', definition: 'a top-level section heading inside a chapter or article' },
  { id: 'heading-2', definition: 'a subsection heading below a top-level section heading' },
  { id: 'bibliography-heading', definition: 'the heading of a bibliography or reference list ("Bibliography", "Works Cited", "References"), or a heading that divides one' },
  { id: 'bibliography-entry', definition: 'one entry of a bibliography or reference list' },
  { id: 'block-quotation', definition: 'a quotation of prose set off from the running text as a paragraph of its own' },
  { id: 'verse', definition: 'lines of poetry or song set off from the running text' },
  { id: 'figure', definition: 'an image, a placement marker for one, or a figure caption' },
  { id: 'list-item', definition: 'one item of a list' },
  { id: 'table', definition: 'a table, or one row or cell of a table set as a separate paragraph' },
  { id: 'body', definition: 'ordinary running text, including a sentence that introduces or comments on a quotation' },
];

export const ROLE_IDS = ROLES.map(role => role.id);
const KNOWN = new Set(ROLE_IDS);
export const isRole = value => KNOWN.has(value);

// Roles that change a paragraph's style or the document's structure; a body paragraph given one of
// these is the most damaging mistake, because code then restyles running text.
export const STRUCTURAL = new Set(ROLE_IDS.filter(id => id !== 'body' && id !== 'bibliography-entry'));
