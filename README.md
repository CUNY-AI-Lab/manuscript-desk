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
npm run dev                     # build and serve dist/ at http://127.0.0.1:8000/manuscript/ (pages only, no API)
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
- `scripts/`: build, vendoring, local server, release check and the extraction measurement.
- `tests/`: Node tests; fixtures are text written for the tests, never real guidelines or manuscripts. `tests/fixtures/catalog-2026-11-09.json` is a copy of the public Gateway model catalog.

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

## Licence

GNU Affero General Public License v3.0 only (see `LICENSE`). Because the tool is offered over a network, anyone who uses it is entitled to its complete source under the terms of that licence.

This suite includes [MuPDF.js](https://mupdf.readthedocs.io/) by Artifex Software, Inc., which is licensed under the GNU AGPL v3.0 or later. Its licence is copied to `web/vendor/mupdf/LICENSE` and served with it from `vendor/mupdf/`.

Developed for the CUNY AI Lab.
