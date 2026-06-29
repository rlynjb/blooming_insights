# Self-corrective RAG

**Industry standard.** A grader between retrieval and generation, with a fallback path. **Not exercised** in this codebase.

## Zoom out, then zoom in

Sits between the retrieval step and the generation step inside the loop. Adds a "is this retrieved chunk relevant and grounded?" decision before letting the model trust it.

```
  Zoom out — where this concept WOULD live

  ┌─ Reasoning layer ───────────────────────────────┐
  │  agent loop                                      │
  └────────────────────────────┬────────────────────┘
                               │ retrieves via tool call
  ┌─ Retrieval layer ─────────▼────────────────────┐
  │  ★ relevance / grounding grader (not here) ★    │ ← we are here
  │  decide: use this result, or fall back?          │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Generation layer ────────▼────────────────────┐
  │  agent continues with verified context           │
  └─────────────────────────────────────────────────┘
```

This repo runs structured-data retrieval (EQL queries against Bloomreach), where the substrate problem — "did a chunk come back relevant to the query" — doesn't apply the same way. A query either runs and returns data or it errors. There's no chunk-level relevance to grade.

## Structure pass

Layers: retrieval (tool call) → relevance gate (a separate model call grading each result) → fallback path (rewrite query / widen search / escalate).

**Axis traced — "what catches the irrelevant-chunk problem?":** in vector RAG, the gate; here, nothing — the structured nature of EQL means there's no chunk-level relevance to grade, and structured-output validation (`tryParseAnomalies` etc.) catches the next failure mode (the model fabricated a result), not the retrieval failure mode.

**Seam:** the grader's verdict — a small typed `{relevant: bool, grounded: bool}` object that gates whether the retrieved content reaches the generation step.

## How it works

### Move 1 — the mental model

You know the difference between trusting a search result and double-checking it. Plain agentic RAG runs the retrieved chunks through the generator without verification — if the retrieval was wrong (the top-k were off-topic), the answer is wrong. Self-corrective RAG adds a checkpoint: a grader reads each chunk and asks "is this actually relevant?" before letting the generator see it. If not, it falls back — rewrite the query, widen the search, or escalate.

```
  The corrective gate

  retrieve ──► ┌─ grade each chunk ──────────────┐
               │  relevant? grounded?            │
               └──────────┬──────────────────────┘
                ┌──────────┴──────────┐
                ▼ relevant            ▼ not relevant
            generate              fall back:
                                  rewrite query / widen
                                  search / escalate
```

The point: retrieval success (chunks came back) is not answer success (the chunks are relevant and the answer is grounded in them). The grader is the gate that catches the gap.

### Move 2 — step by step

#### Why this doesn't apply to this repo's substrate

Vector RAG's failure mode is *relevance drift*: you embed a query, run ANN against the index, get the top 5 chunks back. Sometimes those chunks are about the query; sometimes they're about a phrase that happened to embed close to the query. The grader catches the second case.

This repo's substrate doesn't have that failure mode. When the diagnostic agent runs `execute_analytics_eql(eql='sum event purchase.total_price where customer.country=USA period 90d')`, the result is either:

- A number (the EQL succeeded; the number is canonical for that query).
- An error envelope (the EQL was malformed or hit rate-limit; the error surfaces to the model as a `is_error: true` tool_result).

There's no "is this chunk relevant?" decision. The result IS the answer to the query the model asked. If the model asked the *wrong* query, the result is canonical for the wrong question — but that's a different failure mode (query construction, not retrieval relevance) and it's handled by ReAct's next-turn reasoning ("that query didn't tell me what I wanted, let me ask a different one").

#### What this *would* look like if this repo added a knowledge layer

If the repo grew a vector store — say, embedding past investigation diagnoses for episodic memory — the grader pattern would apply at that layer:

```ts
// hypothetical lib/retrieval/past-diagnoses.ts (not implemented)
async function searchPastDiagnoses(query: string): Promise<{
  chunks: PastDiagnosis[];
  graded: boolean;
}> {
  const topK = await vectorStore.search(query, { k: 5 });
  // grader call (cheap model, structured output)
  const grades = await Promise.all(topK.map(async chunk => ({
    chunk,
    verdict: await graderModel.complete({
      system: GRADER_PROMPT,
      messages: [{
        role: 'user',
        content: `Query: ${query}\nChunk: ${chunk.summary}\nIs this relevant?`,
      }],
      maxTokens: 64,
    }),
  })));
  const relevant = grades.filter(g => parseVerdict(g.verdict).relevant).map(g => g.chunk);
  if (relevant.length === 0) {
    // fallback: widen the search, rewrite the query, or return empty
    return { chunks: [], graded: true };
  }
  return { chunks: relevant, graded: true };
}
```

The grader is one extra model call per chunk — cheap (Haiku-class) so the cost is acceptable. The pattern composes inside the agent's tool call: the tool itself runs retrieval + grading, and only surfaces verified chunks to the agent.

#### The closest parallel in this repo

The structured-output validators (`tryParseAnomalies` in `@aptkit/agent-anomaly-monitoring/.../validate.js`, `tryParseDiagnosis`, `validateRecommendations`) are *post-generation* gates — they run after the model has emitted the final text, checking it against a schema and returning null on failure. The recovery prompt (in `runAgentLoop`) re-asks the model to format correctly when parsing fails.

That's the cousin pattern to self-corrective RAG, but at the *generation* boundary instead of the *retrieval* boundary. Both add a checkpoint between a model output and the next pipeline step. The difference: validators check structure ("does this parse as `Anomaly[]`?"); a relevance grader checks meaning ("is this chunk actually about the query?").

### Move 3 — the principle

**Retrieval success is not answer success.** The pattern exists because vector retrieval is a similarity search, and similarity in embedding space doesn't perfectly track relevance to the user's intent. The grader bridges that gap by running an explicit relevance check.

For substrates where retrieval *is* canonical for the query asked (SQL, EQL, structured APIs), the pattern doesn't apply — there's no similarity-relevance gap to bridge. The substrate's structure does the work the grader would do.

## Primary diagram

```
  Self-corrective RAG (hypothetical, for a vector store added later)

  agent emits tool_use(search_past_diagnoses, query)
                       │
                       ▼
  ┌─ tool: search_past_diagnoses ───────────────────────────────┐
  │  topK = vectorStore.search(query, k=5)                       │
  │   ┌───────────────────────────────────────────────────────┐  │
  │   │  for each chunk in topK:                              │  │
  │   │    grade = graderModel.complete(GRADER_PROMPT, chunk) │  │
  │   │    if grade.relevant: relevant.push(chunk)            │  │
  │   └───────────────────────────────────────────────────────┘  │
  │   if relevant.empty:                                          │
  │     fallback: rewrite query? widen k? return [] with flag?    │
  │   return relevant (only the verified chunks)                  │
  └───────────────────────┬──────────────────────────────────────┘
                          │  tool_result
                          ▼
              agent sees only verified context;
              if [] returned, agent decides
              whether to issue another retrieval
              call with a rewritten query
```

## Elaborate

The self-corrective RAG pattern is sometimes called "Self-RAG" in the literature (Asai et al., 2023). The paper added retrieval gates *and* generation gates ("is the output grounded in the retrieved context?") — the version this file covers is the simpler retrieval-side variant.

The pattern's value scales with how noisy your retrieval is. For a dense semantic search over a well-curated corpus where the top-1 is almost always right, the grader is overhead with no win. For a noisy corpus (e.g. web search results) or a multi-source retrieval (vector + SQL + web), the grader becomes load-bearing — it's the only thing keeping irrelevant cross-source results from poisoning the answer.

The Anthropic/LangGraph "Adaptive RAG" pattern combines self-corrective RAG with retrieval routing (next file) — the router picks the source, the corrective gate verifies the chunks, the fallback can re-route to a different source if the first one fails. That's the production-grade synthesis of the patterns; this repo doesn't approach that complexity because it doesn't need to.

## Interview defense

> **Q: Does this codebase do self-corrective RAG?**
>
> No, and the absence is appropriate to the substrate. Self-corrective RAG catches the chunk-relevance failure mode that's specific to vector retrieval — the top-k chunks came back but they're not actually about the query. This repo runs structured-data retrieval (EQL queries against Bloomreach via MCP). When `execute_analytics_eql` returns a number, that number is canonical for the query asked; there's no relevance to grade. The failure mode here is "the model asked the wrong query," which ReAct handles in the next turn ("that wasn't useful, let me ask a different one").

> **Q: If you added a vector store for past investigation memory, would you add the grader?**
>
> Yes, at the retrieval-tool boundary. The grader would run inside the `search_past_diagnoses` tool implementation — top-5 chunks via similarity, each graded by a cheap model (Haiku) against the query, only the verified chunks returned to the agent. The cost is one extra Haiku call per chunk (~$0.0001/chunk), which is small relative to the ~$0.01 per Sonnet turn in the agent loop. The win is the agent never reasons over a chunk that's similar-but-not-relevant — which is exactly the failure mode that produces confidently-wrong diagnoses.

> **Q: What's the closest equivalent to a corrective gate in the current code?**
>
> The structured-output validators (`tryParseAnomalies`, `tryParseDiagnosis`, recommendation validators) plus the recovery prompt in `runAgentLoop`. They're *post-generation* gates instead of retrieval-side gates — they check that the model's final text parses as the expected schema. Same shape (output → gate → fall back if invalid) at a different boundary. The differences matter though: a schema validator catches format errors, not semantic relevance errors. A self-corrective RAG grader is qualitative; a schema validator is structural.

## See also

- → `01-agentic-rag.md` — the loop self-corrective RAG augments
- → `03-retrieval-routing.md` — the orthogonal "pick the right source first" pattern
- → `04-agent-infrastructure/04-agent-evaluation.md` — the post-generation validators that are this repo's cousin pattern
- → cross-reference (when generated): `study-ai-engineering`'s `03-retrieval-and-rag/` reranking file — the retrieval-quality mechanics this corrective gate compares against
