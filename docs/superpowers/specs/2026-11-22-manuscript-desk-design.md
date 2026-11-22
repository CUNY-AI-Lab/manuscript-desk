# Manuscript Desk: design

Date: 2026-11-22. Status: draft for Stefano's approval.

"Manuscript Desk" is a working name (my call; rename freely).

## Intent

Scholars lose days reformatting a finished manuscript to a publisher's or
journal's submission guidelines, and still miss requirements. Manuscript Desk
is a CUNY AI Lab tool suite that does the mechanical part and tells the author
exactly what is left for them.

The suite has two tools:

1. **Formatter.** The author says what the manuscript is (article, monograph,
   or edited collection), supplies the guidelines and the manuscript, and gets
   back the manuscript with every change as a Word tracked change, comments on
   what needs their judgment, and a To-dos list of what only they can supply.
2. **Index Builder.** A new, model-assisted version of Stefano's
   [book-index](https://github.com/smorello87/book-index): it proposes the
   index terms from the manuscript, then builds the index from the typeset
   proofs.

It is for CUNY AI Lab members only, behind CUNY Login.

## Goals

- Work with any publisher's or journal's guidelines, not a fixed list.
- Every text change is a tracked change the author can accept or reject.
- Every rule the tool applies can be traced to a sentence in the guidelines or
  to the named style manual.
- The author leaves with one list of what remains for them to do.
- A whole monograph is affordable on a personal Gateway budget.
- The manuscript file never leaves the author's browser; only text passages
  are sent for model reading, to providers that do not retain them.

## Non-goals

- Copyediting beyond the guidelines and the named style manual (no general
  grammar or prose improvement).
- Converting between citation systems in running text (notes to author-date or
  the reverse). The tool reports the mismatch as a To-do.
- Inputs other than `.docx` for the manuscript (no LaTeX, Google Docs, PDF,
  `.doc`, `.odt`).
- Submitting to a publisher's system, typesetting, or producing print-ready
  PDF.
- Scanned (image-only) guidelines or proofs. The tool says OCR is needed.
- Fetching guidelines from a URL in version 1 (see Decisions).
- A shared, saved library of rule sheets in version 1 (see Decisions).
- Embedding Word index fields (`XE`) in the manuscript.

## Anti-goals

These make it a failure even if it runs:

- A change to the author's prose that is not shown as a tracked change.
- A rule the guidelines never stated, presented as if they had.
- An output file Word reports as damaged, or one that loses footnotes,
  comments, images, or formatting that were in the input.
- Manuscript text stored or logged anywhere on the server.

## Constraints

From the [CAIL Tool Integration Contract](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/main/05%20Infrastructure/CAIL%20Tool%20Integration%20Contract.md)
and the Bibliography Converter, which is the pattern to copy
(`/Users/veritas44/Downloads/github/biblio-zotero`, branch `origin/main`):

- A Cloudflare Worker with static assets, mounted by CAIL Doorway under
  `https://tools.ailab.gc.cuny.edu/`. Doorway is the only way in: no
  `workers.dev`, no preview URLs.
- The Worker verifies two signed identities on each request with
  `@cuny-ai-lab/cail-identity`: its own audience and `cail:gateway`. Missing or
  invalid is `401` with the launch path; the browser then does a full-page
  navigation to the launch path, never a scripted retry.
- All model calls go to CAIL Gateway through the service binding
  `GATEWAY → cail-model-api` with `@cuny-ai-lab/cail-client`. Never a global
  `fetch()` to the tools hostname (it returns `404` from inside the zone).
  The health route reads the catalog through the binding; the release verifier
  asserts the binding; the workerd tests model the origin's `404`.
- Spend lands on the signed-in person's Gateway budget. No provider keys in
  the app.
- Gateway serves open-weight models only and rejects file parts
  (`400 file_input_unsupported`). Only text can be sent. No retries on the
  app's side beyond what `x-should-retry` allows; cancellation is propagated.
- Model IDs are canonical catalog IDs. The model menu is built from the
  Gateway catalog's recommended rows, as in the Bibliography Converter's
  `models.js`.
- No prompts, file contents, or identifiers in operational logs.

## Approaches considered

**A. Rule sheet plus engine (chosen).** A model reads the guidelines into a
structured rule sheet. Code and a model then read the manuscript and produce
*findings* (place, rule, proposed fix). Code in the browser writes the
findings into the `.docx` as tracked changes and comments. The model never
returns rewritten prose. Most work to build, because writing tracked changes
is fiddly, but the result can be trusted, the file stays in the browser, and
cost stays low because model output is short.

**B. Model rewrites, we diff.** Send each chapter with the guidelines, take
back a revised chapter, turn the differences into tracked changes. Quickest
to build. Rejected: open-weight models drift over long text and "improve"
sentences nobody asked about, the diffs are noisy, and output tokens for a
monograph cost many times more.

**C. Report only.** No edits, only a compliance report and To-dos. Cheap and
safe. Rejected as the product (Stefano: "it's useless otherwise"), but it is
A's first working milestone.

Stefano chose A.

## The Formatter

### What the author does

1. **Describe.** Pick article, monograph, or edited collection.
2. **Guidelines.** Upload a PDF or `.docx`, or paste the text. More than one
   source is allowed (a press often has a guide plus a series sheet).
3. **Rule sheet.** Review the rules the tool read out of the guidelines. Each
   rule shows the sentence it came from. The author can edit, switch off, or
   add rules, and download the sheet as a file to reuse or share.
4. **Manuscript.** Upload one `.docx` (article, or a book in one file) or
   several (a book with one file per chapter, in order).
5. **Review.** Watch progress, then see findings grouped by rule, with counts.
   The author can switch a whole rule's fixes off before the file is written.
6. **Download.** The marked-up `.docx` file or files, plus the To-dos list.

### The rule sheet

The rule sheet is the piece that makes the tool general. It is a JSON document
with a fixed set of categories; the document type decides which categories
apply.

Every rule has:

- `id`, `category`, and a plain-language `statement`.
- `source`: a verbatim quotation from the guidelines, or `manual` (comes from
  the named style manual), or `author` (added by hand). Code checks that each
  quotation really occurs in the guidelines text (after whitespace and
  quote-mark normalization). A rule whose quotation is not found is dropped
  and counted, never shown as the publisher's.
- `mode`: one of
  - `fix`: mechanical, applied as a tracked change;
  - `flag`: needs judgment, left as a comment;
  - `supply`: something only the author can provide, goes on the To-dos list.
- `params`: typed settings for the checker that enforces it (for example
  `{ "quotes": "double", "punctuationInside": true }`).

Categories, all document types: citation system and style; reference list;
notes (footnotes or endnotes, numbering); headings (levels, capitalization,
numbering); spelling variety; quotation marks and block quotations; dashes,
ellipses and number ranges; numbers and dates; abbreviations; italics and
emphasis; figures, tables, captions and callouts; alt text; permissions;
page layout (font, size, spacing, margins, page numbers, alignment); length
limits; file naming and file structure; inclusive-language or other house
statements; and `other` (free-text rules the fixed categories do not cover,
always `flag` or `supply`).

Extra for articles: abstract, keywords, title page, anonymization for peer
review, author note, declarations (funding, conflicts, data, AI use), ORCID.

Extra for monographs: front matter (title page, dedication, contents, lists
of figures, acknowledgments), back matter (appendices, bibliography, index
conventions), chapter openings, running order, one file or many.

Extra for edited collections: everything for monographs, plus per-chapter
requirements (abstract, keywords, bio, per-chapter references or a shared
bibliography), contributor materials, and consistency across chapters.

**Named style manuals.** Guidelines usually say "follow Chicago, with these
exceptions". The tool ships baseline rule sheets for Chicago 17 and 18 (notes
and author-date), MLA 9, and APA 7, written in our own words. The extracted
rules are layered on top; a rule from the guidelines overrides the baseline
rule in the same slot, and the review screen shows which is which. If the
guidelines name a manual the tool has no baseline for, it says so and applies
only what the guidelines state.

A baseline is small on purpose (my call): it holds only the rules the named
checkers can enforce, a few dozen per manual, not a digest of the manual. Each
baseline rule cites the manual's section number as its trace. When the
guidelines only say "follow Chicago", the mechanical baseline rules run as
`fix` and the rest as `flag`; the review screen lists them as coming from the
manual so the author can switch any off. Fable drafts the baselines from the
manuals; Stefano spot-checks them before release.

**Extraction.** The browser extracts text from the guidelines (MuPDF for PDF,
the `.docx` reader for Word). The Worker sends it to the model in category
groups, asking for JSON that matches the schema. Long guidelines are split
with overlap and the results merged by slot. Unparseable or schema-invalid
replies are retried once, then reported as a failure for that group; the
author can still fill the group by hand.

### Reading the manuscript

The browser unzips the `.docx` and builds a paragraph model from
`word/document.xml`, `footnotes.xml`, `endnotes.xml`, `styles.xml`,
`comments.xml` and the document properties: for each paragraph a stable id,
its style, its text, and the run boundaries needed to map a text range back to
XML.

Text inside live fields (Zotero, EndNote or Word citation and bibliography
fields, cross-references, tables of contents) is read but never edited,
because an edit there is lost when the field refreshes (my call). The reader
marks field regions as protected ranges; findings inside them become comments
or To-dos. When the references are a live field, the To-do is to change the
style in the reference manager, which is the correct fix anyway, and the CSL
step is skipped.

If the input already contains unresolved tracked changes, the tool stops and
asks the author to accept or reject them in Word first (my call: mixing two
authors' revisions makes the result unreadable).

### Finding problems

Two kinds of checker, both producing the same *finding* record
(`paragraphId`, exact `quote`, `ruleId`, and either a `replacement` or a
`note`):

**Code checkers** for rules that need no judgment: quotation mark style,
double spaces, dash type in number ranges, ellipsis form, heading style
mapping, page layout, length limits, presence of required sections (abstract,
keywords, declarations), figure and table callout numbering against captions,
file naming, and the anonymization scan (author names the author enters, in
text, notes, acknowledgments and document properties).

**Model checkers** for rules that need reading: heading capitalization,
number and date style in context, abbreviation first use, spelling variety,
italics for titles, block-quotation threshold, citation form, self-citation
in anonymized submissions, and the `other` rules. The Worker sends a passage
(consecutive paragraphs with their ids, sized to the model's context, with a
little overlap) and only the rules relevant to it. The model returns findings
as JSON. It is never asked for the passage back.

Code then guards every model finding:

- the `quote` must occur exactly in the named paragraph, or the finding is
  discarded and counted;
- a `replacement` is accepted only for a `fix` rule, and only if it differs
  from the quote within that rule's allowed kind of edit (for instance, a
  quotation-mark rule may change only quotation marks); otherwise it is
  downgraded to a comment that carries the suggestion;
- duplicates and overlaps are merged, code-checker findings winning.

**References.** Reformatting a reference list is done by a citation engine,
not free-hand. The model parses each entry into CSL-JSON (the Bibliography
Converter's method and prompts are the starting point), `citeproc-js` renders
it in the required style, and the difference is written as a tracked change
with a comment asking the author to check the entry. The tool bundles CSL
styles for the baseline manuals and accepts an uploaded `.csl` file. In-text
citations and notes are checked for form and flagged, not rewritten.

### Writing the result

A JavaScript module in the browser writes the findings into the document:

- `fix` findings as `w:del` / `w:ins` revisions by the author name
  "CAIL Manuscript Desk", preserving run formatting;
- paragraph style changes as tracked paragraph-property changes;
- `flag` findings as Word comments anchored to the quoted text;
- page layout (font, spacing, margins, page numbers) applied directly, because
  Word shows tracked layout changes poorly; each one is listed in the summary
  (my call).

Stefano's Python `tracked.py`
(`~/.claude/skills/jitp-copyediting/scripts/tracked.py`) is the reference for
how these revisions are built; the module is a JavaScript port of the same
approach, extended to footnotes and endnotes.

The To-dos list is shown in the app and downloadable as its own `.docx`
(my call: it is not inserted into the manuscript, which goes to a publisher).
Each To-do names the rule, quotes its source sentence, and, when it has a
place in the text, has a matching comment there. It ends with a summary: what
was fixed by rule and count, what was flagged, what was skipped and why.

**Edited collections.** Each chapter is processed on its own, then a
cross-chapter pass reports inconsistencies (citation style, spelling variety,
heading scheme, note style) and a contributor checklist (bio, abstract,
permissions per chapter) as To-dos for the volume editor.

## The Index Builder

Indexing happens at two moments, so the tool has two stages. They share one
term list, which the author can download and bring back months later.

**Stage 1, at submission: propose the terms.** From the manuscript `.docx`
the model proposes entries, passage by passage: personal names in index form
(`King, Martin Luther, Jr.`), concepts, works, places, organizations, with
variants (`artificial intelligence (AI, machine learning)`), subentries and
`see` / `see also` cross-references. Code merges duplicates across passages
and counts occurrences. The author edits the list: accept, drop, merge,
rename, add. The term-list syntax of the current tool stays valid, so an
existing list still works.

**Stage 2, at proofs: build the index.** From the typeset PDF, the existing
matcher (`extract.js` and `indexer.js` from book-index, with MuPDF in a Web
Worker) finds every occurrence with real page numbers. The model then helps
where the current tool leaves hand work:

- identifying the bibliography, notes and front-matter pages so the author can
  exclude them in one click;
- judging ambiguous hits in context (`Bush` the president or the shrub,
  `Turkey`) for terms the author marks or the tool detects as ambiguous;
- sorting hits into the author's subentries;
- collapsing consecutive pages into ranges.

Output is the index formatted to the press's conventions (indented or run-in,
page-range style, letter-by-letter or word-by-word sorting), taken from the
rule sheet when the Formatter was used, as plain text and as `.docx`.

Without a model call the tool still works as book-index does today; the model
steps are additions, and each can be skipped.

The public book-index on stefanomorello.com is unchanged. Its matching code is
copied into this suite with its tests (both are GPL-3.0; MuPDF.js is AGPL-3.0,
so this repository stays public with complete source).

## How it is built

One repository, one Worker, one Doorway mount (my call: each mount needs its
own Doorway change, and the two tools share the rule sheet, the `.docx`
reader, the model plumbing and the sign-in handling).

- Worker `cail-manuscript`, audience `cail:manuscript`, mounted at
  `/manuscript/`, launch path `/launch/manuscript`.
- Pages: `/manuscript/` (choose a tool), `/manuscript/format/`,
  `/manuscript/index/`.
- Worker routes, all `POST` with JSON unless noted, all authenticated except
  health: `GET /health`, `GET /api/session`, `GET /api/models`,
  `GET /api/quota`, `/api/rules` (guidelines text to rules for one category
  group), `/api/review` (one passage plus rules to findings),
  `/api/references` (entries to CSL-JSON), `/api/index/terms` (passage to
  proposed terms), `/api/index/judge` (hits in context to decisions).
  Prompts and JSON schemas live on the server. Bodies and deadlines are
  bounded; the browser's abort reaches the Gateway call.
- The browser holds all state for a job. The Worker is stateless: no database,
  no object storage, nothing kept after a response.
- Browser modules, each testable in Node without a browser: `docx-read`,
  `docx-write` (revisions and comments), `rules` (schema, baselines, merge,
  quotation check), `checkers` (code checkers), `findings` (guards, merge),
  `references` (citeproc), `chunk` (passage sizing), `index-terms`, plus the
  copied `extract` and `indexer`.
- No UI framework, as in the Bibliography Converter; esbuild for bundling;
  Node's test runner.

**Models.** The menu lists Gateway-recommended text models with at least
32,000 tokens of context. Rule extraction and reference parsing default to the
strongest recommended model; passage review defaults to a cheaper one. Before
a long job the app shows the number of passages and lets the author pick the
model; quota is shown from `/api/quota` and is display only.

Cost target (my call): a 100,000-word monograph reviewed on the default
passage model for under $5, a tenth of the current $50 per 30 days personal
limit. To hold that, each passage is sent once, carrying all the model rules
relevant to it, not once per rule or category. The catalog has no price or
strength field, so defaults follow the catalog's own `tier` and `order`:
extraction and reference parsing use the first recommended row of the top
tier, passage review the first recommended row of the next tier down, and the
builder confirms both against the live catalog and a measured run on a sample
chapter before fixing them.

**Failure handling.** A passage that fails is retried only when the Gateway
says to, then marked failed; the job continues, and the summary lists failed
passages so the author knows which pages were not reviewed. A partial result
is always downloadable. A lost session (`401`) must not cost the author paid work.
The rule sheet and the findings so far are kept in the browser's IndexedDB,
keyed by a hash of the file; the file itself is not. After signing in again
the author picks the same file and the job resumes without repeating
finished passages. This local copy is deleted on download, on "Clear", or
after 24 hours (my call).

**Privacy statement on the page.** The file is opened in the browser and is
not uploaded. Passages of text are sent through the CUNY AI Lab Gateway to
open-weight models under no-retention terms. Nothing is stored on the
server. Work in progress is kept in this browser only, and cleared when the
job is downloaded.

## Testing and acceptance

- Unit tests for every browser module and the Worker handler, following the
  Bibliography Converter's `tests/` (including the workerd test that fails on
  a global fetch to the tools hostname, and the release-verifier test).
- `.docx` round-trip fixtures: documents with footnotes, comments, images,
  tables, mixed run formatting and fields go through read, write, and are
  checked for (a) valid XML and package structure, (b) text identical to the
  input after rejecting all revisions, (c) expected text after accepting all.
  Accept and reject are implemented as test helpers.
- **Generality set.** At least eight real guideline documents covering all
  three document types and at least three citation systems, each with a
  hand-checked expected rule sheet. A script runs extraction against them
  through a real Gateway model and reports, per document, rules found, rules
  missed, and rules dropped by the quotation check. This is how "works with
  any guidelines" is measured; it runs on demand, not in CI, because it
  spends budget. Stefano supplies or approves the eight; Fable drafts the
  expected rule sheets and Stefano corrects them. Pass bar (my call): at
  least 90 percent of expected rules found across the set, and no document
  below 80 percent. Rules wrongly attributed to the publisher are already
  impossible, because of the quotation check. Guideline texts and real
  manuscripts are copyrighted or unpublished, so they are read from a private
  folder outside the repository and never committed; fixtures in the
  repository are documents written for the tests.
- Manual acceptance before release: one real article and one real book
  chapter through the Formatter, the output opened in Microsoft Word with no
  repair prompt; one real proof PDF through the Index Builder.

## Build order

Each step ends with something usable.

1. Skeleton: Worker, sign-in handling, Gateway binding, model menu, health,
   release verifier, CI. Copied in shape from the Bibliography Converter.
2. Rule sheet: schema, baselines, extraction, quotation check, review screen,
   download and upload.
3. Report (approach C): `.docx` reader, code checkers, model checkers,
   finding guards, findings and To-dos shown in the app.
4. Marked-up file: the `.docx` writer, comments, To-dos document.
5. References through CSL.
6. Edited collections: several files, cross-chapter pass.
7. Index Builder, stage 2 first (the port of book-index with the model
   helpers), then stage 1.

Fable writes the implementation plan; Opus agents implement it.

## Decisions made for Stefano to check

- Name "Manuscript Desk", Worker `cail-manuscript`, path `/manuscript/`.
- One Worker and one mount for both tools.
- Guidelines by upload or paste only in version 1. Fetching an arbitrary URL
  from a Worker inside the Lab's zone needs a guarded fetcher and an allowed
  host list, which does not fit "any publisher". Earlier in conversation I
  said a URL would work; this narrows it.
- Rule sheets are downloaded and uploaded as files in version 1. A shared
  library for common publishers needs storage, moderation and a retention
  policy; it is worth doing after the generality set shows extraction is
  reliable.
- Page layout is applied directly and listed, not tracked.
- The To-dos list is a separate document.
- Input with unresolved tracked changes is refused.
- Text inside live fields is never edited.
- Baselines are small (checker rules only) and spot-checked by Stefano.
- Cost target of under $5 per monograph; default models by catalog tier.
- Generality pass bar of 90 percent; real guidelines and manuscripts stay out
  of the repository.
- Unfinished work is kept in the browser for up to 24 hours so a sign-in
  round trip does not repeat paid passages.

## Open, for Stefano

- **Repository owner and license.** The Bibliography Converter lives under
  `smorello87` and is GPL-3.0. The MuPDF dependency requires AGPL-compatible
  terms and public source either way. Draft assumption: `smorello87/manuscript-desk`,
  GPL-3.0, public.
- **The generality set.** Which eight or more guideline documents.

## Left to the builder

File layout inside the repository, prompt wording, the exact JSON schemas,
passage sizes, the checker list beyond those named, UI layout and styling
(following the Lab's existing tools), and the choice of zip and XML libraries.

## Not part of this build

Deployment. Going live needs a Doorway route change in
`CUNY-AI-Lab/cail-tools-admission` (as PR #382 did for the Bibliography
Converter), the verifier key and bindings installed, a catalog entry on the
Lab website, and a signed-in acceptance run. That is a separate, explicitly
requested step after the source is ready.
