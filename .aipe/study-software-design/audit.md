# The audit — 8 APOSD lenses applied to THIS repo

The lens-by-lens walk. Each section calls out what the codebase actually does, with `file:line` grounding or `not yet exercised` when the lens has nothing to bite on. Where a finding has its own deep walk, the audit cross-links rather than restating.

> **Verdict-first.** The biggest design move in the codebase is "small interface, fat body" — and it appears TWICE (the DataSource seam and the AptKit adapter bridges). The biggest historical sin (`app/page.tsx` shallow module) is RESOLVED. The biggest remaining debt is naming-level — two short names in one helper file. That's a strong codebase.

---

## Lens 1 — complexity-in-this-codebase

**Verdict: no live hotspots. The one historical hotspot (`app/page.tsx`) is resolved.**

The three symptoms APOSD names:

```
  symptom               where would it land?
  ───────────────────   ───────────────────────────────────────────
  change amplification  → none active; one resolved (the
                          page-decomposition that landed in PRs #1–#4)
  cognitive load        → two routes hover at ~340 LOC each
                          (briefing 336, agent 345) — earning it, not
                          shallow; named for cross-reference only
  unknown-unknowns      → filterByStep at app/api/agent/route.ts
                          reads AgentEvent shape by string tag
                          (latent — future-debt finding)
```

### Findings

**1.1 — `app/page.tsx` was the complexity postal address; it isn't anymore.** The 12-day study, the 06-14 audit, and earlier runs all named it. It now stands at 461 LOC (was 817) after three hook extractions: `useBriefingStream` (313 LOC), `useDemoCapture` (146 LOC), `useReconnectPolicy` (123 LOC). Severity: **resolved**. The historical case is preserved as a teaching artifact in `04-shallow-module-page-component-resolved.md`.

**1.2 — `/api/agent/route.ts` is 345 LOC carrying three flows (diagnose, recommend, query) + cached-replay branch + 401 gate.** Lines aren't the metric; *concerns at one altitude* is. The three flows each have a coherent lifecycle and the dispatch is a tight if-else, so it's deep, not shallow. Severity: **medium-but-earned**. No design action — but if a fifth flow ever lands, revisit.

**1.3 — `/api/briefing/route.ts` is its peer at 336 LOC, one flow + demo replay branch + auth gate.** Same band; same shape; same verdict. No action.

**1.4 — Latent unknown-unknown: `filterByStep` reads `AgentEvent` shape by string tag.** When a new event variant lands, every reader has to add a case or get silently skipped. The fix is a discriminated-union exhaustiveness check (Replace Conditional with Polymorphism). Future-debt. Severity: **medium**.

---

## Lens 2 — deep-vs-shallow-modules

**Verdict: the depth axis stretched again. The deepest deep modules got deeper; the worst shallow module retreated to its place.**

Module depth ≈ functionality ÷ interface size. The codebase has THREE genuinely deep modules and ZERO active shallow modules.

### Findings

**2.1 — Deepest: the DataSource seam.** `lib/data-source/types.ts` is a 73-LOC interface (two method signatures: `callTool`, `listTools`); `BloomreachDataSource` is 214 LOC of body (OAuth, rate-limit retry ladder, 60s cache, AbortSignal composition, typed errors); `SyntheticDataSource` is 516 LOC of body (a 30+ tool dispatcher with deterministic fake data). The agent layer holds a `DataSource` reference and never sees the concrete adapter. **Functionality:interface ratio ≈ 10:1.** This is the textbook deep module the book describes. Severity: **strong praise**. **→ see `01-deep-module-data-source.md` for the deep walk.**

**2.2 — Second-deepest: the AptKit adapter bridge.** `lib/agents/aptkit-adapters.ts` is 206 LOC carrying three classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) that bridge AptKit's generic primitive interfaces (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) to Blooming's owned types (Anthropic SDK, MCP `callTool`, the `ToolCall` shape the route streams). Each adapter is small enough to read in one screen; together they hide AptKit's entire wire shape from the four agent classes. **Same APOSD lesson at a different altitude.** Severity: **strong praise**. **→ see `02-information-hiding-aptkit-bridge.md`.**

**2.3 — Third-deepest: `lib/agents/base.ts` (and its legacy sibling `base-legacy.ts`).** The active `base.ts` is 14 LOC — it's now a type shim (`AGENT_MODEL` + `McpCaller`) because AptKit owns the agent loop. The previous deep module shape (`runAgentLoop` with `parseResult` + `recoveryPrompt`, 270 LOC) is preserved at `base-legacy.ts` as the revertibility anchor. The depth moved upstream into AptKit. Severity: **deliberate hand-off**.

**2.4 — Shallowest module today: nothing screams.** No `*Manager`, no thin-data-class-with-getters-and-setters, no "Worker that delegates everything." The historical worst case (`app/page.tsx`) is resolved. Severity: **none active**. **→ see `04-shallow-module-page-component-resolved.md` for the historical worked example.**

**2.5 — Earned pass-through (not a smell): `BloomreachDataSource.listTools`** (`lib/data-source/bloomreach-data-source.ts:211-213`). Forwards directly to the transport with no caching or rate-limit logic. The forward IS the implementation — the SDK already provides exactly what callers want, and there's nothing to enrich. APOSD's pass-through smell fires when the wrapper adds nothing AND the caller could call the inner thing directly; here, the wrapper's role is to *be* the seam (hiding the SDK from callers), not to transform the call. **Earned.**

---

## Lens 3 — information-hiding-and-leakage

**Verdict: strong hides everywhere; no active leaks.**

### Findings

**3.1 — Strong hide: `BloomreachDataSource` owns the Bloomreach rate-limit grammar.** `parseRetryAfterMs` (`lib/data-source/bloomreach-data-source.ts:64-71`) knows the two error-text shapes the live server emits (`Retry after ~12 second(s)` and `rate limit reached (1 per 10 second)`); no caller knows. The retry ladder is internal; the `RETRY_BUFFER_MS` cushion is internal. The agent layer asks `callTool(name, args)` and gets back `{ result, durationMs, fromCache }` — the rate-limit dance is invisible.

**3.2 — Strong hide: `BloomingTraceSinkAdapter` owns the AptKit `CapabilityEvent` → `ToolCall` mapping.** `lib/agents/aptkit-adapters.ts:100-142`. The route handlers consume `ToolCall` objects and never know that AptKit emits a different shape (`tool_call_start` + `tool_call_end` with `timestamp`-keyed correlation). The adapter holds an internal `Map<toolName, ToolCall[]>` to stitch the start/end pair back into one object.

**3.3 — Strong hide: `redactSecrets` + `formatError`** (`lib/mcp/transport.ts:55-97`). Owns the secret-pattern grammar (`Bearer`, `access_token`, `refresh_token`, `id_token`, `code_verifier`) and the multi-cause-chain walking. All six routes that surface errors import these two functions; none re-implement them. The class of bug "an OAuth token reaches Vercel logs" is killed at one location.

**3.4 — Strong hide: `BloomreachAuthProvider`** (`lib/mcp/auth.ts`) owns the three-backend selection by `NODE_ENV` (AsyncLocalStorage in prod, file in dev, in-memory in test). Routes ask for a session; the storage backend is invisible.

**3.5 — Strong hide: `lib/state/insights.ts` owns the session-tenancy boundary.** A previous bug (concurrent users wiping each other's feeds) was killed by routing every read/write through `sessionState(sessionId)`. The outer map is never cleared by a request — only per-session sub-maps are. The Insight↔Anomaly bidirectional mapping (`anomalyToInsight`, `insightToAnomaly`) is colocated in the same file; the four fields intentionally dropped on the reverse mapping are pinned by a round-trip test.

**3.6 — Strong hide: `buildSynthesisInstruction`** lived in `lib/agents/base.ts` (now in AptKit) and owned the synthesis prefix+closer string. The four agent classes pass only the role-specific clause; the boilerplate has one home.

**No active leaks.** The Insight↔Anomaly leak (decision in two files) closed in commit `b5d922a`. The `formatError` duplication risk (about to fan from 2 to 6 routes) closed in commit `d91dd1d`.

---

## Lens 4 — layers-and-abstractions

**Verdict: every layer transforms. One earned pass-through (named in 2.5). One previously-flagged pass-through-the-layer failure (AbortSignal) has been mostly closed by the AptKit migration.**

### Findings

**4.1 — Every architectural layer changes the contract on the way down.**

```
  layer                  contract it presents to the layer above
  ─────────────────      ───────────────────────────────────────────
  UI components          React props + handlers
  React hooks            stateful return objects (insights, status,
                         traceItems, …) — useBriefingStream returns 9
  fetch + readNdjson     ReadableStream<bytes> → typed event stream
                         (BriefingEvent | AgentEvent)
  route handlers         NDJSON stream per request shape
  agent classes          domain objects (Anomaly, Diagnosis,
                         Recommendation[]) + Hooks for trace
  AptKit primitives      ModelRequest/Response + CapabilityEvent
  Blooming adapters      AnthropicSDK calls + DataSource.callTool
  DataSource             { result, durationMs, fromCache }
  MCP transport          { name, arguments } over HTTP + OAuth
```

Each row is a real abstraction change, not a forward. The pass-through smell would mean two adjacent rows offer the same shape; none do.

**4.2 — Four agent classes share a uniform constructor shape** (`anthropic, dataSource, schema, allTools, sessionId`). After the AptKit migration each class is ~30 LOC (the body is now `new AptKitXAgent(...).method(...)` + a mapper). They're peer wrappers across one seam (AptKit), not a stack — so no pass-through-the-layer issue. Severity: **earned uniformity**.

**4.3 — `AbortSignal` propagation is now wired through every layer.** Routes accept `req.signal`; agents accept `{ signal }` hooks; agents pass it through to AptKit; AptKit calls `ModelProvider.complete({ signal })` and `ToolRegistry.callTool(_, _, { signal })`; the Bloomreach adapter composes the route signal with `AbortSignal.timeout(30_000)` in `composeSignals` so first-to-fire wins. The "pass-through-the-layer failure" the 06-15 audit named (briefing/agent routes not honoring `req.signal`) has a stub queued; the AptKit-side plumbing is in place to receive it. Severity: **medium, in progress**.

---

## Lens 5 — pull-complexity-downward

**Verdict: the kernel pattern fires twice. Once at the data layer (DataSource), once at streaming (`readNdjson`). Both are textbook "pull complexity down" moves.**

### Findings

**5.1 — `readNdjson` is the canonical pulled-down kernel.** `lib/streaming/ndjson.ts`, 64 LOC. Owns the `fetch → reader → TextDecoder → buffer → split('\n') → JSON.parse → handle(event)` loop that the four streaming surfaces all need: `useBriefingStream`, `useInvestigation`, `useDemoCapture`, and `StreamingResponse.tsx`. Plus the integration test helper `collectEvents` consumes it too. **One implementation; five callers; no duplication.** Severity: **strong praise**. **→ see `03-pulled-complexity-down-readndjson.md`.**

**5.2 — `BloomreachDataSource` pulls down 4 concerns the route could otherwise expose.** Caching, rate-limit retry, request spacing, and signal composition all live behind one `callTool` call. Routes never set TTL, never pass retry counts, never compose signals. The agent layer only ever passes `signal` (one option).

**5.3 — Constants are well-defaulted.** `AGENT_MODEL` (`lib/agents/base.ts:7`), `TOOL_TIMEOUT_MS = 30_000` (`lib/mcp/transport.ts:38`), `minIntervalMs = 200` / `maxRetries = 3` / `retryDelayMs = 10_000` / `retryCeilingMs = 20_000` (`bloomreach-data-source.ts:130-136`). All have inline rationale comments explaining the choice. No avoidable config exposed to callers.

**5.4 — Counter-example (intentional knob): `cacheTtlMs` + `skipCache`.** `BloomreachDataSource.callTool` accepts these on top of the abstract DataSource surface. Two specific call sites need them (`/api/mcp/call` for the debug panel, `/api/mcp/capture` for the live snapshot capture). The agent layer never uses them. APOSD's rule: don't expose a knob if the module can decide it. Here the module CAN'T decide — the cache decision is the caller's intent. **Earned.**

---

## Lens 6 — errors-and-special-cases

**Verdict: strongest design facet in the codebase. Errors are defined-out-of-existence at three intentional boundaries.**

### Findings

**6.1 — Boundary 1: rate-limit errors are not errors to the caller.** `BloomreachDataSource.callTool` catches `isRateLimited(result)` and retries inside `callTool` itself. The route layer never sees a rate-limit case. The class of bug "I have to handle rate-limit every place I call a tool" cannot exist by construction.

**6.2 — Boundary 2: per-tool failure inside the agent loop becomes a tool_result with `is_error: true`.** AptKit's loop reads the `isError` field and threads it back to Claude as the next turn's tool result. The agent classes never special-case "tool X failed" — the model decides whether to retry, pivot, or give up. The class of bug "tool failure → agent crashes the request" cannot exist by construction.

**6.3 — Boundary 3: parse failure becomes a recovery turn, not a special case.** AptKit's agent loop (originally `runAgentLoop` in `base-legacy.ts:215-217` before the migration) accepts a `parseResult` + `recoveryPrompt` pair. If parsing the model's final answer fails, it injects a forced-synthesis turn and tries once more before giving up. The four agent classes don't carry their own retry/parse logic. The class of bug "every agent class re-implements its own one-turn recovery" was killed when `synthesize()` lifted to the loop (commit `43ba9f0`, ~90 LOC removed).

**6.4 — Boundary 4 (cross-cutting): `composeSignals` defines cancellation out of branching.** `lib/mcp/transport.ts:173-189`. Two AbortSignals (client cancel + per-call 30s timeout) become one via `AbortSignal.any`. Callers don't switch on "did the client cancel or did we time out?"; both paths fire the same abort. The wrapper turns two concerns into one signal — exactly APOSD's "define errors out of existence" move applied to cancellation.

**6.5 — No try/catch sprawl.** Errors are caught at three places that matter (transport, data source, agent loop) and propagated as typed objects (`McpToolError`) or shaped results (`{ isError: true, content }`). Routes have one try/catch at the top of the streaming start function. Components don't catch at all. The catch density is exactly what the book asks for.

---

## Lens 7 — readability (names · comments · consistency · obviousness)

**Verdict: strong overall. Two short-name holdouts in one helper file; one inline-CSS vs Tailwind convention drift in one component.**

### Names

**7.1 — `r` and `cp` in `lib/insights/derive.ts:13, :29`.** `r` is a result envelope (`e.result as Record<string, unknown>`), `cp` is the current/prior pair returned by `findCurrentPrior`. Both functions are small (10–15 LOC), so the names are visible in their scope — but `result` and `currentPrior` would carry more signal at zero cost. Severity: **low**. Fold into the next `derive.ts` touch.

**No other vague names.** No `data`, `obj`, `tmp`, `manager`, `handler` (the page hook's `handle` is scoped to a 90-LOC dispatcher and clearly names "the NDJSON event dispatcher"). No `_legacy` files in active call paths.

### Comments

**Comments are load-bearing throughout `lib/`.** Three patterns the codebase reaches for:

```
  file-header comment  — what this file owns; where it sits in the
                         system; what its history is
                         (e.g. lib/streaming/ndjson.ts top-of-file)
  decision rationale   — why this constant, why this branch
                         (e.g. retryCeilingMs = 20_000 — "raising it
                         risks blowing the per-investigation budget")
  cross-link to test   — "verification harness:
                         test/api/briefing.integration.test.ts"
                         (e.g. lib/hooks/useBriefingStream.ts:11-12)
```

No comments restating the code. Interface comments present on every public function.

### Consistency

**7.2 — Inline-CSS vs Tailwind drift in `components/feed/InsightCard.tsx`.** Mix of `style={{...}}` and Tailwind classes within one file. Severity: **low**. Component-at-a-time migration; not blocking.

**Otherwise: one streaming kernel (`readNdjson`), one error formatter (`formatError`), one session-state shape (`sessionState`), one agent constructor shape, one NDJSON event-emit helper (`encodeEvent`).** No double-conventions.

### Obviousness

**Two surprises worth knowing about.**

  - `lib/hooks/useInvestigation.ts` deliberately does NOT cancel the fetch on cleanup — React StrictMode (dev) mounts→unmounts→mounts, and cancelling on the first cleanup aborted the stream. The comment names this explicitly (`:34-37`). Not a bug; a documented constraint.
  - `lib/mcp/client.ts` is a 17-line back-compat shim re-exporting from `lib/data-source/bloomreach-data-source.ts`. Looks like a real module from the import side; the doc comment says it's a shim. Worth knowing before opening it expecting logic.

---

## Lens 8 — red-flags-audit (capstone)

Ousterhout's red flags scored against this repo today.

```
FIRES (ranked by severity for this repo)
  ──────────────────────────────────────────────────────────────────
  #1  vague names         LOW       r, cp in lib/insights/derive.ts
                                    → Lens 7.1 — fold into next touch

  #2  convention drift    LOW       inline-CSS vs Tailwind in
                                    components/feed/InsightCard.tsx
                                    → Lens 7.2 — component migration

  #3  pass-through        N/A       BloomreachDataSource.listTools
       method                       earns its keep (Lens 2.5) —
                                    listed for completeness; does
                                    not actually fire

  #4  pass-through-the-   MEDIUM    /api/briefing + /api/agent don't
       layer (cancellation)         honor req.signal end-to-end; the
                                    plumbing exists, the wiring is
                                    queued — Lens 4.3

  #5  unknown-unknowns    MEDIUM    filterByStep reads AgentEvent
                                    shape by string tag — future-debt
                                    if a new variant lands — Lens 1.4

CLOSED (since prior audits)
  ──────────────────────────────────────────────────────────────────
  shallow module          RESOLVED  app/page.tsx 817→461 LOC + 3 hooks
                                    → 04-shallow-module-page-component-
                                      resolved.md
  information leakage     CLOSED    Insight↔Anomaly colocation (b5d922a)
  duplication (cross-file) CLOSED   NDJSON parser extracted (0f06eff)
                                    → 03-pulled-complexity-down-
                                      readndjson.md
  duplication (mild)      CLOSED    formatError lifted + extended (d91dd1d)
  special-case sprawl     CLOSED    synthesize() duplication lifted (43ba9f0)
  partially-pushed-up cfg CLOSED    synthesisInstruction lifted (8179e08)

DOESN'T FIRE (praise — keep it that way)
  ──────────────────────────────────────────────────────────────────
  classitis               4 agent classes earn their keep at ~30 LOC
                          each; 3 bridge adapters earn theirs at
                          ~70 LOC each (Lens 2.2)
  try/catch sprawl        errors masked at 4 intentional boundaries
                          (Lens 6)
  comment restates code   comments carry rationale and history,
                          not what the code already says (Lens 7)
  hard-to-read names      >95% of names are precise (Lens 7)
  exposed avoidable cfg   constants well-defaulted with inline
                          rationale (Lens 5.3)
  temporal decomposition  data-fetch / parse / dispatch are not split
                          across files; readNdjson owns the whole loop
                          (Lens 5.1)
```

---

## The top 3 fixes ranked across the whole repo

  1. **Wire `req.signal` end-to-end through `/api/briefing` and `/api/agent`** (Lens 4.3). The plumbing exists at every layer; the routes are the missing link. Real ops cost on cancelled requests today; latent budget burn. Stub queued: `design-honor-abortsignal-in-briefing-route.md`.
  2. **Rename `r` and `cp` in `lib/insights/derive.ts`** (Lens 7.1). One-minute change; fold into the next touch. Not worth a dedicated PR.
  3. **Make `filterByStep` exhaustively check the `AgentEvent` discriminated union** (Lens 1.4). Future-debt — pays off the next time a new event variant lands. Replace Conditional with Polymorphism.

Everything else is praise, not action.
