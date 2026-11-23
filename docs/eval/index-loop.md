# Evaluation loop: the Index Builder

The Index Builder is measured against the indexes of published books, as the owner asked: a
book's PDF with its index pages taken out stands for the typeset proofs, and the index the book
actually has, made by a professional indexer, is the gold. The books are copyrighted: they, their
indexes and everything drawn from them stay in the private guidelines folder (`index-books/`), and
this file holds only counts, rates and generic descriptions. The script is
`scripts/index-eval.mjs` (`npm run index-eval`); the README says how a case is made.

The cases:

- **Dev**: a monograph from a university press, 304 PDF pages (287 once the 17 index pages are taken
  out), with page labels that give the printed numbers. Its index is run-in, Chicago style:
  993 entries, 1,056 subentries, 4 `See` and 24 `See also` references, 3,084 text pages and 128
  pages cited only for a note.
- **Holdout**: a monograph from another university press, 340 PDF pages (323 without the index),
  scanned with a text layer and no page labels; 8 unnumbered plates sit between two printed pages,
  so its stripped PDF was given labels with the printed numbers (as a press's proof has them).
  Index: 729 entries, 244 subentries, 2 `See` and 57 `See also`. Scored once, at the end, with
  nothing changed after.

The model throughout is the Formatter's measured default, `deepseek-v4.1-flash-1017`. No other model
was compared: the results below did not call for it.

## Where things stand

| Measure | Dev | Holdout |
|---|---|---|
| The ported matcher against book-index's own code, same PDF and list, no model | identical | identical |
| Pages found against the index's, the index's headings as the term list, no model | precision 56.9%, recall 64.1% | precision 57.2%, recall 64.7% |
| The same with front matter, notes and back matter left out | precision 70.6%, recall 64.0% | precision 73.3%, recall 64.2% |
| Page-ranges helper against ranges marked by hand | 3 of 3 ranges found; pages left out: precision 100%, recall 95.7% (the cover page missed) | 2 of 2 found; precision 100%, recall 97.3% (the first, blank page missed) |
| Ambiguity helper against a sample of 40 hits labelled by hand first | 38 of 40 agree; 1 hit to keep dropped, 1 to drop kept | not labelled |
| Stage 1: of 50 proposals that are not index entries, reasonable index terms anyway (judged by hand) | 38 | 37 |
| Ambiguity helper, judged entries' pages against the index | precision 43.9% to 51.3%, recall 55.8% to 51.5% | precision 61.2% to 77.3%, recall 58.6% to 55.4% |
| Subentry helper: hits on the index's pages filed as the index files them | 78.9% (165 of 209) | 57.4% (592 of 1,032) |
| Stage 1: the index's main entries proposed (recall) | 85.3% (847 of 993) | 80.5% (587 of 729) |
| Stage 1: proposals that are index entries | 46.6% (848 of 1,819) | 43.0% (614 of 1,429) |
| Stage 1: quotations verified in their passage | 95.6% | 99.7% |
| Stage 1: people with exactly the index's surname-first heading | 93.0% (479 of 515) | 73.5% (169 of 230) |
| Stage 1 cost and time for the book | 61 calls, $0.28 by the catalog's prices, 315 s | 71 calls, 328 s |

## Stage 2: the matcher with no model

The gold's headings are the term list, written by fixed rules an author using book-index would
follow (in the script, `goldLine`): people go in the names, keeping a name in parentheses as
another name of theirs and dropping a qualifier in lower case; a title filed under its first word
after an article is searched as written; any other heading loses its parenthetical qualifier and
also searches the part before a comma, and the parts after it that share its first four letters. Which headings
are people was decided by a model (7 calls on dev, about one cent); 30 headings checked by hand were
all sorted correctly.

**Identity.** book-index's own `indexer.js` and `extract.js`, imported from its checkout, on the
same PDF and the same lines: the same entries, pages, not-found list and `term: pages` text, byte for
byte (937 entries found, 53 not found, in 3.3 s for 993 entries). The unit tests copied from
book-index pass unchanged, and `tests/browser/index-smoke.mjs` checks the page's own
`term: pages` download against book-index's form.

**Against the index (dev).** Of the 3,474 pages the matcher found, 56.9% are pages the index gives
for that entry; of the index's 3,084 pages, it found 64.1%. 46.2% of entries come out exactly the
same. The disagreements, sorted:

- missed: the indexer gave a page where no search form of the entry occurs (a discussion that does not
  use the word, a pronoun, a later page of the same discussion) 585; a page inside a range the
  indexer gave, other pages of which were found 399; entries found nowhere 122 (51 entries: their
  headings are not how the text names them).
- extra: pages of front matter, notes or back matter 607; a page elsewhere in the text (a passing
  mention the indexer left out, or another sense of the word) 708; a page next to one the index
  gives 114; a page where the index cites a note 68.

Leaving out the pages marked by hand (front matter, acknowledgments at the back, the notes) raises
precision to 70.6% and costs 2 of the 3,084 pages. The index does cite notes: 174 of its locators
are on the notes pages, which this leaves out (as text pages they would be found only where the
word occurs).

This measures the matcher against a professional's choices, not its correctness: an indexer indexes
discussions, not words. The two biggest kinds of disagreement (pages without the word, and
passing mentions) are the hand work the tool does not do.

## The helpers

**Pages the index does not cover (dev).** 3 calls (page openings of 287 pages in windows of 30,000
characters), 12 s, $0.009. It found the front matter (pages 2 to 9 of 1 to 9 marked: it left the
cover alone), the acknowledgments at the back and the notes section, each exactly; one proposed
range was rejected because its heading was not on its first page. Taking its ranges out gives the
same scores as the ranges marked by hand.

**Ambiguous hits (dev).** The matcher marked 55 entries: hits inside another entry's longer hit
(30), a capitalized term found in lower case (20), a form another entry also searches for (10), a
short abbreviation (2); no surname was shared, since the index's people are named in full. The 52
entries with 1 to 150 hits (1,124 hits) took 64 calls, about 3 minutes, $0.11 to $0.20 a run.

- Against 40 hits drawn at random and labelled by hand before the first run: 38 agree. The first
  run (without the first-line mark below) agreed on 37: its three misses were two running heads it
  kept and one citation of a person's book in a note. A hit on a page's first line is now marked,
  and the prompt says such a place is often a running head; the second run dropped both running
  heads, kept the note citation and dropped one hit labelled keep.
- Against the index's pages: of the hits on pages the index gives for the entry, 79 were dropped
  (486 kept); of the hits on other pages, 174 were dropped (385 kept). For the 50 judged entries
  with pages in the gold, precision of pages rose from 43.9% to 51.3% and recall fell from 55.8% to
  51.5%. Many kept hits off the index's pages are the right sense in a passing mention, which the
  helper is told to keep. Of the 79 hits dropped on the index's pages, the model's reason named a
  longer name or title the hit is part of for 34, a title for 18 and a book for 7; 23 of the 79 are
  on notes pages. The index gives those pages for the entry all the same; which of the drops are
  wrong in sense, rather than right in sense on a page the indexer chose for another reason, was not
  checked hit by hit.
- The decisions are proposals: the page applies them only when the author does, entry by entry.

**Subentries (dev).** 25 of the 94 entries with subentries, spread over the alphabet, their gold
subentries given as the author's; 424 hits in 26 calls. Of the hits on pages the index gives, 165
of 209 (78.9%) were filed as the index files them (a subentry, or the heading itself). The
subentry's own words on the page, the code-only rule, placed 79 hits, 58 of them as the index does.

## Stage 1: terms proposed from the text

There is no `.docx` of these books, so the script feeds the terms route the stripped PDF's text
outside the hand-marked ranges, cut into paragraphs (dev: 831), through the product's own passages
(61 of about 9,000 characters), reply parser, quotation check, merging and counting. The page itself
takes a `.docx`; the Brill run below goes through it.

**Thinking.** The first dev run had thinking on, as the reading check does, with 20,000 tokens of
room: calls ran past three minutes and stopped at the limit with no answer (a single passage: all
20,000 tokens in 120 s). With thinking off the same passage took 9 s and 1,911 tokens and gave 27
verified proposals. Thinking is off for this route. The failed first run cost about $1.30 of this
work's spend.

**Results (dev).**

- 2,985 proposals, 2,853 with their quotation found in the passage (95.6%); merged into 1,819
  entries, of which 29 are not found in the text by their own search forms (flagged on the page).
- Recall of the index's 993 main entries: 847 (85.3%). By kind (sorted by a model): people 88.9%,
  places 100% (12), organizations 82.6%, works 86.6%, events 60.0% (10), concepts 72.0%.
- Proposals that are index entries: 848 of 1,819 (46.6%). Of a fixed sample of 50 of the others,
  judged by hand, 38 are reasonable index terms anyway (a work, place or person named in the text,
  a concept discussed); 12 are not (a phrase used once, a simile, a magazine named as a source, a
  paraphrase). 30 of the 50 occur once: most of the excess is passing mentions the indexer left out.
- Duplicates left after merging: 65 index entries matched by more than one proposal (a person under
  two forms the merge did not join, a concept in two wordings).
- People: 479 of the 515 matched (93.0%) have exactly the index's heading, surname first.
- The scoring's matching (heading, singular and plural, a variant, a surname with compatible
  forenames) was checked by hand on 30 matched pairs: 29 the same entry, 1 a near-equivalent.

## Holdout, scored once

Everything above was settled on the dev book; the holdout was then run once with every step and
nothing was changed after (`npm run index-eval -- --book <holdout> --steps match,ranges,judge,subentries,terms`,
343 calls, about 36 minutes, $1.38 by the catalog's prices). The numbers are in the table.

- **Matcher.** Identical to book-index's own code again (653 entries found, 76 not found). Against
  the index: precision 57.2%, recall 64.7%, 31.8% of entries exactly the same; with front matter and
  notes left out, precision 73.3%. This index capitalizes every heading (as "Ceramics"), so the
  term list made from it searches capitalized words; case is ignored by default, as in book-index.
- **Page ranges.** 4 calls, 31 s: front matter (pages 2 to 13 of 1 to 13) and the notes (264 to 323),
  each exactly; the appendix of maps and figures, which is text, was rightly left alone.
- **Ambiguity.** 162 entries marked, mostly because their capitalized heading is also found in
  lower case (130); 154 judged, 2,866 hits in 184 calls, about 10 minutes. Precision of their pages
  rose from 61.2% to 77.3%, recall fell from 58.6% to 55.4%; 126 hits on the index's pages were
  dropped, 566 off them. No hand-labelled sample on this book.
- **Subentries.** 57.4% of hits on the index's pages filed as the index files them (dev 78.9%). This
  index's subentries are long, in the author's own phrasing, and its largest entries have hundreds
  of pages, so the task is harder than on dev; 61 calls for 25 entries took 19 minutes.
- **Stage 1.** Recall 80.5% (people 95.6%, places 81.8%, organizations 80.8%, works 88.2%, concepts
  51.5%); 43.0% of proposals are index entries; 37 of 50 others judged reasonable by hand; 99.7% of
  quotations verified; 65 duplicates left. Name form agrees for 73.5% of people: this index gives
  ranks and titles after the forenames, which the proposals do not.

## The run through the page

One real run through `/manuscript/index/` in `npm run dev` mode, with real models and the key's
own allowance, driven by Playwright with the installed Chrome. The manuscript is the eleven-chapter
edited volume of the Brill job (about 78,600 words); there is no typeset proof of it, so the PDF is
a **stand-in**, made from the manuscript with LibreOffice (`soffice --headless --convert-to pdf`):
285 pages, no page labels, its page breaks not a press's.

- **Stage 1.** The page said "55 model calls, one per passage of about 9,000 characters; 754
  paragraphs of bibliography left out" before running; the bibliographies were found by their
  headings, since this browser kept no Formatter labels for the file. Against the manuscript's
  paragraph roles set by hand, that left out 449 of its 450 non-empty bibliography paragraphs and
  nothing else. 55 calls, no failures, 239 s; 1,197 entries proposed, all accepted for the run.
- **Stage 2.** Matching 1,197 entries on 285 pages took 6.8 s in the Worker; 1,170 entries found.
  The page-ranges helper (4 calls, 29 s) proposed the front matter, the list of abbreviations, the
  notes on contributors and each chapter's "Works cited", each with its heading on its first page and,
  where a bibliography began mid-page, the text above it kept; ticking them left out 51 pages and
  1,105 entries remained. The index downloaded as text, as a Word file that passes the validator, and
  as book-index's `term: pages` list.
- **The judge and the subentries on the whole list** were planned by the page at 388 calls (10,241
  hits of 195 entries) and 135 calls (4,552 hits); both were skipped to keep within this work's spend
  plan. In a second session on the same page with a 9-entry list, the judge made 5 calls (40 s) and
  the subentry helper 3 calls (57 s); both were applied and the index downloaded. The same 5 judge
  calls made in an earlier, interrupted session had proposed different drops (5, 3 and 3 hits of
  three entries, then 3, 0 and 3): the decisions are not stable from one run to the next.
- **A fault found and fixed.** 27 proposed entries were not found in the proofs because the model
  filed titles under their first word after an article ("Long Night, The"), which the matcher
  searches literally. Merging now adds the title as the text writes it as a variant; this fix came
  after the run and the scores above.
- Cost: the whole page run, both sessions included, about $0.38 by the Gateway's estimate.

For a book of this size: about 55 to 70 calls and 4 to 6 minutes for stage 1 (about $0.20 to $0.30),
3 or 4 calls for the page ranges, and for the judge and the subentries on a whole proposed list some
hundreds of calls, which is why each states its number of calls first.

## Not measured, and why

- Stage 1 on a `.docx` against a real index: the books with indexes have no `.docx`, and the
  manuscript with a `.docx` has no index. The `.docx` path is exercised by the Brill run and the
  mocked smoke test; its quality is measured only on the books' text.
- Whether an author would accept the ambiguity and subentry proposals: no person has reviewed them.
- A real typeset proof of a manuscript the tool also read as a `.docx`: none was available; the
  Brill run's PDF is a LibreOffice stand-in.
- The hand-labelled ambiguity sample exists for the dev book only.
- Another model: none was compared.
- Run-in against indented output, and the page-range styles, against a press's house style: they
  follow Chicago's rules and are unit-tested on Chicago's own examples, not on a real index's
  typesetting.
