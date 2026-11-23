# Manuscript Desk, Plan 1: Foundation and Rule Sheet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in CUNY AI Lab member can give the tool a publisher's guidelines and get a reviewed, editable, downloadable rule sheet in which every rule quotes the guidelines verbatim.

**Architecture:** One Cloudflare Worker (`cail-manuscript`) serves static pages and a small JSON API behind CAIL Doorway; it is stateless and reaches models only through the `GATEWAY` service binding. The browser reads the guidelines file, sends its text to the Worker in groups, and validates, quote-checks, merges and displays the rules with pure modules that also run under Node tests.

**Tech Stack:** JavaScript ES modules, no UI framework, esbuild 0.25.9, wrangler 4.130.0, Node 22 test runner, `@cuny-ai-lab/cail-client` 6.3.0, `@cuny-ai-lab/cail-identity` 5.2.6, `mammoth` 1.11.0, `mupdf` 1.28.1 (WebAssembly, vendored).

**Spec:** `docs/superpowers/specs/2026-11-22-manuscript-desk-design.md`. This plan covers build-order steps 1 and 2. Later plans: 2 Report (reader, checkers, baselines), 3 Marked-up file, 4 References, 5 Edited collections, 6 Index Builder.

**Pattern to copy:** the Bibliography Converter at `/Users/veritas44/Downloads/github/biblio-zotero`. Its working tree is on an old branch; always read with `git -C /Users/veritas44/Downloads/github/biblio-zotero show origin/main:<path>`. Read-only: never edit that repository. MuPDF vendoring: `/Users/veritas44/Downloads/github/book-index/scripts/vendor-mupdf.mjs`.

## Global Constraints

- License `AGPL-3.0-only`; `LICENSE` holds the AGPL-3.0 text; `package.json` `"private": true`, `"type": "module"`, name `cail-manuscript`.
- Worker name `cail-manuscript`; audience `cail:manuscript`; origin `https://tools.ailab.gc.cuny.edu`; mount path `/manuscript`; launch path `/launch/manuscript`; `workers_dev = false`; `preview_urls = false`.
- Every Gateway call (chat, quota, catalog) goes through `env.GATEWAY.fetch` via `createCailClient({ app: 'manuscript', fetchImpl })`. No global `fetch()` to `tools.ailab.gc.cuny.edu` anywhere in `server/`.
- Both identity legs (`cail:manuscript` and `cail:gateway`) are verified on every route except `GET|HEAD /manuscript/health`.
- `POST` requires header `origin: https://tools.ailab.gc.cuny.edu`.
- The Worker stores nothing and logs no request bodies, prompts, guideline text or identifiers.
- No retries in the Worker. The browser retries a call only when the response header `x-should-retry` is `true`, at most once.
- Model output and guideline text are rendered with `textContent`, never `innerHTML`.
- Default model id `deepseek-v4.1-flash-1017` (changed from `glm-5.3` after measurement during execution); if the menu does not offer it, the first offered row.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, create a remote, or deploy.
- Real publisher guidelines and manuscripts are never committed. Test fixtures are text written for the tests.

## Review Focus

1. **Scanned or empty guidelines PDF.** Expect a plain message asking for pasted text, not an empty rule sheet. Test in Task 7.
2. **Model reply that is valid JSON but quotes text the guidelines never said, or elides with "…".** Expect the invented rule dropped and counted, and an elided quote accepted only when every segment is found in order. Tests in Task 4.
3. **Guidelines that state the same requirement two ways in two places.** Expect both rules kept and marked as a conflict for the author, not one silently chosen. Test in Task 5.
4. **Truncated or non-JSON model reply for one group.** Expect one retry, then that group reported as failed while the other groups' rules are still shown. Test in Task 8.
5. **A rule sheet file uploaded by the author that is malformed, the wrong version, or carries markup in its text.** Expect a clear refusal for the first two and literal text for the third. Tests in Task 3 and Task 9.

---

## File Structure

```
package.json  wrangler.toml  .npmrc  .gitignore  LICENSE  README.md
.github/workflows/ci.yml          check job only (no release job in this plan)
server/worker.js                  createHandler: auth, health, session, quota, catalog, /api/rules
server/model.js                   modelControls(row, expectedOutputTokens)
server/prompts.js                 rulesPrompt({ docType, group })
lib/rules/schema.js               categories, slots, validateRule, validateSheet, newSheet
lib/rules/quote.js                normalizeForMatch, findQuote
lib/rules/merge.js                mergeExtracted, layerSheet
lib/rules/chunk.js                splitGuidelines
lib/rules/extract.js              extractRuleSheet (orchestrates calls, injected transport)
lib/guidelines/read.js            readGuidelines(file) -> { text } | { error }
web/index.html                    suite landing: links to the two tools
web/format/index.html             Formatter page (steps 1 to 3 in this plan)
web/format/app.js                 Formatter UI
web/shared/api.js                 request(), lost-session handling
web/shared/models.js              modelMenu(catalog), chooseModel
web/shared/store.js               saveJob, loadJob, clearJob (IndexedDB, 24 h)
web/shared/pdf-worker.js          MuPDF text extraction off the main thread
web/shared/styles.css
web/vendor/mupdf/                 written by scripts/vendor-mupdf.mjs
scripts/build.mjs  dev.mjs  vendor-mupdf.mjs  verify-release.mjs  generality.mjs
tests/*.test.mjs  tests/fixtures/
```

`lib/` is pure (no DOM, no network) and is imported by both `web/` and tests.

---

### Task 1: Worker skeleton with sign-in, health, session, quota and catalog

**Files:**
- Create: `package.json`, `.npmrc`, `.gitignore`, `LICENSE`, `wrangler.toml`, `server/worker.js`
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Produces: `createHandler({ gatewayFetch, fetchImpl, deadlineMs = 180000 } = {}) -> (request, env) => Promise<Response>`; default export `{ fetch: createHandler() }`.
- Produces error body shape `{ error: { code, message, request_id, launch? } }` with headers `x-should-retry`, `x-cail-request-id`; `launch` is `/launch/manuscript` on every `401`.
- Produces routes: `GET|HEAD /manuscript/health` → `{ status: 'ready', version_id, tag }`; `GET /manuscript/api/session` → `{ authenticated: true }`; `GET /manuscript/api/quota`; `GET /manuscript/api/catalog`; `GET|HEAD /manuscript` → `308` to `/manuscript/`; other `GET|HEAD` → static asset from `env.ASSETS` with the path prefix stripped.

Port `server/worker.js` from the Bibliography Converter, keeping its `AppError`, `json`, `boundedText`, `bodyJSON`, `validateModel`, `verifierConfigs`, `readiness`, `authenticate`, catalog cache, error mapping and response headers. Remove everything about `/api/parse`, `/api/ocr`, `/api/enrich`, `/api/source` and the catalog-lookup cache. Change the constants to the Global Constraints values. `MAX_BODY` is `1024 * 1024`. The Content-Security-Policy is `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.

`wrangler.toml`: as the Bibliography Converter's, with `name = "cail-manuscript"`, the `GATEWAY → cail-model-api` service binding, `CAIL_IDENTITY_ISSUER`, `[assets] directory = "./dist"`, `run_worker_first = true`, `[version_metadata]`, `compatibility_flags = ["enable_request_signal"]`, and no `SCRAPE_HOSTS` or `CATALOG_HOSTS`.

- [ ] **Step 1: Write the failing tests** in `tests/worker.test.mjs`. Build signed test identities the way `tests/worker.test.mjs` on the pattern's `origin/main` does (copy its key-generation and `signedHeaders` helper, changing the audience to `cail:manuscript`). Tests, each asserting status and `error.code`:

```js
test('foreign origin is 404', ...)                          // https://example.org/manuscript/api/session -> 404 not_found
test('no identity leg is 401 with launch path', ...)        // error.code 'authentication_required', error.launch '/launch/manuscript'
test('malformed identity leg is 401 invalid_credential', ...)
test('identity for another audience is 401', ...)           // app leg signed for 'cail:bibliography'
test('gateway leg for a different subject is 401', ...)
test('session returns authenticated for valid legs', ...)   // 200 { authenticated: true }
test('POST without the tools origin header is 403 invalid_origin', ...)
test('quota is read through the injected gateway fetch with the gateway leg', ...) // assert Authorization bearer equals the gateway JWT
test('health is 503 gateway_unavailable when the catalog cannot be read', ...)
test('health is 200 ready without credentials when catalog and assets answer', ...)
test('missing verifier key set is 503 identity_unavailable', ...)
test('unknown api path is 404', ...)
test('static asset is served with the path prefix stripped and the CSP header', ...) // GET /manuscript/format/ -> ASSETS asked for /format/
test('GET /manuscript redirects 308 to /manuscript/', ...)
```

- [ ] **Step 2: Run** `node --test tests/worker.test.mjs`. Expected: FAIL, cannot find `server/worker.js`.
- [ ] **Step 3: Implement** `package.json` (scripts `test`: `node --test tests/*.test.mjs`; dependencies at the Tech Stack versions; devDependencies esbuild, wrangler, mupdf), `.npmrc` (`@cuny-ai-lab:registry=https://registry.npmjs.org`), `.gitignore` (`node_modules`, `dist`, `.wrangler`, `web/vendor`), `LICENSE`, `wrangler.toml`, `server/worker.js`. Run `npm install`.
- [ ] **Step 4: Run** `node --test tests/worker.test.mjs`. Expected: PASS, 14 tests.
- [ ] **Step 5: Commit** `Add the Worker skeleton with sign-in, health, quota and catalog`.

### Task 2: Build, dev server, CI, release verifier, workerd test

**Files:**
- Create: `scripts/build.mjs`, `scripts/dev.mjs`, `scripts/vendor-mupdf.mjs`, `scripts/verify-release.mjs`, `.github/workflows/ci.yml`, `web/index.html`, `web/format/index.html`, `web/shared/styles.css`, `README.md`
- Test: `tests/workerd.test.mjs`, `tests/verify-release.test.mjs`

**Interfaces:**
- Produces: `npm run build` writes `dist/` (`index.html`, `format/index.html`, `format/app.js`, `shared/styles.css`, `shared/pdf-worker.js`, `vendor/mupdf/*`, `LICENSE.txt`); `npm run check` runs `node --check` on `server/worker.js` and each script, then the tests, then the build; `npm run vendor` copies MuPDF from `node_modules/mupdf/dist` into `web/vendor/mupdf` with its `LICENSE` and a `VERSION` file.
- Produces: `verify-release.mjs` exporting `verifyConfig(wranglerToml: string) -> string[]` (a list of problems, empty when good).

Port `scripts/dev.mjs`, `scripts/verify-release.mjs`, `tests/workerd.test.mjs`, `tests/verify-release.test.mjs` and the `check` job of `ci.yml` from the pattern. The `release` job is not ported: deployment is outside this plan. `web/index.html` and `web/format/index.html` are minimal valid pages for now (title "Manuscript Desk", a heading, a link between them); Task 9 fills the Formatter page.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/workerd.test.mjs — runs the real Worker in workerd (as the pattern does) with a stub
// GATEWAY service and an outbound handler that answers 404 for tools.ailab.gc.cuny.edu.
test('health reads the catalog through the GATEWAY binding', ...)          // 200 ready
test('a global fetch to the tools hostname would fail health', ...)         // with the binding removed: 503 gateway_unavailable
// tests/verify-release.test.mjs
test('accepts the checked-in wrangler.toml', ...)                           // verifyConfig(real file) deep-equals []
test('rejects a config without the GATEWAY binding to cail-model-api', ...)
test('rejects workers_dev = true', ...)
test('rejects preview_urls = true', ...)
test('rejects a config whose name is not cail-manuscript', ...)
```

- [ ] **Step 2: Run** `node --test tests/workerd.test.mjs tests/verify-release.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above. `README.md` states what the suite is, the privacy statement from the spec, development commands, and the AGPL-3.0 and MuPDF notices.
- [ ] **Step 4: Run** `npm run vendor && npm run check`. Expected: all tests pass and `dist/` exists. Then `npx wrangler deploy --dry-run --outdir /tmp/cail-manuscript-dry` exits 0.
- [ ] **Step 5: Commit** `Add build, CI check, release verifier and workerd test`.

### Task 3: Rule sheet schema

**Files:**
- Create: `lib/rules/schema.js`
- Test: `tests/schema.test.mjs`

**Interfaces — Produces:**

```js
export const SHEET_VERSION = 1;
export const DOC_TYPES = ['article', 'monograph', 'edited-collection'];
export const MODES = ['fix', 'flag', 'supply'];
export const CATEGORIES;        // array of { id, label, docTypes: string[], group: 'style'|'references'|'structure' }
export const SLOTS;             // { [slot]: { category, params: { [name]: validator } } }
export function categoriesFor(docType) -> Category[];
export function validateRule(rule) -> { ok: true, rule } | { ok: false, reason: string };
export function validateSheet(value) -> { ok: true, sheet } | { ok: false, reason: string };
export function newSheet(docType) -> RuleSheet;
```

```
Rule = { id: string, category: string, slot: string|null, statement: string,
         mode: 'fix'|'flag'|'supply',
         source: { kind: 'guidelines', quote: string, doc: number }
               | { kind: 'manual', manual: string, section: string }
               | { kind: 'author' },
         params: object, enabled: boolean, conflict?: true }
RuleSheet = { version: 1, docType, manual: { id: string|null, named: string|null },
              rules: Rule[], dropped: number, created: string /* ISO */ }
```

Categories (id · group · document types; "all" means all three):

| id | group | docTypes |
|---|---|---|
| spelling, quotations, punctuation, numbers, abbreviations, italics, headings | style | all |
| citations, references, notes | references | all |
| figures-tables, alt-text, permissions, layout, length, files, statements, other | structure | all |
| abstract-keywords | structure | article, edited-collection |
| title-page, anonymization, declarations | structure | article |
| front-matter, back-matter, index, chapters | structure | monograph, edited-collection |
| contributors, consistency | structure | edited-collection |

Slots and their params (a rule with a slot must have exactly these params; a rule without a slot has `params: {}`):

| slot | category | params |
|---|---|---|
| `quotes.primary` | quotations | `style`: `double` \| `single` |
| `quotes.punctuation` | quotations | `inside`: boolean |
| `blockquote.threshold` | quotations | `words`: integer > 0 or null, `lines`: integer > 0 or null (one must be non-null) |
| `dash.ranges` | punctuation | `dash`: `en` \| `hyphen` |
| `comma.serial` | punctuation | `use`: boolean |
| `ellipsis.form` | punctuation | `form`: `character` \| `three-dots` \| `spaced` |
| `spelling.variety` | spelling | `variety`: `us` \| `uk` \| `oxford` \| `ca` \| `au` |
| `numbers.spellout` | numbers | `below`: integer 2..1001 |
| `percent.form` | numbers | `form`: `percent` \| `per cent` \| `%` |
| `centuries.form` | numbers | `form`: `spelled` \| `numeral` |
| `headings.case` | headings | `case`: `title` \| `sentence` |
| `notes.kind` | notes | `kind`: `footnotes` \| `endnotes` |
| `notes.restart` | notes | `per`: `chapter` \| `none` |
| `citations.system` | citations | `system`: `notes-bibliography` \| `author-date` \| `mla` \| `apa` \| `numbered` \| `other` |
| `layout.font` | layout | `family`: string 1..80 or null, `sizePt`: number 6..30 or null |
| `layout.spacing` | layout | `line`: number 1..3 |
| `layout.margins` | layout | `inches`: number 0.25..3 |
| `length.words` | length | `max`: integer > 0 or null, `min`: integer > 0 or null |
| `abstract.words` | abstract-keywords | `max`: integer > 0 |
| `keywords.count` | abstract-keywords | `min`: integer >= 0, `max`: integer > 0 |
| `anonymize` | anonymization | `required`: boolean |

Limits: `id` matches `/^[a-z0-9-]{1,64}$/`; `statement` 1..500 characters; `quote` 12..400; `manual` and `section` 1..80; at most 400 rules per sheet; a slot-less rule may only be `flag` or `supply`; `category: 'other'` may only be `flag` or `supply`.

- [ ] **Step 1: Write the failing tests** in `tests/schema.test.mjs`:

```js
test('categoriesFor("article") includes anonymization and excludes front-matter', ...)
test('categoriesFor("edited-collection") includes contributors and consistency', ...)
test('every slot names an existing category', ...)
test('accepts a slotted fix rule with exact params', ...)      // quotes.primary { style: 'double' }
test('rejects unknown category, mode, slot', ...)              // three assertions, reason mentions the field
test('rejects a slotted rule with a missing, extra or wrong-typed param', ...)
test('rejects a slot whose category differs from the rule category', ...)
test('rejects mode "fix" on a rule without a slot', ...)
test('rejects a guidelines source whose quote is shorter than 12 characters', ...)
test('validateSheet rejects version 2 with reason "version"', ...)
test('validateSheet rejects non-objects, arrays, and more than 400 rules', ...)
test('validateSheet keeps markup in a statement as literal text', ...) // '<img src=x onerror=1>' round-trips unchanged
test('validateSheet strips unknown top-level and rule keys', ...)
test('newSheet("monograph") is valid and empty', ...)
```

- [ ] **Step 2: Run** `node --test tests/schema.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/rules/schema.js`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `Add the rule sheet schema`.

### Task 4: Quotation check

**Files:**
- Create: `lib/rules/quote.js`
- Test: `tests/quote.test.mjs`

**Interfaces — Produces:**

```js
export function normalizeForMatch(text: string) -> string;
export function findQuote(quote: string, guidelines: string) -> boolean;
```

`normalizeForMatch`, in this order: Unicode NFKC; remove soft hyphens (U+00AD); join words hyphenated across a line break (`-` followed by optional spaces, a newline, optional spaces, then a lowercase letter: drop the hyphen and the break); curly single and double quotation marks and primes to straight; every dash character (U+2010 to U+2015, U+2212) to `-`; collapse all whitespace runs to one space; trim; lowercase.

`findQuote`: split the quote on `...` or `…` (also when wrapped in square brackets). Trim each segment and strip leading and trailing quotation marks and terminal punctuation `.,;:`. Segments shorter than 12 normalized characters make the whole quote fail. All segments must occur in the normalized guidelines in order, and from the start of the first to the end of the last may span at most 600 characters.

- [ ] **Step 1: Write the failing tests:**

```js
const G = 'Please use double quotation marks (“like this”) throughout.\nNotes should be foot-\nnotes, numbered from 1 in each chapter. Use en dashes – not hyphens – in ranges.';
test('finds a verbatim quote', () => assert.equal(findQuote('Please use double quotation marks', G), true));
test('ignores curly versus straight quotes and dash type', () => assert.equal(findQuote('double quotation marks ("like this") throughout', G), true));
test('joins a word hyphenated across a line break', () => assert.equal(findQuote('Notes should be footnotes, numbered from 1', G), true));
test('ignores case and runs of whitespace', () => assert.equal(findQuote('USE  EN DASHES - not hyphens', G), true));
test('accepts an elided quote whose segments occur in order', () => assert.equal(findQuote('Please use double quotation marks … numbered from 1 in each chapter', G), true));
test('rejects segments out of order', () => assert.equal(findQuote('numbered from 1 in each chapter ... Please use double quotation marks', G), false));
test('rejects a paraphrase', () => assert.equal(findQuote('Authors must use double quotes everywhere', G), false));
test('rejects a quote with a segment under 12 characters', () => assert.equal(findQuote('Please use ... notes', G), false));
test('rejects segments more than 600 characters apart', ...) // build a guidelines string with 700 filler characters between two sentences
test('rejects an empty or non-string quote', ...)
```

- [ ] **Step 2: Run** `node --test tests/quote.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/rules/quote.js`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `Add the quotation check for extracted rules`.

### Task 5: Merging and layering rules

**Files:**
- Create: `lib/rules/merge.js`
- Test: `tests/merge.test.mjs`

**Interfaces:**
- Consumes: `validateRule`, `SLOTS` from `lib/rules/schema.js`; `findQuote`, `normalizeForMatch` from `lib/rules/quote.js`.
- Produces:

```js
// candidates: raw objects from model replies (untrusted). guidelines: string[] (one per source document).
export function mergeExtracted(candidates: object[], guidelines: string[]) -> { rules: Rule[], dropped: number };
// Later plans supply real baselines; here the function and its tests use a small fixture baseline.
export function layerSheet(sheet: RuleSheet, baseline: Rule[]) -> Rule[];
```

`mergeExtracted`: give each candidate `source.kind = 'guidelines'`, `enabled: true`, and an `id` of `<category>-<n>` numbered in output order. Drop and count a candidate when `validateRule` fails or its quote is not found in `guidelines[source.doc]` (a missing or out-of-range `doc` is tried against every document and set to the first that matches). Then:
- two slotted rules with the same slot and deep-equal params: keep the first;
- same slot, different params: keep both, set `conflict: true` on both;
- two slot-less rules whose normalized quotes are equal, or one contains the other: keep the one with the longer statement.
Output order: by the order of `CATEGORIES`, then by first appearance.

`layerSheet`: returns the sheet's rules followed by each baseline rule whose slot no enabled-or-disabled sheet rule occupies. Baseline rules keep `source.kind === 'manual'`. A baseline rule without a slot is always appended.

- [ ] **Step 1: Write the failing tests:**

```js
test('drops and counts a rule whose quote is not in the guidelines', ...)          // dropped === 1
test('drops and counts a rule that fails validation', ...)
test('assigns doc to the document that contains the quote', ...)                   // two guideline strings
test('dedupes the same slot with equal params', ...)
test('keeps both and marks conflict for the same slot with different params', ...) // "double quotation marks" in one place, "single quotation marks" in another
test('dedupes slot-less rules whose quotes overlap, keeping the longer statement', ...)
test('orders output by category order then appearance and numbers ids', ...)       // ids like 'spelling-1', 'notes-1'
test('never returns a rule with source.kind other than guidelines', ...)           // candidate claiming kind 'manual' is rewritten
test('layerSheet appends baseline rules for unoccupied slots only', ...)
test('layerSheet lets a disabled sheet rule still occupy its slot', ...)
```

- [ ] **Step 2: Run** `node --test tests/merge.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/rules/merge.js`.
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit** `Add rule merging, conflict marking and baseline layering`.

### Task 6: Rule extraction route

**Files:**
- Create: `server/prompts.js`, `server/model.js`
- Modify: `server/worker.js` (add the `/api/rules` route)
- Test: `tests/rules-route.test.mjs`, `tests/prompts.test.mjs`

**Interfaces:**
- Consumes: `CATEGORIES`, `SLOTS`, `DOC_TYPES`, `categoriesFor` from `lib/rules/schema.js`.
- Produces: `rulesPrompt({ docType, group }) -> string`; `modelControls(row, expectedOutputTokens) -> object`.
- Produces route `POST /manuscript/api/rules`, request `{ model: string, docType, group: 'style'|'references'|'structure', text: string /* 1..60000 chars */ }`, response `{ content: string, request_id }` where `content` is the model's raw JSON text. Errors: `400 invalid_request`, `400 invalid_model`, `502 model_output_limit` (finish reason `length`), `502 invalid_model_response` (empty content).

The Worker sends `{ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: rulesPrompt(...) }, { role: 'user', content: text }], ...modelControls(row, 6000) }` through `client.chatCompletions(payload, credential, { signal, correlation })`, exactly as the pattern's `/api/parse` does.

`modelControls`: copy the pattern's function and its measured constants (`MAX_OUTPUT_TOKENS = 16000`, `REASONING_HEADROOM_TOKENS = 4000`, `REASONING_MAX_TOKENS = 10000`), replacing its `path`/`entries` arguments with `expectedOutputTokens`. Keep the comments that explain why: Workers AI defaults `max_tokens` to 256, and reasoning models bill thinking as output.

`rulesPrompt` must contain, and the tests assert, these parts:
- the task: extract every distinct requirement the author must meet; do not add requirements the text does not state; ignore greetings, offers of help and advice that asks for nothing specific;
- the reply shape `{"rules":[{"category","slot","statement","quote","mode","params"}],"manual":{"named": string|null}}`, JSON only;
- `quote` is copied character for character from the instructions, at most 400 characters, and a rule with no supporting sentence must be omitted;
- the three modes with one-line definitions from the spec;
- the category ids of the requested `group` that apply to `docType`, each with its label, and no others;
- the slots belonging to those categories with their param names and allowed values, and the instruction to use `slot: null, params: {}` when none fits;
- `manual.named`: the style manual and edition the instructions tell the author to follow, verbatim, or null.

- [ ] **Step 1: Write the failing tests:**

```js
// tests/prompts.test.mjs
test('style group for an article lists spelling and quotations and not notes or front-matter', ...)
test('structure group for an article lists anonymization; for a monograph lists front-matter and not anonymization', ...)
test('lists each slot of the group with its allowed values', ...)   // contains 'quotes.primary' and 'double' and 'single'
test('states the reply shape and the verbatim-quote rule', ...)
// tests/rules-route.test.mjs (injected gatewayFetch records the outgoing payload)
test('sends system prompt, user text, temperature 0 and json_object', ...)
test('adds max_tokens for a Workers AI non-reasoning row', ...)
test('adds reasoning_effort low for a reasoning row', ...)
test('returns the model content and a request id', ...)
test('rejects text over 60000 characters, unknown docType, unknown group, bad model id', ...) // four 400s
test('maps finish_reason length to 502 model_output_limit', ...)
test('maps empty content to 502 invalid_model_response', ...)
test('requires sign-in', ...)                                        // 401 with launch path
test('passes a Gateway 429 through with x-should-retry true', ...)
```

- [ ] **Step 2: Run** `node --test tests/prompts.test.mjs tests/rules-route.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/prompts.js`, `server/model.js` and the route.
- [ ] **Step 4: Run** `npm test`. Expected: PASS, including Task 1's tests.
- [ ] **Step 5: Commit** `Add the rule extraction route and prompt`.

### Task 7: Reading guidelines files

**Files:**
- Create: `lib/guidelines/read.js`, `web/shared/pdf-worker.js`
- Test: `tests/guidelines-read.test.mjs`, `tests/fixtures/guidelines.docx`, `tests/fixtures/guidelines.pdf`, `tests/fixtures/scanned.pdf`

**Interfaces — Produces:**

```js
// extractPdf and extractDocx are injected so the function runs in Node tests and in the browser.
export async function readGuidelines({ name, bytes }, { extractPdf, extractDocx }) ->
  { ok: true, text: string } | { ok: false, code: 'unsupported'|'no_text'|'too_long'|'unreadable', message: string };
export function cleanPastedText(text: string) -> { ok: true, text } | { ok: false, code: 'too_short'|'too_long', message };
export const MAX_GUIDELINES_CHARS = 600000;
export const MIN_GUIDELINES_CHARS = 200;
```

Type is decided by the file's first bytes (`%PDF` or the zip signature `PK\x03\x04`), not its name. Messages (exact copy):
- `unsupported`: "Upload a PDF or Word (.docx) file, or paste the guidelines as text."
- `no_text`: "This PDF has no readable text. It is probably a scan. Paste the guidelines as text instead."
- `too_long`: "These guidelines are too long to read in one go. Upload only the part about preparing the manuscript."
- `unreadable`: "This file could not be opened. Try saving it again, or paste the guidelines as text."
- `too_short`: "Paste the full guidelines. This is too short to contain any."

`no_text` applies when a PDF yields fewer than 200 non-whitespace characters. In the browser, `extractDocx` is `mammoth.extractRawText`, and `extractPdf` posts the bytes to `web/shared/pdf-worker.js`, which loads `../vendor/mupdf/mupdf.js` and returns the pages' text joined with blank lines (follow `book-index/public/pdf-worker.js` and `extract.js` for loading MuPDF in a Web Worker).

Create the fixtures with a script run once and committed alongside them (`tests/fixtures/make-fixtures.mjs`): a `.docx` and a text PDF each containing the sentence "Use double quotation marks throughout the manuscript." plus 300 characters of other invented guidance, and a PDF with one page holding only an image.

- [ ] **Step 1: Write the failing tests** (Node; `extractPdf` uses the `mupdf` package directly, `extractDocx` uses `mammoth`):

```js
test('reads a docx by content, whatever its name', ...)        // name 'x.bin' still works; text includes the sentence
test('reads a text pdf', ...)
test('reports no_text for an image-only pdf with the exact message', ...)
test('reports unsupported for a png', ...)
test('reports unreadable for a truncated docx', ...)
test('reports too_long above 600000 characters', ...)          // injected extractor returns a long string
test('cleanPastedText trims, rejects under 200 characters, rejects over the limit', ...)
```

- [ ] **Step 2: Run** `node --test tests/guidelines-read.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the module, the fixtures script and the PDF worker; add `web/shared/pdf-worker.js` to the build.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `Read guidelines from PDF, Word and pasted text`.

### Task 8: Extraction orchestrator

**Files:**
- Create: `lib/rules/chunk.js`, `lib/rules/extract.js`
- Test: `tests/chunk.test.mjs`, `tests/extract.test.mjs`

**Interfaces:**
- Consumes: `mergeExtracted` (Task 5), `newSheet`, `categoriesFor` (Task 3).
- Produces:

```js
export function splitGuidelines(text: string, { size = 40000, overlap = 2000 } = {}) -> string[];
// callRules({ model, docType, group, text, signal }) -> Promise<{ content: string }>; rejects with an
// Error carrying { code: string, retry: boolean } on failure. Injected: the browser passes a wrapper
// over POST /manuscript/api/rules, tests pass a fake.
export async function extractRuleSheet({ docType, model, guidelines /* string[] */, callRules, signal, onProgress }) ->
  { sheet: RuleSheet, failures: { group: string, doc: number, part: number, code: string }[] };
```

`splitGuidelines` cuts at the last paragraph break (blank line) before `size`, else the last sentence end, else at `size`; each later part begins `overlap` characters before the previous cut, moved forward to a paragraph or sentence start. A text of `size` or fewer characters is one part.

`extractRuleSheet` runs every (document, part, group) call with at most 3 in flight. For each call: parse `content` as JSON (tolerating a Markdown code fence around it); a reply that does not parse, or has no `rules` array, is retried once, and so is a rejection whose `retry` is true; a second failure is recorded in `failures` and the run continues. Each parsed candidate is tagged with its `doc`. `sheet.manual.named` is the first non-null `manual.named` returned. Rules and `dropped` come from one `mergeExtracted` call over all candidates. `onProgress({ done, total })` fires after each call settles. An aborted `signal` rejects with the abort reason.

- [ ] **Step 1: Write the failing tests:**

```js
// tests/chunk.test.mjs
test('short text is one part', ...)
test('long text is cut at a paragraph break and parts overlap by about 2000 characters', ...)
test('every character of the input appears in some part', ...)
test('a 100000-character text with no breaks still splits', ...)
// tests/extract.test.mjs
test('calls each of the three groups once for a one-part document', ...)             // 3 calls
test('calls groups times parts times documents', ...)                               // 2 docs, one with 2 parts -> 9 calls
test('never has more than three calls in flight', ...)
test('accepts a reply wrapped in a json code fence', ...)
test('retries a non-JSON reply once and then records a failure', ...)               // failures has { group: 'style', code: 'invalid_model_response' }
test('retries a rejection with retry true once; does not retry when retry is false', ...)
test('a failed group does not remove the other groups rules', ...)
test('drops an invented quote and reports it in sheet.dropped', ...)
test('takes manual.named from the first reply that names one', ...)
test('reports progress up to the total', ...)
test('rejects when aborted', ...)
```

- [ ] **Step 2: Run** `node --test tests/chunk.test.mjs tests/extract.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** them again. Expected: PASS.
- [ ] **Step 5: Commit** `Add guideline splitting and the extraction orchestrator`.

### Task 9: Formatter page, steps 1 to 3

**Files:**
- Create: `web/shared/api.js`, `web/shared/models.js`, `web/shared/store.js`, `web/format/app.js`
- Modify: `web/format/index.html`, `web/index.html`, `web/shared/styles.css`, `scripts/build.mjs`
- Test: `tests/api.test.mjs`, `tests/models.test.mjs`, `tests/store.test.mjs`, `tests/sheet-file.test.mjs`

**Interfaces — Produces:**

```js
// web/shared/api.js
export function createApi({ fetchImpl = fetch, navigate = url => location.assign(url), base = '/manuscript' } = {}) ->
  { get(path, { signal }), post(path, body, { signal }) };   // resolve to parsed JSON
// Rejections are ApiError { code, message, status, retry: boolean }. On 401 with code authentication_required,
// invalid_credential or session_invalid: await onLostSession() if given, then navigate(error.launch) and never settle.
// web/shared/models.js
export function modelMenu(catalog) -> { id, label }[];        // recommended, active, text-generation, context_length >= 32000, not a classifier, by order
export function chooseModel(chosen, menu) -> string;          // chosen if offered, else 'glm-5.3' if offered, else menu[0].id
// web/shared/store.js
export function createStore({ indexedDB, now = Date.now }) -> { saveJob(key, value), loadJob(key), clearJob(key) };
// loadJob returns null and deletes the record when it is older than 24 hours.
// web/format/app.js
export function sheetToFile(sheet) -> { name: 'rule-sheet.json', text: string };
export function sheetFromFile(text) -> { ok: true, sheet } | { ok: false, message: string };
```

`sheetFromFile` messages (exact): not JSON → "This is not a rule sheet file."; wrong version → "This rule sheet was made by a different version of the tool."; otherwise invalid → "This rule sheet file is damaged and cannot be used."; over 2,000,000 characters → the first message.

The page, top to bottom, following the look of the Lab's other tools (read the pattern's `index.html` and `styles.css` for type, colors and spacing; reuse its header and quota display):

1. **What are you submitting?** Three choices: Article, Monograph, Edited collection.
2. **Guidelines.** File picker (PDF or Word, more than one allowed) and a paste box; each added source is listed with a remove button. A model menu with the default chosen, and "Read the guidelines". The privacy statement from the spec sits here.
3. **Rule sheet.** A progress line while reading. Then: the named style manual if one was found; a notice "N rules were left out because the tool could not find their wording in the guidelines." when `dropped > 0`; a notice naming each failed group with a "Try again" button; rules grouped under category headings, each row showing the statement, the source quotation in quotation marks, a mode menu (Fix automatically / Leave a comment / Add to my To-dos; "Fix automatically" disabled for slot-less rules), an on/off switch, an Edit and a Remove control; rules marked `conflict` shown together under "The guidelines say two different things" with a choice between them; "Add a rule"; "Download rule sheet" and "Load a rule sheet".

State changes are saved with `saveJob('format', { docType, guidelines, sheet })`; on load the page restores it. `onLostSession` saves before navigating. "Start over" calls `clearJob('format')`.

- [ ] **Step 1: Write the failing tests** (Node; `store.test.mjs` uses the `fake-indexeddb` dev dependency):

```js
// tests/api.test.mjs
test('get resolves parsed JSON', ...)
test('a 401 authentication_required runs onLostSession then navigates to the launch path and does not settle', ...)
test('a 401 does not retry and does not fetch the launch path from script', ...)   // exactly one fetch call
test('a 429 rejects with retry true from x-should-retry', ...)
test('a network failure rejects with code network_error and retry false', ...)
test('post sends JSON with content-type application/json', ...)
// tests/models.test.mjs — fixture: copy tests/fixtures/catalog-2026-11-09.json from the pattern
test('offers only recommended active text rows with enough context, in catalog order', ...)
test('excludes rows whose id or name matches guard|safeguard', ...)
test('chooseModel prefers glm-5.3 when nothing is chosen', ...)
test('chooseModel keeps a chosen model that is still offered', ...)
test('chooseModel falls back to the first row when glm-5.3 is not offered', ...)
// tests/store.test.mjs
test('saves and loads a job', ...)
test('returns null and deletes a job older than 24 hours', ...)
test('clearJob removes it', ...)
// tests/sheet-file.test.mjs
test('a downloaded sheet loads back deep-equal', ...)
test('refuses non-JSON, wrong version, invalid sheet, each with its exact message', ...)
test('a statement containing markup comes back as the same literal string', ...)
```

- [ ] **Step 2: Run** `node --test tests/api.test.mjs tests/models.test.mjs tests/store.test.mjs tests/sheet-file.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the shared modules, then the page. `web/format/app.js` must not import anything that touches `document` at module top level, so its two exported functions load under Node.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS. Then check for unsafe rendering: `grep -rn "innerHTML\|insertAdjacentHTML\|outerHTML" web/` prints nothing.
- [ ] **Step 5: See it work.** `npm run dev` (the ported dev server signs local identities and proxies Gateway calls using `CAIL_API_KEY` from the environment, as the pattern's does). In a browser at the printed address: choose Monograph, upload `tests/fixtures/guidelines.docx`, read the guidelines, confirm at least one rule appears with its quotation, switch one off, download the sheet, start over, load the sheet, and confirm the switched-off rule is still off. If `CAIL_API_KEY` is not set, say so in the task report instead of claiming this step.
- [ ] **Step 6: Commit** `Add the Formatter page through the rule sheet review`.

### Task 10: Generality script

**Files:**
- Create: `scripts/generality.mjs`
- Test: `tests/generality.test.mjs`

**Interfaces:**
- Consumes: `rulesPrompt`, `modelControls` usage as in the route; `readGuidelines`; `extractRuleSheet`.
- Produces: `npm run generality -- --models a,b,c [--only <folder>]`, and
  `export function scoreSheet(sheet, expected) -> { found: number, of: number, missed: string[] }`,
  `export function passes(results) -> boolean`.

The script reads the private folder named by `MANUSCRIPT_DESK_GUIDELINES` (default `../manuscript-desk-guidelines`). Each subfolder may hold guideline files (PDF, `.docx`, `.html`, `.txt`) and an `expected.json`: `{ "docType": "monograph", "rules": [{ "name": "alt texts for all images", "any": ["ALT-texts for all images"] }] }`. A rule counts as found when any of its `any` strings (after `normalizeForMatch`) occurs in some extracted rule's quote or statement. HTML is reduced to text by removing `script`, `style`, `nav`, `header` and `footer` elements and all tags. Folders without `expected.json` are run and reported with rule counts only.

Calls go to `https://tools.ailab.gc.cuny.edu/v1/chat/completions` with `Authorization: Bearer $CAIL_API_KEY` (the public URL is correct from outside the Lab's Cloudflare zone). The script exits with a clear message when the key is not set. Output: one table per model with, per document, rules kept, dropped, expected found, and seconds; then totals and token cost from the catalog's `pricing`. `passes` is true when total found is at least 90 percent of total expected and no document is below 80 percent. The script never writes guideline text or extracted quotes into the repository; results go to stdout only.

- [ ] **Step 1: Write the failing tests:**

```js
test('scoreSheet finds a rule by quote or by statement, ignoring quote style and case', ...)
test('scoreSheet lists missed rule names', ...)
test('passes at 90 percent overall with every document at or above 80', ...)
test('fails when one document is below 80 percent even if the total is above 90', ...)
test('fails at 89 percent overall', ...)
test('htmlToText drops script, style and navigation and keeps paragraph text', ...)
```

- [ ] **Step 2: Run** `node --test tests/generality.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `scripts/generality.mjs` (export the pure functions; run the CLI only when invoked directly) and the `generality` npm script.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS. Then `CAIL_API_KEY= npm run generality -- --models glm-5.3` prints the missing-key message and exits non-zero.
- [ ] **Step 5: Commit** `Add the generality script for measuring rule extraction`.

---

## Done when

`npm run check` passes; `wrangler deploy --dry-run` succeeds; Task 9 Step 5 was performed or reported as not performed; no file under `web/` assigns HTML strings; and `git log` shows one commit per task. Deployment, the Doorway mount and the GitHub repository are separate, explicitly requested steps.


## Executed

Completed 2026-11-22 on branch `plan-1-foundation`. Changes made during execution, each reviewed: Task 11 added (PDF text extraction keeps the spaces between words); the quotation check requires whole-word matches; slot-less duplicate removal narrowed to same category, mode and quotation; the page's sign-in-free dev run (Task 9 Step 5) replaced by a browser smoke test with mocked API; six whole-branch review findings fixed (loaded sheets marked unverified, named manual verified, settings shown on rows, failed re-read keeps the sheet, failure reasons shown and saved, trailing-slash redirect).
