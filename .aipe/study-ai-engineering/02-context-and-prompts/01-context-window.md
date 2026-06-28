# 01 — context window

**Subtitle:** Fixed token budget per call · Industry standard

## Zoom out, then zoom in

Every model call has a finite token budget — input plus output combined. For
`claude-sonnet-4-6` that's 200,000 tokens. The model sees ONLY what's in that
window. Everything Blooming does to manage prompts, summaries, and turn
counts is in service of staying inside it.

```
  Zoom out — the window is one config of one call

  ┌─ Agent adapter (lib/agents/aptkit-adapters.ts:42) ─────┐
  │  anthropic.messages.create({                           │
  │    model: 'claude-sonnet-4-6',  ← 200k token window   │
  │    max_tokens: 4096,            ← OUTPUT cap          │  ← we are here
  │    messages: [...history],      ← INPUT eats the rest │
  │    system: '...',                                      │
  │    tools: [...],                                       │
  │  })                                                    │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — utilization.** The window contains five
    competing things: system prompt, conversation history (grows per turn),
    tool definitions, current tool results, and reserved output space
    (`max_tokens`). Hold "what fraction of 200k is each?" as the question:
    in this codebase the answer per turn is roughly 0.5% / 5-15% / 1% /
    1-10% / 2%, totaling well under 30%. The cap is comfortable.

  → **The seam:** between "what you ship" (`AnthropicModelProviderAdapter.complete()`)
    and "what the model sees" (the assembled prompt). The seam is where
    truncation must happen — once you've shipped, you've paid.

## How it works

### Move 1 — the mental model

Same as RAM in a process: fixed size, multiple consumers, OOM if you exceed
it. The fix is the same too: budget per consumer, cap each, monitor
utilization.

```
  The context window — competing consumers

  ┌─────────────── 200,000 tokens (claude-sonnet-4-6) ───────────────┐
  │                                                                  │
  │  ┌─ system prompt (the agent's role) ───────┐                   │
  │  │  ~500 tokens · monitoring.md / etc.       │                   │
  │  └───────────────────────────────────────────┘                   │
  │                                                                  │
  │  ┌─ schema summary (workspace context) ─────┐                   │
  │  │  ~1500 tokens · schemaSummary() trims    │                   │
  │  │  from ~30k full schema                   │                   │
  │  └───────────────────────────────────────────┘                   │
  │                                                                  │
  │  ┌─ tool definitions (per-agent allowlist) ──┐                  │
  │  │  ~1000 tokens · 8-17 tools with schemas   │                  │
  │  └────────────────────────────────────────────┘                  │
  │                                                                  │
  │  ┌─ conversation history (grows per turn) ──────────┐           │
  │  │  turn 1: ~3-5k                                    │           │
  │  │  turn 6: ~10-15k (prior turns + tool results)    │           │
  │  └───────────────────────────────────────────────────┘           │
  │                                                                  │
  │  ┌─ reserved output (max_tokens=4096) ──┐                       │
  │  └───────────────────────────────────────┘                       │
  │                                                                  │
  │  ┌─ unused (huge cushion) ──────────────────────────────────────┐│
  │  │  ~180k tokens left                                           ││
  │  └───────────────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The cap is set per call, not per loop.** Look at `complete()` again
(`lib/agents/aptkit-adapters.ts:43-46`):

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: this.defaultModel,
  max_tokens: request.maxTokens ?? 4096,
  messages: request.messages.map(toAnthropicMessage),
};
```

  → **`max_tokens: 4096`** is the *output* cap. The model will stop after
    4096 tokens regardless. This bounds individual call cost and prevents
    runaway generation. It does NOT bound input.

  → **`messages: …`** is the input — the *whole* conversation history. On
    turn 1 it's just the user message + tool results so far (~empty). On
    turn 6 it's the user + 5 prior assistant turns + 5 sets of tool
    results. The model re-reads everything every time.

**Where the budget pressure comes from.** Three growers, in order of
significance:

  → **Tool results.** Bloomreach EQL queries can return large payloads
    (event lists, customer counts, segmentation tables). The route
    truncates results to 4000 chars before they ride the NDJSON wire
    (`app/api/agent/route.ts:97-101` — `trunc(tc.result)`), but the
    *agent loop itself* sends the full result to the next turn. A 10kb
    EQL result is roughly 2.5k tokens — manageable per turn, but six of
    them stack to 15k.

  → **Schema summary.** `schemaSummary(schema)` (`lib/agents/monitoring.ts:19-60`)
    truncates aggressively: top 20 events, 10 properties each, 30 customer
    properties. Output is ~1.5k tokens; full schema would be ~30k. Without
    this truncation, a 6-turn loop would carry 180k tokens of repeated
    schema. See `01-llm-foundations/02-tokenization.md` for the numbers.

  → **Tool definitions.** Per-agent allowlists from `lib/mcp/tools.ts` — 8
    tools for recommendation, 13 for monitoring, 17 for diagnostic, ~20 for
    query. Each tool definition is ~50-100 tokens (name + description +
    inputSchema). The diagnostic agent's 17 tools take ~1.5k tokens, repeated
    every turn.

**The current health check.** Run a typical 6-turn diagnostic investigation:

  ```
  turn 1:  system 500  + schema 1500 + tools 1500 + messages 1000   ≈ 4.5k
  turn 2:  system 500  + schema 1500 + tools 1500 + messages 2500   ≈ 6k
  turn 3:  system 500  + schema 1500 + tools 1500 + messages 4500   ≈ 8k
  turn 4:  system 500  + schema 1500 + tools 1500 + messages 7000   ≈ 10.5k
  turn 5:  system 500  + schema 1500 + tools 1500 + messages 10000  ≈ 13.5k
  turn 6:  system 500  + schema 1500 + tools 1500 + messages 14000  ≈ 17.5k
  ```

That's well under the 200k cap. The 6-tool-call hard limit in the prompt
(monitoring/diagnostic) and 4-tool-call limit (recommendation) bound the
turn count. Even with the largest tool results coming back, the loop has
~10x headroom.

**Where pressure could grow.** If you removed the schema truncation OR
removed the per-prompt tool-call cap OR introduced RAG (which would add
retrieved-doc chunks to context), pressure would climb fast. The current
configuration is conservative on purpose — it has to work against an alpha
MCP server that can return arbitrary-sized EQL payloads.

**What happens if you exceed.** The Anthropic API returns a 400 with a
`max_tokens_exceeded` error. The error doesn't naturally retry; it surfaces
as a thrown exception in `complete()`, propagates up through AptKit's loop,
and the route layer catches it and emits `{ type: 'error', message: ... }`
on the NDJSON stream. The user sees a "something went wrong" panel.

### Move 3 — the principle

**Budget every consumer, cap each, monitor utilization.** Three numbers
matter: (1) the model's hard cap, (2) the per-turn growers (schema, tool
results), (3) the turn count multiplier. Multiply (2) by (3) and confirm
it's well under (1). Add headroom for tool results to grow unexpectedly.

This codebase has a generous cap (200k) and aggressive defaults (20/10/30
schema truncation, 6-call loop, 4096 output cap). The conservative
defaults make context overflow effectively impossible on the current data
shape — which is why nothing in the code path actively monitors
utilization. Once RAG or longer histories enter the system, that has to
change. See the exercise.

## Primary diagram

```
  Context window over a 6-turn diagnostic loop

  utilization:

  turn 1:  ██░░░░░░░░░░░░░░░░░░  4.5k / 200k  (2.3%)
  turn 2:  ███░░░░░░░░░░░░░░░░░  6k   / 200k  (3.0%)
  turn 3:  ████░░░░░░░░░░░░░░░░  8k   / 200k  (4.0%)
  turn 4:  █████░░░░░░░░░░░░░░░ 10.5k / 200k  (5.3%)
  turn 5:  ███████░░░░░░░░░░░░░ 13.5k / 200k  (6.8%)
  turn 6:  █████████░░░░░░░░░░░ 17.5k / 200k  (8.8%)

  growers per turn:
    + tool result          ← biggest, unpredictable size
    + agent text / tool_use
    + (schema, tools, system: STATIC per turn)
```

## Elaborate

The 200k Sonnet context window is generous by 2026 standards but not
infinite. Earlier Claude models had 100k; even earlier ones had 8k. The
20/10/30 schema truncation budgets were sized for the 100k era and survive
into the 200k era as conservative defaults. If the truncation budgets were
re-derived today, the schema summary could be ~5k without trouble — but
nothing's broken at 1.5k, and the smaller summary means cheaper turns (see
`06-token-economics.md`).

The reason there's no in-app context-pressure monitor: the data shape this
codebase sees doesn't push the limits. EQL tool results are mostly
aggregates (counts, sums) — small. The schema summary is bounded by
construction. The agent prompts cap tool calls hard. There's nothing in the
hot path that *can* explode. The moment that changes (RAG, larger schemas,
multi-tenant deep histories), `02-tokenization.md`'s exercise 2 — the
context-pressure warning at 100k — becomes relevant.

The 4096 `max_tokens` default deserves a note: Sonnet 4.6's hard `max_tokens`
ceiling per call is 8192. Bumping the default would let longer JSON synthesis
fit (e.g. monitoring's `Anomaly[]` with all 10 categories' impact prose), but
also let runaway generation eat more budget. 4096 is the conservative
default; the recommendation agent's typical final-turn output is ~1500
tokens, so it's not currently constrained.

## Project exercises

### Exercise — emit context utilization with each agent turn

  → **Exercise ID:** `study-ai-eng-02-01.1`
  → **What to build:** In `AnthropicModelProviderAdapter.complete()`,
    compute `(input_tokens / 200_000) * 100` and emit a
    `{ type: 'context_utilization', percent }` trace event before the
    response is returned. Surface in the StatusLog as a small bar.
  → **Why it earns its place:** Visibility before the limit matters.
    Today there's nothing in the UI that tells you a long investigation
    is approaching the wall.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:63-71`,
    `lib/mcp/events.ts` (new type), `components/investigation/ReasoningTrace.tsx`
    (render).
  → **Done when:** Each agent turn surfaces a utilization percent in the
    status panel during live runs.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How big is the context window blooming insights uses, and how much of
it do you actually consume?**

Sonnet 4.6's context window is 200k tokens. A typical 6-turn diagnostic
investigation peaks at ~17.5k tokens — under 9% of the window. Three things
keep utilization low: the schema is hand-truncated from ~30k to ~1.5k by
`schemaSummary()` (`lib/agents/monitoring.ts:19-60`), per-agent tool
allowlists keep tool definitions to ~1.5k, and the prompt enforces a
6-tool-call cap so turn count is bounded.

```
  Budget breakdown per turn (turn 6 of a diagnostic):
    system prompt           500   tok    ← static
    schema summary         1500   tok    ← static
    tool definitions       1500   tok    ← static
    conversation history  14000   tok    ← grows
                          ─────
                         17500   tok / 200000 = 8.8% utilization
```

**Anchor line:** "Plenty of headroom. The 20/10/30 schema truncation in
`schemaSummary` is what keeps history growth slow."

**Q: What would push you close to the cap?**

Three things: (1) RAG (currently not implemented; would add retrieved chunks
per turn), (2) longer conversation histories (the current cap is per
investigation; a persistent chat would accumulate), (3) un-truncated EQL
tool results (currently bounded by the model's tool-call patterns, not by
explicit truncation in the loop). None of those exist today; they're the
refactors that would trigger building real context monitoring.

**Anchor line:** "Conservative defaults today, but the *pressure model* —
schema + tools + history per turn × turn count — is the right shape to
reason about it."

## See also

  → `01-llm-foundations/02-tokenization.md` — what `input_tokens` measures
  → `01-llm-foundations/06-token-economics.md` — what utilization costs in dollars
  → `02-lost-in-the-middle.md` — when window position matters
