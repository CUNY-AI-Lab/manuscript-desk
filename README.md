# Manuscript Desk

A CUNY AI Lab tool suite that prepares a finished manuscript for a publisher's or journal's submission guidelines. It reads the guidelines into a rule sheet that the author reviews, applies the mechanical changes as Word tracked changes, and lists what only the author can supply. It has two tools: the Formatter and the Index Builder.

It is for CUNY AI Lab members, behind CUNY Login, at `https://tools.ailab.gc.cuny.edu/manuscript/`.

## Privacy

Your files are opened in the browser and are not uploaded. To read the guidelines and to label the manuscript's paragraphs, passages of their text are sent through the CUNY AI Lab Gateway to open-weight models under no-retention terms; when the rule sheet asks for running titles, the chapter titles are sent the same way; and when the author chooses the reading check in step 6, the title block, abstract, keywords, headings and the first pages of each chapter's text, the notes on contributors and the front matter (title page and contents list) are sent the same way. The manuscript is formatted in the browser. Nothing is stored on the server. The browser keeps the guidelines' text, the rule sheet, the paragraph labels and the author's corrections to them, but not the manuscript or its text, and clears them on Start over or after 24 hours.

## The Formatter page

`/manuscript/format/` takes a scholar from guidelines to finished files in six steps:

1. What is being submitted: an article, a monograph or an edited collection.
2. The guidelines: PDF or Word files, or pasted text, read in the browser.
3. The rule sheet read out of them (`POST /manuscript/api/rules`, each part read once per group of categories; then each part is asked once, through `POST /manuscript/api/settings`, about the settings that reading did not fill, with the sentence that states each, and about the sentences of the part that read as requirements and that no reading quoted, a short list item counting as one when the sentence introducing its list asks something, and shown with that sentence), each rule with the sentence it came from, to edit, switch off, add to, download or load. A call the Gateway refuses for its rate limit is asked again after a pause, a few times.
4. The manuscript: one `.docx`, read in the browser (`lib/docx/read.js`) and held in the page's memory only, with its size in words and paragraphs.
5. What each paragraph is: "Read the manuscript" labels the paragraphs through `POST /manuscript/api/roles`, stating the number of model calls first, with progress and Stop. The review shows, by chapter (with the front and back matter, such as a contents list or notes on contributors, as groups of their own), the paragraphs that are not body text or bibliography entries (those the model could not label first), each with an excerpt, its label in a menu the scholar can change and its neighbours on demand; a filter shows every paragraph or one kind, with counts. The labels are kept in the browser by a hash of the file, with the corrections; after a reload or a sign-in the scholar chooses the same file again and nothing is labelled again (a stopped run resumes from the passages already answered), while another file is labelled from the start.
6. Format and download: the formatter, the To-do checks, the comments, the To-dos list and the companion documents run in the browser (`web/format/output-state.js`), running titles are asked of `POST /manuscript/api/running-titles` only when the rule sheet calls for them, and every file offered has passed the structural validator. An optional reading check, which states its number of model calls (one per chapter) before it is chosen, sends each chapter's opening to `POST /manuscript/api/reading` for the queries an editor would make (the same thing named two ways, a name or affiliation that differs, missing spaces, typing slips, stray text, an abstract out of line with the guidelines); a query is kept only when the words it quotes are in the paragraph it names, and it becomes a comment and a To-dos entry marked as a model's proposal, never a change. A summary says what was changed, with counts, what was flagged, and what the author still has to supply.

The page's decisions are pure functions that load under Node (`web/format/app.js` for steps 1 to 3, `manuscript-state.js` for 4 and 5, `output-state.js` for 6) and are unit-tested; `manuscript-step.js` and `output-step.js` draw steps 4 to 6. Every text from the manuscript, the guidelines or a model is set with `textContent`, which `tests/html-sinks.test.mjs` enforces.

## How it runs

It is a Cloudflare Worker (`server/worker.js`) with static assets built into `dist/`. The Worker has no public address of its own: the portal (CAIL Doorway) handles sign-in and access, then forwards two signed identity assertions over a service binding. The Worker verifies both and calls models through the CAIL Gateway, which it reaches only through its `GATEWAY` service binding.

## Develop

Requires Node.js 22.

```bash
npm ci                          # CAIL packages are public on npm; no token needed
npm run vendor                  # copy MuPDF from node_modules into web/vendor/mupdf (git-ignored)
npm run check                   # vendor, syntax checks, all tests, then the build into dist/
npm test                        # tests only
npm run build                   # build dist/ (needs npm run vendor first)
npm run dev                     # build, then serve the pages and the Worker's routes at http://127.0.0.1:8787/manuscript/ (see below)
node scripts/verify-release.mjs # check wrangler.toml keeps the Worker private and bound to the Gateway
npx wrangler deploy --dry-run --outdir /tmp/cail-manuscript-dry   # offline bundle check
```

The tests stub every upstream and never call a model.

A browser smoke test of the built Formatter page, with the API mocked by request interception, lives in `tests/browser/` and is not part of `npm test` or `npm run check`. It goes through all six steps, choosing the invented manuscripts in `tests/fixtures/` (written by `node tests/fixtures/make-manuscripts.mjs`), and checks that every download is a valid Word file. Playwright is not a dependency; point the script at any copy of it:

```bash
npm run build
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node tests/browser/formatter-smoke.mjs
```

It uses Playwright's own Chromium if installed, otherwise the installed Google Chrome. `tests/workerd.test.mjs` runs the bundled Worker in real workerd through Miniflare.

Layout:

- `server/worker.js`: the Worker routes.
- `web/`: the pages. `web/vendor/mupdf/` is written by `npm run vendor`.
- `lib/`: the browser modules, testable in Node: `guidelines/` and `rules/` (the rule sheet), `docx/` (the manuscript reader, the package writer, the comments writer, a builder for new documents and the structural validator), `roles/` (paragraph roles), `format/` (the formatting stage), `checks/` (the To-do checks) and `todos/` (the To-dos list and the companion documents).
- `scripts/`: build, vendoring, local test server, release check and the extraction, roles, formatting and To-dos measurements.
- `tests/`: Node tests; fixtures are text written for the tests, never real guidelines or manuscripts. `tests/fixtures/catalog-2026-11-09.json` is a copy of the public Gateway model catalog.

## Try it locally with real models

```bash
CAIL_API_KEY=sk-cail-... npm run dev
```

This builds `dist/` and serves it with the Worker's real routes at `http://127.0.0.1:8787/manuscript/format/` (`PORT` sets another port). The Formatter works as in production, through all six steps: the model menu and allowance load, and reading the guidelines, labelling the manuscript and proposing running titles make real model calls through the public CAIL Gateway (a book of 1,460 paragraphs took 85 labelling calls and under five minutes). Every call is charged to the key in `CAIL_API_KEY`, so it spends the key owner's own model allowance; the allowance shown is that key's.

Sign-in is simulated. The server makes a throwaway signing key when it starts and signs both identity assertions for one fixed local person on every request, so there is no CUNY Login; it drops any credential the browser sends and puts the key on the Gateway calls instead. It listens on 127.0.0.1 only, answers only requests addressed to `localhost` or `127.0.0.1` on its port, and accepts a POST only from its own pages. It logs one line per API request (method, path, status, milliseconds), never a body, and never prints the key. Without `CAIL_API_KEY` the pages are served but model calls fail.

This mode exists only in the dev script (`scripts/dev.mjs`, `scripts/dev-server.mjs`). The deployed Worker is unchanged: it has no key path and accepts no local origin.

## Measuring rule extraction

`scripts/generality.mjs` measures how well the rule sheet comes out of real publishers' guidelines with real models. It runs the product's own reading, prompt, model controls and extraction code, calls the Gateway at `https://tools.ailab.gc.cuny.edu/v1/chat/completions` directly, and checks each sheet against rules we have written down as expected.

```bash
CAIL_API_KEY=... npm run generality -- --models deepseek-v4.1-flash-1017,other-model [--only <folder>] [--all [--doc-type article]] [--repeat <n>] [--save <folder>]
```

`--repeat <n>` reads each case n times and adds, per case, a table of the rule sheet's settings: in how many runs each was filled and with which values (a text value, such as a font name or a marker's example, only as a label), and how many were filled in every run. `--save <folder>` writes each rule sheet as JSON to that folder, which must be outside the repository, since a sheet quotes the guidelines. `--record <folder>` writes every model answer, with the request it answered, to that folder (outside the repository too), and `--replay <folder>` scores again from such a recording without calling the Gateway.

Every call is charged to the key in `CAIL_API_KEY`, so a run spends your own model budget; the script reports the tokens used and their cost from the public model catalog. The key is read only from that variable and never printed.

Real guidelines stay outside the repository. The script reads the folder named by `MANUSCRIPT_DESK_GUIDELINES` (default `../manuscript-desk-guidelines`, next to this checkout), with one subfolder per publisher holding its guideline files (PDF, `.docx`, `.html`, `.txt`), possibly in further subfolders. A subfolder with an `expected.json` is a scored case:

```json
{
  "docType": "monograph",
  "files": ["author-guide.pdf", "style/finalizing.docx"],
  "rules": [{ "name": "alt texts for all images", "any": ["ALT-texts for all images"] }]
}
```

`files` (paths relative to that subfolder) lists the documents read together as one set of guidelines; without it, every supported file directly in the subfolder is used. A rule counts as found when any of its `any` strings occurs, ignoring case, quote style and dashes, in an extracted rule's quotation or statement. A model passes when it finds at least 90 percent of all expected rules and at least 80 percent in every case; the script exits non-zero unless every model passes.

By default only scored cases run. `--all` also runs every other supported file as its own unscored case (a monograph unless `--doc-type` says otherwise), reported with counts only; `--only <folder>` runs one subfolder. Output goes to stdout: per model, one row per case with rules kept, left out, expected found, failed calls, calls made and seconds, then totals, cost, the number of settings questions and of calls the Gateway refused, PASS or FAIL, the names of missed expected rules and the settings each case's questions filled. It never prints guideline text, quotations or rule statements, and writes nothing to disk unless `--save` or `--record` is given.

## Measuring paragraph roles

`scripts/roles-eval.mjs` measures how well the paragraphs of a real manuscript are labelled with their roles (title block, heading, block quotation, verse, bibliography entry, body and so on), against roles set by hand. It runs the product's own `.docx` reader (`lib/docx/read.js`), passages and labelling run (`lib/roles/`) and the payload `POST /manuscript/api/roles` sends, through the public Gateway with the key in `CAIL_API_KEY`:

```bash
CAIL_API_KEY=... npm run roles-eval -- --chapters dev [--model <id>] [--case <folder>] [--save <file>]
```

A case is a folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES` with `source.docx` and `gold-roles.json`; the gold may list spans of front and back matter outside the chapters (`matter`), which `--chapters dev` and `all` measure and report apart. The script prints accuracies, counts and confusion tallies only, never manuscript text. It caches every model answer in the case's `work/roles-answers.json`, so a re-score pays for nothing it asked before, and `--save <file>` writes the roles it labelled. The measured runs, the held-out result and the remaining confusions are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## Measuring formatting

`lib/format/format.js` turns a manuscript's `.docx`, its paragraph roles and a rule sheet into a new `.docx` in which structure is carried by named paragraph styles instead of direct formatting: one style per role (with a no-indent variant for the first paragraph after a heading or a quotation, and separate styles for a title block's title, subtitle, author and affiliation), empty spacer paragraphs removed, each chapter its own Word section when notes restart in every chapter, heading numbers through Word numbering and figure placement markers when the sheet asks for them. It keeps runs, note references, links, images, tables, fields and the character formatting that carries meaning, and declares every change to the text with the words it removed and added and the paragraphs it was made at. The changes to words (a title split at its colon, a rewritten figure marker, an added caption line) are tracked insertions and deletions by "CAIL Manuscript Desk"; style changes are direct. `lib/docx/validate.js` checks the structure of the file it writes, its comments and its tracked changes.

`scripts/format-eval.mjs` measures it against a formatting job done by hand:

```bash
npm run format-eval -- [--predicted | --roles <file>] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--score <file>] [--pdf]
```

`--roles` takes the roles from a file (as the Formatter page keeps them), and `--score` measures a formatted file made elsewhere, such as a download from the page: the script formats the source with the same roles and sheet, checks that the file has the same paragraphs, text and styles, and measures that file.

A case is a folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES` with `source.docx`, `gold-roles.json` and the hand-formatted `.docx` in `reference/`. The script formats the source with the gold roles (or, with `--predicted`, roles from the labelling stage) and a rule sheet (`hand` is a short sheet written for the case, `extracted` the product's own extraction from the publisher's guidelines), then prints counts only: paragraphs matched to the reference by their text, style agreement through the committed map in `docs/eval/brill-style-map.json`, sections, words (any change no declaration explains is a failure, and rejecting every tracked change must give back the source's words), the elements carried over, and the validator's result. The output and any model answer are written to the case's `work/` folder and model answers are reused from there, so nothing is paid for twice; model calls, made only when a cache is missing, use the key in `CAIL_API_KEY`. With `--pdf` it also converts the output with LibreOffice, if installed, to see that it opens. The measured runs are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## Measuring how the file looks

Style names agreeing with a hand-formatted file is not the same as the file looking like it. `scripts/render-eval.mjs` compares what a reader sees, without Word:

```bash
npm run render-eval -- <tool.docx> <reference.docx> [--case <folder>] [--pdf word|soffice --pdf-dir <folder>] [--pdfs <a.pdf>,<b.pdf>] [--json <file>]
```

`lib/docx/appearance.js` resolves each paragraph's effective formatting through the document defaults (with theme fonts), the style hierarchy, numbering and direct formatting: the font and size most of its text is set in, line spacing, space before and after, indents and alignment. The script matches the two files' paragraphs by their text (as `format-eval` does) and reports agreement per property, dev and holdout chapters apart when `--case` names a case (the source paragraph each paragraph came from gives its chapter), with the differences grouped into classes ("line: 2 -> 1.5 (reference Body Text): 328"); the same for the notes; each file's sections (page size, margins, note numbering, where the page number stands on a section's first page and on the others, and its font) and, by chapter, whether they agree; and the Latin text set in a font that is not the body's (East Asian and complex-script text takes the fonts made for it; symbol and code fonts are not counted), in the body, the notes and the headers and footers. With `--pdf` it exports both files with Microsoft Word (through AppleScript) or LibreOffice into a folder of its own and reports page counts and the characters set in each font of the PDFs (read with MuPDF); `--pdfs` reads PDFs made already. It prints counts, style names, font names and measurements only, never text.

## The To-dos

`lib/checks/` reads the paragraph model, the roles, the formatter's report and the rule sheet and returns findings, each with its kind, chapter, paragraph, rule and a message that says, in plain words, what is left to do. A check runs only when a rule in the sheet asks for what it checks (quotation marks kept out of chapter titles, abstracts and keywords, a running title's length, permissions, alt texts, and so on) or when it concerns a change the formatter made that the author must verify (a split title, joined quotation lines, added heading numbers); the checks that did not run are listed with what each needed. Two checks compare the front matter with the chapters: the manuscript's own contents list against the chapter titles and authors actually present (a chapter missing from it, a line that matches nothing, a title or name worded differently, authors in another order), and the notes on contributors against the chapters' authors (an author with no note, a note on no author, a name spelled differently, an affiliation the note does not give, a note far from the length asked). The findings become Word comments in the formatted file (`lib/docx/comments.js`, one per place, with a general comment at the top that counts what the pass changed) and the To-dos list, its own `.docx` (`lib/todos/todos.js`): every finding by chapter and kind, each naming its rule and quoting the guideline sentence; the requirements only the author can supply; and a summary of what was changed, flagged and skipped. Companion documents are made only when a rule asks for them (`lib/todos/companions.js`): abstracts and keywords per chapter, an alt-text template with every figure by number, running titles (proposed by a model through `POST /manuscript/api/running-titles`, kept only when they fit and use the title's own words) and a checklist of the sheet's requirements with a status for each.

`scripts/todos-eval.mjs` measures them against the comments of a job done by hand:

```bash
npm run todos-eval -- [--predicted | --roles <file>] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--running-titles] [--reading dev|holdout|all]
```

A case needs, besides the files above, a private answer key of the reference's comments in its `work/` folder (`comments-key.json`: chapter, paragraph, kind and class of each comment; `companions-key.json` for the companion documents). The script runs the product on the source and prints counts only: of the key's comments in each class (`structure`, `reading`, `human`), how many the tool produced (same kind, same chapter, within two paragraphs with text), the misses and the extra findings by kind, how the companion documents line up with the reference's, and the output's validity. The outputs go to `work/`. It makes no model call, except with `--running-titles` when the proposals are not cached, and with `--reading`, which runs the reading check on the dev, holdout or all chapters (answers cached in `work/reading-answers.json`), with the key in `CAIL_API_KEY`. The reading check's kept findings, with their quotations, go to the private `work/reading-findings-<tag>.json` for review; stdout gets their counts by place and kind. The measured runs are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## Licence

GNU Affero General Public License v3.0 only (see `LICENSE`). Because the tool is offered over a network, anyone who uses it is entitled to its complete source under the terms of that licence.

The `.docx` reader uses [fflate](https://github.com/101arrowz/fflate) (MIT) to unzip the file and [saxes](https://github.com/lddubeau/saxes) (ISC, with xmlchars, MIT) to parse its XML; both licences are compatible with the AGPL.

This suite includes [MuPDF.js](https://mupdf.readthedocs.io/) by Artifex Software, Inc., which is licensed under the GNU AGPL v3.0 or later. Its licence is copied to `web/vendor/mupdf/LICENSE` and served with it from `vendor/mupdf/`.

Developed for the CUNY AI Lab.
