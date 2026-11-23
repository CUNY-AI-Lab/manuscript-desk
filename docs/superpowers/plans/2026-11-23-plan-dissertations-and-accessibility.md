# Plan: dissertations and accessibility checks

Date: 2026-11-23. Branch `dissertations`. Builds on round 8 of `docs/eval/brill-loop.md`.

## Goal

1. A fourth document type, `dissertation` (a dissertation or thesis), with the requirement shapes a
   university's format guide has and a publisher's does not.
2. Accessibility checks on the `.docx` for every document type.
3. A built-in rule sheet for the CUNY Graduate Center (owner's change of 2026-11-23): for a
   dissertation, step 2 offers it as the default, read from no model.

## What an earlier prototype taught (CUNY-AI-Lab/a11y-check)

Taken: the shape of dissertation requirements (page layout with sides that can differ, spacing by
element, two page-number sequences with a counted but unnumbered title page, a required order of
front matter, title-page contents, chapters on a new page, numbered captions above tables and below
figures, lists of tables and figures) and accessibility as a first-class check with three severity
levels. Rejected: its hardcoded values (none is copied; the Graduate Center's current guide differs
from them), a model judging layout from a text summary (layout is measured from the file), a free
prose report with no quotation check, and uploading the whole file.

## Tasks and files

**A. Schema and extraction** (`lib/rules/schema.js`, `server/prompts.js`, `web/format/rules-view.js`,
`lib/todos/shared.js`, tests). `DOC_TYPES` gains `dissertation`; the categories that fit a
dissertation (title page, abstract, front and back matter, chapters) admit it; a new category
`accessibility` for every type. New slots, each wired through the schema, the prompt's slot uses,
the rules view and the checklist:

| Slot | Params | Applied or checked |
|---|---|---|
| `layout.paper` | `size`: letter, a4 | applied to every section |
| `layout.margin-sides` | `top`, `right`, `bottom`, `left`: inches or null | applied per side |
| `layout.element-spacing` | `notes`, `quotations`, `bibliography`, `captions`: line or null | applied to those styles |
| `layout.page-sequences` | `preliminary`: lower-roman, arabic, none; `restart`: true, false; `titlePage`: counted-not-shown, shown | applied as Word sections |
| `matter.order` | `order`, `required`: part names separated by `>` | checked, never reordered |
| `title-page.elements` | `elements`: part names separated by `>` | checked, missing listed to supply |
| `chapters.new-page` | `required` | applied (page break before) |
| `captions.position` | `tables`, `figures`: above, below, or null | checked and commented |

Existing slots are reused where they fit (`layout.page-numbers`, `layout.spacing`, `layout.font`,
`layout.margins`, `notes.restart`, `abstract.words`, `headings.*`).

**B. Roles** (`lib/roles/roles.js`, the labelling prompt, the review menu): `copyright-page`,
`approval-page`, `dedication`, `appendix-heading`, all outside the chapters. Sections that carry a
heading (acknowledgments, preface, contents, lists of tables and figures, abstract) keep the
`front-matter-heading` role and code names the section from the heading's words; entries of the
lists of tables and figures are `contents-entry`. Measure the Brill case's roles again.

**C. Formatter** (`lib/format/plan.js`, `lib/format/format.js`, `lib/format/styles.js`,
`lib/format/declared.js`): paper size and margins per side; line spacing of notes, quotations,
bibliography and captions; the front matter as a section numbered in lower-case roman with the
title page counted and not shown, the body from arabic 1; a page break before each chapter and
major section. Front-matter order, missing parts and title-page elements are checked
(`lib/checks/matter-order.js`), never reordered or invented. A generated table of contents is
out of scope (a TOC field is updated by Word only after a prompt); it stays a To-do.

**D. Accessibility** (`lib/checks/accessibility.js`, `lib/docx/accessibility.js`): read from the
package, for every document type, whether or not a rule asks: skipped heading levels, pictures
without alt text (`wp:docPr` `descr`/`title`), tables without a header row (`w:tblHeader`), link
text that says nothing or is a bare URL, no document title (`docProps/core.xml`) or language
(`w:lang`), highlighting or coloured text used as a marker, pictures that are probably text. Each
finding is a comment at its place and an entry in an "Accessibility" section of the To-dos with a
severity (must fix, should fix, check) and fix guidance in Word and Google Docs terms. Safe fixes,
declared: the document title from the title page or title block, a table's first row marked as
header when it is set apart as one. Findings name an accessibility rule of the sheet when it has
one. The alt-text companion lists the same pictures.

**E. Built-in rule sheets** (`lib/presets/`, step 2 of the page): a preset is a rule sheet in the
normal schema whose rules each quote the published page, with its address and the date it was
read; loading one calls no model. Only the Graduate Center's is shipped; `scripts/check-preset.mjs`
fetches the pages again and reports quotations no longer found.

**F. Measurement** (`docs/eval/dissertation-loop.md`, private cases): the Graduate Center and other
universities' requirements as generality cases with hand-written `expected.json`; generality on
them and across all cases; an invented dissertation fixture formatted against the Graduate Center
sheet and measured with `lib/docx/appearance.js` requirement by requirement; LibreOffice PDFs; the
browser smoke test extended.

## Interfaces

- `settingsFrom(sheet)` gains `paper`, `marginSides`, `elementSpacing`, `pageSequences`,
  `chapterNewPage`, `captionPosition`.
- `accessibilityFindings({ bytes, paragraphs, roles, report, sheet })` returns findings in the
  checks' shape plus `severity`; `runChecks` takes `bytes` to run them.
- `PRESETS` (`lib/presets/index.js`): `{ id, name, docType, url, retrieved, sheet }`.

## Out of scope

Reordering front matter; inventing a missing part; a generated contents list or lists of figures
(To-do); moving captions (commented); title page and copyright page both unnumbered (one first
page per section); page-number distance from the edge; the bibliography's hanging indent value;
PDF tagging and the PDF's own title and language (set when exporting); colour contrast.
