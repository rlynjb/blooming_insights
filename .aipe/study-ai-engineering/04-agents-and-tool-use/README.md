# 04 — agents and tool use

**The load-bearing section for this codebase.** Every feature in blooming
insights runs through an agent loop. AptKit owns the loop; Blooming wraps
it in three adapters. Five agents (monitoring, diagnostic, recommendation,
query, intent) compose into the product.

## Files

```
01-agents-vs-chains.md     ← the loop-vs-pipeline distinction (LOAD-BEARING)
02-tool-calling.md         ← tool_use / tool_result message shape + adapter
03-react-pattern.md        ← Thought / Action / Observation trace
04-tool-routing.md         ← heuristic-vs-LLM tool picking; per-agent allowlists
05-agent-memory.md         ← in-context history (no long-term yet)
06-error-recovery.md       ← rate-limit retry, tool errors, hard caps
```

## What's load-bearing in this section

  → **`01-agents-vs-chains.md`** — explains why blooming insights is BOTH:
    a *chain* at the top (monitoring → diagnostic → recommendation) and
    a *loop* inside each agent. The chain is in Blooming's route handler;
    the loop is in AptKit.

  → **`02-tool-calling.md`** — the `BloomingToolRegistryAdapter` is the
    seam where AptKit's agent loop calls Blooming's data sources. Without
    this seam, AptKit wouldn't know how to call Bloomreach MCP tools.

  → **`04-tool-routing.md`** — per-agent allowlists in `lib/mcp/tools.ts`
    are how Blooming controls which tools each agent can pick. Coverage
    gating via `categories.ts` is the heuristic-before-LLM routing.

## What's pattern-only (Case B)

  → **`05-agent-memory.md`** — only short-term (in-context) memory exists
    today. Long-term memory across sessions would land in
    `03-retrieval-and-rag/11-rag.md`-style RAG over past investigations.
