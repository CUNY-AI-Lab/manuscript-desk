# The decide step (2026-11-23)

The round that turns the model bake-off's agent spike ([`model-bakeoff.md`](model-bakeoff.md)) into
the product. The owner tried the live beta and said it "returned a million questions" instead of
working on the Word file the way the hand job did. The decide step runs after the pipeline, on by
default: it does the work the guidelines settle, applies defaults where they are silent, and hands
the author only the real decisions. In the same round every call was fixed to one model,
`deepseek-v4.1-flash-1017` (`lib/calls/model.js`): the model menus are gone from both pages.

Everything private (the Brill manuscript, its hand-formatted reference, the hand job's notes and
build spec, the dissertation) stays in the private guidelines folder; this file holds counts only.
"Verified" means measured by `npm run decide-eval` (`scripts/decide-eval.mjs`), which runs the
page's own `buildOutputs`; "inferred" means my reading, said where it applies.

## The answer in short

- On the Brill volume, with the page's own labels and extracted rule sheet, the decide step leaves
  **38 comments** in the file (the pipeline today: 96; the hand job: 39), keeps a comment near **25
  of the hand job's 27 questions** (the target), and hands back a **14-row checklist** (pipeline:
  190 rows; hand job: 26). Verified, two runs, the same counts.
- It does the work the spike did and more: the typed contents list replaced by a contents field
  (28 typed lines deleted), 6 of 6 repeated-author dashes written as the hand job wrote them, 2 of 2
  titles in capitals retyped (and one heading), the duplicated passage and the stray letter
  removed, a list of illustrations of the 7 figures, and the six settings the hand job chose all
  the same (four of them from the new defaults). Verified.
- **No wrong text change is possible**: the model proposed one free text change per run, and the
  guard refused it; every applied change to words is one of the declared mechanical kinds (0
  outside them); no undeclared word change; rejecting every tracked change gives the source's words
  back; every file validates. Verified.
- Cheap and quick: 25 model calls, about $0.025 a run, under a minute of model time with the
  reading check cached. The reading check itself (14 calls, thinking on) takes most of the real
  time; the page now says "about 5 minutes" for this book before it starts (inferred from the
  calls' measured durations, not timed on the page).
- On the held-out dissertation (never tuned on, run once): 14 comments (pipeline 20), a 5-row
  checklist (pipeline 39), 3 queries moved to the copyeditor, no refusal, no mechanical operation
  (none applies there; see below), files valid. No gold for its questions exists.

## How it works

The pipeline runs as before (formatter, checks, reading check). Then (`lib/decide/`):

1. **Code does the mechanical work** (`mechanical.js`), as declared edits that `formatDocx` now
   takes as input and makes after its own changes, on the paragraphs as they then stand (the spike
   lost about five operations a run to paragraphs the formatter had already changed; none was lost
   here). Operations: contents list; repeated-author dashes (when a rule asks for full names);
   capitals to title case (when a rule asks for title case); a passage typed twice in a row (two
   paragraphs or more, or one of 200 characters, word for word); a stray letter on a line of its
   own between two paragraphs of the same running role; a list of illustrations (when a rule asks
   and the file has none).
2. **Defaults where the guidelines are silent** (`defaults.js`), books and articles only: 1.5 line
   spacing, page numbers bottom centre, 2.54 cm margins, chapter labels (books), 1 cm hanging
   indent, 12 pt Times New Roman. A guideline rule on the slot wins; a guideline setting switched off
   as misread lets the default in. Three settling defaults: author separators left as typed, a
   length "about" N tolerating a third either way, web addresses in bibliographies left in full.
3. **The model answers small units** (`units.js`, `loop.js`) through `POST /manuscript/api/decide`
   (`server/decide-prompts.js`), thinking off, the tools passed as OpenAI-style `tools`: one unit
   for the layout settings (switch off a misread one), one per chapter for the reading check's
   queries in running text (copyeditor's or a question; at most two turns of reading, inside the
   chapter only, then decide), forty rules a unit for the triage. The Worker is stateless: the page
   sends each unit's few turns. Brill: 14 units, 25 calls, every unit finished.
4. **Code judges** (`policy.js`, `run.js`): the guards on text, and the disposition of every
   finding: resolved by an applied operation (or a change the formatter declared), settled by a
   stated default, the copyeditor's (only a reading-check slip whose paragraphs are both running
   text), or a question. A query on a title, a name, an affiliation, an abstract, keywords, a contents
   line or a heading is always a question.
5. **What the author gets** (`outputs.js`): the file with one summary comment and one comment per
   decision (questions on neighbouring lines of a title block, an abstract with its keywords, or
   the notes on contributors share one; a check repeated across a chapter, such as highlighting, is
   one comment there), a checklist, "What we did", "Queries for the copyeditor".

## Before and after on the reference book

Verified with `npm run decide-eval -- --runs 2` (pipeline = the page with the decide step unticked
and the reading check on, as before this round; its numbers include the accessibility checks,
which the spike's 75 comments did not). Decide runs 1 and 2 are two separate runs of the model on
the final code; run 2's first pass met one rate-limited unit (40 comments, a unit's rules not
triaged), and with the longer backoff it finished on the second pass: the table gives that pass.

| Measure | Pipeline | Decide, run 1 | Decide, run 2 | Hand job |
|---|---|---|---|---|
| Comments in the file | 96 | 38 | 38 | 39 |
| Hand job's 27 questions with a comment near (same chapter, within two paragraphs with text) | 26 | 25 | 25 | 27 |
| The same, counting question comments only (not the summary or a flag) | | 25 | 25 | |
| Questions put to the author (findings; at places) | 134 To-dos, 71 to supply, 99 not checked | 84 at 32 places | 85 at 33 places | 27 |
| Checklist rows | 190 | 14 | 14 | 26 |
| Copyedit queries moved to "Queries for the copyeditor" | 0 | 14 | 13 | (left to the copyeditor) |
| Text changes outside the declared mechanical kinds | | 0 | 0 | |
| Guard refusals, by kind | | 1 copyediting the text | 1 copyediting the text | |
| Model choices refused (a choice outside the allowed ones) | | 0 | 0 | |
| Undeclared word changes; rejecting all changes gives the source | 0; yes | 0; yes | 0; yes | |
| All files valid | yes | yes | yes | |
| Typed contents list replaced by a field | no | yes (28 typed lines) | yes | yes |
| Repeated-author dashes as the hand job wrote them | 0 of 6 | 6 of 6 | 6 of 6 | 6 |
| Titles in capitals retyped | 0 of 2 | 2 of 2 (and 1 heading) | the same | 2 |
| Hand job's deletions | 0 of 3 | 2 of 3 (the duplicate, the stray letter) | the same | 3 |
| Deletions not in the hand job | | 0 | 0 | |
| List of illustrations | no | yes, 7 figures | yes | yes |
| Settings as the hand job's (6) | 2 | 6 | 6 | 6 |
| Settings switched off as misread | | 1 (the publisher's typeface, only encouraged) | 1 | |
| `render-eval` (LibreOffice): line spacing, left indent, first-line indent agreement | 0.0%, 97.0%, 73.4% | 34.4%, 96.2%, 73.1% | the same | |
| `render-eval`: font, size, alignment | 100%, 98.8%, 98.3% | 100%, 98.9%, 98.3% | the same | |
| `render-eval`: chapters whose page setup (margins, page numbers) agrees | 0 of 12 | 12 of 12 | 12 of 12 | |
| LibreOffice PDF pages (reference 223) | 237 | 213 | 213 | 223 |
| Model calls, cost (catalog prices), model minutes | (reading cached) | 25, $0.025, 0.6 | 25, $0.024, 0.8 | |

The two hand-job questions no comment is near: an item to supply in the front matter that no
check finds, and a stray passage in running text the reading check does not report (the pipeline
alone misses the second too). Counting question comments only, the contents heading's comment is
a flag of the operation, not a question, so that question counts as missed there.

Rules triage, run 1 (186 rules): done 35, settled by a default 6, not applicable 46, for the
copyeditor 20, to hand in 72 (in 9 kinds), decisions 17, of which 13 are rules already asked in
the file's comments (one checklist row) and 4 open choices (an index method, a word-break system,
a book title, a layout request). The checklist is 1 + 4 + 9 rows.

The 0.6 to 0.8 minutes are model time with the reading check cached; on the page the reading check
runs too (14 calls; round 7 measured about a minute each, three at a time), which is why the page
says about 5 minutes for this book (inferred).

### Tuning on this book, and what it showed

The harness was adjusted on this book, so these are dev numbers. In order (all runs in the ledger):

- First run: 54 comments, 25 of 27, checklist 29. The settings unit switched off 9 settings,
  including the abstract length, the keyword count and the title split: the model read "switch
  off the misread ones" as licence. Fixed in code: only layout settings are shown and only they
  may be switched off. Then 36 comments.
- Clustering neighbouring questions (title block, abstract and keywords, notes on contributors)
  and resolving queries on lines of the deleted typed contents list took 54 places to about 32.
- The triage prompt was rewritten once (what the formatting already does; decisions are few). One
  run looked much worse (59-row checklist): seven units had been refused for the Gateway's rate
  limit and their rules defaulted to "decision" and "to hand in". The fix was in the harness:
  six backoff pauses and two units at a time. After it, 14 rows.

## The held-out manuscript

The dissertation `owner-phd` with the built-in Graduate Center set, its labels from the
dissertation loop's round 2 (the structure pass changes none). Run once, after the tuning above;
nothing was changed for it.

| Measure | Pipeline | Decide |
|---|---|---|
| Comments in the file | 20 | 14 |
| Questions (findings; places) | 24 To-dos, 1 to supply, 19 not checked | 20 at 14 places |
| Checklist rows | 39 | 5 |
| Copyedit queries moved | 0 | 3 |
| Operations | | none |
| Defaults applied | | none (a dissertation keeps its built-in set) |
| Refusals; text changes outside the mechanical kinds | | 0; 0 |
| Undeclared word changes; reject gives the source; valid | 0; yes; yes | 0; yes; yes |
| Model calls, cost | 4 reading calls, $0.025 | 3 decide calls, $0.003 |

No gold exists for its questions, so whether the 14 comments are the right ones is not measured.
Nothing alarming: no change was refused or made to words, the files validate. Why no operation
(verified on the labels): the labels give the abstract page's repeated title a title-block role, so
the first "chapter" starts before the contents list, and the contents operation (which works only
on a typed list before the first chapter) does not apply; the list there is also a Word field
already. No rule asks for full names or title case. Three queries on lines of the contents list
stay questions for the same reason. Of the 20 questions, 9 are accessibility findings (pipeline: 10), in fewer comments (one per
check and chapter).

## Operations: built and left out

Built (verified on the reference book or the tests): contents list from the chapters with the
typed one removed; repeated-author dashes; title case where a rule asks; page setup and numbering
per section (defaults, and the formatter's settings); footnotes restarting per chapter where a rule
asks (the formatter's, unchanged); a note on a title or author line, flagged with a proposed "Note
on the text" (not moved); figure numbers per chapter with placement markers where a rule asks (the
formatter's, with the numbering fix below); quotations pasted one line per paragraph rejoined (the
formatter's) and flagged once per chapter; a list of illustrations from the captions; an exact
duplicate removed; a stray letter removed.

Left out: part title pages (the reference book's parts exist only in the typed contents list, so
making them means inserting text; not attempted); a proposed division of a long title (the
comment asks the author to choose; no division is proposed); tables from tabbed lines.

Fixes on the way (verified): the figure finding now numbers the reference book's chapter 5
figures 5.1 to 5.7 (an introduction whose contents line says "Introduction" while its title page
gives only its title is unnumbered); a font rule about the text inside illustrations no longer
becomes the body font (extraction keeps it as a comment, and the decide step does the same for a
sheet read before); declared edits are an input to `formatDocx`.

## Guards, counted and tested

`tests/decide.test.mjs` tests each refusal: a change to a title's words, a title divided, a name,
an affiliation in the notes on contributors, keywords, an abstract, a heading, a reference beyond
its dash, copyediting the running text, words not in the paragraph; and the two allowed cases. A
role change on a title block or title page is refused too. In the runs on the reference book, the
model proposed one free change to running text a run, refused as copyediting and put on the
copyeditor's list; the spike's wrong changes (a title's spelling, a title divided, a keyword list
normalised) did not come up as proposals in these units, and could not have been made.

## Unsure, and not checked

- All tuning was on one book; the held-out dissertation has no gold for its questions and needed
  no operation.
- No person has opened these files in Word, accepted or rejected the tracked changes, or let Word
  update the contents field (LibreOffice headless only, as asked).
- The time the page states is inferred from call durations; the page itself was not timed with
  real calls (the browser smoke test mocks them).
- The triage's "to hand in" is broad (72 rules, grouped into 9 rows) and its "done" is the model's
  reading; neither was checked rule by rule.
- The rate limit: one unit in one pass was refused six times running and stayed undecided; the
  page says so when it happens, and its items stay questions or "to decide".

## Spend

$0.19 at catalog prices of the $8 cap: 176 paid calls in the ledger (`work/decide/ledger.jsonl` in
the private folder), for the Brill development and final runs and the dissertation's four reading
calls and three decide calls. The Brill reading check came from the existing cache. (The script's
own running total printed more, up to $0.52: two calls starting together read the ledger twice.
Fixed; the ledger's sum is the figure.)
