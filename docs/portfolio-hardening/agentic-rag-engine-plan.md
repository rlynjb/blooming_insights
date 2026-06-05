# agentic RAG engine — domain-portable, eval-first

goal: build an **agentic RAG engine** whose retrieval/generation core is fixed and domain-agnostic, with a swappable **`KnowledgeDomain` adapter** as the only industry-specific layer. prove portability by shipping **two adapters** (e-commerce catalog + policy/benefits) so the demo *is* the architecture: same engine, swap the adapter, watch it work in a new industry.

this fills the one pillar missing across your portfolio (RAG) while applying the same senior move you used in blooming insights — isolate the volatile part behind an interface (`DataSource` there, `KnowledgeDomain` here). doing it twice reads as a design philosophy, not a one-off.

stack: TypeScript / Next.js (App Router), React 19 — same as blooming insights, so the backbone is reuse, not rebuild.

---

## the split — what's fixed vs swappable

### fixed core (the portfolio value — never changes across industries)
- agent loop with **retrieve-as-a-tool** (reuse `runAgentLoop` from blooming insights)
- **intent capture / slot-filling** (the Track 1 half — generic: what does the user want, what's still missing, is it enough to retrieve yet)
- **hybrid retrieval** — dense (embeddings) + sparse (BM25 / Postgres FTS)
- **reranking** the top-k (cross-encoder)
- **query decomposition** — multi-hop questions → sub-queries (your agent-loop strength)
- **"not in corpus → say so"** faithfulness handling + citations
- the **eval harness** (retrieval + generation metrics)

### swappable adapter — `KnowledgeDomain` (everything industry-specific)
only three things differ by industry; isolate exactly these:
1. **corpus + chunking** — a catalog chunks per-item; policy docs chunk by clause/section. the adapter declares how its source is parsed and chunked.
2. **intent schema** — shopping `{recipient, budget, deadline, interest}`; benefits `{procedure, plan, conditions}`. slot-filling logic is generic; the *slots* are config.
3. **answer contract** — what a cited answer looks like (a product card vs a policy clause with section ref).

```ts
interface KnowledgeDomain {
  id: string
  parse(raw: RawSource): Document[]        // domain-specific parsing
  chunk(doc: Document): Chunk[]            // domain-specific chunking strategy
  intentSchema: IntentSchema               // slots to fill during capture
  answerContract: AnswerContract           // shape of a grounded, cited answer
}
```
the engine consumes a `KnowledgeDomain`. the agent loop, retrieval, reranking, and eval harness must **never** reference a specific domain.

---

## reuse from blooming insights (this is why it's fast)

retrieval becomes one more tool the agent calls — the rest you've already built and can lift:
- **`runAgentLoop`** — the Claude tool-use loop. add a `retrieve` tool; the loop is otherwise the same.
- **model routing** — haiku for intent classification, sonnet for synthesis (same as blooming insights' haiku classifier / sonnet agents).
- **NDJSON streaming** over `ReadableStream` — stream the agent's retrieval reasoning to the UI ("shows its work": which sub-queries, which chunks retrieved, why). same contract you already have.
- **deterministic agent testing** — TDD the loop with injected fakes, no network. lift the pattern directly.

net-new systems vs blooming insights: the retrieval stack (embeddings + vector store + hybrid + rerank), the `KnowledgeDomain` adapter, and the retrieval evals. everything else is reuse.

---

## the senior narrative — build naive, measure, let it fail, earn each upgrade

the differentiation is **never the plumbing** (pgvector is commodity). it's that you knew RAG is a retrieval problem and fixed naive RAG's specific failures *with evidence*. the writeup leads with numbers, not tools:

> "naive RAG hit 0.61 recall@5 and recommended a product not in the catalog on 18% of out-of-corpus questions. hybrid retrieval moved recall to 0.79; reranking moved precision\@5 from 0.4 to 0.68; agentic decomposition fixed multi-hop questions that single-shot retrieval missed entirely. final groundedness 0.94, refusal-on-out-of-corpus 0.91."

that progression *is* the seniority signal. most people skip to the fancy version and can't tell you whether it helped.

---

## tech choices (concrete, in-stack)

- **embeddings**: Voyage (`voyage-3`) or OpenAI `text-embedding-3` via API, BYO-key pattern.
- **vector store + sparse**: **pgvector in Supabase** (you already use Supabase across projects) for dense; **Postgres full-text search** (`tsvector`/`ts_rank`) co-located in the same store for sparse. one store, hybrid = fuse pgvector cosine + FTS rank with **reciprocal rank fusion (RRF)**.
- **reranker**: Cohere Rerank API for v1 (simplest), or a cross-encoder endpoint later. note: paid, BYO-key.
- **generation + agent loop**: Anthropic SDK, `runAgentLoop` with a `retrieve` tool.
- **evals**: implement metrics **in TS** — retrieval metrics deterministic from a labeled set; faithfulness/relevance via LLM-as-judge (judge spot-checked against manual labels). (RAGAS exists in Python if you'd rather; implementing in-stack is itself a small flex and keeps one language.)

---

## phases — concrete first, abstract second

**critical discipline: do NOT extract the `KnowledgeDomain` interface until domain 2 forces it.** abstractions invented from one case guess at seams that don't match reality. one domain working + evals beats two domains half-built behind a premature interface — exactly the same discipline as extracting the blooming insights seam only *after* you understood the coupling.

### phase 0 — scaffold + eval harness skeleton (before any optimization)
- [ ] Next.js + Supabase (pgvector + FTS) scaffold.
- [ ] **build the eval harness first**, so every retrieval change is measured from the first one. you cannot optimize a number you aren't recording.
- [ ] construct the **labeled eval set** for domain 1: questions + ground-truth relevant chunks (retrieval metrics) + reference answers (faithfulness/relevance) + an **out-of-corpus question set** (refusal metric). you own this ground truth — it's the foundation, treat it like one.

### phase 1 — domain 1 (e-commerce catalog), naive RAG, measured
- [ ] corpus: a public catalog + reviews + shipping/return policy. options: an Amazon product/review subset (clean English), or Olist (continuity with blooming insights, but Portuguese — translation overhead). pick one.
- [ ] ingest: parse → fixed-size chunk → embed → store. *hardcode for this domain* (no interface yet).
- [ ] naive retrieve: dense cosine top-k → stuff into prompt → generate.
- [ ] **measure** recall@k, MRR, faithfulness, refusal rate. record the baseline. **let it fail** — note exactly where.

### phase 2 — earn hybrid retrieval
- [ ] add Postgres FTS (BM25-style) + RRF fusion with the dense results.
- [ ] re-run evals. keep it only if recall@k measurably improves (it should — product names/SKUs need exact-match that pure vectors miss).

### phase 3 — earn reranking
- [ ] retrieve broad (e.g. top-20) → cross-encoder rerank → top-5 to the generator.
- [ ] re-run evals. justify with the precision@k delta.

### phase 4 — earn the agentic + intent-capture layer (the Track 1 half)
- [ ] **intent capture / slot-filling** as a first-class system: incremental slot extraction, "what's still missing," and a decision gate for *when enough is known to retrieve*. (reuse the haiku-classifier pattern.) this is the half most people skip and the half you can already do — make it real, not a one-shot classifier.
- [ ] **agentic decomposition**: multi-hop question → sub-queries → retrieve per sub-query → synthesize a cited answer. retrieval is a tool inside `runAgentLoop`.
- [ ] stream the reasoning (NDJSON) — which sub-queries, which chunks, why.
- [ ] re-run evals on multi-hop questions specifically; show single-shot missed them.

### phase 5 — extract the `KnowledgeDomain` interface by adding domain 2
- [ ] now, with one domain fully working and measured, add **policy/benefits** (a public insurance/benefits/regulation doc set — mixed tables + dense prose, so chunking becomes a genuine decision).
- [ ] extracting the interface is *driven by the second case*: whatever differs between catalog and policy becomes the adapter surface (`parse`, `chunk`, `intentSchema`, `answerContract`). whatever's the same stays in the core.
- [ ] build domain 2's labeled eval set; run the full harness on it.

### phase 6 — prove portability (the demo)
- [ ] one UI, a domain switcher. show the same engine answering grounded, cited questions over the catalog, then over the policy set, by swapping the adapter.
- [ ] the demo *is* the thesis: not "I built a RAG," but "I built a RAG platform, and here's the seam that makes it domain-portable."

---

## scope discipline / the rules that don't change

- **evals before optimization.** never tune a retrieval stage you aren't measuring. the harness exists from phase 0.
- **each upgrade earned by a measured delta.** hybrid, rerank, agentic — each stays only if a number moved. cut it if it didn't.
- **the adapter is a real seam, not a config flag.** the test an interviewer applies: *"could a stranger add a third industry without touching the core?"* if adding a domain means editing the retrieval loop, the abstraction failed; if it means writing one new adapter file, it's real. design toward that test.
- **don't extract the interface from one case.** the seam is discovered from two real domains, not guessed from one.
- **faithfulness + refusal are first-class.** "not in corpus → say so, with no invented answer" is a requirement and a measured metric, not an afterthought.
- **the core never imports a domain.** `runAgentLoop`, retrieval, rerank, evals reference the `KnowledgeDomain` interface only — never a specific one.

---

## what this proves (and the gaps it closes)

- **RAG — the missing pillar** — and the *senior* version: hybrid + rerank + agentic, with retrieval evals, not naive "chat with my docs."
- **architectural portability** — the `KnowledgeDomain` seam is the same design philosophy as the `DataSource` seam in blooming insights. two instances = a pattern, which is what L4–L5 evaluates.
- **agentic retrieval** — reuses and deepens the agent muscle from blooming insights.
- **eval discipline** — compounds with the blooming insights eval work; the same through-line across both projects.
- **real-time intent capture** — the Track 1 differentiator, and an existing strength of yours.

after this, the three projects line up cleanly: **blooming insights** (agents + evals + MCP, source-portable), **contrl** (classical supervised ML + on-device, shipped), **this** (agentic RAG, domain-portable). three distinct pillars, two of them showing the same portability instinct.

## honesty / cost checks

- **the labeled eval sets are the unglamorous foundation** — same as contrl's data collection. they're where credibility lives; a RAG project with no retrieval evals is a demo. don't skip, don't shortcut.
- **don't over-abstract early.** the interface is phase 5, not phase 1. resist it until domain 2 forces the seam.
- **paid APIs**: embeddings + reranker (Cohere) cost money per call — BYO-key, and watch eval-run costs (re-running the harness repeatedly adds up; cache embeddings).
- **LLM-as-judge must be spot-checked** against your manual labels before you trust a faithfulness number — an unverified judge is just another model that can be wrong.
- **two domains is the target, not five.** portability is proven by the *second* adapter; a third is diminishing returns. ship two well.
