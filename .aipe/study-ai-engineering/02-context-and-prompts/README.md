# 02 · Context and prompts

Three concepts on context management and prompt composition:

- [01-context-window.md](01-context-window.md) — the finite container and what competes for space in this codebase.
- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — why the schema summary is trimmed and where relevance ordering matters.
- [03-prompt-chaining.md](03-prompt-chaining.md) — the diagnostic → recommendation chain that powers the investigation flow.

## The load-bearing files in this sub-section

- `lib/agents/monitoring.ts:19-88` — `schemaSummary()` — the trimmed schema fits in ~1500 tokens.
- `lib/agents/aptkit-adapters.ts:75-98` — the cache_control breakpoint on the system prompt.
- `lib/agents/diagnostic.ts` + `lib/agents/recommendation.ts` — the two-step chain wired through the route.
