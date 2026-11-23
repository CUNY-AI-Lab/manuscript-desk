# Evaluation loop: the Brill job

Manuscript Desk is built in rounds, and each round is measured against a real formatting job that
was done by hand: an eleven-chapter edited volume, exported from Google Docs with direct formatting
and no styles, formatted for Brill. Each round builds the next stage, measures it on that job,
improves it, and measures again. The manuscript is other scholars' unpublished work: it stays in the
private guidelines folder, and nothing from it (text, titles, names) is in this repository. This
file holds only counts, accuracies and role names.

## Round 1: paragraph roles

The stage: `lib/docx/read.js` reads the `.docx` into one entry per top-level child of `w:body`
(text, kind and direct-formatting hints); `lib/roles/` cuts the paragraphs into passages, and a
model labels each non-empty paragraph with one of 14 roles through `POST /manuscript/api/roles`.

The measure: `gold-roles.json` holds the role of each paragraph as set by hand during the manual job.
Its chapters are split into `dev` (5 chapters, 662 scored paragraphs) and `holdout` (7 chapters,
736 scored paragraphs). Gold paragraphs that the reader finds empty (467 of 1,865, mostly blank
spacer paragraphs inside bibliographies and running text) are not scored, because empty paragraphs
are not sent to the model and get no role. "Structural" roles are all roles except `body` and
`bibliography-entry`; "body as structural" counts body paragraphs given a structural role, the
mistake that would restyle running text.

### How to run it

```bash
CAIL_API_KEY=sk-cail-... npm run roles-eval -- --chapters dev        # or holdout, all, or chapter keys
```

The script reads the single case folder under `manuscripts/` in `MANUSCRIPT_DESK_GUIDELINES`
(default `../manuscript-desk-guidelines`; `--case <folder>` picks one when there are several), which
holds `source.docx` and `gold-roles.json`. It runs the product's reader, passages and labelling run,
sends the payload the route sends (`rolesPayload` in `server/prompts.js`) to the public Gateway with
the key in `CAIL_API_KEY`, and prints, per chapter and for dev, holdout and in total: paragraphs
scored, accuracy, structural accuracy, body given a structural role, the confusions as
`gold->predicted: count`, and tokens and cost. `--model` picks another model (default
`deepseek-v4.1-flash-1017`). It prints no manuscript text and writes nothing to disk. Each measured
chapter is labelled together with the ten paragraphs before it (not scored), so a chapter does not
start exactly where a passage starts, as it would not in a whole manuscript.

### Measured runs (dev chapters, `deepseek-v4.1-flash-1017`)

| Run | What changed | Dev accuracy | Dev structural | Body as structural | Cost |
|---|---|---|---|---|---|
| 1 | Baseline: passages of up to 12,000 characters and 80 paragraphs, 8 paragraphs of context before and 4 after, thinking off | 95.6% | 91.5% (238/260) | 1 | $0.0271 |
| 2 | Every paragraph's length in characters shown; the prompt explains verse against prose quotations pasted one printed line per paragraph | 97.3% | 94.2% (245/260) | 1 | $0.0295 |
| 3 | The prompt says heading levels are relative to the chapter; paragraphs a reply left out are asked again in a second pass | 96.2% | 91.5% (238/260) | 1 | $0.0300 |
| 4 | Thinking left on (low effort, the 10,000-token cap) for roles calls | 98.0% | 96.2% (250/260) | 1 | $0.0487 |
| 5 | The prompt asks for one role per set-off quotation as a whole; context widened to 12 before and 8 after (both undone after this run) | 96.8% | 93.1% (242/260) | 1 | $0.0646 |
| 6 | Run 4 plus passages of at most 40 paragraphs, each starting halfway through the previous one, so every paragraph is read twice and the reading with more context on both sides is kept | 98.0% | 96.2% (250/260) | 1 | $0.0919 |

Run 6 is the configuration in the code. Runs 1, 3 and 5 differ from 2 and 4 mostly by one run of
eight paragraphs in one chapter, a prose quotation pasted line by line that the model called verse in
some runs and not in others: a difference of one or two points between two runs is within the noise.

### Holdout (run once, with run 6's configuration, nothing changed after)

| Holdout accuracy | Holdout structural | Body as structural | Cost |
|---|---|---|---|
| 99.0% (736 scored) | 98.7% (221/224) | 4 | $0.1247 |

Total spent on this round: $0.42 (seven runs). A whole manuscript of this size (about 1,400
non-empty paragraphs) costs about $0.25 to label with run 6's configuration.

### Remaining confusions

In the last dev run (13 in all) and the holdout run (7 in all):

| Gold -> predicted | Dev | Holdout | Best explanation |
|---|---|---|---|
| block-quotation -> verse | 8 | 0 | Prose quotations pasted with a line break on every line. Most now come out right from their length, but short lines that end with sentence punctuation and start with a capital look like verse by every visible cue, and a centred prose quotation carries the layout of verse. This is also where the run-to-run noise is. |
| body -> verse | 0 | 3 | Short paragraphs of running text set apart, such as a one-line quoted phrase or a list of short items, read as lines of a poem. |
| bibliography-entry -> bibliography-heading | 2 | 0 | A short line inside a bibliography (a very short entry, or a subdivision that the manual job kept as an entry) reads as a heading. The gold may itself be arguable here. |
| list-item -> body | 0 | 2 | List items typed without Word numbering, as plain paragraphs, are read as running text. |
| heading-1 -> heading-2 | 1 | 1 | A heading in a chapter with a mix of levels, without numbering, whose level is not marked by its formatting. |
| block-quotation -> epigraph | 1 | 0 | A set-off quotation near the start of a chapter, before its first section, has the place of an epigraph. |
| body -> block-quotation | 1 | 0 | A paragraph of running text that consists mostly of a quotation. |
| body -> table | 0 | 1 | A Word table used to lay out running text, which the manual job kept as body. |

Body paragraphs given a structural role: 1 in dev and 4 in holdout (3 as verse, 1 as table), out
of 1,398 scored paragraphs. These are the mistakes the page must make easy to catch when the author
reviews the roles.

### What to try next

- Measure the noise first: repeat the dev run two or three times on the same configuration before
  reading a one-point change as an improvement.
- Read set-off quotations more than once: a vote of three readings for paragraphs labelled `verse`
  or `block-quotation` only (a small share of a manuscript), or a focused second question for each
  run of them that shows the whole run with its lengths and line ends.
- State in the passage what code can see for certain: that a paragraph ends without punctuation and
  the next begins in lower case (a sentence running on), and the length of the longest line in a run
  of set-off paragraphs.
- Lists typed by hand: mark paragraphs that start with a bullet character, a number and a stop, or a
  letter in parentheses.
- Other models: measure the other recommended text models on the same configuration; this round
  measured only the default.
- Other manuscripts: one book is not a generality set. A second case, ideally an article and a
  monograph with styles, would show how much of this carries over.
