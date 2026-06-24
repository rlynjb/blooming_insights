# Eval pipeline — 4-pillar measurement suite

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** offline eval harness, LLM-as-judge, golden-fixture regression, K-iteration sampling
**Type:** Industry standard · Language-agnostic

> An agent stack is not deployed software; it's a stochastic system whose behavior changes when any of (prompt, model, tool surface, training data) changes. The eval pipeline is the system that makes those changes legible — four parallel evals (detection, diagnosis, recommendation, regression), each modeled as its own request-flow, each producing a paper trail you can compare across runs.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The eval pipeline lives in `eval/` — a sibling of `app/`, `lib/`, and `mcp-server-olist/`. It does NOT live inside the request flow; nothing in production calls it. Instead it sits in a parallel universe with its own request-flow per pillar: a CLI entry point (`npm run eval:<pillar>`) spawns the same agent stack you'd run in prod, captures the output, hands it to a judge (LLM or deterministic), scores it with a rubric, and writes a dated paper trail to `eval/results/<YYYY-MM-DD>/`. The agent stack underneath is unchanged — `MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `runAgentLoop` — but the I/O is rerouted: stdin/stdout instead of a route handler, fixture file instead of OAuth-gated user input, scoring rubric instead of a UI render.

```
Zoom out — where the eval pipeline lives

┌─ Production code paths ────────────────────────┐
│  app/api/briefing  →  agents  →  DataSource    │
│  app/api/agent     →  agents  →  DataSource    │
└─────────────────────┬──────────────────────────┘
                      │  imports the SAME agent + DataSource code
┌─ Eval pipeline ─────▼──────────────────────────┐  ← we are here
│  eval/scripts/run-detection.ts                 │ ★ PILLAR 1 ★
│  eval/scripts/run-diagnosis.ts                 │ ★ PILLAR 2 ★
│  eval/scripts/run-recommendation.ts            │ ★ PILLAR 3 ★
│  eval/scripts/run-regression.ts                │ ★ PILLAR 4 ★
│         │                                       │
│         ▼  (each pillar)                        │
│   load fixtures → run agent → judge → score → │
│   write eval/results/<date>/                   │
└─────────────────────┬──────────────────────────┘
                      │
┌─ External callers ─────────────────────────────┐
│  Anthropic (working model: Sonnet 4.6)         │
│  Anthropic (judge model:  Sonnet 4.6)          │
│  mcp-server-olist subprocess (SQLite ground    │
│    truth — 3 seeded anomalies)                 │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you measure a stochastic system in a way that catches *real* regressions but doesn't flake on the noise that's inherent to LLM sampling? The answer here is **four pillars** with deliberately different shapes: detection (K=10 iterations, deterministic scoring against 3 seeded anomalies, looser & strict modes), diagnosis (K=10, LLM judge with a 0–9 rubric, pass at total ≥7), recommendation (K=10, LLM judge over Bloomreach-feature alignment), regression (K=1 per fixture × 10 golden fixtures, two-mode capture/score with structural-diff + similarity judge). The pillars don't share a runner — each has its own rubric, its own ground truth, its own pass criterion. What they DO share: the same `OlistDataSource` subprocess, the same `runAgentLoop`, the same JSON-write-to-`eval/results/<date>/`, and the same `EVAL_RUN_TAG` env var for same-day re-runs. The next sections walk the per-pillar request-flow, the judge-as-a-subsystem, and the paper trail that makes deltas legible.

---

## Structure pass

**Layers.** The eval pipeline stacks five layers per pillar: the **CLI entry** (`npm run eval:<pillar>`, parses `--K=`/`--capture` args, loads `.env.local`), the **fixture/ground-truth loader** (`loadSeededAnomalies()` reads SQLite; `loadFixtures()` reads JSON; `loadReferenceDiagnoses()` reads JSON), the **agent driver** (`runMonitoringAgentOnce` / `runDiagnosticAgentOnce` / etc. — the same agents as production but wired to capture instead of stream), the **judge** (deterministic scorer for detection; LLM judge for diagnosis/recommendation; structural-diff + LLM similarity for regression), and the **paper trail writer** (JSON dump + markdown summary to `eval/results/<date>[/<tag>]/`).

**Axis: trust.** What does each layer trust the upstream layer to have validated? This axis pops because the whole point of an eval pipeline is **trust assignment** — the rubric trusts the judge to be calibrated; the judge trusts the agent driver to have captured every tool call; the agent driver trusts the fixture loader to provide ground truth; the CLI trusts `.env.local` for credentials. Lifecycle is a plausible alternate (build / run / score), but trust is sharper — it explains *why* each judge call is retried once on malformed JSON (the judge sometimes fails the contract; the rubric needs to know), *why* the regression eval has a capture mode (you have to TRUST a golden once before you can score against it), and *why* same-day re-runs need `EVAL_RUN_TAG` (you can't trust two `2026-06-15` directories to mean the same thing).

**Seams.** Four seams matter; two are load-bearing. **Seam 1 (load-bearing): fixture → agent driver.** Trust flips from "this is ground truth" (3 anomalies in SQLite, JSON fixtures with input + golden_output) to "this is one stochastic run that we'll score against the ground truth." Every per-K iteration crosses this seam. **Seam 2 (load-bearing): agent output → judge.** Trust flips from "this is the model's stochastic emission" to "this is a verdict we'll write to disk and compare across runs." The judge layer is what converts noise into signal. **Seam 3: judge → rubric.** Trust flips from "the judge said X" to "X plus the rubric's pass threshold gives an aggregate pass rate." **Seam 4: per-pillar result → paper trail.** Trust flips from "this run produced these numbers" to "these numbers are reviewable, comparable, re-runnable." The `EVAL_RUN_TAG` convention is the contract that makes the seam non-destructive.

```
Structure pass — eval pipeline

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  CLI · Fixture/ground-truth · Agent driver · Judge · │
│  Paper trail                                         │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  trust: what does each layer trust the upstream to   │
│  have validated?                                     │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: fixture → agent driver ★load-bearing            │
│      (ground truth → one stochastic sample)          │
│  S2: agent output → judge ★load-bearing              │
│      (noise → verdict)                               │
│  S3: judge → rubric (verdict → aggregate)            │
│  S4: per-pillar → paper trail (numbers → audit)      │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

### Move 1 — Mental model

Think of each eval pillar as a unit test that calls the agent under controlled conditions, except (a) the assertion isn't `expect(...).toBe(...)` because the output is stochastic, and (b) the "pass" isn't binary — it's a score on a rubric. The pillars are parallel; running one doesn't depend on the others. Each pillar's runner is its own `main()` in its own `eval/scripts/run-<pillar>.ts`.

```
 fixture / ground truth
       │
       ▼  per K iteration (K=10 for detection/diagnosis/recommendation; K=1 per fixture for regression)
 ┌──────────────────┐
 │  agent driver    │   spawns OlistDataSource subprocess, runs the agent, captures output
 │  (same agent     │
 │   as production) │
 └────────┬─────────┘
          │ agent output (Anomaly[] | Diagnosis | Recommendation[] | string | Intent)
          ▼
 ┌──────────────────┐
 │  judge           │   deterministic scorer (detection); LLM judge (diagnosis/reco/regression-similarity);
 │                  │   structural diff (regression)
 └────────┬─────────┘
          │ scores per K + aggregate
          ▼
 ┌──────────────────┐
 │  paper trail     │   eval/results/<date>[/<tag>]/<pillar>-K<n>-<mode>.json + summary.md
 │                  │
 └──────────────────┘
```

The pillars look the same at this altitude. The differences show up in the judge and the rubric.

---

### Move 2 — The four pillars walked

The four pillars are not equal. **Detection (pillar 1) is the load-bearing one** — it's the one that measures whether the system can *find* the anomalies in the data at all; if detection breaks, everything downstream is meaningless. **Regression (pillar 4) is the surprising one** — it doesn't measure "is the system correct?", it measures "did anything change between the last known-good output and today's?", which is a different question and needs a different machine.

**Pillar 1 — Detection (`eval:detection`, deterministic scorer)**

K=10 iterations. Each iteration spawns a fresh `OlistDataSource` subprocess, calls `MonitoringAgent.scan()` against the live SQLite-backed mcp-server-olist, captures the emitted `Anomaly[]`. Then `scoreRun(insights, seededAnomalies)` does deterministic matching against the 3 seeded ground-truth anomalies in `mcp-server-olist/data/olist.db`'s `seeded_anomalies` table. Two modes: **loose** (matches if any of metric/dimension/segment match) and **strict** (all three must match AND the direction of change). Output: precision/recall per K, aggregated, plus a per-anomaly recall rate ("seeded anomaly #3 was found in 8/10 runs").

```
Detection eval — K=10 deterministic scoring
─────────────────────────────────────────────
                                                    each K
                                                       │
  3 seeded anomalies ──► runMonitoringAgentOnce(i) ────┼──► Anomaly[]
  (SQLite ground truth)                                │
                                                       ▼
                                              scoreRun(loose + strict)
                                                       │
                                                       ▼
                                         per-K precision/recall + matches[]
                                                       │
                                                       ▼
                                          aggregate over K + per-anomaly recall
                                                       │
                                                       ▼
                              detection-K10-loose.json + -strict.json + -raw.json + summary.md
```

The deterministic scorer's whole point is to avoid the LLM-judge variance — the seeded anomalies are known; matching is a set operation. Use the LLM judge only when set-matching doesn't capture the question.

**Pillar 2 — Diagnosis (`eval:diagnosis`, LLM judge with 5-criterion rubric)**

K=10 iterations. Each iteration runs `DiagnosticAgent.investigate()` against one of the seeded anomalies (taken as input). The output `Diagnosis` is judged by a separate Claude Sonnet 4.6 call (the judge) reading the diagnosis prompt at `eval/judges/diagnosis-judge.md` — five criteria scored 0–2 each (hypothesis, evidence, sizing, calibration, fabrication; one is 0–1), summed to a 0–9 total, **pass at total ≥7**. The judge sees the anomaly, the reference diagnosis (human-written ground truth at `eval/fixtures/reference-diagnoses.json`), the candidate diagnosis, and the full tool-call transcript (so it can verify citations).

```
Diagnosis eval — K=10 LLM judge with rubric
────────────────────────────────────────────
                                                    each K
                                                       │
  seeded anomaly + ref diagnosis ──► runDiagnosticAgentOnce(i) ──► Diagnosis + toolCalls[]
                                                       │
                                                       ▼
                                            judge.judgeDiagnosis()
                                                       │
                                                       │  Anthropic API call (Sonnet 4.6 judge)
                                                       │  retries ONCE on malformed JSON
                                                       ▼
                                       JudgeOutput { scores, total, pass, reasoning_per_criterion }
                                                       │
                                                       ▼
                                            aggregate pass-rate + score distribution
                                                       │
                                                       ▼
                              diagnosis-K10-judge.json + summary.md
```

The judge is itself an LLM call that can fail — when it returns malformed JSON, the harness retries once and then marks the K as `judge_error`. Errored judge runs are counted separately in the aggregate (not silently treated as fails).

**Pillar 3 — Recommendation (`eval:recommendation`, LLM judge over Bloomreach-feature alignment)**

K=10 iterations. Each iteration runs `RecommendationAgent.propose(anomaly, diagnosis)` where the diagnosis comes from `eval/fixtures/reference-diagnoses-as-input.json` (NOT the candidate diagnosis from pillar 2 — that would couple two evals' variance). Output `Recommendation[]` is judged on whether the suggested Bloomreach feature (`scenario | segment | campaign | voucher | experiment`) is appropriate for the diagnosis, whether the rationale grounds in the evidence, and whether the steps are actionable.

```
Recommendation eval — K=10 LLM judge over feature alignment
────────────────────────────────────────────────────────────
                                                    each K
                                                       │
  seeded anomaly + REFERENCE diagnosis ──► runRecommendationAgentOnce(i) ──► Recommendation[]
  (input — NOT the candidate from pillar 2)            │
                                                       ▼
                                            judgeRec.judgeRecommendation()
                                                       │
                                                       ▼
                                       per-rec score + aggregate
                                                       │
                                                       ▼
                              recommendation-K10-judge.json + summary.md
```

The pillar 2 / pillar 3 input split is the key design decision: each pillar measures one agent in isolation. Coupling them (run pillar 2, feed its output into pillar 3) would conflate "the diagnosis was bad" with "the recommendation given a bad diagnosis was bad" — un-debuggable.

**Pillar 4 — Regression (`eval:regression`, two-mode capture/score)**

K=1 per fixture, 10 fixtures total. Different shape from the other three pillars: there's no ground truth in the form of "this is the right answer" — instead there's a golden output captured from a known-good past run, and the eval asks "is today's output sufficiently similar to the golden?" Two modes:

- **Capture mode** (`npm run eval:regression -- --capture`): runs each fixture once, writes the output back into the fixture file as `golden_output` with `captured_at` and `captured_with: { model, prompt_hash }`. Run this after a known-correct prompt change.
- **Score mode** (default): runs each fixture once, compares the new output to the captured golden via (a) `structuralDiff` (deterministic — required fields present, types match) and (b) `judgeSimilarity` (LLM Sonnet 4.6 reads `eval/judges/similarity-judge.md`, returns `same_conclusion: bool, confidence: 0–1, differences_named: string[]`). Overall pass = structural pass AND semantic pass.

```
Regression eval — two modes
────────────────────────────
 CAPTURE mode (rare; after known-correct change):
   fixture (input only) ──► run agent ──► output ──► write back as golden_output
                                                     + prompt_hash
                                                     + captured_at

 SCORE mode (CI / smoke-test):
   fixture (input + golden) ──► run agent ──► new output
                                                  │
                                ┌─────────────────┼─────────────────┐
                                ▼                                   ▼
                       structuralDiff()                     judgeSimilarity()
                       deterministic                        LLM, Sonnet 4.6
                       (required fields                      (semantic match,
                        present, types ok)                    confidence)
                                │                                   │
                                └────────────► overall_pass ◄───────┘
                                       (struct AND semantic)
```

The two-mode shape is what makes a regression eval different from a unit test. A unit test asserts the output against a hand-written expected value; a regression eval asserts today's output against yesterday's captured output, with the LLM judge filling in the semantic-similarity assertion that's too noisy to hand-code. The `prompt_hash` field is the safety net: if the captured golden was produced with a prompt that's since changed, the next score-mode run can flag "this golden was captured against a different prompt — re-capture or expect drift."

---

### Move 2.5 — The LLM-as-judge harness as a system component

Every pillar except detection uses an LLM as a judge. That's a non-trivial system component:

- It has its own retry policy (`judge.ts` retries malformed JSON once, then marks `judge_error`).
- It has its own model (`JUDGE_MODEL = 'claude-sonnet-4-6'` in `eval/scripts/lib/judge.ts` L72 — same as the working model, by convention).
- It has its own prompt versioning (`eval/judges/*.md` — separate from `lib/agents/prompts/*.md`).
- It can fail in ways that look like the candidate failed — and the rubric layer has to distinguish "the agent failed" from "the judge failed."

```
LLM-as-judge — three failure modes, three behaviors

  agent fails              judge succeeds, returns pass=false → counted as fail (correct)
  agent succeeds, judge succeeds                             → counted accurately
  agent succeeds, judge fails (malformed JSON)              → retry once → judge_error → counted separately
```

The judge prompt itself is calibrated against the same anti-bias techniques the working prompts use (criterion scoring, few-shot anchors, JSON-only output). The truncation rule (`TOOL_RESULT_TRUNCATE = 4000` in `judge.ts` L77) is a system-design call: Olist tools sometimes return ~50 KB of sample rows; the judge doesn't need that to score whether the candidate's claims are grounded, and feeding it the full payload inflates both cost and judgment noise.

---

### Move 3 — The principle

**Per-pillar isolation, shared paper trail.** Each pillar measures one thing well; coupling them would create un-debuggable failures. But they all write to the same `eval/results/<date>/` so a single run produces a single dated artifact that captures the system's state on that day. The `EVAL_RUN_TAG` env var (read by every pillar's `makeResultsDir()`) is the non-destructive escape hatch: same-day re-runs land in `eval/results/<date>-<tag>/`, so an "after-fix" run doesn't overwrite the "before-fix" baseline.

This is the same principle as a CI build artifact, scaled down: each eval is reproducible from its inputs (fixture + DB seed + prompt hash + model name + `captured_with`), and each output is keyed by date so two engineers running the same evals on the same day can name them apart.

---

## Eval pipeline — diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLI ENTRY (eval/scripts/run-<pillar>.ts main())                            │
│                                                                              │
│  loadEnvLocal()  →  ANTHROPIC_API_KEY                                       │
│  parseK / parseCaptureFlag                                                  │
│  makeResultsDir() ← reads EVAL_RUN_TAG                                      │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌─ Fixture / ground-truth ─────▼──────────────────────────────────────────────┐
│  detection:   loadSeededAnomalies() → SQLite seeded_anomalies table         │
│  diagnosis:   loadSeededAnomalies() + reference-diagnoses.json              │
│  recommend:   loadSeededAnomalies() + reference-diagnoses-as-input.json     │
│  regression:  loadFixtures() → eval/fixtures/regression-golden/*.json       │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌─ Agent driver (per K) ───────▼──────────────────────────────────────────────┐
│  runMonitoringAgentOnce / runDiagnosticAgentOnce /                          │
│  runRecommendationAgentOnce / runQueryAgentOnce / runIntentAgentOnce        │
│  ─ spawns OlistDataSource subprocess (fresh per K for isolation)            │
│  ─ uses olistWorkspaceSchema() (no OAuth, no live MCP)                      │
│  ─ NEVER throws — failures land in capture.error                            │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ candidate output (Anomaly[] | Diagnosis | …)
┌─ Judge ──────────────────────▼──────────────────────────────────────────────┐
│  detection:   scoreRun() — deterministic set matching, two modes            │
│  diagnosis:   judgeDiagnosis() — Sonnet 4.6 LLM, 5-criterion rubric, 0–9   │
│  recommend:   judgeRecommendation() — Sonnet 4.6 LLM, feature-alignment    │
│  regression:  structuralDiff() AND judgeSimilarity() — LLM same_conclusion │
│  retry-once on judge JSON parse failure → judge_error                       │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ scores + verdict
┌─ Paper trail writer ─────────▼──────────────────────────────────────────────┐
│  eval/results/<YYYY-MM-DD>[/<EVAL_RUN_TAG>]/                                │
│    <pillar>-K<n>-loose.json     (detection only)                            │
│    <pillar>-K<n>-strict.json    (detection only)                            │
│    <pillar>-K<n>-judge.json     (diagnosis/recommend/regression)            │
│    <pillar>-K<n>-raw.json       (every tool call, every reasoning text)     │
│    summary.md                   (human-readable scorecard)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

Five layers, four pillars, one date-keyed paper trail. The architecture is asymmetric in the judge layer (deterministic for detection, LLM for the others) and that asymmetry is the load-bearing design call.

---

## Implementation in codebase

**File:** `eval/scripts/run-detection.ts`
**Function / class:** `main()` (L109–L263); `loadSeededAnomalies()` (L70–L84); `makeResultsDir()` (L89–L100); `loadEnvLocal()` (L30–L51)
**Role:** Pillar 1 entry — K=10 by default (`parseK()` L57–L65), spawns `OlistDataSource` per K via `runMonitoringAgentOnce`, scores both loose and strict, writes 4 JSON files + `summary.md`.
**GitHub:** `eval/scripts/run-detection.ts`

```
// L132–L144 — the K-loop
for (let i = 1; i <= K; i++) {
  const capture = await runMonitoringAgentOnce(i, `${sessionId}-run${i}`);
  const score = scoreRun(capture.insights, anomalies);
  perRun.push({
    runIndex: capture.runIndex,
    durationMs: capture.durationMs,
    error: capture.error,
    insights: capture.insights,
    score,
    toolCalls: capture.toolCalls.map((tc) => ({ toolName: tc.toolName, args: tc.args })),
    reasoning: capture.reasoning,
  });
  // … per-K log line with loose+strict P/R …
}
```

The `EVAL_RUN_TAG` read at L95 is the same-day re-run escape hatch — set it before a re-run and the results dir becomes `eval/results/2026-06-15-after-fix/` instead of overwriting `2026-06-15/`.

---

**File:** `eval/scripts/lib/run-agent.ts`
**Function / class:** `runMonitoringAgentOnce(runIndex, sessionId)` (L51–end); `AgentRunCapture` interface (L27–L43)
**Role:** The shared agent driver for detection's K-loop. Mirrors `app/api/briefing/route.ts` exactly — same factory call shape, same hook surface, same workspace schema — but with stdio capture instead of NDJSON stream. Hardcodes `live-sql` (Olist) because eval only scores the Olist path.
**GitHub:** `eval/scripts/lib/run-agent.ts`

The subprocess-per-K isolation (L56: `const dataSource = new OlistDataSource()` — fresh per call, disposed in `finally`) is the load-bearing detail: if one run's subprocess crashes, the next K gets a clean spawn. Without it, a single subprocess corruption would cascade across K.

---

**File:** `eval/scripts/lib/judge.ts`
**Function / class:** `judgeDiagnosis(anthropic, input, prompt)`; `JUDGE_MODEL` (L72); `parseJudgeResponse()`; `JudgeOutput` / `JudgeError` interfaces
**Role:** The LLM-as-judge harness for pillar 2. One Anthropic call per candidate, retried once on malformed JSON, then `judge_error`. Truncates tool results to 4 KB (`TOOL_RESULT_TRUNCATE` L77) before showing the judge.
**GitHub:** `eval/scripts/lib/judge.ts`

The same harness shape is repeated in `judge-rec.ts` (pillar 3) and `similarity-judge.ts` (pillar 4 score mode). Three judges, same anti-bias structure, different rubrics.

---

**File:** `eval/scripts/run-regression.ts`
**Function / class:** `main()` (L726–L737); `captureMode()` (L291–L376); `scoreMode()` (L381–L620); `promptHash()` (L163–L175); `runFixture()` (L193–L286)
**Role:** Pillar 4 entry — two modes split by `--capture` flag. Capture mode runs each fixture once and writes the output back into the fixture file as the golden; score mode runs each fixture and judges against the captured golden via structural diff + similarity judge. The `promptHash()` call writes a SHA-256 of the prompt file content into the fixture so a later score-mode run knows whether the prompt has changed under it.
**GitHub:** `eval/scripts/run-regression.ts`

```
// L380–L398 (excerpt) — pre-flight uncaptured check
const uncaptured = fixtures.filter((f) => f.golden_output == null);
if (uncaptured.length > 0) {
  console.error(`[regression:score] ${uncaptured.length}/${fixtures.length} fixtures have null golden_output:`);
  for (const f of uncaptured) console.error(`  - ${f.id}`);
  console.error('Run `npm run eval:regression -- --capture` first to populate goldens.');
  process.exit(1);
}
```

The fail-loud-upfront pattern is deliberate: a regression eval that silently passes when half the fixtures are uncaptured is worse than no eval at all. The exit-on-uncaptured is the trust contract for the paper trail.

---

**File:** `eval/results/<YYYY-MM-DD>[/<tag>]/`
**Role:** The paper trail — every pillar writes JSON + a markdown scorecard here. Convention: one dir per date, optional `-<tag>` suffix for same-day re-runs (via `EVAL_RUN_TAG`).
**Layout:**
- `detection-K<n>-loose.json` / `-strict.json` / `-raw.json` — pillar 1
- `diagnosis-K<n>-judge.json` / `-raw.json` — pillar 2
- `recommendation-K<n>-judge.json` / `-raw.json` — pillar 3
- `regression-judge.json` / `-candidates.json` / `-summary.json` / `-summary.md` — pillar 4
- `summary.md` — per-pillar human-readable scorecard

Already on disk: `2026-06-15/`, `2026-06-15-after-fix/`, `2026-06-15-capture/`, `2026-06-15-score-baseline/` — the same-day-multi-tag pattern in action.

---

## Elaborate

### Where this pattern comes from

The four-pillar shape is borrowed from classic ML eval frameworks (RAG eval suites like RAGAS, agent benchmarks like SWE-Bench, structured-output suites like BIG-Bench) but rebuilt around this codebase's specifics: the agents are specialized (not one big LLM call), the tool surface is small (3 Olist tools), and the ground truth is partially synthetic (3 seeded anomalies are *known* because we seeded them). The unusual choice is having a **regression** pillar at all — most agent eval suites have detection/quality but skip regression because LLM outputs are hard to compare deterministically. The two-mode (capture + score) shape with a similarity-judge fallback is the workaround.

The LLM-as-judge pattern itself has formal names: **Constitutional AI** (Anthropic's framing), **G-Eval** (general LLM-as-judge), **LLM-Eval**. The risk is well-known (judges have biases, can be gamed by candidate outputs that mimic the judge's preferred style) and the mitigations here are textbook: criterion scoring (not freeform), few-shot anchors in the rubric, JSON-only output, separate model for judging from working (here violated by convention: same model — Sonnet 4.6 — for both; Phase 3 plan resolved Q1 documents the tradeoff).

### The deeper principle

**Measure what you can measure deterministically; defer to LLM judges only when set-matching falls short.** Detection uses a deterministic scorer because the seeded anomalies are *known* — matching is a set operation. Diagnosis uses an LLM judge because the candidate output is freeform prose and the rubric asks "does this conclusion hold up against the evidence?" — a question no set-matching can answer. The pillar count (4) reflects how many *different* questions you need to ask; the judge variety (deterministic / LLM / structural+LLM) reflects how many different machines you need to answer them.

### Where it breaks down

**Judge variance.** An LLM judge is itself a stochastic process. Even at temperature 0, repeated judges on the same input occasionally disagree. The harness doesn't run the judge K times — one judge call per candidate. This is a deliberate cost tradeoff (judging K=10 candidates × judge-K=3 = 30 judge calls per eval pillar) and a measurement risk (one bad judge run can shift the aggregate pass rate by 10%). Mitigation: write the raw judge output (`raw_response` field on `JudgeOutput`) to the paper trail so a flaky judge can be audited after the fact.

**The judge sees a truncated transcript.** `TOOL_RESULT_TRUNCATE = 4000` (`judge.ts` L77) means a 50 KB Olist tool result becomes 4 KB. The judge therefore can't catch a candidate diagnosis that fabricates a number that only appears past byte 4000 of the raw result. The truncation is necessary for judge sanity (50 KB inflates judge cost ~10×) but creates a blind spot.

**Same model for working and judging.** `AGENT_MODEL` and `JUDGE_MODEL` are both `claude-sonnet-4-6`. If Sonnet has a systematic bias (e.g., prefers diagnoses that cite many tools regardless of relevance), the judge will reward that bias. The fix is to use a different model family for judging (GPT-4, Llama, etc.), at the cost of paying for two providers.

**No A/B against the production prompt.** The evals always run the *current* prompt. There's no harness for "run prompt A and prompt B side-by-side, score both, compare." Adding it is straightforward (pass a prompt-override env var to the agent driver) but currently a manual git-checkout-and-rerun.

### What to explore next

- **Multi-judge consensus** — run the judge K times, aggregate, increase confidence in the verdict (at K× cost).
- **Eval-as-CI** — wire the score-mode regression eval into a pre-merge check; fail the PR if more than 1/10 goldens regress. Requires controlling cost (~$1–2 per run × N PRs/day).
- **Capture-on-merge** — auto-capture goldens after each merge to main, so the regression eval always compares against the most recent known-good state. Risk: a bad merge becomes the new golden silently.
- **Cross-model robustness** — repeat each pillar with a different model (Haiku, GPT-4) to detect prompts that only work on Sonnet.

---

## Interview defense

**What they're really asking:** "Do you know how to measure an agent system, or are you just shipping vibes?"

---

**[mid] Why four pillars instead of one combined eval?**

Because each pillar measures a different question and combining them would conflate failures. Detection asks "can the system find what's there?" — a set-matching question. Diagnosis asks "given an anomaly, is the candidate's reasoning correct?" — a rubric question. Recommendation asks "given a diagnosis, is the proposed Bloomreach action appropriate?" — a feature-alignment question. Regression asks "did anything change between today's output and the last known-good output?" — a comparison question. Coupling pillars 2 and 3 (run pillar 2, feed its output into pillar 3) would make "the recommendation was bad" indistinguishable from "the recommendation given a bad diagnosis was bad" — un-debuggable. The split between `reference-diagnoses.json` (ground truth for pillar 2) and `reference-diagnoses-as-input.json` (clean inputs for pillar 3) is exactly this isolation.

```
combined eval               isolated pillars
─────────────────────       ─────────────────────────────
"the run failed somehow"    "pillar 2 passed, pillar 3 failed
                             on the same anomaly → recommend
                             agent regressed; diagnostic fine"
```

---

**[senior] The LLM judge is itself an LLM. What stops it from giving the same wrong answer as the candidate?**

Three things, in order of strength. (1) **Criterion-scored rubric, not freeform** — the judge has to assign 0–2 on each of 5 criteria, which forces it to articulate why each score; freeform "yes/no" judges are far more biased. (2) **Few-shot anchors in the judge prompt** — the rubric includes example diagnoses scored 0, 1, 2 for each criterion, calibrating the judge's distribution. (3) **The judge sees the tool-call transcript** — it can verify the candidate's citations against the actual tool results, catching fabrication that a freeform judge would miss. The honest residual risk: same model family (`claude-sonnet-4-6` for both working and judging) means systematic Sonnet biases pass through unflagged. The fix is a different judge model; the codebase defers it under the Phase 3 plan's Q1 resolution because the variance saved by using one provider for both was deemed greater than the bias risk at hackathon scale.

```
freeform judge: "is this good?" → yes/no       criterion judge: hypothesis 0–2, evidence 0–2, …
   ┌──────────────────┐                            ┌─────────────────────────────────────┐
   │ flips on phrasing │                            │ requires articulating reasoning per │
   │ confirmation bias │                            │ criterion — forces examination       │
   │ low audit value   │                            │ raw_response in paper trail          │
   └──────────────────┘                            └─────────────────────────────────────┘
```

---

**[arch] You have K=10 per pillar. How would you decide whether to go to K=30 or K=3?**

K is the variance-vs-cost dial. At K=10 with Sonnet 4.6 the per-pillar cost is ~$1–3 and runtime ~5–10 min; aggregate precision/recall stabilizes around ±5%. K=3 would drop cost to ~$0.30 and runtime to ~2 min, but the variance on a per-anomaly recall rate would be ±15–20% — every single eval run would feel like a different verdict. K=30 would push cost to ~$10 per pillar and runtime to ~30 min — fine for a pre-release check, prohibitive for a per-PR check. The right call is K-per-pillar tuned to how often you run it: pre-merge regression eval at K=1 (deterministic enough), nightly detection/diagnosis at K=10, weekly multi-judge consensus at K=30. The `EVAL_RUN_TAG` env var lets you run multiple K values on the same day without overwriting prior runs.

```
K=3     fast     noisy        feels-different-each-run
K=10    medium   stable ±5%   the current default
K=30    slow     stable ±2%   pre-release confidence
```

---

**The dodge: "Why not just trust the model on Sonnet 4.6? It's good enough."**

That's the position before the eval pipeline exists. The whole point of building the pipeline is to make the question "is the model good enough?" *answerable* per change — per prompt change, per model upgrade, per tool-surface change. Without the pipeline, every regression is found by users in production; with it, regressions are found by the score-mode regression eval before merge. The framing is the same as adding a test suite to an untested codebase: the cost is real (~$5 per full 4-pillar run, ~30 min wall-clock), but the alternative is shipping and hoping. The seeded-anomaly ground truth in `mcp-server-olist/data/olist.db` is the load-bearing detail — it's what turns "vibes-based eval" into "measurable eval" by providing a known answer the system *should* find.

---

**Anchors:**
- `eval/scripts/run-detection.ts` L132–L144: the K-loop, the heart of pillar 1
- `eval/scripts/lib/run-agent.ts` L51 onward: the per-K subprocess-isolated agent driver
- `eval/scripts/lib/judge.ts` L72: `JUDGE_MODEL` = `'claude-sonnet-4-6'` (same as working model; documented tradeoff)
- `eval/scripts/lib/judge.ts` L77: `TOOL_RESULT_TRUNCATE = 4000` — the judge's blind spot
- `eval/scripts/run-regression.ts` L80, L291, L381: the two-mode split (`--capture` vs default)
- `eval/scripts/run-regression.ts` L163–L175: `promptHash()` — the safety net for capture-vs-score drift
- `eval/scripts/run-detection.ts` L95: `EVAL_RUN_TAG` — the same-day re-run escape hatch
- `mcp-server-olist/data/olist.db` `seeded_anomalies` table: the 3 ground-truth anomalies

---

## See also

→ [audit.md](./audit.md) (request-response-and-data-flow lens — the eval pipeline is a parallel-universe request flow over the same agent code) · [03-provider-abstraction.md](./03-provider-abstraction.md) (the `DataSource` seam that makes eval-vs-prod parity possible) · [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md) (what the evals are measuring) · [10-authored-mcp-server.md](./10-authored-mcp-server.md) (the seeded anomalies live in the `mcp-server-olist` SQLite database — that's the ground truth)

---
