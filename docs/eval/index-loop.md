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

## Where things stand (round 1)

Round 2, at the end of this file, changed several of these and the scoring of people; its table gives both.

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

Everything above was settled on the dev book; in round 1 the holdout was then run once with every step and
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

## Round 2

The weak spots of round 1, worked on the dev book; the holdout was then scored once more, at the end,
with nothing changed after (commit `cb6d7d8`, `--steps match,ranges,judge,subentries,terms`).
Spend by the catalog's prices: $3.03 in all (the dev work $2.03, the holdout run $1.00).

### Before and after

Round 1 is the published table; round 2 is this round's code, prompts and default settings. Where the
scoring itself changed, both are given.

| Measure | Dev, round 1 | Dev, round 2 | Holdout, round 1 | Holdout, round 2 |
|---|---|---|---|---|
| The ported matcher against book-index's own code | identical | identical | identical | identical |
| Pages found against the index's, no model | precision 56.9%, recall 64.1% | the same | precision 57.2%, recall 64.7% | the same |
| The same, front matter, notes and back matter left out | 70.6%, 64.0% | the same | 73.3%, 64.2% | the same |
| Page-ranges helper against ranges marked by hand | 3 of 3; precision 100%, recall 95.7% | the same (prompt unchanged) | 2 of 2; 100%, 97.3% | the same (prompt unchanged) |
| Ambiguity helper against the 40 hits labelled by hand | 38 of 40 | 39 of 40 (a second run 38) | not labelled | not labelled |
| Ambiguity helper, judged entries' pages | precision 43.9% to 51.3%, recall 55.8% to 51.5% | 43.9% to 51.5%, 55.8% to 51.2% | 61.2% to 77.3%, 58.6% to 55.4% | 61.2% to 78.2%, 58.6% to 55.0% |
| Ambiguity helper, two runs: the same decision | not measured | 97.8% of hits (kappa 0.94); round 1's settings 98.1% (0.95) | not measured | one run |
| Subentry helper, hits on the index's pages filed as it files them | 78.9% (165 of 209) | 84.2% (186 of 221) | 57.4% (592 of 1,032) | 65.6% (716 of 1,091) |
| Subentry helper, the index's pages filed as it files them | 64.5% (round 1's cached answers, 7 calls missing) | 86.7% (144 of 166) | 65.3% (362 of 554, round 1's cached answers) | 69.3% (384 of 554) |
| Stage 1: the index's main entries proposed (recall) | 85.3% | 84.5% (strict matching 84.3%) | 80.5% | 78.7% (strict 75.9%) |
| Stage 1: concepts proposed | 72.0% | 77.6% | 51.5% | 58.8% |
| Stage 1: proposals that are index entries | 46.6% (848 of 1,819) | 40.0% of 2,095; 49.2% of the 1,652 the default shows | 43.0% (614 of 1,429) | 38.6% of 1,537; 44.1% of the 1,256 the default shows (strict) |
| Stage 1: index entries proposed among those the default shows | not built | 81.9% | not built | 74.8% (strict; 75.9% for every proposal) |
| Stage 1: quotations verified in their passage | 95.6% | 94.8% | 99.7% | 99.5% |
| Stage 1: people with exactly the index's heading | 93.0% (479 of 515) | 97.4% (487 of 500), strict matching | 73.5% (169 of 230) | 84.7% (171 of 202), strict matching |
| Stage 1: index entries matched by more than one proposal | 65 | 61 (strict matching 27) | 65 | 69 (strict 45) |
| Stage 1 cost and time | 61 calls, $0.28, 315 s | 61 calls, $0.36, 375 s | 71 calls, 328 s | 71 calls, 401 s |

**The inverted-title fix** (a title proposed under its first word after the article also searches the
title as written), made after round 1's runs, re-scored on round 1's answers with round 1's code:
dev, entries not found by their own forms 29 to 28, recall unchanged (847 of 993); holdout entries not found by their own forms 14 to 12, entries 1,429 to 1,428, duplicates 65 to 64, recall unchanged (587 of 729).

**Strict matching.** Round 1's scoring let a proposed person's bare-surname search form, or the surname
alone of an index heading, match every person of that surname: one proposed person counted as several
index entries, as duplicates, and as a mismatch of name form against the wrong person. Round 2 matches a
person in the index only to a proposal with the same name (same surname, compatible forenames), the
same full name in the text's order, or the name the index gives in parentheses. On round 1's own dev
answers this moves recall from 85.3% to 84.9%, duplicates from 65 to 16 and the exact name form from
93.0% to 98.0%: most of round 1's duplicates and name-form misses were the scoring's. Both matchings are
printed; the table gives round 1's where it can.

### 1. The proposed list: ranked, with thresholds the author moves

Each proposal gets the facts it is ranked by (`lib/index/terms.js` `countAndDrop`, `lib/index/rank.js`):
the pages of the manuscript it is on (stretches of about 2,500 characters, about a printed page, since a
`.docx` has no pages), its occurrences, the passages in which the model proposed it, whether a heading
names it, and whether the model said a passage discusses it (asked for this round). The term editor
shows the proposals ranked (proposed in more passages, then on more pages, then more occurrences) and
hides those below two thresholds: the pages a concept is on, and the same for names (people, places,
organizations, works, events). Hidden proposals stay in the list; one button shows them.

What the signals are worth, on dev (round 1's answers, strict matching; base rate 46%):

- Kind, more than anything. 81% of proposed people are index entries, 60% of works, 21% of concepts,
  20% of organizations, 12% of places. This index takes most people it names even once: 300 of its
  people are proposals on one page only. So a threshold on every proposal loses most of the index: on
  at least 2 pages, 735 shown, 51.8% index entries, 38.7% of the index.
- Proposed in two passages or more: 68.5% are index entries, but only 28.8% of the index.
- In a heading: 51 proposals, 51% index entries; too few to matter.
- The model's own word, "discussed" (asked for in round 2, so from round 2's answers): it says so of 673
  of 791 concept proposals; of all proposals, those discussed are 37% index entries and those not 49%.
  Asking for it did not help, and it serves only to break ties in the ranking.

The trade-off of the threshold on concepts, every name shown (dev, round 2's answers, strict matching):

| Concepts shown when on at least | Proposals shown | Of them, index entries | Of the index, proposed |
|---|---|---|---|
| 1 page (all) | 2,095 | 39.9% | 84.3% |
| 2 pages (default) | 1,652 | 49.2% | 81.9% |
| 3 pages | 1,514 | 52.5% | 80.3% |
| 4 pages | 1,433 | 54.4% | 78.7% |
| 5 pages | 1,397 | 55.0% | 77.4% |
| 6 pages | 1,369 | 55.7% | 76.9% |
| names also on at least 2 pages | 897 | 42.9% | 38.9% |

The default is 2 pages for concepts and every name: the step from 1 to 2 hides 443 proposals of which
about one in twenty is an index entry, the clearest gain on the curve; each later step still hides
mostly proposals that are not entries (one in seven, then one in five) but costs more of the index. It
costs concepts most: on dev, the index's concepts proposed and shown fall from 77.6% to 64.0%, which is
why the hidden proposals are one click away. On the holdout the default showed 1,256 of 1,537 proposals, 44.1% index entries against 36.6%, and 74.8% of the index against 75.9% (strict matching).

### 2. Concepts

The 45 concepts of the dev index not proposed in round 1, sorted: 25 where a proposal shares a word but
is narrower or worded otherwise (the qualified phrase instead of the general noun, the noun inside a
title), 15 headings whose words, as headed, are nowhere in the text, 5 general nouns never proposed.

- **Prompt.** Stage 1 now asks for the subjects a passage is about, not only its names: abstract
  subjects, groups of people, practices, genres, movements; the general heading a reader looks up first,
  and the general subject as well when a passage is about a narrower one. Concepts proposed rose from
  72.0% to 77.6%; the list grew from 1,812 to 2,095 entries (round 1's answers with round 2's merging),
  people fell from 88.4% to 87.0% and organizations from 82.6% to 67.4% (46 in the index, 7 fewer
  proposed), so overall recall is about the same (84.9% to 84.3%, strict).
- **A second pass, tried and not kept.** The model was shown, for each part of about twenty pages, the
  entries proposed there with their quotations, and asked for the organizing concepts of the part,
  each naming the listed entries it gathers and quoting the part. Two versions (11 calls each, $0.03
  to $0.06): the first gave 364 concepts, many of them the book's general subject with an endless list
  of qualifiers, and the entries they gathered, used as their search forms, made merging absorb other
  entries (duplicates up from 13 to 50); the second, at most ten short headings a part, without the
  gathered forms, gave 110 and one more of the index's concepts (125 to 126 of 161), while its forms
  still absorbed entries. It was taken out.
- **What remains out of reach.** Of the 36 dev concepts still not proposed: 16 headings whose words are
  not in the text at all (a heading that gathers works by kind, a genre the text names otherwise, a group
  the book never calls by that name, a word in another language the index supplies): no tool that reads
  for words finds these, and the matcher could not find their pages either; 16 where a proposal is
  narrower or worded otherwise, which the author can merge or rename; 4 general nouns used throughout,
  which passage-by-passage reading still does not offer as entries. On the holdout, concepts proposed rose from 51.5% to 58.8% and places fell from 81.8% to 74.2% (264 in its index, 20 fewer proposed), so overall recall fell from 80.5% to 78.7%: on both books the prompt shifts what the model proposes toward subjects, at some cost to names.

### 3. The ambiguity judge

- **Which entries.** The page now offers the entries the author marked, those the tool flags, or both,
  each choice with its number of entries and calls before anything runs; the default is the author's
  marks when there are any.
- **Evidence.** Every drop must quote words of that hit's own context showing the other meaning; code
  finds them there, marks aside, or the drop is left undecided (4 of about 270 drops on dev) and the hit
  is kept. The page shows the evidence with each decision.
- **Stability**, two runs of the same 64 calls on dev, all 1,124 hits:

| Settings | Same decision | Drops in both, of the drops either made | Kappa | Hand labels agreed | Judged pages, precision and recall |
|---|---|---|---|---|---|
| Round 1 (thinking on, no evidence) | 98.1% | 92.0% | 0.95 | 38 and 39 of 40 | 51.3%, 51.5% |
| Thinking off, evidence | 99.2% | 95.7% | 0.97 | 34 and 33 of 40 | 49.7%, 52.4% |
| Thinking on, evidence (kept) | 97.8% | 90.7% | 0.94 | 39 and 38 of 40 | 51.5%, 51.2% |
| Two readings of the kept settings, a drop only when both drop | | | | 38 of 40 | 51.2%, 51.9% |

  Round 1's instability was seen in five calls of the real page run; over the dev book's 64 calls the
  judge was already stable, and no setting tried made it much more so without losing accuracy: with
  thinking off it misses the drops the hand labels call names inside cited titles. Two readings cost
  twice and gained 0.4 points of recall, so the page asks once. Thinking on with evidence costs more
  than round 1 ($0.26 a run on dev against $0.11 to $0.20): the evidence lengthens the answers.
- **Precision and recall** are as in round 1 (dev 43.9% to 51.5% and 55.8% to 51.2%): the judge drops
  hits on the index's own pages (82 of 565), many in names or titles on notes pages, which the index
  cites all the same. Holdout, one run of 184 calls (863 s): precision of the judged entries' pages 61.2% to 78.2%, recall 58.6% to 55.0% (round 1: to 77.3% and 55.4%).

### 4. Subentries

The holdout's round-1 answers, sorted by kind of error only (no entry or prompt was read against
them): of 327 hits filed otherwise than the index, 140 were answered "none" where the index files the
page under a subentry, 118 went to another subentry, 69 to a subentry where the index has the heading;
its entries are large (up to 15 batches of hits for one entry, several hits to a page), and each hit
was sorted alone, so one page got several answers. The general causes, worked on dev:

- **A page is one question.** The subentry question now numbers the entry's pages, each with the words
  around its hits (at most three, overlapping ones left out), and an answer covers every hit of the
  page, as an index files a page.
- **Thinking off.** With thinking on, the per-page question ran out of room in its large batches and
  cost $0.28 on dev; that run was also spoiled by the reply naming places by a field called "page",
  where the model gave printed page numbers (now "n", the number in brackets, and a printed page is
  never read as a place). With thinking off and the fixed reply: 84.2% of hits on the index's pages
  filed as it files them (78.9% in round 1), 86.7% of pages, for about $0.02. Thinking on was not
  measured again with the fixed reply.
- **Scored by page too.** The eval now also scores pages as the page composes the index (a page goes to
  each subentry whose words are on it or to which an applied answer sorts a hit, else to the heading):
  the code's word rule alone files 30.1% of dev's pages as the index does. Holdout: 65.6% of hits and 69.3% of pages filed as the index files them (round 1: 57.4% and 65.3%); the code's rule alone files 53.4% of pages. Most of what remains is another subentry than the index (81 pages) and a subentry where the index keeps the heading (59): this index's subentries are long and in the author's own phrasing, which the words around a hit often do not settle. Round 1's holdout figure per page comes from its cached answers, 9 calls of which were missing.

### 5. Name forms

Merging now puts a lower-case particle leading a surname after the forenames ("Beauvoir, Simone de";
a capitalized one stays), leaves out honorifics (Mr., Dr., Professor), treats a proposed "person" whose
heading names a body (a company, band, society, university) as an organization, and takes a short
forename or a quoted nickname as the same person when no other person of the surname could be meant.
The eval now sorts each matched person by the form of the index's heading. Dev, strict matching: plain
450 of 456 exactly the index's form, particle 20 of 20, one name or a name known by 10 of 11, title or
rank 5 of 7, nickname or other name 1 of 3, compound surname 1 of 3; no proposed person is an
organization in the index. The remaining misses on dev are a middle initial, a name the index gives in
another form (a stage name, a later name), and spellings that differ between the text and the index.
Holdout: 171 of 202 (84.7%); by the index's form, plain 151 of 157, particle 9 of 11, one name 5 of 6, compound surname 3 of 3, and title or rank 3 of 25: this index puts ranks and titles in its headings, and the proposals do not. The strict matching also misses some people whose index heading carries a title among the forenames, so it under-counts the holdout's people (86.9% proposed, against 95.2% with round 1's matching); the truth lies between. Ranks and titles after the forenames are a press's choice, and the tool does not move them.

### 6. Duplicates

Merging now joins a title with and without its article, a work and a concept of the same words, a
short forename or quoted nickname, and a person whose name in the text's order is another entry's
search form. On round 1's dev answers: 65 to 59 (round 1's matching), 16 to 13 (strict). With round 2's
prompt, which proposes more: 61 and 27. The rest on dev are a general concept and its narrower forms
proposed apart, and one person proposed under two names. Holdout: 69 with round 1's matching (round 1: 65, and 64 re-scored with the inverted-title fix), 45 strict.

### Concerns

- The hand-labelled sample of proposals that are not index entries (38 of 50 reasonable) is round 1's;
  round 2's sample was written but not judged by hand. The dev file holding the labelled sample was
  overwritten once during this round and rebuilt from the same answers; it may differ in a few items.
- The default threshold is chosen on one book. It hides a seventh of the index's concepts on dev.
- Thinking on for the judge and the subentry question run on per-page batches with the fixed reply was
  not measured, to keep within the spend.
- The Gateway refused many calls for its rate limit this round (another agent shared it); refused calls
  were asked again in later passes of the same configuration, which the cache makes cheap. The holdout run itself had 11 calls refused (1 of stage 1, 10 of the subentry question); a second pass of the same commit, nothing changed, asked those again and also asked again, whole, 3 judge batches the first pass had answered in halves. The table gives the completed run; the first pass, with the refused calls missing, gave recall 78.2% and pages of subentries 65.3%, and the judge 77.8% and 55.0%.
