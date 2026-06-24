# Retrieval routing

**Industry name(s):** Retrieval routing, multi-source retrieval, source selection, retriever dispatch, polyglot retrieval
**Type:** Industry standard · Language-agnostic

> When you have more than one knowledge source — a vector index, a SQL warehouse, a web search, a live API — a router picks which source to retrieve from before retrieving. blooming insights has *one* source (Bloomreach via MCP), so source-level routing doesn't apply; the adjacent pattern that *does* live here is the coverage gate (`lib/agents/categories.ts`), which routes the monitoring agent toward the subset of anomaly categories the workspace's schema can actually support — a pre-retrieval *capability* route.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Retrieval routing would sit at the seam between the Shared agent loop and the Tools band — a dispatcher that reads the query, picks the right retrieval *source* (vector vs SQL vs web search), and only then fires retrieval. In blooming insights, there is no source-routing because there is only one source (Bloomreach MCP). What does exist at roughly this slot is a *capability* router: `filterToolSchemas` (`lib/mcp/tools.ts`) hands each agent a different subset of the same MCP toolset based on the agent's role. Same dispatch shape (route → tool subset), different axis (capability per agent, not source per query).

```
  Zoom out — where retrieval routing WOULD live

  ┌─ Shared agent loop ─────────────────────────────┐
  │  runAgentLoop emits a tool_use block             │
  └─────────────────────────┬────────────────────────┘
                            │  query shape
  ┌─ Retrieval router ──────▼────────────────────────┐  ← ★ THIS ★ (absent as source-router)
  │  ★ vector? SQL? web? — pick by query shape ★      │  ← we are here
  │  ── absent in blooming insights ──                │
  │  closest analog: filterToolSchemas in             │
  │  lib/mcp/tools.ts (capability routing per agent)  │
  └─────────────────────────┬────────────────────────┘
                            │  routed tool call
  ┌─ Tools + MCP transport ─▼────────────────────────┐
  │  lib/tools/* (one source: Bloomreach MCP)        │
  │  lib/mcp/client.ts                               │
  │  Not yet implemented: multi-source retrievers     │
  └─────────────────────────┬────────────────────────┘
                            │  HTTPS
  ┌─ External ──────────────▼────────────────────────┐
  │  Bloomreach MCP server (the only source)         │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when there's more than one place the answer could live, what picks the right source before retrieval runs? Vector for paraphrase, SQL for exact lookup, web for freshness — pick wrong and the strong retriever never gets called. blooming insights does NOT implement source routing (one source — Bloomreach MCP) but it does route on a different axis: per-agent capability via `filterToolSchemas`. Below, you'll see the source-routing pattern and how blooming insights' capability routing sits in the same architectural slot for a different reason.

---

## Structure pass

**Layers.** A would-be retrieval router has four layers: the **Agent loop** (emits a "I want to retrieve about X" intent), the **Source router** (reads the query shape, picks among vector / SQL / web / live API), the **Retrievers** (one per source), and the **Sources** (the actual stores). In blooming insights only one source exists (Bloomreach MCP), so the Source-router band collapses; what lives at the same architectural slot is `filterToolSchemas` — a *capability* router that hands each per-agent definition a different tool subset of the same source.

**Axis: control.** Who decides which retrieval source (or which tool subset) the query goes to — the model picking from a full menu every time, or a router that pre-filters based on something deterministic about the request? This is the right axis because retrieval routing is *literally a control-flow placement question* about the retrieval dispatch step. Cost is downstream (you route to avoid paying the wrong retriever); lifecycle is downstream too (you route to hit the freshest source). Control is what the axis traces.

**Seams.** Two seams matter, and the first is load-bearing in the WOULD-BE shape. Seam 1 sits between the Agent loop and the Source router — control flips from MODEL (intent) to CODE (which source matches). That seam IS retrieval routing; remove it and you're back to "agent calls one retriever or none." Seam 2 sits between the Source router and the Retrievers — control stays in CODE on both sides (route → call), so it's cosmetic. In blooming insights the source-router collapses and Seam 1 sits instead at *agent-construction time* (CODE picks the tool subset for each agent role) rather than at *per-query time*. The flip is the same shape; the moment it happens is earlier.

```
  Structure pass — Retrieval routing (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Agent loop (intent)                           │
  │  Source router (picks vector/SQL/web/live)     │
  │  Retrievers (per source)                       │
  │  Sources (the actual stores)                   │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides the retrieval source?    │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Agent loop ↔ Source router            │
  │          (MODEL → CODE) ★ load-bearing —       │
  │          this IS retrieval routing             │
  │  Seam 2: Source router ↔ Retrievers            │
  │          (CODE → CODE) cosmetic                │
  │  In this repo: Seam 1 lives at agent-          │
  │  construction time as filterToolSchemas        │
  │  (capability route, not source route)          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it (and where the same dispatch flip lives at a different moment in this codebase).

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

The technical distinction: routing decides *which source to ask*; the relevance grader (covered in the self-corrective RAG note) decides *whether the answer that came back is any good*. They sit at different layers of the same retrieval loop, and conflating them is a common mistake.

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

The technical thing: there is exactly one knowledge source in this codebase — Bloomreach via the MCP transport (the MCP client wrapper and its tool schemas). Every agent retrieves through the same analytics tool (or its siblings) against the same backend. There's nothing to route *between* at the source layer.

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

The condition under which the absence is okay: the one source covers the question surface. The typed analytics query language can answer every analytics question the agents currently ask. The day a question shape lands that it can't express (free-text similarity, real-world freshness), the source-routing pattern earns its place beside what's already here.

### What blooming insights has *adjacent* — the coverage gate, a capability route

The technical thing: there's a different kind of routing here — a pre-retrieval *capability* gate that filters the monitoring agent's anomaly checklist to the categories the workspace's schema can support before any retrieval happens. It's not picking *which source* (there's one); it's picking *which questions the source can answer* before the agent spends its budget.

If you're coming from frontend, this is feature-flag gating before render. You don't ship the feature into a UI whose dependencies aren't available — you check the schema (or the user's permissions, or the workspace's plan) first and only show the entry points that work. The gate is *upstream* of the loop, and it prunes the input space before the loop runs.

```
The coverage gate — capability routing, not source routing

  ┌─────────────────────────────────────────────────┐
  │ workspace schema (events present, properties)   │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ schema_capabilities()                            │
  │ → Set<string>: events + 'catalog:<name>'         │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ coverage_for(cat, available)                     │
  │ → 'full' | 'limited' | 'unavailable'             │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │ runnable_categories()                            │
  │ → only full + limited categories                 │
  └────────────────────┬────────────────────────────┘
                       ▼
  monitoring agent loop spends its tool-call budget
  on RUNNABLE categories only
   (briefing route hands the gate's result to the agent)
```

The practical consequence: the coverage gate prunes the monitoring agent's question space *before* the agentic-RAG loop spends a turn. The agent never wastes a tool call asking about `view_item` in a workspace that doesn't emit `view_item` — the gate already filtered that category out. This is routing in the broader sense (pick the right next action based on a pre-check), at the *capability* layer rather than the *source* layer.

The condition under which the gate works: the schema has to be authoritative about what's queryable. The MCP server returns the workspace's events and catalogs; if the workspace genuinely emits an event but the schema is stale, the gate falsely marks the category unavailable. The mitigation is treating the schema bootstrap as the route's premise check (it runs once per investigation).

Cross-reference: the broader capability-gating pattern (capabilities → permitted actions) lives in the ai-engineering capability-gating note. This file covers it specifically as an *adjacent* shape to retrieval routing, named because it's the closest thing to routing the codebase has.

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
│ analytics tool call              │  │   ├─ semantic match? → vector store   │
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

This is what people mean when they say "a single vector store is rarely the whole answer." Production retrieval is often a mix of vector for semantic, SQL for exact, and web for fresh, and the router is what makes the mix work without each query trying every source. blooming insights doesn't need that yet because it sits at the other end of the spectrum: one source, structurally fitted to the question shape it serves.

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
  │   coverage gate (workspace-schema-aware capability route)    │
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
  │ AGENTIC-RAG LOOP (the shared agent loop)                      │
  │   model picks tool_use against the SELECTED retriever         │
  │   observes the result, decides next call or stops             │
  └──────────────────────────────────────────────────────────────┘

  WHAT THIS CODEBASE HAS:
    capability gate — runs ONCE before the loop;
                      prunes which anomaly categories are runnable
                      against this workspace
    one retriever (Bloomreach via MCP) — no source fork to route between

  WHAT IT DOESN'T HAVE:
    source router — there's only one source; the dispatch would be
    a no-op until a second source ships
```

---

## Implementation in codebase

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

## See also

→ 01-agentic-rag.md · → 02-self-corrective-rag.md · → `../01-reasoning-patterns/06-routing.md` · → `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
