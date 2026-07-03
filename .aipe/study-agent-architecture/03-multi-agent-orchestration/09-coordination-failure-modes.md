# Coordination failure modes

_Industry standard._

## Zoom out, then zoom in

The failures that don't exist in single-agent systems. Multi-agent adds classes of bug that no single loop can produce — infinite handoff, cost blowup that compounds silently across workers, synthesis of contradictory sub-results, context bloat as shared state grows. Blooming's mitigations are code-driven (BudgetTracker, per-call timeouts, type-guard validation, `is_error` graceful degradation), and this file walks the specific failure ⇄ mitigation pairs.

```
  Zoom out — the failure surface multi-agent adds

  ┌─ Single-agent failures ─────────────────────────────────────┐
  │  bad tool arg, infinite loop on one path, hallucinated output│
  │  (all bounded by one iteration cap)                          │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Multi-agent adds these ────────────────────────────────────┐
  │  · infinite handoff (A→B→A→B)                                │
  │  · tool-call cascade (per-agent budgets compound)            │
  │  · context bloat (shared state grows)                        │
  │  · synthesis failure (contradictory worker outputs)          │
  │  · cost blowup (2-5x overhead compounds silently)            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: each failure has a specific mitigation in this repo, or a specific reason it doesn't apply. This file names the pairing.

## Structure pass

**Layers:** detection · bounding · graceful degradation · trace preservation.
**Axis:** *at what point in the run does this failure become terminal, and what bounds it?*
**Seam:** the boundary between "budget-exceeded" (recoverable — emit graceful error) and "system error" (unrecoverable — trace it, but abort). BudgetExceededError is caught by the route handler; anything else propagates.

```
  Failures ranked by "who bounds this?"

  Infinite handoff       — supervisor is code, no handoff exists
  Tool-call cascade      — BudgetTracker check-before-dispatch
  Context bloat          — schemaSummary caps + prompt caching
  Synthesis failure      — type guards (isDiagnosis, isRecommendationArray)
  Cost blowup            — BudgetTracker (tokens AND USD ceilings)
  Provider fault         — is_error graceful degradation
```

## How it works

### Move 1 — the mental model

You've written a request handler with a timeout, a retry budget, and a validation guard on the response. Multi-agent needs those same three primitives but *across* agent boundaries, not just within one call. The BudgetTracker is a run-wide token budget; the type guards are run-wide response validation; the deterministic supervisor eliminates handoff as a failure mode entirely.

```
  Pattern: bounded coordination

  ┌─ Run start ────────────────────────────────┐
  │  BudgetTracker created (token+USD ceiling) │
  └─────────────────┬──────────────────────────┘
                    ▼
  ┌─ Every model turn ─────────────────────────┐
  │  1. check budget (fail fast if exceeded)   │
  │  2. dispatch                                │
  │  3. accumulate usage into tracker           │
  └─────────────────┬──────────────────────────┘
                    ▼
  ┌─ Between agents ───────────────────────────┐
  │  Type-guard validate the artifact           │
  │  (isDiagnosis, isRecommendationArray)      │
  └────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Failure: infinite handoff. Mitigation: no handoff exists.** The classic swarm failure — A → B → A → B forever — doesn't apply because blooming's supervisor is deterministic (see `02-supervisor-worker.md`). The dispatch is a top-level `await` in TypeScript, not a model decision. There is no code path in `route.ts` that lets DiagnosticAgent invoke RecommendationAgent, and vice versa. This failure mode is *architecturally eliminated*, not mitigated.

**Failure: tool-call cascade. Mitigation: BudgetTracker check-before-dispatch.** One agent triggers a storm of calls — a diagnostic loop that keeps re-querying with slight variations, never settling. `lib/agents/aptkit-adapters.ts:64` is the gate:

```ts
// aptkit-adapters.ts:64 — check BEFORE dispatching
async complete(request: ModelRequest): Promise<ModelResponse> {
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // ... dispatch to Anthropic ...
  this.budget?.add({ inputTokens: response.usage.input_tokens, ... });
}
```

Line-by-line:

- **`this.budget?.exceeded()` runs before the API call.** A runaway agent can't burn additional cost after the ceiling has already been hit. The check happens even if the agent's own iteration cap hasn't triggered.
- **`throw new BudgetExceededError(...)`** — a typed error, not a generic exception. The route handler catches it specifically and emits a graceful NDJSON `error` event so the UI can render "budget exceeded" instead of showing a crash.
- **`this.budget?.add(...)` after** — accumulates usage so the next check has current numbers. Cross-agent: the same tracker is threaded through DiagnosticAgent AND RecommendationAgent when both share an investigation, so Stage B sees Stage A's spend.

**Failure: context bloat. Mitigation: schemaSummary caps + prompt caching.** As agents accumulate shared context, prompts grow and lost-in-the-middle attacks the model's attention. `lib/agents/monitoring.ts:19-60` bounds the schema at 20 events × 10 properties + 30 customer props — small enough to fit in cached prefix. The full 112KB workspace schema is never in the prompt; only the summary is. The Anthropic ephemeral cache on `system` prompt (`aptkit-adapters.ts:85-89`) turns the fixed prefix into a `cache_read` on turn 2+, so the token cost of the shared context is amortized.

**Failure: synthesis failure. Mitigation: type guards at the seam.** The supervisor synthesizes worker outputs by passing them (see `08-shared-state-and-message-passing.md`). If a worker produces malformed structure — a Diagnosis missing `conclusion`, a Recommendation with an unknown `bloomreachFeature` — Stage B would consume garbage. The guards in `lib/mcp/validate.ts` reject before the next stage sees:

```ts
// lib/mcp/validate.ts:29-35 — isDiagnosis
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}

// lib/mcp/validate.ts:42-56 — isRecommendationArray
// enforces bloomreachFeature ∈ {scenario,segment,campaign,voucher,experiment}
// enforces confidence ∈ {high,medium,low}
```

Line-by-line: the guards enforce shape *and* the fixed enums. The model can't propose a novel `bloomreachFeature` — it must pick one of five. The guards don't catch bad content (a strategically wrong recommendation of a valid shape), but they catch every structural failure the model can produce.

**Failure: cost blowup. Mitigation: BudgetTracker with USD ceiling.** The tracker takes both `maxTokens` and `maxCostUsd` (see `lib/agents/budget.ts:21-26`). USD ceiling uses `estimateAnthropicCost` from `lib/agents/pricing.ts` — same numbers as the report. The eval load harness sets `budgetPerInvestigationUsd: 2` per case; the receipt from run `2026-07-03T05-21-12-237Z` shows `perInvestigationP50: $0.070` — well under. The ceiling is defensive, not typical-case.

**Failure: provider fault. Mitigation: `is_error` graceful degradation.** `FaultInjectingDataSource` (`lib/data-source/fault-injecting.ts`) proves the shape. When a tool call fails (timeout, 500, malformed JSON), AptKit's agent loop presents the failure as `tool_result` with `is_error: true`. The model reasons around it — "that query failed, let me try a different framing" — instead of the loop crashing. Load-harness receipt (`2026-07-03T05-21-12-237Z`, N=3 at 20% timeout + 20% malformed_json fault rates): **9 injected faults, 3 completed investigations, 0 failed runs**. Real receipt of the pattern working.

```
  Layers-and-hops — how each failure gets bounded

  ┌─ Route handler (outer try/catch) ─────────────────────────────┐
  │  catches BudgetExceededError → NDJSON `error` event           │
  │  catches everything else → NDJSON `error` event + log         │
  └───────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
  ┌─ Agent (DiagnosticAgent, RecommendationAgent) ────────────────┐
  │  runs AptKit loop bounded by maxTurns=8, maxToolCalls=6       │
  │  every model turn: BudgetTracker check-before-dispatch        │
  │  every tool result: `is_error: true` → model reasons around   │
  └───────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
  ┌─ Data source (BloomreachDataSource + FaultInjectingDataSource)┐
  │  rate limit retry (minIntervalMs=1100, retryCeilingMs=20_000) │
  │  fault decorator surfaces provider errors as is_error=true    │
  └───────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Every coordination failure in this repo has a specific bound, and the bound is usually *code, not prompt*. BudgetTracker is code; type guards are code; deterministic supervisor is code; graceful degradation via `is_error` is code. That's the interview-grade principle — multi-agent's 2-5x overhead only stays bounded when the controls that bound it are outside the model's decision surface. Prompts can be jailbroken or ignored; typed contracts and code-side budgets cannot.

## Primary diagram

```
  Recap — coordination failure ⇄ mitigation pairs in this repo

  Failure                         Mitigation                       Site
  ─────────────────────────────  ───────────────────────────────  ─────────
  Infinite handoff               Deterministic supervisor          route.ts
  Tool-call cascade              BudgetTracker check-before-       aptkit-adapters.ts:64
                                 dispatch
  Context bloat                  schemaSummary caps + prompt       monitoring.ts:19-60
                                 cache on system prompt            aptkit-adapters.ts:85-89
  Synthesis failure              Type guards at seam               mcp/validate.ts
  Cost blowup                    BudgetTracker USD ceiling         lib/agents/budget.ts
                                                                   lib/agents/pricing.ts
  Provider fault                 is_error graceful degradation     fault-injecting.ts
                                 (receipt: 9 faults / 0 failed)    load receipt 2026-07-03
```

## Elaborate

The 2-5x coordination overhead multi-agent adds shows up in three specific places, and this repo's controls target each:

- **Token cost per hop.** Each additional agent turn is another model call. The BudgetTracker bounds the total; the Anthropic ephemeral cache on system prompts cuts the marginal cost of each turn.
- **Latency stack-up.** Sequential agents add wall-clock (~50s diagnose + ~51s recommend). AptKit's `maxTurns=8` and `maxToolCalls=6` bound how deep each agent can dig; the 1-req/s data-source throttle bounds how many tool calls per second.
- **Failure surface.** Every seam is a new opportunity for shape mismatch. Type guards on Diagnosis and Recommendation catch the shape-level failures; `is_error` handling catches the tool-level failures.

The fault-injection load harness is the receipt that these controls actually work together. Running 3 investigations against a fault-injected data source at 20% timeout + 20% malformed_json rates: 9 faults presented to the model as `is_error: true` tool results, 3 investigations completed cleanly, 0 failed runs, $0.20 total spend. The system degrades gracefully in the face of injected chaos — the exact tier-2 story the fault decorator was built to defend.

Blooming's failure controls all live in code that the model doesn't see. That's deliberate: a prompt-level control ("don't exceed the budget") can be jailbroken by adversarial input or ignored by a distracted model. A code-level control (`if (budget.exceeded()) throw`) cannot. The senior-grade version of this idea is "controls belong outside the model's decision surface."

## Interview defense

**Q: What multi-agent failures does this system defend against, and where do the controls live?**
A: Five failure classes, five specific controls, all in code (not prompts). Infinite handoff is eliminated by having a deterministic supervisor — there IS no handoff, just top-level `await`s in `route.ts`. Tool-call cascade and cost blowup are bounded by the BudgetTracker's check-before-dispatch pattern in `lib/agents/aptkit-adapters.ts:64` — every model turn checks the tracker BEFORE the API call, so a runaway loop can't burn cost after the ceiling. Context bloat is bounded by `schemaSummary` in `lib/agents/monitoring.ts:19-60` capping the shared context to a small prefix + Anthropic's ephemeral cache. Synthesis failure is caught by the type guards in `lib/mcp/validate.ts` — `isDiagnosis` and `isRecommendationArray` reject malformed shape and enforce the fixed feature enum. Provider fault is handled by `is_error: true` on tool results — the load harness shows 9 injected faults across 3 investigations with 0 failed runs.

Diagram: the failure ⇄ mitigation table with sites in the code.
Anchor: `lib/agents/aptkit-adapters.ts:64` (budget check) + `lib/agents/budget.ts` + `lib/mcp/validate.ts` + `lib/data-source/fault-injecting.ts`.

**Q: Why is the BudgetTracker a code-side control instead of a prompt instruction?**
A: Prompts can be ignored. If the system prompt says "don't exceed $2," the model might respect it, might not — and there's no enforcement. The BudgetTracker is a `if (this.budget.exceeded()) throw BudgetExceededError` right before every Anthropic API call, in the model provider adapter. The model can't jailbreak past it because the model never sees it. That's the senior-grade principle: controls belong outside the model's decision surface. Same reason we do type-guard validation in TypeScript instead of asking the model to "please return valid JSON."

Diagram: the check-before-dispatch site, showing where the budget gate sits relative to the model.
Anchor: `lib/agents/aptkit-adapters.ts:60-66`.

## See also

- `04-agent-infrastructure/04-guardrails-and-control.md` — the full control envelope around the loop.
- `05-production-serving/03-fault-injection-and-graceful-degradation.md` — the load-harness receipt in detail.
- `05-production-serving/04-cost-controls.md` — the BudgetTracker + prompt cache + pricing helper together.
- `01-when-not-to-go-multi-agent.md` — the 2-5x cost claim, now made concrete.
