# RFC-006: AptKit primitives at the runtime, Blooming-owned adapters at the boundary

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** The per-stage ReAct loop — the loop that drives one Claude call, parses `tool_use` blocks, runs them through a tool registry, feeds results back, and stops on natural-end or budget — moved out of Blooming-owned code (`lib/agents/base.ts:runAgentLoop`, now preserved at `lib/agents/base-legacy.ts:86-176` as the legacy path) into `@aptkit/core@^0.3.0`'s runtime. Each of the four active agents (`monitoring`, `diagnostic`, `recommendation`, `query`) is now a thin wrapper that constructs an AptKit agent and wires three Blooming-owned adapter classes (`lib/agents/aptkit-adapters.ts`, 206 LOC) at its boundary: `AnthropicModelProviderAdapter` (Anthropic SDK → AptKit's `ModelProvider` port), `BloomingToolRegistryAdapter` (`DataSource` → AptKit's `ToolRegistry` port), `BloomingTraceSinkAdapter` (AptKit's `CapabilityEvent` → Blooming's NDJSON hook surface). The library owns the loop; Blooming owns every boundary the loop touches.

---

## Context

`runAgentLoop` had been Blooming-owned from day one. It was 90-ish lines of `while (turn < maxTurns)` plus a forced-synthesis turn plus tool-result truncation plus per-turn cancellation checks. It worked. The four agents shared it.

Two pressures forced the question:

1. **The loop wasn't load-bearing intellectual property.** Every Claude agent harness ships a near-identical version: turn loop, parse `tool_use`, dispatch, append result, repeat until no tool calls or budget hit. The differences (forced-synthesis turn, max-tool-call budget, per-turn cancel checks) are configuration, not algorithm. Owning 90 lines of generic loop is paying maintenance for vocabulary every loop has.

2. **AptKit (`@aptkit/core`) was being built as the generic primitive layer for exactly this.** Named primitives: `ModelProvider` (anything that can `complete(request) → response` — Anthropic, OpenAI, a fake), `ToolRegistry` (anything that can list and call tools — MCP, in-process, anything), `CapabilityTraceSink` (anything that can consume the loop's emitted events — logs, NDJSON, OpenTelemetry). Per-agent classes (`AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, `RecommendationAgent`) compose those primitives.

The choice was: stay hand-rolled forever, or move the loop to AptKit while keeping every Blooming-owned concern (which Anthropic client we use, which tools we expose, how trace events get to the UI) on our side. We chose the second.

The legacy path stays in source. `lib/agents/base-legacy.ts` (the runAgentLoop), `lib/agents/{monitoring,diagnostic,recommendation,query,intent}-legacy.ts`, `lib/agents/categories-legacy.ts`, `lib/agents/legacy-validate.ts`. The reason: a major loop swap with no rollback is a major loop swap with no rollback. Keeping the legacy in source means we can A/B against it (or revert to it) until the AptKit-backed path is unambiguously battle-tested. The route handlers point at the AptKit-backed classes (`lib/agents/monitoring.ts`, not `monitoring-legacy.ts`). Both paths satisfy the same supervisor contract (RFC-003) and read from the same DataSource seam (RFC-005).

Implementation: `lib/agents/aptkit-adapters.ts:1-206` (the three bridge classes), `lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts` (the active wrappers), `lib/agents/base.ts:1-14` (the trimmed module — just `AGENT_MODEL` and the `McpCaller` re-export from the DataSource seam), `lib/agents/base-legacy.ts:86-176` (the preserved hand-rolled loop), `package.json:14` (`"@aptkit/core": "npm:@rlynjb/aptkit-core@^0.3.0"`).

---

## Goals

- The per-stage loop ships as a library primitive, not our code. Maintenance of "the canonical Claude ReAct loop" stops being our burden.
- The library does not see any Blooming-specific shape. Our Anthropic client, our DataSource, our NDJSON hook surface stay behind adapters we own.
- The supervisor's `if`-ladder (RFC-003) and the DataSource seam (RFC-005) do not move. The migration is *underneath* both.
- The hand-rolled loop stays callable from source, so we can A/B and revert without git archaeology.
- Tests stay no-network: a `Pick<DataSource, 'callTool'>` fake + a fake `ModelProvider` satisfy both paths.

## Non-goals

- Adopting AptKit's framework conventions for orchestration or persistence. We're consuming the *primitives* (ModelProvider, ToolRegistry, CapabilityTraceSink, the per-agent classes); we are not adopting any AptKit pattern that would touch the supervisor or the route layer.
- Vendoring AptKit's source into our repo. The dependency is real (`@aptkit/core`); the boundary is our adapter layer.
- Removing the legacy path. The `-legacy.ts` siblings stay as the receipts the swap was a substitution.
- Migrating intent classification onto AptKit. Intent is one tool-less Haiku call (`lib/agents/intent.ts`); wrapping it in AptKit's agent shape would be overkill. The `-legacy.ts` version stays for parity but the active one is a simple Anthropic call.

---

## The decision

```
  ┌─ Route layer (app/api/agent/route.ts, briefing/route.ts) ──────────┐
  │                                                                    │
  │  const dataSource = dsResult.dataSource;                          │
  │  const diagAgent = new DiagnosticAgent(                            │
  │    anthropic, dataSource, schema, allTools, sessionId);            │
  │  const diagnosis = await diagAgent.investigate(anomaly, hooks);    │
  └─────────────────────────────┬──────────────────────────────────────┘
                                │
  ┌─ Blooming wrapper (lib/agents/diagnostic.ts) ─────────────────────┐
  │  class DiagnosticAgent {                                          │
  │    investigate(anomaly, hooks) {                                  │
  │      const agent = new AptKitDiagnosticInvestigationAgent({       │
  │        model: new AnthropicModelProviderAdapter(...),             │
  │        tools: new BloomingToolRegistryAdapter(dataSource, allTools),│
  │        workspace: schema,                                         │
  │        trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),  │
  │      });                                                          │
  │      return toBloomingDiagnosis(await agent.investigate(anomaly));│
  │    }                                                              │
  │  }                                                                │
  └────────────┬──────────────────┬──────────────────┬────────────────┘
               │                  │                  │
   ┌───────────▼──────────┐ ┌─────▼────────────┐ ┌───▼──────────────┐
   │ AnthropicModel       │ │ BloomingTool     │ │ BloomingTrace    │
   │ ProviderAdapter      │ │ RegistryAdapter  │ │ SinkAdapter      │
   │                      │ │                  │ │                  │
   │ Anthropic SDK →      │ │ DataSource →     │ │ CapabilityEvent  │
   │ ModelProvider port   │ │ ToolRegistry port│ │ → NDJSON hooks   │
   │ (complete(req)→resp) │ │ (call/listTools) │ │ (onText/         │
   │                      │ │                  │ │  onToolCall/...) │
   └──────────┬───────────┘ └────────┬─────────┘ └────────┬─────────┘
              │                      │                    │
   ┌──────────▼──────────────────────▼────────────────────▼─────────┐
   │ @aptkit/core (the runtime)                                     │
   │                                                                │
   │ AptKitDiagnosticInvestigationAgent.investigate(anomaly):       │
   │   while (turn < maxTurns) {                                    │
   │     resp = model.complete(req)        ← OUR adapter            │
   │     if (no tool_use) break            ← natural stop           │
   │     for (tool_use): tools.callTool(…) ← OUR adapter            │
   │     trace.emit(event)                 ← OUR adapter            │
   │     if (budget spent) force-synthesis-turn                     │
   │   }                                                            │
   └────────────────────────────────────────────────────────────────┘
```

The pattern: **library owns the loop, Blooming owns the boundary.** Three primitives, three adapters, one wrapper per agent. The wrapper is ~50 lines; the adapter file is ~200 lines total for all three; the loop body — historically ~90 lines in `runAgentLoop` — is now zero of our lines.

Three load-bearing details:

1. **The adapters are *ports*, not framework hooks.** AptKit defines `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink` as TypeScript interfaces with method signatures. Our adapters implement those signatures by wrapping Blooming-owned objects (the Anthropic SDK, the DataSource, the NDJSON hook surface). There is no `@aptkit.hook` decorator, no AptKit-aware lifecycle, no AptKit configuration leak into our objects. The boundary is one direction: Blooming knows about AptKit's interfaces; AptKit does not know about Blooming.

2. **Per-agent classes ship with the library.** AptKit exports `AnomalyMonitoringAgent`, `DiagnosticInvestigationAgent`, `RecommendationAgent` — the per-stage logic (prompts, max-tool-call budgets, synthesis instructions, output schemas) lives in the library. Our four wrapper classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) construct the AptKit agent, pass the three adapters, and translate the AptKit return type into Blooming's domain shape (e.g. `toBloomingDiagnosis`, `toBloomingAnomaly`). The translation is structural — same fields, modest renames — because we deliberately seeded AptKit's types from Blooming's types.

3. **The legacy path is preserved end-to-end, not just the loop.** `base-legacy.ts` is the loop. But the siblings (`monitoring-legacy.ts`, `diagnostic-legacy.ts`, `recommendation-legacy.ts`, `query-legacy.ts`, `intent-legacy.ts`, `categories-legacy.ts`, `legacy-validate.ts`) preserve the *full* old call graph. Reverting any agent to the legacy path is one import swap in the route handler. We can run both paths against the same DataSource and the same supervisor in parallel.

---

## Alternatives considered

### Alternative A: Keep `runAgentLoop` forever — never depend on a third-party agent runtime

The do-nothing answer. The loop works. The legacy is the active path. Skip the dependency.

**Why it lost:**

- The loop genuinely is generic. Every iteration we make to it (a forced-synthesis improvement, a per-turn cancellation hook, a new model provider) is iteration on something the rest of the agent ecosystem also has to solve. Maintaining our own version means doing that work twice (once for us, once for the library we eventually adopt or write).
- The loop's bugs were silent. The legacy `runAgentLoop` had no tests at the level of "given a model that emits these tool_use blocks, does the loop terminate correctly?" — every test was at the agent level (DiagnosticAgent does its thing). AptKit's primitives ship with that test layer; we inherit it.
- The "we'll never need to swap loop semantics" framing didn't hold. The Phase 3 eval flywheel surfaced two cases where the loop's behavior (when forced synthesis fires, how it interacts with empty tool-use blocks) mattered. With a library, those become library bugs to push upstream; without one, they become our bugs to chase.

The honest version: do-nothing is the cheapest option *for the next month*. It loses the day we want a new model provider (Bedrock, Vertex), a new framing (OpenAI's `function-calling` over Anthropic's `tool_use`), or anything else the agent runtime ecosystem has been working on. AptKit lets us inherit that work; runAgentLoop doesn't.

### Alternative B: Vendor AptKit directly into our routes — no adapter layer

The "skip the abstraction" answer. Import `AnomalyMonitoringAgent` straight into `app/api/briefing/route.ts`, pass our Anthropic client directly, pass our DataSource directly.

**Why it lost:**

- AptKit's `ModelProvider` interface expects a `complete(request) → response` shape. Our Anthropic client is `anthropic.messages.create(params, options)`. The two are close but not identical (parameter naming, optional-fields handling, the `model` field's default semantics). Without an adapter, the route handlers either bend our Anthropic usage to AptKit's shape (every call site changes) or we leak AptKit's types into places they don't belong.
- AptKit's `ToolRegistry.callTool` returns `{result, durationMs}`. Our `DataSource.callTool` returns `{result, durationMs, fromCache}`. The `fromCache` field flows into the UI's tool-call trace and into observability logs. An inline adapter at the call site drops it; a typed adapter (`BloomingToolRegistryAdapter`) preserves it explicitly by forwarding `result` and `durationMs` and discarding `fromCache` from AptKit's view (we still log it on the Blooming side).
- AptKit's `CapabilityEvent` union has different field names than our NDJSON hook surface (`event.toolName` vs our `tc.toolName`, `event.timestamp` vs our `Date.now()` per call). An inline mapping at every call site drifts. One adapter class makes the mapping reviewable.
- The day AptKit ships a breaking change to any of its three primitives, an adapter layer is one file to update. Without it, every route and every agent class has to be touched.

The general principle: when adopting a library at a load-bearing boundary, the adapter is *cheap insurance* against the library's churn and your domain's drift. The cost is ~200 LOC; the savings is "library upgrade is mechanical."

### Alternative C: Use AptKit's higher-level orchestration (its agent-composition / pipeline primitives)

AptKit ships more than just the per-stage runtime — it has compositional pipelines and (future) multi-agent orchestration. The "go all-in" answer.

**Why it lost:**

- RFC-003 is the supervisor. It's six lines of `if`. AptKit's pipelines would replace that with a graph-shaped abstraction that doesn't pay for itself at three stages. Adopting them would be exchanging code we read in one minute for code that requires learning the library's pipeline DSL.
- AptKit's orchestration primitives haven't earned their place against our concrete needs. The `if`-ladder is testable, debuggable, and one-engineer-comprehensible. AptKit's pipelines may earn their place the day we have 8 stages or adaptive routing; today they don't.
- This RFC is about the *runtime primitives* (the loop, the model provider, the tool registry, the trace sink). The compositional layer is a separate question — and one we've already answered (in code) by keeping the supervisor as `if`s.

### Alternative D: Adopt LangChain / LangGraph instead

The other major agent-framework ecosystem.

**Why it lost:**

- LangGraph specifically is what RFC-003 rejected. The graph-shaped abstraction over what is, for us, three sequential stages in a known order doesn't earn its weight. RFC-003's framework-rejection logic still holds.
- LangChain is heavier — pulls in chain-builders, retrievers, document loaders, callback managers, the whole framework convention. AptKit's primitives are tight: ModelProvider, ToolRegistry, CapabilityTraceSink. The narrower surface is what we want at a boundary we're inheriting.
- Vendor lock at a different boundary. LangChain's ergonomics for "build your own agent" still encourage you to use their compositional primitives; the moment you don't, you're fighting the framework. AptKit's per-agent classes are agent-class-shaped (one method per stage's job — `agent.investigate(anomaly)`, `agent.scan()`, `agent.propose(diagnosis)`) which match Blooming's call sites exactly.

### Alternative E: Build our own ModelProvider / ToolRegistry / TraceSink primitives in Blooming

The "we'll own the boundary AND the primitives" answer. Define the three interfaces ourselves; implement a loop against them; never depend on AptKit.

**Why it lost:**

- This is the do-nothing answer reframed: we'd be writing the library AptKit already wrote. Same maintenance, no leverage.
- The interfaces we'd define would be almost identical to AptKit's (the shape of "a model provider" or "a tool registry" is not a place where two engineers diverge interestingly). Inventing a parallel vocabulary is a tax on every future contributor who already knows the AptKit one.
- The argument for owning the primitives is "what if AptKit goes away?" But the adapter layer is the answer — if AptKit goes away, we keep the adapters, swap the import, write 200 lines of "fake AptKit" in-house, done. We have the runAgentLoop legacy as the fallback if even that fails. The owning-the-primitives layer doesn't add insurance the adapter layer doesn't already provide.

```
  Alternatives matrix

  option                          loop-ownership  boundary-control  upgrade-cost  chosen?
  ──────────────────────────────  ──────────────  ────────────────  ────────────  ───────
  AptKit primitives + adapters    library          ours              mechanical    ★
  keep runAgentLoop forever       ours             ours              none          no (locks out
                                                                                    ecosystem leverage)
  vendor AptKit directly           library          leaks AptKit shape every-route  no (high coupling)
                                                   into routes        every change
  AptKit higher-level pipelines    library          partial (we'd     library-shape no (loses RFC-003's
                                                   rewrite supervisor) churn         deterministic supervisor)
  LangChain / LangGraph            framework        framework-shaped  high          no (RFC-003 rejected)
  build our own primitives         ours             ours              ours alone    no (re-inventing
                                                                                    AptKit)
```

---

## Tradeoffs accepted

We chose AptKit + adapters, accepting:

1. **A real dependency.** `@aptkit/core@^0.3.0` is a third-party (Blooming-owner-published) library; its upgrades land on our maintenance budget. *We accept this — version pinning + the legacy path + the adapter layer all bound the cost. Breaking changes hit one file (`aptkit-adapters.ts`); behavioral regressions are A/B-able against the legacy.*

2. **The legacy path is dead weight in source.** ~900 LOC of `-legacy.ts` files that the route handlers don't import today. *We accept this for the safety net — the day we delete them is the day we've shipped on the AptKit-backed path for a full release cycle plus the eval flywheel revival (whichever comes first). Today the receipt is the receipt.*

3. **Two paths to keep mentally consistent.** Engineers reading `lib/agents/` see both `monitoring.ts` and `monitoring-legacy.ts`. The `-legacy` suffix is the contract. *We accept this — the convention is grep-visible; the route handlers are the source of truth for which path is active.*

4. **AptKit owns the per-agent prompts.** The diagnostic prompt, the monitoring prompt, the recommendation prompt — those moved into `@aptkit/core` as part of the per-agent classes. Tuning a prompt means publishing a new AptKit version (or, in practice, editing the AptKit source locally since the package is owner-published). *We accept this — the prompts were maintained in `lib/agents/prompts/` in the legacy path; reading them now requires opening the AptKit source. The `-legacy.ts` siblings still have the embedded prompts for reference.*

5. **The Blooming-owned `Anomaly` / `Diagnosis` / `Recommendation` types are structurally identical to AptKit's `MonitoringAnomaly` / `DiagnosticDiagnosis` / `RecommendationAction`.** The translation functions (`toBloomingAnomaly`, `toBloomingDiagnosis`) are nearly identity functions today. *We accept this — keeping the translation explicit means the day the types drift (AptKit adds a field; Blooming wants a different shape), the translation has a place to live.*

6. **AptKit's `CapabilityEvent` discriminated union is wider than Blooming's NDJSON `AgentEvent`.** The `BloomingTraceSinkAdapter` filters AptKit's events down to the four Blooming cares about (`step` → `onText`, `tool_call_start` → `onToolCall`, `tool_call_end` → `onToolResult`, anything else dropped). *We accept this — the filter is the contract; new AptKit event types don't leak into the NDJSON wire format unless we explicitly bridge them.*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| AptKit ships a breaking change to `ModelProvider` / `ToolRegistry` / `CapabilityTraceSink` | Medium | The adapter layer absorbs it in one file (`lib/agents/aptkit-adapters.ts`). The four agent wrappers don't change. Version is pinned (`^0.3.0`); breaking changes require a deliberate bump. |
| AptKit's loop behavior diverges from `runAgentLoop` in a way that changes agent outputs (different stopping condition, different forced-synthesis logic) | Medium | The legacy path is preserved end-to-end. A/B testable: import `MonitoringAgent` from `monitoring.ts` (AptKit) vs `monitoring-legacy.ts` (runAgentLoop) and run both against the same DataSource. The Phase 3 eval flywheel exists in git history as the harness for this kind of comparison if we need it back. |
| The Blooming-owned `Anomaly` / `Diagnosis` / `Recommendation` types drift from AptKit's, breaking the (today near-identity) translation functions | Medium | `toBloomingAnomaly` / `toBloomingDiagnosis` / `toBloomingRecommendation` are the only translation site. TypeScript catches missing fields; structural compatibility is checked at compile time. |
| AptKit's `CapabilityEvent` adds a new variant we silently drop | Low | `BloomingTraceSinkAdapter.emit` has an explicit switch on `event.type`. Unknown variants are no-ops (intentional). When AptKit ships a variant we *do* want to surface, the bridge gains a case. |
| The four `-legacy.ts` files bit-rot from disuse | Low today | They're in source; the test suite imports them where the legacy semantics matter. If they bit-rot, the test suite breaks. Today they pass. |
| AptKit's per-agent prompt is wrong for our backend (it expects MCP tools shaped one way, Bloomreach exposes them another way) | Medium | The prompts were seeded from Blooming's prompts during AptKit's authoring (the package is owner-published). The eval flywheel surfaced the small remaining divergences; what's left is monitored by Blooming's existing route-integration tests. Future drift is grep-visible because AptKit is npm-installed and its source is in `node_modules/@aptkit/core/`. |
| Confusion between "the active agent class" (`monitoring.ts`) and "the legacy one" (`monitoring-legacy.ts`) | Low | The `-legacy` suffix is the convention; the route handlers import the unsuffixed file. A grep for "from '@/lib/agents/monitoring-legacy'" in app/ returns nothing. |

---

## Rollout / migration

The migration was incremental. AptKit's primitives stabilized at `@aptkit/core@0.3.0`; the adapter file landed at `lib/agents/aptkit-adapters.ts`; the four agent wrappers were rewritten one at a time (`monitoring.ts`, then `diagnostic.ts`, then `recommendation.ts`, then `query.ts`); each rewrite was test-gated against the existing route-integration tests; the legacy files were renamed with the `-legacy.ts` suffix in the same change as the rewrite.

Two things did NOT move during the migration:

1. **The supervisor (RFC-003).** The `if`-ladder in `app/api/agent/route.ts:228-230` stayed exactly the same. AptKit's per-agent classes have the same shape (`agent.investigate(anomaly)`, `agent.scan()`, `agent.propose(diagnosis)`) as the Blooming wrappers, so the supervisor doesn't see the swap.

2. **The DataSource seam (RFC-005).** The route handlers still construct `dataSource` via `makeDataSource(mode, sessionId)`. The new `BloomingToolRegistryAdapter` consumes `dataSource.callTool` and exposes it as `ToolRegistry.callTool` — the seam stays at the route → adapter boundary, not at the agent → loop boundary.

**The rollback path** if AptKit causes a real production regression: change the imports in the route handlers from `@/lib/agents/diagnostic` to `@/lib/agents/diagnostic-legacy` (and the same for the other three). One-line change per agent. The `-legacy.ts` files are wired to the same DataSource, the same supervisor, the same tools — they were before the migration and they still are.

**The deletion path** for the legacy files: once the AptKit-backed path has shipped through a real release cycle with no rollback events, and once we've decided the legacy path's value as a comparison harness is below the maintenance cost, delete the `-legacy.ts` siblings in one PR. Not yet.

---

## Open questions

1. **When do we delete the legacy path?** Today: kept. Trigger: the AptKit-backed path has run in production for long enough that "fall back to legacy" stops being a useful escape valve, AND we don't need the side-by-side for an eval harness. No date.

2. **Does the AptKit-backed path want its own per-stage telemetry layer?** The legacy `runAgentLoop` logged `{site: 'agents/base:runAgentLoop', sessionId, usage}` once per turn (`lib/agents/base-legacy.ts:135`). The AptKit adapter logs the same shape (`lib/agents/aptkit-adapters.ts:57-61`). What's missing on both paths is per-stage phase-timing on the 300s budget; today that's tracked at the route level. Open whether the per-stage timing should ride through AptKit's trace sink instead.

3. **Should `BloomingToolRegistryAdapter` re-list tools per call instead of holding a session snapshot?** Today `allTools` is fetched once at session start and held in the adapter (`lib/agents/aptkit-adapters.ts:75-87`). For Bloomreach this is fine (the tool list is stable across a session); for Synthetic it's fine (the tool list is static). The day an adapter exposes dynamic tools (e.g., per-customer custom tools loaded mid-session), the adapter rebuilds per call. Not today.

4. **The intent classifier is the one un-migrated agent.** `lib/agents/intent.ts` is a single tool-less Anthropic call to Haiku — it doesn't fit the AptKit per-agent class shape because it has no loop, no tools, no synthesis turn. The `-legacy.ts` sibling exists for parity but the active version is a direct Anthropic call. Whether to wrap it in an AptKit primitive (the simplest version: a "completion-only" provider call) is open. Low priority — it's 38 lines and works.

5. **What happens if AptKit's per-agent prompts diverge from what our evals validated?** The Phase 3 eval flywheel was calibrated on the runAgentLoop path. The current AptKit path was hand-spot-checked, not re-evaluated end-to-end against the same rubric. The eval substrate is retired; the spot-check confidence is enough for the demo path but not for "we shipped the same quality bar." Reviving the eval is a separate decision (and was deferred at PR #8 when Olist + eval went together).

---

## What a reviewer will push on (and the framing that holds)

> "Why depend on an external library for a 90-line loop you already had working?"

The loop is generic. Every Claude agent in the ecosystem ships one. Owning ours forever means iterating on it forever; using AptKit's means inheriting fixes, model-provider extensions, and improvements that the broader agent ecosystem is already paying to solve. The cost of the dependency is `@aptkit/core@^0.3.0` in `package.json`; the savings is "we don't own a loop maintenance treadmill." And the legacy path stays in source as the rollback receipt.

> "Three adapter classes is a lot of indirection for what's essentially 'pass our objects to AptKit.'"

The adapters are the boundary that makes the dependency reversible. Each one absorbs a difference: `AnthropicModelProviderAdapter` translates between the Anthropic SDK's call shape and AptKit's `ModelProvider` port; `BloomingToolRegistryAdapter` bridges `DataSource.callTool` to `ToolRegistry.callTool` (preserving `fromCache` on our side); `BloomingTraceSinkAdapter` filters AptKit's `CapabilityEvent` union into our four-event NDJSON surface. Skip the adapters and you've coupled the route handlers, the agent classes, and the DataSource seam to AptKit's shape — at which point library upgrades become source-wide refactors.

> "Why keep the legacy files? That's dead code."

It's an A/B harness disguised as an import switch. Until the AptKit-backed path is unambiguously battle-tested, the legacy is one route-handler import-line change away from being the active path. The cost is ~900 LOC sitting in `lib/agents/`. The cost of not having it would be a real production regression with no quick fallback.

> "Couldn't AptKit just expose what runAgentLoop exposes, and you skip the adapters?"

AptKit's API IS shaped almost identically to what `runAgentLoop` exposed — that's not the boundary the adapters protect. The boundary is between AptKit's *types* (their `ModelProvider`, their `ToolRegistry`, their `CapabilityEvent` union) and the rest of Blooming's code (the Anthropic SDK call shape, the DataSource seam, the NDJSON hook surface). Skipping the adapters means leaking AptKit's types into route handlers and the DataSource layer — places they don't belong.

> "The synthetic adapter and the DataSource seam (RFC-005) are doing the same thing this RFC describes. Why two separate decisions?"

Different boundaries. RFC-005 is "what backend produces tool results." RFC-006 is "what runtime drives the agent loop that calls the tools." `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`) is the *seam-on-seam* — it forwards `tools.callTool` into `dataSource.callTool`. If you collapsed the two RFCs, you'd be saying "the loop's tool source IS the backend" — which is true today but the moment you have a tool the loop runs that isn't a backend call (a local computation, a prompt template fetch), the merged abstraction breaks down.

> "You're 5 active agents (monitoring, diagnostic, recommendation, query, intent) with 5 legacy siblings — that's a lot of code for one product."

Four wrappers + the adapter file = ~550 LOC active. The legacy siblings preserve the old call graph end-to-end, which is what makes the migration reversible. Comparing total lines to the *runAgentLoop legacy alone (~270 LOC)* is the wrong frame; comparing them to "the work we'd be paying to keep doing forever" is the right one. The active path delegates 90% of its volume to AptKit; the legacy is the safety net.

---

## References

- `package.json:14` — `"@aptkit/core": "npm:@rlynjb/aptkit-core@^0.3.0"` (the dependency)
- `lib/agents/aptkit-adapters.ts:26-72` — `AnthropicModelProviderAdapter` (Anthropic SDK → AptKit ModelProvider)
- `lib/agents/aptkit-adapters.ts:75-97` — `BloomingToolRegistryAdapter` (DataSource → AptKit ToolRegistry; the seam-on-seam)
- `lib/agents/aptkit-adapters.ts:100-142` — `BloomingTraceSinkAdapter` (CapabilityEvent → NDJSON hooks)
- `lib/agents/base.ts:1-14` — the trimmed module (just `AGENT_MODEL` and the `McpCaller` re-export)
- `lib/agents/base-legacy.ts:86-176` — the preserved hand-rolled `runAgentLoop`
- `lib/agents/monitoring.ts` — active wrapper (AptKit-backed)
- `lib/agents/diagnostic.ts` — active wrapper (AptKit-backed)
- `lib/agents/recommendation.ts` — active wrapper (AptKit-backed)
- `lib/agents/query.ts` — active wrapper (AptKit-backed)
- `lib/agents/intent.ts` — active classifier (direct Anthropic call; not AptKit-wrapped, by design)
- `lib/agents/monitoring-legacy.ts`, `diagnostic-legacy.ts`, `recommendation-legacy.ts`, `query-legacy.ts`, `intent-legacy.ts` — the preserved legacy siblings (the rollback receipt)
- `app/api/agent/route.ts:228-230` — the supervisor `if`-ladder (unmoved by this migration)
- `app/api/agent/route.ts:160-179` — the route's DataSource construction (RFC-005, unmoved by this migration)
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — the supervisor that didn't move
- `.aipe/rehearse-design-doc/05-datasource-seam-and-adapter-pattern.md` — the DataSource seam this RFC layers on top of
- Bushnell & Helm, *Design Patterns* (1994) — Adapter pattern (the canonical reference for both bridges in play)
- AptKit `@aptkit/core` README — the primitive contracts (ModelProvider, ToolRegistry, CapabilityTraceSink) this RFC builds on
