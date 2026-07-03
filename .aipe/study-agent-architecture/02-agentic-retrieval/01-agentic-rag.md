# Agentic RAG

_Industry standard._

## Zoom out, then zoom in

The difference between static RAG (retrieve top-k, generate) and agentic RAG (loop: query, retrieve, evaluate, re-retrieve, generate). **Not implemented in blooming_insights.** This file covers the shape and names the refactor that would introduce it.

```
  Zoom out — where agentic RAG would sit if adopted

  ┌─ Worker agent ─────────────────────────────────────────────┐
  │  Currently: DiagnosticAgent runs execute_analytics_eql     │
  │  (analytical tool call — not semantic retrieval)           │
  │                                                            │
  │  With agentic RAG (hypothetical):                          │
  │  DiagnosticAgent + retrieve_playbook + retrieve_incident   │
  │  tools that hit a vector store over past investigations    │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: agentic RAG is *ReAct whose primary tool is retrieval.* Same kernel from `01-reasoning-patterns/02-agent-loop-skeleton.md`, different tool policy.

## Structure pass

**Layers:** query decomposition · per-source retrieval · relevance evaluation · re-retrieval loop · generation.
**Axis:** *when does the loop decide it has enough evidence?*
**Seam:** the evaluator — deterministic (chunk count?) or LLM (is this enough to answer?).

```
  Static RAG vs agentic RAG — what's added

  Static RAG:
   query → retrieve top-k → stuff → generate
   (single pass, no evaluation)

  Agentic RAG:
   query → decompose → retrieve → evaluate → sufficient?
                                             │      │
                                             │ no   │ yes
                                             ▼      ▼
                                          re-retrieve  generate
                                          (cap iterations)
```

## How it works

### Move 1 — the mental model

You've built a paginated search UI before — user types a query, results come back, user refines and searches again. Agentic RAG is that same loop, with the *model* playing the user role: it queries, reads results, refines, re-queries. Cap the loop so it doesn't spiral.

```
  Pattern: agentic RAG (retrieval as a control loop)

  ┌───────────────────────────────────────────┐
  │  decompose query into sub-questions       │
  └────────────────┬──────────────────────────┘
                   ▼
  ┌───────────────────────────────────────────┐
  │  retrieve for each (route to right source)│
  └────────────────┬──────────────────────────┘
                   ▼
  ┌───────────────────────────────────────────┐
  │  evaluate: is this enough to answer?      │
  └──────┬──────────────────────┬─────────────┘
         ▼ no                   ▼ yes
     re-retrieve            generate answer
     (refine query)
         │
         └──── loop (cap iterations)
```

### Move 2 — the walkthrough

**In this codebase — not implemented.** No vector store exists. Nothing to retrieve semantically from. Blooming's investigative loop *does* run a ReAct-shaped loop, but every tool is analytical (EQL, list_scenarios, list_experiments), not semantic-retrieval-shaped.

**The closest existing shape.** The DiagnosticAgent's tool policy (`node_modules/@aptkit/.../diagnostic-agent.js:8-23`) allows 11 tools, but they're all "run this deterministic query against Bloomreach state." The model does pick which to run based on prior observations — that's the *control loop*, which IS the agentic part — but the tools themselves aren't retrievers.

**Where agentic RAG would land.** Suppose Blooming grew to include a corpus of past investigation writeups ("here's how we handled a similar checkout drop in Q3 2025"). Then the shape would be:

Hypothetical:
```ts
// hypothetical additions to DiagnosticAgent's tool policy
const RETRIEVAL_TOOLS = [
  'retrieve_similar_investigations',  // vector search over past writeups
  'retrieve_playbook',                 // vector search over incident playbooks
];

// In the loop, the model would interleave:
//   - retrieve tool (get context)
//   - analytical tool (test hypothesis against current data)
//   - another retrieve (get more context based on findings)
//   - generate diagnosis grounded in both
```

Line-by-line: the additions are tool-policy changes. The loop *shape* is unchanged — same `runAgentLoop`, same maxTurns=8. What changes is the model's evaluation of "do I have enough evidence" — it now considers both current data (EQL results) AND past context (retrieved playbook chunks).

**The tradeoff, made concrete.** Static RAG (one-shot retrieve + generate) at ~$0.005 per query. Agentic RAG loop at 3-5 tool calls: ~$0.015-0.025 (3-5x cost, 2-5x latency). Only worth it when one-shot retrieval measurably fails on multi-step queries. For a workspace-analysis product, the loop over EQL already IS the multi-step loop — adding another loop around a doc corpus would need a clear measured win.

### Move 3 — the principle

Not all agentic AI does retrieval, but all agentic RAG is agentic AI. The escalation from static to agentic is a threshold decision: measure one-shot retrieval failing on multi-hop questions FIRST; adopt the loop only when the failure is real. In this codebase there's no retrieval at all, so the question is moot — the diagnostic loop over analytical tools IS the agentic pattern here.

## Primary diagram

```
  Recap — agentic RAG as a specialization of the ReAct kernel

  ┌─ ReAct kernel (see 01-reasoning-patterns/02) ────────────┐
  │  step → tool → observe → repeat                          │
  └───────────────┬──────────────────────────────────────────┘
                  │  when tools are RETRIEVERS:
                  ▼
  ┌─ Agentic RAG specialization ─────────────────────────────┐
  │  step (decompose query)                                  │
  │  tool = retrieve(query_i, source)                        │
  │  observe (chunks came back)                              │
  │  evaluate (enough?)  ─┐                                  │
  │       │ no             │                                 │
  │       ▼                ▼                                 │
  │   refine + loop     generate grounded answer             │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern came from LangChain's "self-querying retriever" and the "corrective RAG" papers (Yan et al. 2024). Production shape looks like: primary tool is `retrieve(query, source)`; secondary tool is `search_web(query)` for freshness; the loop evaluates chunks and re-retrieves.

Anchor for the reader coming from AdvntrCue: that project ran classic RAG over pgvector — one-shot retrieve top-k, stuff, generate. That's the static shape. Agentic RAG would add the loop *around* it — retrieve k=5, evaluate, if not enough refine the query, retrieve again. The AdvntrCue-scale question was whether the loop's coordination cost was worth the reliability lift; the answer depends on the failure rate of single-hop retrieval on your queries.

## Interview defense

**Q: Does blooming_insights use agentic RAG?**
A: No. It runs an agentic loop, but over analytical tools (EQL queries against Bloomreach state), not over a retrieval corpus. There's no vector store. If the product grew to include a playbook corpus or a past-investigation memory, I'd add retrieval tools to the DiagnosticAgent's policy and the same `runAgentLoop` kernel becomes agentic RAG for free — that's the point of the tool-agnostic loop.

Diagram: the ReAct kernel with "tool = retrieve" callout.
Anchor: `lib/agents/diagnostic.ts` (current) + hypothetical tool policy addition.

**Q: When does one-shot RAG become insufficient?**
A: When queries are multi-hop or cross-source. Multi-hop: "which product category drove the revenue drop, and which acquisition channel brought those customers in?" — that's a two-retrieve dependency; one-shot can't do it. Cross-source: "compare this quarter's playbook to what we did last quarter" — needs multiple retrievals against different stores. Measure with a golden set of hard queries; if one-shot fails >20% on those, the loop earns its keep.

Diagram: one-shot vs loop — decision fork on "hops needed to answer".
Anchor: general reasoning; refers to `study-ai-engineering` for one-shot mechanics.

## See also

- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel this pattern instantiates.
- `03-retrieval-routing.md` — the routing tier over multiple sources.
- Cross-reference: `.aipe/study-ai-engineering/03-retrieval-and-rag/` for static RAG mechanics.
