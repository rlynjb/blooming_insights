# Fault injection and graceful degradation

_Industry standard._

## Zoom out, then zoom in

Chaos engineering for the tool-call surface. `FaultInjectingDataSource` (`lib/data-source/fault-injecting.ts`) wraps any concrete DataSource and forces failures at configurable rates. The receipt from a recent load run — **9 injected faults across 3 investigations, 0 failed runs** — is the specific proof that AptKit's agent loop plus `is_error: true` tool results plus BudgetTracker together produce graceful degradation, not catastrophic collapse.

```
  Zoom out — the fault injector, wrapping any DataSource

  ┌─ FaultInjectingDataSource (decorator) ──────────────────────┐
  │  configurable rates:                                        │
  │    timeout, rate_limit, server_error, malformed_json        │
  │  seeded PRNG for reproducibility                             │
  │  onFault callback for tracking                              │
  └───────────────────────────┬─────────────────────────────────┘
                              │ wraps
                              ▼
  ┌─ BloomreachDataSource / SyntheticDataSource ────────────────┐
  │  the actual data source (untouched)                         │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the decorator pattern preserves the DataSource interface. The wrapped source doesn't know it's being faulted; every downstream (AptKit, BudgetTracker, retry ladder) sees exactly the fault shapes that show up in production against real Bloomreach.

## Structure pass

**Layers:** decorator (fault gate) → concrete DataSource (Bloomreach / Synthetic) → transport.
**Axis:** *does the failure look like what the model sees against real Bloomreach?*
**Seam:** the DataSource port. The decorator's whole design brief is "produce identical error shapes to real production failures," so downstream code doesn't need to distinguish injected vs real faults.

```
  Four fault kinds — one per real production failure

  Fault kind         Shape (mimics)              Downstream effect
  ─────────────────  ──────────────────────────  ─────────────────────
  timeout            "HTTP 0: timeout after 30s" retry ladder engages
  rate_limit         429 + retry-after hint      retry ladder engages
  server_error       HTTP 500                     retry ladder passes,
                                                  agent sees is_error
  malformed_json     ToolResult with garbled JSON type-guard rejects,
                                                  agent sees is_error
```

## How it works

### Move 1 — the mental model

You've hit refresh in Chrome DevTools with Network throttling on "Slow 3G" — deliberate degradation to see how your app handles it. The fault injector is that shape at the tool-call layer. Set a rate, run a load test, watch the agent's recovery paths execute against injected failures. The failures look identical to what production would emit.

```
  Pattern: decorator with configurable failure rates

  ┌─ Every callTool ───────────────────────────┐
  │  1. Roll random number                     │
  │  2. Check each fault threshold in order    │
  │     (timeout → rate_limit → 500 → malformed│
  │  3. First threshold hit fires that fault    │
  │  4. Otherwise pass through to real source  │
  └────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**The decorator — `lib/data-source/fault-injecting.ts:59-104`.**

```ts
// fault-injecting.ts:59-104 — the decorator
export class FaultInjectingDataSource implements DataSource {
  private callIndex = 0;
  private prngState: number;

  constructor(
    private readonly inner: DataSource,
    private readonly options: FaultInjectorOptions,
  ) {
    this.prngState = options.seed ?? 0;
  }

  async callTool(name, args, opts?) {
    this.callIndex += 1;

    const roll = this.random();
    const r = this.options.rates;

    let acc = 0;
    if (r.timeout != null && r.timeout > 0) {
      acc += r.timeout;
      if (roll < acc) return this.fireTimeout(name);
    }
    if (r.rateLimit != null && r.rateLimit > 0) {
      acc += r.rateLimit;
      if (roll < acc) return this.fireRateLimit(name);
    }
    // ... server_error, malformed_json ...

    return this.inner.callTool(name, args, opts);
  }
}
```

Line-by-line:

- **`implements DataSource`** — same interface as the wrapped source. Everything downstream is unchanged.
- **Independent per-error probabilities, checked in order.** Each fault has its own rate. First one whose cumulative threshold exceeds the roll wins. Higher-severity errors checked first so a heavy config still yields the more disruptive faults.
- **Seeded PRNG (xorshift32) when `seed` set.** Deterministic sequence — the same seed produces the same fault pattern across runs, so a regression test that catches a specific failure at seed=42 catches it every time.
- **`onFault` callback fires on every injection.** Load harness uses this to count faults per kind for the receipt.

**The fault shapes — `lib/data-source/fault-injecting.ts:112-155`.** Each fault produces an error that mimics real production:

- **`fireTimeout`** — throws `HTTP 0: timeout after 30000ms`. Shape mimics `lib/mcp/transport.ts:137` — same error string real transport timeouts produce.
- **`fireRateLimit`** — throws with `status=429` and text `Rate limited: please retry after 2000ms`. Triggers BloomreachDataSource's retry ladder.
- **`fireServerError`** — throws with `status=500`. No retry (retry ladder only handles 429), so the agent sees the failure directly.
- **`fireMalformedJson`** — RETURNS (doesn't throw) a ToolResult with garbled JSON in the text block. Non-throwing failure exercises the type-guard rejection path downstream.

The distinction between throw and return is deliberate: `malformedJson` is a "successful" HTTP response with bad content, exactly what a downstream JSON parse would reject. That's a different failure class from network faults, and the decorator tests both.

**The receipt — `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`.** From the actual run:

- **Config:** N=3, faultRates `timeout=0.2, malformedJson=0.2`, faultSeed=42.
- **`faultTotals`:** 5 malformed_json + 4 timeout = **9 faults injected across 3 investigations**.
- **Result:** 3 succeeded, 0 failed.
- **Cost:** total=$0.21, per-investigation p50=$0.070.

That's the load-bearing receipt: fault-injection at aggressive rates (40% total per-call fault probability) produces 9 real failures presented to the model, and every investigation still completed cleanly. The recovery paths work.

**How the agent recovers — `is_error: true` on tool results.** When the decorator throws (`fireTimeout`, `fireRateLimit`, `fireServerError`), the error propagates up through `BloomingToolRegistryAdapter.callTool` into AptKit's agent loop. AptKit catches it and presents the failure to the model as a `tool_result` with `is_error: true`. The model reads that as feedback ("your last query failed") and reasons around it in the next turn — usually by trying a different query or acknowledging the failure in the final answer.

The malformed-JSON case is subtler. The decorator returns a "successful" result with garbled content. AptKit doesn't know it's bad; it passes to the model. The model reads the garbled tool_result, sees it can't extract usable content, and reasons "that result was unusable, let me try another approach." Same outcome — the model degrades gracefully. The receipt shows this working under real fault rates.

```
  Layers-and-hops — one injected timeout, end to end

  ┌─ Load harness worker runs an investigation ────────────────┐
  └───────────────────────────┬────────────────────────────────┘
                              │
                              ▼
  ┌─ DiagnosticAgent (AptKit runAgentLoop) ────────────────────┐
  │  emits tool_use { name: "execute_analytics_eql", ... }     │
  └───────────────────────────┬────────────────────────────────┘
                              │ registry.callTool(name, args)
                              ▼
  ┌─ BloomingToolRegistryAdapter ──────────────────────────────┐
  │  dataSource.callTool(name, args, opts)                     │
  └───────────────────────────┬────────────────────────────────┘
                              │
                              ▼
  ┌─ FaultInjectingDataSource ─────────────────────────────────┐
  │  roll=0.15 < timeout=0.2 → fireTimeout(name)               │
  │  throws "HTTP 0: timeout after 30000ms"                    │
  └───────────────────────────┬────────────────────────────────┘
                              │ error propagates up
                              ▼
  ┌─ AptKit catches, presents to model ─────────────────────────┐
  │  tool_result { is_error: true, content: "HTTP 0: timeout"} │
  └───────────────────────────┬────────────────────────────────┘
                              │ next turn
                              ▼
  ┌─ Model reasons: "that query failed. Let me try a different  │
  │  framing" → emits new tool_use                              │
  └────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Graceful degradation isn't a feature you add — it's a property that emerges from three things working together: (a) errors are presented to the model as tool results with `is_error: true`, not thrown into the caller; (b) the model has enough context to reason around a failed tool call (which the compact schemaSummary provides); (c) hard ceilings (BudgetTracker, iteration caps) bound the recovery attempts so a bad path doesn't burn the budget indefinitely. Fault injection is how you *prove* the three work together in your specific system. The receipt is the artifact — "9 faults, 3 investigations, 0 failed" is much stronger than "we handle errors gracefully."

## Primary diagram

```
  Recap — the fault-injection tier and the receipt

  ┌─ FaultInjectingDataSource (decorator on any source) ────────┐
  │                                                             │
  │  configurable rates:  timeout, rate_limit, server_error,    │
  │                        malformed_json                       │
  │  seeded PRNG (xorshift32) for reproducibility               │
  │  onFault callback → tallied into receipt                    │
  │                                                             │
  │  throws for network faults → AptKit → is_error tool_result   │
  │  returns for malformed_json → type guard / model rejects     │
  └─────────────────────────────────────────────────────────────┘

  Recent receipt (2026-07-03T05-21-12-237Z):
  ┌─────────────────────────────────────────────────────────────┐
  │  N=3, faultRates = { timeout: 0.2, malformed_json: 0.2 }    │
  │  ─────────────────────────────                              │
  │  faults injected: 9 (5 malformed_json + 4 timeout)          │
  │  investigations completed: 3                                 │
  │  investigations failed: 0                                    │
  │  total cost: $0.21   |   p50 per investigation: $0.070      │
  └─────────────────────────────────────────────────────────────┘

  ★ 9 faults / 3 investigations / 0 failures ★
  ★ That's the receipt of graceful degradation. ★
```

## Elaborate

The fault-injection tier is Phase 4 defensive infrastructure. Phase 1 was the DataSource port itself (swap Bloomreach for Synthetic). Phase 2 was the observability hook. Phase 3 was BudgetTracker. Phase 4 is the fault decorator plus the receipt. Together they cover the "will this survive production?" question: swap sources, capture telemetry, bound cost, inject faults.

The seam has already survived two adapter swaps (Olist added, Olist removed, Synthetic added) with zero caller-surface change. Adding the fault decorator was a third proof — offline decoration rather than a swap, but structurally identical. If the seam had leaked (say Bloomreach-specific fields exposed on the port), the fault decorator would have to know about them; it doesn't.

Why the decorator RETURNS for malformed_json instead of throwing: production `structuredContent` failures don't throw. They return a response with unexpected shape. The type guard downstream (`isDiagnosis`, `isRecommendationArray`) rejects them at the artifact layer, and the model's reasoning catches them within a turn ("that result was garbled"). Testing this path means the decorator must return a broken shape, not throw. Throwing would exercise a different recovery path (the catch block in the agent adapter), not the type-guard rejection.

The receipt's specific numbers matter for interview grade: "we handle errors gracefully" is vague. "N=3, 9 injected faults across 3 investigations, 0 failed runs, $0.21 total, seeded PRNG for reproducibility" is a receipt. The difference is whether the interviewer can verify the claim — the seeded PRNG means the exact fault sequence can be replayed.

## Interview defense

**Q: How do you prove this system degrades gracefully under real production failures?**
A: `FaultInjectingDataSource` — a decorator on the DataSource port that injects timeouts, 429s, 500s, and malformed JSON at configurable rates with a seeded PRNG. Each fault shape mimics a real production failure — the timeout throws `HTTP 0: timeout after 30000ms` matching the transport layer, the rate_limit fires a 429 with a retry-after hint matching Bloomreach's shape, malformed_json returns a "successful" result with garbled JSON that exercises the type-guard rejection path. The receipt: at N=3 investigations with 20% timeout + 20% malformed_json fault rates, we get 9 injected faults across 3 investigations, 0 failed runs, $0.21 total spend. The graceful path works because AptKit's agent loop catches thrown errors and presents them to the model as `tool_result` with `is_error: true` — the model reads that as feedback and reasons around it in the next turn.

Diagram: the fault propagation path from decorator through AptKit to the model's next-turn reasoning.
Anchor: `lib/data-source/fault-injecting.ts` (the decorator) + `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json` (the receipt).

**Q: Why does the malformed_json fault return instead of throw?**
A: Production malformed responses don't throw — they're a "successful" HTTP 200 with a garbled body. The failure is at the *content* layer, not the transport layer. Throwing would exercise the wrong recovery path — it'd hit the agent's adapter catch block instead of the type-guard rejection. By returning a `ToolResult` with garbled `content`, the decorator makes the failure look like real Bloomreach when its `structuredContent` envelope goes wrong. The type guards in `lib/mcp/validate.ts` (or AptKit's downstream shape parsing) reject; the model sees the unusable result and reasons "let me try a different query." That's the specific graceful-degradation path we want to exercise, and it's different from the network-fault path.

Diagram: the two failure classes — throws (network faults) and returns (content faults) — and their different recovery paths.
Anchor: `lib/data-source/fault-injecting.ts:139-155` (fireMalformedJson).

## See also

- `02-fan-out-backpressure.md` — the load harness that runs against the fault decorator.
- `04-cost-controls.md` — the BudgetTracker that bounds recovery attempts.
- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the failure ⇄ mitigation table.
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the DataSource port the decorator wraps.
