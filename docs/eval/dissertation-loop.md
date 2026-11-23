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

### A real thesis (counts only)

No real Graduate Center dissertation `.docx` was available. The one real thesis on this machine that
could be used is the owner's own master's thesis from an Italian university (its title page in
Italian, its text in English; 3,225 paragraphs, 20 pictures, 11 tables, chapter titles in Word's
Heading 1 style, A4 pages in 199 sections with uneven margins, page numbers top left). A private copy
was labelled through the product's own labelling run (109 calls, $0.66 by the script's catalog price,
no failure; the labels were not reviewed, as a student would in step 5) and formatted with the
Graduate Center sheet. It is not a Graduate Center dissertation, so this tests the tool on a real file,
not that file's compliance.

- **Labels**: no paragraph was labelled as a chapter's title block: the chapter titles in Heading 1
  came out as section headings. With no chapter, the front matter could not be numbered apart, the
  chapters could not start pages or restart notes, and the formatter left the numbering as it was and
  said so; this round adds a To-do that names the cause and the fix in step 5. The labelling prompt
  was not changed for it: a change would have to be measured on the Brill case and this thesis again,
  and the round stopped paid calls before that (see the spend below).
- **Applied**: US Letter in all 199 sections, 1-inch margins in all 199, the body double-spaced
  (1,628 of 1,628 body paragraphs); no word changed undeclared; every download valid.
- **Not met**: text as small as 4.5 pt (under the 9-pt floor; not applied, flagged by the sheet's rule
  only as "not checked"); page numbers with a footer distance of 0 and not on the first section; the
  bibliography's hanging indent (two values, neither 0.5 in).
- **Parts**: found title page, contents, list of abbreviations, bibliography; reported missing:
  copyright page, approval page, abstract, list of tables, list of figures (it has both) and the first
  chapter (from the labels). Title page: reported as lacking the author's name, the statement, the
  degree and the year: wrong in part, because the reader of title pages assumes the title comes first
  and this layout puts the university first and the title near the end, with one unlabelled line in
  between that ends the page early.
- **Accessibility**: 14 pictures without alt text (must), 6 whose alt text looks machine-written or a
  file name (check), 8 tables without a header row (must; 2 more were marked by the safe fix), 103
  paragraphs with highlighting or colour (should), 12 links whose text is a bare address outside the
  bibliography (check); title set by the safe fix; language present.

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

## Spend

By the scripts' catalog prices: extraction $0.54, Brill roles $0.19, the thesis's labels $0.66, about
$1.39 in all. The Gateway's own figure for the key over its 30-day window was $2.68 used when paid
calls stopped; that figure includes use of the key before this round (and by any other session using
it), and no figure for this round alone was available, so paid calls stopped there to stay inside a
$3 cap on either reading.

## Round 2: chapter titles from the file, the page numbers' distance, the hanging indent, the title page

Round 2 (2026-11-23), on the branch `dissertations-2`: four gaps the real thesis showed in round 9.
Counts, measurements and generic descriptions only, as above.

### 1. Chapter titles typed in Heading 1 read as section headings

**The cause, from the cached answers first.** The thesis's labelling run (round 9) was kept, answer by
answer. Each of its six chapter titles (an introduction, four numbered chapters, a conclusion, all in
the Heading 1 style) was read in two overlapping passages: 10 of the 11 readings said `heading-1`, one
said `title-block`, and the reconciliation kept a `heading-1` every time. The model also read the
chapters' own sections (Heading 2) as `heading-1` in one chapter and `heading-2` in the others. What the
passage showed of those titles: the style id ("style Heading1"), the alignment, the indents, the length;
not that each starts a new page (the break is a section break at the end of the paragraph before, which
the reader did not report), not the outline level, and not the contents list's levels (the file's
contents list is one content control, which the passage shows as a single block of lines). The prompt
defines a title block as "the title, subtitle, author names and affiliations at the start of a chapter
or article", says the manuscript has "no paragraph styles", and has no sentence on a single-author
work, whose chapter titles stand alone. So the model was given a style id that spells the wrong role
and none of the evidence that tells a chapter from a section; the file has that evidence. A paid
comparison on the passages that hold the chapter titles of both real dissertations measured what
changes the model's reading (table below).

**The fix: the file's own structure, after the labelling, the model's label deciding where it is
silent.** The reader (`lib/docx/read.js`) now gives each paragraph, apart from the hints the passage
shows (so the labelling passages, and every cached answer, are unchanged): its style's name and outline
level (through the styles it is based on; a built-in "heading N" style counts as level N), whether it
starts a new page (a page break before it, in its style or at the start of its text, or a page or
section break at the end of the text before it), and its level in the file's contents list (by the
list's links to bookmarks, or by a contents line with its words). A pass after the labelling
(`lib/roles/structure.js`), for a monograph or a dissertation only, makes a paragraph the model called a
heading a chapter's title block when two signs mark it as a top-level division: one that marks a level
(the top outline level, the top level of the contents list, a "Chapter 3" label) and one that is not
the style again (a new page, the contents list, a label); front or back matter headings at the same
outline level count as a sign but never with the outline level alone. A heading so marked whose words name front or
back matter heads that part; a label line before the title joins the title block; the headings of each
chapter at the top level are levelled again under its title (by the contents list's level, else the
outline level, when every heading has one; else, in a chapter the pass found, moved up when none is at
the top). Title-block lines right after an abstract's heading, before the first chapter, are the
abstract page's own title and author lines. The pass leaves the file alone when fewer than two headings
are so marked, and when most of the chapters the model found itself, two or more, stand at another
level (a book whose chapter titles have a style of their own and whose sections use Heading 1). Body
text, front and back matter and title pages are never changed by it. The page runs it in step 5 and
says how many chapter titles it found; `roles-eval` scores the roles before and after it;
`format-eval --predicted` applies it.

**Gold.** Set by hand for this round, privately, before the fix was measured: the thesis's structural
paragraphs (title page, front matter headings, contents, chapter titles, headings by level, the
bibliography's headings; 55 paragraphs, from the rendered PDF's numbering and the file's contents
list), with a `scope` so that a paragraph not listed but predicted with one of those roles counts as an
error. A second real document was found read-only on this Mac: the owner's own Graduate Center
dissertation deposit, which uses Heading 1 for its chapters and a custom heading style for its front
and back matter. Its 112 structural paragraphs were set by hand before any label of it was seen, and it
was labelled once, fresh (58 calls).

| | Thesis, before | Thesis, after | Second dissertation, before | Second dissertation, after |
|---|---|---|---|---|
| Chapters' structural paragraphs (titles, headings) | 3/25 | **24/25** | 7/25 | **25/25** |
| Front and back matter, structural | 26/27 | 26/27 | 80/87 | **85/87** |
| Chapters found by the formatter | 0 | 6 of 6 | 3 of 5 (one of them the abstract page) | 5 of 5 |
| Paragraphs predicted as a scope role the gold does not list | 0 | 0 | 0 | 0 |

The second dissertation is not a clean holdout: the pass as first written, on the thesis alone, changed
nothing on it (the model had read its abstract page's title lines as a chapter title block, which
tripped the guard against files whose chapters are found elsewhere), so the guard was narrowed, the
abstract page rule added and the levelling extended to chapters the model found itself, after that
result had been seen. The thesis's remaining errors: one heading set in the Heading 3 style that the
file's numbering shows as a first-level section (the styles and the numbering disagree), the
title page's table of names labelled as a table, and three archive names inside the bibliography read
as its subheadings. The second's: two bold lines heading the items of a front-matter section, read as
list items (the gold's judgment calls them headings).

**What the model needs, measured.** The 11 passages of the thesis that hold its six chapter titles were asked
again (`deepseek-v4.1-flash-1017`, 22 calls), each answer kept privately: once with the round's
evidence written into the passage lines (outline level, "starts a new page", contents level), the
prompt unchanged; once with the prompt given one sentence that a single-author work's chapter title is
`title-block` though no author line follows it, the passage unchanged. Readings of a chapter title as
`title-block`, out of 11: the cached run 1, with the evidence in the passage 1, with the sentence in the
prompt 3. Neither change to what the model reads makes it find the chapters; the pass on the file's
evidence finds all six. The same comparison on the second dissertation was stopped after one call (the
Gateway was refusing most calls for its rate limit at the time), so it rests on the thesis alone.

**Brill (an edited collection).** The labelling prompt and the passages are unchanged, so every cached
answer was reused; the pass does not run for an edited collection, and forced as a monograph it
changes 0 labels on the dev and holdout chapters (the file has no outline levels). The holdout chapters
had not been labelled with the round 9 prompt, and round 9's dev result (232/260 structural) rested on
one fresh run; both were labelled fresh this round:

| | Round 6 (recorded) | Round 9 (one run) | Round 2 of this loop |
|---|---|---|---|
| Dev | 98.0% (250/260 structural) | 95.3% (232/260) | **98.0% (250/260)**, a fresh run |
| Holdout | 99.0% (221/224) | not run | **99.0% (221/224)** |
| Front matter | 57/57 | 57/57 | 57/57 |

The dev confusions of the fresh run are round 6's (block quotation read as verse 8, and five others),
so round 9's drop was the run-to-run variance it was taken for. `format-eval --chapters all` (gold
roles, hand sheet: 1,353 of 1,383 matched, 99.4% style agreement, 46/46 title-block paragraphs, 175
tracked changes, no undeclared word change, valid; predicted roles: 98.6%, 46/46) and `todos-eval
--chapters all` give the same output as `main`.

### 2. Page numbers 0.49 inch from the edge

New setting `layout.page-number-distance` (inches): every section's header and footer distance is
raised to at least that much. A section whose top or bottom margin would leave less than a quarter of
an inch beyond the header or footer is listed for the author (Word would move the text), and so is a
page number in a text box or frame fixed on the page, which a header distance does not move. Wired
through the schema, the reading prompts (its use line), the rules view, the checklist and the summary;
the Graduate Center sheet's "at least ¾” from any edge of page" rule now sets it to 0.75 (it was a rule
to check).

### 3. The bibliography's hanging indent 0.39 inch

New setting `references.hanging-indent` (inches), applied to the Bibliography style (direct indents on
entries are removed as before), with the same wiring; the Graduate Center sheet's checklist question
"Is there a 0.5” hanging indent in this section?" now sets it to 0.5. The sheet keeps 39 rules, 13 with
settings (11 applied by the formatter, 2 checked); `npm run check-preset` found every quotation on its
page again.

### 4. The title page read by position

`titlePageParts` (`lib/format/titles.js`) reads each line of a whole work's title page by what it says:
"by" or "Edited by", a date line (a year with months, seasons or the words of an academic year), an
advisor's or a candidate's label, a submission statement, a program, an institution (with a line that
goes on from it, such as one starting with "and"), a line of names; the author is the name after "by"
or a candidate's label, else the last line of names not under an advisor's; the title is the first line
that is none of these, and the lines of words right after it are its subtitles. The formatter's title
page styles and the title-page check both use it. The check reads the page across a picture or a table
between its lines (a logo, a table of the candidate's and advisors' names), cell by cell, and knows a few
more degree, program and advisor words. Tests on invented pages in four orders: the Graduate Center's
(title, "by", author, statement, institution, year); the university first, title near the end, the
candidate and advisor under labels, the academic year last; the date and statement before the title,
"Presented by" after it; a book's title in capitals that read like names, with "Edited by" and the
editors' institutions. One expectation of an older test changed: an "Edited by" line after a one-line
title is now a label, as the README says it is, not a subtitle.

### Follow-ups the real files showed

With chapters found, the contents check ran on both real dissertations and reported their chapters
missing from the list and their section lines as matching nothing: a Word table of contents in a
content control is one paragraph holding every line, a dissertation's contents list gives the sections
too, a list of figures was read as part of the contents, and a heading that is only a label word
("Appendix") had nothing to match. Each is fixed and tested; Brill's to-dos are unchanged.

### The invented dissertation, before and after

The same file and pipeline as in round 9 (`buildOutputs`, the built-in sheet), measured from the file
and from LibreOffice's PDF. Every row of round 9's table is as it was, except:

| Requirement | Before | After |
|---|---|---|
| Page numbers at least ¾ in from the edge | footer distance 0.49 in; PDF: the number 0.492 in from the bottom edge on 9 of 9 numbered pages | **met**: header and footer 0.75 in in all 4 sections; PDF: 0.750 in on 9 of 9; the lowest text 1.00 in from the bottom edge, 0.06 in above the number |
| Bibliography hanging indent 0.5 in | 0.39 in (2 of 2 entries) | **met**: 0.50 in (2 of 2) |

The rest, measured again: US Letter (4 sections; PDF 612 × 792 pt), 1-inch margins, body 7/7 at
double spacing, abstract, dedication and contents 5/5, notes 2/2 single, smallest text 10 pt, front
matter lower-case roman from i with the title page unnumbered (PDF: none, ii to vii), the chapters
arabic from 1 (PDF: 1 to 3), numbers bottom centre throughout, notes restarting in every section, the
same part order, missing parts and title page findings, no undeclared word change, every download
valid. The pass changes nothing on this file (its roles are given).

### The real thesis, before and after (counts only)

The thesis of round 9, its labels from round 9's run (not reviewed), the built-in sheet; before is
`main`, after is this branch with the pass. It is not a Graduate Center dissertation (an Italian
master's thesis, apparently converted from a PDF: one section per page, notes typed as text, page
numbers in a text box in the header).

| Requirement | Before | After |
|---|---|---|
| Chapters found | 0 (a To-do said why) | 6 |
| US Letter, 1-inch margins | met (199 sections) | met (10 sections: the 189 page breaks inside chapters went) |
| Body double-spaced | 663/663 | 663/663 |
| Front matter numbered apart, title page counted and unnumbered | not applied ("no first chapter was found") | applied: title page's section lower-case roman from 1 with no number on its first page, 3 more in roman, the introduction arabic from 1, 5 continuing |
| Chapters and major sections on a new page | met (the source breaks every page) | met: 9 of 9 titles at the top of a page in the PDF |
| Header and footer at least ¾ in from the edge | header 0.49 in, footer 0 | 0.75 in in all 10 sections |
| The visible page numbers | the file's own, in a text box fixed 0.80 in from the top | the same box, 0.80 in from the top (the distance does not move it; now listed for the author); LibreOffice clips its digits, so the numbers it shows cannot be read off the PDF |
| Bibliography hanging indent 0.5 in | 0.39 in | 0.50 in on 961 of 962 paragraphs in the Bibliography style (one, a numbered list paragraph, keeps its list's indent) |
| Title page states title, author, statement, degree, year | reported lacking the author, the statement, the degree and the year | all five found; no finding |
| Required parts | 6 missing reported (copyright, approval, abstract, lists of tables and figures, the first chapter) | 5 (the same without the first chapter); they are missing from this file |
| Contents list against the chapters | not run (no chapters) | run; no finding |
| No word changed undeclared; valid files | met | met |

The second dissertation, the same way: chapters found 3 (the abstract page among them, so the arabic
numbers began at the abstract) → 5; page numbers 0.51 to 0.71 in from the bottom edge in the PDF → 0.76
to 0.96 in on 296 of 297 pages, the lowest text still 1.01 in from the edge; front matter in roman
numerals ii to x, where before the arabic numbers began on its fifth page; the hanging indent 0.39 →
0.50 in; the title page finding (author "missing") gone; the order finding (the first chapter out of
order) gone.

### What remains

- Nothing was opened in Microsoft Word. LibreOffice prints the file's own header text box with clipped
  digits on the thesis, so whether every page shows its number there was not checked.
- The pass needs a styled file: a manuscript typed with direct formatting only and no contents list
  gets nothing from it (Brill shows 0 changes), and its chapter titles depend on the model as before.
- The labelling prompt still says the manuscript has no paragraph styles and defines a title block by
  its author lines; see the measured comparison above before changing it, and measure Brill again if
  it changes.
- A page number in a fixed text box is listed, not moved.
- The second dissertation's gold and the pass were not independent (above); a third styled document
  would be the clean test.

### Spend

By the scripts' catalog prices: the second dissertation's labelling $0.169, Brill holdout $0.134,
Brill dev fresh $0.100, the comparison of passages and prompt about $0.14 (23 calls; the script was
stopped before printing its own tally, so this is 23 calls at the thesis run's average of $0.006): about
$0.54 in all, under the $3 cap. Calls the Gateway refused for its rate limit are not charged. The thesis was measured from round 9's cached answers.
