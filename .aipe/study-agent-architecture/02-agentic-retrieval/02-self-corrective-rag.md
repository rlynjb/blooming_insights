# Self-corrective RAG

*Industry name: self-corrective RAG / CRAG / Self-RAG — Industry standard.*

Add a relevance grader between retrieval and generation, with a fallback path on poor retrieval. Not in this repo (no RAG of any kind). Covered as placement.

## Zoom out — where this concept would live

If RAG were adopted (see `01-agentic-rag.md`), the grader step would sit between the retrieval tool and the generation step inside the agent loop.

```
  Where self-corrective RAG WOULD live

  ┌─ Agent layer (hypothetical KnowledgeAgent) ──────────────┐
  │  ReAct loop:                                              │
  │    pick query                                             │
  │    retrieve chunks                                        │
  │    ★ GRADE each chunk: relevant? grounded? ★ ← would live│
  │      relevant → generate                                  │
  │      not       → rewrite query / widen search / escalate  │
  └──────────────────────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

Retrieval success (a chunk came back) is not answer success (the chunk is relevant and the answer is grounded in it). Self-corrective RAG is the gate that catches the gap. You know form validation — the form submitted (succeeded at HTTP), but the data is wrong (failed at validation). Same shape: retrieval returned (succeeded at SQL), but the chunks are off-topic (failed at relevance).

```
  Self-corrective RAG — retrieve + grade + fallback

  retrieve → ┌─────────────────────────┐
             │ grade each chunk:       │
             │ relevant? grounded?     │
             └──────────┬──────────────┘
              ┌──────────┴──────────┐
              ▼ relevant            ▼ not relevant
          generate            fall back:
                              rewrite query / widen
                              search / escalate
```

### Move 2 — what the grader actually checks

Two predicates, both required:

- **Relevant** — does this chunk address the sub-question? (a similarity score above some threshold is necessary but not sufficient)
- **Grounded** — can the generation actually be supported by this chunk's content, or is the chunk topical but lacking the specific fact?

The grader is typically a cheap LLM call (a haiku, GPT-4o-mini) given the question and a chunk, returning `{ relevant: bool, grounded: bool, reasoning: string }`. The cost is one cheap call per chunk, so for top-5 retrieval the grader adds ~5 cheap calls.

### Move 3 — the principle

The grader catches the failure that breaks naïve RAG most often: the top-k similar chunks are about the right topic but don't contain the specific answer. Without a grader, the model rationalizes — "based on the retrieved context, X seems to be the case" — and hallucinates plausibly. With a grader, the loop catches this and either rewrites the query or escalates.

## In this codebase

**Not implemented. Not applicable today.** This repo has no retrieval-then-generate path — the agents either query live data and reason directly, or recommend actions grounded in a diagnosis they already have. There are no chunks to grade.

The closest analogue: the diagnostic agent's prompt requires every claim in `evidence[]` to cite a tool result the agent actually observed. That's a *structural* grounding rule applied at the producer, not a critic-after-the-fact grader. If we ever added a corpus-grounded agent, the self-corrective grader would be the path forward.

## Primary diagram

The contrast: what RAG looks like with vs without a grader.

```
  Comparison — naïve RAG vs self-corrective RAG

  Naïve:
  ┌──────┐  top-k  ┌──────┐  stuff  ┌──────┐
  │query │ ──────► │vector│ ──────► │ LLM  │ → answer (maybe hallucinated)
  └──────┘         └──────┘         └──────┘

  Self-corrective:
  ┌──────┐  top-k  ┌──────┐  per-chunk  ┌──────┐
  │query │ ──────► │vector│ ──────────► │grader│
  └──────┘         └──────┘             └──┬───┘
                              ┌────────────┴──────────┐
                              ▼ all/most relevant     ▼ none/few relevant
                          ┌──────┐               rewrite query OR
                          │ LLM  │ → answer       widen search OR
                          └──────┘                escalate to human
```

## Interview defense

**Q: "How would you prevent hallucination in a RAG agent?"**

A: Three layers. First, structural — every claim must cite a retrieved chunk by id; the generation prompt enforces it and a post-processor strips claims that don't. Second, self-corrective grader — a cheap LLM call between retrieval and generation that scores each top-k chunk for relevance + groundedness; on a bad batch, the loop rewrites the query or escalates. Third, the diagnostic agent's pattern in this repo: every evidence item in the output must cite the tool call it came from, so the structural rule applies even when the "retrieval" is a SQL query rather than a vector search. The graders are the cost-effective middle layer — much cheaper than full reflexion (`../01-reasoning-patterns/05-reflexion-self-critique.md`).

Anchor: "in this repo there are no chunks to grade because there's no RAG — but the diagnostic prompt's 'every claim cites a tool result' rule is the same insight at a structural level."

## See also

- [`01-agentic-rag.md`](./01-agentic-rag.md) — the loop the grader plugs into
- [`../01-reasoning-patterns/05-reflexion-self-critique.md`](../01-reasoning-patterns/05-reflexion-self-critique.md) — the heavier version of the same idea
