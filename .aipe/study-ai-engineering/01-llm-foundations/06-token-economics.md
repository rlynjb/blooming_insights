# Token economics

*Industry standard — pay-per-token pricing model*

## Zoom out — where this concept lives

Every LLM call in this codebase emits a `usage` log line (`input_tokens`, `output_tokens`). Multiply by the model's per-token rate; you have the bill. The two cost-drivers here are (1) Sonnet's per-token rate × the agents' tool-loop token volume, and (2) the absence of prompt caching, which means long system prompts pay full price on every call.

```
  Zoom out — what costs money in this stack

  ┌─ Per-user flow ──────────────────────────────────────────┐
  │  briefing scan       → monitoring agent  (Sonnet, ~$0.06)│
  │  click card          → diagnostic agent  (Sonnet, ~$0.08)│
  │  click "see recs"    → recommendation    (Sonnet, ~$0.07)│
  │  ask any question    → intent classify (Haiku, ~$0.0003) │
  │                        + query agent     (Sonnet, ~$0.05)│
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ ★ The ledger ★ ─────────────────────────────────────────┐ ← we are here
  │  one full flow (scan → diagnose → recommend) ≈ $0.21     │
  │  per user, per session, before any caching savings.      │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Costs are tractable because volume is low (this is an analyst tool, not a chatbot). But the rates are honest about the scaling math: 1,000 sessions/day = $210/day = ~$6,300/month, and that's *before* prompt caching cuts the input-token bill.

## Structure pass — layers · axes · seams

**Layers:** model → tokens → dollars.

**Axis: where do the tokens go?** Mostly to *input* — the system prompt + schema summary + tool definitions + tool results are large; the model's output is small. Typical ratio: ~10× input to output tokens.

**Seam:** the per-call `usage` log at `lib/agents/aptkit-adapters.ts:55-60`. That's where token volume becomes visible. Aggregating across calls is something this codebase doesn't do yet — Vercel log queries are the only path.

## How it works

### Move 1 — the mental model

You know how AWS charges per request + per GB? Anthropic charges per input token + per output token, at different rates. Output tokens are ~5× more expensive than input tokens. Your bill is `Σ(input × input_rate + output × output_rate)` across every call.

```
  The cost shape — input vs output tokens

  ┌─ One monitoring scan ───────────────────────────────────┐
  │  Input tokens (you pay full price):                     │
  │   system prompt        ~400 tokens                      │
  │   schema summary       ~500 tokens                      │
  │   tool definitions     ~800 tokens                      │
  │   tool results (×6)   ~12,000 tokens (truncated to 4KB) │
  │   ────────────────────────────────                      │
  │   Total input         ~13,700 tokens                    │
  │                                                         │
  │  Output tokens (5× more expensive per token):           │
  │   tool_use blocks      ~600 tokens                      │
  │   anomaly synthesis    ~800 tokens                      │
  │   ────────────────                                      │
  │   Total output        ~1,400 tokens                     │
  │                                                         │
  │  Cost (Sonnet 4.6 pricing, approx 2026):                │
  │   input:  13,700 × $3/1M  = $0.041                      │
  │   output:  1,400 × $15/1M = $0.021                      │
  │   ──────────────────────                                │
  │   Total per scan: ~$0.062                               │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — where the tokens are logged.**

Every Anthropic call emits a log line from `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:55-60`:

```typescript
console.log(JSON.stringify({
  site: this.logSite,                // "agents/{name}:aptkit-model"
  sessionId: this.sessionId,
  usage: response.usage,             // { input_tokens, output_tokens }
}));
```

That's it. No aggregation, no per-day rollup, no per-route cost. To answer "how much did we spend yesterday on diagnostic agents?", you query Vercel logs for `site = "agents/diagnostic:aptkit-model"`, sum input + output across the time window, multiply by Sonnet rates.

**Part 2 — where the tokens come from (input side).**

The input side has four contributors, in rough descending order:

  → **Tool results** (~70% of input on a typical scan). Each `tool_call_end` feeds the truncated (4KB) result back to the model as a `tool_result` content block. With 6 tool calls × 4KB each = 24KB ≈ ~6000–8000 tokens depending on the result shape.
  → **Tool definitions** (~10–15% of input). Each agent ships its tool subset to the model: monitoring's 13 tools, diagnostic's 17, etc. Tool schemas are verbose JSON — even with no calls made yet, the prompt carries ~800 tokens of tool definitions.
  → **System prompt** (~5%). The agent's role + rules. Monitoring's prompt at `lib/agents/legacy-prompts/monitoring.md` is ~400 tokens.
  → **Schema summary** (~5%). `schemaSummary()` at `lib/agents/monitoring.ts:18` caps at 20 events + 10 properties + 30 customer props ≈ ~400-500 tokens.

**Part 3 — output side is the structured output, plus reasoning text.**

Output is dominated by:

  → **`tool_use` blocks** — the agent's tool calls. Each is ~50-100 tokens (name + small input object). 6 calls ≈ 400-600 tokens.
  → **Final synthesis** — the typed reduction (`Anomaly[]`, `Diagnosis`, etc.). Verbose for recommendations (rationale + steps + impact), small for anomalies.

**Part 4 — the cheap-classifier savings.**

Intent classification (`lib/agents/intent.ts:30`) uses Haiku, not Sonnet. Per call cost: ~$0.0003 vs ~$0.05 for a Sonnet query. The savings only materialize on the free-form `q` path where the user types a question — the briefing/investigation paths don't classify intent. But on the chat surface, the savings compound: a generic "hi" or off-topic question gets a cheap Haiku call and a default-route to the query agent, never spinning up a full Sonnet investigation.

```
  Cheap-classifier routing cost shape

  user types "hi"
       │
       ▼
  intent classify (Haiku, ~$0.0003) → 'generic'
       │
       ▼
  query agent (Sonnet, ~$0.005 for a short answer)
       │
       ▼
  Total: ~$0.0053 instead of jumping straight to a
         full ~$0.05 Sonnet investigation.

  On bigger questions (legit metric queries), the
   intent classify adds $0.0003 to a $0.05 investigation —
   essentially free. The Haiku call also serves a routing
   purpose, not just cost: pickng the right downstream agent.
```

### Move 3 — the principle

**Output tokens cost more; tool results dominate input.** The two biggest cost levers are (1) prompt caching for the static parts (system prompt + tool definitions + schema summary), and (2) truncating tool results aggressively. This codebase does the second (4KB cap at `route.ts:99`); it does NOT do the first.

## Primary diagram — the full recap

```
  Token economics ledger — one full session in this app

  ┌──────────────────────┬───────┬──────┬──────────────────┐
  │ Step                 │ Model │ Cost │ Notes            │
  ├──────────────────────┼───────┼──────┼──────────────────┤
  │ Briefing scan        │ Sonnet│ $0.06│ 6 tool calls,     │
  │                      │       │      │ truncated results │
  ├──────────────────────┼───────┼──────┼──────────────────┤
  │ Diagnostic           │ Sonnet│ $0.08│ ~7 tool calls,    │
  │ investigation        │       │      │ hypothesis-testing│
  ├──────────────────────┼───────┼──────┼──────────────────┤
  │ Recommendation       │ Sonnet│ $0.07│ ~5 tool calls +   │
  │ proposal             │       │      │ verbose synthesis │
  ├──────────────────────┼───────┼──────┼──────────────────┤
  │ Free-form query      │ Haiku │ $.0003│ pre-routing       │
  │ intent classify      │       │      │                  │
  ├──────────────────────┼───────┼──────┼──────────────────┤
  │ Free-form query      │ Sonnet│ $0.05│ 1 user question   │
  │ answer               │       │      │                  │
  └──────────────────────┴───────┴──────┴──────────────────┘

  Total typical session (scan + 1 invest + 1 query) ≈ $0.26
   Scaling math:
     100 sessions/day  → ~$26/day  → ~$780/month
   1,000 sessions/day  → ~$260/day → ~$7,800/month
   The 60s response cache catches repeat-scans within the
    window, so multi-tab or rapid-reload behavior doesn't multiply cost.
```

## Elaborate

**Why prompt caching matters here.** The static parts of every agent prompt (system + tool definitions + schema summary) are ~1700 tokens. They're identical for every call by the same agent against the same workspace. With Anthropic's prompt caching, cached prefix tokens cost ~10% of normal input rate. For an agent that runs 6 LLM calls per scan, that's a ~60% saving on input tokens for calls 2-6 (call 1 pays the cache-set premium, ~25% extra).

The cache isn't wired today. The adapter would need to set `cache_control: { type: 'ephemeral' }` on the system prompt + tool definitions block when building the request. Wire one agent first (monitoring is the highest-volume per session), measure, then propagate.

**Why output is the expensive side.** Sonnet's output rate is roughly 5× the input rate. For an agent that outputs verbose recommendations (300+ tokens of rationale × N recommendations), output can rival input in dollar terms even though it's 1/10th the token count.

**Where the codebase is honest about not measuring.** There's no aggregate cost dashboard. There's no per-user cost cap. There's no alert when usage spikes. The honest framing: cost is tractable today because volume is low; the moment that changes, the first step is wiring prompt caching, the second is per-user rate limiting, the third is per-day caps with `console.warn` thresholds.

## Project exercises

### Exercise — Wire Anthropic prompt caching for the monitoring agent

  → **Exercise ID:** B1.6
  → **What to build:** Add `cache_control: { type: 'ephemeral' }` markers to the static parts of the monitoring agent's request — the system prompt, the schema summary, and the tool definitions. Measure the cache hit rate via the `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` fields. Log the cost savings per scan.
  → **Why it earns its place:** monitoring is the highest-volume agent per session (briefing scan runs on every page load when live). Even a 50% cache hit rate cuts the monitoring bill in half. This is the most direct dollar lever in the codebase.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (extend `complete()` to thread cache markers through), `lib/agents/monitoring.ts` (mark static parts as cacheable), `test/agents/aptkit-adapters.test.ts` (assert the markers land on the SDK request).
  → **Done when:** the per-call usage log shows non-zero `cache_read_input_tokens` after the second monitoring scan in a session, a wallclock measurement shows the second scan cheaper than the first by ~50% on input tokens, and the test suite has fixtures for both cache-create and cache-read cases.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How much does it cost to run a monitoring scan?"**

About 6 cents per scan, in Sonnet 4.6 pricing. The breakdown is roughly $0.04 input + $0.02 output, driven by 6 tool calls each returning a truncated (4KB) result. The full session — scan + one investigation + one recommendation — comes to about $0.21. The cheap classifier is Haiku at $0.0003 per call; it covers the free-form query intent only.

*Anchor: "$0.06 per scan, $0.21 per session, measured from `response.usage` logs."*

**Q: "Where would you go to cut cost?"**

Two levers. First, Anthropic prompt caching — the system prompt + tool definitions + schema summary are static per agent per workspace, ~1700 tokens. Caching them cuts the input bill by ~60% on the second-and-later calls per scan. Not wired yet (`B1.6`). Second, the tool-result truncation is already aggressive (4KB cap) but blind — large numeric results get truncated alongside small ones. A smarter truncation (`{ count, first 100 rows, ... }` rather than first 4KB raw) would let the model see *more* of the result for fewer tokens.

*Anchor: "Prompt caching first (60% input savings on monitoring), smart truncation second."*

## See also

  → `02-tokenization.md` — the unit costs are denominated in
  → `06-production-serving/01-llm-caching.md` — the prompt-caching exercise from a serving lens
  → `06-production-serving/02-llm-cost-optimization.md` — the full cost-optimization story
  → `05-evals-and-observability/04-llm-observability.md` — the per-call usage log story
