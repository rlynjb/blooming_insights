# Cost controls

_Industry standard._

## Zoom out, then zoom in

Four compound levers together: (1) Anthropic ephemeral cache on the system prompt (`aptkit-adapters.ts:87`) reduces per-turn input cost ~80% after turn 1, (2) `BudgetTracker` in `lib/agents/budget.ts` bounds spend with USD ceiling, (3) `estimateAnthropicCost` in `lib/agents/pricing.ts` provides the pricing helper (aptkit's `estimateCost` is OpenAI-only), (4) tight iteration caps (`maxTurns=8`, `maxToolCalls=6`) bound depth. Together they hold per-investigation cost around **~$0.07-0.09 p50** on the current dataset.

```
  Zoom out — the four cost levers, compounding

  ┌─ Anthropic prompt cache (aptkit-adapters:87) ───────────────┐
  │  cache_control: ephemeral on system prompt                  │
  │  turn 1: cache_creation (~1.25× input cost)                 │
  │  turn 2+: cache_read (~0.1× input cost)                    │
  │  → ~80% reduction on system-prompt token cost              │
  └─────────────────────────────────────────────────────────────┘
  ┌─ BudgetTracker (lib/agents/budget.ts) ──────────────────────┐
  │  maxTokens ceiling + maxCostUsd ceiling                     │
  │  check BEFORE dispatch → hard stop when exceeded            │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Pricing helper (lib/agents/pricing.ts) ────────────────────┐
  │  Sonnet: $3 in / $15 out per MTok                            │
  │  Haiku: $1 in / $5 out per MTok                              │
  │  Fills aptkit's OpenAI-only gap for Anthropic models         │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Iteration caps (AptKit config) ─────────────────────────────┐
  │  maxTurns=8, maxToolCalls=6 per agent                        │
  │  bounds depth → bounds cost per investigation                │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the compound effect is what matters. Each lever alone is decent; together they define the cost surface. This file walks each and how they interact.

## Structure pass

**Layers:** per-turn cost (cache) · per-agent cost (iteration caps) · per-investigation cost (BudgetTracker) · pricing math (helper).
**Axis:** *at what granularity does this lever apply?*
**Seam:** the BudgetTracker's check-before-dispatch — the enforcement site where all four levers converge.

```
  The four levers, ordered by scope

  Granularity          Lever                          Effect
  ─────────────────  ──────────────────────────────  ─────────────────
  per-turn            cache_control: ephemeral       ~80% input reduction
  per-agent-loop      maxTurns=8, maxToolCalls=6     depth bound
  per-investigation   BudgetTracker.maxCostUsd       hard USD ceiling
  cost math           estimateAnthropicCost          pricing accuracy
```

## How it works

### Move 1 — the mental model

You've optimized an expensive API endpoint before: cache what's stable, cap what can grow, count what you spend, hard-stop on overrun. Cost controls for an agent loop are the same instinct across four levers. Each has its own scope; missing one shows up as a specific failure — no cache = expensive per-turn, no depth cap = unbounded per-agent-loop, no BudgetTracker = unbounded per-investigation, no pricing = you can't measure any of it.

```
  Pattern: layered cost bounding

  ┌─ Per-turn: prompt cache ─────────────────────┐
  │  Stable prefix cached; 80% input saving       │
  └───────────────────────────────────────────────┘
  ┌─ Per-agent-loop: iteration caps ──────────────┐
  │  maxTurns, maxToolCalls bound depth           │
  └───────────────────────────────────────────────┘
  ┌─ Per-investigation: BudgetTracker ────────────┐
  │  USD + token ceiling; check-before-dispatch   │
  └───────────────────────────────────────────────┘
  ┌─ Cost math: pricing helper ───────────────────┐
  │  All measurement rolls up through here         │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Lever 1 — prompt caching (`lib/agents/aptkit-adapters.ts:85-89`).** The cache breakpoint sits on the `system` block:

```ts
// aptkit-adapters.ts:85-89 — the cache
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
```

Line-by-line:

- **The system prompt is stable across every call within an investigation.** All ~5-15 ReAct-loop iterations reuse it.
- **`cache_control: { type: 'ephemeral' }`** — Anthropic's cache breakpoint. Turn 1 is `cache_creation` (~1.25× normal input cost); turns 2-N are `cache_read` (~0.1× normal). 5-minute TTL.
- **Tools are also cached transparently.** Anthropic caches the `tools` block when the SAME breakpoint is set on `system`. One `cache_control` covers both prefixes.
- **Verified in live logs.** The cache_creation → cache_read pattern shows up on every ReAct run, with the token count matching what aptkit's `model_usage` reports.

For a diagnostic run with ~10 model turns:
- Without cache: 10 turns × 3200 input tokens × $3/MTok = $0.096.
- With cache: 1 × 3200 × 1.25 × $3/MTok + 9 × 3200 × 0.1 × $3/MTok = $0.012 + $0.0086 = **$0.021**.
- Savings: ~78% of input-side cost.

**Lever 2 — `BudgetTracker` (`lib/agents/budget.ts:41-77`).** Bounds per-investigation spend. See `04-agent-infrastructure/04-guardrails-and-control.md` for the full mechanics. Key parts:

```ts
// lib/agents/budget.ts:41-77 — the tracker
export class BudgetTracker {
  constructor(
    public readonly limit: BudgetLimit,       // maxTokens? maxCostUsd?
    private readonly modelName = 'claude-sonnet-4-6',
  ) {}

  add(usage: { inputTokens: number; outputTokens: number }): void { ... }
  snapshot(): BudgetSnapshot { ... }         // uses estimateAnthropicCost
  exceeded(): boolean { ... }                 // check before dispatch
}
```

Line-by-line:

- **Two ceilings, either or both.** `maxTokens` for compute-side hard stop; `maxCostUsd` for dollar-side. Load harness uses `budgetPerInvestigationUsd: 2` — headroom over the ~$0.07 p50 case.
- **Uses `estimateAnthropicCost`** — same pricing as the report, so the tracker's decision matches what shows up in receipts.
- **Slight undercount when caching is on.** The tracker only sees `input_tokens` / `output_tokens` from the SDK response, which already exclude cache-read tokens. That means the tracker is *conservative* — real spend is lower than what it reports.

**Lever 3 — pricing helper (`lib/agents/pricing.ts`).** AptKit's `estimateCost` returns `undefined` for Anthropic models (it only knows OpenAI). Blooming fills the gap:

```ts
// lib/agents/pricing.ts (excerpt) — Anthropic pricing
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
  [/^claude-haiku-4/, { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }],
  [/^claude-opus-4/, { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];

export function estimateAnthropicCost(
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>,
  modelName: string,
): CostEstimate | undefined { /* ... */ }
```

Line-by-line:

- **Model-family match by regex.** New model versions in a family (Sonnet 4.7 when released) work without code change.
- **Same shape as aptkit's `CostEstimate`.** Downstream code doesn't have to distinguish Anthropic vs OpenAI cost math.
- **No cache-tier pricing** — deliberately. The model_usage event Blooming captures doesn't expose `cache_read_tokens` separately; costs estimated here are therefore an UPPER BOUND when caching is on. Real spend is lower.

**Lever 4 — iteration caps (AptKit config).** `maxTurns=8` and `maxToolCalls=6` per agent bound how deep any single loop can go. That's the depth ceiling; multiplied by the two-stage pipeline (diagnose → recommend) it gives ~16 turns and ~12 tool calls maximum per investigation. Real median is ~10 turns and ~5 tool calls; the caps are defensive.

**The math on a typical run.** Baseline run receipt (`2026-07-03T05-21-12-237Z`):
- Per investigation p50: **$0.070**, ~9246 tokens.
- Cost breakdown per investigation: ~$0.03 diagnose + ~$0.04 recommend.
- Model turns per phase: ~5.
- The cache turns "10 turns × full prefix" into "1 write + 9 reads," which explains why per-investigation cost holds around $0.07 even at Sonnet 4.6 pricing.

```
  Layers-and-hops — one turn's cost accounting

  ┌─ Model turn starts ────────────────────────────────────────┐
  └───────────────────────────┬────────────────────────────────┘
                              ▼
  ┌─ AnthropicModelProviderAdapter.complete ────────────────────┐
  │  1. budget.exceeded()? throw BudgetExceededError            │
  │  2. build params with cache_control on system              │
  │  3. anthropic.messages.create(...)                          │
  │  4. log usage                                                │
  │  5. budget.add({ inputTokens, outputTokens })               │
  └───────────────────────────┬────────────────────────────────┘
                              ▼
  ┌─ Downstream (evals) ────────────────────────────────────────┐
  │  onCapabilityEvent → aggregator → estimateAnthropicCost     │
  │  → receipt row per investigation                            │
  └─────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Cost controls compound. Each lever alone bounds one dimension: the cache bounds per-turn cost; iteration caps bound per-agent depth; BudgetTracker bounds per-investigation dollars; the pricing helper makes all of it measurable. Missing any one and the others become guesses. The transferable version: production cost is a compound of granularities, so bound each granularity where it applies — per-request cache, per-loop cap, per-run budget, per-model pricing. That's what turns "we tried to minimize cost" into "our p50 investigation is $0.07 and here's the receipt."

## Primary diagram

```
  Recap — the four cost levers in this repo

  ┌─ Lever 1: prompt cache (per turn) ──────────────────────────┐
  │  cache_control: ephemeral on system prompt                  │
  │  aptkit-adapters.ts:85-89                                   │
  │  Effect: ~78% input-side cost savings after turn 1          │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Lever 2: iteration caps (per agent loop) ──────────────────┐
  │  AptKit maxTurns=8, maxToolCalls=6                          │
  │  Effect: depth bound, guarantees loop terminates             │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Lever 3: BudgetTracker (per investigation) ────────────────┐
  │  maxTokens + maxCostUsd ceilings                            │
  │  Check BEFORE dispatch at aptkit-adapters.ts:64             │
  │  Effect: hard USD ceiling, throws BudgetExceededError       │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Lever 4: pricing helper (measurement) ─────────────────────┐
  │  estimateAnthropicCost — Sonnet $3/$15, Haiku $1/$5,        │
  │                          Opus $15/$75 per MTok               │
  │  Fills aptkit's OpenAI-only gap                              │
  └─────────────────────────────────────────────────────────────┘

  Compound result: p50 per investigation ≈ $0.07, ~9246 tokens
  Receipt: eval/load-receipts/load-2026-07-03T05-21-12-237Z.json
```

## Elaborate

The cache lever is the highest-leverage single change in this repo. Blooming's Phase-3B addition was adding the `cache_control: { type: 'ephemeral' }` line to the system prompt. That's five characters of code, roughly 80% cost reduction on the input side of a ~10-turn diagnostic loop. Every other lever is more work for smaller gain.

The BudgetTracker is defensive. In the typical case it never fires — p50 investigation is $0.07, ceiling is $2, three orders of magnitude of headroom. The lever earns its keep when a runaway happens: a model that gets stuck in an EQL loop, a fault injection that keeps returning `is_error` and the model keeps retrying, an agent whose iteration cap fails to catch it. The tracker's check-before-dispatch is what stops the runaway before it burns the full budget.

The pricing helper is the smallest lever but the most important for accuracy. Without it, aptkit's `estimateCost` returns `undefined` for every Anthropic call, and receipts have no cost column. The Anthropic pricing is public and stable, so keeping it in a helper file is low-maintenance — update when Anthropic changes prices, add rows for new families. The regex-per-family match means Sonnet 4.7 will work without code change when it lands.

The iteration caps come from AptKit itself; blooming's contribution is not overriding them to loosen. `maxTurns=8` per agent is defensive for a diagnostic loop that typically settles in 5 turns; loosening it to 12 or 15 would allow more exploration at the cost of higher upside spend. The tradeoff is context-dependent — for the current product, the tight cap works.

The compound receipt at $0.07 per investigation is the outcome of these four levers together. If any one were missing, the number would drift up: no cache = $0.15+ (double the input side), no iteration cap = variable up to whatever the model wanders into, no budget tracker = same variance without a ceiling, no pricing = unmeasurable.

## Interview defense

**Q: What cost controls does this system have, and what's the per-investigation cost?**
A: Four compound levers. Anthropic ephemeral cache on the system prompt (`aptkit-adapters.ts:87`) — five characters of code that give ~78% input-side savings after turn 1. AptKit iteration caps (`maxTurns=8`, `maxToolCalls=6` per agent) bound depth. `BudgetTracker` in `lib/agents/budget.ts` with check-before-dispatch in the adapter — hard USD ceiling, throws `BudgetExceededError` before the next API call if exceeded. `estimateAnthropicCost` in `lib/agents/pricing.ts` fills aptkit's OpenAI-only pricing gap so receipts have a cost column. Compound result: p50 per investigation is **~$0.070**, ~9246 tokens, verified in receipt `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`. Without the cache, it would be roughly double.

Diagram: the four levers stacked with compound effect labeled.
Anchor: `lib/agents/aptkit-adapters.ts:85-89` (cache) + `lib/agents/budget.ts:41-77` (tracker) + `lib/agents/pricing.ts` (helper).

**Q: Why is the BudgetTracker's cost estimate an "upper bound" when caching is on?**
A: The tracker sees `input_tokens` and `output_tokens` from the SDK response, but Anthropic's response splits input tokens into `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` — and aptkit's `model_usage` event shape (the surface Blooming consumes) only exposes total `inputTokens`, treating cache-read tokens as still "input" for accounting. That means the tracker's cost estimate uses the full input rate ($3/MTok Sonnet) for every input token, but real spend on cache reads is roughly $0.30/MTok. The tracker is *conservative* — it thinks we're spending more than we are, which means the USD ceiling triggers earlier than strictly necessary. That's the safer direction — you'd rather have a defensive ceiling that stops too early than one that stops too late.

Diagram: the two token buckets (real cache tiers vs the tracker's aggregate view) with the price gap.
Anchor: `lib/agents/pricing.ts:12-14` (the pricing note) + `lib/agents/aptkit-adapters.ts:103-110` (the accumulator).

## See also

- `01-context-engineering.md` — the schemaSummary bounding that keeps the cached prefix small.
- `04-agent-infrastructure/04-guardrails-and-control.md` — the BudgetTracker in context.
- `05-observability-hook.md` — how `onCapabilityEvent` feeds the cost aggregator.
- Cross-reference: `.aipe/study-ai-engineering/`'s single-call cost / cache / pricing files for the primitives.
