# Eval-driven iteration (iterate against a golden set, not vibes)

**Industry name(s):** eval-driven development, golden-set / regression-set iteration, LLM-as-judge, offline evaluation harness
**Type:** Industry standard · Language-agnostic

> The senior-vs-junior line in prompt work is this: a junior edits a prompt, eyeballs one output, and ships; a senior runs the edited prompt against a fixed set of labeled cases and ships only if the score holds AND no critical case regressed. blooming insights has no golden set and no harness — but its prompts are visibly iterated-by-incident: the "CRITICAL: verify your windows actually contain data" and "Never report a change derived from an empty window" blocks are regression fixes encoded as prose, an informal regression suite with no runner behind it.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Eval-driven iteration is an *orthogonal* path that runs parallel to the request flow, not inside it. You edit a prompt at the Per-agent definitions band, but the eval harness exercises the real production path (Per-agent definitions → Shared agent loop → Provider) from a separate entry point — a `evals/` runner that injects a deterministic `McpCaller` through the same seam the unit tests use. The dataset, runner, scorer, and gate all live in a sibling layer that touches the same agent classes the request path touches, just driven by a different caller.

```
  Zoom out — where eval-driven iteration lives

  ┌─ Engineer edits prompt ─────────────────────────┐
  │  lib/agents/prompts/<name>.md                    │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ EVAL band (orthogonal) ▼─────────  ┌─ Request flow ──────┐
  │  ★ evals/cases/*.json (dataset) ★   │ app/api/agent/route │
  │  ★ evals/run.ts (runner) ★          │ → Pipeline coord    │
  │  uses REAL Per-agent definitions ──→│ → Per-agent defs    │
  │  + Shared agent loop + Provider     │ → Shared agent loop │
  │  + injected deterministic McpCaller │ → Provider          │
  │  ↓                                  │ ↓                   │
  │  ★ scorer (assert | LLM-judge) ★    │ user receives result │
  │  ↓                                  └─────────────────────┘
  │  ★ gate: avg ↑ AND no regression ★   ← we are here
  └──────────────────────────────────────────────────┘
       (not yet implemented in blooming insights)
```

**Zoom in — narrow to the concept.** The question this file answers: how do you know the edit that fixed today's bug didn't silently break a case you fixed three weeks ago? A golden set + runner + scorer + gate moves the definition of "better prompt" out of your head and onto a number, with the gate checking two things — aggregate up AND no critical case regressed. blooming insights has the misses (every CRITICAL block in the prompts is a regression fix in prose) and the injection seam (used by 169 unit tests that check shape) but has not yet turned either into a scored harness. Below, you'll see why unit tests aren't evals, what the runner has to share with production, and the LLM-judge trap to respect before trusting a score.

---

## How it works

**Mental model.** An eval harness is three parts: a *dataset* of cases (input + a notion of what a good output is), a *runner* that feeds each case through the real prompt-and-model path, and a *scorer* that turns each output into pass/fail or a number. You iterate by editing the prompt, re-running the whole dataset, and comparing the aggregate AND the per-case deltas. The aggregate tells you if the change helped on average; the per-case diff tells you what it broke.

```
EVAL LOOP
─────────────────────────────────────────────────────────────
   edit prompt  (monitoring.md / diagnostic.md / …)
        │
        ▼
   ┌─────────── DATASET ───────────┐
   │ case 1: input → expected/grader│
   │ case 2: input → expected/grader│   20–50 cases
   │ …                              │
   └───────────────┬────────────────┘
                   ▼
   ┌─────────── RUNNER ────────────┐
   │ for each case: run real path   │   prompt + model + parse
   │ collect output                 │
   └───────────────┬────────────────┘
                   ▼
   ┌─────────── SCORER ────────────┐
   │ pass/fail or 0–1 per case      │   assertion / LLM-judge
   └───────────────┬────────────────┘
                   ▼
   compare:  aggregate ↑?  AND  per-case regressions = 0?
        │
        ▼  ship only if both hold
```

The whole point is the second half of the final comparison. "Average went up" is the trap; "average went up AND no critical case went down" is the gate.

---

### Part 1 — the dataset is the asset, not the prompt

The prompt is cheap to rewrite. The labeled dataset — the 50 cases that encode "here is what good looks like across the edge cases we have hit" — is the thing you cannot regenerate from memory. Hamel Husain's central argument (his "Your AI Product Needs Evals" essay is the canonical reference) is that teams over-invest in prompt cleverness and under-invest in the dataset, and it is exactly backwards: the dataset is what lets you change the prompt safely.

```
WHAT YOU OWN
─────────────────────────────────────────────────────────────
 prompt text      ← cheap, regenerable, you rewrite it weekly
 the dataset      ← EXPENSIVE, accreted from real misses, irreplaceable
                    each case = one bug you already paid for once
```

For blooming insights the cases are obvious because the prompts already name them. Every "CRITICAL"/"Never"/"Do NOT" block is a case waiting to be written down:

- `monitoring.md` L31–37: a workspace whose recent 90 days are empty. Expected: agent anchors `execution_time` or returns `[]` — NOT a ±100% swing.
- `monitoring.md` L29: a metric with a prior value < 500 events. Expected: agent ignores it, does not report a "swing."
- `diagnostic.md` L38–50: queries for recent windows return 0. Expected: conclusion honestly states data is historical — NOT an invented cause.
- `diagnostic.md` L35: a hypothesis that would need `customers matching`. Expected: agent uses `by <attribute>` and does not waste a call.

Each of those is a regression fix that currently lives only as a sentence in a prompt. The dataset turns each sentence into an enforceable case.

---

### Part 2 — the runner feeds the REAL path

The runner must exercise the actual production path — the loaded `.md` prompt, the real model, `runAgentLoop`, `parseAgentJson`, the type guards — not a hand-mocked approximation. A harness that scores a prompt against a different parser than production uses is measuring fiction.

```
RUNNER must use the SAME path as production
─────────────────────────────────────────────────────────────
 case input
    │
    ▼
 DiagnosticAgent.investigate(anomaly)   ← real class, real prompt
    │  runAgentLoop → real model → parseAgentJson → isDiagnosis
    ▼
 Diagnosis | FALLBACK                    ← exactly what prod returns
    │
    ▼
 scorer reads THIS, not a mock
```

The seam that makes this cheap already exists. `runAgentLoop` injects both the Anthropic client and the `McpCaller` (`lib/agents/base.ts` L48–L62, L16–L22) — the same seam the 169 unit tests use to pass fakes. For evals you do the opposite of the unit tests: you keep the real Anthropic client (you want real model behavior) and inject a *deterministic* `McpCaller` that returns canned tool results per case, so the case's "empty 90-day window" is reproducible run to run.

---

### Part 2.5 — current state: unit tests are not evals

This is the distinction the brief demands be named plainly. blooming insights has 169 Vitest tests. They are unit tests with injected fakes, and they test **shape, not answer quality.**

```
UNIT TEST (exists)                  EVAL (does not exist)
──────────────────────────────     ──────────────────────────────
inject fake anthropic + fake mcp    real anthropic, canned mcp results
assert: parseAgentJson returns      assert: the diagnosis is CORRECT
        an object of the right       for THIS anomaly given THIS data
        shape; isDiagnosis true
─────────────────────────────────────────────────────────────
"does the contract hold?"           "is the answer any good?"
deterministic, no model call        non-deterministic, real model call
```

`test/agents/diagnostic.test.ts` proves that when the fake model returns fenced JSON, `investigate` returns a typed `Diagnosis`, and when it returns garbage, the chain falls to `FALLBACK`. That is the structured-output contract (→ 02-structured-outputs.md) under test. It says nothing about whether the diagnosis is *right*. A hallucinated-but-well-shaped diagnosis passes every one of those 169 tests. The eval is the layer that would catch it, and it is the layer that does not exist.

So the honest framing of the current state: the prompts ARE iterated against real failures — the dense warning blocks prove it — but the iteration loop runs in someone's head, manually, one case at a time, with no record of the case and no automated re-check. It is a regression suite with no harness. That works until the person who remembers all the edge cases changes a prompt and forgets one.

---

### Part 3 — the scorer, and the LLM-judge trap

Two case types need two scorers.

For the JSON agents, scoring is mostly a code assertion because the output is structured: did the monitoring agent return `[]` for the empty-window case? Did the diagnostic conclusion avoid inventing a cause? Some of that is a substring/field check (`anomalies.length === 0`), some of it needs judgment ("does this conclusion honestly state the data was historical?").

For the query agent (prose, → 07-output-mode-mismatch.md) there is no field to assert on, so you reach for an LLM-as-judge: a second model call that grades the answer against a rubric.

```
SCORER per output mode
─────────────────────────────────────────────────────────────
 JSON agents   →  field assertions   (anomalies.length, conclusion regex)
                  + LLM-judge for the "is this honest?" cases
 query agent   →  LLM-judge against a rubric (prose has no fields)
```

The trap to name: an LLM judge is itself a model that can be wrong, and it is often wrong in a *correlated* way with the model it grades. Hamel's discipline here is non-negotiable — you must validate the judge against human labels before you trust it. If you skip that, you have replaced "I think this looks good" with "a model thinks this looks good," which is the same vibes-based iteration with extra latency.

---

### The principle

Eval-driven iteration moves the definition of "better prompt" out of your head and into a number on a fixed dataset, and it gates every change on two conditions, not one: the aggregate improved AND no critical case regressed. The dataset — accreted one production miss at a time — is the asset; the prompt is disposable. blooming insights has the misses (they are written into the prompts as CRITICAL blocks) and the injection seam (used by 169 unit tests) but has not yet turned either into a scored harness, so it iterates by memory.

---

## Eval-driven iteration — diagram

This diagram spans the loop. The Engineer edits a prompt; the Harness layer runs the real production path over a fixed dataset and scores each output; the Gate compares both the aggregate and the per-case deltas before allowing a ship. The feedback edge — every production miss becomes a new permanent case — is what makes the dataset grow stronger than memory.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ENGINEER                                                             │
│   edits lib/agents/prompts/<name>.md  (e.g. tighten the empty-window  │
│   rule in monitoring.md L31–37)                                       │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│  HARNESS LAYER   evals/  (does not exist yet)                         │
│                                                                       │
│  DATASET   evals/cases/*.json  — 20–50 cases                         │
│    each: { input anomaly/query, canned mcp results, grader }         │
│           │                                                          │
│  RUNNER   evals/run.ts                                               │
│    real Anthropic client + injected deterministic McpCaller          │
│    → DiagnosticAgent.investigate / QueryAgent.answer (REAL path)     │
│           │  output                                                  │
│  SCORER   field assertion (JSON agents) | LLM-judge (query prose)    │
│           │  pass/fail or 0–1 per case                               │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  results table
┌───────────────────────────▼───────────────────────────────────────────┐
│  GATE                                                                 │
│   aggregate ↑ ?    AND    per-case regressions == 0 ?                │
│        │ yes & yes                    │ no                            │
│        ▼                              ▼                               │
│      SHIP                       reject / investigate the regression   │
└──────────────────────────────────────────────────────────────────────┘
        ▲
        │  every production miss → new permanent case  (the dataset grows)
        └───────────────────────────────────────────────────────────────
```

A reader who sees only this should grasp: the dataset is fixed and growing, the runner uses the real path, and the gate checks two things — average up AND no critical regression.

---

## Implementation in codebase

**Not yet implemented.** There is no eval set, no eval runner, and no LLM-judge anywhere in blooming insights; the 169 Vitest tests under `test/` are unit tests that inject fake Anthropic/MCP clients and assert output *shape* (e.g. `test/agents/diagnostic.test.ts` checks that a fenced-JSON fake yields a typed `Diagnosis` and that garbage falls to `FALLBACK`) — they never score answer quality, so a hallucinated-but-well-formed output passes all of them.

The closest partial analog is the prompts themselves: every "CRITICAL"/"Never"/"Do NOT" block (`monitoring.md` L31–37 and L29, `diagnostic.md` L38–50 and L35, `recommendation.md` L82) is a regression fix encoded as prose — an informal, harness-less regression suite. A real harness would live in a new `evals/` directory at the repo root, reusing the injection seam in `lib/agents/base.ts` (L48–L62) that the unit tests already exploit.

---

## Elaborate

### Where this comes from

Eval-driven development crystallized around 2023–2024 as teams shipped LLM features and discovered prompt iteration had no safety net. Hamel Husain's writing ("Your AI Product Needs Evals", and the follow-ups on LLM-as-judge and looking at your data) is the canonical practitioner reference; it argues the dataset and the act of *reading your outputs* are the work, and the prompt is downstream. The pattern borrows directly from software testing — golden files, regression suites, snapshot tests — and adapts the scorer to tolerate the non-determinism of model output (assertions on structured fields, rubric-based LLM judges for prose).

### The deeper principle

```
software test                       eval
──────────────────────────────     ──────────────────────────────
unit under test = function          unit under test = prompt+model
output = deterministic value        output = sampled, non-deterministic
scorer = ===                        scorer = field assert | LLM-judge
regression = exact diff             regression = score drop on a case
```

The deep equivalence: both move correctness from "I checked once" to "the suite checks every change." The only adaptation is that the eval scorer must absorb non-determinism — which is why you score on a fixed dataset with a tolerance, and why a single critical case failing matters more than a fractional average dip.

### Where this breaks down

1. **A small golden set lies.** 20 cases that all happen to have healthy data tell you nothing about the empty-window path. The set must over-represent the edge cases — the CRITICAL blocks — not the happy path, because the happy path rarely regresses.

2. **The average hides the killer.** This is the named failure mode: a prompt edit that raises mean score by tightening the happy-path phrasing while regressing the one historical-data case. Aggregate-only gating ships it. You must diff per-case.

3. **The LLM judge drifts and colludes.** An unvalidated judge that shares blind spots with the agent (often the same model family, → 10-self-critique.md) will rubber-stamp the agent's confident-wrong outputs. The judge must be validated against human labels, and re-validated after a model upgrade.

4. **Real-model evals cost money and are non-deterministic.** Running 50 cases through `claude-sonnet-4-6` per prompt edit is real spend and the scores wobble run to run. You cache where you can, set a tolerance band, and accept that the gate is statistical, not exact.

### What to explore next

- **Pin every production miss as a case.** The moment a merchant gets a bad briefing, capture the anomaly + the canned tool results and add it to `evals/cases/` — the dataset's whole value is that it grows from real failures.
- **LLM-judge validation set.** Hand-label 20 query-agent answers, then measure the judge's agreement with your labels before trusting it on the other 30.
- **A/B prompt comparison.** Run two prompt versions over the same dataset and report the per-case win/loss/tie table, not just the two averages.

---

## Project exercises

### Build a golden set + runner under `evals/`

- **Exercise ID:** C3.1 / C3.2 (adapted) — stand up an offline eval harness for the agents.
- **What to build:** a new `evals/` directory with (1) `evals/cases/` holding 20–50 JSON cases, each an input anomaly (or query) plus the canned MCP tool results that case implies plus a grader spec; (2) `evals/run.ts` that constructs `DiagnosticAgent`/`QueryAgent` with the real Anthropic client and a deterministic `McpCaller` that replays the case's canned results, runs each case, and applies the grader; (3) a results table printing aggregate pass-rate and a per-case pass/fail column. Seed the set directly from the prompts' CRITICAL blocks: the empty-90-day-window case (`monitoring.md` L31–37), the < 500-events baseline case (L29), the historical-data case (`diagnostic.md` L38–50).
- **Why it earns its place:** it converts the informal in-prose regression suite into an executable one and gives every future prompt edit a number to gate on — the single highest-leverage thing missing from the system.
- **Files to touch:** new `evals/cases/*.json`, new `evals/run.ts`, new `evals/grade.ts`; reuse `lib/agents/base.ts` (the injection seam), `lib/agents/diagnostic.ts`, `lib/agents/query.ts`, `lib/mcp/validate.ts`.
- **Done when:** `tsx evals/run.ts` runs every case through the real agent path, prints an aggregate score and a per-case table, and the three seeded edge-case cases pass on `main` and fail when the corresponding CRITICAL block is deleted from the prompt.
- **Estimated effort:** 1–2 days

### Add an LLM-judge for the query agent's prose

- **Exercise ID:** C3.3 (adapted) — rubric-based grading for free-form output.
- **What to build:** a grader for the query agent's prose answer (`query.md` L49) that calls a model with a rubric ("grounded in real numbers? honest when data is missing? answers the question asked?") returning a 0–1 score, then a small validation step: hand-label 15 query answers and report the judge's agreement with your labels so the judge is trusted only after it matches humans.
- **Why it earns its place:** demonstrates you know prose needs a different scorer than JSON and that an LLM judge is worthless until validated against human labels — the step teams skip.
- **Files to touch:** new `evals/judge.ts`, new `evals/cases/query/*.json` (with human labels), `evals/run.ts` (wire the judge for query cases).
- **Done when:** the judge scores a held-out set of query answers, and you report its agreement rate with your 15 hand labels before any score from it is used to gate a prompt change.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you know a prompt change made things better?" tests whether you stop at "I checked the output" or go to "I ran it against a fixed dataset and gated on aggregate-up-and-no-regression." The senior signal is naming the average-up-but-edge-case-down failure mode, distinguishing unit tests (shape) from evals (quality), and knowing the dataset — not the prompt — is the asset.

### Likely questions

**[mid] "You have 169 passing tests. Why isn't that enough to iterate on prompts safely?"**

Because they test shape, not answer quality. `test/agents/diagnostic.test.ts` injects a fake model and asserts that fenced JSON parses to a typed `Diagnosis` and garbage falls to `FALLBACK` — that is the structured-output contract under test. A hallucinated diagnosis with the right fields passes every one of those tests. Evals are the missing layer that scores whether the answer is *correct*.

```
unit test → "is the shape right?"   (fake model, deterministic)
eval      → "is the answer right?"  (real model, scored on a dataset)
```

**[senior] "Walk me through the failure mode of iterating without a golden set."**

A prompt edit raises the average but regresses one untracked critical case. Concretely: I tighten `monitoring.md`'s happy-path phrasing, mean score goes up, every demo case looks better — but I broke the empty-90-day-window path (L31–37) and now a historical-data workspace gets a ±100% swing reported as critical. With no per-case diff, the average hid it; the merchant finds it for me. The gate has to be two conditions: average up AND no critical case down.

```
edit → avg ↑ (looks great)  ── but ──▶ empty-window case ↓ (silent)
no per-case diff → ship the regression → merchant reports bad briefing
```

**[arch] "How would you build evals here without a ground-truth dataset to start from?"**

The dataset already exists in prose. Every CRITICAL/Never/Do-NOT block in the four prompts is a documented production miss — I write each as a case: input anomaly, the canned MCP results that trigger the edge (empty window, < 500 baseline, historical data), and a grader. I run them through the real `DiagnosticAgent` path with a deterministic injected `McpCaller` (the seam in `base.ts` L48–L62 the unit tests already use), and gate prompt edits on it. The dataset then grows from every new production miss.

```
prompt CRITICAL block → eval case → grader
real agent path (injected deterministic mcp) → output → score
new prod miss → new permanent case (dataset grows)
```

### The question candidates always dodge

**"How do you know your LLM judge is any good?"** You validate it against human labels first, and candidates dodge because they ship the judge unvalidated. An LLM judge often shares blind spots with the agent it grades (same model family) and will rubber-stamp confident-wrong output. Until it agrees with hand labels at a measured rate, it is vibes with extra latency. The honest answer leads with the validation step, not the judge.

### One-line anchors

- `test/agents/diagnostic.test.ts` — unit test of shape, not quality; the gap evals fill.
- `lib/agents/prompts/monitoring.md` L31–37 — empty-window CRITICAL block = an eval case in prose.
- `lib/agents/prompts/diagnostic.md` L38–50 — historical-data block = an eval case in prose.
- `lib/agents/base.ts` L48–L62 — the injection seam an eval runner would reuse.
- Hamel Husain, "Your AI Product Needs Evals" — the canonical reference.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the eval loop: edit prompt → dataset → runner (real path) → scorer → gate. State the two conditions the gate checks and name which one, alone, ships silent regressions.

### Level 2 — Explain

Out loud: why are the 169 Vitest tests (e.g. `test/agents/diagnostic.test.ts`) NOT evals? Name what they assert (shape) versus what an eval asserts (answer quality), and give an example of an output that passes all 169 tests but should fail an eval.

### Level 3 — Apply

Scenario: turn `monitoring.md` L31–37 (the empty-90-day-window CRITICAL block) into an eval case. Specify the input anomaly, the canned MCP tool results that make the recent window empty, the expected output (`[]` or an `execution_time`-anchored result, NOT a ±100% swing), and which class you'd run it through (`MonitoringAgent`) with which injected dependency made deterministic (the `McpCaller`).

### Level 4 — Defend

A reviewer says: "We have 169 green tests, we don't need evals." State the distinction between shape and quality, give the average-up-edge-case-down failure mode as the concrete risk, point to a real CRITICAL block (`diagnostic.md` L38–50) that no unit test pins for correctness, and name the breakpoint event that makes building `evals/` mandatory.

### Quick check — code reference test

Which seam in `lib/agents/base.ts` would an eval runner reuse to feed deterministic tool results to the real agent, and how does its use differ from the unit tests'? (Answer: the injected `anthropic` client and `McpCaller` parameters of `runAgentLoop` — `lib/agents/base.ts` L48–L62, interface L16–L22. Unit tests inject a fake model AND a fake MCP; an eval runner keeps the REAL Anthropic client for real model behavior but injects a deterministic `McpCaller` that replays the case's canned results.)

## See also

→ 02-structured-outputs.md · → 03-prompts-as-code.md · → 10-self-critique.md · → 13-forbidden-patterns.md

---
Updated: 2026-05-29 — Updated the Vitest test count from 125 to 169 across all 11 body references (the suite grew this session).
Updated: 2026-05-29 — Resynced stale prompt-line refs (the {categories} shift + earlier prompt revisions): monitoring.md CRITICAL block L25–31→L31–37, small-baseline caution L23→L29; diagnostic.md historical-data block L36–42→L38–50, "customers matching" ban L33→L35; recommendation.md id-ban L64→L82; query.md prose L36→L49.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
