// The roles a manuscript paragraph can have, each with the one-line definition the model is given.
// Later stages apply a style and structure by role. Pure data.

export const ROLES = [
  { id: 'title-block', definition: 'the title, subtitle, author names and affiliations at the start of a chapter or article' },
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
  { id: 'title-page', definition: 'the title page of a whole book, dissertation or thesis at the start of the manuscript: its title and subtitle, its editors or authors with their affiliations, lines such as "Edited by" or "by", and a dissertation\'s statement of submission, degree, institution and year (the title of a chapter or an article is "title-block")' },
  { id: 'front-matter-heading', definition: 'the heading of a section outside the chapters, in the front or back matter: "Contents", "List of Illustrations", "List of Tables", "List of Figures", "Abbreviations", "Notes on Contributors", "Acknowledgements", "Abstract", "Preface", "Approval", "Vita" and the like' },
  { id: 'contents-entry', definition: 'one line of a table of contents, or of a list of tables or figures, typed into the manuscript: a chapter\'s, section\'s, table\'s or figure\'s title, its author, its number, its page number, or the name of a part, as the list gives them' },
  { id: 'contributor-note', definition: 'one note on a contributor, in a list of notes on contributors: a short biography of one author or editor' },
  { id: 'part-title', definition: 'the title of a part of the book that groups several chapters, with its label such as "Part I", standing on its own before the part\'s first chapter (a part named in a contents list is "contents-entry")' },
  { id: 'copyright-page', definition: 'a line of the copyright page of a book, dissertation or thesis: the copyright notice (©, a year, the author\'s name) and lines such as "All rights reserved"' },
  { id: 'approval-page', definition: 'a line of the approval or committee page of a dissertation or thesis: a statement that the work was read and accepted, the approval date, and the names and roles of the advisor, committee members and program head' },
  { id: 'dedication', definition: 'a dedication of the work, standing on its own in the front matter ("For my mother")' },
  { id: 'appendix-heading', definition: 'the heading of an appendix after the chapters, with its label such as "Appendix A"' },
];

export const ROLE_IDS = ROLES.map(role => role.id);
const KNOWN = new Set(ROLE_IDS);
export const isRole = value => KNOWN.has(value);

// Roles of the front and back matter: they belong to no chapter, and a chapter ends before them.
export const MATTER = new Set(['title-page', 'front-matter-heading', 'contents-entry', 'contributor-note', 'part-title', 'copyright-page', 'approval-page', 'dedication', 'appendix-heading']);

// Roles that change a paragraph's style or the document's structure; a body paragraph given one of
// these is the most damaging mistake, because code then restyles running text.
export const STRUCTURAL = new Set(ROLE_IDS.filter(id => id !== 'body' && id !== 'bibliography-entry'));
