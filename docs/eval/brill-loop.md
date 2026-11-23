# Evaluation loop: the Brill job

Manuscript Desk is built in rounds, and each round is measured against a real formatting job that
was done by hand: an eleven-chapter edited volume, exported from Google Docs with direct formatting
and no styles, formatted for Brill. Each round builds the next stage, measures it on that job,
improves it, and measures again. The manuscript is other scholars' unpublished work: it stays in the
private guidelines folder, and nothing from it (text, titles, names) is in this repository. This
file holds only counts, accuracies and role names.

## Where things stand

For a reader who has not followed the rounds: the current headline numbers, each from the round
named, then what no person has checked and what is not built. The rounds below hold the detail.

| Measure | Current result | Round |
|---|---|---|
| Guideline reading, 18 publishers' guidelines | 421 of 438 expected requirements (96.1%), lowest case 88.9%, PASS (round 6: 424, lowest 70.0%, FAIL) | 7 |
| Settings stability, Brill guidelines | 18 settings filled in all of five runs (5 before round 4); 19 in round 6's 18-case run, 21 in its page run | 5, 6 |
| Paragraph roles, structural | dev 98.0%, holdout 99.0% (run once), front matter 57 of 57 | 6 |
| Style agreement with the hand-formatted file | gold roles, hand sheet: dev 100.0%, holdout 98.9%; the page's own labels and sheet: 98.7% over the book. Style names only: not how the file looks (next row) | 6, 8 |
| How the file looks against the hand-formatted file (`render-eval`, gold roles, hand sheet, 1,359 matched paragraphs) | font 100% (98.4% before round 8), size 98.7%, space before 97.0% and after 96.2%, indents 95.0 to 97.2%, first-line indent 73.5%, alignment 98.8%, line spacing 0% (the manuscript's double spacing is kept: the guidelines set none, the hand job chose 1.5); no Latin text outside the body font (6,834 characters before); page setup agrees in 0 of 12 chapters (margins and page-number position are the hand job's choices). Word: 241 pages against 224 | 8 |
| Comments of the manual job found | structure 21 of 26, reading 7 of 12 strictly (8 by the script), human 0 of 1 (not imitated, by design) | 6, 7 |
| Calls and rough cost for this book | about 14 calls to read the guidelines, 85 to label 1,460 paragraphs, 13 to 15 for the reading check, 1 for running titles: about 115 calls and $0.50 to $0.60 by the Gateway's estimate | 4, 6, 7 |

A correction to rounds 2 to 7: "style agreement" (99%) counted whether each paragraph got the
style name the hand job gave it. It said nothing about what those styles look like, direct
formatting left in runs, page setup, headers and footers or fonts. Opened side by side in Word,
the tool's file was visibly less finished; since round 8, `render-eval` measures what a reader sees.

Never checked by a person:

- Accepting or rejecting the formatted file's tracked changes in Word. Word opened the formatted
  file and exported it to PDF without a repair prompt (the stakeholder before round 8, the agent in
  round 8); its changes have not been reviewed one by one.
- The review step (step 5) used by a scholar on a real manuscript, including its front-matter group.
- The reading check's extra queries judged by someone other than the agent that built the check
  (they are "real on my reading" in rounds 5 and 6, a judgment by that agent).
- The rate-limit backoff against a real refusal: no measured run has been refused by the Gateway
  since round 5, so the pauses are exercised only by unit tests.
- Whether the rules the sentence question adds are requirements rather than advice, beyond the
  agent's own sample (round 6) and a word count (round 7).

Not built (checked against the design and the code, round 7):

- Deployment. Built for it (2026-11-23): the release job and its readback, the once-per-page
  sign-in guard, the saved work deleted 24 hours after the last change also while the page is open
  (kept after download, by decision; "Delete saved work now" deletes it at once), and a beta line on
  both pages; see the README's Release section. Not done: the first release, the Doorway route, the
  verifier key in the `production` environment, the catalog entry and a signed-in acceptance run.
- Usage attribution. The Worker sends `X-CAIL-App: manuscript` on every Gateway call, but the Gateway
  does not read that header for attribution: it takes the tool from the `tool` claim of the
  `cail:gateway` assertion Doorway signs, which the Worker passes on unchanged and cannot alter. Doorway
  names a tool there only from its `GATEWAY_TOOLS` list (`apps/doorway/src/identity.ts`), and the
  Gateway keeps only ids in its `CAIL_TOOLS` and `JWT_TOOLS` lists (`src/tool-attribution.ts`), so
  this tool's calls are reported as `unattributed`, as the Bibliography Converter's are. Naming it
  takes `"manuscript"` in both lists, in the Gateway contract's tool lists
  (`docs/gateway-contract.md`) and in Admission's `tool` CHECK (`apps/admission/src/registry-schema-v24.ts`,
  a migration); no change here.
- Chapter labels are added only when the rule sheet sets `chapters.label` (round 8); these
  guidelines do not, so none is added in this job (the hand job added 12).
- A rebuilt contents list: the typed list is kept and compared with the chapters; none is built
  with page numbers. Front matter is not put in the order the editor's note lists.
- Tables from tabbed lines: such lines get the table style and a To-do asking the author to make a
  Word table; no table is built.
- A second manuscript, ideally one whose source uses styles: everything here is measured on one book.

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

## Round 3: what is left for the author

The stage: tell the author what is left for them, the way the hand job did with 39 Word comments
addressed to the volume editors and four companion documents.

### The answer key

The 39 comments of the hand-formatted file were read with their anchors and keyed privately
(`work/comments-key.json` in the case folder): for each, the chapter, the source paragraph it
concerns (for a comment on text the manual job built, such as a rebuilt table or a new heading, the
source paragraph it was built from), the role of that paragraph, a kind, and a class: `structure`
(derivable from roles, formatting and the rule sheet, with no reading of prose), `reading` (needs a
model to read the text) or `human` (a judgment or outside knowledge no tool should fake). A comment
whose content spans classes takes the class of its core; 10 of the 39 also have a part in another
class (6 a human part, 3 a structure part, 1 a reading part).

| Kind | Structure | Reading | Human | Where |
|---|---|---|---|---|
| chapter-title (a title split, with quotation marks, in capitals, long without a subtitle) | 6 | | | chapters |
| wording-inconsistent (two places name the same thing differently) | | 5 | | 3 in chapters, 2 front matter |
| contents-mismatch (the old contents list disagrees with the chapter) | 2 | | | 1 chapter, 1 front matter |
| heading-numbering (numbers added, or typed and incomplete) | 2 | | | chapters |
| stray-or-duplicated-text | 2 | 1 | | chapters |
| affiliation-inconsistent | | 2 | | chapters |
| contributor-bio (missing, too short) | 1 | 1 | | front matter |
| formatting-summary (what the pass changed) | 1 | | | front matter |
| front-matter-to-supply (cover image and its credit) | 1 | | | front matter |
| abstract-missing | 1 | | | chapter |
| keywords-form | 1 | | | chapter |
| bibliography-headings | 1 | | | chapter |
| repeated-author-dash | 1 | | | chapter |
| source-highlight (highlighted text in the source) | 1 | | | chapter |
| figure-to-supply (file, size, permission, alt text, callouts) | 1 | | | chapter |
| table-from-tabs | 1 | | | chapter |
| table-for-layout (Word tables of parallel text) | 1 | | | chapter |
| title-block-people (two affiliation lines joined) | 1 | | | chapter |
| quotation-lines-joined | 1 | | | chapter |
| note-on-title | 1 | | | chapter |
| abbreviations-system | | 1 | | front matter |
| typo | | 1 | | front matter |
| missing-spaces | | 1 | | chapter |
| list-of-illustrations (with a question about other chapters' images) | | | 1 | front matter |
| **Total** | **26** | **12** | **1** | 29 in chapters (12 dev, 17 holdout), 10 front matter |

Two thirds of what the hand job told the editors (26 of 39) needs no reading of prose: it follows
from the roles, the formatting and the rules. Of those 26, 4 need the front matter or the old
contents list, which no stage reads yet. A third (12) needs a model to read, and one is a judgment.

### What was built

- Six rule-sheet slots for what the checks read: `titles.quotes`, `figures.files`,
  `figures.callouts`, `notes.titles`, `references.repeated-author`, `running-title.length`.
- The formatter declares where it made each change (source paragraphs) and lists its figures.
- `lib/checks/`: 21 checks, each run only when a rule asks for what it checks or when it concerns
  a change the formatter made: the summary of the pass; chapter titles (split to verify, quotation
  marks, capitals, long without a subtitle); abstracts and keywords (missing, length, number,
  repeats, mixed separators); notes on title-block lines; repeated-author dashes; heading numbers
  (added, or typed and incomplete); bibliography headings across chapters; joined quotations; what
  each figure still needs (file, permission, alt text, caption, a mention in the text); tables typed
  with tabs; Word tables of running text.
- Word comments in the formatted file (one per place, by "CAIL Manuscript Desk", a general one at
  the top with counts), and the validator extended to the comments part.
- The To-dos list as its own `.docx`, by chapter and kind, each item naming its rule and quoting the
  guideline sentence, then what to supply, then what was changed, flagged and skipped.
- Companion documents, each only when a rule asks: abstracts and keywords, alt-text template,
  running titles, checklist.
- Running titles proposed by a model (`POST /manuscript/api/running-titles`), kept only when they fit
  and add no word the title lacks; one more request, with the count, for any that is too long.
- Tracked changes for the formatter's changes to words: split titles and author lines, rewritten
  and added figure markers, added caption lines and caption numbers. Rejecting them all gives back
  the source's words exactly (45 tracked changes on this case). Joined quotation lines, which
  change no word, stay direct, declared and commented.

The measure: `npm run todos-eval` (see the README). A key comment counts as produced when a finding
of the same kind, in the same chapter, sits on its paragraph or within two paragraphs with text of
it; each finding counts once. Findings are counted as places (kind and paragraph). The hand sheet
grew from round 2's 7 rules to 21: the requirements the manual job relied on, each now quoting its
guideline sentence from the verified extraction.

### Measured runs (dev chapters: 12 comments, 12 of them structure; front matter shown apart)

| Run | What changed | Structure produced, dev | Extra places, dev | Front matter, structure | Validity |
|---|---|---|---|---|---|
| 1 | Baseline: the stage as described above, one finding per chapter for joined quotations, bibliography headings compared without capitals | 8/12 | 7 | 1/4 | valid, 30 comments |
| 2 | One finding per joined quotation (its paragraphs: those with only quotation lines between them) | 9/12 | 10 | 1/4 | valid |
| 3 | Bibliography headings that differ only in capitals count as different | 10/12 | 10 | 1/4 | valid, 35 comments |
| 3p | Run 3 with predicted roles (round 1's labelling) | 9/12 | 9 (and 2 in front matter) | 1/4 | valid |
| 3e | Run 3 with this round's extracted sheet (134 rules) | 8/12 | 5 | 1/4 | valid |
| 3e2 | Run 3 with round 2's extracted sheet (178 rules, none of the new slots) | 9/12 | 9 | 1/4 | valid |
| 4 | Running-title proposals and tracked changes added (no change to the checks) | 10/12 | 10 | 1/4 | valid, 35 comments, 45 tracked changes |

With predicted roles the first heading of one chapter is not labelled a heading (the heading-number
finding moves out of reach), and the notes on contributors, which the labelling gives roles, become
part of a chapter. The extracted sheets differ from run to run: this round's two extractions with the
new slots kept 131 and 134 rules and filled 7 and 9 slots (3 and 4 of the 6 new ones); round 2's
own code, run again today, kept 135 rules and filled 3. Round 2's cached sheet (178 rules, 9 slots)
was a fuller run than any since: the subtitle split, the figure marker, the abstract length and the
keyword count were left unslotted in all three runs this round, so with the extracted sheet the
titles are not split (title block 10/11 in the formatting measurement) and the checks those slots
gate do not run. Run-to-run variance in slot filling, not the new slots, is the cause.

### Holdout (run once with run 4's configuration, nothing changed after; 17 comments, 10 structure)

| Roles and sheet | Structure produced | Reading produced | Extra places | Validity |
|---|---|---|---|---|
| Gold, hand sheet | 7/10 | 0/7 | 7 | valid |
| Predicted, hand sheet | 7/10 | 0/7 | 7 | valid |
| Gold, extracted sheet | 5/10 | 0/7 | 2 | valid |

The baseline run printed the holdout rows as well (7/10), before the script was changed to report the
dev chapters by default; the two changes after it concern dev chapters only and leave the holdout
number where it was. All chapters, gold roles and hand sheet: structure 18 of 26 (dev 10/12, holdout
7/10, front matter 1/4), reading 0 of 12, human 0 of 1; 17 extra places.

### Misses by kind (all chapters, gold roles, hand sheet)

| Kind | Missed | Explanation |
|---|---|---|
| contents-mismatch | 2 (1 dev, 1 front matter) | Needs the manuscript's own contents list as a role, to compare with the chapter titles. Front matter is out of scope this round. |
| stray-or-duplicated-text | 2 structure (holdout), 1 reading | A fragment and a duplicated run of lines. No rule in the sheet asks for a clean manuscript in a form a check can read, and a check with no rule behind it does not run. The gold also leaves these paragraphs without a role. |
| source-highlight | 1 (dev) | Highlighting in the source, kept by the formatter. No rule asks about it. |
| title-block-people | 1 (holdout) | The manual job joined two affiliation lines; nothing in the sheet asks for that. |
| contributor-bio | 1 structure, 1 reading (front matter) | The notes on contributors have no role; out of scope. |
| front-matter-to-supply | 1 (front matter) | The cover image is on the To-dos list as a requirement to supply, with its guideline sentence, but not as a comment, so the anchor rule counts it missed. |
| reading class | 12 | No model check reads prose this round. |
| human class | 1 | Not imitated, by design. |

### Extra findings by kind (all chapters, gold roles, hand sheet)

| Kind | Places | Judgment |
|---|---|---|
| quotation-lines-joined | 4 (dev) | Real: the other joined quotations of the same chapter; the reference's comment names three of them in its text. |
| chapter-title | 6 (3 dev, 3 holdout) | Real but redundant: titles the formatter split at their colon, which the manual job split without a comment. Each split is now also a tracked change, so the comment asks a second time for the same decision. |
| abstract-length | 3 (1 dev, 2 holdout) | Real: abstracts of 242 to 262 words where the guidelines ask for about 200. |
| keywords-form | 2 (1 dev, 1 holdout) | Real: 12 keywords and 4 keywords where the guidelines ask for 6 to 10. |
| repeated-author-dash | 2 (1 dev, 1 holdout) | Real: the chapters the reference's own dash comment names in its text, which it anchored once. |

No extra finding was noise. The reference makes one comment where the tool makes one per place, and
it leaves silent what it changed silently; most extras are those two habits.

### Companion documents (gold roles, hand sheet)

| Document | Produced | Against the reference |
|---|---|---|
| Abstracts and keywords | yes | Same 12 chapters; abstracts present for the same 11; a marked gap for the chapter without one. |
| Alt texts (template) | yes | 7 figures, all in the same chapter, as in the reference. Each caption is marked as still to write: the captions are in notes attached to the old markers, which the reference moved by hand. |
| Running titles | yes, with proposals | Same 12 chapters. Without the model: the main title where it fits 60 characters (11) and a blank (1). With the model: first request without lengths, 8 of 12 fit and 4 were too long; with each title's length in the request, 12 of 12 fit after one call. 5 of the 12 are the reference's own proposals; on average they share 55% of the reference proposal's words. |
| Checklist | yes | 21 requirements of the hand sheet (the reference lists 26, from the editor's list and the guide's checklist): 14 flagged, 4 to supply, 2 done by the tool, 1 not checked. With this round's extracted sheet: 134 requirements, most of them to supply or not checked. |

### What round 4 should do

- The reading class, 12 comments: a model check per chapter over its title block, abstract and
  keywords (and the notes on contributors once they have a role) for the same thing named two ways,
  an affiliation that differs between two places, missing spaces and typing slips, each finding
  guarded by a quotation that must occur in the paragraph.
- Front matter roles (contents entry, contributor note, part title), so the manuscript's own contents
  list can be compared with the chapters and the bios with the title blocks: 4 structure comments.
- A slot for a clean manuscript (stray fragments, a paragraph repeated, highlighting left in), so the
  3 structure comments of that kind have a rule to run on.
- Make the extraction's slot filling stable: a second, short pass that asks only which slot each
  extracted rule sets, or a vote of two runs; measure it on the same guidelines first.
- Leave out the title-split comment where the split is a tracked change, or fold it into the summary.
- Propose moving a caption from the note attached to an old marker into the caption line, as a
  tracked change.
- A second manuscript, ideally one whose source uses styles, before any of this is called general.

Spent in this round: $0.088 (three extractions of the guidelines, $0.087, one of them with round 2's
code to separate noise from the new slots; two running-title calls, $0.0008). Every answer is
cached in the case's `work/` folder.

## Round 4: the page, and two reliability fixes

The stage: everything rounds 1 to 3 built as library code is now reachable from the Formatter page,
and two problems the measurements exposed are fixed first.

### A part that runs out of output room

A rules call that ended with `model_output_limit` lost that part of the guidelines (one publisher's
guide fell from 27 to 15 of 30 expected requirements on such a run). `extractRuleSheet` now splits
the part in two at the paragraph break nearest its middle (`splitInTwo` in `lib/rules/chunk.js`, the
second half starting a little before the cut) and reads each half as its own call; a half that runs
out of room again is recorded as a failure with its half, and nothing is split further. Other
failures are unchanged. An `only` option reads just the parts or halves named, which the page's
"Try again" uses. `labelRoles` does the same for a passage of paragraphs, and leaves a half that
failed again out of its second pass, which would fail the same way. Tests use fake models that run
out of room above a size.

### Making the rule sheet's settings stable

The same guidelines filled between 3 and 9 settings on different runs. Measured with
`npm run generality -- --only brill --repeat 5` (and a private driver of the same functions that kept
each sheet), five runs each, `deepseek-v4.1-flash-1017`:

1. The route's controls are what it intends on this model: temperature 0, thinking off
   (`enable_thinking: false`; no reasoning text in the reply). The code adds no nondeterminism: results
   keep task order whatever finishes first, and the merge is order-stable. A short invented request
   gave the same answer twice. On the full guidelines the answers still vary from run to run: the
   provider is not deterministic at temperature 0, so the variance had to be handled, not removed.
2. The prompt listed each setting by name and allowed values only. Each slot now has a line saying
   when it applies (`SLOT_USES` in `lib/rules/schema.js`), and the prompt says a requirement a slot
   describes takes that slot.
3. Each part is read twice (`READINGS` in `lib/rules/extract.js`): the first reading that read
   everything gives the rules, the other adds only the settings it found with a verified quotation;
   two readings that fill a setting differently become a conflict for the author. A part counts as
   failed only when both readings fail.

Runs filled, of five, per setting (values in brackets; "conflict" means a run held rules that
disagree, which the sheet marks for the author). "First wording" is the slot instruction as first
written, which cost recall on another journal (below); "final" is the code as committed, with the
second wording and two readings.

| Setting | Before (one reading) | First wording, one reading | First wording, two readings | Final |
|---|---|---|---|---|
| headings.case | 5 (title) | 5 | 5 | 5 |
| headings.numbering | 5 (decimal) | 5 | 5 | 5 |
| notes.restart | 5 (chapter) | 5 | 5 | 5 |
| references.repeated-author | 5 (name) | 5 | 5 | 5 |
| titles.quotes | 5 (not allowed) | 5 | 5 | 5 |
| citations.system | 4 (other) | 5 | 5 | 5 |
| figures.files | 4 (separate) | 5 | 5 | 5 |
| notes.titles | 3 (not allowed) | 5 | 5 | 5 |
| figures.numbering | 4 (chapter) | 5 (conflict in 1) | 5 (conflict in 5) | 5 (conflict in 1) |
| figures.markers | 1 | 5 (conflict in 4) | 5 (conflict in 5) | 5 (conflict in 5) |
| chapters.subtitle | 1 (split) | 4 | 5 | 5 |
| keywords.count | 0 | 3 (6 to 10) | 5 | 4 |
| running-title.length | 1 (60) | 4 | 5 | 4 |
| abstract.words | 0 | 3 (200) | 5 | 3 |
| figures.callouts | 4 | 3 | 4 | 3 |
| layout.font | 1 | 4 | 5 (conflict in 1) | 0 |
| spelling.variety | 1 (us) | 1 | 1 | 1 |
| length.words | 0 | 2 (both empty) | 0 | 0 |
| Settings filled in all five runs | 5 | 10 | 15 | 11 |
| Expected rules found | 115/125 | 119/125 | 120/125 | 117/125 |
| Cost of five runs (catalog prices) | $0.144 | $0.147 | $0.257 | $0.287 |

Each setting keeps the same value in every run in which it is filled, apart from the conflicts. The
two figure settings are conflicts because the guidelines state both a by-chapter and a whole-work
figure number and show more than one form of placement marker; the author settles them in step 3
(round 2 met the same disagreement once). The title split, whose absence left the titles unsplit in
round 3's extracted sheet, is filled in all five final runs. It was missing, though, in the
guidelines reading of the end-to-end run below, a sixth run of the final code, which filled 10
settings without the split, the abstract length, the keyword count, the running title or the font.
So the final code fills 11 settings every time against 5 before, and the rest still vary. With two
readings, the Gateway's rate limit refused calls often enough that four parts failed in ten runs
(three in two runs with the first wording, one in the final runs); a part counts as failed only
when both its readings are refused.

The first wording of the slot instruction ("always takes that slot, even when the sentence also says
other things") filled more settings but cost recall elsewhere. Over all 18 guideline cases it found
398 of 438 expected rules. One journal's guidelines fell to 8 and 10 of 17 in two runs, because the
heading levels' typefaces were folded into copies of the headings' capitals setting, which the merge
then removes as duplicates. The prompt now says each requirement is its own rule, and that what a
slot does not capture is a separate rule with no slot, even in the same sentence (that journal: 17
and 16 of 17).

Generality, `npm run generality -- --models deepseek-v4.1-flash-1017`, all 18 cases, final code:
**414 of 438 expected rules (94.5%), no failed call, lowest case 88.2%: PASS**, against the last
recorded 411 (with one failed call; 423 counting that case's re-run). 162 calls, $0.63 at catalog
prices.

### What the page does now

After the three steps of the rule sheet, the Formatter page has:

4. **Manuscript.** One `.docx`, read in the browser with `lib/docx/read.js` and held in the page's
   memory only; a file the reader cannot open gets its plain message. The size is shown in words and
   paragraphs.
5. **What each paragraph is.** "Read the manuscript" states first how many paragraphs go to the model
   in how many passages, then labels them through `/api/roles` with progress and Stop. The review is
   built for a long book: by default it shows only the paragraphs that are not body text or
   bibliography entries (plus any the scholar corrected), grouped by chapter (a chapter starts at a
   title block), paragraphs the model could not label first; each has its first 120 characters, its
   label in plain words in a menu, and its neighbours on demand. A filter shows every paragraph or one
   kind, with counts per kind; above it, a notice says a wrong label is the most damaging mistake the
   tool can make. A correction is saved at once. Paragraphs left unlabelled can be tried again alone.
6. **Format and download.** The formatter, the checks, the comments, the To-dos list and the
   companion documents run in the browser (`web/format/output-state.js`); running titles are asked of
   `/api/running-titles` only when the sheet has a running-title rule. Every file offered has passed
   the structural validator. A summary gives what was changed, with counts, what was flagged by kind,
   what the author still has to supply, and what was not done (settings in conflict, titles that could
   not be proposed). A formatter failure offers nothing and says why; a failed re-run keeps the files
   made before; files made from an older sheet or older labels are marked as out of date.

What the browser keeps (IndexedDB, 24 hours, cleared by Start over), under its own key beside the rule
sheet's: the file's SHA-256, its paragraph count and name, the roles and the corrections by paragraph
index, the failures by index, and, during a run, each answered passage reduced to its roles (keyed by
a hash of the model and the passage). No text of the manuscript is kept, and the file itself never
leaves the page. After a reload or a sign-in, the same file chosen again is recognised by its hash and
not labelled again; a run that was stopped or interrupted resumes without paying for the passages
already answered; another file is said to be another file and is labelled from the start, after a
question. The privacy statement now says what each step sends and what the browser keeps.

The decisions are pure functions tested under Node (`tests/manuscript-page.test.mjs`, 18 tests:
size, labelling plan, saved record holds no word of the manuscript, untrusted restore, same and other
file, corrections, retry merging, review grouping and filters, excerpts and neighbours, downloads
offered, running titles only on a rule, failure and re-run, staleness, summary wording without
jargon). The browser smoke test (mocked API) chooses an invented manuscript written by
`tests/fixtures/make-manuscripts.mjs`, labels it with one deliberate mislabel, corrects it, formats,
downloads each offered file and checks that each is a valid Word file and that the manuscript carries
the expected comments (5), reloads and confirms no labelling call is made and the correction is back,
and chooses another file, which is labelled from the start after a question. All its steps pass, with
no page or console error.

### One real run through the page

`npm run dev` with the key, installed Chrome driven by Playwright as the smoke test does, no mocks,
all six steps on this case: the editor's note and the author guide as guidelines (edited collection),
`source.docx` as the manuscript, no label corrected. Downloads, the rule sheet, the roles the page
kept and two screenshots went to the case's private `work/page-run/` folder.

| Step | What happened | Time |
|---|---|---|
| 2 to 3 | Two guideline files read in the page; 18 rules calls (3 parts, 3 groups, two readings), none failed; 151 rules, 11 left out, no conflict; 10 settings filled (no title split) | 44 s |
| 4 | 79,519 words in 1,460 paragraphs, read in the page | 0.2 s |
| 5 | The plan said 85 passages; 85 roles calls, none failed, none left unlabelled; the review showed 535 paragraphs to check in 13 chapter groups | 280 s |
| 6 | Formatted in the page; no running-title request, because this sheet had no running-title rule; 5 downloads: the formatted manuscript, the To-dos list, abstracts and keywords, the alt-text template and the checklist; summary: 22 comments, 24 To-do items, 63 requirements to supply | 1.0 s |

Every download passed the structural validator. The formatted file has 22 comments, 31 tracked
changes (rejecting them all gives back the source's words exactly), 13 sections each restarting note
numbers, and every note reference (390), link (125), table (4), content control (86) and bookmark (31)
of the source; the word check finds no undeclared change. The only console error was the browser
asking the local server for `/favicon.ico`, which local test mode does not serve.

The page's labels against the hand-set roles: dev 98.2% (structural 251/260, body as structural 1),
holdout 98.5% (217/224, 4), as in round 1 (98.0% and 99.0%). `npm run format-eval -- --roles
work/page-run/roles.json --sheet work/page-run/rule-sheet.json --score "work/page-run/source
(formatted).docx"` first confirmed that the page's file has the same 1,443 paragraphs, text and styles
as the script's own formatting with those roles and that sheet, then measured it:

| Run | Roles, sheet | Dev matched (near) | Dev style agrees | Dev title block | Holdout matched (near) | Holdout style agrees | Holdout title block |
|---|---|---|---|---|---|---|---|
| Round 2, 4p | predicted, hand | 629 (11) | 98.1% | 20/20 | 724 (4) | 99.0% | 26/26 |
| Round 2, 4e | gold, extracted | 622 (3) | 100.0% | 20/20 | 724 (4) | 98.9% | 26/26 |
| Round 4, page | predicted, extracted (both made by the page) | 613 (5) of 644 | 97.9% | 10/11 | 720 (4) of 739 | 99.3% | 22/22 |

Round 3's runs (gold roles, hand sheet) gave 35 comments and 45 tracked changes; the page's run, with
its own roles and its own sheet, gives 22 and 31, because this sheet had no title split (so no split
titles, and the dev title block falls to 10 of 11) and the markers took the author guide's form.
Paid: the reading of the guidelines and the labelling of the whole book, about $0.33 by the Gateway's
estimate.

### What remains

- From earlier rounds: comments that need reading the prose (round 3's reading class, 12 of 39);
  front matter (contents, contributor notes, part titles) has no role, so its 4 structure comments
  and the contents comparison are out of reach; chapter-label lines above titles (12 in this job);
  tables rebuilt from tab-separated lines.
- Slot filling is steadier but not stable: 11 settings every time against 5, while the title split,
  the abstract length, the keyword count and the running-title length still drop out of some
  readings, as the end-to-end run showed. The two figure settings are now a conflict every time on
  these guidelines, which is truthful but leaves numbering and markers unapplied until the author
  chooses.
- Reading each part twice doubles the calls to the Gateway and so meets its rate limit more often:
  in the ten measured runs with two readings, four parts failed because both their readings were
  refused (none in the generality run or the end-to-end run).
- The page's review was exercised with a mocked model and on this book with no corrections; no
  scholar has used it yet. A Word table and a list typed by hand are still labelled as round 1 found.
- The spec deletes the browser's copy when the finished file is downloaded; the page keeps it until
  Start over or 24 hours, as this round's brief asked.

### What round 5 should do

- Make the settings that still drop out reliable by a focused question rather than more readings:
  after the reading, one short call per setting the sheet lacks, asking whether the guidelines say it
  and, if so, for the quotation (the quotation check keeps it safe). Measure on five runs and on the
  18 cases.
- Use the page with a scholar on a real manuscript and change the review where it is slow: the
  default list of 535 paragraphs to check is long for this book.
- Front matter roles and the contents comparison; chapter labels; tables from tabbed lines.
- A model check per chapter for the reading-class comments.
- A second manuscript, ideally one whose source uses styles.

Spent in this round: $1.50 by the Gateway's estimate ($5.74 of the allowance left): the stability
measurements ($0.144, $0.147, $0.257 and $0.287 at catalog prices), two generality runs over the 18
cases ($0.57 and $0.63), small checks on two journals ($0.065) and the end-to-end run. Catalog
prices take no account of the discount on cached input, so they add up to more than the Gateway
billed.

## Round 5: settings by a focused question, and a reading check

### A. Settings that dropped out, without doubling the calls

What changed (`lib/rules/extract.js`, `server/prompts.js`, `lib/calls/backoff.js`, `lib/rules/quote.js`):

- Each part of the guidelines is read once per group of categories, as before round 4. Then, for the
  settings no reading filled, each part is asked once, through `POST /api/settings`, whether it states
  them, with the sentence that does: one call per part listing every missing setting. An answer counts
  only as a setting it was asked for, with its slot and a verified quotation; two parts that state a
  setting differently make a conflict. A failed question is a failure of its own ("settings") group,
  and "Try again" asks only that part, leaving out the settings the sheet already has.
- The settings question says that an approximate figure ("about", "ca.") states the setting, and that
  one sentence may state several settings. Without this the abstract length, given as an approximate
  number in the same sentence as the keyword count, was never reported.
- The quotation check drops a hyphen or dash between two letters, with or without one space after it,
  in the quotation and the guidelines alike. A model retypes a PDF line-break hyphen as "key-words" or
  "key- words", and those quotations had failed; this also fixes a break across a blank line. It is why
  the rules left out fell from 68 to 10 over five runs below.
- A call the Gateway refuses for its rate limit (status 429 or a rate-limit code; never a spent
  allowance) is asked again after 2, 4 and 8 seconds, or after its Retry-After up to 30 seconds, in the
  rules reading, the settings question, the labelling and the reading check. Before, it was asked once
  more at once, and was refused again.

Five runs on the Brill guidelines (`npm run generality -- --only brill --repeat 5`), runs filled of
five, and in brackets where a run held rules that disagree:

| Setting | Round 4 final (two readings) | Round 5, first wording | Round 5 final |
|---|---|---|---|
| chapters.subtitle | 5 | 5 | 5 |
| running-title.length | 4 | 5 | 5 |
| abstract.words | 3 | 3 | 5 |
| keywords.count | 4 | 3 | 5 |
| figures.callouts | 3 | 5 | 5 |
| notes.kind | 0 | 1 | 5 |
| quotes.primary, quotes.punctuation | 0 | 0 | 5 each |
| the eight round 4 also filled every time | 5 each | 5 each | 5 each |
| figures.numbering | 5 (conflict in 1) | 5 (conflict in 1) | 5 (conflict in 1) |
| figures.markers | 5 (conflict in 5) | 5 (conflict in 5) | 5 (conflict in 4) |
| dash.ranges, layout.font | 0 | 1, 0 | 2, 1 |
| **Settings filled in all five runs** | **11** | **13** | **18** |
| Calls per run | 18 | 12 | 12 |
| Failed parts in five runs | 1 (4 in ten runs) | 0 | 0 |
| Calls refused by the Gateway | not counted | 0 | 0 |
| Rules left out (quotation not found), five runs | not recorded | 68 | 10 |
| Expected rules found | 117/125 | 118/125 | 120/125 |
| Cost of five runs (catalog prices) | $0.287 | $0.180 | $0.185 |

"First wording" is the settings question before the two lines on approximate figures and shared
sentences, and before the quotation change. In the final runs the questions filled between 0 and 5
settings a run (the title split and the running title in one run, the abstract length in three).

Generality, `npm run generality -- --models deepseek-v4.1-flash-1017`, all 18 cases, final code:
**417 of 438 expected rules (95.2%) in 110 calls (27 of them settings questions), no failed call, no
call refused**, against round 4's 414 in 162 calls. $0.38 at catalog prices against $0.63. The
script's verdict was **FAIL**: one edited-collection case found 13 of 17 (76.5%), under the 80%
floor for a case. Its misses are plain requirements of the first reading (referees, forms, a
checklist), not settings, and the settings question filled nothing in it. Read four more times it
found 15, 14, 15 and 17 of 17: that case varies by four rules from run to run in the one reading both
rounds share. Nothing was changed for it.

### B. Comments that need reading the prose

What changed (`lib/checks/reading.js`, `POST /api/reading`, step 6 of the page, `todos-eval --reading`):

- For each chapter, one call sends its title block, abstract and keywords, its headings, and its
  running text up to 8,000 characters, with the sheet's rules about the title page, abstract and
  keywords. The model reports only six kinds: the same thing named or spelled two ways, a name or
  affiliation given two ways, missing spaces, typing slips, stray or repeated text, and an abstract or
  keywords against a listed rule. It is told what not to report (style, argument, capitals, quotation
  marks, citation form, lengths and counts, which code checks).
- Model output is not trusted. A finding is kept only when it names a paragraph it was shown and
  quotes words that `findQuote` finds in that paragraph; the two kinds that compare places must quote
  the other place too, and the two quotations must differ. The reader now records where note
  references stand, and the text sent marks them, so that words on either side of a note are not
  reported as run together (a finding that quotes across a note marker as missing spaces is dropped).
- Findings become Word comments and To-dos entries, each beginning "Query from a model's reading of
  the text, for you to check", quoting the place (and the other place), never a change to the text.
- The model keeps its thinking on (low effort). On the dev chapters, with thinking off, it gave 27
  findings, of which 13 were real and 14 were what the prompt excludes (capitals, quotation marks,
  facts from outside the text, ordinary short forms of a name); with thinking on, 13, all real or
  reasonable. Thinking sometimes uses up the output room: such a chapter is read again as two halves,
  each with the chapter's opening.
- On the page the check is an opt-in box in step 6 that states its number of calls (one per chapter)
  and what is sent; the privacy statement says so. The browser smoke test ticks it with a mocked model
  and confirms that the invented quotation is dropped.

Measured against the reference's 12 reading-class comments (gold roles, hand sheet). Of the 12, five
are in the front matter (reported with dev), none in a dev chapter, seven in holdout chapters.

| | Reading comments found | Extra findings | Of the extras, real on my reading |
|---|---|---|---|
| Dev chapters and front matter | 0/5 (all five are in the front matter, which the check does not read) | 13 | 13 (2 of them judgment calls) |
| Holdout, run once, nothing changed after | 3/7 | 17 | 16 (1 doubtful) |
| Whole book, predicted roles and the round 5 extracted sheet | 2/12 | 41 (12 not in the gold-roles run) | of a sample of the 12 new ones, 9 or 10 |

The real extras are what an editor queries: a doubled word, a misspelt or garbled word, a work's
title or a person's name given two ways in the abstract and the text, a stray bracket or slash, a
repeated keyword, missing spaces in an abstract. None is in the reference, which queried such slips
only where they were many. The doubtful ones rest on knowledge from outside the text (a name's usual
spelling) or call an ordinary short form of a name an inconsistency.

Holdout misses: two affiliations that differ from the notes on contributors (the check does not read
those notes, which have no role); one stray symbol that the source uses many times as a typed note
marker, which the model did not report; and one name given two ways that the model did report, but
at the paragraph next to a second finding of the same kind, which the matching counts as one place.

Cost: about $0.01 a chapter at catalog prices, $0.12 to $0.14 for this book.

### C. Front matter: skipped

Not done. The gold roles leave the front matter unlabelled, so measuring contents entries and
contributor notes would mean labelling them by hand first, and the part titles the reference has were
built by the manual job (the source has none). Doing that and the two comparisons well did not fit
this round. Role accuracy was not re-measured, since no role changed.

### The whole book with the final code

| Run | Matched (near) | Style agrees | Title block | Structure comments | Reading comments | Extra places | Validity |
|---|---|---|---|---|---|---|---|
| Gold roles, hand sheet | 1,353 (14) of 1,383 | 99.4% | 46/46 | 18/26 | 3/12 | 42 | valid, 52 comments |
| Predicted roles, round 5 extracted sheet (151 rules) | 1,346 (8) of 1,383 | 98.6% | 46/46 | 17/26 | 2/12 | 53 | valid, 64 comments |

Formatting with gold roles and the hand sheet is unchanged from rounds 2 to 4 (dev 629 (10) and 100.0%,
holdout 724 (4) and 98.9%; 45 tracked changes; no undeclared word change). With predicted roles and
the round 5 sheet the title split is now in the sheet, so titles are split and the dev title block is
20/20 (round 4's page run: 10/11); the figure markers are still a conflict, so they are not rewritten
(16 tracked changes, all rejected give back the source's words). The structure comments are round 3's
(18 of 26 with gold roles); the extra places grew from 17 to 42 by the reading check's findings.

### What remains

- The reading check reads only chapters. Four of the five front-matter reading comments, and the two
  affiliation comments in holdout chapters, need the contents list and the notes on contributors,
  which have no role (C).
- One reading of the guidelines still varies by several requirements from run to run on some cases
  (13 to 17 of 17 on one); the generality verdict failed on that variance this round.
- The figure numbering and marker settings are a conflict on these guidelines in most runs, so the
  author must choose before markers are rewritten.
- The reading check's extras are mostly real, but a scholar sees 2 to 3 per chapter that the
  reference left unsaid; whether that is welcome is untested with a scholar.
- The check reads 8,000 characters of each chapter's running text; slips later in a chapter are not
  looked for.

### What round 6 should do

- Front matter roles (contents entry, contributor note, part title), labelled by hand in the gold
  first, then the contents comparison and the contributor notes against the title blocks, and the
  notes on contributors added to the reading check's units.
- The first reading's run-to-run variance on plain requirements: measure the low case ten times, then
  try a focused question for the requirements of a category a reading left empty, as this round did
  for settings.
- Read the reading check's extras with a scholar on the page, and decide whether slips (typing,
  spacing) should be grouped into one comment per chapter.
- A second manuscript, ideally one whose source uses styles.

Spent in this round: $0.73 by the Gateway's estimate ($5.69 to $4.96 of the allowance left): three
five-run measurements on the Brill guidelines and small probes of the settings question ($0.41 at
catalog prices), the 18-case generality run ($0.38), four repeats of the low case ($0.03), and the
reading check on dev, holdout and the whole book with predicted roles ($0.34). Catalog prices take no
account of the discount on cached input, so they add up to more than the Gateway billed. Every answer
of the reading check is cached in the case's `work/` folder.

## Round 6: the front matter, sentences a reading leaves out, the reading check on the page

### A. Front matter

**The gold.** The round 5 gold labelled the chapters only. Before any measurement this round, the
non-empty paragraphs outside them were labelled by hand in the private gold, from the styles the
hand-formatted reference gives the same text: 57 paragraphs in two spans recorded as `matter` (the
book's title page and its old contents list before the introduction; a list of abbreviations and the
notes on contributors between the introduction and the first chapter). No existing label changed. A
line of underscores in the contents list, which the reference dropped, is left without a label, as
the gold leaves other stray lines; the reference's two part-title pages have no source paragraph and
are not gold. Four of the answer key's front-matter comments had been anchored on lines of the old
contents list, because the front matter had no roles then; they were moved to the source paragraphs
the reference anchors them on (the abbreviations heading, the notes heading, two notes), also before
any measurement. The hand sheet gained the three rules the manual job relied on for its
front-matter comments, each quoting the editor's checklist: a contents list, notes on contributors
of about 100 words, and names kept the same across the contents, the notes and the chapters' first
pages (24 rules).

**What changed** (`lib/roles/roles.js`, `server/prompts.js`, `lib/format/`, `lib/checks/front.js`,
`lib/checks/reading.js`, the review in `web/format/manuscript-state.js`):

- Five roles: `title-page` (a book's own title page), `front-matter-heading` (Contents,
  Abbreviations, Notes on Contributors and the like), `contents-entry` (one line of a typed contents
  list, a part's name in it included), `contributor-note` and `part-title` (a part title standing
  in the text; a source can carry one, though this one does not). They belong to no chapter: a
  chapter ends before them, and what follows a matter heading (a list of abbreviations) is in no
  chapter until the next title block. The labelling prompt says that front and back matter belong to
  no chapter wherever they stand and that their headings are never section headings.
- The formatter gives them styles of their own (`Book Title`, `Book Subtitle`, `Book Author`,
  `Book Affiliation` from the title page's parts, `Front Matter Heading`, `Contents Entry`,
  `Contributor Note`, `Part Title` on a new page), and removes spacer paragraphs from the start of the
  front matter. The review groups the matter after a chapter under "Front or back matter", and its
  menu has the five roles in plain words.
- The title block's affiliation words now include the Spanish and Portuguese words for university
  (an affiliation line in Spanish had been read as an author's name).
- A setting for the length of a note on a contributor (`contributors.words`).
- Two checks. The contents list against the chapters: each chapter's title and authors are matched
  to the list's lines (a title wrapped onto a second line, an author line before or in the same line
  as the title), and each difference is reported, once in a comment on the list and again at the
  chapter: words of the title that differ (or "another title" when more than six do), an author the
  entry leaves out, authors in another order, words beside the names the title page lacks (an
  affiliation spelled otherwise), a chapter the list leaves out, a line that matches nothing in the
  text, a section heading listed in other words. The notes on contributors against the chapters'
  authors: notes are matched to authors by their opening words, compared letter by letter however a
  name is spaced; an author with no note, a note on no author, a name spelled a letter or two apart,
  an affiliation of the title page that the author's note does not name, and a note under half or
  over one and a half times the length asked. Each runs only with a rule on the front matter, the
  contributors or consistency, and names it.
- The reading check reads each chapter with the notes on its authors after its opening, and the
  title page, contents list, matter headings and any note no chapter took as one more unit. A model
  query of the same kind at the same paragraph as a code check's finding is left out.

**Role accuracy** (`npm run roles-eval`, each chapter with ten paragraphs before it, the matter
spans with dev):

| | Round 1 (run 6 configuration) | Round 6 |
|---|---|---|
| Dev, old roles | 98.0% (250/260 structural, 1 body as structural) | 98.0% (250/260, 1) |
| Holdout, old roles (run once) | 99.0% (221/224, 4) | 99.0% (221/224, 4) |
| Front matter, new labels | not labelled | 57/57 (title page 6/6, matter headings 3/3, contents entries 27/27, notes 14/14, abbreviation lines 7/7) |

The dev confusions are round 1's thirteen, in the same places (prose quotations pasted line by line
read as verse, 8; short bibliography lines read as headings, 2; and three single ones).

**Comments** (gold roles, the hand sheet of 24 rules, the reading check on; front matter reported
with dev, as before):

| | Round 5 | Round 6 |
|---|---|---|
| Structure, dev chapters and front matter | 11/16 (10/12 and 1/4) | 14/16 (11/12 and 3/4) |
| Structure, holdout | 7/10 | 7/10 |
| Structure, all | 18/26 | 21/26 |
| Reading, dev chapters and front matter | 0/5 | 2/5 |
| Reading, holdout | 3/7 | 5/7 |
| Reading, all | 3/12 | 8/12 by the script, 7/12 strictly (2/5 and 5/7; the eighth match is explained below) |

The holdout chapters were labelled once and their reading check run once, with nothing changed
after. The holdout confusions are round 1's seven, in the same places. Formatting is unchanged:
dev 629 (10 near) with 100.0% style agreement and 20/20 title-block paragraphs, holdout 724 (4) with
98.9% and 26/26, 45 tracked changes, no undeclared word change, valid; with this round's labels and
the hand sheet, all chapters 1,353 (15 near) of 1,383 and 98.7%.

What the new checks found that the key has: the contents comment on the old list, the chapter whose
contents entry gives its authors in another order, the one-sentence note on a contributor, the
editors who have no note (the reading-class comment on the notes), and the two affiliations of a
title page that the authors' notes do not give (two reading-class comments, now found by code).
The reading check found the typing slip in a note, two names or titles given two ways and the
missing spaces in a keywords line. "8 of 12" counts one match that is not real: the key's comment on
a part title has no paragraph, so the matching takes any front-matter finding of its kind, and a
query about a university spelled two ways in one note took it. Strictly, 7 of 12.

Still missed: in structure, the two stray or repeated passages and the highlighting (no rule asks
for a clean manuscript), the two affiliation lines the manual job joined, and the cover image (on
the To-dos list as a requirement to supply, not as a comment); in reading, the book's subtitle
against the names of its parts (one prompt line asking for it was tried on dev, found nothing more
and was taken out), the abbreviations list that belongs to one chapter, a stray symbol used as a
typed note marker, and one name given two ways that the model did not report.

Extra places: 61, against 42 in round 5. The code checks' extras are the per-chapter contents
comments (8: each chapter whose entry in the old list differs, all real; the reference lists them
in its one comment on the list), a name spelled a letter apart in a note and a note half again as
long as asked (both real). The reading check kept 44 queries in 13 calls (2 chapters' answers ran
out of room even in halves; their halves that answered are kept): 5 match the key and 39 are extra,
of which 37 are real on my reading (a doubled word, a name misspelled, a missing space, an unmatched
bracket, a year in the wrong place); the two doubtful ones are a comma a copyeditor might leave and
a plural. Four of the front-matter extras are slips in the old contents list that the contents
comparison also reports, in other words.

With this round's labels and the round 5 extracted sheet (code checks only): structure 20/26,
reading 3/12. The extracted sheet has no note length, so the one-sentence note is not found.

### B. Requirements one reading leaves out

**Why.** `npm run generality` can now record every answer with its request (`--record`) and score
again from a recording (`--replay`; with both, only what the recording does not hold is asked).
Five runs each of the edited-collection case that fell to 13 of 17 in round 5 (one part of 12,000
characters), of a monograph guide of 23,000 characters in one part, and of an article style sheet
of 36,000 characters in one part, with the round 5 code:

| Case | Expected found, five runs | Rules per reading of the largest group | Output tokens of that reading (cap 6,000) |
|---|---|---|---|
| Edited collection, 17 expected | 16, 17, 15, 17, 16 (81/85) | 28 to 33 | 1,616 to 2,000 |
| Monograph, 30 expected | 30 every time (150/150) | 67 to 73 | 4,313 to 4,788 |
| Article style sheet, 30 expected | 30, 30, 29, 30, 30 (149/150) | 35 to 67 | 2,368 to 4,592 |

Every case is a single part, so no requirement fell at a part boundary, and no reading ran out of
output room: every reply ended normally, well under its cap. Each miss is a plain sentence that the
reading of its group did not report at all, and which sentences go unreported changes from run to
run: the readings stop early on a long list. Cutting each part's sentences out (`lib/rules/coverage.js`:
paragraphs, list items at their bullets, sentences), keeping those whose wording asks something
(a word of obligation or an opening imperative) and checking each against every quotation the
part's readings gave: in all fifteen runs every missed requirement was among the sentences no
quotation covered. Those were 14 to 19 of 40 such sentences on the edited collection, 15 to 20 of 97
on the monograph (whose readings missed nothing) and 11 to 19 of 62 on the style sheet (19 in the
run that missed a rule).

**What changed** (`lib/rules/extract.js`, `lib/rules/coverage.js`, `server/prompts.js`,
`POST /api/settings`):

- After the readings, a part whose uncovered requirement sentences are at least a quarter of its
  requirement sentences (and at least three) is asked once more, through the settings route, about
  those sentences only (at most 30, 6,000 characters): the answer gives a verdict on each, and a
  sentence it says asks something of the author becomes a rule whose quotation is the sentence
  itself, with the category and statement the answer gives, never a setting or a fix. A failed question is a failure of its own group
  and "Try again" asks the same sentences.
- The settings question is as in round 5. The first wording put the sentences into it: the model
  then answered with an empty list in four runs of five on the edited collection (74 of 85), and on
  the style sheet filled every setting it was asked about with a stray quotation in two runs, so it
  became a question of its own.
- The verdict counts an example (a sample citation or sentence) as asking nothing; before that line,
  examples on the style sheet were turned into 20 rules in five runs, after it 13.

**Before and after** (five runs each; "after" reuses recorded readings, so the comparison is on the
same readings with and without the new question):

| Case | Before (round 5 code) | After, same readings without the question | After |
|---|---|---|---|
| Edited collection | 81/85 (lowest 15) | 73/85 (readings of the first try) | 83/85 (16, 17, 16, 17, 17) |
| Article style sheet | 149/150 | 149/150 (the before readings) | 150/150 |
| Monograph | 150/150 | 150/150 | 150/150, no question asked |

On the edited collection the question was asked in all five runs and gave 9 to 19 rules a run; on
the style sheet in two runs of five (6 and 7 rules); on the monograph never. Of the rules it adds,
about two thirds on my reading of a sample are real requirements; the rest are advice (a suggestion to
consider something, an option) that the verdict counts as asking.

**The 18 cases**, `npm run generality -- --models deepseek-v4.1-flash-1017`, fresh, final code:

| | Round 5 | Round 6 |
|---|---|---|
| Expected rules found | 417/438 (95.2%) | **424/438 (96.8%)** |
| Calls | 110 (27 settings questions) | **129** (27 settings questions, 19 sentence questions) |
| Lowest case | 76.5% (the edited collection above) | **70.0%** (another edited collection, 7 of 10) |
| Failed or refused calls | 0 | 0 |
| Cost at catalog prices | $0.38 | $0.43 |
| Verdict | FAIL | **FAIL** |

The total and the calls meet the bar; the floor for a case does not. The case under it is the
shortest edited-collection guide (5,400 characters, 10 expected): its readings gave 7 rules and the
sentence question 9 more, but the three it missed are items of bulleted lists under lead-ins that ask
something (a sentence ending in a colon that says what the editor is responsible for, or what a
chapter should include): noun phrases with no word of obligation, which the coverage code does not count as requirement sentences, so they were
never asked about. A rule that makes such items inherit their lead-in was written after the run and
checked offline against that run's recording (two of the three would have been asked); it was not
measured and is not in the code. The edited collection of the brief found 16 of 17 and the Brill
guidelines 25 of 25, with 19 settings (round 5's 18 and the new note length).

### C. The reading check through the page

`npm run dev` with the key, installed Chrome driven by Playwright (a private driver adapted from the
smoke test), no mocks: the editor's note and the author guide as guidelines (edited collection),
`source.docx` as the manuscript, the reading check ticked. To stay inside this round's allowance,
the labels were not paid for a second time: the private driver put this round's labelling of the
whole book (the `roles-eval` runs above, the same labelling code) into the browser's store as the
page keeps it, and the page restored them when the file was chosen ("This is the file labelled
before"), as it does after a reload. Downloads and the page's record went to the case's private
`work/page-run-6/`.

| Step | What happened | Time |
|---|---|---|
| 2 to 3 | 9 rules calls and 5 settings-route calls (3 settings questions, 2 sentence questions), none failed; 190 rules, 2 left out, one setting in conflict (the figure marker); 21 settings | 52 s |
| 4 to 5 | 79,519 words in 1,460 paragraphs; labels restored, 14 review groups | 0 s |
| 6 | The plan said 13 calls (12 chapters and the front matter); 21 reading calls, 6 of them answers that ran out of room (each such unit read again in halves), 1 unit still without an answer; then 1 running-titles call; 6 downloads | 400 s |

Every download passed the structural validator. The formatted file has 76 comments, 50 of them the
reading check's queries, each beginning "Query from a model's reading of the text"; the To-dos list
has the same 50 entries; 45 tracked changes, 14 sections each restarting note numbers, 390 note
references. `npm run format-eval -- --score` confirmed that the page's file has the same paragraphs,
text and styles as the script's own formatting with those labels and that sheet, and measured it:
1,346 (8 near) of 1,383 matched, 98.7% style agreement, 46/46 title block, no undeclared word change.

No call was refused by the Gateway, so the rate-limit backoff was not exercised on the page this
time (it is covered by the unit tests). The console's errors were the missing favicon and the six
502 answers that ran out of room. Two wordings were wrong and are fixed: the summary said the check
"read the opening of 13 chapters" (it is 12 and the front matter) and blamed an unanswered unit on
the model service, where the answer had run out of room; and it counted 52 queries where 2 had been
left out as the same as a code check's finding (50 in the file).

### What remains

- The 18-case floor: one short edited-collection guide at 7 of 10, its misses list items under a
  lead-in that the coverage code does not see as requirements.
- The sentence question adds rules of which about a third are advice the verdict counts as asking;
  a scholar sees them in step 3.
- The reading check's answers run out of room on some chapters with thinking on (2 of 13 units
  unanswered in the gold run, 1 in the page run, after halves).
- The book's subtitle against its part names, an abbreviations list that serves one chapter, stray
  passages and highlighting (no rule asks for a clean manuscript), joined affiliation lines.
- Part titles: the role exists but no source here has one, so it is untested on a real manuscript.
- The page's labelling with the new roles was not run through the page this round (measured with
  `roles-eval` instead).
- A second manuscript, ideally one whose source uses styles.

### What round 7 should do

- Count a list item under a lead-in that asks something as a requirement sentence, asked with its
  lead-in (written and checked offline this round), and measure the 18 cases again.
- Tighten the sentence verdict on advice and options, measured by sampling the rules it adds, not
  only by recall.
- Give the reading check more output room, or smaller halves, where thinking uses it up.
- Run the page's own labelling of the whole book with the new roles, and read the review's front
  matter group with a scholar.
- A second manuscript.

Spent in this round: $1.20 by the Gateway's estimate ($4.90 to $3.70 of the allowance left): five
readings each of three guideline cases before ($0.24 at catalog prices), the after measurements
(three tries, mostly replayed from recordings, $0.24), the labelling of dev and front matter and of
the holdout ($0.24), the reading check on dev (twice, the second for a prompt line taken out again)
and holdout ($0.21), the 18-case run ($0.43) and the page run (about $0.24 by the Gateway's
estimate). Every answer is recorded or cached in the case's `work/` folder (`roles-answers.json`,
`reading-answers.json`, `generality-r6/`).

## Round 7: list items under a lead-in, room for the reading check

### A. Requirements in bulleted lists under a lead-in

**Why.** Round 6's lowest case (7 of 10) missed three items of bulleted lists: bare noun phrases
under a lead-in that asks something (a sentence ending in a colon that says what the editor is
responsible for, or what a chapter should include). The coverage code did not count such items as
requirement sentences, so the sentence question never asked about them.

**What changed** (`lib/rules/coverage.js`, `server/prompts.js`):

- `sentenceEntries` gives each sentence of a bulleted item the sentence ending in a colon just
  before its list (in the same paragraph or the one before), as its lead-in; a sentence that does
  not end in a colon ends the list's lead-in.
- An item counts as a requirement sentence when its own words ask something, as before, or when its
  lead-in asks something (the same words of obligation and imperatives, and also "responsible for")
  and the item, without its bullet, has at least 12 characters, the shortest quotation the
  guidelines' check accepts.
- Coverage compares a sentence without its bullet, and a text shorter than 25 characters (a short
  item) is covered only by a quotation that holds all of it, not by a few shared characters.
- The sentence question shows each item under a lead-in that asks with that lead-in, which the
  Worker finds in the part's own text, so the route's request is unchanged; the prompt says an item
  is read with the sentence introducing its list. A verdict on an item quotes the item itself.
- The verdict now also counts as asking nothing a suggestion left to the author's choice (what the
  author may wish to, might or could do, or may consider) and a sentence that only says where more
  information or help is found.

**Offline, on round 6's recordings** (the readings replayed, the sentences the new code would ask
computed, no call): the lowest case's question grew from 14 to 28 sentences and held all three of its
misses; no other case's question changed by more than a few sentences, the same parts would be
asked, and in one part two sentences asked in round 6 (neither an expected requirement) fell past
the 30-sentence cap. Tests use invented text:
lead-ins across a blank line and in the same paragraph, a lead-in that asks nothing, an item too
short to quote, a short item that shares only its last words with a quotation, the message that
shows an item with its lead-in, and an extraction in which an item becomes a rule quoting itself.

**The 18 cases**, `npm run generality -- --models deepseek-v4.1-flash-1017`, fresh, final code, run
once:

| | Round 6 | Round 7 |
|---|---|---|
| Expected rules found | 424/438 (96.8%) | **421/438 (96.1%)** |
| Calls | 129 (27 settings questions, 19 sentence questions) | **128** (27 settings questions, 18 sentence questions) |
| Lowest case | 70.0% (the short edited-collection guide, 7 of 10) | **88.9%** (an article guide, 16 of 18) |
| The short edited-collection guide | 7/10 | **10/10** (27 sentences asked, 23 rules from them) |
| Failed or refused calls | 0 | 0 |
| Cost at catalog prices | $0.43 | $0.43 |
| Verdict | FAIL | **PASS** |

The floor is met and the calls are within the bar; the total is three under round 6's 424, so that
target is missed. The case the change was for found all ten, and one other edited collection and
the article guide each found one more. Six cases found one or two fewer, and the losses are not the
change's, on the run's own recording: no sentence the round 6 code would have asked was pushed past
the cap by the new items, and the two misses that went to the question got the same verdict ("asks
nothing") as in round 6, on sentences that state a policy rather than a request. The rest are the
readings' variance: in one edited-collection guide the readings quoted enough this time that no
sentence question was asked, and it found two fewer; in the other cases the missed sentence
overlapped a reading's quotation without the expected words reaching a kept rule, or was past the
cap of a part with 55 to 141 uncovered sentences, as before.

Advice: of the sentences the verdict said ask something, 41 of 277 (15%) in round 6 and 25 of 232
(11%) in round 7 hold a word of suggestion or a pointer (may wish, could, consider, refer to, for
more information, contact, recommend). That is a word count, not a reading: round 6's estimate of a
third was a sample read by the agent, and this round's rules were not read the same way. Some
advice still passes (a suggestion to consider colour, a reminder to stay in touch with contributors).

### B. The reading check runs out of output room

**Why it ran out.** The cached answers are short: at most about 3,600 characters (about a thousand
tokens) on the 63 answers of three prompts. What fills the 10,000-token cap is the thinking before
them. Units that ran out were 8,400 to 14,000 characters, the same range as units that answered, and
halves ran out too, so smaller units would not have removed it; the findings cap (12) does not
touch the thinking either, and this model on Workers AI has no thinking budget finer than "low",
which it already had. In round 6's page run a call that ran out took 61 to 65 seconds, about 160
tokens a second.

**What changed** (`server/model.js`, `server/prompts.js`): the reading call's hard cap is 20,000
tokens (`READING_MAX_TOKENS`), still held under half the context window and under the catalog's
output limit when a row gives one (the catalog gives none for this model). At the measured speed a
call that uses it all takes about two minutes, inside the three-minute deadline. Other calls are
unchanged. `todos-eval` now records the cap an answer ran out at, so a larger cap asks only those
units again and keeps every cached answer that finished (the cap changes nothing before it is
reached).

**Verified** with `npm run todos-eval -- --reading all --chapters all` (gold roles, hand sheet): 2
calls made, for the two chapters that had run out whole, 11 answers from the cache; both answered
(about 21,000 output tokens for the two, so at least one needed more than the old cap). 13 of 13
units answered, against 11 in round 6. Reading comments found: 8 of 12 by the script (2 of 5 dev and
front matter strictly, 5 of 7 holdout), unchanged; structure 21 of 26, unchanged. Queries kept: 47
(44 in round 6), 2 dropped as unverified. Cost $0.028 at catalog prices.

### C. Labelling through the page: skipped

Not done. A full labelling of the book through `npm run dev` (85 calls with thinking on, about $0.24
at catalog prices in round 6) and the guidelines on the page did not fit what was left of this
round's $0.65 after A and B ($0.19). The page's labelling with the front-matter roles is still
measured only by `roles-eval` (round 6).

### D. Where things stand

Added at the top of this file.

### What remains

- The guideline reading varies by several requirements between runs in the readings themselves
  (421 and 424 on the same 18 cases with nearly the same code); the 30-sentence cap leaves
  uncovered sentences of long parts unasked.
- Two verdicts say "asks nothing" of sentences that state a policy the author must keep (one
  submission at a time; who may be an author).
- The items a lead-in introduces are now asked, but the advice share of the sentence question's
  rules has only been counted by words, not read.
- The page's labelling with the new roles, a scholar using the review, the formatted file in Word.
- The sign-in loop guard and eager deletion of saved work before deployment.

### What round 8 should do

- Before deployment: the once-per-page sign-in guard, and deleting saved work after 24 hours
  without waiting for the page to be opened.
- Ask the uncovered sentences of a long part in more than one question, or order them by how
  strongly they ask, instead of the first 30 in the text.
- Label the book through the page, and put the page, the review and the Word file in front of a
  person.
- A second manuscript.

Spent in this round: $0.46 at catalog prices: the 18-case run ($0.428) and the two reading calls
($0.028); by the Gateway's estimate, $0.29 ($3.70 to $3.41 of the allowance left; its estimate lags the
calls and counts cached input cheaper). Every answer is
recorded in the case's private `work/` folder (`generality-r7/`, `reading-answers.json`).


## Round 8: how the file looks

Rounds 1 to 7 scored the formatted file against the hand-formatted reference by style name per
paragraph (99%). Nobody had compared how the two files look. The stakeholder opened both in Word,
exported PDFs and listed eleven differences from about six pages each. This round measures
appearance, closes the gaps the rule sheet or general tidiness justify, and records the rest.
No model was called.

### A. The rendered comparison

`scripts/render-eval.mjs` with `lib/docx/appearance.js` (see the README) resolves each paragraph's
effective formatting through the document defaults and theme fonts, the style chain, numbering and
direct formatting, matches the two files' paragraphs by text, and reports agreement per property
(dev, holdout and front matter apart; a paragraph's chapter comes from the source paragraph it came
from), difference classes with counts, the notes, each file's sections (page, margins, note
numbering, page-number position on a section's first and other pages, and its font), the Latin text
set in a font other than the body's, and, from PDFs, page counts and characters per font (MuPDF).
Six tests on an invented package. Its first run, on round 6's page output, gave the scale of each
difference:

| Difference (round 6's page output against the reference) | Count |
|---|---|
| Body line spacing 2 against 1.5 | 473 paragraphs |
| Other styles single-spaced against 1.15 or 1.25 (bibliography, verse, quotations, headings, title blocks) | about 860 paragraphs |
| First-line indent of the body 0.75 cm against 1 cm | 326 paragraphs |
| Latin text in a font other than the body's | 3,704 characters in the text, 3,130 in the notes |
| Page number top right in the defaults' sans-serif font at 10 pt, missing on the first page of 8 of 14 sections, against bottom centre in the body font | every section |
| Margins: three page setups in one file against one | 13 of 14 sections differ |
| Word pages | 240 against 224 |

Where the stray fonts came from: not the theme. The source (a word processor's export) set fonts on
runs: Latin text in an East Asian font in one chapter and its notes (85 runs, with an East Asian hint
that also took the quotation marks), two sans-serif fonts (about 210 runs, many of them empty lines
in notes), Aptos (14 runs in notes) and two more; and its document defaults name a sans-serif font,
which the headers' page number used.

### B. The gaps, and what was done

Classes as the brief defines them: (a) a rule-sheet setting, (b) a tidy-up right for any publisher,
(c) consistency within the manuscript, (d) a choice of the hand job that no rule supports. The
publisher's author guide and the editor's note were searched for line spacing, page numbers,
margins, fonts, chapter labels and contents: the guide's checklist asks for a contents list that
gives the order of the chapters, and for Unicode fonts; neither document says anything of line
spacing, page-number position, margins or chapter labels. No cached extracted sheet sets those
either. The hand sheet was not changed.

| # | Gap | Class | What was done | Before -> after (gold roles, hand sheet) |
|---|---|---|---|---|
| 1 | Body line spacing | (a), unset for this publisher; the 1.5 is (d) | `layout.spacing` was already applied when set; unset here, so the manuscript keeps its double spacing, and the summary comment now says which layout the sheet leaves to the source | line-spacing agreement 0% -> 0% |
| 2 | Page numbers | (a) new slot `layout.page-numbers`, unset here; (b) for the rest | With the slot set, every section shows the number where it says (headers and footers that hold other text are left to the author). Unset: the source's top-right numbers stay, but sections the formatter adds at chapter starts no longer copy a different first page that hid the number (5 sections), and the number takes the body font | position agrees in 0/12 chapters -> 0/12; first pages without a number 8 sections -> 3 (the source's own) |
| 3 | Chapter label | (a) new slot `chapters.label`, unset here; the reference's labels are (d) | A numbered chapter without a label gets one in the example's form when the slot is set; none added here | unmatched label lines 12 -> 12 |
| 4 | Brackets around an affiliation | (b) | Removed as tracked deletions | 12 lines, 24 deletions |
| 5 | Two authors on one line | (c), ambiguous | The reference keeps both names on one line too; what it changed is the word between them. The four multi-author lines join names three different ways (a comma twice, "and" once, an ampersand once), with no majority, so a new check (on a consistency rule) comments on each instead of changing them. One name per line is the book's title page (item 6) | 4 comments, counted as extra places by `todos-eval` |
| 6 | The book's title page | (b) | The title's final colon goes; a subtitle broken over two lines is joined; an "Edited by" line is read as a label; each "Name, Institution" line is split into an author and an affiliation line | front-matter paragraphs matched by text 8 -> 13 |
| 7 | Contents list | (a), a requirement of the guide | Not rebuilt: the typed list is kept and round 6's check compares it with the chapters. A list with page numbers needs Word's layout (a TOC field, or page numbers from a render) | unchanged |
| 8 | Bibliography heading typed with two different capitalizations (8 and 4) | (c), with a rule | A heading repeated in every chapter with different capitals is made like the variant that follows the sheet's heading case (title case here), else like most of them; with neither, the author is asked | 8 headings changed, tracked |
| 9 | Quotation marks around title and subtitle together | (b) | An opening mark at the start of the title and its closing mark at the end of the last subtitle go; a title holding its own quotation keeps its marks (a colon inside its closing mark goes, as a colon before a subtitle) | 1 title block |
| 10 | A heading starting with a line break | (b) | Spaces and line breaks at the ends of headings and title lines go, tracked | 16 places; the heading's number back on its line |
| 11 | Aptos and other stray fonts | (b) | Direct Latin fonts other than the body's are removed from runs in the text, notes, headers and footers (symbol, code, other-script and East Asian fonts stay; an East Asian hint goes from runs without East Asian text); the document defaults take the body font | 329 runs; Latin text outside the body font 6,834 -> 0 characters; font agreement 98.4% -> 100% (notes 97.9% -> 100%); in Word's PDF, Aptos and the stray sans-serif and serif fonts are gone, the East Asian font remains only on full-width East Asian punctuation |

Found beyond the list, by paging through both PDFs (front matter, chapter openings, block
quotations, verse, the figures, the table, bibliographies, footnotes, the last pages):

| Gap | Class | What was done |
|---|---|---|
| One chapter types each note's number next to Word's automatic one, so it prints twice, in the text and in the note (63 each) | (b) | A superscript run of digits right after a note mark goes, tracked; a space stays after the mark in a note. The reference removed them in the notes only, so its text still prints them twice |
| A subtitle divided from its title at a colon keeps its lower-case first letter | (b) | Capitalized, tracked (1) |
| A subtitle ends with a full stop | (b) | Removed, tracked (1) |
| Three page setups in one file | (c) | Sections take the page size and margins of most of the text (by paragraphs), unless landscape or set by a margins rule: 6 sections. The reference's 2.54 cm margins are (d) |
| Front matter in the source's order (abbreviations and notes on contributors after the introduction), against the order the editor's note lists | (a) | Not done: no rule or check orders front matter yet |
| One chapter title in sentence case, one in capitals | (a) for section headings only; (d) for chapter titles | The existing check comments on the title in capitals; titles were not retyped |
| The tool's own style values (first-line indent 0.75 cm, block quotations indented both sides, single spacing outside the body) differ from the reference's | (d) both ways | Not changed: neither comes from a rule |
| The old contents list's heading typed in capitals | (c) | Not done |

What the hand job chose that was not copied, and why: 1.5 line spacing, 2.54 cm margins and page
numbers at the bottom centre (no rule states them; the manuscript's own are kept and the summary
says so); chapter and introduction label lines and part title pages (no rule asks for labels; the
slot is there for guidelines that do); a rebuilt contents list with page numbers (needs layout; the
requirement is checked, not built); front matter reordered; "and" between two authors (no majority
in the manuscript, so flagged); chapter titles retyped in title case (the rule is for section
headings); and the hand job's style values (12 pt on Normal, 1 cm indent, 1.15 spacing for the
bibliography and verse).

### C. Measured after

`format-eval` (gold roles, hand sheet, all chapters): matched 1,353 of 1,383 (dev 629, holdout 724),
style agreement 99.4% (dev 100.0%, holdout 98.9%), title block 46/46, all unchanged; near matches 14
-> 55, because the typed note numbers are gone from the text while the reference still prints them;
tracked changes 45 -> 175; no undeclared word change, and rejecting every change gives the source's
words; valid. With round 6's page labels and sheet: 1,346 matched, 98.7%, unchanged.

`todos-eval` (gold roles, hand sheet, no reading check): structure 21/26 and reading 3/12, unchanged;
extra places 27 -> 31, the four comments on the author lines (item 5).

`render-eval`, before and after (matched paragraphs; agreement per property):

| Configuration | Pairs | font | size | line | before | after | left | right | first line | jc |
|---|---|---|---|---|---|---|---|---|---|---|
| Gold roles, hand sheet, before | 1,354 | 98.4% | 98.7% | 0.0% | 97.1% | 96.2% | 97.2% | 95.0% | 73.4% | 98.8% |
| Gold roles, hand sheet, after | 1,359 | 100.0% | 98.7% | 0.0% | 97.0% | 96.2% | 97.2% | 95.0% | 73.5% | 98.8% |
| Dev / holdout after | 622 / 724 | 100 / 100% | 99.4 / 98.5% | 0 / 0% | 99.7 / 95.9% | 99.0 / 94.6% | 96.8 / 97.7% | 94.5 / 95.4% | 76.2 / 70.9% | 99.4 / 98.6% |
| Round 6 page labels and sheet, before (the page's file) | 1,347 | 98.4% | 98.8% | 0.0% | 96.8% | 96.0% | 97.0% | 95.5% | 73.3% | 98.3% |
| Round 6 page labels and sheet, after | 1,352 | 100.0% | 98.8% | 0.0% | 96.7% | 95.9% | 97.0% | 95.5% | 73.4% | 98.3% |
| Notes, before -> after | 384 | 97.9 -> 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

Pages: Word 240 (round 6's page output) and 241 (gold roles, hand sheet, after); reference 224.
LibreOffice: 234 -> 237 for gold roles and hand sheet, 237 for round 6's labels and sheet, reference
223. The pages went up by about three because the sections that had 2 cm bottom margins now share
the setup of most of the text (a 3 cm bottom margin); the gap to the reference is the line spacing.

Word opened the gold-roles output and exported it to PDF; the document showed, with its tracked
changes, and no repair prompt appeared. The first export was asked to write into a folder Word had
not been given access to, and Word stopped on its "Grant File Access" dialog, which the agent's tools
could not answer; the PDF was then saved into a folder Word may write to. The dialog stayed open, so
the second configuration was exported with LibreOffice only. Outputs, PDFs and reports are in the
case's private `work/round-8/`.

Tests: 449 (437 before): six for the resolver and the comparison, twelve for the tidy-ups and
settings on invented manuscripts, and one changed (an affiliation split from its author line now
loses its brackets).

### What remains

- Line spacing, margins and page-number position stay the manuscript's when the guidelines are
  silent. Whether a submission default should apply needs a decision: the design traces every
  applied rule to the guidelines or a named style manual, and the manual baselines are not built.
- The new slots (`chapters.label`, `layout.page-numbers`) are in the extraction prompt but were not
  measured on the 18 guideline cases (that needs paid calls); no sentence of these guidelines fills them.
- The contents list is checked, not rebuilt; front matter is not ordered.
- The tool's own style values are constants, not the source's (the first-line indent is 0.75 cm
  whatever the manuscript used).
- Nobody has gone through the tracked changes in Word.

### What round 9 should do

- Measure the two new slots and `layout.spacing` on the 18 guideline cases with `--repeat`, and see
  which other publishers state line spacing or page numbers.
- Decide on submission defaults (a style-manual baseline, as the design describes, would give them
  with a section reference).
- Build the contents list as a Word TOC field from the chapter titles, and check the front-matter
  order against a rule.
- Take the first-line indent and quotation indents from the source when the sheet is silent.
- Have a person accept and reject the changes in Word on this book, and run a second manuscript.

Spent in this round: nothing. No model was called; every measurement used `gold-roles.json`, round
6's page labels and the cached rule sheets ($3.41 of the allowance left, unchanged).
