# 01 — LLM foundations

Phase 1 of the blooming insights AI-engineering study guide: the load-bearing facts about what a language model *is* and how the codebase wraps it. Each file is a full per-concept study sheet (Why care → How it works → primary diagram → In this codebase → Elaborate → Tradeoffs → Tech reference → Project exercises → Summary → Interview defense → Validate).

## Index

- **[01-what-an-llm-is.md](01-what-an-llm-is.md)** — An LLM is a next-token *function* returning a `string`, never a typed object; the codebase earns the type at the boundary with `parseAgentJson` + type guards + a hard-coded `FALLBACK`. (foundational — C1.13/C1.14 context)
- **[02-tokenization.md](02-tokenization.md)** — Models bound and bill in tokens; blooming insights does no token counting and bounds prompts with *character* budgets (`MAX_TOOL_RESULT_CHARS=16_000`, route `TRUNC=4000`, `schemaSummary` caps) plus `max_tokens` — a coarse ≈4-chars/token proxy. (C1.1, learn-only)
- **[03-sampling-parameters.md](03-sampling-parameters.md)** — No `temperature`/`top_p`/`top_k` set anywhere (Claude defaults); only `max_tokens` is tuned, including a deliberate `16` on the intent classifier. Why defaults are fine for the analysts and a small gap for the classifier/synthesis. (C1.3, B1.3)
- **[04-structured-outputs.md](04-structured-outputs.md)** — The output contract: extract JSON from prose, validate the shape, repair via a clean-context `synthesize()` before `FALLBACK`. Native tool-use for *input*, parse-from-prose for the *final artifact*. (C1.4, B1.1) — **codebase strength.**
- **[05-streaming.md](05-streaming.md)** — NDJSON over a `ReadableStream` (schema bootstrap now happens *inside* the stream; `maxDuration = 300`), consumed by `fetch`+`getReader()`+`TextDecoder` in the StrictMode-safe `useInvestigation` hook, deliberately *not* `EventSource` (reconnect would re-fire the run). Streaming is the product surface, not a spinner. (C1.5, Case A here) — **codebase strength.**
- **[06-token-economics.md](06-token-economics.md)** — Cost *bounds* present (`maxToolCalls` budgets, truncation, haiku-vs-sonnet tiering); cost *meter* absent (nothing reads `res.usage`, no `ai_call_log`). Bounded but blind. (C1.6, B1.2/B1.8)
- **[07-heuristic-before-llm.md](07-heuristic-before-llm.md)** — The free path before the paid path: `parseIntent` substring heuristic before the `classifyIntent` haiku call, and the route's parameter-presence branch before either. (C1.9, B1.5/B1.8)
- **[08-provider-abstraction.md](08-provider-abstraction.md)** — A *testability* seam (`McpCaller`/`McpTransport` + injected `anthropic` param → fakes in tests, no network), **not** multi-LLM-provider switching (one provider, concrete SDK type, no factory). (C1.8, B1.6)
- **[09-user-override-locks.md](09-user-override-locks.md)** — Read-only analyst: no user-editable persisted fields, so no `_overridden_at`. If recommendations became dismissible/editable, a re-run must not clobber the human's edit. (C1.11, B1.9)

## How to read this section

- **Strengths (read first to see the codebase at its best):** `05-streaming.md` and `04-structured-outputs.md` are where blooming insights does the hard thing well — a real "show its work" stream and a robust extract/validate/repair output contract.
- **Case B (study material + buildable target):** `09-user-override-locks.md` is fully Case B — the concept is real interview knowledge, the codebase has no analog (read-only data), and the `Project exercises` block is the thing to build. `02-tokenization.md` is Case-B-adjacent: the real tokenizer is absent, but the honest character-budget analog is present and the exercises add real token accounting.
- **Honest gaps named, not hidden:** `06` (cost meter absent), `08` (provider portability absent), `03` (temperature unset) each state the absence plainly and name the fix — the gap *is* the interview signal.

All citations are to blooming insights files (verified line numbers) and curriculum IDs for provenance only.

---
Updated: 2026-05-28 — Refreshed the 05-streaming entry for `maxDuration = 300`, bootstrap-in-stream, and the consumer's move to the `useInvestigation` hook; the rest of the index verified accurate against the current source.
