# Plan: the Index Builder

Date: 2026-11-23. Implements "The Index Builder" in
`docs/superpowers/specs/2026-11-22-manuscript-desk-design.md`, build order step 7: stage 2 (the
port of book-index with the model helpers) first, then stage 1 (terms proposed from the manuscript).

## Ground rules

- book-index's matcher (`public/indexer.js`, `public/extract.js`, GPL-3.0, same owner) is copied
  unchanged into `lib/index/`, with a header naming where it came from and its licence, and its
  tests copied with it. Everything book-index does today works here with no model call, and gives
  the same index for the same PDF and term list.
- Every model helper is optional, says how many calls it makes before it runs, shows progress, can
  be stopped, and is retried as the Formatter's runs are: at most three calls in flight, one retry
  after an unreadable reply or a refusal marked retry, pauses after a rate-limit refusal
  (`lib/calls/backoff.js`), a call that runs out of output room asked again as two halves, failures
  recorded and offered to "Try again" with `only`.
- Every model claim is checked by code: a proposed term quotes its passage (`findQuote`), a page
  range quotes the heading it saw on its first page, a judgment names a hit it was shown.
- The Worker stays stateless. The PDF and the manuscript stay in the browser; only passages, page
  openings and hit contexts are sent, for the calls the author starts.
- Text from files or models is set with `textContent` only. No UI framework.

## Files

Copied from book-index (header added, code unchanged):

- `lib/index/indexer.js`: `normalizeText`, `pageVariants`, `variantRegExp`, `reverseName`,
  `addTerms`, `pageNumbering`, `buildIndex`, `sortKey`, `letterFor`.
- `lib/index/extract.js`: `extractPdf(mupdf, data, onProgress)` -> `{ texts, labels }`.
- `tests/index-indexer.test.mjs`: book-index's `tests/indexer.test.mjs`, importing from here.
- `tests/fixtures/index-sample.pdf`, `tests/fixtures/index-locked.pdf`: book-index's invented fixtures.

New, pure (Node-testable):

- `lib/index/termlist.js`: the term list. File syntax is book-index's (one term per line, `term
  (variant, variant)`, names as `Last, First`), with optional additions an old list never has:
  `Terms:` / `Names:` section lines, an indented line under an entry for a subentry (`  aspect
  (variant)`), indented `see X` / `see also X; Y`, a trailing ` [ambiguous]` mark and `#` notes.
  A list with none of them is all terms, as book-index's Terms box. `parseTermList(text)`,
  `serializeTermList(list)`, `matcherInput(list)` -> `{ terms, names }` (exactly the lines
  book-index would be given), entry ids.
- `lib/index/hits.js`: `findHits(pages, list, { matchCase })`: `buildIndex` first, then for every
  (entry, page) it found, each occurrence with its context (text before and after, case kept) and
  an id. Pages, and so the index, are exactly `buildIndex`'s. `detectAmbiguous(list, hits)`:
  a capitalized term found in lower case, a variant shared by entries or equal to another name's
  surname, a short all-capitals acronym, hits lying inside another entry's hits; each with its reason.
- `lib/index/ranges.js`: `collapsePages(pages, { collapse, style })`: consecutive arabic pages
  become ranges; `full`, `chicago` (Chicago's abbreviation rules) or `two-digit`; roman numerals
  never abbreviated.
- `lib/index/format.js`: `formatIndex(entries, { layout: indented|run-in, sorting:
  letter|word, ranges, collapse })` -> lines and `.docx` blocks; letter groups; subentries;
  `See` / `See also` per Chicago's placement; `indexDocx(...)` through `lib/docx/build.js` (new
  block type for index entries, styles "index 1" and "index 2"), validated before it is offered.
- `lib/index/matter.js`: page digests for the page-ranges question (`pageDigests(pages)`), the
  reply parser, the heading check on the range's first page, joining ranges cut by windows, and
  `applyExclusions(pages, ranges)` (a range's first page keeps the text before its heading).
- `lib/index/runner.js`: the shared run for the three index calls (in-flight cap, retry, backoff,
  halves on `model_output_limit`, `only`, progress, Stop), shaped like `lib/roles/label.js`.
- `lib/index/judge.js`: batches of hits for the ambiguity question and the subentry question,
  their reply parsers (`keep`/`drop` with a reason; a subentry name or none), `judgeHits(...)`,
  `sortIntoSubentries(...)`.
- `lib/index/terms.js` (stage 1): passages of the manuscript's body (bibliography zones left out,
  by roles when the Formatter's labels for the same file are kept in this browser, else by
  headings), the reply parser (heading, kind, variants, subentry, see, quote), the quotation check,
  `proposeTerms(...)`, `mergeProposals(...)` (same person named two ways, singular and plural,
  variants), `countOccurrences(...)`, and dropping what occurs only in bibliography.

Server:

- `server/index-prompts.js`: `termsPrompt/termsPayload`, `judgePrompt/judgePayload` (tasks
  `ambiguous` and `subentries`), `rangesPrompt/rangesPayload`, written for any scholarly book.
- `server/worker.js`: `POST /api/index/terms` (`{ model, passage }`), `POST /api/index/judge`
  (`{ model, task, entry, subentries?, hits }`), `POST /api/index/ranges` (`{ model, pages }`),
  validated and bounded as `/api/roles`, typed failures, nothing logged or echoed.

Rule sheet:

- `lib/rules/schema.js`: slots `index.layout` (`indented` | `run-in`), `index.page-ranges`
  (`full` | `chicago` | `two-digit`), `index.sorting` (`letter-by-letter` | `word-by-word`), in
  the `index` category; their `SLOT_USES`; `web/format/rules-view.js` labels; the checklist says
  "for the Index Builder" for them (`lib/todos/companions.js`).

Page:

- `web/index/index.html`, `web/index/app.js` (DOM wiring), `web/index/state.js` (pure: plans,
  saved state and restore, rule-sheet prefill, term-list edits), `web/index/terms-view.js` (the
  list editor), `web/index/index-worker.js` (MuPDF: read pages and labels; match).
- `web/shared/store.js`: `createStore({ name })`, so the Index Builder keeps its work in its own
  database (`manuscript-desk-index`) with its own 24-hour clock and "Delete saved work now"; it
  only reads the Formatter's saved paragraph labels.
- `web/index.html` links the new page; `scripts/build.mjs` builds it.

Measurement:

- `scripts/index-eval.mjs` (`npm run index-eval`): stage 2 identity against book-index's own code,
  page ranges against ranges marked by hand, ambiguity judgments against a sample labelled first;
  stage 1 recall against a term list drawn up by hand before the first run (two dev chapters, two
  holdout chapters scored once), precision on a random sample of 100 merged terms judged by hand,
  duplicate rate, share of quotations verified. Model answers cached in the case's `work/`.
- `docs/eval/index-loop.md`: numbers and generic descriptions only.
- `tests/browser/index-smoke.mjs`: the built page with the API mocked.

## Tasks, in order

1. Copy the matcher, its tests and fixtures; header and README provenance. `npm run check`.
2. Term list syntax (`termlist.js`) and tests, old lists unchanged.
3. Hits, ambiguity detection, page ranges, index formatting, `.docx`; tests.
4. Rule-sheet slots, wired as round 8 did.
5. Runner, judge, matter; server prompts and routes; route tests.
6. Store name option; the page for stage 2 (models off first, then the three helpers); worker;
   build; landing link; HTML-sink and beta-line tests cover the new page.
7. Stage 1: terms module, route, page section; tests.
8. Browser smoke test with the API mocked.
9. Measurement: gold lists first, then `index-eval` runs, then `docs/eval/index-loop.md`.
10. A real run through the page in `npm run dev` mode, both stages, outputs kept in the private folder.

## Deviations

- **Measurement on published books.** At the owner's request, made after this plan was written,
  stage 2 and stage 1 are measured against the indexes of two published monographs (one dev, one
  holdout scored once), not against a stand-in PDF and a list drawn up by hand: the book's PDF with
  its index pages taken out is the proof, and its parsed index is the gold. The Brill manuscript
  (a `.docx`) is used for the real run through the page; its PDF there is a stand-in made with
  LibreOffice. `scripts/index-eval.mjs` gained a text-in path for stage 1 (the PDF's paragraphs),
  used by the script only; the page still takes a `.docx`.
- **Shared runner.** `lib/index/runner.js` holds the run the three index routes share, instead of
  each helper repeating the shape of `lib/roles/label.js`.
- **One route for two judgments.** `/api/index/judge` takes `task: ambiguous | subentries`; the
  browser builds the batch text and the route checks the task and its length.
- **Running heads.** A hit on a page's first line is marked for the judge, which is told that such a
  place is often a running head (dev: the judge kept the two running-head hits of the hand-labelled
  sample without the mark).
- **Saved ranges keep a number, not a heading.** Where an excluded range's first page is cut is
  saved as a character position, so no heading text from the PDF is kept in the browser.
