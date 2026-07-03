# 04 · Token budgeting and context window management

**Industry name:** *token budgeting* / *context management* / *prompt caching* · Language-agnostic

## Zoom out — where tokens leak

Tokens leak in three specific places in this repo, and each has a corresponding lever. Draw them on the same picture, because the levers only make sense when you see where the leaks are.

```
  Zoom out — where tokens leak, and where the levers are

  ┌─ Agent call ──────────────────────────────────────────────────┐
  │                                                                │
  │  system prompt                                                 │
  │    § role/rules            (small, constant)                   │
  │    § context injection  ← ★ leak 1: schemaSummary lever ★     │
  │    § output shape          (small, constant)                   │
  │                                                                │
  │  messages[] (grows each turn)                                  │
  │    tool_result blocks   ← ★ leak 2: 4000-char truncation ★    │
  │                                                                │
  │  tools[] (constant)                                            │
  │    input_schema list       (medium, constant)                  │
  │                                                                │
  └────────────────────────┬───────────────────────────────────────┘
                           │  Anthropic.messages.create()
  ┌─ Provider ─────────────▼───────────────────────────────────────┐
  │  ★ leak 3: system prompt recomputed every call ★               │
  │  fix: cache_control: ephemeral on the system prompt            │
  │       first call = cache_creation, rest = cache_read           │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — three levers, one budget

The three specific levers in this codebase:

1. **`schemaSummary()`** at `lib/agents/monitoring.ts:19-60` — collapses a 112KB workspace schema to 20 events × 10 properties + top 30 customer properties.
2. **4000-char truncation** at `app/api/agent/route.ts:98`, `app/api/briefing/route.ts:72`, and `eval/run.eval.ts:145-146` — caps every tool result body.
3. **Ephemeral prompt caching** at `lib/agents/aptkit-adapters.ts:85-89` — wraps the system prompt in `cache_control`, so within a 5-min window subsequent calls read the cache at ~0.1× input cost.

These aren't tuning knobs. They're the difference between "runs a golden case in $0.09" and "runs a golden case in $1.50."

## Structure pass — layers, axis, seams

Trace one axis: *token cost per model turn*, from the largest bucket down.

- **Layer 1 — system prompt.** Largest fixed bucket. Held constant across the ~10-turn ReAct loop of a diagnosis.
- **Layer 2 — tool results in messages[].** Grows every turn. Each tool_result body is capped at 4000 chars.
- **Layer 3 — model output.** Bounded by `max_tokens: 4096`. Diagnose avg 1,858; recommend avg 2,468.
- **Layer 4 — provider-side.** Prompt caching turns Layer 1 from "billed every call" to "billed once per 5-min window."

**The seam:** between Layer 1 (constant across the loop) and Layer 2 (grows each turn). This is where prompt caching pays. Everything constant sits above the seam and gets cached. Everything growing sits below and doesn't.

## How it works

### Move 1 — the shape

You've done this pattern before with any bounded resource — memory, CPU budget, screen real estate. You had a budget, you had multiple consumers, and you decided who got how much. Tokens are the same shape. The budget is the model's context window (Claude Sonnet 4.6: 200K input). The consumers are the four sections of the prompt plus the growing messages array. The lever is: which consumer gets compressed, which gets cached, and which gets truncated.

```
  Pattern — the token budget as competing consumers

  context window (Claude Sonnet 4.6: 200K input)
  ┌────────────────────────────────────────────────────────┐
  │  ▓▓▓▓▓  system prompt          (constant, cacheable)   │
  │  ▓▓                             role + rules            │
  │  ▓▓▓                            context injection       │
  │  ▓                              output shape            │
  │                                                         │
  │  ░░░░░░░░░  messages[]          (grows every turn)      │
  │  ░░         user "begin"                                 │
  │  ░░         tool_use blocks                              │
  │  ░░░░░      tool_result blocks  ← truncated to 4000ch    │
  │                                                         │
  │  ▒▒▒        tools[]              (constant, cacheable)   │
  │                                                         │
  │   free space ~180K until it isn't                        │
  └────────────────────────────────────────────────────────┘
```

The 80% rule: if you're using more than 80% of the window, you're one model change away from breaking. This repo runs at maybe 5% for diagnose (avg 7,404 input tokens). Room to spare — because the compression levers work.

### Move 2 — walking the three levers

#### Lever 1 — `schemaSummary()` for context compression

`lib/agents/monitoring.ts:19-60`:

```
export function schemaSummary(schema: WorkspaceSchema): string {
  const oldestDate = schema.oldestTimestamp
    ? new Date(schema.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';

  // Top 20 events, each capped at 10 properties
  const MAX_EVENTS = 20;
  const MAX_PROPS_PER_EVENT = 10;

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  // Customer properties, cap at 30
  const MAX_CPROPS = 30;
  const customerPropsText = schema.customerProperties.slice(0, MAX_CPROPS).join(', ');
  // …
}
```

The full workspace schema is >100KB of JSON — event names, per-event properties, catalogs, customer attributes. Pass that verbatim and § 2 of the prompt (context injection) blows past 30K tokens on its own. `schemaSummary()` collapses it to a few hundred tokens by:

- Taking the top 20 events by count.
- Capping each event's property list to the top 10.
- Capping the customer property list to the top 30.
- Adding one horizon-date line if the workspace has one.

The trade-off: an anomaly that lives in event #21 (a niche event outside the top 20) won't be reasoned over. That's a real limitation. In practice for this workspace, the top 20 events cover >99% of the signal, so the compression pays.

The lever: `MAX_EVENTS`, `MAX_PROPS_PER_EVENT`, `MAX_CPROPS`. Move them up, model has more context but every call is more expensive; move them down, faster / cheaper but risk of missing niche signals. The current numbers are the balance point for this workspace.

```
  Comparison — with vs without schemaSummary

  raw workspace schema:      ~30K tokens per call × 10 calls = 300K tokens
  after schemaSummary():     ~400 tokens per call × 10 calls =  4K tokens
                             ─────────────────────────────────
                             ~75× reduction in the schema-injection cost
```

#### Lever 2 — 4000-char tool-result truncation

Three places in this repo cap tool result bodies at 4000 chars:

`eval/run.eval.ts:145-146`:
```
const truncated =
  raw.length > 4000 ? raw.slice(0, 4000) + `… [truncated, ${raw.length} total chars]` : raw;
lines.push(`result: ${truncated}`);
```

`app/api/agent/route.ts:98`: `const TRUNC = 4000;`
`app/api/briefing/route.ts:72`: `const TRUNC = 4000;`

Why 4000? Empirically enough for a typical EQL query result — a few dozen rows of aggregated numbers, or an experiment listing, or a segment definition. Sufficient to reason over; small enough that ten tool results in a row don't dominate the message history.

The truncation lands with an explicit `… [truncated, N total chars]` suffix. That's important — the model can see the truncation happened and won't confabulate the missing content. A silent truncation would be worse than none.

The failure mode this prevents: a tool that returns a 500KB response (a full customer export, a raw event log). Without truncation, one such call blows past the context window and every subsequent turn in the same investigation fails. With truncation, the call still succeeds; the model just knows it saw the head of the result.

The trade-off: for tools that return long structured lists (e.g. "list all 300 scenarios"), 4000 chars is only the first ~40 items. The recommendation agent's `list_scenarios` call routinely hits this — the model gets the first 40 scenarios and reasons over them, then moves on.

#### Lever 3 — ephemeral prompt caching

`lib/agents/aptkit-adapters.ts:83-89` (the load-bearing block):

```
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
```

One line — the `cache_control: { type: 'ephemeral' }` on the system prompt. Two consequences:

1. **First call in the loop** is a cache_creation. Costs about 1.25× normal input for the cached content. You pay a small tax up front.
2. **Every subsequent call within a 5-minute window** is a cache_read. Costs about 0.1× normal input for the same content. That's a 10× win on the largest fixed bucket.

Anthropic caches tools transparently when the same breakpoint is on the system prompt. So this one line covers both stable prefixes — system + tools. That's a lot of load-bearing for one config option.

From the code comment at `lib/agents/aptkit-adapters.ts:76-84`:

> For a diagnostic run's ~10 model turns this is roughly an 80% reduction on the system-prompt token cost.

Baseline evidence: live logs from run `2026-07-03T04-08-28-644Z` show `cache_read_input_tokens` landing at 3168 within a single investigation. That's 3168 tokens the pricing meter charged at cache-read rates instead of full input rates — for one investigation of one case.

```
  Flow — how caching lands over a 10-turn loop

  turn 1  system=[...cached] messages=[user]              ─► cache_creation (~1.25×)
  turn 2  system=[...cached] messages=[user, asst, user]  ─► cache_read     (~0.10×)
  turn 3  system=[...cached] messages=[…]                 ─► cache_read     (~0.10×)
  …
  turn 10 system=[...cached] messages=[…]                 ─► cache_read     (~0.10×)

  effective cost on the constant prefix:
    naïve:   10 × 1.00× = 10.00 units
    cached:   1 × 1.25× + 9 × 0.10× = 2.15 units
    saving: ~78%
```

The specific gotcha: the cache is content-addressed. Change one character in the system prompt (or the tools list) and the whole cache misses. Which means: don't dynamically re-generate the system prompt with a timestamp in it. Don't shuffle the tool order per call. The stability is what makes the cache work.

### Move 2 variant — the load-bearing skeleton

The kernel of token budgeting in a real repo:

1. **Compress the context injection.** Drop it and § 2 dominates every call. `schemaSummary()` here.
2. **Bound tool result bodies.** Drop it and one long tool response blows the whole window. 4000-char truncation here.
3. **Cache the stable prefix.** Drop it and you pay for the system prompt on every turn. `cache_control: ephemeral` here.
4. **Bound the output.** `max_tokens: 4096` at `lib/agents/aptkit-adapters.ts:70`. Not the biggest lever, but the failure mode is worst — an unbounded model can loop on its own thoughts and burn through the whole budget.

Everything else — count-your-tokens dashboards, per-agent budgets, cost dashboards — is hardening on top of this skeleton. `BudgetTracker` at `lib/agents/budget.ts` is one such hardening layer: it caps the *dollar* spend per investigation. When a runaway loop breaks compression, the tracker catches it before the bill lands.

### Move 3 — the principle

**Token counting is not optional. It's basic hygiene.** The prompt engineer who doesn't know their per-turn input token cost is the ML engineer who doesn't know their loss curve — they will iterate in the wrong direction. In this repo the numbers are visible: `sharedRunId 2026-07-03T04-08-28-644Z` shows diagnose at avg 7,404 input / 1,858 output, recommend at 1,384 / 2,468. Those numbers are the floor. Every prompt change moves them. If you don't know what they are today, you can't tell that today's edit made them worse.

## Primary diagram

```
  Token budgeting — the full recap

  ┌─ Compression stage (before the model call) ────────────────────┐
  │                                                                  │
  │  workspace schema (~100KB)  ── schemaSummary() ──►  ~400 tokens  │
  │  tool result (500KB max)    ── truncate 4000ch ──►  ~1000 tokens │
  │                                                                  │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │
  ┌─ Model call (turn N) ────────▼──────────────────────────────────┐
  │                                                                  │
  │  system: [{ text: "...", cache_control: ephemeral }]  ← the lever│
  │  messages: [ growing tool_result history ]                       │
  │  tools:   [ ... ]                                                │
  │  max_tokens: 4096                                                │
  │                                                                  │
  │  → first call: cache_creation (~1.25× input)                    │
  │  → later calls: cache_read (~0.10× input)                       │
  │                                                                  │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │
  ┌─ Observability ──────────────▼──────────────────────────────────┐
  │  console.log({ site, sessionId, usage: response.usage })         │
  │  eval receipts capture usage per case: input, output, cost       │
  │  BudgetTracker halts the loop if $ ceiling hit                   │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The three levers here are the ones that fit this codebase. Two more that show up in other real systems:

- **Sliding window on chat history.** For a conversational agent, you drop the oldest N turns once history exceeds a threshold. This repo doesn't have conversational agents — each investigation is a fresh loop — so the lever doesn't apply. If `query.ts` grew into a chatbot, this would land.
- **Summarisation of earlier turns.** Instead of dropping old turns, summarise them. Higher context recall, higher latency. Same non-fit reason as sliding window here.

The "lost in the middle" failure mode: even when context fits, relevant content placed in the middle of a long prompt is poorly attended. Position matters. In this codebase the fix is structural — critical rules go at the top (§ 1 role) and bottom (§ 4 output shape), with per-call context in the middle. If a hard rule started sliding into the middle of § 2 during a refactor, model compliance would drift on that rule specifically. This is why the four-section anatomy from concept 01 is enforced.

Prefix caching is the modern take on the old "keep what's stable at the front" advice. Static prefix goes first (system prompt, tools). Growing suffix goes after (messages history). The cache pays because of this discipline. Reverse the order — put the growing messages before the static system — and every call is a cache miss.

Anthropic's caching docs, OpenAI's cookbook, and Simon Willison's blog cover the specifics. The underlying pattern is: fixed prefix + variable suffix + cache the prefix. It applies to Anthropic's ephemeral cache, OpenAI's prompt caching (automatic), and any homebrew equivalent.

## Interview defense

**Q: How do you keep a growing agent loop within budget?**

Three levers. One, compress the largest fixed bucket — the workspace schema goes from 100KB to a few hundred tokens via `schemaSummary()`. Two, bound the growing bucket — every tool result body is truncated to 4000 chars with an explicit truncation marker. Three, cache the stable prefix — one `cache_control: ephemeral` on the system prompt turns the ~10-turn diagnostic loop from paying full input cost every turn to paying it once. In this codebase that's `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:85-89`. Baseline evidence: run `2026-07-03T04-08-28-644Z` shows cache_read hits inside a single investigation.

```
   compress §2      truncate tools    cache §1+tools
      ▲                 ▲                 ▲
      │                 │                 │
   schemaSummary   4000-char cap    ephemeral
```

Anchor: `lib/agents/monitoring.ts:19-60`, `eval/run.eval.ts:145-146`, `lib/agents/aptkit-adapters.ts:85-89`.

**Q: What's the specific bug that told you truncation is not optional?**

A tool that returns a full customer export — say `list_customers` with no scope — returns 500KB. Without truncation, the tool_result block goes into messages[]. Next turn, the model gets the same block back plus a new tool_use plus a new tool_result. Turn 3 hits the context limit. Investigation halts. In this codebase every tool result body is capped at 4000 chars with an explicit `… [truncated, N total chars]` suffix. The suffix matters — a silent truncation would let the model confabulate the tail; the explicit marker lets it plan around the missing content.

```
  before:  1 tool call × 500KB result  ──► turn 3 blows the window
  after:   1 tool call × 4000 char cap ──► loop stays bounded
```

Anchor: `app/api/agent/route.ts:98`, `eval/run.eval.ts:145-146`.

## See also

- 01 · anatomy — the four sections are what caching partitions along.
- 02 · structured outputs — tool schemas are part of the stable prefix, which is why caching covers both.
- 05 · eval-driven iteration — the receipts capture per-case input/output tokens so you can measure a lever's impact.
- 06 · single-purpose chains — smaller purposes → smaller prompts → smaller budgets.
