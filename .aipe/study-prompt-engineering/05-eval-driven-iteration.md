# 05 — Eval-driven prompt iteration

*Eval-driven development for prompts · Industry standard · Case B (substrate absent)*

## Zoom out, then zoom in

This concept is the senior-vs-junior dividing line in prompt work. Pull up where the eval substrate *would* live in this codebase.

```
  Where eval-driven iteration would sit in the system

  ┌─ Source (lib/agents/legacy-prompts/*.md) ─────────────────────────┐
  │  monitoring.md · diagnostic.md · recommendation.md · query.md      │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ The missing layer ▼ ─────────────────────────────────────────────┐
  │  ★ EVAL HARNESS — DOES NOT EXIST IN THIS REPO TODAY ★             │ ← we are here
  │   - golden set (20–50 hand-curated cases with expected outputs)    │
  │   - regression suite (production failures, added forever)          │
  │   - score: deterministic checks + LLM-as-judge for fuzzier shapes  │
  │   - runner: in CI, on every prompt PR                              │
  │  NOT PRESENT IN THIS REPO: no eval/ directory, no harness today.   │
  │  TODAY: by-hand comparison against lib/state/demo-*.json snapshot │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ Process ▼ ────────────────────────────────────────────────────────┐
  │  prompt change → run evals → diff outputs → keep if improved        │
  │  TODAY: prompt change → run live → eyeball UI → ship                │
  └────────────────────────────────────────────────────────────────────┘
```

This file is **Case B**: the pattern is real and load-bearing across the industry; the substrate is *absent* from this repo today. There is no `eval/` directory, no 4-pillar eval suite, no LLM-as-judge harness. The honest framing matters — without evals, prompt iteration in this codebase is by-hand against the captured demo snapshot, and that's a real gap I'd close next.

## Structure pass

**Layers.** Outer: the iteration loop (change prompt → measure → decide). Middle: the eval set (golden set + regression suite). Innermost: the per-case scoring function.

**Axis — what flips between "amateur" and "professional" prompt work.** Walk it down:

```
  one axis — "how do I know this prompt change is better?" — three layers

  ┌─ amateur ─────────────────────────┐
  │  "the response feels better now"  │   vibes
  └───────────────────────────────────┘
       ┌─ middle ground (this repo today) ─┐
       │  "the demo snapshot still renders" │  single-snapshot regression
       └────────────────────────────────────┘
            ┌─ professional ────────────────┐
            │  "score went 0.78 → 0.84      │  golden-set + regression suite
            │   without regressing any case" │  + LLM-as-judge for fuzzier shapes
            └────────────────────────────────┘
```

**Seams.** The biggest seam is between *deterministic* checks (the type guards already in `lib/mcp/validate.ts`) and *semantic* checks (does the diagnosis actually explain the anomaly?). Type guards catch shape drift; semantic checks need an eval set.

## How it works

### Move 1 — the mental model

You know how you don't ship a database migration without running it against a test database first? Eval-driven prompt iteration is the same shape: you don't ship a prompt change without running it against a curated set of cases first.

```
  The eval-driven loop — change-measure-decide

       ┌──────────────────────────────────────────────────────────┐
       │                                                            │
       ▼                                                            │
  ┌─────────┐    ┌────────────┐    ┌─────────────┐    ┌──────────┐│
  │ change  │ →  │ run evals  │ →  │ diff scores │ →  │ keep or  ││
  │ prompt  │    │ (N cases)  │    │ + per-case  │    │ revert   ││
  └─────────┘    └────────────┘    └─────────────┘    └────┬─────┘│
                                                            │      │
                                                            └──────┘

  the loop is fast (seconds per iteration) only when the eval set is real
```

The kernel: a set of cases with expected outputs, a scoring function, and the discipline to *write the eval before iterating the prompt*. Without those three, you're iterating against a moving target — "better" is whatever the most recent run looked like.

### Move 2 — the walkthrough

**Step 1 — the golden set.** A hand-curated set of 20–50 cases that represent the *real* range of inputs the prompt will see. Each case has an input (what gets fed to the prompt) and an expected output (what a correct response looks like).

For the monitoring agent in this codebase, a golden set would look like:

```
  Pattern — a golden set entry for the monitoring agent

  {
    "name": "revenue-drop-Q4-2025",
    "input": {
      "workspace": "wobbly-ukulele",
      "schemaSnapshot": "fixtures/wobbly-q4.json",   // a real workspace state
      "categories": ["revenue_drop", "conversion_drop", "traffic_drop"]
    },
    "expected": {
      "containsCategory": "revenue_drop",
      "severity": "critical",
      "scopeContains": "global",
      "changeDirection": "down",
      "changeValueMin": 20.0,    // critical = >20%
      "evidenceCount": ">=1"
    }
  }
```

Note: expected is *constraint-based*, not byte-equal. You can't byte-compare LLM output — it's probabilistic. You can check "contains the category id `revenue_drop`," "severity is `critical` or `warning`," "scope includes `global`." These are deterministic predicates over the parsed structured output.

**Step 2 — the regression suite.** Every production failure that's worth not regressing on, added as a case. Forever. The regression suite *only grows*. This is the part that compounds — six months in, the regression suite is the project's memory of every bug it ever shipped.

For this codebase, the regression suite would include:

  → A workspace with 0 events in the last 90 days (the "data may be historical" failure mode named in `legacy-prompts/diagnostic.md:48-54`).
  → A workspace with a syntax-validation EQL error (the "bare leading dot in a breakdown" case from `legacy-prompts/monitoring.md:63-67`).
  → A workspace where the prompt model would *want* to invent anomalies for empty data — assert the output is `[]`.
  → A workspace where the model exhausts its tool-call budget (assert the forced-final synthesis turn produces parseable JSON).

Each one of these is a real failure I'd seen and fixed by adjusting the prompt; without the regression suite, the next prompt change is one step from re-introducing it.

**Step 3 — the iteration loop.** Pseudocode:

```
  # iterate-prompt.py — the eval-driven loop

  baseline_scores = run_evals(prompt_version='HEAD~1')   # what's currently in main
  candidate_scores = run_evals(prompt_version='HEAD')    # what's in the PR

  for case in eval_set:
    if candidate_scores[case] < baseline_scores[case]:
      print(f"REGRESSION on {case.name}: {baseline} → {candidate}")
      print(f"  input:    {case.input}")
      print(f"  baseline: {case.baselineOutput}")
      print(f"  candidate:{case.candidateOutput}")

  if any_regression and not approved_with_justification:
    exit(1)   # block the PR

  print(f"avg score: {baseline_avg} → {candidate_avg}")
  if candidate_avg < baseline_avg - tolerance:
    exit(1)   # average regressed, block
```

The discipline: **average improvement is not enough.** A prompt change that improves the average by 3 points but regresses one critical case is *not* a win — that one case is in the regression suite for a reason. You either fix the regression or document why it's an acceptable trade.

**Step 4 — LLM-as-judge for fuzzier shapes.** Some outputs can't be checked with deterministic predicates. The recommendation agent's `rationale` field is one — "is this rationale a good explanation?" isn't a regex. The pattern: a *second* LLM call that scores the output against a rubric.

```
  Pattern — LLM-as-judge, for fuzzier outputs

  ┌─ candidate output ─────────────────────┐
  │  {                                      │
  │    "title": "Send recovery email...",   │
  │    "rationale": "Mobile cart abandonment │
  │       jumped 23% — a recovery email      │
  │       targeting that segment recovers..."│
  │  }                                      │
  └────────────────────┬───────────────────┘
                       │
  ┌─ rubric (you author) ─────────────────┐
  │  Score the rationale 1–5:               │
  │   - cites a specific number from        │
  │     the diagnosis                       │
  │   - names the customer segment          │
  │   - explains the causal link            │
  │   - actionable for a marketer           │
  └────────────────────┬───────────────────┘
                       │
  ┌─ judge LLM call ▼ ────────────────────┐
  │  Score: 4/5                             │
  │  Missing: doesn't quantify recovery     │
  │  Confidence: high                       │
  └─────────────────────────────────────────┘
```

LLM-as-judge has its own failure modes — it has the same blind spots as the model being judged (this matters more for self-critique; see concept 10). The discipline: use it for outputs where deterministic scoring would be impossible *and* you can spot-check 10% of the judge's scores against human review.

**The specific bug — better average, worse edge case.** This is the classic. You ship a prompt change. Average score on the eval set goes up. You ship it. A week later a customer reports a critical bug — turns out the prompt change "improved" the average by being better on common cases but completely regressed one tail case that wasn't in the eval set yet.

The fix isn't "more cases" — you can't enumerate them in advance. The fix is the *discipline*: when a production failure happens, add it to the regression suite before fixing it. The regression suite is the project's memory of "things we've broken before."

**Why this file is Case B.** There is no eval substrate in this codebase today — no `eval/` directory, no 4-pillar suite, no LLM-as-judge harness. The current state of "how do I know a prompt change is better":

```
  Honest state — eval substrate today

  TARGET STATE                           ACTUAL STATE (today)
  ────────────                           ────────────────────
  eval/ harness                          (none — no eval/ directory)
  LLM-as-judge runner                    (none)
  golden + regression cases              (none)
  CI on every prompt PR                  (none)
                                          ↓
                                          by-hand verification:
                                            change prompt
                                            run /api/briefing live
                                            eyeball UI output
                                            compare against lib/state/
                                              demo-insights.json
                                              demo-investigations.json
                                            ship if it looks right
```

What I have today is the *single committed demo snapshot* at `lib/state/demo-*.json` — a useful one-data-point regression check but not an eval set. The substrate has to be built from scratch; the project exercises below sketch the smallest version that closes the gap.

**What I'd build next.** The discipline doesn't need the old infrastructure rebuilt — it needs a new one that fits the current shape:

  1. ~10 hand-curated cases, each a workspace-schema fixture + expected anomaly shape.
  2. A runner that calls the actual `MonitoringAgent.scan()` (and `DiagnosticAgent.investigate()`) against each fixture using a recorded/replayed Anthropic response.
  3. Deterministic predicates over the structured output (the type guards in `lib/mcp/validate.ts` are half of this — they catch shape; the eval predicates would catch *content*).
  4. CI on every PR that touches `lib/agents/legacy-prompts/` or `AGENT_MODEL`.

The prerequisite is concept 03 (prompts-as-code) — already in place. The actual harness is the missing piece.

### Move 3 — the principle

Eval-driven iteration is the same discipline as test-driven development, with one twist: the assertions can't be exact equalities, they have to be predicates over fuzzy output. The principle survives: *write the test before changing the implementation*. Without it, prompt iteration is iterating against a moving target — "better" is whatever the most recent run looked like, and you'll iterate in circles forever.

## Primary diagram — the eval-driven loop (Case B: the target state)

```
  ┌─ prompt source (lib/agents/legacy-prompts/*.md) ───────────────────┐
  │  reviewed in PRs, version-controlled (concept 03 — done)             │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ┌─ THE EVAL HARNESS (missing today; the target) ────────────────────┐
  │                                                                     │
  │  ┌─ golden set ──────────┐   ┌─ regression suite ─────────────┐   │
  │  │  20–50 hand-curated    │   │  every production failure ever  │   │
  │  │  cases, real workspace │   │  seen, added as a case          │   │
  │  │  shapes                 │   │  (grows forever)                 │   │
  │  └───────────┬─────────────┘   └────────┬─────────────────────────┘   │
  │              │                            │                           │
  │              ▼                            ▼                           │
  │  ┌─ runner ────────────────────────────────────────────────────┐    │
  │  │  for each case: call agent → parse output → score against    │    │
  │  │  predicates (deterministic) + LLM-as-judge (fuzzy)           │    │
  │  └─────────────────────────┬──────────────────────────────────┘    │
  │                            │                                          │
  │                            ▼                                          │
  │  ┌─ diff vs baseline ────────────────────────────────────────────┐  │
  │  │  any per-case regression? → block PR                            │  │
  │  │  average improved without regressions? → green                  │  │
  │  └─────────────────────────────────────────────────────────────────┘  │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ┌─ CI (on every prompt PR) ──▼────────────────────────────────────────┐
  │  block merge on any regression                                        │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ TODAY (the gap) ─────────────────────────────────────────────────┐
  │  by-hand comparison against lib/state/demo-{insights,investigations}.json│
  │  single snapshot = single data point; useful but not an eval set        │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The canonical reference here is Hamel Husain's *"Your AI Product Needs Evals"* (hamel.dev/blog/posts/evals/). Read it once, then again after you've built your first eval set — it lands differently the second time. The discipline Hamel advocates is exactly what's missing in this codebase: the loop, the golden set, the regression suite, the LLM-as-judge for fuzzy outputs.

Other places to look:

- **OpenAI's evals framework.** The `openai/evals` repo is open-source and runnable. Heavy machinery; useful as a reference for the *shape* of a real eval harness even if you build something lighter.
- **Anthropic's evaluation docs.** Anthropic publishes patterns for LLM-as-judge specifically (`anthropic.com/news/evaluating-ai-systems`). The bias-mitigation discussion is the part most "build your own judge" posts miss.
- **promptfoo (npm package).** A lighter-weight eval runner aimed at the use case in this codebase. CLI tool, YAML-defined cases, deterministic + LLM-as-judge scoring. Closer to what I'd build for `blooming_insights` than the OpenAI framework.

In this codebase, concept 03 (prompts as code) is the *prerequisite* (you can't run a regression suite against a prompt-version you don't have). Concept 10 (self-critique) is the *adjacent* concept that shares the LLM-as-judge mechanism but uses it at runtime instead of in CI. The two get conflated; they shouldn't be — self-critique is for output quality at the boundary, evals are for output quality across versions.

## Project exercises

### Exercise — Stand up a 10-case eval harness for `MonitoringAgent`

  → **Exercise ID:** EVAL-MONITORING-MIN
  → **What to build:** A `lib/evals/monitoring/` directory with: 10 fixture workspaces (saved JSON), expected anomaly predicates per fixture, a runner that instantiates `MonitoringAgent` against each, scores with deterministic predicates (shape via `isAnomalyArray`; content via per-fixture assertions), and exits non-zero on any regression vs the previous git revision's scores.
  → **Why it earns its place:** Eval-driven iteration is Case B in this guide — the discipline is industry-standard, the substrate is gone from this repo, and this is the smallest unit that closes the gap. Once it exists, every prompt change is gated by it.
  → **Files to touch:** `lib/evals/monitoring/runner.ts` (new), `lib/evals/monitoring/cases/*.json` (new fixtures), `lib/evals/monitoring/predicates.ts` (new), `package.json` (add `eval:monitoring` script), `.github/workflows/evals.yml` (new, gates PRs that touch `lib/agents/legacy-prompts/monitoring.md` or `AGENT_MODEL`).
  → **Done when:** `npm run eval:monitoring` runs all 10 cases, prints per-case scores, exits non-zero on any regression. The first 10 cases include at least: empty-window workspace, healthy-baseline workspace, syntax-error injection, sparse-tail workspace.
  → **Estimated effort:** ~6–10 hours for the runner + 10 hand-curated cases. Each subsequent case is ~20 min.

### Exercise — Add `promptSha` to the runtime log line

  → **Exercise ID:** EVAL-PROMPT-LOG
  → **What to build:** Modify `lib/agents/aptkit-adapters.ts:57-61` (the existing `console.log({ site, sessionId, usage })`) to include `promptSha` (the git SHA of the active prompt `.md` file, captured at build time as a `process.env.PROMPT_SHA` injected by `next.config`).
  → **Why it earns its place:** Concept 03 names this as the prerequisite gap for closing the loop from production-trace back to prompt-version. Adding one field unlocks tracing "which output came from which prompt revision."
  → **Files to touch:** `lib/agents/aptkit-adapters.ts`, `next.config.ts` (inject the SHA), the log-aggregation parser if one exists.
  → **Done when:** every agent call's log line carries a `promptSha`; querying logs by `promptSha` returns only outputs produced by that revision.
  → **Estimated effort:** ~2 hours.

## Interview defense

**Q: "How do you iterate a prompt?"**

The senior version is eval-driven: write the eval first, then iterate the prompt against it. Honest answer for this codebase: I *don't* have an eval harness today — no `eval/` directory, no harness, no CI gate. What I have today is the committed demo snapshot at `lib/state/demo-*.json` — one data point's worth of regression check. Useful for "the prompt still produces *a* response," not for "the prompt is *better* than the previous version." The next thing I'd build is the 10-case harness I sketched in the project exercise.

```
  the gap, named honestly:                  the target:
  ────────────────────                     ───────────
  change prompt                            change prompt
  run live, eyeball UI                     run 10-case eval
  compare to demo snapshot                 diff per-case scores
  ship if it looks right                   block merge on any regression
```

Anchor: *"the discipline is industry-standard; the substrate is the gap I haven't filled yet. The pattern is real, the implementation is on the to-do list."*

**Q: "What's the failure mode of average-scoring?"**

A prompt change that improves the average score but regresses one critical case is *not* a win. The regression suite is what catches it — every production failure goes into the suite, forever, and the runner blocks merges on any per-case regression even when the average went up. The discipline is *per-case*, not average. Average-only scoring is how you ship a prompt that "improved" by 3 points and broke the one case that mattered.

```
  the trap:                              the fix:
  ────────                              ───────
  avg score: 0.78 → 0.84  ✓ ship       per-case diff blocks on ANY regression
  case-X score: 0.92 → 0.61  (hidden)   even if average went up
```

Anchor: *"average improvement is not enough; per-case regression blocks the merge."*

**Q: "When do you reach for LLM-as-judge?"**

When the output can't be checked with deterministic predicates and you can spot-check 10% of judge scores against human review. The recommendation agent's `rationale` field is a good example — "is this rationale a good explanation?" isn't a regex. The risk: the judge has the same blind spots as the model being judged. Mitigation: rotate judge models (use Sonnet to judge Opus output, and vice versa) and human-spot-check a sample. Concept 10 (self-critique) is the runtime sibling of this pattern and has the same blind-spot problem.

Anchor: *"reach for LLM-as-judge only when deterministic predicates can't reach. Verify the judge with humans on 10%."*

## See also

- `02-structured-outputs.md` — type guards catch shape drift; evals catch content drift. Same boundary, two layers.
- `03-prompts-as-code.md` — versioned prompts are the prerequisite for evals; without prompts-as-code, you can't bisect a regression.
- `10-self-critique.md` — runtime version of the same LLM-as-judge mechanism; same blind-spot problem.
