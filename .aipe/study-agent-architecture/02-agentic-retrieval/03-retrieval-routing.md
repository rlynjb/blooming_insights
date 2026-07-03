# Retrieval routing

*Industry name: retrieval routing / multi-source RAG · Language-agnostic*

## Zoom out

```
  Zoom out — retrieval routing chooses the source per query

  ┌─ query ─────────────────────────────────────┐
  │  "why did revenue drop in Texas last month?" │
  └───────────────────┬─────────────────────────┘
                      ▼
  ┌─ ★ RETRIEVAL ROUTING ★ ──────────────────────┐ ← we are here
  │  which knowledge source answers this?         │
  └───────────────────┬─────────────────────────┘
                      ▼
  ┌─ chosen source ──────────────────────────────┐
  │  analytics EQL / catalog / segment defs / …   │
  └──────────────────────────────────────────────┘
```

## Zoom in

When there are multiple knowledge sources, route the query to the right one before retrieving. A single vector store is rarely the whole answer in production; routing between a vector store (paraphrase queries), a relational store (exact lookups), and live search (freshness) is what production retrieval looks like. In this repo, "sources" means MCP tools (`execute_analytics_eql`, `get_segment_definitions`, `list_scenarios`, etc.) — same pattern, MCP as the source registry.

## Structure pass

Layers: **router** — **source A** — **source B** — **source C** — **merge** (optional, for multi-source queries).

Axis to hold constant: **which query characteristics pick which source?**

```
  Source selection — what the router keys off

  paraphrase / semantic  → vector store       (e.g. docs Q&A)
  exact match / lookup   → relational DB      (e.g. customer by ID)
  fresh / real-time      → web search or API  (e.g. current news)
  business analytics     → EQL / OLAP         (e.g. this repo)
  structured metadata    → graph store        (e.g. segment defs)
```

## How it works

### Move 1 — the shape

You've written a switch statement over content-type before — different handler per type. Retrieval routing is that pattern where the "type" is the query's shape and the "handler" is a knowledge source.

```
  Retrieval routing — the shape

  query → ┌──────────────────────────┐
          │ router: which source?    │  ← heuristic OR LLM
          └──────────┬───────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     source A     source B    source C
     (semantic)   (exact)     (fresh)
```

### Move 2 — how it looks in this repo

**The MCP tool registry IS the source registry.** In this repo, "sources" are MCP tools. When the diagnostic agent needs data:

```
  Retrieval routing in this repo — MCP tools as sources

  agent needs to answer sub-question
    │
    ▼
  ┌───────────────────────────────────────────────┐
  │  aptkit exposes ALL MCP tools to the agent    │
  │  as a tool registry                            │
  └──────────┬────────────────────────────────────┘
             │ model picks based on tool description
             ▼
  ┌─────────────────────────────────────────────────────────┐
  │  execute_analytics_eql   → for metric queries           │
  │  get_event_schema        → for schema questions         │
  │  list_scenarios          → for existing automations     │
  │  get_segment_definitions → for customer cohort defs     │
  │  list_projects           → for project metadata         │
  │  (12+ tools total)                                       │
  └─────────────────────────────────────────────────────────┘
```

The **model does the routing** in the sense that its tool selection IS the source choice. The tool descriptions (part of each tool's `inputSchema`) are the routing hints — the model reads them and picks the tool whose description best fits the current sub-question. This is a form of **LLM routing at the tool-selection layer**, tightly coupled to the MCP protocol.

**When you'd want an explicit router.** As the tool count grows, throwing all N tools at the model per turn causes two problems: (a) context bloat (every tool's schema takes tokens), and (b) tool-selection confusion (more choices, more misfires). The mitigation is a **deterministic pre-router** that narrows the tool set to a relevant subset before the model turn:

```
  Pre-router narrowing — what would change if tool count grew

  Today (12 tools): pass all 12 to the model per turn

  If it grew to 50:
    query → ┌────────────────────────────┐
            │ pre-router (heuristic +     │
            │  embedding-similarity)      │  ← narrows to top-5
            └────────────┬────────────────┘
                         │ 5 tools
                         ▼
                    aptkit tool registry
                    (only these 5 exposed
                    to the model this turn)
```

Not needed yet at 12 tools; would be if the repo added, say, 30+ Bloomreach features. LangChain's `Tools Retrieval` and OpenAI's Assistants "code interpreter + retrieval" pattern both implement this.

**Cross-source retrieval — the harder case.** A single query that needs data from two sources ("USA customers who bought X *and* saw ad Y") requires **retrieval fan-out** + a merge step. This is the multi-agent parallel pattern (`03-multi-agent-orchestration/04-parallel-fan-out.md`) applied to retrieval — each worker owns one source, a merge agent combines. This repo doesn't need it (EQL can express joins across event streams within one source), but the pattern is worth naming.

**Routing at the workspace level, not just per-query.** The `x-bi-mcp-config` header (`lib/mcp/config.ts`) plus the AuthProvider factory (`lib/mcp/auth-providers/index.ts`) let a portfolio visitor route the entire session to a different MCP server — Bloomreach as default, but any MCP-compliant server via bearer or anonymous auth. This is a higher-altitude form of retrieval routing — the router isn't picking a tool per query, it's picking a whole knowledge source (a different MCP server entirely) per session. Same pattern, coarser granularity.

### Move 3 — the principle

Retrieval routing is SECTION A's routing pattern applied to knowledge sources. In a single-agent system it picks a tool; in a multi-agent RAG system it picks which retrieval-specialist agent handles the sub-query. The interview-grade point: a single vector store is rarely the whole answer — production retrieval routes between semantic, exact, and fresh sources.

## Primary diagram

```
  Retrieval routing — this repo and the general pattern

  ┌─ general pattern ──────────────────────────────────────────┐
  │                                                            │
  │  query → router → { vector DB | SQL DB | web | proprietary }│
  │          (LLM or                    (chosen source runs)   │
  │           embedding-               → results               │
  │           semantic OR              → (optional) merge      │
  │           heuristic)               → generate              │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ this repo — MCP tools as the source registry ─────────────┐
  │                                                            │
  │  aptkit agent                                              │
  │    │                                                       │
  │    ▼                                                       │
  │  ┌──────────────────────────────────────────────┐          │
  │  │  MCP tool registry (12+ tools)               │          │
  │  │  ─ execute_analytics_eql (EQL / metric)      │          │
  │  │  ─ get_event_schema (schema)                 │          │
  │  │  ─ list_scenarios (automations)              │          │
  │  │  ─ get_segment_definitions (segments)        │          │
  │  │  ─ …                                         │          │
  │  └──────────────────────────────────────────────┘          │
  │    │ model picks based on tool descriptions                │
  │    ▼                                                       │
  │  DataSource.callTool → MCP server → workspace              │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ session-level routing (via x-bi-mcp-config) ──────────────┐
  │  visitor's browser sends { url, authType } header          │
  │  → route swaps the MCP server for this session              │
  │  → same tool interface, different provider                  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Retrieval routing became a first-class concept when teams noticed that RAG over a single vector store hit a ceiling for enterprise knowledge — customer records live in Salesforce, transaction data in a warehouse, product info in a graph, documentation in a wiki. LangChain's `MultiRetrievalQAChain` and LlamaIndex's `Router Query Engine` were early productions.

The MCP protocol (Model Context Protocol, Anthropic Nov 2024) is designed exactly around this pattern — a standard way for models to discover and call tools across multiple servers. The tool description IS the routing hint. This repo's use of MCP for a single Bloomreach server is a lightweight version; the pattern scales to routing across many MCP servers (one for CRM, one for analytics, one for docs), and that's the direction the protocol is designed to go.

The related pattern at the topology layer is **specialized retrieval agents** — one agent per source, a supervisor routes and merges (see `03-multi-agent-orchestration/02-supervisor-worker.md`).

## Interview defense

**Q: How do you handle multiple knowledge sources?**

MCP tool registry as the source registry. The agent sees all 12+ MCP tools; the tool description is the routing hint; the model picks based on the sub-question. This is LLM routing at the tool-selection layer, tightly integrated with MCP.

I also have session-level routing — `x-bi-mcp-config` header lets a visitor point at a different MCP server entirely, with auth swappable via the AuthProvider factory (Bloomreach OAuth as default, bearer or anonymous as alternatives). Same tool interface, different backing provider.

*Anchor visual:* the tool-registry-as-source-registry diagram above.

**Q: When does this stop scaling?**

Tool count. At 12 tools it's fine — the model reads all schemas per turn and picks well. At 50+, you'd need a pre-router: heuristics or embedding similarity to narrow the tool set to a relevant subset before the model turn, to avoid context bloat and tool-selection confusion. Not needed here; would be if the repo added many more Bloomreach features.

The other scale-out direction is multi-source queries — a single question needing data from two sources. Today EQL handles cross-event joins within one source. If I needed to join across sources (CRM + analytics + docs), I'd fan out to specialist retrieval agents and merge (SECTION C parallel + merge pattern).

## See also

- **`01-agentic-rag.md`** — the base loop this routes inside.
- **`02-self-corrective-rag.md`** — the grader that catches bad retrievals.
- **`01-reasoning-patterns/07-routing.md`** — routing at the intent layer above this.
- **`03-multi-agent-orchestration/02-supervisor-worker.md`** — the multi-agent version of retrieval routing.
- **`04-agent-infrastructure/03-tool-calling-and-mcp.md`** — MCP as the substrate for source routing.
