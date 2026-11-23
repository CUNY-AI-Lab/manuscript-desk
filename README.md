# Manuscript Desk

A CUNY AI Lab tool suite that prepares a finished manuscript for a publisher's or journal's submission guidelines. It reads the guidelines into a rule sheet that the author reviews, applies the mechanical changes as Word tracked changes, and lists what only the author can supply. It has two tools: the Formatter and the Index Builder.

It is for CUNY AI Lab members, behind CUNY Login, at `https://tools.ailab.gc.cuny.edu/manuscript/`.

## Privacy

The file is opened in the browser and is not uploaded. Passages of text are sent through the CUNY AI Lab Gateway to open-weight models under no-retention terms. Nothing is stored on the server. Work in progress is kept in this browser only, and cleared when the job is downloaded.

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
- `scripts/`: build, vendoring, local server and release check.
- `tests/`: Node tests; fixtures are text written for the tests, never real guidelines or manuscripts. `tests/fixtures/catalog-2026-11-09.json` is a copy of the public Gateway model catalog.

## Licence

GNU Affero General Public License v3.0 only (see `LICENSE`). Because the tool is offered over a network, anyone who uses it is entitled to its complete source under the terms of that licence.

This suite includes [MuPDF.js](https://mupdf.readthedocs.io/) by Artifex Software, Inc., which is licensed under the GNU AGPL v3.0 or later. Its licence is copied to `web/vendor/mupdf/LICENSE` and served with it from `vendor/mupdf/`.

Developed for the CUNY AI Lab.
