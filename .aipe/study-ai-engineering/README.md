# study-ai-engineering — blooming insights

The AI engineering guide for this repo. blooming insights is a Next.js multi-agent
analyst for a Bloomreach Engagement workspace — five agents (monitoring, diagnostic,
recommendation, query, intent) running on `@aptkit/core@0.3.0` with Anthropic
`claude-sonnet-4-6` (and `claude-haiku-4-5-20251001` for intent), talking to the
Bloomreach loomi connect MCP server. This guide walks every AI pattern the codebase
actually uses, anchored to real files and line ranges.

Reading order

```
1.  00-overview.md                   ← read first; the whole system in one diagram
2.  ai-features-in-this-codebase.md  ← what the five agents do, in one table
3.  01-llm-foundations/              ← model I/O, tokens, streaming, structured output
4.  02-context-and-prompts/          ← the context window, chaining, lost-in-the-middle
5.  03-retrieval-and-rag/            ← NOT YET EXERCISED (see README in folder)
6.  04-agents-and-tool-use/          ← the load-bearing layer — AptKit owns the loop
7.  05-evals-and-observability/      ← built-but-thin: no eval harness, structured logging only
8.  06-production-serving/           ← caching, cost, prompt injection, rate-limit, retry
9.  07-system-design-templates/      ← interview reframes (search ranking, support chatbot)
```

## What's load-bearing here

If you only have an afternoon, the spine is:

  → **`04-agents-and-tool-use/`** — the agent loop is the whole product. AptKit owns
    it; Blooming wraps it in three adapters (`AnthropicModelProviderAdapter`,
    `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) in
    `lib/agents/aptkit-adapters.ts`. The trace sink is the bridge between
    AptKit's capability events and Blooming's NDJSON wire format.

  → **`01-llm-foundations/08-structured-outputs.md`** — every agent's final answer
    parses through `parseAgentJson` + a hand-written type guard in
    `lib/mcp/validate.ts`. No schema-mode, no tool-call JSON contract — lenient
    extraction plus runtime validation.

  → **`02-context-and-prompts/03-prompt-chaining.md`** — monitoring → diagnostic
    → recommendation is the chain. The investigate page splits diagnose (step 2)
    and recommend (step 3) into separate route calls so the user can stop after
    the diagnosis if that's all they wanted.

  → **`06-production-serving/04-rate-limiting-backpressure.md`** + **`05-retry-circuit-breaker.md`**
    — the alpha Bloomreach server enforces "1 per 10 second" globally per user,
    and the `BloomreachDataSource` retry ladder (parse hint → backoff → ceiling)
    is the reason live mode works at all.

## What's NOT exercised (case B — taught as patterns, not anchored)

  → **RAG / vector retrieval** — there's no vector store, no embeddings, no
    chunking. Bloomreach EQL queries are the "retrieval" the agents do, and
    they're MCP tool calls against a relational/event store. `03-retrieval-and-rag/`
    teaches the pattern and names what RAG would add if you wanted journal-style
    semantic search on top of customer data.

  → **Automated eval harness** — the honest current state: no LLM-as-judge,
    no golden set, no regression eval. `05-evals-and-observability/` covers
    eval *patterns* you'd add to harden this codebase. Unit tests with fake
    MCP adapters are what stands in today (24 files, 221 passing).

  → **Current data-source modes** — `bi:mode` resolves to `demo`,
    `live-bloomreach`, or `live-synthetic`. Two `DataSource` adapters:
    `BloomreachDataSource` (real MCP) and `SyntheticDataSource` (local
    fake). See `lib/data-source/`.

## Cross-links

This guide overlaps the other study generators at well-defined seams:

  → **`.aipe/study-system-design/`** owns the system-shape walkthroughs (request
    flow, OAuth boundary, streaming NDJSON, multi-agent orchestration). This
    guide owns the AI-specific mechanics inside those shapes.

  → **`.aipe/study-prompt-engineering/`** owns the prompt-shape patterns. This
    guide names *that the prompts exist* (`lib/agents/legacy-prompts/*.md`,
    now consumed inside AptKit) but doesn't re-teach prompt composition.
