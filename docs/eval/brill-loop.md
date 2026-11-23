# Evaluation loop: the Brill job

Manuscript Desk is built in rounds, and each round is measured against a real formatting job that
was done by hand: an eleven-chapter edited volume, exported from Google Docs with direct formatting
and no styles, formatted for Brill. Each round builds the next stage, measures it on that job,
improves it, and measures again. The manuscript is other scholars' unpublished work: it stays in the
private guidelines folder, and nothing from it (text, titles, names) is in this repository. This
file holds only counts, accuracies and role names.

## Round 1: paragraph roles

The stage: `lib/docx/read.js` reads the `.docx` into one entry per top-level child of `w:body`
(text, kind and direct-formatting hints); `lib/roles/` cuts the paragraphs into passages, and a
model labels each non-empty paragraph with one of 14 roles through `POST /manuscript/api/roles`.

The measure: `gold-roles.json` holds the role of each paragraph as set by hand during the manual job.
Its chapters are split into `dev` (5 chapters, 662 scored paragraphs) and `holdout` (7 chapters,
736 scored paragraphs). Gold paragraphs that the reader finds empty (467 of 1,865, mostly blank
spacer paragraphs inside bibliographies and running text) are not scored, because empty paragraphs
are not sent to the model and get no role. "Structural" roles are all roles except `body` and
`bibliography-entry`; "body as structural" counts body paragraphs given a structural role, the
mistake that would restyle running text.

### How to run it

```bash
CAIL_API_KEY=sk-cail-... npm run roles-eval -- --chapters dev        # or holdout, all, or chapter keys
```

The script reads the single case folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES`
(default `../manuscript-desk-guidelines`; `--case <folder>` picks one when there are several), which
holds `source.docx` and `gold-roles.json`. It runs the product's reader, passages and labelling run,
sends the payload the route sends (`rolesPayload` in `server/prompts.js`) to the public Gateway with
the key in `CAIL_API_KEY`, and prints, per chapter and for dev, holdout and in total: paragraphs
scored, accuracy, structural accuracy, body given a structural role, the confusions as
`gold->predicted: count`, and tokens and cost. `--model` picks another model (default
`deepseek-v4.1-flash-1017`). It prints no manuscript text and writes nothing to disk. Each measured
chapter is labelled together with the ten paragraphs before it (not scored), so a chapter does not
start exactly where a passage starts, as it would not in a whole manuscript.

### Measured runs (dev chapters, `deepseek-v4.1-flash-1017`)

| Run | What changed | Dev accuracy | Dev structural | Body as structural | Cost |
|---|---|---|---|---|---|
| 1 | Baseline: passages of up to 12,000 characters and 80 paragraphs, 8 paragraphs of context before and 4 after, thinking off | 95.6% | 91.5% (238/260) | 1 | $0.0271 |
| 2 | Every paragraph's length in characters shown; the prompt explains verse against prose quotations pasted one printed line per paragraph | 97.3% | 94.2% (245/260) | 1 | $0.0295 |
| 3 | The prompt says heading levels are relative to the chapter; paragraphs a reply left out are asked again in a second pass | 96.2% | 91.5% (238/260) | 1 | $0.0300 |
| 4 | Thinking left on (low effort, the 10,000-token cap) for roles calls | 98.0% | 96.2% (250/260) | 1 | $0.0487 |
| 5 | The prompt asks for one role per set-off quotation as a whole; context widened to 12 before and 8 after (both undone after this run) | 96.8% | 93.1% (242/260) | 1 | $0.0646 |
| 6 | Run 4 plus passages of at most 40 paragraphs, each starting halfway through the previous one, so every paragraph is read twice and the reading with more context on both sides is kept | 98.0% | 96.2% (250/260) | 1 | $0.0919 |

Run 6 is the configuration in the code. Runs 1, 3 and 5 differ from 2 and 4 mostly by one run of
eight paragraphs in one chapter, a prose quotation pasted line by line that the model called verse in
some runs and not in others: a difference of one or two points between two runs is within the noise.

### Holdout (run once, with run 6's configuration, nothing changed after)

| Holdout accuracy | Holdout structural | Body as structural | Cost |
|---|---|---|---|
| 99.0% (736 scored) | 98.7% (221/224) | 4 | $0.1247 |

Total spent on this round: $0.42 (seven runs). A whole manuscript of this size (about 1,400
non-empty paragraphs) costs about $0.25 to label with run 6's configuration.

### Remaining confusions

In the last dev run (13 in all) and the holdout run (7 in all):

| Gold -> predicted | Dev | Holdout | Best explanation |
|---|---|---|---|
| block-quotation -> verse | 8 | 0 | Prose quotations pasted with a line break on every line. Most now come out right from their length, but short lines that end with sentence punctuation and start with a capital look like verse by every visible cue, and a centred prose quotation carries the layout of verse. This is also where the run-to-run noise is. |
| body -> verse | 0 | 3 | Short paragraphs of running text set apart, such as a one-line quoted phrase or a list of short items, read as lines of a poem. |
| bibliography-entry -> bibliography-heading | 2 | 0 | A short line inside a bibliography (a very short entry, or a subdivision that the manual job kept as an entry) reads as a heading. The gold may itself be arguable here. |
| list-item -> body | 0 | 2 | List items typed without Word numbering, as plain paragraphs, are read as running text. |
| heading-1 -> heading-2 | 1 | 1 | A heading in a chapter with a mix of levels, without numbering, whose level is not marked by its formatting. |
| block-quotation -> epigraph | 1 | 0 | A set-off quotation near the start of a chapter, before its first section, has the place of an epigraph. |
| body -> block-quotation | 1 | 0 | A paragraph of running text that consists mostly of a quotation. |
| body -> table | 0 | 1 | A Word table used to lay out running text, which the manual job kept as body. |

Body paragraphs given a structural role: 1 in dev and 4 in holdout (3 as verse, 1 as table), out
of 1,398 scored paragraphs. These are the mistakes the page must make easy to catch when the author
reviews the roles.

### What to try next

- Measure the noise first: repeat the dev run two or three times on the same configuration before
  reading a one-point change as an improvement.
- Read set-off quotations more than once: a vote of three readings for paragraphs labelled `verse`
  or `block-quotation` only (a small share of a manuscript), or a focused second question for each
  run of them that shows the whole run with its lengths and line ends.
- State in the passage what code can see for certain: that a paragraph ends without punctuation and
  the next begins in lower case (a sentence running on), and the length of the longest line in a run
  of set-off paragraphs.
- Lists typed by hand: mark paragraphs that start with a bullet character, a number and a stop, or a
  letter in parentheses.
- Other models: measure the other recommended text models on the same configuration; this round
  measured only the default.
- Other manuscripts: one book is not a generality set. A second case, ideally an article and a
  monograph with styles, would show how much of this carries over.

## Round 2: formatting

The stage: `lib/format/format.js` takes the source `.docx` bytes, the paragraph roles and a rule
sheet and returns a new `.docx` in which structure is carried by named paragraph styles. The
decisions are made first on the reader's paragraph model (`lib/format/plan.js`), then applied to the
XML through a small element tree (`lib/docx/xml.js`) and written back with every part the stage does
not change left byte for byte (`lib/docx/write.js`). What it does:

- One style per role, with variants: `Body Text` and `Body Text First` (no indent after a heading, a
  quotation, verse, an epigraph, the abstract and keywords, a figure, a table or a list, and at a
  chapter's start); `heading 1` for a chapter title with `Chapter Subtitle`, `Chapter Author` and
  `Chapter Affiliation`; `Epigraph` and `Epigraph Source`; `heading 2` and `heading 3` for the two
  heading roles; `Bibliography Heading`, `Bibliography Subheading` (a bibliography heading after
  another in the same chapter) and `Bibliography`; `Block Quotation`, `Verse`, `List Item`,
  `Table Text`, `Figure`, `Figure Marker`, `Figure Caption`; and `footnote text` for the notes. A
  style the document already has under the same name keeps its id and is redefined in place.
- A styled paragraph loses the direct paragraph formatting its style carries (alignment, indents,
  spacing, keep and page-break settings, borders, shading). In its runs, values that change nothing
  go (switches set off, black and near-black text colour, white or clear shading, the body's own
  font and size); the body's font, size and line spacing move to `Normal` and the body styles, so
  the text keeps its look. Italics and bold inside a sentence, superscripts, small capitals,
  underlining, other fonts (the ones East Asian text is set in, say) and coloured text stay. A
  heading's or title's bold or italics over the whole paragraph goes, because the style now marks it.
  Runs, note references, links, content controls, bookmarks, tables and fields are carried over.
- Chapters start at a run of title-block paragraphs and end at the last paragraph with a role before
  the next. With `notes.restart` set to `chapter`, each chapter is a Word section of its own (a copy
  of the properties of the section it falls in, starting a new page) and every section restarts
  footnote numbers; a source section break inside a chapter goes. Without that rule no break is added.
- Empty spacer paragraphs from the last paragraph before the first chapter to the end of the last
  chapter are removed, except one empty paragraph between two lines of verse, kept as a stanza
  break. Bookmarks in a removed paragraph move to the next one.
- The title block's parts are told apart in code (`lib/format/titles.js`), from position and wording:
  a label line, then the title, then subtitles until the people begin; the people are the lines at
  the end of the block that read as names (capitalized words and the particles names hold) or name
  an institution (a multilingual list of words such as university, institute, centre, or an e-mail
  address). An author line that also names the institution, in brackets or after a comma, is split
  into the author line and the affiliation. With `chapters.subtitle` set to split, a title with a
  colon and no subtitle line is split into title and subtitle.
- With `headings.numbering` set to `decimal`, the heading styles are numbered through Word numbering
  (the chapter title at level 0, unnumbered, so section numbers start again in each chapter); a
  chapter whose headings already carry typed numbers is left as it is.
- With `figures.markers`, the first paragraph of each figure becomes a placement marker in the form
  of the guidelines' example, with the figure's number by chapter, and a caption line follows.
- A prose quotation pasted with a break at the end of every printed line (round 1's main confusion)
  is joined back into paragraphs: a block-quotation line joins the next when it stops mid-sentence
  and the next goes on in lower case, or, in a run of lines of about one printed line each, when it
  is as long as a full line.
- Every change to the text is declared with the words it removed and added. Four slots were added
  to the rule sheet for this: `headings.numbering`, `chapters.subtitle`, `figures.numbering` and
  `figures.markers`.

The measure: `scripts/format-eval.mjs` (see the README) formats the source, checks the output with
the structural validator (`lib/docx/validate.js`) and the word check (`lib/format/words.js`: a diff of
the source's and the output's words, body and notes, in which every difference must be declared),
and compares the output with the hand-formatted reference. Paragraphs are matched by their text
(letters and digits only, lower case, a leading section number left out): the longest common
sequence first, then near matches between those anchors. Style agreement is counted on matched
paragraphs through the map in `docs/eval/brill-style-map.json`. The reference's built front matter
(the five sections before the first chapter) and paragraphs outside the chapters the formatter found
are left out. "Title block" counts the matched paragraphs the reference styles as a chapter's title,
subtitle, author or affiliation. Unless a run says otherwise it uses the gold roles and a hand-written
rule sheet of seven rules (the settings the manual job relied on: footnotes restarting in each
chapter, numbered headings in title case, split titles, figure markers in the form the editor's note
gives, figures numbered by chapter).

### Measured runs (dev chapters: 646 reference paragraphs in scope)

| Run | What changed | Matched (near) | Style agrees, dev | Title block | Undeclared word differences | Validity |
|---|---|---|---|---|---|---|
| 1 | Baseline: the stage as described above, without the last two items | 617 (13) | 100.0% (617) | 18/18 | 0 | valid |
| 2 | Lines of a quotation pasted one per paragraph joined back into paragraphs | 627 (10) | 100.0% | 18/18 | 0 | valid |
| 3 | An author line that names its institution split into author and affiliation | 629 (10) | 100.0% | 20/20 | 0 | valid |
| 4 | The body font also set for East Asian text in `Normal` (seen in the PDF: text in that script had lost its font); the last section keeps its own properties | 629 (10) | 100.0% | 20/20 | 0 | valid |
| 4p | Run 4 with roles predicted by the labelling stage (round 1's run 6 configuration) | 629 (11) | 98.1% | 20/20 | 0 | valid |
| 4e | Run 4 with the rule sheet the product extracts from the Brill guidelines | 622 (3) | 100.0% | 20/20 | 0 | valid |

Run 1 with predicted roles: 617 matched, 98.1%. The extracted sheet (178 rules, 14 left out,
`deepseek-v4.1-flash-1017`) holds every setting the hand sheet has, but takes the figure marker's
form from the author guide's example rather than the editor's note the manual job followed, so its
seven markers do not match the reference's text; its two `figures.numbering` rules disagree
(chapter and whole work) and are not applied, and the marker's example (a number with a chapter
part) decides numbering by chapter.

In every run the output was a valid Word file and the word check found no undeclared difference: the
output has 78,637 body words and 11,990 note words against the source's 78,623 and 11,990 (the
reference: 79,044 and 11,744); the 35 words removed and 49 added are the declared title splits (the
word that carried the colon), the seven rewritten placement markers and their caption lines. Note
references (390), links (125), tables (4), content controls (86) and bookmarks (31) are carried over
in equal numbers. The output has 14 sections, each restarting footnote numbers (the reference has
19: its five front-matter sections, two part-title sections and twelve chapters; the output has the
source's two front-matter sections and one section per chapter, the introduction's also holding the
notes on contributors that follow it in the source). LibreOffice converted
the output to PDF headlessly; it shows per-section footnote numbers as 0, as the job notes say it
does for any file that restarts them.

Declared transformations in the final run: 587 empty paragraphs removed, 4 kept as stanza breaks,
37 pasted quotation lines joined, 7 titles split at a colon, 1 author line split from its
affiliation, 7 placement markers rewritten and 7 caption lines added, 9 section breaks added at
chapter starts and 1 removed inside a chapter, 45 heading numbers added through Word numbering, and
1 duplicate style definition removed.

The title block needs no model call: the code reads it right on every matched title-block paragraph,
20 of 20 in dev and 26 of 26 in holdout, with gold and with predicted roles.

### Holdout (run once with run 4's configuration, nothing changed after; 737 reference paragraphs)

| Roles and sheet | Matched (near) | Style agrees | Title block | Undeclared | Validity |
|---|---|---|---|---|---|
| Gold, hand sheet | 724 (4) | 98.9% (716/724) | 26/26 | 0 | valid |
| Predicted, hand sheet | 724 (4) | 99.0% | 26/26 | 0 | valid |
| Gold, extracted sheet | 724 (4) | 98.9% | 26/26 | 0 | valid |

All chapters with gold roles and the hand sheet: 1,353 of 1,383 reference paragraphs matched, 99.4%
style agreement, 46/46 title-block paragraphs.

After the holdout run, one change was made that is not a formatting decision: a review found that
style definitions were written by putting values from the document (its style ids, its line
spacing) into XML text. They are now set as attributes, which the writer escapes, and the stage
returns a typed failure instead of throwing. Re-measured on all chapters, every number above is
unchanged.

### Remaining differences (all chapters, gold roles, hand sheet)

| Reference -> tool | Count | Explanation |
|---|---|---|
| `ChapterLabel` unmatched | 12 | The manual job added a label line above each title. The source has none and no rule asks for one. |
| `FigureCaption` unmatched, `Figure Caption` unmatched | 7 and 7 | The captions were in notes attached to the placeholder markers; the manual job moved them into caption lines. The tool writes the caption line with the figure number only and lists the caption as owed. The seven markers themselves match only nearly: the tool numbers the introduction as chapter 1, so the fifth chapter's figures are 6.n, not 5.n. |
| `PartLabel` and `PartTitle` unmatched | 2 and 2 | Part title pages built by the manual job; the source's chapters carry no part structure. |
| `(table)` and `TableCaption` unmatched, `Table Text` unmatched | 1, 1 and 10 | Ten tab-separated lines that the manual job rebuilt as a Word table with a caption. |
| `BodyTextFirst -> Body Text` | 4 | Paragraphs after four Word tables that the gold labels `body` (tables used to lay out running text, round 1's `body -> table` case). The first-paragraph rule follows the role, so a table labelled body does not count as a display element. |
| `Verse -> (none)` | 3 | Three lines the gold leaves without a role; the manual job set them as verse. |
| `Bibliography` unmatched, both sides | 2 and 2 | Entries whose repeated-author dash the manual job replaced with the name (a text change). |
| `ChapterAffiliation` unmatched, `Chapter Author` unmatched | 1 and 2 | A title block with two author names on two lines, which the manual job joined into one line, and an affiliation line that names no institution word, which code reads as a name. |
| `Heading2` and `BodyTextFirst` unmatched | 1 and 1 | A note on a chapter title moved into a "Note on the Text" section before the bibliography (the publisher allows no notes on titles). |
| `BodyText -> Body Text First` | 1 | The paragraph after the rebuilt table: the reference put an empty table-text paragraph between them, so its own rule saw no table before it. |
| `(none)` unmatched | 1 | A stray fragment the manual job deleted; the gold leaves it without a role. |
| Near matches | 14 | The placement markers above, and paragraphs whose text the manual job edited (typing slips, punctuation). |

With predicted roles the extra disagreements are round 1's labelling confusions: `BlockQuote -> Verse`
7 (prose quotations pasted line by line, read as verse, so they are not joined), `BodyText -> Body Text First`
3, `Bibliography -> Bibliography Subheading` 2, `BodyText -> Block Quotation` 2, and five single cases
around epigraphs and lists. The 23 paragraphs between the introduction and the first chapter (the
notes on contributors) are counted in the introduction, because the labelling stage gives them roles.


### Needs the author

What the reference did that the tool cannot know to do without a human decision, by kind, with the
count in this job:

| Kind | Count |
|---|---|
| Figure caption to write (the marker's note may hold it) | 7 figures |
| Chapter number to confirm for figure numbers (no chapter labels; whether the introduction counts) | 1 chapter |
| Chapter label lines above titles | 12 chapters |
| Part title pages | 2 parts |
| A table to build from tab-separated lines, with its caption | 1 table (10 lines) |
| Title-block wording: names joined on one line, an affiliation to correct | 1 chapter |
| Repeated-author dashes in bibliographies to replace with names | 2 entries here (6 in the job) |
| A note on a chapter title to move into a note on the text | 1 chapter |
| Lines to delete or keep that the source leaves ambiguous (a stray fragment, a duplicated passage) | 4 paragraphs |
| Front matter: title page, contents, list of illustrations, abbreviations, notes on contributors | out of scope this round |

The tool reports the first two kinds itself; the others come from this comparison.

### What round 3 should do

- Write the declared text changes (split titles, markers, joined lines) as tracked changes, as the
  design asks, and add comments for the "needs the author" kinds the tool can detect.
- Treat a Word table as a display element in the first-paragraph rule, whatever its role.
- Rules the reference applied that the sheet already reads but the stage does not yet apply: note
  numbers after punctuation, heading capitalization, full names for repeated authors; each as a
  declared, tracked change.
- Read chapter numbers and part titles from the manuscript's own contents list when it has one,
  and ask the author when it has none.
- Feed the line-joining signal back into labelling: a run labelled verse whose lines stop
  mid-sentence at about one printed line each is prose (the main confusion left with predicted roles).
- A second case, ideally an article or a monograph whose source already uses styles, to see how much
  of this carries over.

Spent in this round: $0.30 (the rule-sheet extraction, $0.03, and the labelling of the whole
manuscript, $0.27, each once and cached).
