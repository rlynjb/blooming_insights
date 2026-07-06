# Options and opportunity cost

**"Why this path and not the alternatives?"** The review room's second-favorite probe. This file walks four major architectural options where the wrong choice would have cost real time — and the reasoning that picked the right one, with the opportunity cost of the alternatives named explicitly.

The frame this file uses is the **evaluated-and-accepted decision mode**: you looked at each option, named what it costs, named what its alternative costs, and *decided*. Not "we happened to end up with X." Not "X was the default." Chose, with receipts.

## The shape

```
  Four major options, each with an evaluated pick

  ┌─ 1. AGENT RUNTIME ──────────────────────┐
  │  own loop  ─────►  AptKit migration     │
  │  (evaluated-and-accepted; legacy kept)  │
  └──────────────────────────────────────────┘

  ┌─ 2. PORT / ADAPTER FOR DATA ────────────┐
  │  DataSource seam                         │
  │  · Olist add  · Olist remove             │
  │  · Synthetic add  · Fault-injecting      │
  │  · McpDataSource / AuthProvider generalization │
  │  5 uses, zero caller-surface changes    │
  └──────────────────────────────────────────┘

  ┌─ 3. STREAMING TRANSPORT ────────────────┐
  │  NDJSON over fetch stream                │
  │  (rejected: SSE + EventSource)           │
  │  4-consumer readNdjson kernel proves it  │
  └──────────────────────────────────────────┘

  ┌─ 4. PORTFOLIO HARDENING SEQUENCING ─────┐
  │  6 phases over 4 weeks                   │
  │  eval → obs → cost → fault → gate → CI  │
  │  per-week reading + per-session commits  │
  └──────────────────────────────────────────┘
```

Walk each with the option compared, the opportunity cost of the loser, and the receipt of the pick.

## Option 1 — Own loop → AptKit migration

**The choice.** Started with an own-implementation of the agent loop (Claude + MCP tool use, hand-written). Migrated to `@aptkit/core@0.3.0` as the runtime substrate. Kept the legacy own-loop files as `*-legacy.ts` for rollback receipt.

**The alternative — kept the own loop.**

Opportunity cost of *staying* on the own loop:
- Every substrate improvement aptkit ships (tracing helpers, retry primitives, transport polish) has to be re-implemented in your own code.
- The bar for what the loop supports (tool schema validation, error surfacing, streaming) is set by *your* patience for maintenance, not by a library invested in getting it right.
- No shared vocabulary with other engineers using the same substrate — every conversation about the loop has to start with "here's how I wrote it."

Opportunity cost of *migrating*:
- Migration risk. Aptkit could change API. Aptkit could go stale. You're taking on a dependency that could rot.
- Some of aptkit's assumptions may not fit (the OpenAI-first cost helper is a real example — see Ch 02, cost controls).

**The evaluation.** For a portfolio product, the shared-substrate value wins over the maintain-your-own value. You want an interviewer to say "oh, aptkit — I know that shape" rather than "let me read your custom runtime for 20 minutes." And the aptkit gap you found (OpenAI-only cost helper) turned into a *feature* of the story: you shipped the Anthropic pricing helper on top, which shows exactly the kind of substrate-collaboration muscle a portfolio should demonstrate.

**Legacy preserved as rollback receipt.** The `*-legacy.ts` files aren't dead code. They're the audit trail. If aptkit ever ships something incompatible, the rollback path is a file-rename, not a git-archaeology exercise. This is Ch 02's "legacy preserved" cut viewed from the *options* angle: keeping legacy was the deliberate insurance policy on the migration decision.

**The receipt.** `git log` the migration. Old files under `*-legacy.ts`. New agents on aptkit's `Agent` / `runAgentLoop` primitives. Tests pass on both paths (some tests still exercise legacy for the rollback receipt).

## Option 2 — DataSource seam (the port/adapter pattern)

**The choice.** Introduce a `DataSource` interface (the port) at `lib/mcp/tools.ts`, with concrete adapters that implement it. Agents depend on the port, not any specific adapter. Adapter selection happens at composition root, not at agent code.

**This is the option that pays back hardest.** Here's the receipt shape you can put on a whiteboard.

```
  DataSource seam — 5 shipped uses, zero caller-surface changes

  ┌─ AGENTS ─────────────────────────────────┐
  │  DiagnosticAgent · RecommendationAgent   │
  │  MonitoringAgent · QueryAgent            │
  │                                           │
  │  depend on ▼                              │
  │      DataSource (the port)                │
  └──────────────────┬───────────────────────┘
                     │
     ┌───────────────┼───────────────┬─────────────┬────────────────┐
     ▼               ▼               ▼             ▼                ▼
  Bloomreach    Olist MCP       Synthetic     Fault-injecting   McpDataSource
   MCP adapter   adapter         adapter       decorator         + AuthProvider
                                                (wraps another)  generalization
  · used 1        · added 1       · used 3      · used 4          · used 5
    live prod       proved seam    live-syn +    offline drill      swappable-MCP
    briefings       (retired)      eval + demo                      via UI modal
```

**The alternative — direct MCP client calls.**

Opportunity cost of *not* having the port:
- Every place an agent needs data is coupled to the MCP client's specific method signatures.
- Adding a second data source means editing agent code, not adding an adapter.
- Testing without hitting a live MCP server means mocking the MCP client — noisy, fragile.
- Demo mode has to fork the whole agent path instead of swapping one dependency.

**The evaluated evidence — 5 uses, zero caller-surface changes.** This is the receipt that makes the seam defensible in an interview. The port was proved not by *arguing* it was clean, but by *using* it five different ways without changing the code that depends on it:

1. **Olist MCP adapter — added.** A second, third-party MCP server (Olist, ecommerce dataset) was wired up as an alternate DataSource. Agents worked against it unchanged. This was the *first* proof the port wasn't a same-shape-different-name — the adapter did real translation.
2. **Olist MCP adapter — removed.** Once the seam was proved, the Olist adapter was retired in favor of the cleaner Synthetic path. Removal without caller changes = the seam works in both directions.
3. **SyntheticDataSource — added.** In-process data generator that fabricates workspace-shaped responses. No network. No auth. It's what backs the default `live-synthetic` UX (real agent loop, in-process data) and the eval; the committed `demo` snapshot path uses it too.
4. **FaultInjectingDataSource decorator — added.** Wraps any other DataSource and injects failures at the port boundary. Used for the fault-tolerance drill (Ch 02, un-cut fault tolerance).
5. **McpDataSource + AuthProvider generalization — added.** Sessions A–D. The auth stopped being "the Bloomreach OAuth flow" and became an `OAuthClientProvider` interface with three shipped providers — `BloomreachAuthProvider` (PKCE + Dynamic Client Registration, still the default preset), `BearerAuthProvider` (user-supplied token for MCPs that expose one), `AnonymousAuthProvider` (no auth). `McpDataSource` accepts any provider, and `components/settings/McpConfigModal.tsx` lets the user point the whole app at any MCP URL with any provider — no code change, no env change. **This is the strongest problem-selection defense in the whole guide.** The abstraction survived five real pressures — not just four; the fifth one was the widest (identity, not just data shape), and no caller changed.

Five shipped uses, no agent code changed. That's the port/adapter pattern earning its keep. And use #5 turned the seam from "we can swap the data source" into "we can swap the entire MCP identity of the app from the UI" — the abstraction covered a category of change (auth) it wasn't originally scoped for.

**The receipt-density on use #5, specifically.** The swappable-MCP work was itself a real choice — hardcoding Bloomreach forever would have been faster in the moment, and defensible up until the day an interviewer asks "can this hit my company's MCP server?" The un-hardcoded version cost roughly one day of work (Sessions A–D), preserved backward compatibility (the default preset is still Bloomreach with the existing PKCE + DCR flow untouched), and shipped three concrete providers behind one interface. The fact that ~1 day of work covered that surface — with the existing agents, existing tools, existing eval unchanged — is the receipt for the abstraction *quality*. A rougher seam would have cost a week to generalize; this one cost a day, because the port was already load-bearing everywhere it needed to be.

**Second-order receipt — the seam held under a real bug (Move 4, `cab85c6`, 2026-07-03).** The concurrent same-session `/api/briefing` drill converged on a last-writer-wins race in `putInsights`. Initial framing said "session-key the map" — reading the code showed the map was already session-keyed. Actual fix: a route-level in-flight gate via a new `lib/state/in-flight-briefings.ts` module (plus 8 tests). **The state module `insights.ts` was not touched.** That's the abstraction paying off a second time — the fix landed at the boundary the boundary was for, without disturbing the storage layer it wrapped. Test count moved 268 → 276.

**The interview line.** *"The DataSource seam looked speculative until it earned 5 uses without changing caller code: Olist add, Olist remove, Synthetic add, Fault-injecting decorator, and the McpDataSource + AuthProvider generalization that made the whole app swappable-MCP from a UI modal. That last one is the receipt I'd stake it on — an abstraction that survives a category of change it wasn't originally scoped for (auth, not just data) is the abstraction you keep."*

## Option 3 — NDJSON over fetch stream

**The choice.** Newline-delimited JSON events streamed over a `ReadableStream` from an HTTP endpoint, read on the client with `fetch` + a stream reader. Not Server-Sent Events. Not WebSockets.

**The alternative — Server-Sent Events + `EventSource`.**

Opportunity cost of *SSE + EventSource*:
- `EventSource` doesn't support POST — you can't send a request body with the streaming request. That means passing the request as URL params or setting up a two-request handshake (POST to create job, GET to subscribe). More moving parts.
- `EventSource`'s auto-reconnect is helpful when it fires and painful when it doesn't. The MCP alpha's token revocation would trigger reconnects with stale tokens, which is worse than a clean error.
- SSE's data frames must be text (base64 encoded for binary). Fine here since NDJSON is text, but constrains you if the payload ever needs binary.

Opportunity cost of *NDJSON over fetch*:
- No built-in reconnect — you write the retry logic yourself. In this codebase that's `app/page.tsx`'s auto-reconnect-once-on-`invalid_token`.
- Parsing is manual — you carry a buffer, split on newlines, JSON.parse each event.

**The evaluated evidence — 4-consumer readNdjson kernel.** The `readNdjson` function reads a stream and yields parsed events. It's used by 4 distinct consumers:
1. The feed page consuming `/api/briefing`.
2. The diagnose page consuming `/api/agent?step=diagnose`.
3. The recommend page consuming `/api/agent?step=recommend`.
4. The dev capture path consuming `/api/agent` (combined run).

One parsing kernel, four consumers, one wire format (`AgentEvent` — see `lib/mcp/events.ts`). That's the shipped abstraction receipt — the parser earned its shape by being reused unchanged.

**The interview line.** *"NDJSON over `fetch` because `EventSource` doesn't support POST bodies and its auto-reconnect fights the MCP alpha's token revocation. The `readNdjson` kernel has 4 consumers with one wire format. Reuse without modification is how you know the abstraction is real."*

## Option 4 — Portfolio hardening plan sequencing

**The choice.** 6 phases over 4 weeks. Each phase has an explicit ordering rationale — earlier phases unlock later ones. Per-week reading discipline (docs + repo dive before writing code). Per-session commit hygiene (small commits, receipts in commit messages).

**The alternative — build features until something ships, then harden reactively.**

Opportunity cost of *reactive hardening*:
- You harden the parts you notice, not the parts that matter. Squeaky-wheel maintenance.
- No baseline to measure against, so "I fixed X" has no proof.
- Portfolio narrative becomes "here are the parts I got around to" instead of "here's the flywheel I built."

**The sequencing that actually shipped.** Each phase is ordered because the previous phase's receipt is the next phase's foundation:

```
  6 phases, ordered by dependency

  ┌─ Phase 1: EVAL ─────────────────────────┐
  │  goldens, rubrics, blind calibration,   │
  │  regression gate                         │
  │  → unlocks: measured baseline            │
  └──────────────┬───────────────────────────┘
                 │
  ┌─ Phase 2: OBSERVABILITY ────────────────┐
  │  per-run receipts, aggregation script    │
  │  → unlocks: cost + latency numbers       │
  └──────────────┬───────────────────────────┘
                 │
  ┌─ Phase 3: COST ─────────────────────────┐
  │  prompt caching, pricing helper,         │
  │  BudgetTracker check-before-dispatch     │
  │  → unlocks: fail-closed cost bound       │
  └──────────────┬───────────────────────────┘
                 │
  ┌─ Phase 4: FAULT TOLERANCE ──────────────┐
  │  FaultInjectingDataSource decorator      │
  │  → unlocks: 4th shipped use of the seam  │
  └──────────────┬───────────────────────────┘
                 │
  ┌─ Phase 5: REGRESSION GATE ──────────────┐
  │  eval:gate vs committed baseline         │
  │  → unlocks: CI can block on quality      │
  └──────────────┬───────────────────────────┘
                 │
  ┌─ Phase 6: CI INTEGRATION ───────────────┐
  │  gate wired to PR flow                   │
  │  → unlocks: portfolio-defensible flywheel│
  └──────────────────────────────────────────┘
```

Each phase's output was the next phase's input. Phase 1 without Phase 2 has no way to aggregate. Phase 2 without Phase 3 has no cost lever to pull. Phase 5 without the earlier phases has nothing to gate against.

**Per-week reading discipline.** Before each phase, read the relevant docs (Anthropic caching docs before Phase 3, Vercel streaming docs before Phase 2 obs). The reading isn't performance — it's the reason the code shipped correctly the first time instead of the third.

**Per-session commit hygiene.** Small commits with receipts in the commit messages. Not "wip" and not "cleanup." Each commit stands as an audit trail of what was tried, what worked, what was reverted.

**The interview line.** *"The hardening plan wasn't 'do these things eventually.' It was 6 phases ordered by dependency — each phase's output was the next phase's input. Phase 1 (eval) was the foundation because it gave me a baseline to measure everything else against."*

**The negative-result receipt on the flywheel (Move 3, `be05240`, 2026-07-03).** The clearest evidence that the sequencing wasn't ornamental is a drill where the eval *caught the mistake*. The multi-agent handoff drill isolated a fingerprint (4/6 baseline runs targeting a `supported: false` hypothesis) and shipped `filterSupportedHypotheses` at the handoff boundary. The full 10-case eval regressed all 4 recommendation dimensions by 13–23pp. Reverted. Tombstone at `lib/agents/recommendation.ts:15-25`. The mental-model fix was wrong; the gate was the safety net. That's the flywheel doing its job — not the flywheel getting shown off.

## The pattern — how to defend option choices in general

The move that works in the review room:

1. **Name the option you picked.** Direct.
2. **Name the alternative you rejected.** Specific — not "some other approach," but *the* alternative.
3. **Name the opportunity cost of BOTH.** Yours *and* theirs. Owning your cost is the credibility move.
4. **Name the evidence that closes the loop.** For each pick above, the closing evidence is a *shipped receipt* — 5 uses of the seam, 4 consumers of the parser, 6 phases with their gate to CI, aptkit + legacy files both in the tree.

Every option in this file follows that shape. Every option you'll be asked about should.
