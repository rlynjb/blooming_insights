# Retrieval routing

**Industry name(s):** Retrieval routing, multi-source retrieval, source selection, retriever dispatch, polyglot retrieval
**Type:** Industry standard · Language-agnostic

> When you have more than one knowledge source — a vector index, a SQL warehouse, a web search, a live API — a router picks which source to retrieve from before retrieving. blooming insights has *one* source (Bloomreach via MCP), so source-level routing doesn't apply; the adjacent pattern that *does* live here is the coverage gate (`lib/agents/categories.ts`), which routes the monitoring agent toward the subset of anomaly categories the workspace's schema can actually support — a pre-retrieval *capability* route.

**See also:** → 01-agentic-rag.md · → 02-self-corrective-rag.md · → `../01-reasoning-patterns/06-routing.md` · → `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md`

---

## Why care

You wrote a `useUser()` hook that pulls user data. Behind the hook is one data source — a `/api/me` endpoint, say — and the hook always calls it. The same shape is in your reducer: `state.user`, one slot, one source of truth. You don't think about "which source" because there is only one.

Now picture a different shape. You have a search input, and behind the input are three places the answer could live: a `users` table (exact lookups by email), an Algolia index (typo-tolerant search by name), and a web search (when the user types a brand or a public name). Hit the wrong one and you waste a query or return nothing — Algolia returns empty for a UUID, the `users` table returns empty for a typo, the web search returns nothing for an internal email. You can't run all three on every keystroke. So *something* has to look at the query and pick the right source first.

That's the question this file answers: **when there's more than one place the answer could live, what picks the right one before the retrieval happens?** Not "what's the best retriever" — they're each best at something different. The line is at *dispatch*: a router that reads the query and routes it to the source whose shape fits.

**Why answering that question matters:** because retrievers have non-overlapping strengths. Vector indexes are good at paraphrase ("a customer wrote 'cancel my subscription'" matches "I want to unsubscribe") and bad at exact lookups. SQL is good at exact lookups and bad at semantic match. Web search is good at freshness and bad at private data. Pick the wrong source and the strong retriever for *that question* never gets called. The cost isn't slower retrieval — it's an empty top-k from the wrong source masquerading as "no answer found."

Without routing:
- The system has one retriever (say, a vector index) and uses it for everything
- A user asks "what's the SKU for product X" — the vector index returns the chunk that *mentions* the product, not the SKU itself
- The model answers from the chunk's prose, which paraphrases or hallucinates the SKU
- The answer is plausible-looking and wrong; the SQL table where the SKU lives was never consulted

With routing:
- The system has a router that reads "what's the SKU for product X" and recognises an exact-lookup shape
- It routes to the SKU table, returns the row, the model cites the value
- The vector index never gets the wrong question; the SQL DB gets the right one

One-line summary: **retrieval routing is `if/else` over data sources — the same dispatch you'd write in a request handler, but the chooser sits between the question and the retriever, and the inputs are query shapes rather than HTTP verbs.** Here's the shape of the pattern, and why this codebase has a *capability* route but not a *source* route (because there's only one source).

---

## How it works

**The mental model: a request handler whose route is decided by the query's shape.** You've already built this on the frontend — a search bar that fires different fetches based on input pattern. If the input matches an email regex, hit `/api/users/by-email`. If it starts with `#`, hit `/api/issues`. If it's a free string, hit Algolia. The router *isn't* the retriever; it's the dispatch step in front of the retriever, picking which one runs.

```
The mental model — a dispatch table between question and retriever

  question
     │
     ▼
  ┌─────────────────────────────┐
  │ ROUTER                       │
  │   read the query's shape;    │
  │   pick which retriever to    │
  │   call                       │
  └────┬───────┬───────┬─────────┘
       ▼       ▼       ▼
   vector    SQL     web
   (semantic)(exact) (fresh)
       │       │       │
       └───────┼───────┘
               ▼
            result
```

The strategy in plain English: **two stages, not one — pick the source, then retrieve.** The "retrieve" step is what agentic RAG already covers (the loop, the tool calls, the observations). Routing is the step *in front of* that, when the loop has more than one retriever it could pick from. Without multiple retrievers, the router collapses to a constant — "there's only one place to look, so look there."

### Heuristic-first, LLM-fallback — the production shape

The technical thing: production routers usually run two layers — a deterministic heuristic at the front (regex, rules, schema lookups) catching the high-volume predictable cases, and an LLM router at the back catching the ambiguous ones. The split exists because most queries fit a pattern (exact email → SQL, free text → vector) and the model only earns its cost on the queries the rules can't classify.

If you're coming from frontend, this is the same shape as `if (input.match(/^\d+$/)) fetchOrderById(input); else if (input.includes('@')) fetchUserByEmail(input); else searchAlgolia(input)` — except when none of the rules fire, you fall back to a smarter classifier instead of guessing.

```
Two-layer router

  query
    │
    ▼
  ┌─────────────────────────────┐
  │ Heuristic router            │  regex / rules / lookups
  │ ~95% of traffic              │  fast, deterministic, free
  └──┬──────────────────────┬───┘
     │ match                │ no match
     ▼                      ▼
  retriever picked      ┌─────────────────────────────┐
  (vector / SQL / web)  │ LLM router                   │
                        │ ~5% of traffic               │
                        └────────────┬─────────────────┘
                                     ▼
                              retriever picked
```

The practical consequence: the heuristic handles the bulk of queries at zero LLM cost; the LLM only runs on the queries the heuristic can't classify. The cost is one extra layer (you maintain the rules); the win is bounded LLM spend on routing decisions.

The condition under which it works: the rules have to be cheaper *and* mostly right. If the heuristic mis-routes 30% of queries, you've added a layer that's worse than just using the LLM router for everything. Tune the rules against a labelled trajectory set, the same way you'd tune any classifier.

### What routing is NOT — the relevance grader's other job

The technical distinction: routing decides *which source to ask*; the relevance grader (`02-self-corrective-rag.md`) decides *whether the answer that came back is any good*. They sit at different layers of the same retrieval loop, and conflating them is a common mistake.

If you're coming from frontend, routing is the URL the request goes to. The grader is "the response came back, was its body shape what the UI needs." Both can fail; their fixes are different.

```
Two different gates on the same loop

  question
     │
     ▼
   ROUTING (which source?)      ◄── this file
     │
     ▼
   retrieve from that source
     │
     ▼
   GRADER (relevant + grounded?) ◄── 02-self-corrective-rag.md
     │
     ▼
   pass → generate / fail → fall back
```

The practical consequence: a router miss puts you at the wrong source (the answer was never reachable); a grader miss approves a chunk that shouldn't have been used (the answer was reached but wrong). You need both for full coverage when you have multiple sources *and* a fuzzy retriever; you need neither when there's one source and structural retrieval like EQL.

### What blooming insights has — one source, no source router

The technical thing: there is exactly one knowledge source in this codebase — Bloomreach via the MCP transport (`lib/mcp/client.ts`, `lib/mcp/tools.ts`). Every agent retrieves through the same `execute_analytics_eql` (or its siblings) against the same backend. There's nothing to route *between* at the source layer.

If you're coming from frontend, this is the case where your `useUser()` hook reads from `/api/me` and only `/api/me`. You don't need a router because there's no fork.

```
Source layer — one source, no fork

  question
     │
     ▼
  one retriever (Bloomreach via MCP)
     │
     ▼
  result
```

The practical consequence: the source-routing pattern this file teaches doesn't apply to this codebase *yet*. The day a second knowledge source goes in — a vector store over past investigations, a web search for fresh PR mentions, a local SQL cache — the router becomes necessary; until then, dispatching to one source is a no-op.

The condition under which the absence is okay: the one source covers the question surface. EQL against Bloomreach can answer every analytics question the agents currently ask. The day a question shape lands that EQL can't express (free-text similarity, real-world freshness), the source-routing pattern earns its place beside what's already here.

### What blooming insights has *adjacent* — the coverage gate, a capability route

The technical thing: there's a different kind of routing here — a pre-retrieval *capability* gate (`lib/agents/categories.ts`) that filters the monitoring agent's anomaly checklist to the categories the workspace's schema can support before any retrieval happens. It's not picking *which source* (there's one); it's picking *which questions the source can answer* before the agent spends its budget.

If you're coming from frontend, this is feature-flag gating before render. You don't ship the feature into a UI whose dependencies aren't available — you check the schema (or the user's permissions, or the workspace's plan) first and only show the entry points that work. The gate is *upstream* of the loop, and it prunes the input space before the loop runs.

```
The coverage gate — capability routing, not source routing

  ┌─────────────────────────────────────────────────┐
  │ workspace schema (events present, properties)   │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ schemaCapabilities()    L121–127                │
  │ → Set<string>: events + 'catalog:<name>'         │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ coverageFor(cat, available)  L131–136            │
  │ → 'full' | 'limited' | 'unavailable'             │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ runnableCategories()   L158–160                  │
  │ → only full + limited categories                 │
  └────────────────────┬────────────────────────────┘
                       ▼
  monitoring agent loop spends its 6-call budget on
  RUNNABLE categories only
   (briefing/route.ts L203–L204)
```

The practical consequence: the coverage gate prunes the monitoring agent's question space *before* the agentic-RAG loop spends a turn. The agent never wastes a tool call asking about `view_item` in a workspace that doesn't emit `view_item` — the gate already filtered that category out. This is routing in the broader sense (pick the right next action based on a pre-check), at the *capability* layer rather than the *source* layer.

The condition under which the gate works: the schema has to be authoritative about what's queryable. Bloomreach's MCP returns the workspace's events and catalogs; if the workspace genuinely emits an event but the schema is stale, the gate falsely marks the category unavailable. The mitigation is treating the schema bootstrap as the route's premise check (it runs once per investigation at `bootstrapSchema`).

Cross-reference: the broader capability-gating pattern (capabilities → permitted actions) lives in `study-ai-engineering`'s `04-agents-and-tool-use/07-capability-gating.md`. This file covers it specifically as an *adjacent* shape to retrieval routing, named because it's the closest thing to routing the codebase has.

### Phase A vs Phase B — where source routing would slot in

Right now the agents retrieve from one source via one MCP transport. Naming where a router *would* sit clarifies what the second source would buy and cost.

```
        Phase A (now — one source)         Phase B (multi-source, with router)
┌──────────────────────────────────┐  ┌──────────────────────────────────────┐
│ question                          │  │ question                              │
│   ▼                              │  │   ▼                                   │
│ coverage gate (capability route) │  │ coverage gate (capability route)     │
│   ▼                              │  │   ▼                                   │
│ agentic loop                     │  │ SOURCE ROUTER (new!)                  │ ←
│   ▼                              │  │   ├─ exact analytics? → Bloomreach MCP│
│ execute_analytics_eql            │  │   ├─ semantic match? → vector store   │
│   (one source)                   │  │   └─ freshness? → web search          │
│                                  │  │   ▼                                   │
│                                  │  │ agentic loop with selected retriever  │
└──────────────────────────────────┘  └──────────────────────────────────────┘
   coverage gate identical in both — capability routing stays;
   the new layer is SOURCE routing, only valuable with >1 source
```

*Phase A (now):* one source means one retriever. The coverage gate already prunes the agent's question space; nothing else to route. Cheap, simple, no extra layer to maintain.

*Phase B (with a second source):* a vector store over past investigation narratives, say, ships beside the live Bloomreach tool. Now the agent has two retrievers and "which one for this question" is a real decision. The heuristic-first / LLM-fallback router slots in front of the agentic loop's tool-pick step; the agentic-RAG loop itself doesn't change shape — it just gains a "which retriever did the router say" parameter.

The takeaway: **the coverage gate is the routing this codebase needs; source routing is the routing it would need if it added a second source.** Naming both makes the pattern's absence honest — there's no source router because there's no fork to route to.

This is what people mean when they say "a single vector store is rarely the whole answer." Production retrieval is often a mix of vector for semantic, SQL for exact, and web for fresh, and the router is what makes the mix work without each query trying every source. blooming insights doesn't need that yet because it sits at the other end of the spectrum: one source, structurally fitted to the question shape (analytics) it serves.

The full picture is below.

---

## Retrieval routing — diagram

```
Canonical retrieval routing (multi-source) — and where this codebase sits

  question
     │
     ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ CAPABILITY GATE (this codebase)                              │
  │   coverage gate (`lib/agents/categories.ts`)                 │
  │   prunes the agent's question space against the workspace    │
  │   schema BEFORE the agentic loop spends its budget           │
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ SOURCE ROUTER (not in this codebase — only one source)        │
  │                                                                │
  │   Heuristic layer   →  ~95% of traffic, regex / rules         │
  │       │                                                        │
  │       └─ no match  →  LLM router  →  ~5% of traffic            │
  │                                                                │
  │   Picks one of:                                                │
  │     ├─ vector index   (semantic / paraphrase)                  │
  │     ├─ SQL DB         (exact / structured lookups)             │
  │     ├─ web search     (freshness / public data)                │
  │     └─ live API       (current state of a system) ◄── this codebase
  └────────────────────────────┬─────────────────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ AGENTIC-RAG LOOP (`runAgentLoop`, `base.ts` L48–L176)         │
  │   model picks tool_use against the SELECTED retriever         │
  │   observes the result, decides next call or stops             │
  └──────────────────────────────────────────────────────────────┘

  WHAT THIS CODEBASE HAS:
    capability gate (categories.ts) — runs ONCE before the loop;
                                       prunes which anomaly categories
                                       are runnable against this workspace
    one retriever (Bloomreach via MCP) — no source fork to route between

  WHAT IT DOESN'T HAVE:
    source router — there's only one source; the dispatch would be
    a no-op until a second source ships
```

---

## In this codebase

**Case B — source-level retrieval routing is not implemented.** The honest sentence: there's only one knowledge source (Bloomreach via MCP), so there is no source-routing layer; if a vector store or web tool ships beside it, a router would slot in front of the agentic-RAG loop's tool-pick step.

What exists adjacent to the pattern (the pre-retrieval capability route):

**The capability gate**
**File:** `lib/agents/categories.ts`
**Function / class:** `schemaCapabilities()` → `coverageFor()` → `runnableCategories()`
**Line range:** L121–L127 (capability set), L131–L136 (per-category gate), L158–L160 (the runnable filter)

This is the closest thing to routing the codebase has. `schemaCapabilities` reads the workspace's available events and catalogs into a `Set<string>`. `coverageFor(cat, available)` is a pure gate: missing a hard dep (`requires`) → `'unavailable'`; missing only a soft dep (`enriches`) → `'limited'`; else `'full'`. `runnableCategories` filters the 10-category checklist to the subset the schema can support. This runs *before* the monitoring agent's agentic loop, pruning the question space upstream so the 6-call budget doesn't get spent on categories the data can't answer.

**The gate's caller**
**File:** `app/api/briefing/route.ts`
**Function / class:** the briefing stream `start()` body
**Line range:** L200–L204 (coverage computation and runnable filter), L222 (the streamed log "checking N of 10 categories")

The briefing route runs the coverage gate once per investigation and hands `runnable` (not the full registry) to the monitoring agent. The agent only ever sees the categories its workspace can support.

**The single retriever**
**File:** `lib/mcp/client.ts`, `lib/mcp/tools.ts`
**Function / class:** `McpClient.callTool` → MCP transport → Bloomreach
**Line range:** `client.ts` L97–L146 (the single retrieval path)

One source, one path. Every agent in this codebase retrieves through here. No fork above this layer to route between.

```
shape (not full impl):
  // app/api/briefing/route.ts — capability route runs BEFORE the loop
  const capabilities = schemaCapabilities(schema);     // L200ish
  const coverage = coverageReport(capabilities);        // L203
  const runnable = runnableCategories(capabilities);    // L204
  step(`checking ${runnable.length} of 10 categories…`);
  // monitoring agent gets ONLY runnable — its question space is pre-routed

  // A source router would slot HERE if a second retriever shipped:
  //   const source = pickSource(question);    // heuristic + LLM fallback
  //   await runAgentLoop({ mcp: source === 'analytics' ? mcpClient : vectorClient, ... });
```

---

## Elaborate

### Where this pattern comes from

Retrieval routing got named as a production pattern around the same time multi-retriever RAG systems started shipping (2023–2024). The textbook RAG paper assumes one retriever; the real world is messy — internal docs in a vector store, customer records in SQL, current events on the web, real-time state in a live API. The "polyglot retrieval" or "router agent" pattern came out of the observation that a single retriever is rarely sufficient and a naive "try them all" is wasteful. LangChain's `MultiRetriever` and `RouterChain`, LlamaIndex's `RouterQueryEngine`, and the broader Self-RAG family all encode the same idea: dispatch before retrieve.

### The deeper principle

Retrievers have non-overlapping competence. A vector index does paraphrase well and exact lookup badly. A SQL DB does the opposite. A web search does freshness. A live API does current state. The retrieval layer's quality ceiling is set by whether the right retriever ran on the right question, and the router is the thing that enforces that. Without a router, you either pick one retriever and accept the questions it can't answer well, or you fan out across all retrievers and pay the full cost on every query.

```
  retriever                competence                weakness
  ────────────             ──────────────            ─────────────────
  vector index             paraphrase / semantic     exact lookups, math
  SQL / structured DB      exact lookups, joins      paraphrase, fuzzy
  web search               freshness, public data    private / scoped data
  live API (this codebase) current state, exact      semantic similarity
```

### Where this breaks down

The router can mis-classify. A heuristic router built on rules will misroute the queries the rules don't cover; an LLM router will misroute when the query is ambiguous between two retrievers. Mitigation: log the route decision per query, sample the misroutes, refine the rules. A second failure: the router becomes a bottleneck — every query pays the routing cost, and an LLM-router with a slow model adds latency to every retrieval. Mitigation: cache the route decision (an exact-match cache of `query → source`) for repeated questions.

### What to explore next
- Agentic RAG (`01-agentic-rag.md`) → the loop the router would feed into
- Self-corrective RAG (`02-self-corrective-rag.md`) → the grader at the other side of retrieval
- Routing pattern in general (`../01-reasoning-patterns/06-routing.md`) → routing as a single-agent reasoning shape
- Capability gating: `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md` → the broader pattern the coverage gate instantiates

---

## Tradeoffs

The decision here was *whether to add a second knowledge source.* This codebase did not (Phase A, one source); the alternative is multi-source with a router (Phase B). The coverage gate is orthogonal to this choice — it exists in both phases.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ One source (chosen — now)   │ Multi-source + router       │
│                  │                             │ (alternative)               │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build time       │ zero — one MCP transport    │ second retriever stack +    │
│                  │                             │ router + dispatch wiring    │
│ Per-query layers │ capability gate → retrieve  │ capability gate → SOURCE    │
│                  │                             │ ROUTER → retrieve            │
│ Routing cost     │ none                        │ heuristic: ~0; LLM fallback:│
│                  │                             │ +1 model RTT on hard queries│
│ Question surface │ what EQL can express        │ EQL + vector + web + …      │
│ Ops burden       │ one source to monitor       │ N sources + router metrics  │
│ Failure modes    │ "EQL can't answer this"     │ misroute, source down,      │
│                  │ → answer is "not in scope"  │ router miss, fanout cost    │
│ Cost of "wrong"  │ contained: no answer found  │ silent: routed to wrong     │
│ source pick      │                             │ source, wrong answer        │
│ Cost of capacity │ EQL cap = analytics surface │ unbounded (add another      │
│                  │                             │ source any time)            │
│ Debuggability    │ one source, one trajectory  │ trajectory + route decision │
│                  │                             │ per query                   │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up coverage of any question shape that isn't expressible as EQL. Anything that requires free-text similarity (find investigations similar to this one), real-world freshness (what did press say about the company today), or content from outside the workspace (industry benchmarks) — none of those have a retriever today and nothing in the loop would route to one if it existed.

We also gave up the routing layer's flexibility. If a new source ships, it has to be added everywhere the agents bind to MCP — there's no single "dispatch table" the new retriever slots into. The cost of the second source is the source itself plus the router we didn't build.

### What the alternative would have cost

If we had built source routing day one, we would have shipped a router with no second source to route to — a no-op layer adding latency and code without buying anything. The router only earns its place once there are at least two sources whose competences don't overlap; building it eagerly is over-engineering for capacity we don't need.

### The breakpoint

Add the router the moment a second source ships. The specific signals: (a) a feature lands that can't be expressed in EQL (semantic search over narratives, web-fetched comparisons, anything outside the live analytics surface), AND (b) you build a retriever for it. That's the day "which source for this question" becomes a real decision and the heuristic-first / LLM-fallback shape earns its overhead.

### What wasn't actually a tradeoff

"Just use the vector store for everything once we add it" is not a real alternative. A vector store is good at paraphrase and bad at exact aggregates; routing analytics questions to it would silently return paraphrased prose instead of exact counts. The retriever-strength asymmetry is the whole reason routing exists — if one retriever covered everything, you'd just use it. Multi-source isn't a power move; it's a response to retrievers having non-overlapping competence.

---

## Tech reference

### MCP (Model Context Protocol)

- **Codebase uses:** `lib/mcp/client.ts` and `lib/mcp/transport.ts` wrap the single MCP transport; all retrieval goes through it.
- **Why it's here:** MCP is the source layer. Routing would sit *above* MCP (which retriever to call); MCP itself doesn't route — it transports.
- **Leading today:** MCP — adoption-leading for standardized tool/data integrations in agents, 2026.
- **Why it leads:** decouples the tool from the agent; a second MCP transport (a different source) drops in beside this one without touching the agent code, leaving only the router to build above.
- **Runner-up:** direct per-source SDK integrations — no protocol overhead, more glue code per source.

### LangChain / LlamaIndex routing utilities (the named pattern)

- **Codebase uses:** none — the codebase has one source and uses no routing library.
- **Why it's here:** these are where retrieval routing got its production-grade naming (`RouterChain`, `RouterQueryEngine`) and worked examples.
- **Leading today:** LangChain's routing primitives — adoption-leading for orchestrated multi-retriever apps, 2026.
- **Why it leads:** the routing layer ships with the framework; the cost of adopting routing is one component, not a custom dispatch table.
- **Runner-up:** custom heuristic + LLM fallback built per-app — less coupling to a framework, more code to maintain.

### Capability gating (the adjacent pattern)

- **Codebase uses:** `lib/agents/categories.ts` — `schemaCapabilities` (L121–L127), `coverageFor` (L131–L136), `runnableCategories` (L158–L160); consumed in `app/api/briefing/route.ts` L200–L204.
- **Why it's here:** it's the routing the codebase actually has — a pre-retrieval gate that prunes the agent's question space against the workspace's schema before the loop spends its budget.
- **Leading today:** schema-driven capability checks — adoption-leading for production agent systems with variable data shapes, 2026.
- **Why it leads:** pushes the "this isn't answerable" decision *above* the agent loop, where it's cheaper and visible in the UI (ghost tiles in the briefing grid), instead of letting the agent waste tool calls discovering it.
- **Runner-up:** letting the agent discover unavailability mid-loop — simpler to build, burns budget, harder to surface in the UI.

---

## Summary

Retrieval routing dispatches a query to the right knowledge source before retrieval happens — the heuristic-first / LLM-fallback shape catches the high-volume rules at zero LLM cost and falls through to a model classifier for the ambiguous queries. blooming insights has one source (Bloomreach via MCP), so source-level routing doesn't apply yet; the adjacent pattern that *is* here is the coverage gate in `lib/agents/categories.ts`, which routes the monitoring agent toward the subset of anomaly categories the workspace's schema supports — a pre-retrieval capability route that runs once per investigation in `briefing/route.ts` L200–L204. The router pattern earns its place the day a second knowledge source ships (vector over narratives, web search, anything EQL can't express); until then, dispatching to one source is a no-op and the capability gate is the routing decision worth making.

- Retrieval routing = `if/else` over data sources, decided before retrieve.
- Production shape is heuristic-first (regex/rules, ~95% of queries) with LLM fallback (the ambiguous ~5%).
- This codebase has *one* source and so no source router; it has *capability* routing via the coverage gate.
- The coverage gate prunes the question space upstream so the agent doesn't burn budget on unanswerable categories.
- Source routing earns its place when a second retriever ships (something EQL can't express + a stack to retrieve it).

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how does your system pick which knowledge source to use," they're testing whether you can name your retrieval topology honestly. The strong signal is naming how many sources you have, why, and what would change if you added a second. The weak signal is reciting LangChain's `RouterChain` without saying whether you actually have anything to route between.

### Likely questions

[mid] Q: How does this system pick which knowledge source to retrieve from?

A: There's one knowledge source — Bloomreach via MCP — so there's no source routing to do. Every retrieval is `execute_analytics_eql` against the same backend. What we *do* have, which is adjacent to routing, is a capability gate (`lib/agents/categories.ts`) that runs once per investigation: it reads the workspace's schema, checks each of the 10 anomaly categories against required events, and filters to the runnable subset before the monitoring agent's loop starts. So the agent's question space is *pre-routed* against what the source can actually answer — it just isn't pre-routed against *which* source, because there's only one.

Diagram:
```
  schema ─► capability gate ─► runnable categories ─► monitoring agent
              (categories.ts)        L158–160              (one source)
```

[senior] Q: Why didn't you add a vector store beside the live MCP?

A: Because there's nothing the agents currently ask that EQL can't answer. The retriever-strength tradeoff is real — a vector store wins at paraphrase and free-text similarity; EQL wins at exact aggregates and current state. Today every question is an aggregate or a current state, so the live tool is the right (and only) retriever. Adding a vector store eagerly would mean shipping a chunker + embedder + indexer + a router above them, all to handle a question shape no feature in the app produces. The breakpoint is a feature that *requires* paraphrase — say, "find past investigations similar to this one" — which is free-text narrative search, not analytics. The day that ships, the vector store goes in and the router above it goes in with it.

Diagram:
```
   Today                            When a second source earns its place
   ─────                            ────────────────────────────────────
   one retriever (EQL)              EQL + vector (narrative search)
   no router needed                 source router (heuristic + LLM fallback)
   coverage gate is the routing     coverage gate + source router (both)
```

[arch] Q: If you added a vector store tomorrow, what would the router look like in this codebase?

A: A heuristic layer first — regex on the question shape: an analytics phrasing ("conversion drop in the last 90 days") routes to EQL; a similarity phrasing ("similar to the spike we saw in March") routes to vector. An LLM fallback for the ambiguous ones. The router slots *above* `runAgentLoop` — specifically, the agent gets a `retriever` parameter the route handler picks, instead of binding directly to the MCP client. The agentic-RAG loop itself doesn't change shape; what changes is what `mcp.callTool` resolves to. The coverage gate stays where it is — it's a different layer (capability, not source) and it'd run on the EQL-routed branch only.

Diagram:
```
   question
      │
      ▼
   ┌──────────────────────────────┐
   │ heuristic router              │ regex on question shape
   └────┬────────────┬─────────────┘
        ▼ match      ▼ no match
   selected         ┌──────────────────┐
   retriever        │ LLM router        │
                    └──────┬───────────┘
                           ▼
                       selected retriever
        │
        ▼
   ┌──────────────────────────────┐
   │ runAgentLoop with that        │
   │ retriever (unchanged loop)    │
   └──────────────────────────────┘
```

### The question candidates always dodge
Q: Isn't the coverage gate just routing under a different name? Why not call it what it is?

A: Honest answer: it *is* routing, but at a different layer than the file's title pattern. The file is about *source* routing — pick which knowledge source to retrieve from when there are multiple. The coverage gate is *capability* routing — pick which questions to ask of the one source you have, given the workspace's schema. Both are "decide before retrieving," both prune the input space, both are `if/else` dispatches in front of the agentic loop. The reason I distinguish them: the source router scales by adding sources, the capability gate scales by adding categories. They have different breakpoints and different ops surfaces. Calling them both "routing" is correct in the abstract; in code, they live at different files and answer different questions, so naming the layer is what makes the distinction useful.

Diagram:
```
   layer of decision               what it picks                  where it lives
   ─────────────────               ──────────────────             ─────────────────
   source routing (this file)      which retriever to call        ABSENT here
   capability routing (adjacent)   which questions are askable    categories.ts
   relevance grading (next file)   was the answer any good        ABSENT here
```

### One-line anchors
- "Retrieval routing is `if/else` over data sources, decided before the retrieve step."
- "One source here, so no source router — but a capability gate prunes the question space upstream."
- "Heuristic-first plus LLM fallback is the production shape; rules catch the bulk, the model catches the ambiguous tail."
- "Breakpoint: a second knowledge source. Until then, the router is a no-op and the capability gate is the routing worth making."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the canonical retrieval routing diagram: question → router (heuristic + LLM fallback) → one of {vector, SQL, web, live API} → agentic loop. Now mark where this codebase actually has logic and where the absence is — the capability gate goes upstream of the loop, the source router is absent.

Open the file. Compare.

✓ Pass: you drew the two-layer router, put the capability gate in the right place (upstream, capability-not-source layer), and labelled the source router as absent because there's one source
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague asks: "wait, you said no routing, but the briefing page shows ghost tiles for categories that can't run — isn't *that* routing?" No notes. Under 90 seconds.

Checkpoints — did you:
- Distinguish source routing (pick which retriever) from capability routing (pick which questions are askable of the one retriever)?
- Name the coverage gate (`categories.ts` `schemaCapabilities` → `coverageFor` → `runnableCategories`) as the capability route?
- Say why source routing doesn't apply here (one source, EQL covers the surface)?
- Name the breakpoint where source routing would earn its place (a second retriever for a question shape EQL can't express)?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: users can ask "find investigations similar to the one I'm looking at right now." Without opening the code: which retriever shape does this need, where does the source router slot in, and what happens to the coverage gate?

Write your answer (4–6 sentences). Then open `app/api/briefing/route.ts` L200–L204 and `lib/agents/base.ts` L48 to see where the router would intercept versus where the coverage gate stays put.

### Level 4 — Defend the decision you'd change
"You said source routing doesn't apply because there's one source. If you had to ship a second source tomorrow with the same 60s investigation budget and the same 1.1s MCP spacing, what's the cheapest router you'd add and what would it cost per query? Where do the rules go, where does the LLM fallback go, and how do you keep both within budget?"

Reference the code: point to `categories.ts` L158–L160 for what the capability gate already does, and `runAgentLoop` (`base.ts` L48) for where the source decision would intercept the loop's retriever binding.

### Quick check — code reference test
Without opening any files:
- What file holds the coverage gate's `runnableCategories` filter?
- What route calls it, and where does the result go?
- What's the one source the agents retrieve from today?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
