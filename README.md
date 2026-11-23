# Manuscript Desk

A CUNY AI Lab tool suite that prepares a finished manuscript for a publisher's or journal's submission guidelines. It reads the guidelines into a rule sheet that the author reviews, applies the mechanical changes as Word tracked changes, and lists what only the author can supply. It has two tools: the Formatter and the Index Builder.

It is for CUNY AI Lab members, behind CUNY Login, at `https://tools.ailab.gc.cuny.edu/manuscript/`.

## Privacy

The file is opened in the browser and is not uploaded. Passages of text are sent through the CUNY AI Lab Gateway to open-weight models under no-retention terms. Nothing is stored on the server. Work in progress is kept in this browser only, and is cleared when you choose Start over or after 24 hours.

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

A browser smoke test of the built Formatter page, with the API mocked by request interception, lives in `tests/browser/` and is not part of `npm test` or `npm run check`. Playwright is not a dependency; point the script at any copy of it:

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

This builds `dist/` and serves it with the Worker's real routes at `http://127.0.0.1:8787/manuscript/format/` (`PORT` sets another port). The Formatter works as in production: the model menu and allowance load, and reading guidelines makes real model calls through the public CAIL Gateway. Every call is charged to the key in `CAIL_API_KEY`, so it spends the key owner's own model allowance; the allowance shown is that key's.

Sign-in is simulated. The server makes a throwaway signing key when it starts and signs both identity assertions for one fixed local person on every request, so there is no CUNY Login; it drops any credential the browser sends and puts the key on the Gateway calls instead. It listens on 127.0.0.1 only, answers only requests addressed to `localhost` or `127.0.0.1` on its port, and accepts a POST only from its own pages. It logs one line per API request (method, path, status, milliseconds), never a body, and never prints the key. Without `CAIL_API_KEY` the pages are served but model calls fail.

This mode exists only in the dev script (`scripts/dev.mjs`, `scripts/dev-server.mjs`). The deployed Worker is unchanged: it has no key path and accepts no local origin.

## Measuring rule extraction

`scripts/generality.mjs` measures how well the rule sheet comes out of real publishers' guidelines with real models. It runs the product's own reading, prompt, model controls and extraction code, calls the Gateway at `https://tools.ailab.gc.cuny.edu/v1/chat/completions` directly, and checks each sheet against rules we have written down as expected.

```bash
CAIL_API_KEY=... npm run generality -- --models deepseek-v4.1-flash-1017,other-model [--only <folder>] [--all [--doc-type article]]
```

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

By default only scored cases run. `--all` also runs every other supported file as its own unscored case (a monograph unless `--doc-type` says otherwise), reported with counts only; `--only <folder>` runs one subfolder. Output goes to stdout: per model, one row per case with rules kept, left out, expected found, failed calls and seconds, then totals, cost, PASS or FAIL and the names of missed expected rules. It never prints guideline text, quotations or rule statements, and writes nothing to disk.

## Measuring paragraph roles

`scripts/roles-eval.mjs` measures how well the paragraphs of a real manuscript are labelled with their roles (title block, heading, block quotation, verse, bibliography entry, body and so on), against roles set by hand. It runs the product's own `.docx` reader (`lib/docx/read.js`), passages and labelling run (`lib/roles/`) and the payload `POST /manuscript/api/roles` sends, through the public Gateway with the key in `CAIL_API_KEY`:

```bash
CAIL_API_KEY=... npm run roles-eval -- --chapters dev [--model <id>] [--case <folder>]
```

A case is a folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES` with `source.docx` and `gold-roles.json`. The script prints accuracies, counts and confusion tallies only, never manuscript text, and writes nothing to disk. The measured runs, the held-out result and the remaining confusions are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## Measuring formatting

`lib/format/format.js` turns a manuscript's `.docx`, its paragraph roles and a rule sheet into a new `.docx` in which structure is carried by named paragraph styles instead of direct formatting: one style per role (with a no-indent variant for the first paragraph after a heading or a quotation, and separate styles for a title block's title, subtitle, author and affiliation), empty spacer paragraphs removed, each chapter its own Word section when notes restart in every chapter, heading numbers through Word numbering and figure placement markers when the sheet asks for them. It keeps runs, note references, links, images, tables, fields and the character formatting that carries meaning, and declares every change to the text with the words it removed and added and the paragraphs it was made at. The changes to words (a title split at its colon, a rewritten figure marker, an added caption line) are tracked insertions and deletions by "CAIL Manuscript Desk"; style changes are direct. `lib/docx/validate.js` checks the structure of the file it writes, its comments and its tracked changes.

`scripts/format-eval.mjs` measures it against a formatting job done by hand:

```bash
npm run format-eval -- [--predicted] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--pdf]
```

A case is a folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES` with `source.docx`, `gold-roles.json` and the hand-formatted `.docx` in `reference/`. The script formats the source with the gold roles (or, with `--predicted`, roles from the labelling stage) and a rule sheet (`hand` is a short sheet written for the case, `extracted` the product's own extraction from the publisher's guidelines), then prints counts only: paragraphs matched to the reference by their text, style agreement through the committed map in `docs/eval/brill-style-map.json`, sections, words (any change no declaration explains is a failure, and rejecting every tracked change must give back the source's words), the elements carried over, and the validator's result. The output and any model answer are written to the case's `work/` folder and model answers are reused from there, so nothing is paid for twice; model calls, made only when a cache is missing, use the key in `CAIL_API_KEY`. With `--pdf` it also converts the output with LibreOffice, if installed, to see that it opens. The measured runs are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## The To-dos

`lib/checks/` reads the paragraph model, the roles, the formatter's report and the rule sheet and returns findings, each with its kind, chapter, paragraph, rule and a message that says, in plain words, what is left to do. A check runs only when a rule in the sheet asks for what it checks (quotation marks kept out of chapter titles, abstracts and keywords, a running title's length, permissions, alt texts, and so on) or when it concerns a change the formatter made that the author must verify (a split title, joined quotation lines, added heading numbers); the checks that did not run are listed with what each needed. The findings become Word comments in the formatted file (`lib/docx/comments.js`, one per place, with a general comment at the top that counts what the pass changed) and the To-dos list, its own `.docx` (`lib/todos/todos.js`): every finding by chapter and kind, each naming its rule and quoting the guideline sentence; the requirements only the author can supply; and a summary of what was changed, flagged and skipped. Companion documents are made only when a rule asks for them (`lib/todos/companions.js`): abstracts and keywords per chapter, an alt-text template with every figure by number, running titles (proposed by a model through `POST /manuscript/api/running-titles`, kept only when they fit and use the title's own words) and a checklist of the sheet's requirements with a status for each.

`scripts/todos-eval.mjs` measures them against the comments of a job done by hand:

```bash
npm run todos-eval -- [--predicted] [--sheet hand|extracted|<file>] [--chapters dev|holdout|all] [--running-titles]
```

A case needs, besides the files above, a private answer key of the reference's comments in its `work/` folder (`comments-key.json`: chapter, paragraph, kind and class of each comment; `companions-key.json` for the companion documents). The script runs the product on the source and prints counts only: of the key's comments in each class (`structure`, `reading`, `human`), how many the tool produced (same kind, same chapter, within two paragraphs with text), the misses and the extra findings by kind, how the companion documents line up with the reference's, and the output's validity. The outputs go to `work/`. It makes no model call, except with `--running-titles` when the proposals are not cached, with the key in `CAIL_API_KEY`. The measured runs are in [`docs/eval/brill-loop.md`](docs/eval/brill-loop.md).

## Licence

GNU Affero General Public License v3.0 only (see `LICENSE`). Because the tool is offered over a network, anyone who uses it is entitled to its complete source under the terms of that licence.

The `.docx` reader uses [fflate](https://github.com/101arrowz/fflate) (MIT) to unzip the file and [saxes](https://github.com/lddubeau/saxes) (ISC, with xmlchars, MIT) to parse its XML; both licences are compatible with the AGPL.

This suite includes [MuPDF.js](https://mupdf.readthedocs.io/) by Artifex Software, Inc., which is licensed under the GNU AGPL v3.0 or later. Its licence is copied to `web/vendor/mupdf/LICENSE` and served with it from `vendor/mupdf/`.

Developed for the CUNY AI Lab.
