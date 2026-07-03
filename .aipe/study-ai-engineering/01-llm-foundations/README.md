# 01 · LLM foundations

The interface-level model and the primitives every agent in this codebase uses. Nine concept files, each self-contained. Read in order the first time; jump around after.

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the LLM as a function, not a database.
- [02-tokenization.md](02-tokenization.md) — text → tokens → cost + context math.
- [03-sampling-parameters.md](03-sampling-parameters.md) — temperature, top-p, top-k; when to pin to 0.
- [04-structured-outputs.md](04-structured-outputs.md) — typed contracts at the LLM boundary; how `RubricJudge` and the agent tool schemas enforce shape.
- [05-streaming.md](05-streaming.md) — NDJSON over `ReadableStream` for the UI; why not SSE.
- [06-token-economics.md](06-token-economics.md) — the per-case cost ledger from a real eval receipt.
- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — the intent classifier + categories gate as heuristic-before-LLM routing.
- [08-provider-abstraction.md](08-provider-abstraction.md) — the `AnthropicModelProviderAdapter` and aptkit's `ModelProvider` port.
- [09-user-override-locks.md](09-user-override-locks.md) — user override discipline; how the codebase's UI + config surface protects agent output.

## The load-bearing files in this sub-section

- `lib/agents/aptkit-adapters.ts` — the provider adapter, 260 LOC.
- `lib/agents/pricing.ts` — Anthropic pricing helper (aptkit only knows OpenAI).
- `lib/agents/intent.ts` — the Haiku classifier (heuristic layer above Sonnet).
- `lib/mcp/events.ts` + `lib/mcp/types.ts` — the typed streaming contract.
