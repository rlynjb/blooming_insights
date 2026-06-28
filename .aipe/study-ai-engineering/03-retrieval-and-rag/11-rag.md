# 11 — RAG (Retrieval-Augmented Generation)

**Subtitle:** Retrieve → augment → generate pipeline · Industry standard (Case B)

## Zoom out, then zoom in

**Case B: not exercised in this codebase.** blooming insights' agents retrieve
data via Bloomreach EQL — structured query, not semantic retrieval. There's
no embedding step, no vector store, no chunking.

The natural place RAG would land: **diagnosis grounding**. When the diagnostic
agent investigates a 38% conversion drop, it'd help to surface the *last
three diagnoses with similar symptoms* so the agent can cite prior knowledge
("we saw this same pattern in Brazil last quarter; root cause was checkout
gateway timeout").

```
  Zoom out — where RAG WOULD sit in blooming insights

  ┌─ /api/agent ─────────────────────────────────────────────┐
  │  resolve anomaly                                          │
  │  bootstrap schema                                         │
  │  listTools                                                │
  │  ┌─ NEW: retrieve similar past diagnoses ───────┐         │  ← we are here
  │  │  embed(anomaly.metric + scope)               │         │   (Case B)
  │  │  cosineSearch(diagnoses_index, top=3)        │         │
  │  │  → top3 = [past Diagnosis records]           │         │
  │  └────────────────────────────────────────────────┘         │
  │  diagnosticAgent.investigate(anomaly, {priorContext: top3})│
  └───────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — knowledge currency.** Frozen training data (the
    model) vs fresh corpus data (your stuff). RAG bridges. The diagnostic
    agent today only sees the *current* anomaly; with RAG it could see
    *how prior anomalies were resolved* — institutional memory that the
    model has no other way to access.

  → **The seam:** between the existing `lib/state/investigations.ts` (the
    corpus) and the diagnostic agent's prompt (the augmentation point). No
    code today sits at this seam; the exercise below names what would go
    there.

## How it works

### Move 1 — the mental model

Same shape as a `JOIN` between two data sources: the model is one source
(general world knowledge frozen at training), your corpus is the other
(specific to your data, fresh). Retrieval is the join key — semantic
similarity instead of `=`.

```
  RAG = JOIN(model_world, your_corpus) ON semantic_similarity

  user question
       │
       ▼
  embed(question) → query vector
       │
       ▼
  cosine search in corpus → top-k chunks
       │
       ▼
  stuff chunks into prompt as "context"
       │
       ▼
  LLM answers — grounded in retrieved chunks, not from training memory
       │
       ▼
  answer + citations to chunks
```

### Move 2 — the step-by-step walkthrough (Case B — the refactor)

**Step 1 — build the corpus.** Past investigations already exist on disk in
`lib/state/investigations.ts` (in dev: `.investigation-cache.json`; the
saved demo: `lib/state/demo-investigations.json`). Each Investigation is:

```typescript
interface Investigation {
  insightId: string;
  reasoning: ReasoningStep[];
  diagnosis: { conclusion: string; evidence: string[]; hypothesesConsidered: string[] };
  recommendations: Recommendation[];
}
```

The natural "chunk" is one investigation = one chunk. Self-contained,
typically <1000 tokens, naturally bounded by the unit of work. No fancy
chunking strategy required.

**Step 2 — embed each chunk.** Call an embedding model
(`text-embedding-3-small` from OpenAI is the canonical baseline,
`voyage-3` for higher-quality, `BAAI/bge-small-en` for local). Embed the
combined string `diagnosis.conclusion + ' ' + evidence.join(' ')`. Store
the resulting 384/1536-d vector alongside the investigation.

```typescript
// Hypothetical lib/rag/embed.ts
async function embedInvestigation(inv: Investigation): Promise<number[]> {
  const text = `${inv.diagnosis.conclusion}\n${inv.diagnosis.evidence.join('\n')}`;
  const result = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return result.data[0].embedding;
}
```

**Step 3 — store + index.** Two reasonable choices for this codebase:
  - **sqlite-vec**: stay file-based, no server. Simplest for a portfolio
    project.
  - **pgvector**: add a Postgres dependency, but unifies relational
    queries with vector search. Better long-term shape.

The data shape: `{ insight_id, embedding, conclusion, created_at }`. ~100
bytes of metadata + a few KB for the vector per investigation. Even at
10,000 investigations, this fits comfortably in SQLite.

**Step 4 — retrieve at query time.** When `/api/agent?step=diagnose` runs:

```typescript
// Hypothetical: hook into app/api/agent/route.ts before diagAgent.investigate
const queryVec = await embedAnomaly(anomaly);
const priorDiagnoses = await vectorStore.cosineSearch(queryVec, { topK: 3 });
```

**Step 5 — augment the diagnostic prompt.** AptKit's
`DiagnosticInvestigationAgent` would need a `priorContext` option that gets
spliced into the prompt as a "previously seen similar anomalies" block. The
prompt's `{anomaly}` interpolation point gets a sibling `{priorContext}`
that gets:

```
## Previously seen similar anomalies

1. (2026-03-15) "purchases dropped 38% in Brazil due to checkout gateway timeout"
   Evidence: checkout.success rate fell from 92% to 71%; impact concentrated in BR
2. (2026-02-08) "conversion dropped 22% globally after the iOS 18 release"
   Evidence: device_type=ios chunk; new visitor conversion held steady
3. (2025-12-01) "USD revenue down 15% on Black Friday week..."
   Evidence: regional traffic shift; segment description: US small basket buyers
```

**Step 6 — model generates with citations.** The diagnostic agent's
synthesis turn now mentions prior cases explicitly: *"This pattern matches
the BR checkout incident from March; recommend checking the payment gateway
first, as in that case."* Output JSON shape gains an optional
`priorContextCited: number[]` field so the UI can link to the prior
diagnoses.

**The eval move that has to land alongside.** Without measuring retrieval
quality, RAG is just adding latency. Need a small golden set: 10-20
historical anomalies labeled with "the correct top-3 prior diagnoses for
this anomaly." Measure `hit@3` (was the labeled match in the retrieved
top-3?) before and after every retrieval-side change.

### Move 3 — the principle

**RAG bridges the model's frozen knowledge with your corpus's fresh
knowledge. It's only as good as the retrieval; bad retrieval produces
hallucinated answers with citation-shaped confidence.** The principle is:
*don't add RAG to features that work without it*. The diagnostic agent
works without RAG today; adding it is an upgrade for *quality of
diagnosis*, not a fix for a broken feature. That's the right shape — RAG
as enrichment, not crutch.

## Primary diagram

```
  RAG end-to-end as it WOULD land in blooming insights

  ┌─ Offline (per-investigation cron / on-save) ──────────────┐
  │                                                           │
  │  Investigation (lib/state/investigations.ts)              │
  │       │                                                   │
  │       ▼  embed(conclusion + evidence)                     │
  │  vector ──────► vectorStore.upsert({insight_id, vec,      │
  │                                      conclusion,           │
  │                                      created_at})         │
  │                                                           │
  └───────────────────────────────────────────────────────────┘

  ┌─ Online (/api/agent?step=diagnose) ───────────────────────┐
  │                                                           │
  │  anomaly                                                  │
  │       │                                                   │
  │       ▼  embed(anomaly.metric + anomaly.scope.join(' '))  │
  │  queryVec                                                 │
  │       │                                                   │
  │       ▼  cosineSearch                                     │
  │  top3 = [past Investigation refs]                         │
  │       │                                                   │
  │       ▼  splice into prompt                                │
  │  diagnosticAgent.investigate(anomaly, {priorContext: top3})│
  │       │                                                   │
  │       ▼                                                   │
  │  Diagnosis that cites priorContext[i]                     │
  │       │                                                   │
  │       ▼                                                   │
  │  UI renders diagnosis WITH "we've seen this before:" links│
  │                                                           │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern was popularized by the original RAG paper (Lewis et al., 2020)
and made operational by the LangChain / LlamaIndex generation of frameworks
around 2023. Today every LLM app team has an opinion on which vector store
and which embedding model; the patterns themselves are stable.

The decision to *not* add RAG yet to blooming insights is consistent with
the codebase's general philosophy: hand-picked retrieval over semantic
retrieval at small scale. The schema summary is hand-truncated, the
category checklist is hand-curated, the tool allowlists are hand-written —
all of these are "RAG would be overkill, a sorted list of N things works."
RAG earns its place when the corpus grows past N ≈ 50-100 items and human
curation stops scaling.

For the diagnosis-grounding case specifically: today the demo snapshot has
~5 investigations. Even at 50 investigations, a deterministic
sort-by-similar-metric-string would work fine. RAG starts to matter at
~500+ investigations or when the *semantics* of similarity diverges from
exact-string matching (different metrics that describe the same underlying
issue).

## Project exercises

### Exercise — diagnosis grounding via local vector search (sqlite-vec)

  → **Exercise ID:** `study-ai-eng-03-11.1`
  → **What to build:** Wire `sqlite-vec` into the codebase. On every
    investigation save (`lib/state/investigations.ts`), compute an
    embedding via OpenAI's `text-embedding-3-small` (or a local
    sentence-transformers model) and upsert into a local SQLite db. In
    `/api/agent?step=diagnose`, query the top-3 prior investigations
    similar to the current anomaly and pass them as `priorContext` to
    the diagnostic agent. Extend the agent prompt to use them.
  → **Why it earns its place:** Lands the entire pattern end-to-end —
    embedding, storage, retrieval, augmentation, citation. Plus the
    eval set (hit@3 on a labeled mini-corpus). Strongest single
    portfolio move for adding RAG fluency to this repo.
  → **Files to touch:** new `lib/rag/embed.ts`, new `lib/rag/store.ts`
    (sqlite-vec wrapper), `lib/state/investigations.ts`
    (save-side trigger), `app/api/agent/route.ts` (retrieve before
    diagnostic agent), AptKit upstream PR to accept `priorContext` on
    `DiagnosticInvestigationAgent`, new `lib/agents/legacy-prompts/diagnostic.md`
    with a `{priorContext}` placeholder, new test for hit@3 against a
    fixture.
  → **Done when:** A live (or replay) diagnostic investigation surfaces
    "we've seen this before:" with links to past diagnoses. The hit@3
    eval is ≥0.5 on the labeled fixture set.
  → **Estimated effort:** `≥1 week`

### Exercise — switch the embedding provider via a `lib/rag/embed.ts` seam

  → **Exercise ID:** `study-ai-eng-03-11.2`
  → **What to build:** Define an `EmbeddingProvider` interface inside
    `lib/rag/embed.ts`. Implement `OpenAIEmbeddingProvider` and a local
    `OnnxEmbeddingProvider` (using `@xenova/transformers` for
    `BAAI/bge-small-en`). Make the provider env-var-driven
    (`EMBEDDING_PROVIDER=openai|local`).
  → **Why it earns its place:** Mirrors the model-provider seam from
    `01-llm-foundations/08-provider-abstraction.md` on the
    embedding side. Demonstrates the same adapter-pattern fluency for a
    different boundary.
  → **Files to touch:** `lib/rag/embed.ts`, `lib/rag/store.ts` (passes
    provider in), new `package.json` deps for the local model option,
    docs.
  → **Done when:** Both providers produce vectors at the right
    dimensionality; the existing exercise 03-11.1's retrieval works
    against either.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: Does blooming insights use RAG?**

No. The agents retrieve data via Bloomreach EQL — structured query, not
semantic retrieval. There's no embedding step, no vector store, no chunking.
The closest analog is `schemaSummary()` (hand-truncated context) and the
hand-curated category checklist — both are "structured curation" doing what
RAG would do for prose at scale.

**Anchor line:** "Not exercised. We don't have a prose corpus; we have
Bloomreach events queried via EQL."

**Q: Where would RAG land if you added it?**

Diagnosis grounding. We already store every past investigation
(`lib/state/investigations.ts`). The natural enrichment is: on a new
diagnostic run, retrieve the top-3 prior investigations with similar
metric+scope and inject them into the diagnostic agent's prompt as
"previously seen." The agent can cite them; the UI links to them. The
exercise shape is:

```
  Investigation save → embed → upsert into sqlite-vec
  /api/agent?step=diagnose → embed anomaly → cosineSearch top-3
  → pass as priorContext → diagnostic agent grounds + cites
```

**Anchor line:** "Diagnosis grounding via sqlite-vec on past investigations.
The corpus exists; the embedding + store layer is the build."

**Q: What's the load-bearing thing people forget about RAG?**

The retrieval is the entire product. A great model with bad retrieval gives
you confidently-cited hallucinations — the worst failure mode in user-facing
LLM systems because the citation makes it *look* grounded. You can't
improve a RAG system without measuring retrieval quality (hit@k, MRR,
recall@k) on a labeled golden set first. The model is the second-most-
important thing; the retriever is the first.

**Anchor line:** "Retrieval is the product. Bad retrieval + good model = a
confident liar."

## See also

  → `01-embeddings.md` — what the query vector and corpus vectors actually are
  → `04-vector-databases.md` — where the index lives (sqlite-vec choice)
  → `07-reranking.md` — the production-quality move once retrieval is wired
  → `05-evals-and-observability/01-eval-set-types.md` — the golden set you need to measure hit@k
