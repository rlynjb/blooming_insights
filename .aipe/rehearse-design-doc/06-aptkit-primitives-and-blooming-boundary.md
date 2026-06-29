# RFC 06 — AptKit primitives + Blooming adapter boundary

**One-line summary.** The agent tool-use loop migrated from a hand-rolled `runAgentLoop` (Phase 1) to `@aptkit/core@0.3.0` (Phase 4); three Blooming-side adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter` at `lib/agents/aptkit-adapters.ts`, 206 LOC) carry the boundary. AptKit owns the loop; Blooming owns the boundary. The hand-rolled version stays at `*-legacy.ts` files as the rollback receipt.

---

## Context

The agent loop — Claude messages + tool definitions + tool-use blocks + tool-result blocks + iteration budget + termination — was hand-rolled in Phase 1 as `runAgentLoop` (`lib/agents/base-legacy.ts`, 270 LOC). That was a deliberate choice at the time: writing the loop from scratch forced a clean understanding of what the loop actually was, gave the test suite something to drive directly, and avoided coupling to any third-party agent library that might pivot.

By Phase 4 the same pattern had grown to five agents (monitoring, diagnostic, recommendation, query, intent). Each agent was a thin wrapper around `runAgentLoop` with different prompts, different tool subsets, and the same control loop. Three things made owning the loop expensive:

- **Five agents x one shared loop = one bug fix x five places to verify.** A change to how `tool_result` blocks were assembled, or how iteration budget was enforced, meant re-checking five call sites that all looked nearly the same.
- **AptKit had landed at 0.3.0 with a stable shape.** It's a library extracted from the author's own work (npm `@rlynjb/aptkit-core`), aliased here as `@aptkit/core`. The loop primitive, the model provider seam, the tool registry seam, the trace sink seam — all defined, all tested. The shape was the same shape this repo had hand-rolled, by design.
- **The migration was evaluated, not impulsive.** Phase 1's hand-roll was deliberate (understand the loop). Phase 4's migration was equally deliberate (the understanding was banked; carrying the implementation no longer paid rent). The `*-legacy.ts` files are the receipt that the migration happened with both sides on the table.

---

## Decision

**`@aptkit/core@0.3.0` owns the loop. Blooming owns three adapter classes that bridge AptKit's neutral seams to this repo's concrete dependencies.**

```
  The boundary — AptKit owns the loop, Blooming owns the bridges

  ┌─ Blooming's product layer ───────────────────────────┐
  │                                                       │
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent / QueryAgent │
  │  (5 thin wrappers, each calling AptKit's runCapability)│
  │                                                       │
  └─────────────────────────┬─────────────────────────────┘
                            │  pass three adapters in:
                            ▼
  ┌─ The boundary: lib/agents/aptkit-adapters.ts (206 LOC) ─┐
  │                                                          │
  │  AnthropicModelProviderAdapter implements ModelProvider  │
  │    → wraps @anthropic-ai/sdk                            │
  │    → logs `res.usage` per call (lines 60, 65)           │
  │                                                          │
  │  BloomingToolRegistryAdapter implements ToolRegistry     │
  │    → wraps the DataSource port (RFC 05)                 │
  │                                                          │
  │  BloomingTraceSinkAdapter implements CapabilityTraceSink │
  │    → fans events out to existing route/eval hooks       │
  │      (onToolCall, onToolResult, onText)                  │
  │                                                          │
  └─────────────────────────┬─────────────────────────────────┘
                            │  AptKit reads only its own neutral
                            │  interfaces — never @anthropic-ai/sdk,
                            │  never lib/data-source, never AgentEvent
                            ▼
  ┌─ @aptkit/core@0.3.0 (the library, owns the loop) ────┐
  │                                                       │
  │  runCapability(provider, registry, sink, request)     │
  │    → the Claude+tools loop                            │
  │    → iteration budget, termination, tool dispatch     │
  │    → emits CapabilityEvent to the sink                │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

**Three adapters, three seams:**

1. **`AnthropicModelProviderAdapter`** translates AptKit's neutral `ModelRequest` into Anthropic's `MessageCreateParams`, calls the SDK, translates the response back into AptKit's `ModelResponse`. The Anthropic-specific shape (tool-use blocks, tool-result blocks, system prompts, the `signal` option) lives here. Logs `res.usage` per call — at lines 60 and 65 — so every Claude call appears in Vercel logs with input/output token counts.

2. **`BloomingToolRegistryAdapter`** wraps the `DataSource` port (RFC 05). AptKit asks "list tools" and "call this tool by name"; the registry delegates to `dataSource.callTool` and returns AptKit's expected envelope. The two ports compose cleanly because both were designed around the same `{ result, durationMs }` shape.

3. **`BloomingTraceSinkAdapter`** consumes AptKit's `CapabilityEvent` stream (the library's neutral trace) and translates each event into the Blooming-specific `onToolCall`/`onToolResult`/`onText` hooks. Those hooks then drive the NDJSON stream out to the UI (RFC 02). The translation includes a small state machine — pairing `tool_call_start` with `tool_call_end` so the UI sees a single `ToolCall` per call, not two events.

**Five agents, all thin.** Each agent (monitoring, diagnostic, recommendation, query) constructs the three adapters, builds a `CapabilityRequest`, calls `runCapability`, and returns the result. The agent's actual job — picking prompts, picking which tool subset to expose, post-processing the result — is what the agent file contains. The loop is borrowed.

---

## The legacy files are the rollback receipt

This is load-bearing. Every migrated file has a `*-legacy.ts` sibling:

```
  Rollback receipts — the hand-rolled implementation is one git mv away

  lib/agents/
    base.ts                    →  14 LOC, re-exports AptKit primitives
    base-legacy.ts             ←  270 LOC, the original runAgentLoop
    monitoring.ts              →  AptKit-driven
    monitoring-legacy.ts       ←  hand-rolled
    diagnostic.ts              →  AptKit-driven
    diagnostic-legacy.ts       ←  hand-rolled
    recommendation.ts          →  AptKit-driven
    recommendation-legacy.ts   ←  hand-rolled
    query.ts                   →  AptKit-driven
    query-legacy.ts            ←  hand-rolled
    intent.ts                  →  AptKit-driven
    intent-legacy.ts           ←  hand-rolled
    categories.ts              →  AptKit-driven
    categories-legacy.ts       ←  hand-rolled
    legacy-prompts/            ←  the original prompt files
    legacy-validate.ts         ←  the original validators
```

The legacy files aren't dead code — they're the proof that the migration was reversible, and they're a real reference when an AptKit upgrade introduces a behavior change. The current build doesn't import them; they exist for `git diff` and for a worst-case "AptKit 0.4 broke us, fall back to legacy" PR that would change imports in five files and ship.

---

## Alternatives considered

### Stay hand-rolled

Keep `runAgentLoop`. Don't migrate.

**Why it lost.** The hand-roll bought understanding (Phase 1's deliberate goal). That goal was banked — the author wrote, tested, and reasoned through the full loop. Continuing to maintain five wrappers around an in-house loop pays no further dividend on understanding; it just pays the maintenance cost forever. The migration was the *honest* move: the goal that justified the hand-roll completed.

### Use a different agent library (LangChain, LlamaIndex, AutoGen)

The big-name options.

**Why it lost.** Three issues:

1. **Shape mismatch.** LangChain's agent framework assumes its own message types, its own retrieval primitives, its own callback model. Migrating would have meant rewriting the agents around LangChain's *opinions*, not just borrowing its loop.
2. **Dependency weight.** Each of those libraries pulls in a large surface (and often a Python ecosystem assumption). The Blooming bundle and the Blooming runtime are TypeScript-first, edge-deploy-friendly. AptKit is small and provider-neutral by design.
3. **Author-owned library is honest.** `@aptkit/core` is published from the author's own work. Using it here closes the loop on "I extracted these primitives because I needed them in two projects." It's not a NIH; it's a deliberate factoring.

### Adopt AptKit at module level (no adapter classes)

Import AptKit's types directly into the agent files; use them as the types throughout.

**Why it lost.** That couples the agent files to AptKit's exact API shape forever. A new AptKit version that renames `runCapability` to `runCapabilityV2` would touch every agent. With the adapters carrying the boundary, the agents see Blooming's stable surface (`McpCaller`, `AgentEvent`, etc.) and the adapters absorb any AptKit-side change. Three adapter files vs five agent files is the right trade.

---

## Consequences

**What this cost — owned, not apologized for:**

- **AptKit is now a load-bearing dependency.** A bug in AptKit's loop becomes a bug in this product. Mitigated by (a) the legacy files as a rollback path and (b) the fact that AptKit is author-owned, so the author can patch it directly when needed. Not zero risk; not unmanaged.
- **The boundary itself costs 206 LOC.** Three adapter classes, type translation in both directions, a small state machine for tool-call pairing. Worth it because the boundary is what makes the loop replaceable, but it's not free.
- **Two ways to do anything for now.** Until the legacy files are deleted, a contributor could plausibly use either path. The convention is "current code uses the AptKit-driven version; legacy stays untouched." A future cleanup that deletes the legacy files would simplify the directory; today the receipt has more value than the cleanliness.
- **A library upgrade is a real event.** AptKit 0.4 would mean reading the changelog, possibly updating the adapter classes, re-running the 221-test suite. The migration discipline (legacy files, adapter boundary, test suite) makes that event manageable — but it doesn't make it zero-cost.

**What this bought:**

- **The loop got better than the hand-roll could justify.** AptKit's loop has iteration budgets, proper termination, tool-call/tool-result pairing, structured trace events — things the hand-roll *could* have grown, but at the cost of maintaining them alone. The library carries those features now.
- **Five thin agents instead of five thick ones.** Each agent file is now ~product logic + adapter wiring. The loop mechanics aren't in five places anymore. Behavior changes to the loop happen in AptKit; the agents inherit.
- **The boundary is where Blooming has all its leverage.** Want to add a per-call cost tracker? It goes in `AnthropicModelProviderAdapter`. Want to add a tool-call middleware? `BloomingToolRegistryAdapter`. Want to change what events ride the NDJSON stream? `BloomingTraceSinkAdapter`. Three small files; AptKit doesn't have to know.
- **The `res.usage` logging actually happens.** Lines 60 and 65 of `aptkit-adapters.ts` log every Claude call's input/output token counts to Vercel. That observability story is one of the wins the migration delivered: in the hand-roll it was implicit; in the adapter boundary it's enforced because every call goes through `complete()`.
- **The migration receipt is auditable.** The `*-legacy.ts` files plus git history form a complete record: here's the hand-roll, here's the adapter boundary, here's the AptKit version. A reviewer who asks "did you understand the loop before you migrated?" can read both implementations side by side.

---

## Open Questions

- **When do the legacy files get deleted?** Today they're the rollback receipt and a reference. The rule of thumb: delete when (a) two AptKit minor versions have passed without behavior regression, and (b) no PR has needed to consult the legacy for >3 months. Neither condition is met yet.
- **Should the adapter boundary expose AptKit's lower-level seams?** AptKit has finer-grained primitives (its own tool-call cancellation API, its own retry policy). Today the adapters use the high-level `runCapability` entry point. If the product needs the lower seams (e.g., per-tool retry policy), the adapter classes would grow; the agents wouldn't change.
- **Is `BloomingTraceSinkAdapter`'s pairing state machine the right place for it?** Today it tracks `tool_call_start` → `tool_call_end` pairs in a `Map<string, ToolCall[]>`. AptKit's events arrive in order, so the pairing is straightforward — but the state is per-adapter-instance, per-agent-run. A future feature that runs parallel tool calls within one agent would stress this; today no agent does that.
- **Does the boundary stay this shape if AptKit grows a "supervisor" primitive?** AptKit could plausibly add multi-agent coordination. If it did, the question is whether Blooming adopts it (giving up RFC 03's deterministic supervisor) or stays with route-code orchestration. Today's answer is "stay with route code" — but the question becomes live the moment AptKit ships that primitive.
