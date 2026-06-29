# Agentic RAG

*Industry name: agentic RAG / iterative RAG — Industry standard.*

ReAct whose primary tool is retrieval. Static RAG is one shot — retrieve top-k, stuff, generate. Agentic RAG is a loop — decompose the question, retrieve per sub-question, evaluate sufficiency, re-retrieve if needed, then generate.

**Not in this repo.** This codebase has no vector store, no embeddings, no chunking. The closest cousin pattern is its tool-use loop over Bloomreach EQL queries — same loop shape, different tool semantics.

## Zoom out — where this concept would live

If adopted, it'd be a refactor inside an existing agent — most likely the query agent (`QueryAgent`) or a new corpus-grounded agent that retrieved from blog posts / product docs / past investigations rather than from live Bloomreach data.

```
  Where agentic RAG WOULD live (not yet implemented)

  ┌─ Service layer ──────────────────────────────────────────┐
  │  /api/agent?q=...                                         │
  └─────────────────────┬────────────────────────────────────┘
                        ▼
  ┌─ Agent layer ───────────────────────────────────────────┐
  │  Today:   QueryAgent (tools = Bloomreach EQL + others)  │
  │  Future:  + KnowledgeAgent (tool = vector_search)       │ ← would live here
  │           over a corpus of marketer docs, past investigations
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **how many times does the model retrieve before generating?**

```
  Static RAG (one shot):
  ──────────────────────
  query → embed → top-k → stuff → generate
  no evaluation, no second try, no decomposition

  Agentic RAG (a loop):
  ──────────────────────
  query → decompose → per sub-question:
            retrieve → evaluate sufficiency → re-retrieve or generate
  loop is bounded by maxToolCalls (the same kernel from 01-reasoning-patterns)
```

## How it works

### Move 1 — the mental model

You know the loop kernel from `../01-reasoning-patterns/02-agent-loop-skeleton.md`. Agentic RAG is that kernel where the model's tool grant is mostly retrieval tools, and the model's prompt encourages "decompose, retrieve per sub-question, evaluate." It's not a new pattern — it's the loop kernel pointed at retrieval.

```
  Agentic RAG — kernel pointed at retrieval

  ┌───────────────────────────────────────────────┐
  │  decompose query into sub-questions           │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  retrieve for each (route to the right source)│
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  evaluate: is this enough to answer?          │
  └──────────┬─────────────────────┬──────────────┘
             ▼ no                  ▼ yes
        re-retrieve            generate answer
        (refine query)
             │
             └──── loop (cap iterations — maxToolCalls)
```

### Move 2 — what it would look like in this repo

A hypothetical `KnowledgeAgent` could retrieve from a corpus of:
- Past investigation reports stored as markdown
- Bloomreach product documentation
- Marketer best-practice guides

The tool grant would be `vector_search(query, top_k, source)`. The agent would behave like the QueryAgent today, just with `vector_search` as the primary tool instead of `execute_analytics_eql`.

Skeleton of the refactor:

```typescript
// hypothetical lib/agents/knowledge.ts
export class KnowledgeAgent {
  async answer(question: string, hooks: AgentHooks = {}): Promise<string> {
    const agent = new AptKitKnowledgeAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'coordinator', this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, [
        // tool: vector_search(query, top_k, source: 'docs' | 'investigations' | 'guides')
      ]),
      // ... uses runAgentLoop the same as everything else
    });
    return agent.answer(question, { signal: hooks.signal });
  }
}
```

The mechanism is identical to ReAct; only the tool implementation differs. The tool would wrap pgvector or a hosted vector store; the agent doesn't care which.

### Move 3 — the principle

Agentic RAG is not a new pattern — it's the loop kernel pointed at retrieval. The reframe to hand the reader: *all agentic RAG is agentic AI; not all agentic AI does retrieval.* This repo is the second case — agentic AI without retrieval — because the data is live operational state queried via SQL-shaped tools, not a corpus indexed for similarity search.

The tradeoff is steep when you do reach for it. Agentic RAG runs roughly 3-10x the tokens of static RAG and 2-5x the latency, so the above-threshold rule applies hard: use the loop only when one-shot retrieval measurably fails on multi-step or cross-source queries.

## In this codebase

**Not yet implemented. Not planned.** The retrieval surface in this repo is Bloomreach's analytics API via MCP tools — there is no corpus of unstructured text to retrieve from. Adding agentic RAG would require:

1. **Choosing a corpus.** Past investigation reports stored to disk? Bloomreach product docs scraped? Marketer guides curated by the team? None of these exist as a maintained corpus today.
2. **Adding a vector store.** No vector store in the codebase. Adding pgvector would mean adding Postgres (currently no DB at all — state lives in in-memory maps).
3. **An embedding pipeline.** A maintenance liability: every corpus update needs re-embedding.
4. **A new agent class** wrapping `vector_search` as a tool — the cheap part. The first three are the real cost.

The natural opportunity: if a "what should I do about this kind of anomaly" feature got added, a corpus of past resolved-similar-anomalies retrievable by semantic similarity would be the high-leverage place to add it. That's the system-design template in `../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md`.

## Primary diagram

The contrast — what this repo does today (tool-use over EQL) vs what agentic RAG would add (tool-use over a vector store):

```
  Comparison — today's tool-use loop vs hypothetical agentic RAG

  TODAY (QueryAgent, ReAct over EQL):
  ┌────────────────────────────────────────────────────┐
  │  while not done {                                  │
  │    pick EQL query   → execute_analytics_eql({eql}) │
  │    read result      → live ecommerce data          │
  │  }                                                  │
  │  source: Bloomreach (operational state)            │
  └────────────────────────────────────────────────────┘

  HYPOTHETICAL (KnowledgeAgent, agentic RAG):
  ┌────────────────────────────────────────────────────┐
  │  while not done {                                  │
  │    pick search query → vector_search({q, source})  │
  │    read result       → top-k chunks                │
  │    decide: enough?                                 │
  │     yes → generate                                  │
  │     no  → refine query, retrieve again             │
  │  }                                                  │
  │  source: corpus (docs, past reports, guides)       │
  └────────────────────────────────────────────────────┘
```

## Elaborate

Agentic RAG crystallized around 2024 as the answer to static RAG's two failure modes: multi-step questions (the answer needs information from three sources, but top-k only returns the most similar chunks) and ambiguous queries (the model's first retrieval brings back the wrong thing, and there's no second try). LangChain's LCEL chains and LangGraph's state machines both bundled patterns for it. The shape is always the loop kernel pointed at retrieval — the contribution is the prompt design and the per-step grader.

The token-cost honesty: agentic RAG isn't free. A 4-iteration loop with 2 retrievals each = 8 vector searches + 4 LLM calls + 1 generation. Compared to static RAG's 1 vector search + 1 LLM call, that's roughly 10x the cost. The above-threshold rule applies — measure static RAG first, escalate only when a specific failure mode justifies the tax.

The pattern that connects best to this repo: the agent loop primitive is the same. The thing that's different in agentic RAG is the *tool* (vector search) and the *prompt's grader step* (is this chunk enough). If you understand the loop kernel from `01-reasoning-patterns`, you already understand the structure of agentic RAG; you just substitute the tool.

## Interview defense

**Q: "Do you use RAG?"**

A: No. The data this product analyzes is live operational state — ecommerce events, revenue, funnel metrics — accessed via the Bloomreach MCP server's EQL tools. There's no corpus to retrieve from; the model writes a query, the tool runs it against live data, the result comes back as a tool_result block. That's tool-use, not retrieval — same loop kernel, different tool semantics.

If we added a corpus (past investigation reports, Bloomreach docs, marketer best-practice guides), agentic RAG would be the right shape — a vector search tool inside the same ReAct loop the QueryAgent already uses. The refactor is small in the agent layer (~50 lines of a new wrapper class); the real cost is the corpus pipeline (embedding, indexing, freshness, maintenance) and choosing the vector store.

Diagram I'd sketch:

```
  what this repo does:       what RAG would add:
  ┌──────────────┐           ┌──────────────┐
  │ agent loop   │           │ agent loop   │
  │ tool:        │           │ tool:        │
  │  execute_    │           │  vector_     │
  │  analytics_  │           │  search(q)   │
  │  eql(query)  │           │              │
  └──────────────┘           └──────────────┘
   live data, no              static corpus,
   embeddings                 embeddings
```

Anchor: "the loop kernel doesn't change; only the tool semantics do. Today the tool is SQL-shaped EQL against live data; agentic RAG would point it at top-k chunks from a vector store."

**Q: "Why isn't tool-use over EQL just 'agentic RAG with one tool'?"**

A: Because the tool returns *current operational state* — a count, a revenue number, a segmented funnel — not retrieved chunks of pre-indexed text. The agent doesn't have to evaluate "is this chunk relevant to my question"; the EQL tool either returned the metric or it didn't. The classic RAG failure mode (the top-k chunks are off-topic) doesn't exist when the "retrieval" is "select sum event purchase.total_price in last 90 days." It's the difference between asking a database vs asking a search engine — both are retrieval in a loose sense; only one has the relevance problem RAG was invented to solve.

## See also

- [`02-self-corrective-rag.md`](./02-self-corrective-rag.md) — the grader-step variant
- [`03-retrieval-routing.md`](./03-retrieval-routing.md) — when there's more than one source
- [`../01-reasoning-patterns/02-agent-loop-skeleton.md`](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the kernel both this and tool-use over EQL share
- ai-engineering's `03-retrieval-and-rag/` (cross-ref) — retrieval mechanics, if generated
