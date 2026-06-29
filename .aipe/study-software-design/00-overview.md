# 00 — overview

One page. The big picture, the through-line, the load-bearing design moves this repo makes and the ones it doesn't.

## The system in one diagram

```
  blooming insights — module layers + design seams

  ┌─ UI (React 19, App Router) ─────────────────────────────────────────┐
  │  app/page.tsx (461 LOC)   →   3 hooks                                │
  │    Feed                        useBriefingStream                     │
  │    InvestigateStep2/3          useDemoCapture                        │
  │    QueryBox                    useReconnectPolicy                    │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │  fetch + NDJSON   (kernel: readNdjson)
  ┌─ Route handlers (Next.js) ──▼──────────────────────────────────────┐
  │  /api/briefing   /api/agent   /api/mcp/*                           │
  │    stream events as NDJSON via encodeEvent                         │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │  agent.scan / .investigate / .propose
  ┌─ Agent layer (AptKit-wrapped) ─▼──────────────────────────────────┐
  │  MonitoringAgent  DiagnosticAgent  RecommendationAgent  QueryAgent│
  │    each wraps @aptkit/core via 3 bridge adapters                  │
  │    (AnthropicModelProviderAdapter ·                                │
  │     BloomingToolRegistryAdapter ·                                  │
  │     BloomingTraceSinkAdapter)                                      │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │  DataSource port (callTool · listTools)
  ┌─ DataSource port ───────────▼──────────────────────────────────────┐
  │  interface DataSource { callTool, listTools }                       │
  │                                                                     │
  │  BloomreachDataSource (216 LOC, live MCP)                           │
  │  SyntheticDataSource  (516 LOC, in-process fixture)                 │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │  HTTP + OAuth (StreamableHTTPClientTransport)
  ┌─ Outside the boundary ──────▼──────────────────────────────────────┐
  │  Bloomreach loomi connect MCP   ·   Anthropic API                  │
  └─────────────────────────────────────────────────────────────────────┘
```

Four altitudes, two seams. The seams are where the design moves live: the upper seam (`DataSource`) lets the agent layer treat live Bloomreach and synthetic fixtures identically; the lower seam (`McpTransport`) lets `BloomreachDataSource` swap a real SDK transport for a fake in tests. Both are deep — small interfaces, large bodies behind them.

## The through-line

**Complexity is the enemy.** The repo's biggest enemy is per-call rate limits + multi-minute agent loops + revoked OAuth tokens + a streamed UI surface that all have to compose without leaking concerns. The design moves below are how it's kept in hand.

**Deep modules are the weapon.** The port (`DataSource`) is the canonical example — 4-method interface (counting overloads), 700+ LOC of behavior behind it (Bloomreach adapter + Synthetic adapter combined). The kernel (`readNdjson`) is another: ~30 lines of public surface, four streaming surfaces consume it.

**Pull complexity down.** When the same `fetch → reader → split('\n') → JSON.parse → dispatch` loop showed up in 4 places, it got pulled into one kernel. When the agent layer needed an abort signal threaded through to Anthropic + MCP simultaneously, the composition lives in `composeSignals` inside `transport.ts` — every caller passes one signal, the transport composes it with its own 30s ceiling. Callers never see the OR.

**Hide what would otherwise force two modules to change together.** The 3 AptKit bridge adapters in `lib/agents/aptkit-adapters.ts` exist so Blooming's `ToolCall` / `ReasoningStep` / `Anthropic.Messages.MessageParam` vocabularies never touch `@aptkit/core`'s `ModelProvider` / `ToolRegistry` / `CapabilityEvent` vocabularies. Swap the AptKit version, only the bridge changes.

## The ranked findings — top 3 things to look at first

```
  1. the deep port (DataSource)
     → file: lib/data-source/types.ts (73 LOC)
     → why it earns the top slot: 4-method interface, 700+ LOC behind it,
       two adapters, zero callers know which one they hold.
     → see 01-port-and-adapter-data-source.md

  2. the AptKit bridge (3 adapter classes in aptkit-adapters.ts)
     → file: lib/agents/aptkit-adapters.ts (206 LOC)
     → why it matters: the cleanest information-hiding seam in the repo.
       Two vocabularies meet at a wall; neither leaks into the other's body.
     → see 03-aptkit-bridge-information-hiding.md

  3. the streaming kernel (readNdjson)
     → file: lib/streaming/ndjson.ts (64 LOC)
     → why it matters: the smallest deep-module example.
       30-line public surface; consumed by 4 streaming surfaces unchanged.
     → see 02-streaming-ndjson-kernel.md
```

## What this repo does well

  → **Deep modules exist on purpose.** The port (`DataSource`), the kernel (`readNdjson`), the bridge (the 3 AptKit adapters) are all deliberate — the comments in each say what's being hidden and why.
  → **Honest comment voice.** The longer files (`useBriefingStream`, `BloomreachDataSource`, `useReconnectPolicy`) carry comments that explain *why* a decision was made, including when the call was a compromise (the "two regex variants are preserved verbatim" comment in `useReconnectPolicy.ts` is exemplary).
  → **A single NDJSON contract.** `AgentEvent` in `lib/mcp/events.ts` is the wire format. Both producers (routes) and consumers (hooks) typecheck against it; the dispatcher in `useBriefingStream` is exhaustive over the union.
  → **Tests at the right altitude.** 24 test files, 221 passing — they exercise pure logic and the streaming + agent loops with injected fakes. No network in the test suite.

## What it does less well — the 3 honest weaknesses

  → **Parallel `*-legacy.ts` files in `lib/agents/`.** Nine files with the `-legacy` suffix (`base-legacy.ts`, `diagnostic-legacy.ts`, etc., ~1000 LOC total) exist beside the new AptKit-wrapped versions. They're not imported by any production code — only by 2 test files. Either delete them or migrate those tests; the parallel structure is the most expensive thing in the repo to read past.
  → **Two regex variants in `useReconnectPolicy.ts`.** The `AUTH_ERROR_RE_AUTO` and `AUTH_ERROR_RE_BUTTON` predicates are subtly different (the button version misses `invalid_token` and `reconnect`). The comment names this as a latent bug filed for later; in interview terms it's the textbook AOSD red flag of *two ways to do one thing*.
  → **The `whyItMatters` regex chain in `InsightCard.tsx`.** Lines 41–71 dispatch on metric-name regexes to assemble a sentence. It's UI code carrying agent fallback logic — should live next to `deriveInsightFields` in `lib/insights/derive.ts` where the rest of the evidence-derivation lives.

The audit (`audit.md`) walks each of these lenses in full with file:line citations. The Pass 2 files take the design moves worth a deep walk.
