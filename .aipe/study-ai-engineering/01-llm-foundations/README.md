# 01 — LLM foundations

The foundations: what the LLM actually is, how text becomes tokens, what sampling parameters do, how structured outputs are enforced through tool calling, the token economics that drive cost, the heuristic-before-LLM router that keeps cost down, and the provider port that lets you swap Anthropic for anything else later.

Most of these land as straightforward concept walks against the codebase's existing patterns. The two with the most local weight are:

- **`07-heuristic-before-llm.md`** — the intent classifier (`lib/agents/intent.ts`) is the local instance of this pattern, applied at the *intent* layer rather than the *tool* layer.
- **`08-provider-abstraction.md`** — the `ModelProvider` port (from `@aptkit/core`) is the load-bearing seam that lets every agent depend on the abstraction, not the SDK.

Streaming (`05-streaming.md`) is the inverse case: this codebase deliberately does NOT stream the LLM response itself — it streams the *agent's reasoning* via NDJSON. The file explains why.

## Reading order

The files are concept-shaped, not strictly sequential. Read in this order on first pass:

1. `01-what-an-llm-is.md` — the IO model. The mental anchor for the rest.
2. `02-tokenization.md` — why context windows are sized in tokens, not chars.
3. `03-sampling-parameters.md` — temperature / top-p / top-k; what the adapter sets (or doesn't).
4. `04-structured-outputs.md` — the tool-calling contract as the structured-output mechanism.
5. `05-streaming.md` — why this app streams reasoning, not tokens.
6. `06-token-economics.md` — what a scan / investigation / proposal costs.
7. `07-heuristic-before-llm.md` — the intent classifier as the local instance of the pattern.
8. `08-provider-abstraction.md` — the `ModelProvider` port: the load-bearing seam.
9. `09-user-override-locks.md` — `not yet exercised` in this codebase; honest treatment.
