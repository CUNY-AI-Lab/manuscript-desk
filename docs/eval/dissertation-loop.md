# Evaluation: dissertations and accessibility

Round 9 of the build (2026-11-23), on the branch `dissertations`: a fourth document type, accessibility
checks for every type, and the CUNY Graduate Center's requirements as a built-in rule sheet. The plan
is `docs/superpowers/plans/2026-11-23-plan-dissertations-and-accessibility.md`. As in
`brill-loop.md`, this file holds counts, measurements and generic descriptions only: no guideline text
beyond the built-in sheet's own quotations, and nothing from a real manuscript.

## What was built

- **Document type `dissertation`** (step 1: "Dissertation or thesis"). Categories: those of a book
  without index, contributors or consistency across authors, plus title page and abstract; a new
  category `accessibility` for every type. Eight new settings: `layout.paper`, `layout.margin-sides`,
  `layout.element-spacing`, `layout.page-sequences`, `matter.order`, `title-page.elements`,
  `chapters.new-page`, `captions.position`, each wired through the schema, the extraction prompt, the
  rules view (in plain words; part lists shown as "Title page, Copyright page, ...") and the checklist.
  The extraction prompt says "a university's or graduate school's guidelines" for this type; the
  other types' prompts keep their wording but offer the new settings and category.
- **Roles**: `copyright-page`, `approval-page`, `dedication`, `appendix-heading`, outside the chapters.
  Headed sections (abstract, acknowledgments, preface, contents, lists of tables and figures, vita) keep
  `front-matter-heading`, and code names the part from the heading's words; the lines of lists of
  tables and figures are `contents-entry`. A whole work's title page is read into title, "by" line,
  author and statement lines (a submission statement, a degree line, a date, an advisor line), so its
  lines are no longer joined as a broken subtitle.
- **Formatter** (declared, measured below): paper size; margins per side; line spacing of notes,
  quotations, bibliography and captions; a line-spacing rule now also reaches the front matter's text
  (abstract, dedication, contents list, notes on contributors); the front matter as its own section(s)
  numbered in lower-case roman from i with the title page counted and showing no number, the first
  chapter from arabic 1, the others continuing; page numbers added at the bottom centre when the sheet
  asks for numbering but leaves their place open and the file has none (said in the summary); a page
  break before each chapter and major section unless a section break already starts one.
- **Checks on a work's parts** (`lib/checks/parts.js`): parts out of the order given (the fewest parts
  that, moved, restore the order), required parts missing (a list of tables or figures only when the
  work has tables or figures), what the title page lacks, captions above or below as asked. Nothing is
  moved or added.
- **Accessibility** (`lib/checks/accessibility.js`, `lib/docx/accessibility.js`), on the formatted
  file, every type, with or without a rule; safe fixes for the document title and a set-apart header row.
- **Built-in Graduate Center rule sheet** (`lib/presets/cuny-gc.js`) and `scripts/check-preset.mjs`.

## The built-in Graduate Center sheet

Written by hand on 2026-11-23 from three published pages of the Mina Rees Library's Dissertations and
Theses guide (CC0): the Format Requirements page, the Dissertation Office Manuscript Format Checklist
(PDF, December 2025) and the Document Accessibility page. The library states that the format
requirements are the same for a dissertation, a thesis and a capstone project, so one set covers all
three; the title-page statement's wording differs only in the blank for the kind of work, which the
title-page check accepts. 39 rules (27 quoting the Format Requirements page, 8 the checklist, 4 the accessibility page):
11 with settings (paper, margins, line spacing, the notes' spacing, three on the page sequences,
chapters on a new page, notes restarting, part order with the required parts, title-page elements),
of which 9 are applied by the formatter and 2 checked; 28 to flag and 2 to supply. Every quotation was found on its
page by the product's own quotation check, on the saved copies and again live with
`npm run check-preset`.

The earlier prototype's values were not used, and the current guide differs from them: it asks for
1-inch margins on every side (the prototype had a 1.5-inch left margin), page numbers at least
three quarters of an inch from any edge, and leaves the place of the page numbers open.

What the sheet states that the tool neither applies nor checks: the page numbers' distance from the
edge (the footer distance is left as it is), a font "equivalent in scale" to the named sizes, text
inside figures at 9 point or more, the bibliography's 0.5-inch hanging indent (the tool's
Bibliography style has 1 cm), no honorifics before committee names, spelled-out symbols in the
title, the degree year, colour contrast, a PDF with its title and language set at export, permission
letters and the PDF file itself (on the To-dos list to supply or check).

## Measurements

### Reading requirements: the four new cases

Four universities' public format requirements, fetched on 2026-11-23, each a scored case in the
private folder with an `expected.json` written by hand from reading them (sources in its
`MANIFEST.md`): the Graduate Center's three pages above (42 requirements); a private university's
registrar web page (33; its 2025 PDF disagrees with the page on the order of sections and the margins,
so the case reads the page only); another private university's graduate-school page (26; one arabic
sequence from page 2, no roman numerals); a public university's graduate-school page (16; a 1.5-inch
left margin; its content sits where the HTML reader drops it, so the case reads the page's main text
as a person would paste it). `npm run generality -- --models deepseek-v4.1-flash-1017`, run once:

| Case | Found | Calls | Cost |
|---|---|---|---|
| Graduate Center | 42/42 | 15 | $0.031 |
| Registrar page | 31/33 | 4 | $0.008 |
| Graduate-school page, one sequence | 26/26 | 5 | $0.008 |
| Graduate-school page, wider left margin | 14/16 | 4 | $0.005 |
| **The four** | **113/117 (96.6%)**, lowest 87.5% | 28 | $0.051 |

Missed: the order of sections (twice: a list of part names under a heading, which no reading quoted
as a requirement), captions at the bottom of figures, and a font-size requirement in a sentence that
also gives a permission.

Settings the readings filled on these four (from the saved sheets): the page sequences in three of
four (lower-case roman with a restart, twice; one arabic sequence with the title page counted, once),
the paper size in two, margins by side in two (the wider left margin, read right; and a duplicate of
equal margins), spacing by element in three, part order in three, caption position in one (tables
above, figures below, right), title-page elements in one. Wrong or doubtful: spacing by element set to
single for every element where the page only permits single spacing; an abstract limit of 250 words
that the page gives for a lay summary; page numbers at the bottom centre where the page leaves the
place open (above).

### Reading requirements: all cases

All 22 cases, the same command, the four above replayed from their recording. The Gateway refused 85
calls for its rate limit during the first pass and 15 failed after the backoff, in six cases (which fell
to as low as 1 of 11); those six were asked again, replaying the answers that had come back and asking
only the refused parts, with nothing else changed. The numbers below are that combined run.

| | Round 7 (18 cases) | Round 9, the same 18 | Round 9, all 22 |
|---|---|---|---|
| Expected requirements found | 421/438 (96.1%) | **425/438 (97.0%)** | **538/555 (96.9%)** |
| Lowest case | 88.9% | 89.5% (an edited-collection guide, 17 of 19) | 87.5% (the wider-left-margin page) |
| Verdict (90% overall, 80% every case) | PASS | PASS | PASS |

Against round 7, per case: five cases found one more, one (a monograph guide) one fewer, the rest the
same. The new settings and the accessibility category are offered to every document type's reading,
so the old cases' prompts changed; this run does not show that they made the old cases worse. Cost of
the round's extraction runs: about $0.54 by the catalog prices the script reports (the first pass
$0.36, the re-asked parts $0.08, the Brill guidelines $0.05, the four new cases $0.05).

### Paragraph roles on the Brill case

The labelling prompt gained four roles and a sentence on a dissertation's front matter, so the cached
answers could not be reused. `npm run roles-eval -- --chapters dev`, fresh:

| | Round 6 | Round 9 |
|---|---|---|
| Dev, structural | 250/260 (98.0%) | 232/260 (89.2%) |
| Front matter | 57/57 | 57/57 |

All the loss is in one chapter's prose quotations (block quotation read as verse 14, as body 10). That
chapter alone, labelled fresh again: with the round 9 prompt 168/175, with the round 6 prompt (from
`origin/main`, uncached) 168/175, the same six confusions. So the drop is run-to-run variance of a
reasoning model on that chapter, not the prompt; but one more fresh run is not a distribution, and the
holdout was not run (it costs about as much again). Cost $0.19.

### The built-in sheet against the tool's own reading of the same pages

The tool read the same three pages (`npm run generality`, default model, the case's recorded answers)
into 142 rules. On the settings both have, they agree: paper (Letter), margins (1 inch), body line
spacing (2), notes single-spaced, the page sequences (lower-case roman, restart at 1, title page
counted and unnumbered), chapters on a new page, notes restarting in each chapter, and the part order
(the reading adds the preface; the built-in sheet leaves the order of preface, foreword and
acknowledgments open, as the page does). Where they differ, the hand-written sheet follows the page:

| Setting | Built-in sheet | The reading | Why the built-in sheet is right |
|---|---|---|---|
| `layout.page-numbers` | not set | bottom centre | the page lets the numbers stand anywhere, consistently; "bottom middle" is one of its examples |
| `layout.font` | not set | 10 pt, and a second rule with no size (in conflict) | the page accepts any legible font of a scale equivalent to named sizes; no one size is required |
| `headings.numbering` | not set | numbered and not numbered (in conflict) | the page defers headings to the discipline's style manual |
| `title-page.elements` | title, author, statement, degree, year | the same without degree, and a second rule with the year alone (in conflict) | the degree is part of the statement the page asks for |
| `matter.order` required parts | title page, copyright, approval, abstract, contents, lists, body, bibliography | contents, lists, body, bibliography | the page's sequence marks only the optional parts as optional |
| `figures.callouts` | not set | required | the page asks for figures to be listed, not referred to in the text |
| `layout.margin-sides` | not set | 1 inch on every side (a duplicate of the margins) | the same requirement twice |

So a person who uploads the Graduate Center's pages instead of using the built-in sheet gets a sheet
that is mostly right but holds three settings in conflict (left unapplied until resolved) and one
wrong setting (page numbers at the bottom centre).

### The invented dissertation, formatted with the built-in sheet

`tests/dissertation-fixture.mjs` (also `tests/fixtures/dissertation.docx`): a title page, copyright
page, abstract before the approval page, acknowledgments spelled with an e, contents, dedication, two
chapters, A4 pages with margins that differ by section, a subsection heading with no section heading
above it, three pictures (one with alt text, one named as a screenshot and shaped like a strip), a
table with a bold first row and one with none, a link reading "click here", highlighted text, no
document title, no language. Formatted through the page's own pipeline (`buildOutputs`), then measured
from the file (`lib/docx/appearance.js`) and from LibreOffice's PDF, requirement by requirement:

| Requirement (built-in sheet) | Measured | Result |
|---|---|---|
| US Letter | every section 12240 × 15840 twips; PDF 612 × 792 pt | met |
| 1-inch margins | every section 1440 on all four sides | met |
| Body double-spaced | 7/7 body paragraphs at 2 | met |
| Abstract, dedication, contents double-spaced | 5/5 at 2 | met (after this round's change; 0/5 before it) |
| Notes single-spaced | 2/2 note paragraphs at 1 | met |
| Text above 9 pt | smallest 10 pt | met |
| Preliminary pages in lower-case roman, title page counted and unnumbered | sections lowerRoman from 1 with a blank first page, then lowerRoman continuing; PDF: title page shows no number, then ii to vii | met |
| Body in arabic from 1 | first chapter's section decimal from 1, the next continuing; PDF: 1 to 3 | met |
| Every page numbered, the same place | bottom centre in every section (added: the sheet leaves the place open and the file had none) | met |
| Chapters and major sections on a new page | PDF: each front-matter part, chapter and the bibliography starts a page; a heading and its page stay together | met |
| Notes restart in each chapter | every section restarts notes | met in the file; LibreOffice prints the second chapter's note as 0, which it does for `main`'s output as well (a LibreOffice rendering of per-section restarts, not checked in Word) |
| Page numbers at least ¾ in from the edge | footer distance 0.49 in | **not met** (not applied; on the To-dos as a rule to check) |
| Bibliography hanging indent 0.5 in | 0.39 in (the tool's style) | **not met** (not applied; to check) |
| Part order | the abstract found out of the order (before the approval page) | flagged, not moved |
| Required parts | no list of tables, no list of figures (the work has both) | flagged as missing |
| Title page states title, author, statement, degree, year | all found | met (a variant sheet asking for month and advisor too lists both as missing) |
| No word changed undeclared; valid file | 0 undeclared; valid; every download valid | met |

Accessibility on the same file: 8 findings, 4 must fix (two pictures without alt text, the table with
no header row, the missing language), 3 should fix (the skipped heading level, the "click here" link,
the highlighting), 1 to check (the strip-shaped "screenshot"). The safe fixes set the document title
from the title page and marked the bold first row of the other table as a header row. The alt-text
companion lists the same three pictures, with the one alt text that exists.

### Accessibility on the Brill manuscript (a real document, counts only)

Gold roles and the hand sheet. Pictures: none (its figures are placement markers). Tables: 4, each a
single row of two cells, so none needs a header row. Headings: 88 (15 at level 1, 59 at 2, 14 at 3),
no level skipped. Links: 83; 8 hold only a space (a copy-and-paste artifact of the word processor's
export), reported as should fix. Highlighted or coloured text: 14 paragraphs, should fix; the manual
formatting job had commented on highlighting that no rule asked about (round 6, "still missed"), and
this check is the first to find it, though `todos-eval` does not yet score these findings. Document
title: none in the source, set by the safe fix; language: set. No other finding. The Brill formatting
measurements are unchanged from round 8 (`format-eval --chapters all`: 1,353 of 1,383 matched, 99.4%
style agreement, 46/46 title-block paragraphs, 175 tracked changes, no undeclared word change, valid),
apart from the one declared title.

## From the earlier prototype

Read `backend/main.py` of `CUNY-AI-Lab/a11y-check` (a PDF turned into a structure summary, one
model call writing a prose report against two fixed prompts). Taken: the shape of dissertation
requirements and accessibility as a check of its own with three severities. Not taken: its values (none
is in the tool; the Graduate Center's current guide differs from them), layout judged by a model from
a summary that does not hold it (layout is read from the file here), requirements fixed in a prompt
(they come from the uploaded guidelines or the built-in sheet, each with its quotation), a free prose
report with no quotation check, and the upload of the whole file.

## What is not done, and what was not measured

- A table of contents or lists of tables and figures as Word fields: not built. A TOC field shows
  nothing until Word updates it, and whether Word updates it without a prompt could not be checked
  without driving Word, which this round did not do. Missing lists are reported as required parts,
  with the menu that makes them.
- Captions are checked for their side, not moved; front matter is checked for order, not reordered.
- Not applied: the page numbers' distance from the edge, the bibliography's hanging-indent value, a
  title page and copyright page both unnumbered (Word gives a section one different first page; the
  Graduate Center needs only the title page unnumbered, another university both).
- Nothing was opened in Microsoft Word; LibreOffice converted the files, and it prints a restarted
  footnote's number as 0, for this branch's output and `main`'s alike.
- The holdout chapters of the Brill roles were not run again; the dev drop's cause rests on one more
  fresh run of one chapter.
- The accessibility findings are not scored against a hand job (`todos-eval` does not pass the file's
  facts to the checks), and the image-of-text test is a heuristic (a name or description, a strip
  shape, a picture standing where a table is).
