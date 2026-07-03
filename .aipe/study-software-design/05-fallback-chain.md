# Fallback chain — primary provider first, own helper second

Nullish-coalesce composition · Provider-override fallback · Language-agnostic

## Zoom out — where this concept lives

You know how a browser tries a font in `font-family`, and if it
can't find it, falls back to the next one, and finally to a
generic? Same shape. The eval report code calls aptkit's
`estimateCost('anthropic', ...)`, and when aptkit returns
`undefined` (because it only ships OpenAI pricing), the code
falls back to a Blooming-owned helper that fills the gap.

```
  Zoom out — where the fallback chain sits

  ┌─ Eval / budget code (caller) ────────────────────────┐
  │  const cost =                                         │
  │    estimateCost('anthropic', usage, model)  ??        │  ← primary
  │    estimateAnthropicCost(usage, model);               │  ← fallback
  └────────────────────────┬─────────────────────────────┘
                           │
      ┌────────────────────┴───────────────────┐
      ▼                                        ▼
  ┌─ aptkit ──────────────────┐    ┌─ lib/agents/pricing.ts ─────┐
  │  estimateCost(...)         │    │  estimateAnthropicCost(...)  │
  │  knows: OpenAI only        │    │  knows: Sonnet/Haiku/Opus    │
  │  returns undefined for     │    │  returns CostEstimate | undefined│
  │  anthropic today           │    │  (undefined for unknown model)│
  └────────────────────────────┘    └──────────────────────────────┘
```

The two functions return the same aptkit-shaped `CostEstimate`
type. The `??` between them lets whichever knows the model win,
with the third fallback being `undefined` when neither does.

## Structure pass

**Layers.** Two: the primary (aptkit's `estimateCost`) and the
fallback (Blooming's `estimateAnthropicCost`).

**Axis: source of truth.** Who owns the pricing table? Above the
`??`, the caller doesn't care. On the aptkit side, aptkit owns
the OpenAI pricing table. On the fallback side, Blooming owns
the Anthropic pricing table. The axis-answer flips at the `??` —
that's the seam.

**Seams.** The `??` operator itself. It's a one-character seam
that says: "try this first; if it's `undefined`, try that." The
whole chain works because both functions return the same
`CostEstimate | undefined` shape, so composition is free.

## How it works

### Move 1 — the mental model

The pattern is *primary + fallback composition* via nullish
coalescing. Three constraints keep it clean:

```
  Fallback chain — same return type, ?? threads them

     f1(args)  →  T | undefined       primary (aptkit)
                     │
                     │  ??
                     ▼
     f2(args)  →  T | undefined       fallback (blooming)
                     │
                     │  ??
                     ▼
                  T | undefined       final result
                  (undefined only if both returned undefined)
```

- **Same return type.** Both functions return `CostEstimate |
  undefined`. Not `CostEstimate | null`, not `CostEstimate |
  false`. Discipline matters — `??` distinguishes `undefined`
  and `null` from valid falsy values (`0`, `''`), so the type
  discipline is what makes the chain safe.
- **Same argument shape.** Both take `usage` and `model` in
  compatible types. If the fallback needed different args, you
  couldn't compose them with `??`.
- **Primary owns the domain it covers.** aptkit's function
  handles OpenAI models correctly; Blooming's fallback handles
  Anthropic models correctly. Neither one tries to cover the
  whole space.

Recognition test: if you can rewrite `A(...) ?? B(...)` as a
switch statement without gaining clarity, the fallback chain is
the right shape. Adding one more provider means adding one more
`?? C(...)` — no branch grows, no imports move.

### Move 2 — the walkthrough

**The primary — aptkit's helper.** OpenAI-only today.

```typescript
// node_modules/@aptkit/core/node_modules/@aptkit/runtime/dist/src/usage-ledger.d.ts:25
export declare function estimateCost(
  provider: string,
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>,
  modelName: string,
): CostEstimate | undefined;
```

Annotation: aptkit's function is provider-agnostic in its
signature (`provider: string`) but its implementation knows
only OpenAI. When called with `'anthropic'`, it doesn't throw —
it returns `undefined`. That's the door the fallback opens.

**The fallback — Blooming's helper.**

```typescript
// lib/agents/pricing.ts:40-61
export function estimateAnthropicCost(
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>,
  modelName: string,
): CostEstimate | undefined {
  const normalized = modelName.toLowerCase();
  for (const [pattern, pricing] of ANTHROPIC_PRICING) {
    if (pattern.test(normalized)) {
      const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion;
      const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
      return {
        currency: 'USD',
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
        estimated: true,
      };
    }
  }
  return undefined;                     // ← unknown model → fall through
}
```

Annotation:
- Line 41 — same input types as aptkit's function (both take
  `Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens'>`). This
  is what makes them composable — the caller can pass the same
  `usage` object to either.
- Line 43 — same return type as aptkit's function. Same
  `CostEstimate` shape. Callers can't tell which one succeeded.
- Line 45-56 — the Anthropic pricing table. Sonnet, Haiku, Opus
  as regex-matched families. When the model matches, return the
  aptkit-shaped `CostEstimate`.
- Line 60 — unknown model → `undefined`. This is the *third*
  fallback: neither aptkit nor Blooming knows this model, so the
  caller gets `undefined` and can decide (log, skip, or default
  to zero).

**The pricing table itself.**

```typescript
// lib/agents/pricing.ts:26-33
const ANTHROPIC_PRICING: readonly [RegExp, AnthropicPricing][] = [
  // Sonnet family (4 / 4.5 / 4.6) — $3 in, $15 out per MTok
  [/^claude-sonnet-4/, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }],
  // Haiku 4.5 — $1 in, $5 out per MTok
  [/^claude-haiku-4/, { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }],
  // Opus 4.7 — $15 in, $75 out per MTok (unused today; here for completeness)
  [/^claude-opus-4/, { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }],
];
```

Annotation: regex-family match, so `claude-sonnet-4-6`,
`claude-sonnet-4-5`, `claude-sonnet-4-7` all match the same row.
Adding a new family is one row; updating a price is one edit.

**The call site — same shape in three files.**

```typescript
// eval/run.eval.ts:216-220 (diagnosis branch)
// aptkit's estimateCost only knows OpenAI pricing; fall back to
// Blooming's Anthropic pricing helper for our claude-* models.
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

```typescript
// eval/run.eval.ts:272-274 (recommendation branch)
const recommendCost =
  estimateCost('anthropic', recommendUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(recommendUsage, 'claude-sonnet-4-6');
```

```typescript
// eval/load.eval.ts:298-303
const dCost =
  estimateCost('anthropic', dUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(dUsage, 'claude-sonnet-4-6');
const rCost =
  estimateCost('anthropic', rUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(rUsage, 'claude-sonnet-4-6');
```

Annotation: four call sites, identical shape. The comment at
`run.eval.ts:216-217` names *why* the fallback exists (the
audit's "why was this call the right one" trait — see teacher.md).
Anyone editing the pricing helper reads this comment and
understands the composition contract.

**The other consumer — `BudgetTracker.snapshot`.**

```typescript
// lib/agents/budget.ts:57-69
snapshot(): BudgetSnapshot {
  const est = estimateAnthropicCost(
    { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
    this.modelName,
  );
  return {
    inputTokens: this.inputTokens,
    outputTokens: this.outputTokens,
    totalTokens: this.inputTokens + this.outputTokens,
    turns: this.turns,
    estimatedCostUsd: est?.totalCost ?? 0,   // ← default to zero when both fall through
  };
}
```

Annotation:
- Line 58 — `BudgetTracker` skips the aptkit primary and calls
  the Anthropic helper directly. This is because the tracker is
  purpose-built for Anthropic models (the constructor default is
  `'claude-sonnet-4-6'`); there's no reason to consult the
  OpenAI-only primary. The composition primitive is the same;
  the tracker just doesn't need the first hop.
- Line 67 — `est?.totalCost ?? 0` — same `??` idiom to default
  the "no pricing found" case to zero. The tracker's ceiling
  check reads this — an unknown model would produce `0` and the
  ceiling would never trip. That's a deliberate safety-net choice:
  fail-open on unknown models rather than block investigation.

### Move 3 — the principle

**When a vendor's helper has a coverage gap, fill the gap in a
compatible-typed wrapper and compose with `??` at the call site.**
Not a subclass, not a monkeypatch. The vendor's function is
unchanged; your helper is standalone; the composition happens at
one line per call site. When the vendor eventually ships the
coverage (aptkit adds Anthropic pricing), your helper's return-
`undefined` path becomes dead code — but it's not a *breaking*
change, and the callers keep working. That graceful-degradation
property is worth the tiny extra call.

## Primary diagram

```
  Fallback chain — one line, three outcomes

  callers                       call site                       outcomes
  ───────                       ─────────                       ────────

  eval/run.eval.ts:219    ┌── estimateCost('anthropic', ...) ──┐
  eval/run.eval.ts:273    │                                    │
  eval/load.eval.ts:299   │        │                           │
  eval/load.eval.ts:302   │        ▼                           │
                          │   ┌───────────┐                    │
                          │   │  aptkit   │  ── returns ──►    │
                          │   │  knows    │  { totalCost, ...} │  → CostEstimate
                          │   │  OpenAI   │  ─────►────────────┘   (primary path)
                          │   └───────────┘
                          │        │
                          │   returns undefined
                          │   (anthropic model)
                          │        │
                          │        ▼
                          │      ?? ────────────►────────────┐
                          │                                  │
                          │   ┌───────────┐                  │
                          │   │  blooming │  ── returns ──►  │
                          │   │  knows    │  { totalCost, ...}│ → CostEstimate
                          │   │  Anthropic│  ─────►──────────┘   (fallback path)
                          │   └───────────┘
                          │        │
                          │   returns undefined
                          │   (unknown model — e.g. opus-6-9)
                          │        │
                          │        ▼
                          └──── undefined ─────────►────────────► undefined
                                                                  (both fell through;
                                                                   caller decides)
```

## Elaborate

The pattern goes by different names in different traditions. In
functional programming it's *Maybe/Option chaining* (`orElse` on
Java's `Optional`, `<|>` on Haskell's `Alternative`, `.or_else()`
on Rust's `Option`). In web-tooling contexts it's *provider
chain* or *middleware fallback*. What they all share: a value
that might not be present, threaded through a chain of "try
this next" functions until either something succeeds or
everything fails.

JavaScript's `??` (nullish coalescing, ES2020) is the syntactic
version. Before `??`, you wrote `let x = a(); if (x === undefined
|| x === null) x = b();` which is three lines and error-prone
(does `0` fall through? does `''`?). `??` distinguishes nullish
from falsy at the language level, so `0 ?? fallback` gives
`0`, not `fallback`. That distinction matters for cost math —
zero-dollar cost is a valid answer, `undefined` cost is a gap.

Where the pattern shows up elsewhere in this repo: the DataSource
unwrap helper (`lib/mcp/schema.ts` — `structuredContent` preferred
over `content[0].text`) is the same shape, one layer down. Try
the good source; if it isn't there, try the fallback source.

Where this repo pushes on the pattern: the same idiom appears
inside `BudgetTracker.snapshot` (`budget.ts:67`) as `est?.totalCost
?? 0` — a *terminal* fallback that defaults to zero rather than
`undefined`. That's a different design call than the eval code
makes. The eval code lets `undefined` propagate; the tracker
turns it into zero because the ceiling check has to work on a
number. Different callers, different fallback endpoints, same
composition primitive.

## Interview defense

**Q: Why not just extend aptkit's function?**
Two reasons. First, aptkit is a vendor dependency — patching it
means either a fork or a monkeypatch, both of which lose next
time you upgrade. Second, the coverage gap might close (aptkit
adds Anthropic pricing in a future release), and if that happens,
you want the fallback to become dead code silently, not fight
with the vendor. Composing at the call site keeps both possible.

**Q: What's the load-bearing part people forget?**
The `readonly [RegExp, AnthropicPricing][]` shape of the pricing
table (`pricing.ts:26`). It's iterated in order and returns on the
first match, so a broader regex before a narrower one would
shadow the narrower. Today the three families don't overlap, so
order doesn't matter — but adding `claude-sonnet-3` later without
noticing the ordering property could silently mis-price.

Second load-bearing part: `Pick<TokenUsageSummary, 'inputTokens'
| 'outputTokens'>`. Aptkit's `TokenUsageSummary` may grow more
fields (cache-read tokens, cache-creation tokens), and pinning
this function's input to just the two fields it uses insulates
it from the vendor's type drift. If aptkit adds a new required
field to `TokenUsageSummary`, this helper still compiles.

**Q: Why not a switch statement on model prefix?**
That would collapse both providers into one function and force
you to import aptkit's OpenAI table into Blooming's helper. The
`??` composition keeps them independent — aptkit owns OpenAI,
Blooming owns Anthropic, and neither has to know about the
other. Independent evolution is worth the extra function call.

**Q: What would you do differently?**
The `'claude-sonnet-4-6'` string literal appears at seven call
sites across `pricing.ts`, `budget.ts`, `run.eval.ts`,
`load.eval.ts`. That's information leakage (audit lens 3). Read
`AGENT_MODEL` from `lib/agents/base.ts` instead. The pricing
helper's *signature* stays the same (still takes a model name);
the *callers* stop hardcoding the name.

## See also

- `04-optional-hooks.md` — the same "additive composition without
  breaking existing paths" instinct applied to interface shape
  instead of return value.
- `.aipe/read-aposd/` — the book chapter on errors and special
  cases (the fallback chain is the "define errors out" version of
  "the vendor returned undefined").
