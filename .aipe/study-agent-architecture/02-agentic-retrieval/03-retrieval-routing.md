# Retrieval routing

*Industry name: retrieval routing / multi-source routing — Industry standard.*

When there are multiple knowledge sources, pick the right one *before* retrieving. Not in this repo as retrieval routing per se — there's only one knowledge source (live Bloomreach data via MCP). But the *same routing primitive* is what the URL router + intent classifier already do, just for picking tools and framings, not sources.

## Zoom out — where this concept would live

If multiple retrieval sources existed, the router would sit at the agent layer before the retrieval tool — either as a separate classification step or as a multi-tool grant where the model chooses the source per turn.

```
  Where retrieval routing WOULD live (hypothetical)

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  query → ┌──────────────────────────┐                    │
  │          │ retrieval router:        │ ← would live here   │
  │          │ which source for THIS Q? │                    │
  │          └──────────┬───────────────┘                    │
  │       ┌─────────────┼───────────────┐                    │
  │       ▼             ▼               ▼                    │
  │   vector store   live data      web search               │
  │   (history)      (Bloomreach)   (freshness)              │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **does the model pick the source, or does the router pick it for the model?**

```
  Two modes of retrieval routing

  Pre-route (separate step):                Tool-grant route (model picks):
  ──────────────────────────                ──────────────────────────────
  query → classify → pick source → retrieve  query → agent with N retrieval tools
                                                   model picks which to call per turn
  one extra LLM call (cheap)                no extra LLM call; broader tool surface
  source decision visible in trace          source decision is implicit in tool choice
```

In this repo, the same shape shows up at a different layer: the URL router picks the agent class, then the agent picks tools. Pre-route for the predictable decision, tool-grant for the per-turn decision.

## How it works

### Move 1 — the mental model

You know the database vs cache vs CDN routing every backend does — "this lookup hits Redis, this one hits Postgres, this one hits the edge." Retrieval routing for an agent is the same shape, except the router is either a cheap LLM call or a tool-grant decision. The pattern: each source has a comparative advantage; route by what the question needs.

```
  Retrieval routing — pick the source by the question's shape

  query → ┌──────────────────────────┐
          │ router: which source?    │
          └──────────┬───────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     vector DB    SQL DB     web search
     (semantic)   (exact)    (fresh)
        │            │            │
        └────────────┴────────────┘
                     ▼
                generate
```

### Move 2 — what this would mean in this repo

Hypothetically, blooming insights could have:
- **Bloomreach EQL** — live operational data (current state — purchase counts, revenue, funnel)
- **Past investigations corpus** — semantic search over markdown reports of past anomalies and their root causes (would need pgvector or a hosted store)
- **Bloomreach product docs** — semantic search for "how do I configure a scenario for cart abandonment" (would need a doc-ingest pipeline)
- **Live web search** — for freshness on, say, "did Black Friday happen this past weekend" (would need a search-API tool wrapper)

A retrieval-routing agent would dispatch:
- "What's our current conversion rate?" → Bloomreach (live)
- "Have we seen this kind of revenue drop before?" → past investigations (history)
- "What's the right way to configure a recovery scenario?" → product docs (knowledge)
- "Is there a known industry-wide outage today?" → web search (freshness)

None of this exists in the repo today. The query agent (`QueryAgent`) today has tools that all hit one source (Bloomreach), so there's no source decision to make — only a tool-pick decision within that source.

### Move 3 — the principle

A single vector store is rarely the whole answer. Production retrieval looks like routing between a vector store (paraphrase queries), a relational store (exact lookups), and live search (freshness). The cheapest implementation: heuristic-first — if the query matches a SQL-shaped pattern (numbers, dates, exact entities), use the relational store; otherwise fall through to vector search; escalate to web search only when the corpus can't answer freshness questions.

## In this codebase

**Not implemented in the retrieval-routing sense** (there's only one knowledge source). The same routing *primitive* shows up at higher layers:

- **URL router** (`07-routing.md`) picks the agent class based on the URL `?step=` param
- **Intent router** (`07-routing.md`) labels free-form queries with `monitoring`/`diagnostic`/`recommendation` framing

Both are routing. Neither is *retrieval* routing because retrieval-as-similarity-search is not part of this codebase's vocabulary — the only "retrieval" is tool calls to Bloomreach's analytics API.

## Primary diagram

The contrast:

```
  Comparison — today's routing vs hypothetical retrieval routing

  TODAY (URL + intent routing):
  ┌────────────────────────────────────────┐
  │  URL ?step= → DiagnosticAgent           │
  │  intent     → frame the QueryAgent      │
  │                                          │
  │  routes pick AGENT / FRAMING            │
  │  ONE knowledge source (Bloomreach EQL)  │
  └────────────────────────────────────────┘

  HYPOTHETICAL (retrieval routing):
  ┌────────────────────────────────────────┐
  │  query → classify by question shape:    │
  │   - operational (current state)         │
  │   - historical (past investigations)    │
  │   - reference (product docs)            │
  │   - freshness  (web)                    │
  │  → pick the matching source             │
  │  → retrieve → generate                  │
  └────────────────────────────────────────┘
```

## Interview defense

**Q: "Do you route between multiple knowledge sources?"**

A: Not in the retrieval-routing sense — there's only one source today (Bloomreach's live operational data via MCP). The same routing *primitive* shows up at a higher layer: the URL `?step=` parameter routes between agent classes, and a cheap haiku call (the intent classifier) labels free-form questions so the QueryAgent's prompt frames the answer correctly. If we ever added a corpus of past investigation reports or product docs, the right shape would be retrieval routing — a small classifier in front of the agent picking source by question shape (operational → SQL, historical → vector, reference → vector, freshness → web). The heuristic-first principle applies: route on the question's surface form first; fall through to an LLM router only when the surface form is ambiguous.

Anchor: "the route layer already does the routing primitive — it just routes to agents and framings, not to sources. The seam to add a second source is the agent's tool grant; the seam to add a router is the route handler."

## See also

- [`../01-reasoning-patterns/07-routing.md`](../01-reasoning-patterns/07-routing.md) — the routing primitive this repo already uses
- [`01-agentic-rag.md`](./01-agentic-rag.md) — what the routed retrieval would feed into
- [`../03-multi-agent-orchestration/02-supervisor-worker.md`](../03-multi-agent-orchestration/02-supervisor-worker.md) — supervisor's core job is routing at a different layer
