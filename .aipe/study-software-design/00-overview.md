# Overview — where APOSD primitives live in this repo

One page. Where each design primitive shows up in the codebase, with the file that anchors it. Open `audit.md` for the lens-by-lens findings; open the numbered files for the deep walks on the patterns that earn one.

---

## The system, one diagram

The picture before the primitives.

```
  blooming insights — layers + APOSD anchor points

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  app/page.tsx (461 LOC, was 817)                            │
  │   + useBriefingStream / useDemoCapture / useReconnectPolicy │  ← 04 shallow-resolved
  │  app/investigate/[id]/page.tsx                              │
  │  components/{feed,investigation,shared,chat}/*.tsx          │
  └──────────────────────────┬──────────────────────────────────┘
                             │  fetch + readNdjson
                             │  (lib/streaming/ndjson.ts)        ← 03 pulled-complexity-down
  ┌─ Service layer ──────────▼──────────────────────────────────┐
  │  app/api/briefing/route.ts   336 LOC                        │
  │  app/api/agent/route.ts      345 LOC                        │
  │  app/api/mcp/{call,reset,callback,tools,capture,capture-demo│
  └──────────────────────────┬──────────────────────────────────┘
                             │  uses agent classes + DataSource
  ┌─ Agent layer ────────────▼──────────────────────────────────┐
  │  lib/agents/monitoring   diagnostic   recommendation  query │
  │  lib/agents/aptkit-adapters.ts  (3 bridge classes, 206 LOC) │  ← 02 info-hiding bridge
  │  lib/agents/base.ts  (McpCaller seam, AGENT_MODEL)          │
  └──────────────────────────┬──────────────────────────────────┘
                             │  callTool / listTools (DataSource)
  ┌─ Data layer (the seam) ──▼──────────────────────────────────┐
  │  lib/data-source/types.ts   73 LOC interface                │  ← 01 deep module
  │   ├── bloomreach-data-source.ts   214 LOC (live MCP)        │
  │   └── synthetic-data-source.ts    516 LOC (deterministic)   │
  │  + lib/mcp/client.ts  (17-LOC compat shim, re-export)       │
  └──────────────────────────┬──────────────────────────────────┘
                             │  MCP SDK transport (HTTP + OAuth)
  ┌─ Provider layer ─────────▼──────────────────────────────────┐
  │  Bloomreach loomi-mcp-alpha     · Anthropic SDK             │
  └─────────────────────────────────────────────────────────────┘
```

---

## Where each APOSD primitive lives

Read the audit lens in `audit.md` for the full ranked finding list. This is the map view.

```
  primitive (APOSD)              where it lives in THIS repo
  ─────────────────────────      ───────────────────────────────────────
  deep module                    lib/data-source/types.ts  (the interface)
                                 + bloomreach-data-source.ts
                                 + synthetic-data-source.ts
                                 → see 01-deep-module-data-source.md

  information hiding             lib/agents/aptkit-adapters.ts
                                 (3 bridge classes hide AptKit shape)
                                 → see 02-information-hiding-aptkit-bridge.md

  pull complexity down           lib/streaming/ndjson.ts
                                 one kernel, four consumers
                                 → see 03-pulled-complexity-down-readndjson.md

  shallow module (RESOLVED)      app/page.tsx — was 817 LOC, now 461
                                 the worked negative example
                                 → see 04-shallow-module-page-component-resolved.md

  errors out of existence        lib/agents/base.ts via runRecoveryTurn /
                                 AptKit's parseResult + recoveryPrompt
                                 (a parse failure becomes one more turn,
                                 not a special-case branch)
                                 → audit.md lens 6

  define errors low              lib/mcp/transport.ts redactSecrets +
                                 formatError + composeSignals
                                 (timeout, auth, transport) all collapsed
                                 to one module
                                 → audit.md lens 6

  layered abstraction            UI → route → agent → data-source → MCP
                                 each layer transforms; no layer just
                                 forwards (one earned pass-through:
                                 BloomreachDataSource.listTools)
                                 → audit.md lens 4

  readability                    >95% of names are precise; the holdouts
                                 are `r` and `cp` in lib/insights/derive.ts
                                 (low-severity)
                                 → audit.md lens 7
```

---

## The single load-bearing lesson

If you take one thing away from this guide:

> **The codebase teaches "small interface, fat body" TWICE.**
>
> Once at the data layer: a 73-LOC `DataSource` interface over ~730 LOC of two implementations (`BloomreachDataSource` + `SyntheticDataSource`). The agents see five methods; they never see OAuth, rate-limit retry, or synthetic dispatch.
>
> Once at the agent layer: three ~200-LOC adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) over the AptKit primitive interfaces. The route handlers see Blooming's `Anomaly` / `Diagnosis` / `Recommendation` types; they never see AptKit's `ModelRequest` / `CapabilityEvent` shapes.
>
> Same primitive, two altitudes. When a primitive reappears at two levels, it's signal — name it once and point at both occurrences. (The structure-pass move from `format.md`.)

---

## Where the codebase still has a shallow module

`audit.md` Lens 2 documents the historical `app/page.tsx` shallow-module case (RESOLVED — PRs #1–#4 lifted it to 461 LOC + 3 hooks). The walk lives in `04-shallow-module-page-component-resolved.md` as the negative-then-positive worked example.

No active shallow-module debt today. Both routes (`/api/briefing` 336 LOC, `/api/agent` 345 LOC) are deep — each carries a coherent flow with phase boundaries; that depth is earning its keep. If a fifth flow ever lands in `/api/agent`, revisit.
