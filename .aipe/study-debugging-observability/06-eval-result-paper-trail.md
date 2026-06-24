# Eval result paper trail

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** offline observability, committed eval artifact, regression baseline, LLM-as-judge signal, post-hoc trace
**Type:** Industry standard (the broad shape) · Project-specific (the result-dir naming + EVAL_RUN_TAG + judge-as-debug-signal mix is this repo's design)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This is the **fourth observability surface** in blooming insights. The first three surfaced in earlier files — the live NDJSON stream that the UI renders (`01-` / `04-`), the snapshot replay path (`02-` / `03-`), and the test-runner output that gates correctness — are all *online* signals, scoped to one process or one request. The eval result paper trail is *offline*: every K-run sweep of an agent writes a committed JSON record per run (agent output, judge scores, per-criterion breakdown, raw transcripts) into a date-stamped folder under `eval/results/`. The folder is the unit of "one debuggable run"; the result JSONs are the post-hoc trace.

```
  Zoom out — the four observability surfaces

  ┌─ ONLINE (live, request-scoped) ──────────────────────────────────┐
  │  surface 1: NDJSON AgentEvent stream  → UI renders live          │
  │              (lib/mcp/events.ts, send closure)                    │
  │  surface 2: Vitest output            → CI gates correctness       │
  │              (269 unit tests; deterministic)                      │
  │  surface 3: Dev cache files          → mid-loop dev debugging     │
  │              (.auth-cache.json, .investigation-cache.json;        │
  │               gitignored)                                          │
  └────────────────────────────────────────────────────────────────────┘
                            │
                            │ phase 3 adds:
                            ▼
  ┌─ OFFLINE (post-hoc, committed) ──────────────────────────────────┐  ← we are here
  │  surface 4: Eval result paper trail   → debug at the model level  │
  │              eval/results/<date>[-<tag>]/                          │
  │                ├─ detection-K10-*.json                             │
  │                ├─ diagnosis-K10-*.json + summary.md               │
  │                ├─ recommendation-K10-*.json + summary.md          │
  │                ├─ regression-*.json + regression-summary.md       │
  │                └─ summary.md (per-day rollup)                     │
  │              EVAL_RUN_TAG env var → sibling dirs, no overwrite     │
  └────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A paper trail is a *committed, post-hoc, structured record of model behavior under a known stimulus*. Three properties are non-negotiable for it to count: **committed** (it survives across deploys, machines, and rebases — `git log` is part of the trail), **structured** (per-criterion judge scores, raw agent output, transcript — not freeform prose), and **per-run** (one record per K iteration, addressable by index so a regression at "run 8" is a real anchor). The result-dir naming convention (`<date>` plus optional `<tag>` via `EVAL_RUN_TAG`) is the primitive that makes the trail bisectable — two adjacent dirs are two adjacent measurements.

What this surface lets you debug that the other three can't: *model-level behavior*. The 269 unit tests can prove `runAgentLoop` dispatches tool calls in the right order; they cannot tell you "the recommendation agent invented a plausible-but-wrong AOV of R$131,965 because it confused cents with Reais." The live trace shows you the bug if you happen to be watching; the eval surface catches it *across K=10 runs* and flags it through an LLM-as-judge call that scores impact plausibility. The bug shows up as a `0` on `impact_sized` for run 8, with the judge's freeform note as the diagnostic anchor.

---

## Structure pass

**Layers.** Four: the runner scripts (`eval/scripts/run-{detection,diagnosis,recommendation,regression}.ts`), the result writer (a per-script `writeJson` that lands files under `eval/results/<date>[-<tag>]/`), the judge layer (`eval/judges/*.md` — LLM-as-judge prompts that score candidate outputs), and the human-facing summary (the per-run `summary.md` that aggregates K scores into a verdict).

**Axis: lifecycle (when does this evidence get produced, when does it get consumed?).** Trace it across the layers. Runner: produces evidence at *eval time* (manual `npm run eval:*` invocation, costs real Anthropic dollars, takes 5-10 min for K=10). Writer: produces files synchronously at end-of-run, into a date-stamped dir. Judge: produces structured per-criterion scores during the run, persisted alongside the raw output. Summary: a human reads the `.md` later — sometimes seconds, sometimes weeks. The lifecycle gap is the whole point: this surface exists to be consumed *after* the agent run is gone, by a different person, possibly long after the bug was introduced.

**Seams.** Three load-bearing:

- **Runner ↔ result dir.** The dir IS the trace. `EVAL_RUN_TAG` is the primitive that lets two same-day runs land in *sibling* directories instead of overwriting each other (`2026-06-15` vs `2026-06-15-after-fix` vs `2026-06-15-score-baseline`). The seam matters because it's where a re-run becomes a comparison rather than a destruction.
- **Agent output ↔ judge.** The judge is an LLM call (Claude Haiku) that reads the candidate's structured output and emits per-criterion scores (`impact_sized: 0|1`, `evidence_cited: 0|1`, etc.). The seam between "the agent did this" and "this is how good it was" is what converts a transcript into a *measurement*. Without the judge, the result dir is a haystack; with it, the JSON is a scoreboard.
- **Per-run JSON ↔ summary markdown.** The JSONs are machine-readable (you can `jq` across K runs); the summary is human-narrative (the per-run anomaly that broke is named in prose). The seam matters because the same evidence lands in two shapes — one for diffing, one for reading.

A *missing* seam, named for honesty: there's no auto-comparison between adjacent result dirs. If you re-run after a prompt fix, the lift comes from `diff eval/results/2026-06-15-after-fix/summary.md eval/results/2026-06-15/summary.md` by hand. A `compare-runs.ts` script would close that gap; today the comparison is muscle memory + grep.

```
  Structure pass — the eval paper trail

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  runner · writer · judge · summary             │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: produced WHEN, consumed WHEN?      │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  runner ↔ result dir: EVAL_RUN_TAG (LOAD)      │
  │     the dir naming IS the bisect primitive     │
  │  agent ↔ judge: scoreboard not haystack (LOAD) │
  │  json ↔ md: machine-diff + human-read (LOAD)   │
  │  adjacent dirs ↔ comparison: ABSENT (manual)   │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the runner, the writer, the judge, the flywheel.

---

## How it works

**Mental model.** A paper trail is *measurement persisted as a file*. The pattern is the same as a CI job's artifact dir, an `experiments/` folder in an ML repo, or a benchmarks-over-time table. The kernel is three steps: stimulate the system K times under controlled inputs, score each output with a structured rubric, write the scored evidence to a named directory you can later cite. The naming convention (`<date>[-<tag>]`) is the whole bisect substrate — adjacent dirs are adjacent measurements, and `git log eval/results/` is the history of how the system behaved over time.

```
  Pattern — the eval flywheel (measure → debug → fix → re-measure)

           ┌─ baseline ─┐
           │  measure   │   → result-dir 1 (e.g. 2026-06-15)
           └─────┬──────┘
                 │ surface a bug (judge flags it,
                 │ or low precision, or implausible number)
                 ▼
           ┌─ diagnose ─┐
           │  read JSON │   → identify the specific run (run 8)
           │  + transcript│  + the specific criterion (impact_sized=0)
           └─────┬──────┘
                 │
                 ▼
           ┌─ fix ──────┐
           │  prompt /  │   → code change (a phrase in the prompt,
           │  prompt    │     or a unit conversion in the agent)
           │  + code    │
           └─────┬──────┘
                 │
                 ▼
           ┌─ re-measure┐
           │  EVAL_RUN_TAG= → result-dir 2 (sibling: -after-fix)
           │  after-fix  │     no overwrite, two measurements
           └─────┬──────┘     side by side
                 │
                 ▼
           verdict: lift verified or not
                  (PR D: detection 5% → 25% precision = 5x)
```

### Move 2 — walk the parts

#### The runner — K iterations against a known fixture

The reader anchor: you've written a benchmark that runs a function N times and prints the median. Same shape — but here the function is a full agent loop (Anthropic + MCP + tools), the input is a fixed dataset (seeded Olist data with 3 known anomalies), and "median" is replaced with per-criterion scores from an LLM judge.

What happens: `npm run eval:detection -- --K=10` spawns the runner script. It loads `.env.local` (for `ANTHROPIC_API_KEY`), connects to the OlistDataSource (a separate MCP server with seeded SQLite data), and runs the monitoring/diagnostic/recommendation agent K times *sequentially*. Each iteration is isolated — a fresh subprocess for the data source, a fresh in-memory agent. The output of each run is the raw `Anomaly[] | Diagnosis | Recommendation[]` plus the agent's transcript.

Boundary: K=10 costs ~$1-3 in Anthropic spend. The sequential-not-parallel choice matters — it avoids the cross-run race that *did* happen during dev (named below in Use cases). Parallelism would speed it up but mix the trails; sequential keeps every run cleanly indexable by integer.

```
  Runner — what one invocation produces

  npm run eval:detection -- --K=10
       │
       ▼
  for i in 0..K-1:
    spawn fresh OlistDataSource subprocess         ← isolation
    run MonitoringAgent.scan() once
    collect emitted Anomaly[]
    score against 3 seeded anomalies (loose + strict)
    accumulate per-run record
       │
       ▼
  writeJson(eval/results/<date>[-<tag>]/
              detection-K10-{raw,loose,strict}.json)
  writeJson(eval/results/<date>[-<tag>]/summary.md)
```

#### EVAL_RUN_TAG — the sibling-dir primitive

The reader anchor: you've named output files with a date stamp and watched them overwrite each other on a second same-day run. The fix is usually `<date>-<seq>` or `<date>-<descriptor>`. Here it's `<date>[-<tag>]`, driven by an environment variable.

What happens: each runner script reads `process.env.EVAL_RUN_TAG` after parsing the date. If `EVAL_RUN_TAG` is set, the result dir becomes `<date>-<tag>` instead of `<date>`. The same-day re-run discipline lives entirely in this one env var. The four committed result dirs (`2026-06-15`, `2026-06-15-after-fix`, `2026-06-15-capture`, `2026-06-15-score-baseline`) all share a date but each is a separate measurement context.

Boundary: there's no enforcement. If you forget `EVAL_RUN_TAG`, you overwrite. The convention is "set the tag whenever you're running an eval to compare against an earlier same-day baseline" — but it's discipline, not type-checked. The cost of the mistake is reproducible (just re-run), so the lightweight approach is correct.

```
  EVAL_RUN_TAG — sibling-dir naming

  no tag:                          EVAL_RUN_TAG=after-fix:
  ─────────────────────────────    ─────────────────────────────
  eval/results/                    eval/results/
    2026-06-15/                      2026-06-15-after-fix/
      detection-K10-*.json             detection-K10-*.json
      summary.md                       summary.md

  same-day re-run WITHOUT a tag    same-day re-run WITH a tag
  → overwrites the earlier run     → sibling dir, both measurements
    (history lost)                   land in git diff side by side
```

#### The judge — LLM-as-judge as a debug signal source

The reader anchor: you've written a test assertion that compares output against an expected value. Same shape — but for outputs that have no single "expected value" (a recommendation's plausibility, a diagnosis's narrative quality), the assertion is itself an LLM call. The judge reads the candidate, reads a rubric (from `eval/judges/*.md`), and emits structured scores plus a freeform `notes` field.

What happens: the runner passes each candidate output to a judge invocation (Claude Haiku — cheap, fast). The judge prompt is committed in `eval/judges/recommendation-judge.md` / `diagnosis-judge.md` / `similarity-judge.md`. It scores per-criterion: `impact_sized: 0|1`, `evidence_cited: 0|1`, `steps_actionable: 0|1`, plus a `notes` string. The scores aggregate; the notes are the *diagnostic anchor* — when the judge writes "AOV BRL 131,965 is implausible for a Brazilian consumer electronics order," that one sentence is what surfaced the cents-vs-Reais bug.

Boundary: judge calibration is the load-bearing trust check. The repo manually spot-checks judge agreement against human judgment (recommendation eval: 3-of-3 sampled runs the judge's verdict matches the developer's). That spot-check is what licenses the judge as a *real* signal rather than an authoritative-looking nothing. Without calibration receipts, the scores would be theatre.

```
  Judge as observability — LLM call as a debug signal

  candidate output (one run's Recommendation[])
       │
       ▼
  judge prompt (eval/judges/recommendation-judge.md)
       + rubric: impact_sized, evidence_cited, steps_actionable
       │
       ▼  Claude Haiku invocation
  structured scores per criterion
       + freeform `notes` (the anchor for surprising findings)
       │
       ▼
  recommendation-K10-judge.json
       │
       ▼
  human reads notes:
    "AOV BRL 131,965 is implausible"   ← THE bug, found by judge
    → cents-vs-Reais conversion error
    → fix the agent's unit handling
    → re-measure with EVAL_RUN_TAG=after-fix
```

#### The summary — human-narrative rollup

The reader anchor: you've written a benchmark report that lists the median, p95, and a "what stood out" paragraph. Same shape — the summary `.md` aggregates K scores into precision/recall/per-criterion-rates and names the specific runs that broke as prose.

What happens: at end of run, the script aggregates per-run scores into rates (e.g. "8/10 runs cited evidence"), renders a markdown table, and includes a "notable runs" section that names specific failure modes the judge flagged. The summary is committed alongside the JSONs — it's the human entry point ("which day was the BRL bug recurring?"), and the JSONs are the machine entry point ("`jq '.runs[7].scores'` to pull the offending run's structured record").

Boundary: the summary is hand-readable but not machine-comparable. To diff two summaries (baseline vs after-fix) you read both and reason about the delta. A `compare-summaries.ts` script would close this; today, manual diffing is the workflow.

#### Move 3 — the principle

When agent behavior is the unit of correctness, ship the eval results as committed artifacts and name the result-dirs by the unit of "one debuggable run." The lesson generalises beyond this codebase: any time the system under test is non-deterministic, qualitative, or model-driven, the only sane debugging surface is *post-hoc, structured, persisted measurement*. Unit tests assert wiring; eval results assert behavior. Both are correctness surfaces; only the latter scales to "did the prompt change degrade quality?" The result-dir naming + EVAL_RUN_TAG + LLM-as-judge + manual calibration-spot-check stack is the smallest credible version of this discipline that still works.

---

## Primary diagram

The full eval paper trail, from runner invocation to git-committed evidence.

```
  Eval result paper trail — full picture

  ┌─ Trigger ────────────────────────────────────────────────────┐
  │  npm run eval:{detection,diagnosis,recommendation,regression} │
  │    -- --K=10                                                   │
  │  optional: EVAL_RUN_TAG=after-fix npm run eval:...             │
  └─────────────────────────▲────────────────────────────────────┘
                            │
  ┌─ Runner (eval/scripts/run-*.ts) ──────────────────────────────┐
  │  load .env.local (ANTHROPIC_API_KEY)                            │
  │  for i in 0..K-1:                                               │
  │    spawn OlistDataSource subprocess (fresh per iteration)       │
  │    run agent ONCE                                               │
  │    candidate = agent output                                     │
  │    judge = invoke Claude Haiku w/ eval/judges/*.md rubric       │
  │    push { i, candidate, judgeScores, transcript } to records    │
  │  aggregate records → per-criterion rates                        │
  └─────────────────────────▲────────────────────────────────────┘
                            │ writeJson + writeMarkdown
  ┌─ Result dir (eval/results/<date>[-<tag>]/) ────────────────────┐
  │  detection-K10-raw.json        ← per-run candidate outputs      │
  │  detection-K10-loose.json      ← loose match scores             │
  │  detection-K10-strict.json     ← strict match scores            │
  │  diagnosis-K10-candidates.json ← raw diagnoses                  │
  │  diagnosis-K10-judge.json      ← per-criterion judge scores     │
  │  diagnosis-K10-summary.json    ← aggregated rates               │
  │  recommendation-K10-*.json     ← same triple                    │
  │  regression-*.json             ← per-snapshot regression scores │
  │  summary.md                    ← human-narrative rollup         │
  │  recommendation-summary.md     ← per-rubric verdict             │
  │  regression-summary.md         ← regression verdict             │
  └─────────────────────────▲────────────────────────────────────┘
                            │ git add eval/results/<date>[-<tag>]/
                            │ git commit -m "..."
  ┌─ Committed paper trail ───────────────────────────────────────┐
  │  git log eval/results/ → behavior history over time             │
  │  diff eval/results/A/ eval/results/B/ → measure the fix          │
  │  jq '.runs[7]' eval/results/.../diagnosis-K10-judge.json        │
  │     → cite the specific run that broke                          │
  └────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Four real moments the paper trail is doing visible work:

- **PR D: detection-precision baseline reveals the monitoring-prompt bug.** Ran K=10 of the monitoring agent against the seeded Olist data. Detection precision came back at 5% under loose match — far below the expected ~50%. Reading `eval/results/2026-06-15/detection-K10-raw.json` showed the agent was emitting time-windowed anomalies that didn't align with the seeded ground-truth windows. The bug was in the monitoring prompt's date framing — "the last 90 days" was being interpreted relative to a date the agent had baked in from training data rather than the current run date. Phase 2.5 fixed the prompt to inject `today` explicitly; re-ran with `EVAL_RUN_TAG=after-fix`; precision lifted 5x to 25%. The verification was a *side-by-side measurement* of two committed dirs, not a re-deploy.

- **PR E: recommendation eval's run 8 surfaces the BRL cents-vs-Reais bug.** Ran K=10 of the recommendation agent. Eight of the runs scored well; run 8 came back with `impact_sized: 0` and a judge `notes` field reading *"AOV BRL 131,965 is implausible for a Brazilian consumer electronics order — these are stored as cents in the source schema."* That one sentence was the bug. The agent treated `purchase.price_brl` (stored as cents in the seeded data) as Reais, computed an Average Order Value 100x too high, and the judge caught the absurdity. The fix was a unit-conversion guard in the agent's number-handling step. Without the judge, the result would have looked statistically fine — 9/10 is a great number; the bug only surfaced because one criterion flagged one run.

- **PR F: regression eval catches the same BRL bug recurring at run 8 of K=10.** A few weeks later, a refactor of the recommendation agent's tool calling regressed the unit-conversion fix. The regression eval (K=10 against the captured golden run) flagged the same numerical fingerprint — R$131,965 AOV — at run 8. The *exact same run index*, the *exact same fingerprint*. That convergence was the diagnostic — "the same numerical signature recurring in the same iteration slot means the same code path failed in the same way." Two adjacent result dirs (PR E's and PR F's) made the recurrence visible at a glance. Numerical fingerprints across runs are a real observability primitive.

- **PR G: regression baseline 30% reveals conclusion-stability as the system's weakest property.** Ran a K=10 regression against three golden snapshots. The score came back at 30% — diagnoses matched the golden 30% of the time across snapshots. That number isn't a per-bug signal; it's a *property* signal — the system's conclusions are unstable across re-runs of the same input. The result dir `2026-06-15-score-baseline` is the committed evidence of that property; the next pass at improving the diagnostic agent has a measurable target to lift.

### Code side by side, with a line-by-line read

The result-dir naming — EVAL_RUN_TAG as the sibling primitive:

```
  eval/scripts/run-detection.ts  (the results-dir computation)

  // EVAL_RUN_TAG lets a same-day re-run land in a sibling dir (e.g.
  // 2026-06-15-after-fix) without overwriting the earlier baseline.
  const tag = process.env.EVAL_RUN_TAG;                          ← optional env var
  const today = new Date().toISOString().slice(0, 10);            ← YYYY-MM-DD
  const dirName = tag ? `${today}-${tag}` : today;                ← sibling when tagged
  const resultsDir = resolve(REPO_ROOT, 'eval/results', dirName); ← absolute path
  mkdirSync(resultsDir, { recursive: true });                     ← create if missing
        │
        └─ no flag handling, no CLI arg — the env var IS the API.
           Forgetting the tag overwrites; setting it preserves history.
           The discipline lives in shell muscle memory, not in code
           validation. Cheap and clear.
```

The runner's iteration loop — sequential to avoid cross-run race:

```
  eval/scripts/run-detection.ts  (the K-loop)

  const perRun: PerRunScore[] = [];
  for (let i = 0; i < K; i++) {                                  ← sequential, not parallel
    const insights = await runMonitoringAgentOnce(seeded);       ← fresh subprocess per call
    const loose = scoreRun(insights, seeded, 'loose');
    const strict = scoreRun(insights, seeded, 'strict');
    perRun.push({ i, insights, loose, strict });
  }
  const aggregate = aggregateScores(perRun);
  writeFileSync(join(resultsDir, 'detection-K10-raw.json'),
                JSON.stringify(perRun, null, 2));
  writeFileSync(join(resultsDir, 'detection-K10-loose.json'),
                JSON.stringify(aggregate.loose, null, 2));
        │
        └─ the sequential loop is deliberate. Parallel K=10 against
           the same OlistDataSource WOULD race the SQLite reads and
           mix the trails. The parallel-run race anecdote (below)
           is what made the sequential choice non-negotiable.
```

The judge prompts — committed under `eval/judges/`:

```
  eval/judges/recommendation-judge.md  (the rubric, abbreviated)

  ## Rubric

  For each candidate Recommendation, score 0 or 1 on each criterion:

  - impact_sized: Does estimatedImpact include a defensible numeric range?
                  Reject if the number is implausible for the data domain
                  (e.g. AOV of BRL 131,965 for consumer electronics is
                  implausible — these are stored as cents).
  - evidence_cited: Does rationale reference concrete metrics from the
                    diagnosis evidence?
  - steps_actionable: Are steps[] concrete enough that a marketer could
                      execute without further interpretation?
        │
        └─ the rubric IS the observability contract. The "BRL 131,965"
           example in the prompt is calibration tuning — once the bug
           surfaced, the rubric was updated to include it explicitly
           as a teaching example for the judge. The prompt itself
           becomes a paper trail of which bugs the system has learned
           to catch.
```

The committed result dirs — git as the history substrate:

```
  eval/results/  (as of 2026-06-16)

  2026-06-15/                     ← PR D initial baseline (detection 5%)
  2026-06-15-after-fix/           ← PR D after Phase 2.5 prompt fix (25%)
  2026-06-15-capture/             ← PR F regression-golden capture
  2026-06-15-score-baseline/      ← PR G regression score baseline (30%)
        │
        └─ four sibling dirs, all same date, different EVAL_RUN_TAG.
           `git log eval/results/` shows the chronological order of
           measurement; `diff` shows the deltas. The naming convention
           is what makes the trail bisectable by hand — no tooling
           required to see "after-fix lifted detection 5x over the
           initial baseline."
```

---

## Elaborate

The eval paper trail pattern is the same shape as ML's `experiments/` directories (Weights & Biases, MLflow, sacred — all variants of "run, record, commit"), the `bench/` artifacts in compiler/database repos (where every PR ships with a perf trace), and SRE-style postmortem corpuses (where every incident's evidence is preserved in a versioned doc). The common thread: when the system under test is non-deterministic or qualitative, the trace of *measurement* is the substrate for debugging — not the trace of *execution*.

What this pattern gets right that ad-hoc evaluation often misses: the commit. Many teams run evals informally — Slack the score, screenshot the table, move on. Without commits, the trail vanishes; the next person can't bisect, can't reproduce, can't trust the baseline. The blooming insights approach treats eval results as *code artifacts*: every committed result dir is a deployable, diffable, citable record. The `EVAL_RUN_TAG` env var is the smallest possible affordance for "don't overwrite history" — discipline, not enforcement, but cheap to apply.

What's missing — and worth naming — is a **comparison script**. Today, the diff between `2026-06-15` and `2026-06-15-after-fix` is done by opening both `summary.md` files in adjacent panes. A `compare-evals.ts` that reads two result dirs and emits a structured delta ("detection precision: 5% → 25%, +20pp") would close that. It's also where the trail starts to look like a *time series* rather than discrete commits — once you have the comparison primitive, you can ask "show me the precision over the last 10 evals." The naming convention is the substrate; the comparison tool would be the visualizer on top.

Worth noting separately: **LLM-as-judge as observability**. The judge layer is where this surface gets *interesting*. A unit test asserts "the array has 3 items"; the judge asserts "the average order value is plausible given the data domain." That's a qualitatively different kind of signal — it's *human-quality judgment via a cheap LLM call*. The calibration discipline (manually spot-checking that the judge agrees with the human's verdict on a sample of runs — 8/8 on diagnosis, 3/3 on recommendation) is what makes the judge's output a real debug signal rather than authoritative-looking noise. Without the calibration receipts, you have no license to trust the score; with them, the score becomes the cheapest plausible substitute for a senior reviewer reading every output by hand.

The relationship to the live `AgentEvent` trace (surface 1): the eval transcript captured per run is a *post-hoc serialization of the same event stream*. The unit of evidence is the same shape; what changes is the consumption pattern (live vs offline) and the addition of judge scores. In an ideal future, the captured `eval/results/<date>/*-raw.json` would include the full `AgentEvent[]` array per run — at which point the eval surface becomes the snapshot surface, just at a different scope (one investigation vs K iterations across a fixture). Today they're separate; the lesson is that they're not as far apart as they look.

---

## Interview defense

**Q1. Walk me through how the eval result paper trail is different from the three online observability surfaces.**

Four surfaces total. The first three are *online* — scoped to one process, one request, one CI run. Surface 1 is the live NDJSON `AgentEvent` stream the UI renders; surface 2 is Vitest output gating correctness on 269 unit tests; surface 3 is the dev cache files (`.auth-cache.json`, `.investigation-cache.json`) that survive server restarts in dev. All three are *now*-scoped.

Surface 4 — the eval paper trail — is *offline and committed*. Every K-run sweep (`npm run eval:detection -- --K=10`) writes per-run JSON records plus a summary markdown to `eval/results/<date>[-<tag>]/`. The dir is committed; `git log eval/results/` is the history of how the system behaved over time. The unit of debugging is "one date-stamped run dir," not "one HTTP request." The reason this matters: model-level bugs (a prompt drift, a unit-conversion error, a tool-misuse regression) don't surface in unit tests and don't surface in a single live run — they show up *across K iterations* as a low score or a judge-flagged anomaly. Different scope, different debuggability.

```
  three online surfaces       fourth (offline) surface
  ─────────────────────       ──────────────────────────
  live trace (request)        eval results (committed)
  Vitest (CI)                 EVAL_RUN_TAG sibling dirs
  dev cache (dev machine)     judge scores per criterion

  scope: one process          scope: K iterations, captured
  lifetime: minutes           lifetime: forever (git)
  catches: wiring bugs        catches: model-behavior bugs
```

**Anchor:** "unit tests catch wiring; eval results catch behavior. Different surfaces, different bugs."

**Q2. The judge is itself an LLM call. How do you trust it?**

Two moves. (1) **Structured rubric, not freeform critique.** The judge prompts (`eval/judges/recommendation-judge.md`, `diagnosis-judge.md`, `similarity-judge.md`) emit per-criterion 0/1 scores plus a `notes` field. The structure is what makes the score aggregateable across K runs — 8/10 evidence_cited is a measurement, not an opinion. (2) **Calibration receipts.** Manually spot-check judge agreement against developer judgment on a sample of runs. For the diagnosis judge, 8/8 sampled runs the judge's verdict matched mine. For the recommendation judge, 3/3. Those receipts are the license to trust the score on the unsampled runs.

The judge's freeform `notes` field is where the most diagnostically interesting signal lives. The cents-vs-Reais bug surfaced because the recommendation judge wrote *"AOV BRL 131,965 is implausible for a Brazilian consumer electronics order — these are stored as cents in the source schema."* That one sentence is what a senior reviewer would write, and the judge wrote it. The score (`impact_sized: 0`) flagged the run; the note pointed at the bug. That's the whole shape of LLM-as-judge as a debug signal — cheap human-quality judgment, calibrated by spot-check.

```
  trust ladder for LLM-as-judge
  ──────────────────────────────
  layer 1: structured rubric    → scores are aggregateable
  layer 2: freeform notes       → diagnostic anchor
  layer 3: calibration receipts → license to trust the score
            (manual spot-check, sample of runs)
                  ▲
                  └─ without layer 3, the score is theatre
```

**Anchor:** "the judge's notes field is where the bug-finding signal actually lives; the calibration receipt is what licenses you to trust it."

**Q3. Walk me through the parallel-run debugging incident.**

K=10 of the recommendation eval was running from the main session's Bash. While that was running, a PR E sub-agent started ALSO running K=10 against the same OlistDataSource. Two `npm run eval:recommendation -- --K=10` processes, same SQLite file, same date-stamped output dir. Detection was process-level: `ps aux | grep eval` showed two competing PIDs (30039 and 30040). The fix was `kill 30039 30040` before the writes collided. The detection primitive was *process listing* — there's no in-app race-detection, no lock file, no `.eval.lock`.

The lesson generalises: when result-dirs are date-stamped without a tag, *any* concurrent re-run is a silent overwrite race. The defensive move is `EVAL_RUN_TAG=session-1` / `EVAL_RUN_TAG=session-2` for the two sessions, which would have made them land in sibling dirs instead of fighting. The actual workflow change was "always set `EVAL_RUN_TAG` when running an eval from a sub-agent." It's discipline, not enforcement — but the `ps aux` + `kill` recovery is real process-level observability when the in-app surface doesn't exist.

```
  parallel-run incident — process-level debug

  symptom:    two `npm run eval` processes running, same output dir
  detection:  ps aux | grep eval → PIDs 30039 and 30040
  diagnosis:  date-stamped dir + no tag = silent overwrite race
  fix:        kill 30039 30040 (interrupt before collision)
  prevent:    EVAL_RUN_TAG=<session> when spawning from sub-agent
                  ▲
                  └─ no lock file, no in-app detection
                     process-level tooling IS the debugger here
```

**Anchor:** "when the in-app surface doesn't exist, `ps aux` + `kill PID` IS the observability tool."

---

---

## See also

- `audit.md` — the broader lens audit; this surface is named in observability-map, reproduction-and-evidence, and incident-analysis-and-prevention.
- `01-ndjson-agentevent-discriminated-union.md` — the live trace shape that the eval transcripts post-hoc serialize.
- `02-replay-from-snapshot-with-paced-emission.md` — the snapshot replay that operates on a single request's events; this surface operates on K iterations.
- `05-auth-secret-flake-postmortem.md` — the test-level incident; this file adds the eval-level + process-level incident anecdotes (parallel-run race).
- `.aipe/study-ai-engineering/05-evals-and-observability/` — owns the eval design lessons in depth; this guide names the eval results as an *observability surface*, that guide owns the *eval methodology*.
- `.aipe/study-testing/` — owns the test-level correctness surface; the eval surface is the model-behavior complement.

---
Updated: 2026-06-16 — new file: fourth observability surface (eval result paper trail, EVAL_RUN_TAG, flywheel methodology, LLM-as-judge as debug signal, parallel-run process-level debugging incident).
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
