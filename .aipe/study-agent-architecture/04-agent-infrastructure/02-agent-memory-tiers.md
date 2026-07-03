# Agent memory tiers

_Industry standard._

## Zoom out, then zoom in

Memory as a dedicated component, separate from the context window. Working (in-context), episodic (recent runs), long-term (persistent knowledge). This repo has *working memory only* — the context of the current investigation. There's no episodic memory of prior runs, no long-term store of user preferences or facts. This file names why that's the right call for the current product surface, and what adopting each tier would require.

```
  Zoom out — what tiers exist in this repo

  ┌─ Working memory (in-context) ─── ★ THIS IS ALL BLOOMING HAS ──┐
  │  Current investigation's window: system prompt +               │
  │  Anomaly + Diagnosis + tool trace                              │
  │  Lifetime: one HTTP request; gone when the loop ends           │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ────── NOT IMPLEMENTED ────────────┐
  │  Would store: "user investigated X yesterday, concluded Y"      │
  │  Would be retrieved on relevant new investigations              │
  └────────────────────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ── NOT IMPLEMENTED ──────────┐
  │  Would store: durable facts, preferences, prior conclusions     │
  │  Would be a vector DB, semantic search on new tasks             │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the strongest signal in this codebase is what's deliberately absent. Blooming has "no database" as a design principle (see `.aipe/project/context.md`). Session state lives in in-memory `Map<sessionId, SessionFeed>`; investigations live in `sessionStorage` in the browser. That's fine for working memory — it's per-request, per-user, ephemeral. It doesn't extend to episodic or long-term.

## Structure pass

**Layers:** working (in-context) · episodic (recent, retrievable) · long-term (persistent, vector-indexed).
**Axis:** *how long does this memory need to survive, and who queries it?*
**Seam:** the boundary between context-window memory and store-backed memory. Working memory lives IN the prompt; episodic and long-term live OUTSIDE and get retrieved into it.

```
  The tier boundaries — lifetime + query pattern

  Tier          Lifetime          Storage             Query pattern
  ────────────  ───────────────   ────────────────    ──────────────
  Working       one request       context window      inline (whole thing)
  Episodic      hours to days     serialized log      retrieve by relevance
  Long-term     unbounded          vector DB / graph   semantic search
```

## How it works

### Move 1 — the mental model

You've written a React app with three shapes of state: component state (lives with the component, gone on unmount), `sessionStorage` (survives navigation within the tab), a backing database (survives everything). Agent memory tiers are the same instinct, at the agent layer. Working memory = component state. Episodic = `sessionStorage`. Long-term = backing store. Blooming has all three at the app layer, but only the *first* at the agent layer.

```
  Pattern: three-tier agent memory

  ┌─ Working ───────────────────────────────────┐
  │  in-context — same window as the LLM sees   │
  └─────────────────────────────────────────────┘
  ┌─ Episodic ──────────────────────────────────┐
  │  outside window — retrieved on demand        │
  │  scoped to recent, filtered by relevance    │
  └─────────────────────────────────────────────┘
  ┌─ Long-term ─────────────────────────────────┐
  │  outside window — retrieved on demand        │
  │  unbounded, semantic search                  │
  └─────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Working memory — what IS here.** The current investigation's context lives in the LLM's window and in the process. Two implementations back it:

- **Model side.** The prompt carries system prompt + anomaly + tool trace. AptKit's agent loop accumulates the trace turn by turn.
- **Process side.** `lib/state/insights.ts:14` — `const state = new Map<string, SessionFeed>()` — a per-session sub-map holding the current briefing's insights, investigations, and anomalies. Scoped to sessionId so it survives across HTTP requests within a session, but bounded to in-memory (dies with the Vercel instance).

```ts
// lib/state/insights.ts:14-23 — session-scoped working memory
const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Line-by-line:

- **`Map<string, SessionFeed>`** — outer key is sessionId (from cookie). This is the multi-tenant scope key; without it, one user's feed would clobber another's on a warm instance.
- **`SessionFeed` holds Insight/Investigation/Anomaly**. These are the artifacts an agent produces; retaining them means a follow-up request in the same session can look up "the insight I clicked" by id.
- **Purely in-memory.** Dies with the process. On a Vercel cold start, everything is empty. That's fine — the demo path serves committed snapshots, the live path re-fetches from Bloomreach.

**Episodic memory — NOT here, and here's what adopting would require.** An episodic layer would store recent investigations serialized, so a follow-up query ("show me the drops I investigated last week") could retrieve them. What would need to change:

- **Persistence.** In-memory `Map` → a database or an object store. Currently blooming has "no database" as a design principle. Adopting episodic would break that.
- **Retrieval.** By relevance to the current task — usually embedding-based similarity. That means an embedding pipeline and a vector index.
- **Retrieval trigger.** A tool-shaped entry point ("recall_prior_investigation") the agent can call, so retrieval is a control-loop decision, not a blanket inject.

The trigger to adopt this would be a product surface that spans investigations — e.g. "compare this drop to the drop from last month" or "did we already recommend this Bloomreach feature and did it work?" Neither is a current product goal.

**Long-term memory — NOT here, same reasoning.** A long-term layer would store durable facts: user preferences ("this analyst always cares about the checkout funnel"), verified prior conclusions ("we ran Scenario X in March, it lifted conversion 4%"), or workspace-specific patterns ("this workspace's mobile traffic peaks Sundays"). Adopting would need:

- **A vector DB** (Pinecone, pgvector, an embedded store).
- **A write pipeline** — decide when a fact is durable enough to persist. Blooming would probably want a human confirm step, not automatic ingestion.
- **A retrieval loop.** Same as episodic — semantic search on a tool call, not blanket injection.

The reason blooming doesn't have long-term today: every investigation is fresh. The product's value proposition is "an analyst that shows its work" for one moment in time. Cross-investigation learning is a natural next feature, but it's a next feature, not a v1 requirement.

**Why "no long-term" is defensible for now.** Bloomreach itself is the source of truth for durable data (customer profiles, events, catalog). Blooming's job is *reasoning* over that data. If a fact is durable, it belongs in Bloomreach's data model, not in a side-channel memory. If a fact is derived (a prior recommendation's effectiveness), it could live in an episodic tier — but only if the product surface asks for it.

```
  Layers-and-hops — the tiers, currently and hypothetically

  ┌─ Working memory (LIVE) ────────────────────────────────────┐
  │  system prompt + anomaly + tool trace (in LLM window)      │
  │  SessionFeed Map (per-session, in-process)                 │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Episodic (NOT LIVE) ──────────────────────────────────────┐
  │  Would need: durable store, embedding pipeline, tool entry │
  │  Would enable: "what did I investigate yesterday?"          │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Long-term (NOT LIVE) ─────────────────────────────────────┐
  │  Would need: vector DB + write policy + semantic retrieval │
  │  Would enable: prior-recommendation reuse, user preferences│
  └────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Memory tiers are earned, not adopted preemptively. Working memory is required — every agent has it by definition. Episodic and long-term are product features that need a specific reason to exist: "the user needs to reference something across sessions." Without that reason, they add complexity (retrieval, embeddings, storage) for no user-facing gain. Blooming has zero cross-investigation retrieval requirements today, so the tiers stop at working. When the product needs "compare this drop to last month's drop," episodic earns its keep. Until then, deferring is the right call.

## Primary diagram

```
  Recap — memory in this repo

  ┌─ Working memory (only tier that exists) ────────────────────┐
  │                                                             │
  │  In LLM window:                                             │
  │   - system prompt (cached)                                  │
  │   - Anomaly (current investigation input)                   │
  │   - Diagnosis (Stage B input, if step 3)                    │
  │   - tool_use ↔ tool_result trace (grows per turn)            │
  │                                                             │
  │  In process (SessionFeed Map):                              │
  │   - insights: Map<id, Insight>                               │
  │   - investigations: Map<id, Investigation>                   │
  │   - anomalies: Map<id, Anomaly>                              │
  │  Lifetime: warm Vercel instance; per-session scope           │
  └─────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ Episodic + Long-term (deferred) ───────────────────────────┐
  │  Trigger to adopt: cross-investigation product surface       │
  │  Cost: durable store, embeddings, retrieval loop             │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The design instinct behind blooming's "working memory only" is the same one behind "no database": defer state until the product forces it. Every stateful component adds a storage decision, a schema migration, a consistency question. If the product doesn't need that state, adding it is pure debt.

The failure mode this defers, honestly: no cross-session learning. If a user investigates the same checkout drop weekly, blooming re-derives every conclusion from scratch. That's wasteful token spend on repeat problems. An episodic layer would cut that — retrieve last week's diagnosis, tell the model "this is likely the same issue, verify quickly." Estimated saving: 30-50% on repeated investigations. Not adopted because the product hasn't seen that use pattern yet.

The other failure mode: no user personalization. Blooming can't learn "this analyst prefers segment recommendations over scenario recommendations." Every investigation starts cold. A long-term memory layer would fix that. Not adopted because the current interface doesn't ask for it — recommendations are all shown; the analyst picks.

The cross-reference to `study-ai-engineering`'s agent-memory file covers the two-layer short/long split; this file extends it to the three-tier model and names why blooming stops at tier one.

## Interview defense

**Q: What memory tiers does this system have, and where does it stop?**
A: Working memory only. In-LLM: system prompt + Anomaly + tool trace, all in the current window. In-process: a `Map<sessionId, SessionFeed>` in `lib/state/insights.ts` that holds the current session's insights, investigations, and anomalies — per-session scoped so users don't collide on a warm Vercel instance, purely in-memory so it dies with the process. No episodic tier (recent-session recall), no long-term tier (durable facts). Both would be natural next features, but neither has a current product surface asking for them. The design principle is "defer state until the product forces it" — same reason blooming has no database.

Diagram: the three-tier picture with only the working tier lit up.
Anchor: `lib/state/insights.ts:14-23`.

**Q: When would you add long-term memory, and what would you use for it?**
A: The trigger would be a product surface that spans investigations — "compare this drop to last month's" or "did we already recommend this feature and did it work?" Adopting means three moving parts: a durable store (pgvector inside a Postgres, probably; blooming has no database today so this is a real infra decision), an embedding pipeline for semantic retrieval, and a tool-shaped retrieval entry point (`recall_prior_investigation`) so the agent's control loop decides when to look back — not blanket inject. The write side needs a policy — I'd want a human confirmation step before facts become durable, not automatic ingestion. That last part matters: automatic ingestion of every conclusion means bad conclusions become "learned" facts, which is the classic RAG-poisoning failure.

Diagram: the three-tier picture with adoption arrows on episodic → long-term.
Anchor: general; refers to `.aipe/study-ai-engineering/` for RAG mechanics.

## See also

- `01-context-engineering.md` — how the working tier gets curated.
- `03-multi-agent-orchestration/08-shared-state-and-message-passing.md` — the shared-vs-message split that would extend to episodic if adopted.
- Cross-reference: `.aipe/study-ai-engineering/`'s agent-memory file for the two-layer short/long split.
