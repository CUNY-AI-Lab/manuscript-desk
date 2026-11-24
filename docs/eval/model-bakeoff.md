# Model bake-off and the agent workflow (2026-11-23)

Two questions: which of the CAIL Gateway models the Formatter's own menu offers are good enough for
Manuscript Desk, and whether a tool-calling agent that does the work ("like Claude Code does it")
beats the current pipeline, which hands the author its findings. After trying the beta, the owner's
complaint was that the tool "returned a million questions" and "doesn't know how to handle" them;
so the agent question became the main one, and the model ladder serves it.

Everything private (the Brill manuscript, its hand-formatted reference and the hand job's working
notes, the guideline cases, the index books) stays in the private guidelines folder; this file
holds counts and rates only. "Hand job" is the reference formatting done by hand for the Brill
volume (39 Word comments, a 26-row checklist). "Verified" means measured by a script in this
repository; "inferred" means my reading, said where it applies.

## The answer in short

- **The complaint is real and measurable.** On the Brill manuscript, run the way the page runs it,
  the product hands the author 75 comments in the file, a To-dos list of 113 items plus 70
  requirements to supply and 99 rules "not checked", and a checklist of 190 rows. The hand job left
  39 comments and a 26-row checklist. Most of the product's extra questions are things the hand job
  simply did, settled by a default, or are copyediting queries (tables below).
- **An agent pass after the pipeline cuts the questions to the hand job's order** (22 or 29 comments
  against 39; every rule of the guidelines triaged), and it does work the product never does:
  replaces the typed contents list with a generated one, writes the authors' names in place of the
  repeated-author dashes (6 of 6, as the hand job did), retypes the title in capitals (2 of 2),
  deletes the duplicated passage, sets page numbers and margins. No word changed undeclared; every
  file validated; rejecting every tracked change gives the source's words back.
- **But it also drops real questions and makes wrong decisions.** It kept a comment at 16 (DeepSeek)
  or 20 (GLM) of the hand job's 27 real questions, where the pipeline had 25; and every run made 3 to
  5 text changes that settle what the hand job asked the author (a title's spelling, where to divide
  a long title, which keyword to drop). Those must be blocked in code before this ships.
- **Models.** Gemma 4 26B and GPT-OSS 120B cannot drive the agent's tools. Inkling 2 Small and
  Mistral Large 3 pass the small tool test with the final prompt but on the real book leave more
  questions and make more wrong changes (Mistral deleted two lines of a chapter's title block); both
  also fall at extraction or labelling. DeepSeek V4.1 Flash (the default) and GLM-5.3 run the agent
  well enough; GLM-5.3 keeps more of the real questions but is worse at labelling (5.4 points below
  on structural roles) and extraction (93.0% against 97.4%) and costs three to five times as much.
- **Recommendation: pipeline plus an agent pass, DeepSeek V4.1 Flash for every step**, with the
  agent pass built as a decide step inside the product, behind code guards (below). Not agent-first:
  the agent only works when the harness hands it small units of work with the context attached; left
  to plan for itself, the default model read the book for 40 turns and decided nothing.
  Cost of the agent pass: about $0.17 a book on DeepSeek, $0.50 on GLM-5.3, four to seven minutes.

## What the product hands back today (the headline)

`node scripts/spikes/agent/questions.mjs` runs the product as the Formatter page runs it on the
Brill manuscript: the page's own labels and extracted rule sheet from round 6's page run, and the
reading check on every chapter (17 calls, $0.164, answers cached). Verified counts:

| What the author gets | Product | Hand job |
|---|---|---|
| Comments in the formatted file (one per paragraph) | 75 (94 places: a kind of finding at a paragraph) | 39 (27 questions, 12 reports of what was done) |
| To-dos list | 113 items in 12 chapters, 70 requirements to supply, 99 rules not checked | none (the comments and the checklist) |
| Checklist | 190 rows: 100 unchecked, 70 to supply, 16 flagged, 2 conflict, 2 done | 26 rows |
| Of the hand job's 27 questions, a product comment at the same place (any kind, within two paragraphs) | 25 | 27 |

So the product does find nearly everything the hand job asked. The problem is everything else.
The 94 places, classed (a judgment written into `classOf` in `scripts/spikes/agent/questions.mjs`
from the hand job's method; inferred, not measured):

| Class | Places | What they are |
|---|---|---|
| The hand job also commented here | 27 | the same kind of comment at the same place |
| (a) the hand job simply did it | 21 | the contents list (8 places: the hand job rebuilt it from the chapters), titles split at a colon or typed in capitals (8), pasted quotation lines joined (3), repeated-author dashes (2), a name typo, the duplicated passage |
| (b) a default settles it | 8 | how two authors' names are joined (4), abstracts of 241 to 261 words against "about 200" (3), a 165-word note against "about 100" |
| (c) noise or a repeat | 0 | (the repeats are inside places: one paragraph of one abstract carries 10 findings of missing spaces) |
| (d) a real author decision | 2 | a keyword count of 12 and of 4 against 6 to 10 |
| (d, copyedit) a possible slip in the authors' text | 35 | the reading check's queries: typos (13), stray characters (9), wordings (6), missing spaces (4), affiliations (3); some are false (an older spelling taken for a typo). The hand job left these to the copyeditor, at most one comment a chapter |
| Report | 1 | the summary comment |

And the rule sheet's open items (classified by hand from the rules' statements, inferred; the
classification is in the private folder):

| Rule items | (a) met by the formatting or the companion files, or built by the hand job | (b) a default settles it | (c) not for this delivery, conditional advice, a repeat | (d) a real delivery item or author task |
|---|---|---|---|---|
| 76 supply rules | 20 | 0 | 36 | 20 (about 7 distinct items: image files, cover image, permissions, file formats, the revisions outline, contract and questionnaire) |
| 100 rules "not checked" | 27 | 6 | 61 | 6 |

That is the "million questions": of about 270 things the author is handed (94 places, 76 supply
rules, 100 rules not checked), about 40 are decisions or deliveries of the kind the hand job put to
the authors (27 places where it asked too, 2 more decisions, about 7 delivery items, 6 author tasks).

Found on the way (verified): the figure finding numbers the figures of chapter 5 as 6.1 to 6.7 (it
counts the unnumbered introduction as a chapter; the hand job numbered them 5.1 to 5.7), and the
extracted sheet sets the body font size to 9 pt from a sentence about text inside illustrations (two
`layout.font` rules in conflict, so the formatter left the font alone).

## Part 1: the elimination ladder

`npm run bakeoff` (`scripts/model-bakeoff.mjs`) runs every model the Formatter's menu offers
(`modelMenu` over the Gateway catalog of 2026-11-23): `deepseek-v4.1-flash-1017`,
`inkling-2-small`, `glm-5.3`, `gemma-4-26b-a4b-it`, `gpt-oss-120b`,
`mistral-large-3-675b-instruct`. A model is dropped at the first stage it fails. Thresholds were
fixed in the script before the runs:

1. **Answers in the required shape**: a rule sheet from the public fixture
   (`tests/fixtures/guidelines.docx`) with the product's settings, no failed call, at least one
   rule kept, every kept rule's quotation verified by code. Also recorded: whether it answers with
   thinking on.
2. **Drives the agent's tools** (moved up from last, as the brief asked): an invented 14-paragraph
   chapter (`scripts/spikes/agent/probe.mjs`) with six tasks (a heading labelled as body, a
   duplicated paragraph, a repeated-author dash, an affiliation that differs between two places, three
   findings that are noise, two rules to triage) and an instruction planted in the text. Pass: it
   calls finish, at least 90% of tool calls valid, no harmful operation, at least 5 of 6 tasks, in
   both of two runs.
3. **Guideline extraction** on five cases (the Brill guidelines, a university's dissertation guide, a
   journal's article guide, a monograph guide that was hard before, an edited-collection guide; 115
   expected rules): found at least 90% of the baseline's count, no case below 70%, quotations
   verified at least 90%; and the Brill sheet's settings against the hand-made sheet.
4. **Paragraph roles** on the Brill dev chapters (662 paragraphs) with the product's settings:
   structural accuracy no more than 3 points below the baseline's.

The Gateway passes OpenAI-style `tools` through to every one of the six models (verified with one
call each), so stage 2 uses native tool calls; no JSON-action protocol was needed.

Stage 2 was run twice: with the agent prompt as first written (prompt 1) and with the final prompt,
which adds one sentence (never settle a difference of names or titles by replacing one form with the
other; prompt 2). Its pass or fail moved for two models on that one sentence: the stage separates the
clear failures (Gemma, GPT-OSS) from the rest, but a threshold of 5 of 6 tasks sits inside the
noise for the others. Models that passed it under either prompt went on to stages 3 and 4 and to
the Brill agent run.

| Model | 1. Shape (s a call; thinking on) | 2. Agent tools, tasks of 6 (prompt 1; prompt 2) | 3. Extraction (found of 115; Brill settings of 16) | 4. Roles, structural of 260 | Out at |
|---|---|---|---|---|---|
| DeepSeek V4.1 Flash | pass (3.3 s; answers, 9.2 s) | 6, 6; 5, 6 | 112 (97.4%); 15 | 243 (93.5%), 1 body as structural | survives |
| GLM-5.3 | pass (1.7 s; answers) | 6, 5; 6, 6 | 107 (93.0%); 15 | 229 (88.1%), 1 | roles (5.4 points below); survives as an agent |
| Mistral Large 3 | pass (2.2 s; answers) | 5, 5 but one run stopped without finish (fail); 5, 5 (pass) | 110 (95.7%); 15 | 211 (81.2%), 1 | roles (12.3 points below); still run as an agent |
| Inkling 2 Small | pass (9.0 s; answers) | 5, 4 (fail); 5, 5 (pass): missed the mislabelled heading every time | 97 (84.3%; one case at 60%, replies running to the 10,000-token cap, $0.398); 15 | not run | extraction |
| GPT-OSS 120B | pass (6.4 s; answers) | 3, 5; 5, 5, and answered in prose instead of calling finish in one run of each | not run | not run | agent stage |
| Gemma 4 26B | pass (2.8 s; answers, 32.2 s) | 0, 0; 0, 0: repeated one malformed setting call until the turn limit (12 to 14 refusals, never corrected) | not run | not run | agent stage |

No model was eliminated at stage 1: all six answer in the required shape and with thinking on
(Gemma slowly). No run made a harmful operation or obeyed the planted instruction. The roles score
of the baseline today (93.5% structural) is below round 1's 96.2% with the same configuration: the
run-to-run noise of that measure is larger than the doc's earlier one-point estimate, or the model
behind the Gateway name changed; GLM's 5.4-point gap is larger than either.

Costs per stage (verified, catalog prices): extraction on the five cases $0.080 (DeepSeek) and
$0.392 (GLM); the Brill guidelines alone $0.045 and $0.224. Roles on the dev chapters $0.101 and
$0.282 (58 s for GLM against 106 s). Per book, extrapolated from those (inferred: the dev chapters
are 662 of about 1,460 labelled paragraphs): labelling about $0.22 (DeepSeek) or $0.62 (GLM).

Not run, and why: the reading-check comparison across models (`todos-eval --reading` takes no
model argument; with the agent the reading check's queries go to a copyedit list, so it mattered
less) and both index stages (term proposal and subentry sorting). Budget was not the limit; time
was. The index recommendation below rests on the earlier single-model measurements only.

## Part 2: pipeline against an agent pass

### What was built (`scripts/spikes/agent/`, not wired into the product)

The method copies how the hand job was done: read the manuscript and the guidelines, decide in a
spec of operations keyed by paragraph, let code build the file. The model never writes XML.

- `tools.mjs`: the tools over the document model, each validated in code: read paragraphs, find
  text, set roles, set or clear a setting (only those the formatter applies; source "guidelines" or
  "default"), replace text in one paragraph (the "before" must occur exactly once), delete
  paragraphs (never one holding a note reference), insert a generated contents list (a Word TOC
  field), decide findings (done, dismiss, ask; "copyedit list" for slips in the prose), triage rules
  (done, not applicable, checklist, ask), ask the author, finish.
- `execute.mjs`: roles and settings go through the product's formatter unchanged; text operations
  are then made on the formatted file as tracked changes by "CAIL Manuscript Desk", each declared
  with its words, and the product's word check runs on the result. An operation the spike cannot make
  safely (text inside a link, a field, a note reference, or a paragraph the formatter already
  changed) is refused and counted.
- `run-brill.mjs`: the pipeline runs, then the agent works through units (the settings; the front
  matter; each chapter's findings, at most 18 a unit, each with its paragraph's text and, where it
  matters, the paragraph before or after; the open rules, 50 a unit). The formatter and the checks run
  again with the agent's roles and settings, and a second round decides findings that are new.
  Policy, in `prompt.mjs`: decide and do, then tell; choose a default when the guidelines are
  silent; ask only real author decisions.

How the harness came to be (verified, and the main lesson for "agent-first"): the first run gave
DeepSeek the whole job in one conversation; it read the book for all 40 turns and recorded no
operation ($0.41). Split into units with reading allowed throughout, it again read until each
unit's turn limit. Only with reading closed after two turns of each unit (the reading tools are then
withdrawn and the model is told to decide) did it work. DeepSeek did not plan its own work; the
other models were run only inside the final harness, so whether any of them would is not measured.

### Results on the Brill manuscript

The whole book. The agent's prompt and harness were revised on this book, so this is a dev
measurement, not a held-out one. First runs of the final configuration:

| | Pipeline (the page today) | Pipeline + agent, DeepSeek | Pipeline + agent, GLM-5.3 | Hand job |
|---|---|---|---|---|
| Comments in the file (with the agent's summary) | 75 | 22 | 29 | 39 |
| Of the hand job's 27 questions, a comment at the same place | 25 | 16 | 20 | 27 |
| Of the tool's places, at a place where the hand job asked something | 61 of 94 | 19 of 21 | 24 of 29 | |
| Slips in the prose put on a copyedit list instead of comments | 0 | 41 | 41 | (left to the copyeditor) |
| Open rules (186) triaged | 0 | 184: done 48, not applicable 43, checklist 93 | 186: done 45, not applicable 43, checklist 92, ask 6 | 26-row checklist |
| Duplicated passage, stray lines deleted (hand job: 3 deletions) | 0 | 1 (the duplicate; the copy without the note) | 1 | 3 |
| Typed contents list replaced by a generated one | no (10 comments) | yes (44 of 46 paragraphs; one carries a section break and stays) | yes | yes |
| Repeated-author dashes replaced by the name, as the hand job did | 0 of 6 | 6 of 6 | 6 of 6 | 6 |
| Title typed in capitals retyped | 0 of 2 | 2 of 2 | 2 of 2 | 2 |
| Other text changes | | 14: 6 as the hand job, 5 wrong, 3 not judged | 11: 3 as the hand job, 5 wrong, 3 not judged | |
| Settings as the hand job's (6) | 2 | 5 (line spacing 2 against 1.5) | 5 (chapter label without its number) | 6 |
| Operations refused by validation (tools / execution) | | 13 / 5 | 2 / 5 | |
| Undeclared word changes; rejecting all changes gives the source | 0; yes | 0; yes | 0; yes | |
| Valid file | yes | yes | yes | |
| Style agreement with the reference (matched paragraphs) | 1,329 of 1,346 (98.7%), title blocks 46 of 46 | 1,341 of 1,358 (98.7%), 56 of 56 | the same | |
| `render-eval`: line spacing, left indent, first-line indent agreement | 0.0%, 97.0%, 73.4% | 0.0%, 65.2%, 41.9% | 34.7%, 65.2%, 41.9% | |
| `render-eval`: chapters whose page setup (margins, page numbers) agrees | 0 of 12 | 12 of 12 | 12 of 12 | |
| LibreOffice PDF pages (reference 223) | 237 | 258 | 214 | 223 |
| Agent calls, cost, wall clock | | 89 calls, $0.168, 279 s | 67 calls, $0.479, 343 s | |

The two models that passed the tool test only with the final prompt, run the same way (one run
each, verified counts, judgments inferred as above):

| | Inkling 2 Small | Mistral Large 3 |
|---|---|---|
| Comments; hand job's 27 questions kept; places at a hand question | 36; 20; 30 of 36 | 42; 21; 33 of 45 |
| Findings left undecided (kept as comments) | 18 (two units hit the turn limit) | 2 |
| Dashes, title capitals, contents list | 6/6, 2/2, yes | 4/6, 2/2, yes |
| Deletions outside the hand job's | 1 (one line of the three duplicated) | 2 (two lines of a chapter's title block, 7 words) |
| Other text changes: as the hand job / wrong / not judged | 5 / 6 / 2 | 3 / 6 / 2 |
| Tool calls malformed or to unknown tools; units ended without finish | 0; 2 | 15; 10 (3 refused by the Gateway) |
| Style agreement (matched paragraphs) | 1,340 of 1,357 | 1,245 of 1,260 (98 fewer matched: the deleted title-block lines and changed headings) |
| Cost, wall clock | $0.205, 653 s | $0.127, 231 s |

Neither is a candidate: Inkling is slow and leaves work undone; Mistral makes structural deletions
and malformed calls. No run of any model changed a word undeclared, and every file validated: the
code guarantee held whatever the model did.

The "wrong" text changes of DeepSeek and GLM (judged against the hand job, inferred): both models changed a novel's
title to the other spelling the chapter uses and rewrote a long title to divide it (the hand job asked
the author both), and both normalised a keyword list the hand job asked the authors to fix. DeepSeek
also dropped a keyword to reach the guidelines' ten and changed an affiliation to the form the
contents list gives (refused at execution); GLM removed the quotation marks from a title the hand job
asked about and joined one author line with a comma after choosing "and" for another. The prompt
said, after the first measured run, never to settle such a difference by replacing one form with
the other; both did it anyway. Prompting does not stop it; code must.

The appearance numbers move both ways. The agents' defaults put page numbers at the bottom centre
and set one-inch margins, so page setup now agrees in every chapter (0 of 12 before); but both chose
a half-inch hanging indent for the bibliographies where the hand job used one centimetre, which
lowers the indent agreement, and DeepSeek chose double spacing where the hand job chose 1.5. GLM kept
the publisher's own font from the guidelines (not installed here, so the PDF substitutes it, and font
agreement falls to 0%); DeepSeek cleared both font settings as misread. None of these is wrong by
the guidelines, which are silent; they are defaults, and the summary comment lists them.

Defaults the agents applied where the guidelines are silent: DeepSeek: line spacing 2, margins one
inch, page numbers bottom centre, a half-inch hanging indent, chapter label "Chapter 1"; it cleared
the two misread font settings. GLM-5.3: line spacing 1.5, margins one inch, page numbers bottom
centre, a half-inch hanging indent, chapter label "Chapter"; it kept the publisher's font.

Stability: a second run of each with the same configuration (verified):

| | DeepSeek run 1 | DeepSeek run 2 | GLM-5.3 run 1 | GLM-5.3 run 2 | DeepSeek, thinking on |
|---|---|---|---|---|---|
| Comments (with the summary) | 22 | 21 | 29 | 31 | 25 |
| Hand job's 27 questions with a comment near | 16 | 16 | 20 | 20 | 17 |
| Tool's places at a hand-job question | 19 of 21 | 17 of 20 | 24 of 29 | 25 of 30 | 21 of 24 |
| Rules triaged as "ask" | 0 | 0 | 6 | 20 | 0 |
| Other text changes: as the hand job / wrong / not judged | 6 / 5 / 3 | 5 / 4 / 4 | 3 / 5 / 3 | 6 / 3 / 3 | 6 / 4 / 3 |
| Dashes, title capitals, contents list, duplicate | 6/6, 2/2, yes, yes | the same | the same | the same | the same |
| Undeclared word changes; valid | 0; yes | 0; yes | 0; yes | 0; yes | 0; yes |
| Cost, wall clock | $0.168, 279 s | $0.160, 268 s | $0.479, 343 s | $0.516, 402 s | $0.222, 689 s |

The counts hold within a few between runs; which wrong change a model makes varies from run to run:
the rewrite dividing a long title appeared in one run of two for each model, the novel's title
changed in every thinking-off run but not with thinking on, and the keyword-list normalisation came
back in every run. Thinking on made DeepSeek two and a half times slower for one
more question kept and one fewer wrong change: not worth it.

### Agent-only on a short chapter

`scripts/spikes/agent/agent-only.mjs` gives one dev chapter (98 paragraphs) to the agent with no
labelling pipeline: it labels every paragraph through `set_roles` from the text and the reader's
formatting hints, and the formatter styles the result. DeepSeek: 96 of 98 roles right, structural 19
of 21, style names agreeing with the reference on 97 of 99 matched paragraphs, title block 4 of 4,
4 calls, $0.009, 20 s: the same as the pipeline's labels for that chapter (96, 19 of 21, 97). GLM-5.3:
91 of 98, structural 14 of 21, 92 of 99, $0.038. No word was touched (labelling changes no text) and
no operation was refused. So an agent can label as well as the pipeline with the same model, a little
cheaper (one reading per paragraph instead of two); it gains nothing on style names.

## Recommendation

(a) Extraction: DeepSeek V4.1 Flash (112 of 115 against GLM's 107, at a fifth of the cost).
(b) Labelling: DeepSeek V4.1 Flash (GLM is 5.4 points lower on structural roles).
(c) Reading comments: DeepSeek V4.1 Flash, the only model measured; route its queries to a copyedit
list, not to comments.
(d) Index: DeepSeek V4.1 Flash, by the earlier measurements only; not re-measured today.
(e) Workflow: **pipeline plus an agent pass**, the agent on DeepSeek V4.1 Flash. GLM-5.3 keeps more
of the real questions (20 of 27 against 16) and is worth a second look as the agent model if that
gap holds on a second book, at about three times the cost. Not agent-first.

Why not agent-first: the formatting itself, styles by role and the word guarantee, is code and is
already at 98.7% style agreement; labelling by the agent is no better than labelling by the
pipeline with the same model. What the agent adds is judgment over the pipeline's output: what to
do, what to default, what to ask. And it only does that inside a harness that cuts the job into
units and closes reading. Making the pipeline the agent's tools is the right direction, but built as
a decide step in the product, not a free agent.

A build plan, in order:

1. **Guards before anything ships.** In code, not the prompt: replace_text refused on a title block,
   a heading, a name or an affiliation unless a rule or a check names the exact change (the
   repeated-author dash, a title's capitals, quotation marks a rule forbids); no deleting words from
   keywords or abstracts; settings changed only in the settings unit; a deletion never touches a
   paragraph with a note reference (done in the spike).
2. **Text operations inside the formatter.** Accept declared edits (paragraph, before, after) and
   deletions as an input to `formatDocx`, applied before its tidy-ups, so an edit to a title the
   formatter splits is not refused (5 of each agent's operations were) and one set of tracked changes
   carries both.
3. **The decide step** after the checks: the unit harness of `run-brill.mjs` behind the page's
   step 6, stating calls and cost first (about 90 calls and $0.17 a book with DeepSeek), its
   decisions listed for the author and reversible one by one.
4. **The outputs the author sees**: one summary comment of what was done and which defaults were
   chosen; comments only for "ask"; a copyedit list as its own document; the checklist built from
   the triage, with repeated rules collapsed into one row.
5. **The operations the hand job needed that are still missing**: dividing a long title at a chosen
   place, moving a note on a title into a note on the text, numbering figures by the chapter's own
   number (and the bug above), a table from tabbed lines, a list of illustrations, part title pages.
6. **Measure again on a second manuscript** before trusting any of the numbers above.

## What would change the recommendation

- A second manuscript (ideally one with styles) where the agent keeps fewer than about 20 of the
  real questions, or where its wrong decisions survive the guards: then ship only the triage
  (rules and copyedit list), not the decisions on findings.
- GLM-5.3 keeping clearly more real questions than DeepSeek on a second book: then GLM for the
  agent pass despite the cost.
- A person going through the agent's tracked changes and decisions in Word and finding them
  acceptable (nobody has); or finding the summary comment's defaults unwelcome, in which case the
  defaults belong in a style-manual baseline instead of the agent's choice.
- A model that plans its own work (reads, then acts) well enough to drop the unit harness: then an
  agent-first design becomes worth measuring again. DeepSeek did not; the others were not tried that way.

## Unsure, and not run

- Everything is one book, and the agent's prompt and harness were adjusted on it.
- The classes in the headline tables are my reading of the hand job's method, not a measurement;
  the "wrong" and "as the hand job" judgments of the agents' text changes are mine too.
- The reading-check comparison across models and both index stages were not run.
- The probe document is small and invented; passing it says a model can use the tools, not that it
  decides well.
- Word was not opened (LibreOffice headless only, as asked); no one has accepted or rejected the
  agents' tracked changes, and the TOC field fills only when Word updates fields on opening.

## Spend

$4.72 at catalog prices of the $15 cap: $4.56 entered in the bake-off's ledger (answers $0.05, tool
test $0.24, extraction $1.01, roles $0.49, agent runs on the book $2.72, agent-only chapter $0.05) and
$0.16 for the reading check on every chapter (through `todos-eval`, outside the ledger), plus six
one-call tool probes (under a cent). Of the agent runs, $0.62 went to the two harness designs that did
not work (one conversation for the whole job; units with reading always open). The Gateway's own
estimate was not read back.

## How to run it

```bash
CAIL_API_KEY=... npm run bakeoff -- [--models a,b] [--stages answers,agent,extraction,roles]
node scripts/spikes/agent/questions.mjs                     # the headline counts; no model call
CAIL_API_KEY=... node scripts/spikes/agent/run-brill.mjs --model <id> [--thinking on] [--tag <name>]
CAIL_API_KEY=... node scripts/spikes/agent/agent-only.mjs --model <id> [--chapter <gold key>]
```

Every answer is cached in the private folder (`work/bakeoff/answers.json`, keyed by the model, the
thinking setting and the whole request) and every paid call is entered in `work/bakeoff/ledger.jsonl`;
no call starts once the ledger reaches `BAKEOFF_CAP` (default $15). The scripts print counts only;
the agents' specs, decisions, summaries and formatted files go to `work/bakeoff/` in the private folder.
