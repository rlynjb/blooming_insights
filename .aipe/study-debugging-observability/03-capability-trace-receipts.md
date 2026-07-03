# 03 · Capability trace receipts

*Trace capture + persistent ledger — **project-specific***

## Zoom out — where this concept lives

The evaluation runner captures every raw `CapabilityEvent` from the
aptkit trace sink for each case, then writes a per-case JSON file
with the anomaly, diagnosis, judgment, tool calls, tokens, cost,
and budget snapshot. This is the ONLY observability surface in the
repo that persists across runs with full provenance.

```
  Zoom out — receipts as the durable observability layer

  ┌─ eval runner (vitest) ──────────────────────────────────┐
  │  eval/run.eval.ts                                        │
  │    │                                                     │
  │    │ instantiate DiagnosticAgent + hooks                │
  │    ▼                                                     │
  │  hooks.onCapabilityEvent = (ev) => trace.push(ev)        │
  │                                                          │
  └─────────────────────────┬───────────────────────────────┘
                            │  every CapabilityEvent flows in
                            │  including model_usage
                            ▼
  ┌─ agent internals ───────────────────────────────────────┐
  │  DiagnosticAgent → AptKit's DiagnosticInvestigationAgent  │
  │    → AnthropicModelProviderAdapter                       │
  │    → BloomingTraceSinkAdapter.emit(event)                │
  │      → hooks.onCapabilityEvent?.(event)  ← the fork      │
  └──────────────────────────────────────────────────────────┘
                            │  after investigation returns
                            ▼
  ┌─ summarize + write ─────────────────────────────────────┐
  │  summarizeUsage(trace) → {inputTokens, outputTokens,     │
  │                           totalTokens, turns, ...}       │
  │  estimateAnthropicCost(usage, model) → CostEstimate      │
  │                                                          │
  │  ★ writeFileSync(eval/receipts/<case>-<runId>.json) ★    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in — this is what turns "we ran the eval and case 09 was slow"
into "case 09 spent 675s at rec-judge because the judge model
retried three times on this specific rubric response, here are the
token counts per turn, here's what the diagnosis looked like." A
receipt is the discovery-affidavit for a bug.

## Structure pass — the skeleton

**Axis held constant: who owns each field in the receipt?**

| Field | Owned by | Origin |
|---|---|---|
| `anomaly` | golden case | `eval/goldens/*.json` |
| `diagnosis` | agent under test | `DiagnosticAgent.investigate()` |
| `diagnosisJudgment` | judge model | `RubricJudge.judge()` |
| `diagnosisToolCalls` | agent under test | `hooks.onToolResult` capture |
| `usage.diagnose` | trace capture | `summarizeUsage(diagnosisTrace)` |
| `usage.diagnose.costUsd` | pricing helper | `estimateAnthropicCost` fallback |
| `budget.snapshot` | budget tracker | `BudgetTracker.snapshot()` |
| `durationMs.investigate` | eval runner | `performance.now()` bracket |

**Seams — where responsibility flips:**

  → seam 1 — **`onCapabilityEvent` hook.** Blooming's
    `AptKitAgentHooks` (`aptkit-adapters.ts:20-33`) added this hook
    additively; consumers that don't set it see identical behavior.
    The eval runner sets it (`run.eval.ts:194`); the routes don't
    (yet). This is a **pure observability tap** — no functional
    change to the agent.
  → seam 2 — **`summarizeUsage` from aptkit vs `estimateCost` from
    aptkit vs `estimateAnthropicCost` from Blooming.** Aptkit's
    `estimateCost` only knows OpenAI pricing (`pricing.ts:6-9`);
    Blooming provides the Anthropic fallback. The seam is the
    `??` chain at `run.eval.ts:203-205`.
  → seam 3 — **receipt on disk.** After this seam, the trace is
    gone from memory but the summary is durable. The report
    (`report.eval.ts`) can only work off what's in the receipt —
    which is why the receipt design matters.

## How it works

### Move 1 — the mental model

Think of the receipt as the "test failed, here's the whole crime
scene" screenshot — but for a probabilistic system, so it has to
carry more than just inputs and outputs. It carries the **provenance
of the answer**: which model turns produced it, how many tokens
each turn burned, which tools got called with which args and which
results, and what the judge model said about the answer's quality.

```
  The pattern — every case leaves a full-provenance receipt

  golden case
      │
      ▼
  ┌──────────────────────────────────────────────────────┐
  │ agent.investigate(anomaly, {onCapabilityEvent})      │
  │   │                                                  │
  │   │ every model turn, every tool call, every step    │
  │   │ pushes into diagnosisTrace: CapabilityEvent[]    │
  │   ▼                                                  │
  │ diagnosis                                            │
  └──────────────────┬───────────────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────────────┐
  │ judge.judge({subject, context})                      │
  │   │                                                  │
  │   ▼                                                  │
  │ judgment (verdict + per-dimension scores + reason)   │
  └──────────────────┬───────────────────────────────────┘
                     │
                     ▼
              summarizeUsage(trace)
                     │
                     ▼
              estimateAnthropicCost(usage, model)
                     │
                     ▼
              writeFileSync(<case>-<runId>.json)
                     │
                     ▼
                 receipts/
                 └── 09-…-04-08-28-644Z.json   (~35KB)
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the additive `onCapabilityEvent` hook.**

Every place in the codebase where a receipt gets built starts here.
The hook is added at `aptkit-adapters.ts:139` in
`BloomingTraceSinkAdapter.emit()`:

```typescript
// lib/agents/aptkit-adapters.ts:143-148
emit(event: CapabilityEvent): void {
  // Additive Phase-2 observability: forward every event to the optional
  // capability-event hook before existing per-type routing. Consumers
  // that don't set the hook see identical behavior.
  this.hooks.onCapabilityEvent?.(event);

  if (event.type === 'step') { ... }
  if (event.type === 'tool_call_start') { ... }
  ...
}
```

**Why it lives BEFORE the existing per-type routing:** so a consumer
sees the full event stream, including `model_usage` and `warning`
events that don't fan out to `onText` / `onToolCall`. The routes only
care about the fan-out; the eval runner needs the raw firehose.

**What breaks if this hook fires AFTER routing:** the eval runner's
`diagnosisTrace: CapabilityEvent[]` array misses events that got
short-circuited by an early `return` in one of the type-specific
branches. That would silently under-count tokens.

**Part 2 — the eval runner collects the trace per case.**

From `run.eval.ts:189-197`:

```typescript
const diagnosisToolCalls: ToolCall[] = [];
const diagnosisTrace: CapabilityEvent[] = [];
const diagnosis = await diagnosticAgent.investigate(goldenCase.anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,
});
```

Two parallel collections happen:

  → `diagnosisToolCalls: ToolCall[]` — the Blooming-shaped tool call
    records. This is what the receipt persists for the tool trace.
  → `diagnosisTrace: CapabilityEvent[]` — the raw aptkit events,
    kept ONLY for the summarize step. Full trace is discarded after
    `summarizeUsage` runs — the receipt shape doesn't include it.

The tradeoff here: the receipt keeps the *summarized* usage plus the
*Blooming-shaped* tool calls; it discards the raw aptkit event
stream. If you later want a bug to be reproducible from the receipt
alone (not just a summary), you'd add `diagnosisTrace` to the JSON —
at the cost of receipt size. Current call: summary + tool calls is
enough for the report to work.

**Part 3 — `summarizeUsage` + `estimateAnthropicCost`.**

`summarizeUsage` walks the trace and sums `model_usage` events into a
single `TokenUsageSummary`. Cost estimation is provider-specific:

```typescript
// eval/run.eval.ts:200-205
const diagnosisUsage = summarizeUsage(diagnosisTrace);
// aptkit's estimateCost only knows OpenAI pricing; fall back to
// Blooming's Anthropic pricing helper for our claude-* models.
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

Blooming's `estimateAnthropicCost` (`lib/agents/pricing.ts`) is one
short module — MTok pricing for Sonnet, Haiku, Opus:

```typescript
// lib/agents/pricing.ts:23-32
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3,  outputUsdPerMillion: 15 }],
  [/^claude-haiku-4/,  { inputUsdPerMillion: 1,  outputUsdPerMillion:  5 }],
  [/^claude-opus-4/,   { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];
```

**The load-bearing caveat.** `pricing.ts:6-13` documents it plainly:
receipts capture only `inputTokens` and `outputTokens` (aptkit's
`model_usage` event shape). `cache_read_input_tokens` are excluded
from `inputTokens`, so **cost estimated from a receipt is an upper
bound when caching is on.** The report labels this at
`report.eval.ts:136-142`.

**Part 4 — `usageWithCost()` — the ledger row shape.**

From `run.eval.ts:107-119`:

```typescript
function usageWithCost(usage: TokenUsageSummary, cost: CostEstimate | undefined) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    turns: usage.turns,
    modelName: usage.modelName,
    estimated: usage.estimated,
    costUsd: cost?.totalCost ?? null,
    inputCostUsd: cost?.inputCost ?? null,
    outputCostUsd: cost?.outputCost ?? null,
  };
}
```

This is the **per-invocation ledger row**. Two per case (diagnose +
recommend). The report reads this row directly.

**Part 5 — the receipt structure on disk.**

Actual receipt shape from `run.eval.ts:305-323`:

```typescript
const receipt = {
  runId, case, signalClass, intent,
  durationMs: {
    investigate, diagnosisJudge, recommend, recommendationJudge, total
  },
  model: { agent, judge },
  anomaly: {metric, scope, change, severity},
  diagnosisToolCalls: [...],       // Blooming-shaped
  recommendationToolCalls: [...],  // Blooming-shaped
  usage: {                          // Phase-2 observability
    diagnose: usageWithCost(diagnosisUsage, diagnosisCost),
    recommend: usageWithCost(recommendUsage, recommendCost),
  },
  budget: {                         // Phase-3 budget ceiling
    limit, snapshot, exceeded, budgetError,
  },
  diagnosis, diagnosisJudgment, diagnosisJudgmentError,
  diagnosisJudgeAttempts,
  recommendations, recommendationJudgments,
};

writeFileSync(
  resolve(RECEIPTS_DIR, `${goldenCase.caseId}-${sharedRunId}.json`),
  JSON.stringify(receipt, null, 2) + '\n', 'utf8'
);
```

Real receipts land at
`eval/receipts/<caseId>-<runId>.json`; typical case is ~35KB. Example:
`09-engagement-drop-email-campaign-2026-07-03T04-08-28-644Z.json` is
424 lines, holds:
- `durationMs.recommendationJudge: 675185` — the p99 outlier from
  the baseline
- 8 diagnosis tool calls, 4 recommendation tool calls
- `usage.diagnose` and `usage.recommend` ledger rows
- 3 recommendations, each with its own rubric judgment

**Part 6 — `budget` and `judge_error` as first-class receipt fields.**

Two non-obvious slots earn their place:

`budget` — `run.eval.ts:290-297`. Even when the budget isn't hit
(default $2.00 vs observed ~$0.09/case), the receipt records the
limit, snapshot, and exceeded flag. This is proof-of-pipe: the field
is populated on every case so a future budget breach lands
immediately as a distinct outcome.

`buildJudgmentPlaceholder('judge_error')` — `run.eval.ts:87-99`.
When the judge model fails to produce parseable structured output
(retries exhausted), the runner writes a placeholder judgment with
verdict `judge_error` rather than throwing. This makes judge failure a
tracked outcome instead of a missing receipt. The committed baseline
shows this is a real path: 6/40 diagnosis judgments and 9/60
recommendation judgments came back as `judge_error`.

### Move 2 — Layers-and-hops: a case's data journey

```
  One golden case → one receipt

  ┌─ goldens/09-engagement-drop-email-campaign.json ────────┐
  │  anomaly, expected shape, intent                         │
  └────────────────┬─────────────────────────────────────────┘
                   │  read into `goldenCase`
                   ▼
  ┌─ DiagnosticAgent.investigate(anomaly) ──────────────────┐
  │  hooks = {onToolResult, onCapabilityEvent, budget}       │
  │                                                          │
  │  ┌─ 8 model turns ─────────────────────────────────────┐│
  │  │ turn 1: tool_call → list_email_campaigns           ││
  │  │ turn 2: tool_call → get_event_segmentation         ││
  │  │ ...                                                 ││
  │  │                                                     ││
  │  │  each turn emits:                                   ││
  │  │    tool_call_start / tool_call_end / step /         ││
  │  │    model_usage(input_tokens, output_tokens,          ││
  │  │                cache_creation, cache_read)           ││
  │  └────────────────┬────────────────────────────────────┘│
  │                   │  every event                         │
  │                   ▼                                      │
  │  BloomingTraceSinkAdapter.emit(event):                   │
  │    hooks.onCapabilityEvent?.(event)  ← forks the stream  │
  │                                                          │
  └────────────────┬─────────────────────────────────────────┘
                   │  diagnosisTrace grew to N events
                   │  diagnosisToolCalls grew to 8 records
                   ▼
  ┌─ eval/run.eval.ts computes summary ─────────────────────┐
  │  usage = summarizeUsage(diagnosisTrace)                  │
  │  cost  = estimateCost('anthropic', ...) ?? estimateAnthropicCost │
  │  row   = usageWithCost(usage, cost)                      │
  │                                                          │
  │  ┌─ RubricJudge.judge({subject: diagnosis, ...}) ────────┐│
  │  │  judgment = {verdict, dimensions, reasoning}          ││
  │  │  (may retry; may end up as judge_error placeholder)   ││
  │  └───────────────┬─────────────────────────────────────┘│
  │                  │                                       │
  │                  ▼                                       │
  │  receipt = {                                             │
  │    anomaly, diagnosis, diagnosisJudgment,                │
  │    usage: {diagnose: row, recommend: row},               │
  │    budget: {limit, snapshot, exceeded, budgetError},     │
  │    durationMs, ...                                       │
  │  }                                                       │
  └────────────────┬─────────────────────────────────────────┘
                   │  JSON.stringify(receipt, null, 2)
                   ▼
        eval/receipts/09-…-04-08-28-644Z.json  (~35 KB)
                   │
                   ├───────► report.eval.ts       → percentiles + $
                   ├───────► baseline.eval.ts     → per-dimension rates
                   ├───────► gate.eval.ts         → regression check
                   └───────► your grep + jq       → the debug tool
```

### Move 3 — the principle

**The receipt is the debugging boundary between runs.** In-memory
state dies with the process; the wire dies with the browser tab;
the phase log tells you what happened at 30,000ft. The receipt is
the persistent, high-fidelity record that lets a bug reported by
someone else become a bug you can debug tomorrow. Design the
receipt shape once, populate it aggressively (budget, judge errors,
placeholders when data is missing), and every downstream tool
(reports, gates, dashboards) can grow off it without another round
of instrumentation.

## Primary diagram

```
  Capability trace receipts — the full picture

  ┌─────────────────────────────────────────────────────────────────┐
  │ EVAL RUNNER (vitest, per case)                                  │
  │                                                                  │
  │  BudgetTracker(maxCostUsd)  ── shared across agents              │
  │                                                                  │
  │  DiagnosticAgent.investigate(anomaly, {                          │
  │      onToolResult,                                               │
  │      onCapabilityEvent,   ← the observability fork               │
  │      budget,                                                     │
  │  })                                                              │
  │       │                                                          │
  │       │ collects: diagnosisToolCalls[], diagnosisTrace[]         │
  │       │                                                          │
  │       ▼                                                          │
  │  RecommendationAgent.propose(anomaly, diagnosis, {...})          │
  │       │                                                          │
  │       │ collects: recommendationToolCalls[], recommendationTrace │
  │       │                                                          │
  │       ▼                                                          │
  │  RubricJudge.judge({subject: diagnosis, context}) ─┐              │
  │  RubricJudge.judge({subject: rec, context}) ×N ────┼─► judgments │
  │       │                                            │              │
  │  summarizeUsage(trace) → TokenUsageSummary         │              │
  │  estimateCost('anthropic', ...) ?? estimateAnthropicCost          │
  │  usageWithCost(...) → ledger row                                  │
  │                                                                  │
  │  writeFileSync(eval/receipts/<case>-<runId>.json)                │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │
     ┌───────────────────────────┼───────────────────────────┐
     ▼                           ▼                           ▼
 report.eval.ts            baseline.eval.ts             gate.eval.ts
 latency percentiles       per-dimension rates          regression check
 tokens + cost table       verdict distribution         (see file 04)
```

## Elaborate

**Where this pattern comes from.** The idea of a per-test-case
receipt with full provenance is standard in ML/AI eval frameworks
(OpenAI evals, LangSmith, Braintrust, Weights & Biases). What's
particular about this implementation is the seam: the additive
`onCapabilityEvent` hook, which means the same production agent
code runs unchanged in the eval — no fork, no test-only agent
class, no mock. The eval is just "production agent + one hook that
captures the raw event stream."

**Cousins that solve the same problem differently.**

  → **In-memory eval only** (some earlier setups) — fast but every
    run is throwaway. No cross-run comparison, no regression gate.
  → **A dedicated eval DB** (LangSmith, Braintrust) — richer query
    story but adds a runtime dep + credentials + hosted-service
    coupling. blooming picks flat JSON files because they're
    grep-able and diff-able out of the box.
  → **Stdout log scraping** — cheaper to bolt on but the shape
    isn't a first-class object; parsing is fragile.

**Adjacent to `04-baseline-and-regression-gate.md`.** Receipts are
the raw material; the baseline is the compressed summary; the gate
is the policy over the summary. Each layer is a fixed function
over the layer below — deterministic, replayable, auditable.

## Interview defense

**Q1 · "What does 'observability' mean in a probabilistic system
where the output can vary run-to-run?"**

**Model answer.** It means capturing not just inputs and outputs
but the **provenance of the answer**: which model turns produced
it, how many tokens each turn burned, which tools got called with
which args and which results, and what a judge model says about
the answer's quality. In this repo that lives at
`eval/receipts/<case>-<runId>.json` — one file per case per run,
~35KB, with anomaly (input), diagnosis (output), judgment (quality
score), tool calls, token usage, cost, budget snapshot. Any
regression is grep-able across runs. Anchor: `eval/run.eval.ts:305-
323`.

**Q2 · "What's the load-bearing part of this pattern people forget?"**

**Model answer.** Emit the hook BEFORE the type-specific routing.
`BloomingTraceSinkAdapter.emit()` calls `onCapabilityEvent(event)`
at the top of the method (`aptkit-adapters.ts:143-148`), before
any `event.type === 'step' | 'tool_call_start' | ...` branch. If
the hook fires INSIDE a branch, some events short-circuit past it
— specifically `model_usage`, which is what `summarizeUsage` depends
on for token accounting. Fire the hook first and you get the full
raw firehose; fire it inside the switch and your token counts
silently under-count. The comment names this: "Consumers that
don't set the hook see identical behavior" — that's the "additive"
guarantee.

```
  interview sketch — where the fork belongs

  ┌ emit(event) ────────────┐
  │                          │
  │  hooks.onCapabilityEvent?.(event)   ← FORK HERE (correct)
  │                          │
  │  if event.type === 'step':                          │
  │    hooks.onText(event.content)                      │
  │    return                                           │
  │  if event.type === 'tool_call_start':               │
  │    ... early return can happen here                 │
  │  if event.type === 'tool_call_end':                 │
  │    ...                                              │
  │                          │
  └──────────────────────────┘

  If the fork were INSIDE any branch, an early return would drop
  model_usage events → token count wrong → cost wrong → budget
  tracker wrong.
```

**Q3 · "Why keep two parallel collections
(diagnosisToolCalls + diagnosisTrace)?"**

**Model answer.** Different consumers. The Blooming-shaped
`ToolCall[]` is what the receipt persists — it's what the report
reads to compute per-tool-call latency, it's what a human reading
the receipt actually scans. The raw `CapabilityEvent[]` is used
ONLY for `summarizeUsage()` to get token totals, and then it's
discarded. Holding both keeps the receipt shape stable (no aptkit
internals in the JSON), while still getting accurate token math
from the raw event stream. It's a **compute-then-collapse** shape.

## See also

- `01-ndjson-live-trace.md` — the wire the trace mirrors
- `02-per-phase-request-summary.md` — the per-request complement
  (route-scope; this file is eval-scope)
- `04-baseline-and-regression-gate.md` — what these receipts feed
