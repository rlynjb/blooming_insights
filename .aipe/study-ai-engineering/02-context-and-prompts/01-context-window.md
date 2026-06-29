# Context window

*Industry standard — fixed-size context window*

## Zoom out — where this concept lives

Every Anthropic call in this codebase sends a prompt that competes for space in the model's context window. Sonnet's context is 200k tokens; the typical agent call uses ~2-15k. The budget is loose today — `schemaSummary()` does the heavy lifting by capping the workspace shape that goes into the prompt.

```
  Zoom out — where the context budget gets shaped

  ┌─ Caller (agent) ───────────────────────────┐
  │  builds the prompt parts                    │
  │  (system + schema + history + tool defs)    │
  └────────────────────┬───────────────────────┘
                       │
                       ▼
  ┌─ ★ Context window ★ ──────────────────────┐ ← we are here
  │  fixed budget (Sonnet: 200k tokens)         │
  │  everything competes for space              │
  └────────────────────┬───────────────────────┘
                       │
                       ▼
  ┌─ Model ────────────────────────────────────┐
  │  attention over the whole window            │
  └────────────────────────────────────────────┘
```

**Zoom in.** The window is generous (200k tokens) but you still budget for two reasons: (1) tokens cost money (`01-llm-foundations/06-token-economics.md`); (2) attention degrades at the middle of long contexts (`02-lost-in-the-middle.md`).

## Structure pass — layers · axes · seams

**Layers:** prompt sources → assembly → call.

**Axis: what competes for space?** Four contributors: system prompt (~400 tokens), schema summary (~500 tokens), tool definitions (~800 tokens), tool results (~12k tokens across 6 calls). Tool results dominate.

**Seam:** the `schemaSummary()` cap at `lib/agents/monitoring.ts:24-26` (`MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10`) and the `trunc()` cap at `app/api/agent/route.ts:98-101` (`TRUNC = 4000` chars per tool result). These two caps are the entire context budget today.

## How it works

### Move 1 — the mental model

You know how a viewport in CSS is fixed and content competes for space inside it? Context window is the same. Everything you want the model to see has to fit. There's no "out of view; will be scrolled to later" — what's outside the window doesn't exist to the model.

```
  Context window — a fixed container

  ┌────────────────────────────────────────────────┐
  │  Context window (Sonnet 4.6: 200k tokens)      │
  │                                                │
  │  System prompt          [██░░░░░░░░░░░░░░░░░]  │  ~400
  │  Schema summary         [██░░░░░░░░░░░░░░░░░]  │  ~500
  │  Tool definitions       [███░░░░░░░░░░░░░░░░]  │  ~800
  │  Conversation so far    [█░░░░░░░░░░░░░░░░░░]  │  variable
  │  Tool results (×6)      [████████░░░░░░░░░░░]  │  ~12,000
  │  Headroom for response  [░░░░░░░░░░░██████░░]  │  4,096 max_tokens
  │                                                │
  │  Total used: ~15-20k of 200k available         │
  │  Generous — but: every token costs money       │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the schema summary is the proxy budget for the workspace shape.**

`lib/agents/monitoring.ts:18-58` caps how much of the workspace shape enters the prompt:

```typescript
const MAX_EVENTS = 20;
const MAX_PROPS_PER_EVENT = 10;
// ...
const MAX_CPROPS = 30;
```

If the workspace has 200 event types and 50 customer properties, only the top 20 events (sorted by event count) and the top 30 customer properties enter the prompt. The model never sees the rest.

This is the trade — wider visibility into the workspace shape would help the model pick less-common queries, but it would also bloat the system prompt and push tool results out of headroom. The cap is a deliberate cut.

**Part 2 — tool results get truncated per-call.**

`app/api/agent/route.ts:98-101`:

```typescript
const TRUNC = 4000;
const trunc = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
};
```

Every tool result that goes back to the model is capped at 4000 chars (~1000 tokens). A `select count event purchase` that returns 50,000 rows would otherwise drown the next turn's context. The truncation is blind (first 4000 chars) — see the smart-truncation exercise in `01-llm-foundations/06-token-economics.md` for the next step.

**Part 3 — there is no conversation history budget today.**

Each agent invocation is a fresh turn. The diagnose → recommend handoff is structured (a `Diagnosis` object passed in as the recommendation agent's input), not historical (no message-by-message replay). So the "conversation so far" line in the diagram above is small or absent for most agents — only the AptKit loop accumulates per-call history within a single invocation.

The implication: when the diagnostic agent runs 7 tool calls in a row, the seventh call carries the full prior 6 tool results in its prompt context. By call 7, that's ~24-28k tokens of accumulated tool results plus the static prefix. Still well within 200k, but the cost compounds.

### Move 3 — the principle

**The window is fixed; what's outside doesn't exist.** Budgeting is proxy-based today (item count, char count); real budgeting (token count via `count_tokens`) is the next step. The model never sees what was dropped, so dropping the *wrong* parts silently degrades behavior — favor cutting the long tail (least-active events, oldest results) over cutting the head.

## Primary diagram — the full recap

```
  Context budget in this codebase

  ┌─ Static per-agent ───────────────────────────────────────┐
  │  System prompt:    ~400 tokens   (file: legacy-prompts/*)│
  │  Schema summary:   ~500 tokens   (capped: 20 ev × 10 prop)│
  │  Tool definitions: ~800 tokens   (from MCP listTools)    │
  │  ────────────                                            │
  │  Static prefix:    ~1,700 tokens  ← cache candidate       │
  └──────────────────────────────────────────────────────────┘
  ┌─ Per-call dynamic ───────────────────────────────────────┐
  │  Prior tool results: 0 to ~24k tokens (accumulates)      │
  │  New tool result:    0 to ~1k tokens  (truncated 4KB)    │
  └──────────────────────────────────────────────────────────┘
  ┌─ Output ─────────────────────────────────────────────────┐
  │  max_tokens: 4096                                        │
  └──────────────────────────────────────────────────────────┘

  Total per call: ~2-30k of 200k window. Comfortable, but
   the same prefix gets re-sent on every call — prompt caching
   would cut input bills ~60% on calls 2+.
```

## Elaborate

**Why 200k feels infinite for this app.** The agents make 6-8 calls per investigation. Accumulated tool results never exceed ~30k tokens across the full loop. 200k is ~6× headroom — there's no realistic path to filling the window with this app's shape.

**Where 200k would bite.** If a future version pre-loaded the agent with the entire (untruncated) workspace schema (~50-100k tokens), the dynamic per-call growth would eat the rest fast. The current discipline — summarize aggressively, truncate per-call results — is what keeps headroom. The day someone removes a truncation cap "to give the agent more context," costs and latency both spike.

## Project exercises

### Exercise — Real per-prompt token measurement and budget assertion

  → **Exercise ID:** B2.1
  → **What to build:** Call Anthropic's `messages.countTokens` (or compute via a local tokenizer) before every `complete()` call. Assert against a per-agent budget (e.g. monitoring: 30k, diagnostic: 40k); log a warning when over budget. Add the measurement to the existing per-call `usage` log.
  → **Why it earns its place:** turns proxy budgets (item counts, char counts) into real budgets. Catches the day a future refactor pre-loads too much context.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (count input tokens before the call, log + warn on overrun), `test/agents/aptkit-adapters.test.ts` (cover the over-budget warning path).
  → **Done when:** the per-call log carries a `requestInputTokens` field alongside `usage`, an artificially-bloated prompt triggers the budget warning, and the test suite covers both at-budget and over-budget cases.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How big is your context budget?"**

200k tokens (Sonnet 4.6 window). I use ~2-30k per call depending on how many tool results have accumulated. The budget is proxy-based today — schema summary caps at 20 events × 10 properties at `lib/agents/monitoring.ts:24`, tool results truncated to 4KB per call at `app/api/agent/route.ts:98`. Real token counting is the next move (`B2.1`).

*Anchor: "200k window, ~15-30k typical usage, proxy budget today, real `count_tokens` next."*

**Q: "What gets cut when you have to choose?"**

The long tail. `schemaSummary` sorts events by `eventCount` descending and takes the top 20, so the lowest-volume events drop out. Tool results truncate from the back (first 4KB, then `…`). The discipline is "keep what's most useful first; cut what's least active."

*Anchor: "Sort + slice from the bottom; the head of the data is always preserved."*

## See also

  → `02-lost-in-the-middle.md` — why position within the window matters
  → `01-llm-foundations/02-tokenization.md` — the unit the budget is measured in
  → `01-llm-foundations/06-token-economics.md` — the cost story this budget feeds
