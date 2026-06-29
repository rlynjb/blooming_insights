# Agentic RAG

**Industry standard.** Retrieval as a control loop, not a one-shot pipeline step. Partially exercised in this repo — agentic over MCP, not over a vector store.

## Zoom out, then zoom in

Sits inside an agent loop, as the dominant tool the model reaches for. The agent's `step → execute → accumulate → terminate` skeleton remains the same; what changes is *what each tool call does* — most of them retrieve more data.

```
  Zoom out — where this concept lives

  ┌─ Reasoning layer ───────────────────────────────┐
  │  DiagnosticAgent / MonitoringAgent / Query…     │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  runAgentLoop (ReAct)                            │
  │     ★ retrieval IS the primary tool call ★      │ ← we are here
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Tool / data-source layer ▼────────────────────┐
  │  BloomingToolRegistryAdapter                     │
  │     → BloomreachDataSource                       │
  │     → MCP server (execute_analytics_eql, etc.)   │
  │  (NO vector store, NO embeddings)                │
  └─────────────────────────────────────────────────┘
```

In a canonical agentic RAG system, retrieval is a vector-store lookup. In this repo, retrieval is an EQL query against Bloomreach. Different substrate, same control loop.

## Structure pass

Layers: query decomposition (the model decides what to ask) → retrieval (the tool call) → evaluation (is this enough?) → loop until done.

**Axis traced — "what flips between static RAG and agentic RAG?":** the *control* axis flips. In static RAG, code decides to retrieve once. In agentic RAG, the model decides whether to retrieve again, with what query.

**Seam:** the agent's `tool_use` block. The model emits "I want to run this EQL query" as a structured intent; the harness runs it; the result goes back. That seam is identical to the one in the ReAct file — agentic RAG is ReAct whose primary tool is retrieval.

## How it works

### Move 1 — the mental model

You know the difference between writing one SQL query and using an interactive REPL. Static RAG is the one SQL query — write it, run it, stuff the result into a prompt, generate. Agentic RAG is the REPL session — `SELECT *... LIMIT 5; — okay, weird, let me check the schema — \d table; — alright, now the real query — SELECT ... WHERE ...`. The reasoning happens between the queries; the next query depends on the previous result.

```
  Static RAG (one shot):
    query ──► retrieve top-k ──► stuff ──► generate
    (no evaluation, no second try)

  Agentic RAG (a loop):
  ┌─────────────────────────────────────────────────┐
  │  decompose query into sub-questions              │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │  retrieve for each (route to the right source)  │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │  evaluate: is this enough to answer?             │
  └──────────┬─────────────────────┬─────────────────┘
             ▼ no                  ▼ yes
        re-retrieve            generate answer
        (refine query)
             │
             └──── loop (cap iterations via maxTurns)
```

The "evaluate" step in agentic RAG is the same `if (toolUses.length === 0)` in `runAgentLoop` — the model emitting no more `tool_use` blocks IS the "enough, generate the answer" signal.

### Move 2 — step by step

#### What this looks like in this repo — the diagnostic investigation

Trace a real diagnostic run. The user clicks on an anomaly card ("usa purchase_revenue · -38.4%"). The route handler in `app/api/agent/route.ts:273-285` constructs a `DiagnosticAgent` and calls `.investigate(anomaly, hooks)`. That delegates to AptKit's `DiagnosticInvestigationAgent.investigate` which runs `runAgentLoop`. Inside the loop:

```
  Turn 1 (assistant):
    Thought: "USA revenue is down 38% vs prior 90d. Let me check
             if total USA orders dropped or AOV dropped."
    tool_use: execute_analytics_eql(eql='count event purchase
              where customer.country=USA period 90d')

  Turn 2 (user — tool_result):
    Observation: { current: 1240, prior: 1280 }  // orders barely moved

  Turn 3 (assistant):
    Thought: "Orders flat, revenue down 38%. AOV must have collapsed.
             Confirm by querying total revenue."
    tool_use: execute_analytics_eql(eql='sum event purchase.total_price
              where customer.country=USA period 90d')

  Turn 4 (user — tool_result):
    Observation: { current: 145200, prior: 234100 }  // -38% confirmed

  Turn 5 (assistant):
    Thought: "Now test hypothesis: did a high-value segment churn?
             Query top-spending segment activity."
    tool_use: execute_analytics_eql(...)

  ... (continues for 2-4 more turns)

  Final turn (assistant):
    Text only — structured Diagnosis with conclusion, evidence,
    hypothesesConsidered, affectedCustomers.
```

Every `tool_use` is retrieval. The model isn't pulling from a vector store; it's issuing analytical queries against the live Bloomreach workspace and reading the structured result. The loop terminates the same way ReAct terminates — when the model emits no more tool calls.

This is agentic RAG in shape, not in vocabulary. There's no embedding similarity scoring, no chunk reranking, no semantic fusion. But the *control loop* — decompose → retrieve → evaluate → loop — is identical to what an agentic vector-RAG system runs.

#### Why static-style retrieval wouldn't work here

The static-RAG shape would be: when an anomaly fires, pre-fetch a fixed bundle of related queries (top product, top segment, top campaign) and stuff them all into the diagnostic prompt as context. Then one LLM call writes the diagnosis.

Two problems with that for this domain:

1. **The right follow-up queries depend on the anomaly.** A USA-revenue-drop investigation wants top-customer-segment-activity; a global-conversion-drop investigation wants funnel breakdown; a search-failure investigation wants top-failed-queries. Pre-fetching every possible follow-up wastes EQL budget on most of them.
2. **The number of queries to ask is unbounded.** Sometimes the cause shows up in turn 2; sometimes it takes 5-6 queries to triangulate. A fixed pre-fetch bundle is either too small (incomplete diagnosis) or too large (wasted queries and a bloated context).

The agentic loop pays the per-turn cost in exchange for query elasticity — only as many queries as the investigation actually needs.

#### The substrate substitution that doesn't change the pattern

If this repo grew a vector store — say, embedding past investigation diagnoses so future similar anomalies could pull a "prior similar case" chunk — that retrieval step would be one more tool call inside the same agentic loop. The loop wouldn't change shape. The tool registry would expose `search_past_diagnoses(query)` alongside `execute_analytics_eql`; the model would pick which to call. Same control loop, more retrieval surface.

The point: agentic RAG is about the *loop*, not the storage. A vector store is the most common substrate because document retrieval is the most common motivating use case, but the pattern composes over any retrieval interface — SQL, MCP tools, REST APIs, gRPC. The reframe to hold: *all agentic RAG is agentic AI; not all agentic AI does retrieval.*

#### The cost tradeoff

The 3-10x token and 2-5x latency overhead from the spec is real and visible in this repo's wall-clock data. A live diagnostic investigation runs ~50-80s (4-7 turns × ~10s/turn at the ~1 req/s MCP spacing). A pre-computed cached replay (in demo mode) runs in ~30s for visual pacing. The cost of the loop is genuine; the win is the elastic query count.

The above-threshold rule applies: use the loop only when one-shot retrieval measurably fails on multi-step queries. For the diagnostic agent's task — "investigate a metric change across an arbitrary dimension" — one-shot doesn't cut it. For a hypothetical "fetch the workspace summary" task, one-shot is correct and the loop would be waste.

### Move 3 — the principle

**Agentic RAG is ReAct whose primary tool is retrieval.** The shift from static to agentic isn't about the retrieval mechanics — it's about *who decides whether to retrieve again*. Static = code; agentic = model. The cost is the per-turn tax; the win is unbounded query elasticity. For tasks where the query depth is unknown (this repo's investigations), the elasticity is worth the tax. For tasks where the query depth is fixed (the briefing's monitoring scan with `maxToolCalls=6` is the *bounded* version of agentic RAG — the model picks queries but the count is capped), the loop is still agentic but with a tight budget that approximates static cost.

## Primary diagram

```
  Agentic retrieval in the diagnostic flow

  ┌─ DiagnosticAgent.investigate(anomaly) ──────────────────────┐
  │   ─► DiagnosticInvestigationAgent (AptKit) .investigate     │
  │   ─► runAgentLoop, with diagnosticInvestigationToolPolicy   │
  │                                                              │
  │   for turn in 0..maxTurns (8):                              │
  │     ┌─ model.complete (Sonnet) ───────────────────────────┐  │
  │     │  emits: text (Thought) + tool_use (eql query)        │  │
  │     └──────────────────────┬───────────────────────────────┘  │
  │                            ▼                                  │
  │     ┌─ harness ────────────────────────────────────────────┐  │
  │     │  tools.callTool('execute_analytics_eql', {...})      │  │
  │     │   ─► BloomingToolRegistryAdapter                     │  │
  │     │   ─► BloomreachDataSource                            │  │
  │     │       ─► cache check (60s TTL) ─► hit? return : MCP  │  │
  │     │       ─► MCP wire call (proactive 200ms spacing)     │  │
  │     │       ─► rate-limit retry (up to 3x, server-stated   │  │
  │     │         retry window)                                 │  │
  │     │  returns { result, durationMs }                      │  │
  │     └──────────────────────┬───────────────────────────────┘  │
  │                            ▼                                  │
  │     append tool_result to messages                            │
  │     emit trace(tool_call_end) → UI shows the query + result   │
  │                                                                │
  │     model decides: another query? or final answer?           │
  │       another: loop                                            │
  │       final: emit text-only → break                            │
  │                                                                │
  │   on break: validate via tryParseDiagnosis                    │
  │   on parse fail: NO recovery prompt for this agent (only      │
  │     monitoring configures one) → return whatever was parsed   │
  │                                                                │
  │   return Diagnosis { conclusion, evidence, hypothesesConsidered,│
  │                      affectedCustomers? }                       │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The agentic RAG pattern matured in 2023-2024 alongside the canonical static RAG pattern. Static RAG was the first cut — the LangChain "stuff" chain (and its competitors) — and it works for short retrieval-augmented question answering when the right chunks are predictable. Agentic RAG showed up when teams started shipping agents that needed multi-step retrieval — "fetch the user's recent orders, then for each order fetch the product details, then summarize the buying pattern." Static can't express that; agentic can.

The MCP angle is worth a note. MCP (Model Context Protocol) was designed exactly for this pattern — standardize how an LLM agent connects to data sources, so the same agent loop can drive vector retrieval, SQL queries, REST APIs, and filesystem reads through one tool interface. This repo runs MCP for the same reason: Bloomreach's loomi connect server exposes ~33 tools (EQL execution, scenario lookup, segment listing, etc.) and the agents call them all the same way through `BloomingToolRegistryAdapter`. The agentic RAG loop runs over MCP transparently.

The cost of the loop, made concrete: a diagnostic investigation on a typical anomaly is 5 turns × ~3K input tokens (the accumulated context grows) × Sonnet pricing = roughly $0.05-0.10 per investigation, plus 4-6 MCP tool calls each ~5-10s of wall-clock at the rate-limited tier. A one-shot static version would be 1 turn × maybe 8K input tokens (pre-bundled context) = roughly $0.03 — cheaper, but with the unsolved problem of "which queries to bundle." The 2-3x cost ratio is the price of query elasticity.

## Interview defense

> **Q: Does this codebase use RAG?**
>
> Agentic data-retrieval over MCP, but not vector RAG. There's no embedding index, no chunking, no vector store. The agents drive their own EQL queries against Bloomreach via the MCP server — the model picks each query, observes the structured result, decides whether to query again. The control loop is the same shape as agentic vector RAG; the substrate is structured-data retrieval over tool calls instead of similarity-scored document retrieval.
>
> Anchor: any diagnostic investigation — `DiagnosticInvestigationAgent.investigate` → `runAgentLoop` → `BloomingToolRegistryAdapter.callTool('execute_analytics_eql', ...)`.

> **Q: Why no vector store?**
>
> The dominant retrieval task in this repo is "fetch real-time analytics from the workspace," not "find related text passages." Bloomreach's analytics engine answers EQL queries directly against the workspace's event stream; there's no document corpus to embed. Adding a vector store would be useful if we wanted to retrieve *past investigation diagnoses* for similar anomalies (a kind of episodic memory — see `04-agent-infrastructure/02-agent-memory-tiers.md`), but the current loop doesn't need it. The retrieval *interface* the agent talks to (the MCP tool registry) doesn't care whether the source is vector-backed or query-backed.

> **Q: What's the cost of agentic vs static retrieval here?**
>
> Roughly 2-3x token cost and 5-8x latency for a typical diagnostic investigation. A 5-turn loop pays ~$0.05-0.10 in tokens plus 50-80s of wall-clock at the rate-limited tier; a hypothetical pre-bundled static version would be 1 turn × ~$0.03 plus 5-10s. The loop's overhead pays for query elasticity — only as many queries as the investigation actually needs. The above-threshold rule is the right framing: use the loop only when one-shot would measurably fail, which it would here because the relevant follow-up queries depend on the anomaly's shape.

> **Q: How does the loop know when to stop retrieving?**
>
> Same termination as ReAct — the model decides. When the model emits a response with no `tool_use` blocks, the harness breaks out and treats the text as the final answer. There's also the hard budget exit: `maxTurns=8` is the ceiling on the diagnostic loop; if the model hasn't synthesized by turn 8 it gets a forced final turn (tools stripped, synthesis instruction injected) and has to commit. The two exits matter equally — without the budget exit, an indecisive model could loop forever issuing EQL queries.

## See also

- → `01-reasoning-patterns/03-react.md` — the substrate this loop runs on
- → `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the MCP layer the retrieval calls go through
- → `04-agent-infrastructure/02-agent-memory-tiers.md` — where a vector store would fit if added
- → `05-production-serving/01-cross-turn-caching.md` — what makes repeated identical retrievals cheap
- → cross-reference (when generated): `study-ai-engineering`'s `03-retrieval-and-rag/` — the embedding / chunking / vector DB / reranking mechanics this file deliberately doesn't re-teach
