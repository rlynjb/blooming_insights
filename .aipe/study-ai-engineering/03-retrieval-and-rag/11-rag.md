# 11 — RAG (Retrieval-Augmented Generation)

**Type:** Industry standard. Also called: retrieve-then-generate, grounded generation.

## Zoom out, then zoom in

**Not exercised in this codebase.** The umbrella pattern. In this repo, "grounding" happens by tool_call (`execute_analytics_eql`) rather than by embedding retrieval — the agents fetch structured data on demand, not similar text from a vector store.

```
  Two flavors of grounding

  Classical RAG (not this codebase):        Tool-call grounding (this codebase):
  query → retrieve → augment prompt → gen    query → agent → tool_call → data → gen
```

## Structure pass

Axis: how is the model grounded to fresh/private knowledge?
- RAG: pre-embed a corpus; retrieve similar chunks; stuff into the prompt.
- Tool-call (this repo): the agent decides what to fetch and fetches it live via structured tools.

Both address the same failure mode (LLMs don't know your private data) — with different tradeoffs.

## How it works

### Move 1

Standard RAG has three phases: retrieve (dense/sparse over embedded corpus), augment (put retrieved chunks in the prompt), generate (model answers from the augmented prompt). This codebase does retrieve differently — it lets the agent call `execute_analytics_eql` with specific parameters, and the tool result is the "retrieved evidence" in structured form.

```
  Classical RAG                      This codebase (tool-call grounding)
  ────────────                       ──────────────────────
  question                            anomaly
    │                                    │
    ▼ embed + retrieve                   ▼ agent loop
  top-k chunks                        tool_use decides which tool + args
    │                                    │
    ▼ stuff in prompt                    ▼ tool_result comes back
  LLM generates from context          LLM reads structured data
```

### Move 2

**Where classical RAG would earn its place here.**

Past-investigation retrieval. A "similar past investigations" panel that pulls 3 relevant past diagnoses as CONTEXT for the current investigation would be classical RAG — embed the anomaly, retrieve top-3 by cosine, stuff summaries into the diagnostic agent's initial user message.

**Why we don't have it today.**

Two reasons. (1) Volume — past investigation count is low; a "similar past" panel would often have no meaningful matches. (2) The tool-call flow already gives the agent structured, current data — the RAG add would be about retrieving PRIOR REASONING, not current facts. Prior reasoning helps when the corpus is large enough that patterns emerge; small corpora, less so.

**Above-threshold rule.**

Don't add RAG to features that work without it. In this codebase, diagnosis works without RAG because the agent has structured tool access. Adding RAG for "similar past" would earn its place if a measurable diagnosis-quality win could be shown against no-RAG.

### Move 3

RAG solves one problem: connecting an LLM to knowledge it wasn't trained on. This codebase solves the same problem with tool calls over structured data. Different approach, same goal. The "add RAG" decision is a design question about what knowledge shape helps — text similarity of prior reasoning, or structured live-data queries.

## Primary diagram

```
  Umbrella comparison

  Classical RAG (would-be add)                Current tool-call flow
  ──────────────────                         ──────────────────
  anomaly text                                anomaly
      │                                          │
      ▼ embed + retrieve                        ▼ agent decides
  top-3 similar past diagnoses               tool_use: execute_analytics_eql
      │                                          │
      ▼ stuff into diagnostic agent's           ▼ live data
    initial user message                       tool_result
      │                                          │
      ▼                                          ▼
    diagnose (with prior-reasoning context)   diagnose (with live data)
```

## Elaborate

The tradeoff: classical RAG surfaces PRIOR ANSWERS and reasoning; tool-call surfaces CURRENT DATA. They compose — a mature product often uses both. This codebase has strong tool-call grounding today; RAG would be additive if past-reasoning retrieval showed measured value.

Modern RAG variants: **agentic RAG** (agent decides when and what to retrieve, not always), **self-RAG** (agent reflects on retrieval quality before generating), **graphRAG** (see next file).

## Project exercises

### Exercise — measure whether past-investigation RAG helps diagnosis

- **Exercise ID:** C2.14-B · Case B (RAG not exercised).
- **What to build:** if the RAG stack from `01-04` is present, run each of the 10 goldens through the diagnostic agent TWICE — once with a "3 similar past investigations" prefix in the user message, once without. Compare per-dim pass rates in the harness.
- **Why it earns its place:** the above-threshold test in action. Interviewer signal: "I don't add RAG on vibes — I measure whether it helps."
- **Files to touch:** `eval/run.eval.ts` (two-arm run), `lib/agents/diagnostic.ts` (accept optional context).
- **Done when:** report shows per-dim pass rates for with-RAG vs without-RAG on the 10 goldens.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Does this codebase use RAG?**

Not classical RAG (embedding + vector store). It uses tool-call grounding — the agents call `execute_analytics_eql` and other structured MCP tools to fetch current data on demand. Same goal (connect the LLM to knowledge it doesn't have), different mechanism.

**Q: When would you add classical RAG here?**

If past-reasoning retrieval showed measured value. A "similar past investigations" panel that pulls 3 relevant prior diagnoses as context for a new one — that's RAG earning its place if it lifts diagnosis-quality dim scores in an eval.

**Q: Why the split (tool-call for facts, RAG for reasoning)?**

Different knowledge shapes. Live data is best fetched fresh via tools — retrieval over stale embeddings of "how the workspace looked last week" would be worse than a fresh EQL query. But prior reasoning IS text, and similarity retrieval on it can surface applicable prior work.

## See also

- `04-agents-and-tool-use/02-tool-calling.md` — the tool-call grounding that stands in for RAG here
- `12-graphrag.md` — the graph-shaped alternative
- `07-system-design-templates/02-tech-support-chatbot.md` — a RAG-heavy system template
