# 01 — LLM foundations

The model is a function. Input tokens → output tokens. Everything in this section
is about the I/O contract at that boundary — what travels in, what comes back, how
much it costs, and where the seams sit that let you swap providers, count tokens,
or constrain shapes.

## Files in reading order

```
01-what-an-llm-is.md          ← the I/O model — start here
02-tokenization.md             ← why tokens, not characters
03-sampling-parameters.md      ← temperature / top-p / top-k
04-structured-outputs.md       ← typed contracts at the LLM boundary (LOAD-BEARING)
05-streaming.md                ← NOT exercised inside the agent loop; IS exercised on the wire
06-token-economics.md          ← how much each briefing/investigation costs
07-heuristic-before-llm.md     ← where deterministic logic guards the LLM
08-provider-abstraction.md     ← the ModelProvider seam (this is the BIG one)
09-user-override-locks.md      ← NOT exercised — explained as a pattern
```

## What's load-bearing in this section for THIS codebase

  → **`04-structured-outputs.md`** — every agent's final answer is JSON
    extracted by `parseAgentJson` + checked by a hand-written type guard
    (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`). No JSON
    schema mode, no tool-call schema as output, no Zod. Read this to
    understand the "lenient parse + runtime validate" choice.

  → **`08-provider-abstraction.md`** — `ModelProvider` is AptKit's seam.
    Blooming implements it with `AnthropicModelProviderAdapter` so AptKit
    can run agent loops without knowing about Anthropic specifically. This
    is the *entire* reason AptKit code is reusable across projects.

  → **`07-heuristic-before-llm.md`** — the bootstrap chain
    (`list_cloud_organizations` → `list_projects` → `get_event_schema`) is
    deterministic; only AFTER it runs does the LLM see anything. The
    schema summary is hand-truncated (`schemaSummary()` in
    `lib/agents/monitoring.ts:19-60`) to bound input tokens.

## What's pattern-only (Case B) in this codebase

  → **`05-streaming.md`** — the agent loop itself uses non-streaming
    `messages.create()` (`lib/agents/aptkit-adapters.ts:52-55`), but the
    NDJSON wire format streams individual agent events to the UI. Two
    different streams, both called "streaming."

  → **`09-user-override-locks.md`** — the codebase has no user-editable
    LLM-generated fields. Taught as a pattern with a concrete refactor
    target (the recommendation card's title/rationale would be the natural
    place to add it).
