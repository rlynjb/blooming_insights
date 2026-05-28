# Token budgeting and context window management

**Industry name(s):** token budgeting, context-window management, prompt compaction, context engineering
**Type:** Industry standard · Language-agnostic

> Every call has a finite context window and a per-call output ceiling; blooming insights spends its budget deliberately — `schemaSummary` caps the injected `{schema}` (20 events / 10 props / 30 customer-props), `MAX_TOOL_RESULT_CHARS=16_000` caps each observation, per-agent `maxToolCalls` (6/6/4/6) caps transcript growth, and `max_tokens` (4096 / 2048 / 16) caps output — but the static system+schema prefix sits in the wrong place for prefix caching, which the codebase does not use at all.

**See also:** → 01-anatomy.md · → 02-structured-outputs.md · → 03-prompts-as-code.md · → 08-few-shot.md

---

## Why care

You have built a feature where an input field accepts arbitrary user text — a comment box, a search query, a document upload — and you learned the hard way that "it works on my test string" tells you nothing about what happens when someone pastes 40KB. You added a `maxLength`, you truncated server-side, you measured payload size before sending. The boundary between "small input I tested" and "real input at scale" is where features quietly break, and the failure is never a clean error — it's a 30-second hang, a truncated half-answer, or a 500 three layers downstream.

An LLM call is exactly this boundary, except the size limit is denominated in tokens, not characters, and there are three separate limits stacked on top of each other: how much you can put *in* (the context window), how much the model can put *out* (`max_tokens`), and how much you should *actually* use before quality degrades (the practical fraction of the window, well below the hard ceiling). The question this file answers: where does blooming insights spend its token budget, what bounds each line item, and what is it leaving on the table.

**The pivot: token counting is basic hygiene, not an optimization you bolt on later.** I have watched a teammate ship a summarizer that worked beautifully in the demo — three-paragraph inputs — and silently truncated every real document because nobody counted tokens. The model didn't error. It just stopped reading at the window boundary and confidently summarized the first third. The bug was invisible until a user complained the summary "missed the whole second half." Counting tokens up front is the difference between a feature that scales and one that demos.

Before budgeting:
- The full 112KB workspace schema is injected raw; one agent call blows past the practical window and the model starts ignoring the back half of its own instructions
- A single tool result returns 80KB of JSON; it floods the transcript and pushes the original anomaly out of the model's effective attention
- The model "thinks" forever on the final turn and never emits the JSON because nothing bounds output

After:
- `schemaSummary` ships a compact, bounded schema instead of the raw 112KB blob (`monitoring.ts` L15–L48)
- `truncate()` caps every observation at 16,000 chars (`base.ts` L29–L34)
- `maxToolCalls` + `max_tokens` bound how big the transcript and the output can grow

It is the `maxLength`-and-measure-before-send discipline, applied to a backend whose payloads are priced per token and whose "field" is a finite context window.

---

## How it works

**Mental model.** A context window is a fixed-size buffer, and every call fills it from four sources you control independently: the static prefix (system prompt + injected schema), the growing transcript (each Thought / Action / Observation appended turn over turn), the per-call output reservation (`max_tokens`, which is *subtracted* from the window before generation), and the unbounded variable — the tool results the model pulls in. Budgeting is deciding a cap for each source so their sum stays inside the *practical* window, not the hard one.

```
context window (fixed buffer)
┌───────────────────────────────────────────────────────────────┐
│ STATIC PREFIX          system prompt + {schema}                │  ← schemaSummary caps this
│ ─────────────────────────────────────────────────────────────│
│ TRANSCRIPT (grows)     userPrompt                              │
│                        ├─ Thought / Action (turn 1)            │  ← maxToolCalls caps
│                        ├─ Observation (turn 1)  ≤16k chars     │     turn count
│                        ├─ Thought / Action (turn 2)            │  ← truncate() caps
│                        └─ Observation (turn 2)  ≤16k chars     │     each observation
│ ─────────────────────────────────────────────────────────────│
│ OUTPUT RESERVATION     max_tokens (reserved, not yet used)     │  ← 4096 / 2048 / 16
└───────────────────────────────────────────────────────────────┘
          │
   sum must stay under the PRACTICAL window (~80% of hard), not the hard ceiling
```

Each cap targets one source. None of them is optional — remove any one and a single large input can blow the whole call.

---

### The static prefix — `schemaSummary` bounds the biggest variable

The four prompt files end with `## Workspace schema\n{schema}` (`monitoring.md` L75–L77, `diagnostic.md` L83–L85, `recommendation.md` L73–L75, `query.md` L38–L40). That `{schema}` placeholder is the single largest variable input to every agent call, and it is *not* injected raw. `schemaSummary` (`monitoring.ts` L15–L48) compacts the full workspace schema — which the comment at L14 records as ~112KB — into a hard-bounded summary:

```
schemaSummary caps   (monitoring.ts L21–L34)
─────────────────────────────────────────────────────────────
 MAX_EVENTS           = 20    events.slice(0, 20)           L22
 MAX_PROPS_PER_EVENT  = 10    properties.slice(0, 10)       L23
 MAX_CPROPS           = 30    customerProperties.slice(0,30) L33
```

The function is shared: `query.ts` L26 and `diagnostic.ts` / `recommendation.ts` all import `schemaSummary` from `monitoring.ts` and run the raw schema through it before `.replace('{schema}', …)`. So all four agents pay the *same* bounded prefix cost regardless of how large the underlying workspace is. A workspace with 400 event types still injects 20. This is the line item that, left uncapped, would dwarf everything else — a 112KB blob is roughly 28,000 tokens, and it would sit in *every* turn of *every* agent call.

```
raw schema (112KB, ~28k tok)  ──schemaSummary──▶  bounded summary (20/10/30)
   grows with workspace size                       constant regardless of workspace
```

---

### The transcript — `truncate()` and `maxToolCalls` bound growth

The transcript grows two ways: each observation can be arbitrarily large, and the number of turns can be arbitrarily many. blooming insights caps both.

**Per-observation cap.** Every tool result is run through `truncate()` before it re-enters the conversation (`base.ts` L150, L155). `MAX_TOOL_RESULT_CHARS = 16_000` (`base.ts` L29):

```typescript
const MAX_TOOL_RESULT_CHARS = 16_000;                          // base.ts L29
function truncate(s: string): string {                         // L31
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';  // L33
}
```

An MCP query that returns 80KB of rows is clipped to 16,000 chars before `messages.push` feeds it back as the next user turn (`base.ts` L171). Without this, one chatty tool call floods the window and pushes the original instructions and anomaly toward the middle — where the model attends to them least.

**Turn-count cap.** `maxToolCalls` is the hard ceiling on how many Observation blocks ever get appended. Once `toolCalls.length >= maxToolCalls`, `budgetSpent` flips true, the loop sets `forceFinal`, and tools are dropped from the next call (`base.ts` L90–L91, L101):

```
base.ts — the budget gate   (L90–L101)
─────────────────────────────────────────────────────────────
 budgetSpent = maxToolCalls !== undefined
               && toolCalls.length >= maxToolCalls          L90
 forceFinal  = turn === maxTurns - 1 || budgetSpent         L91
 if (!forceFinal) params.tools = toolSchemas                L101  ← tools dropped when spent
```

Each agent sets its own cap: monitoring 6 (`monitoring.ts` L74), diagnostic 6 (`diagnostic.ts` L61), recommendation 4 (`recommendation.ts` L57), query 6 (`query.ts` L41). Recommendation gets fewer because it "mostly reason[s] from the diagnosis" (`recommendation.md` L10) — it does not need the exploration budget the others do. The prompts reinforce the same number in prose: "Make at most 6 tool calls" (`monitoring.md` L11, `diagnostic.md` L11), "at most 4 tool calls" (`recommendation.md` L10). The cap lives in two places — the code enforces it, the prompt tells the model so it spends its budget wisely instead of being cut off mid-exploration.

```
each Observation ≤ 16k chars   AND   at most N Observations
        │                                    │
   truncate() (base.ts L150)        maxToolCalls (per-agent: 6/6/4/6)
        └────────────── together bound transcript size ──────────────┘
```

---

### The output reservation — `max_tokens` per call

`max_tokens` is not a quality knob; it is a hard cap on output that the provider *subtracts from the window before generating*. blooming insights sizes it to the job:

```
max_tokens by call site
─────────────────────────────────────────────────────────────
 agent loop (default)   4096    base.ts L74    ← full structured answer
 synthesize() retry     2048    diagnostic.ts L94, recommendation.ts L98
 intent classifier        16    intent.ts L20  ← one word
```

The classifier's `16` is the sharpest example of budgeting as design. `classifyIntent` (`intent.ts` L17–L31) asks for "ONLY the one word" and reserves exactly enough tokens to return one — `monitoring`, `diagnostic`, or `recommendation`. There is no room for the model to ramble even if it wanted to; the budget enforces the format. The synthesis retry uses 2048 because a `Diagnosis` or `Recommendation[]` is smaller than a full exploratory turn. The default 4096 covers the agent's normal structured output. Notably, `query.ts` passes no `maxTokens` — its prose answer rides the 4096 default from `base.ts` L74.

```
"reply with ONLY one word"  +  max_tokens: 16   →  format enforced by the budget,
                                                    not just requested in prose
```

---

### Move 2.5 — current state vs. the prefix-caching gap

Here is what blooming insights does *not* do, and it is the most consequential omission in its token economics: it uses no prompt caching. Anthropic's prefix caching (`cache_control` on a content block) lets you mark a stable prefix so repeated calls reuse it at a fraction of the input-token cost. blooming insights never sets it — there is no `cache_control` anywhere in `base.ts`, `intent.ts`, or the agent classes.

The static prefix is the *ideal* cache target: the same system prompt and schema are re-sent on every turn of every loop, and the schema is identical across the diagnostic and recommendation calls of a single investigation (both inject the same `schemaSummary`). That prefix is exactly the "stable content kept at the front" that caching rewards.

But there is a structural anti-pattern even before caching is added. The canonical rule is *keep the most stable content at the front of the prompt so the cacheable prefix is as long as possible.* blooming insights does the opposite for its largest stable input: `{schema}` is appended **last** in all four prompt files (`monitoring.md` L75–L77, `diagnostic.md` L83–L85, `recommendation.md` L73–L75, `query.md` L38–L40), *after* the volatile placeholders. The schema varies *less* than `{anomaly}` (diagnostic) or `{intent}` (query) — it changes per workspace, not per call — yet it sits behind them.

```
current prompt layout (anti-pattern for prefix caching)
─────────────────────────────────────────────────────────────
 [Role / Hard rules]        ← static across calls
 [{anomaly} / {intent}]     ← VOLATILE (changes every call)
 [EQL reminders / Output]   ← static across calls
 [{schema}]                 ← stable per workspace, but placed LAST

 a long cacheable prefix needs:  static → stable → volatile
 this layout interleaves them, so the cacheable prefix is short
```

If caching were turned on against this layout, the cache would break at the first volatile token. To actually benefit, the schema (stable) belongs *in front of* the per-call placeholders (volatile), with `cache_control` on the boundary. The current order makes the static prefix shorter than it could be — a real cost the moment call volume rises.

---

### The principle

Budget every source that fills the window — the prefix, the transcript, the output reservation — and place the most stable content first so it stays cacheable. blooming insights caps the prefix (`schemaSummary`), the per-observation size (`truncate`), the turn count (`maxToolCalls`), and the output (`max_tokens`) — four independent caps, each on one source. It leaves two things on the table: no prefix caching at all, and a prompt layout that puts its largest stable input (`{schema}`) last, where it cannot anchor a long cacheable prefix. The caps are the hygiene that ships; the caching is the optimization not yet taken.

---

## Token budgeting — diagram

This diagram spans the full budget. The Service layer assembles a bounded prefix and a per-call cap; the Loop layer grows a capped transcript; the Provider layer enforces the output reservation. A reader who sees only this should grasp that four independent caps keep the call inside the practical window, and that the prefix is in the wrong order for caching.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (agent classes)                                       │
│                                                                       │
│  PROMPT.replace('{schema}', schemaSummary(schema))  monitoring.ts L62│
│     schemaSummary caps 20 events / 10 props / 30 cprops  L15–48      │
│     {schema} appended LAST in the .md  (anti-pattern for caching)    │
│  runAgentLoop({ maxToolCalls: 6|6|4|6, maxTokens: 4096 (default) })  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  system + userPrompt
┌───────────────────────────▼───────────────────────────────────────────┐
│  LOOP LAYER  lib/agents/base.ts                                      │
│                                                                       │
│  per turn: append Thought/Action, run tool, append Observation       │
│    Observation = truncate(JSON.stringify(result))  L150  ≤16k chars  │
│    budgetSpent = toolCalls.length >= maxToolCalls   L90              │
│    forceFinal → drop tools, append synthesisInstruction  L91/98/101  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  max_tokens reserved from window
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic)                                          │
│                                                                       │
│  anthropic.messages.create({ max_tokens })  base.ts L92–102         │
│    agent 4096 · synthesize 2048 · classifier 16 (intent.ts L20)      │
│    NO cache_control anywhere — prefix re-sent in full every turn     │
└────────────────────────────────────────────────────────────────────────┘

  Four caps (prefix · per-observation · turn-count · output) keep the call
  under the practical window. Prefix caching is unused; {schema} is last.
```

The window is finite; four caps keep the sum under the practical fraction, and the one optimization left on the table is the cacheable prefix.

---

## In this codebase

**Case A — implemented (with a named gap).**

### Prefix cap — `schemaSummary`

- **File:** `lib/agents/monitoring.ts`
- **Function / class:** `schemaSummary(schema: WorkspaceSchema): string`
- **Line range:** L15–L48 (caps at L22 `MAX_EVENTS=20`, L23 `MAX_PROPS_PER_EVENT=10`, L33 `MAX_CPROPS=30`)
- **Role:** Compacts the ~112KB raw workspace schema (noted at L14) into a bounded summary injected as `{schema}`; imported and reused by `query.ts` L7/L26 and the diagnostic/recommendation agents.

### Per-observation cap — `truncate`

- **File:** `lib/agents/base.ts`
- **Function / class:** `truncate(s)` + `MAX_TOOL_RESULT_CHARS`
- **Line range:** L29–L34; applied at L150 (success) and L155 (error) before `messages.push` at L171
- **Role:** Clips every tool result to 16,000 chars so one large observation cannot flood the transcript.

### Turn-count cap — `maxToolCalls`

- **File:** `lib/agents/base.ts` (gate) + each agent (value)
- **Function / class:** `budgetSpent` / `forceFinal` in `runAgentLoop`
- **Line range:** gate `base.ts` L90–L91, L101; values monitoring `monitoring.ts` L74 (6), diagnostic `diagnostic.ts` L61 (6), recommendation `recommendation.ts` L57 (4), query `query.ts` L41 (6)
- **Role:** Bounds how many Observation blocks ever enter the transcript; recommendation uses 4 because it reasons from the diagnosis rather than exploring.

### Output cap — `max_tokens`

- **File:** `lib/agents/base.ts` + `intent.ts` + synthesize calls
- **Function / class:** `maxTokens` default; classifier and synthesis call sites
- **Line range:** default 4096 `base.ts` L74; classifier 16 `intent.ts` L20; synthesize 2048 `diagnostic.ts` L94, `recommendation.ts` L98; query rides the 4096 default (no `maxTokens` passed, `query.ts` L30–L45)
- **Role:** Reserves output space sized to the job; the classifier's 16 enforces the one-word format through the budget itself.

### The gap — no prefix caching, `{schema}` placed last

- **File:** the four prompt files + `base.ts`
- **Function / class:** prompt layout; absence of `cache_control`
- **Line range:** `{schema}` last at `monitoring.md` L75–L77, `diagnostic.md` L83–L85, `recommendation.md` L73–L75, `query.md` L38–L40; no `cache_control` in `base.ts` L92–L102
- **Role:** The largest stable input sits behind volatile placeholders, and no call marks a cacheable prefix — the prefix is re-billed in full on every turn.

### Why this is a codebase strength (with one honest weakness)

Three of the four sources are capped at the seam where they enter the window, not patched after a blow-up: the prefix is bounded before injection, observations before they re-enter the transcript, output before generation. The weakness is real and specific: the schema is the biggest stable input and it is placed last, and no call sets `cache_control`, so the prefix is paid in full on every one of the (up to) 7 turns per investigation.

---

## Elaborate

### Where this comes from

Token budgeting predates context windows getting large. Early GPT-3 work lived inside 2K–4K tokens, so "what fits" was a daily constraint and libraries shipped token counters (`tiktoken`, Anthropic's count-tokens endpoint) as first-class tools. The discipline did not relax when windows grew to 200K — it shifted from "will it fit" to "what is the *practical* fraction before quality degrades." Anthropic's own prompt guidance and the OpenAI cookbook both teach: count tokens before you send, cap variable inputs, and keep stable content first for caching. Prefix caching (`cache_control`) arrived as the reward for that last rule.

### The deeper principle

```
hard window                          practical window
──────────────────────────────      ──────────────────────────────
the provider's max (e.g. 200K)       the fraction you should use (~80%)
output reservation subtracted        quality degrades before the ceiling
"it fits" = no error                 "it works" = model still attends to it all
```

The hard window is where the call *errors*. The practical window is where the call still *works* — where the model attends to the whole input instead of skimming. The 80% heuristic exists because a full window degrades before it overflows: instructions placed in the middle of a packed window get attended to least (the "lost-in-the-middle" effect — Liu et al., 2023). blooming insights' caps keep the practical window from filling, but the `{schema}-last` layout pushes a large stable block into exactly the position where lost-in-the-middle bites — and it is the position caching can't reach either.

### Where this breaks down

1. **`truncate()` clips by character, not by token, and not by structure.** Cutting a 16,000-char slice of `JSON.stringify(result)` can sever a row mid-object — the model reads `…"total_price": 4` and never sees the rest. The cap bounds size; it does not preserve meaning. A structured-aware truncation (keep N whole rows) would lose less signal per byte.

2. **The caps are static, not measured.** `MAX_EVENTS=20`, `16_000` chars, `maxToolCalls: 6` are constants chosen by hand, not derived from a measured token count of the assembled prompt. There is no `tiktoken`-style count anywhere — the code never asks "how many tokens did this call actually use." Budgeting by character count and item count is a proxy for the thing that is actually billed.

3. **No caching means the prefix is re-billed every turn.** A 6-tool diagnostic run is ~7 `create` calls, each re-sending the full system prompt + schema as fresh input tokens. With caching, turns 2–7 would read the prefix from cache at a fraction of the cost. Without it, the prefix is the dominant input-token line item on every multi-turn run.

### What to explore next

- **Turn on prefix caching:** reorder the prompts to `static → schema (stable) → volatile placeholders`, then set `cache_control` on the schema boundary so turns 2–N read it from cache.
- **Token-count the assembled prompt:** add Anthropic's count-tokens (or `tiktoken`) before `create`, log it per call, and replace the character/item caps with token-derived ones.
- **Structured truncation:** replace the raw `slice(0, 16_000)` with a row-aware truncation that keeps whole JSON objects up to the budget.

---

## Tradeoffs

### Static hand-tuned caps (no caching) vs. measured budgets + prefix caching

| Dimension | This codebase (static caps, no caching) | Measured budgets + prefix caching |
|---|---|---|
| Setup cost | Zero — constants in code | Token counter + prompt reorder + cache_control |
| Input cost per multi-turn run | Full prefix re-billed every turn | Prefix cached after turn 1 (fraction of cost) |
| Precision of the cap | Proxy (chars / item counts) | Exact (measured tokens) |
| Truncation fidelity | Char-slice, can sever JSON | Token/row-aware, preserves structure |
| Provider coupling | None | Caching is per-provider |
| Visibility into actual usage | None — never counted | Logged token count per call |

**What we gave up.** Cheap multi-turn calls and visibility. Every turn re-bills the full prefix because nothing is cached, and nothing in the code knows how many tokens a call actually used — the caps are proxies, not measurements. A 6-tool run pays for the schema 7 times.

**What the alternative would have cost.** Setup work and a provider coupling. Token counting needs a counter wired in before every `create`; caching needs the prompts reordered (schema to the front) and `cache_control` set, and caching is an Anthropic-specific feature, so it couples this layer to the provider the way native JSON mode would. The codebase chose static caps to ship the four agents without that work — defensible while call volume is low.

**The breakpoint.** Static caps are right while investigation volume is low enough that the re-billed prefix is a rounding error. The moment volume rises — many investigations per day, each ~7 turns re-sending the schema — the un-cached prefix becomes the dominant input-token line item, and turning on prefix caching (after reordering `{schema}` to the front) pays for itself immediately. Caching is held back by the prompt layout, not by inability.

---

## Tech reference (industry pairing)

### `schemaSummary` (bounded prefix injection)

- **Codebase uses:** `lib/agents/monitoring.ts` L15–L48 — caps the raw schema to 20 events / 10 props / 30 customer-props before injecting `{schema}`.
- **Why it's here:** the raw workspace schema is ~112KB; injecting it raw would dominate every call's input tokens.
- **Leading today:** retrieval-over-injection (pull only the relevant schema slice per query) and structured context compaction lead for large-context apps in 2026.
- **Why it leads:** sending only what the call needs beats sending a fixed cap of everything.
- **Runner-up:** a fixed bounded summary (this codebase's choice) — simpler, no retrieval index, predictable cost.

### `truncate` / `MAX_TOOL_RESULT_CHARS` (observation cap)

- **Codebase uses:** `lib/agents/base.ts` L29–L34 — char-slice every tool result to 16,000 chars.
- **Why it's here:** MCP results are unbounded; one large result would flood the transcript.
- **Leading today:** token-aware, structure-preserving truncation (keep whole rows up to a token budget) leads in 2026.
- **Why it leads:** preserves more usable signal per byte than a blind char-slice.
- **Runner-up:** summarize-then-truncate — an extra model call to compress the result before re-entry; more faithful, more expensive.

### `cache_control` (prefix caching — NOT used here)

- **Codebase uses:** nothing — there is no `cache_control` in `base.ts`, `intent.ts`, or any agent.
- **Why it's here:** it is the named gap; the static system+schema prefix is the textbook cache target, but the layout (`{schema}` last) and the absence of the flag mean the prefix is re-billed every turn.
- **Leading today:** Anthropic prompt caching (`cache_control`) and OpenAI automatic prefix caching lead for repeated-prefix workloads in 2026.
- **Why it leads:** repeated multi-turn calls reuse the prefix at a fraction of the input cost.
- **Runner-up:** none worth naming — for a fixed-prefix multi-turn loop like this, prefix caching is the standard answer; the only reason it is absent is it was not wired in.

---

## Project exercises

### Turn on prefix caching for the static system+schema prefix

- **Exercise ID:** C1.7 (adapted) — context-window management.
- **What to build:** reorder the four prompt files so `{schema}` sits *before* the volatile placeholders (`{anomaly}`, `{intent}`), split the system prompt into a stable block and a volatile block, and set `cache_control: { type: 'ephemeral' }` on the stable block in `runAgentLoop`'s `create` params so turns 2–N of a loop read the prefix from cache.
- **Why it earns its place:** demonstrates you know the rule "stable content first" and that the current `{schema}-last` layout is a prefix-caching anti-pattern, and that you can fix both the layout and the call.
- **Files to touch:** `lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md` (reorder `{schema}`), `lib/agents/base.ts` (split `system` into cached + volatile, set `cache_control`), `test/agents/base.test.ts`.
- **Done when:** a multi-turn diagnostic run reports cache reads on turns after the first (visible in the API usage fields), and the structured output is unchanged.
- **Estimated effort:** 1–4hr

### Count tokens before every call and replace character caps with token caps

- **Exercise ID:** C1.7 (adapted) — measure the budget instead of proxying it.
- **What to build:** add a token count (Anthropic count-tokens or `tiktoken`) of the assembled `system + messages` before each `anthropic.messages.create` in `runAgentLoop`, log it per call alongside the agent name, and replace `MAX_TOOL_RESULT_CHARS` with a token-budget-derived truncation.
- **Why it earns its place:** shows you treat token counting as hygiene — the code currently never measures what it bills — and that you can convert hand-tuned char/item caps into measured token caps.
- **Files to touch:** `lib/agents/base.ts` (count + log + token-aware `truncate`), `lib/mcp/types.ts` (a usage field on `ToolCall` or a new event), `test/agents/base.test.ts`.
- **Done when:** every agent call logs an actual token count, and `truncate` clips by token budget rather than a fixed 16,000 chars without severing a JSON row mid-object.
- **Estimated effort:** 1–4hr

---

## Summary

Token budgeting is hygiene, not optimization: every call fills a finite window from the prefix, the transcript, and the output reservation, and each source needs a cap. blooming insights caps three of them at the seam — `schemaSummary` bounds the injected `{schema}` to 20 events / 10 props / 30 customer-props (`monitoring.ts` L15–L48), `truncate()` clips every observation to 16,000 chars (`base.ts` L29–L34), and `maxToolCalls` (6/6/4/6) plus `max_tokens` (4096 / 2048 / 16) bound transcript growth and output. It leaves the fourth lever untouched: no prefix caching, and `{schema}` is appended *last* in all four prompts — behind the volatile placeholders it varies less than — which is a prefix-caching anti-pattern that makes the cacheable prefix short and re-bills the schema on every turn.

**Key points:**
- A finite window is filled from the prefix, the transcript, and the output reservation; budgeting caps each source independently.
- `schemaSummary` caps the largest variable input (the ~112KB schema) to a constant summary, shared across all four agents.
- `truncate()` caps each observation at 16,000 chars; `maxToolCalls` caps how many observations ever enter the transcript.
- `max_tokens` is a hard output cap, not a quality knob — the classifier's 16 enforces a one-word format through the budget.
- The gap: no `cache_control`, and `{schema}` placed last — the largest stable input sits where it can neither anchor a cacheable prefix nor avoid lost-in-the-middle.

---

## Interview defense

### What an interviewer is really asking

"How do you manage the context window?" tests whether you stop at "the window is big, it fits" or go to "I cap every source that fills it and I count what I bill." The senior signal is naming the four sources, pointing to the cap on each in code, and *volunteering* the gap — no caching, schema placed last — rather than presenting the budget as complete.

### Likely questions

**[mid] "The workspace schema is 112KB. How does it not blow the context window on every call?"**

`schemaSummary` (`monitoring.ts` L15–L48) compacts it before injection — top 20 events, 10 properties each, 30 customer properties — so the `{schema}` placeholder always carries a bounded summary, not the raw blob. The cap is constant regardless of workspace size.

```
raw 112KB ──schemaSummary (20/10/30)──▶ bounded ──.replace('{schema}',…)──▶ system prompt
```

**[senior] "What bounds the transcript, and what bounds the output, and why are those different problems?"**

The transcript is bounded two ways: `truncate()` caps each observation at 16,000 chars (`base.ts` L29) so no single result floods it, and `maxToolCalls` (6/6/4/6) caps how many observations ever get appended (`base.ts` L90). Output is bounded by `max_tokens`, which is *reserved from the window before generation* — 4096 for agents, 16 for the classifier. They are different problems because the transcript is input you accumulate and the output is space you reserve; capping one does nothing for the other.

```
transcript:  truncate (per-obs)  +  maxToolCalls (count)   ← input you grow
output:      max_tokens (reserved before generation)        ← space you hold back
```

**[arch] "The static prefix is identical across turns. What is this codebase leaving on the table, and why can't it just turn caching on?"**

Prefix caching. The system prompt + schema are re-sent on every one of the ~7 turns per investigation, un-cached, so the prefix is the dominant input-token cost. It cannot "just turn it on" because `{schema}` is appended *last* in all four prompts, behind the volatile `{anomaly}` / `{intent}` placeholders — the cacheable prefix breaks at the first volatile token. Fixing it requires reordering (schema to the front, as the most stable input) *then* setting `cache_control`. The layout is the blocker, not the feature.

```
now:   [static][VOLATILE][static][{schema}]   ← cache breaks at VOLATILE, prefix short
fixed: [static][{schema}][cache_control][VOLATILE]  ← long cacheable prefix
```

### The question candidates always dodge

**"How many tokens does one of your agent calls actually use?"** The honest answer is: the code does not know. There is no token counter anywhere — the caps are character counts (`16_000`) and item counts (`20`, `6`), which are *proxies* for tokens, not measurements. Budgeting by proxy works until it doesn't, and you cannot tune a prefix you never measured. Conflating "I capped the inputs" with "I counted the tokens" is the dodge.

### One-line anchors

- `lib/agents/monitoring.ts` L15–L48 — `schemaSummary`: caps the prefix to 20/10/30.
- `lib/agents/base.ts` L29–L34 — `truncate` + `MAX_TOOL_RESULT_CHARS=16_000`: per-observation cap.
- `lib/agents/base.ts` L90–L91 — `budgetSpent` / `forceFinal`: the `maxToolCalls` gate.
- `lib/agents/intent.ts` L20 — `max_tokens: 16`: output budget enforcing a one-word format.
- `monitoring.md` L75–L77 — `{schema}` appended last: the prefix-caching anti-pattern.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the context window as a buffer filled from four sources (prefix, transcript, output reservation) and name the cap on each: `schemaSummary` for the prefix, `truncate` + `maxToolCalls` for the transcript, `max_tokens` for the output. State which source has no cap and is unbounded (the underlying tool result, before `truncate`).

### Level 2 — Explain

Out loud: why does the recommendation agent use `maxToolCalls: 4` (`recommendation.ts` L57) when the others use 6? Tie it to `recommendation.md` L10 ("You mostly reason from the diagnosis") — fewer observations are needed because it is not exploring, so a smaller transcript cap fits the job.

### Level 3 — Apply

Scenario: you are adding prefix caching. Open `lib/agents/prompts/diagnostic.md` and find where `{schema}` is (L83–L85) and where `{anomaly}` is (L14–L16). State why the current order defeats caching, and write the reordered layout (static → `{schema}` → `{anomaly}`) with the `cache_control` boundary, citing the line in `base.ts` (L98–L102) where you would set it.

### Level 4 — Defend

A reviewer says: "The schema is 112KB and re-sent every turn — that's wasteful, rewrite the agents to fetch schema on demand." State what is *already* done (`schemaSummary` caps it to a bounded summary, `monitoring.ts` L15–L48), what the reviewer's real target should be (no prefix caching, `{schema}` placed last), and the measured condition — rising investigation volume — under which caching pays for itself.

### Quick check — code reference test

What is `MAX_TOOL_RESULT_CHARS`, where is it defined, and what does `truncate` append when it clips? (Answer: `16_000`, defined at `lib/agents/base.ts` L29; `truncate` returns `s.slice(0, 16_000) + '\n…[truncated]'` — L31–L34.)
