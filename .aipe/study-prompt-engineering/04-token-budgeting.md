# Token budgeting and context window management

**Industry name(s):** token budgeting, context-window management, prompt compaction, context engineering
**Type:** Industry standard · Language-agnostic

> Every call has a finite context window and a per-call output ceiling; blooming insights spends its budget deliberately — `schemaSummary` caps the injected `{schema}` (20 events / 10 props / 30 customer-props), `MAX_TOOL_RESULT_CHARS=16_000` caps each observation, per-agent `maxToolCalls` (6/6/4/6) caps transcript growth, and `max_tokens` (4096 / 2048 / 16) caps output — but the static system+schema prefix sits in the wrong place for prefix caching, which the codebase does not use at all.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Token budgeting spans three bands. The prefix cap (`schemaSummary`) lives at the Per-agent definitions band, where each agent assembles its system prompt. The transcript caps (`truncate`, `maxToolCalls`) live one layer down in the Shared agent loop, where every Observation gets clipped and the turn count gets gated. The output cap (`max_tokens`) is what every call hands to the Provider band, sized to the job — 4096 for the agents, 16 for the classifier. Four caps on three bands, all aimed at keeping the sum under the practical window — and the one optimization left on the table (prefix caching) sits at the Provider boundary where `cache_control` would go.

```
  Zoom out — where token budgeting lives

  ┌─ Per-agent definitions ─────────────────────────┐  ← we are here (prefix cap)
  │  ★ schemaSummary 20/10/30  monitoring.ts L16–49 ★│
  │  PROMPT.replace('{schema}', bounded summary)     │
  └─────────────────────────┬────────────────────────┘
                            │  system + userPrompt
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← we are here (transcript caps)
  │  ★ truncate() ≤16k chars  base.ts L29–34 ★       │
  │  ★ maxToolCalls 6/6/4/6  base.ts L90–101 ★       │
  └─────────────────────────┬────────────────────────┘
                            │  max_tokens reserved
  ┌─ Provider ──────────────▼────────────────────────┐  ← we are here (output cap)
  │  ★ max_tokens: 4096 / 2048 / 16 ★                │
  │  anthropic.messages.create  base.ts L92–102      │
  │  ✗ no cache_control — prefix re-sent every turn │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: where does blooming insights spend its token budget, what bounds each line item, and what is it leaving on the table? The answer is four independent caps on three layers — prefix, transcript-per-observation, transcript-turn-count, output — plus one named omission: prefix caching is unused and `{schema}` is appended *last* in every prompt, which is the wrong place for the cacheable-prefix rule. Below, you'll see how each cap targets one source, why the classifier's 16-token ceiling enforces a one-word format through the budget itself, and what the `{schema}-last` layout costs every multi-turn run.

---

## Structure pass

**Layers.** The context window has four fill sources and you have to cap each one independently or any single one of them blows the call. Layer A is the *static prefix* — the system prompt plus the injected `{schema}`, identical on every turn of a loop. Layer B is the *growing transcript* — user prompt plus each turn's Thought/Action/Observation, accreting turn by turn. Layer C is the *output reservation* — `max_tokens`, which the provider subtracts from the window *before* generation. Layer D is the *unbounded variable* — the raw tool result that gets clipped on its way back into Layer B. Same window, four different fill sources, four different caps.

**Axis: cost.** How many tokens does each layer cost per call, and how does that cost scale (per workspace? per turn? per call?)? Cost is the right axis because the failure this concept defends against is the call that "fits" in the hard window but degrades in the practical one — and degradation tracks token consumption, not turn count. State is too generic (everything is "in the window"); guarantees doesn't bite (the window is sized in tokens, not promises). Trace cost across A→D and the seams pop: the prefix is paid in full every turn (and uncached), the transcript grows quadratically without caps, the output reservation is paid up front, and Layer D is the one that gets clipped at the seam.

**Seams.** Three seams; the load-bearing one is the prefix-caching seam that isn't there. Seam 1 (D↔B) — the cost flips from *unbounded* to *capped-at-16k-chars*; `truncate()` is the gate, and the bug it defends against is one chatty tool call flooding the transcript. Seam 2 (B's per-turn boundary) — cost flips from *paying for one turn* to *paying for N turns*; `maxToolCalls` (6/6/4/6) caps N. The load-bearing seam is Seam 3, which is hypothetical and aspirational: between the *cacheable prefix* and the *volatile placeholders* inside Layer A — cost would flip from *full-rate input tokens* to *fraction-rate cache reads* on turns 2-7. Today this seam doesn't exist because `{schema}` is appended *last*, behind the volatile `{anomaly}` / `{intent}` placeholders, so the cacheable prefix breaks at the first volatile token. Get this layout fixed (schema in front, `cache_control` on the boundary) and the dominant input-token line item on multi-turn runs drops sharply.

```
  Structure pass — token budgeting

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: static prefix (system + {schema})          │
  │  B: growing transcript (turns accreted)         │
  │  C: output reservation (max_tokens)             │
  │  D: raw tool result (unbounded → clipped)       │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: tokens per layer per call; how does it  │
  │  scale (per workspace, per turn, per call)?     │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (D↔B): unbounded → capped 16k chars         │
  │            (truncate gate)                      │
  │  S2 (B per-turn): 1× → N× (maxToolCalls 6/6/4/6)│
  │  S3 (within A): full-rate → cache-rate          │
  │            (LOAD-BEARING — and NOT BUILT;       │
  │             {schema} placed last blocks it)     │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "what does the prefix cost on turn N?" answered two ways

  ┌─ today ──────────┐    seam     ┌─ with cache + reorder┐
  │  full-rate input │ ═════╪═════► │  fraction-rate cache │
  │  tokens × every  │  (would flip│  reads × turns 2..N  │
  │  turn (no cache) │   if built) │                      │
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → this boundary is the optimization left on the table
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

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

### The static prefix — the schema summarizer bounds the biggest variable

The four prompt files end with `## Workspace schema\n{schema}`. That `{schema}` placeholder is the single largest variable input to every agent call, and it is *not* injected raw. A shared schema-summarizer function compacts the full workspace schema — roughly 112KB raw — into a hard-bounded summary:

```
schema summarizer caps
─────────────────────────────────────────────────────────────
 MAX_EVENTS           = 20    events.slice(0, 20)
 MAX_PROPS_PER_EVENT  = 10    properties.slice(0, 10)
 MAX_CPROPS           = 30    customer_properties.slice(0, 30)
```

The function is shared: all four agents import the same summarizer and run the raw schema through it before stamping it into `{schema}`. So they all pay the *same* bounded prefix cost regardless of how large the underlying workspace is. A workspace with 400 event types still injects 20. This is the line item that, left uncapped, would dwarf everything else — a 112KB blob is roughly 28,000 tokens, and it would sit in *every* turn of *every* agent call.

```
raw schema (112KB, ~28k tok)  ──schema summarizer──▶  bounded summary (20/10/30)
   grows with workspace size                            constant regardless of workspace
```

---

### The transcript — `truncate()` and `maxToolCalls` bound growth

The transcript grows two ways: each observation can be arbitrarily large, and the number of turns can be arbitrarily many. blooming insights caps both.

**Per-observation cap.** Every tool result is run through a truncate helper before it re-enters the conversation. The cap is 16,000 characters:

```
  MAX_TOOL_RESULT_CHARS = 16_000

  truncate(s):
    if s.length <= MAX_TOOL_RESULT_CHARS:
        return s
    return s.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…[truncated]"
```

An MCP query that returns 80KB of rows is clipped to 16,000 chars before the loop pushes it back as the next user turn. Without this, one chatty tool call floods the window and pushes the original instructions and anomaly toward the middle — where the model attends to them least.

**Turn-count cap.** A per-agent `max_tool_calls` setting is the hard ceiling on how many Observation blocks ever get appended. Once the tool-call count reaches the cap, a `budget_spent` flag flips true, the loop sets `force_final`, and tools are dropped from the next call:

```
  the budget gate
  ─────────────────────────────────────────────────────────────
  budget_spent = max_tool_calls is set
                 AND tool_calls.length >= max_tool_calls
  force_final  = (turn == max_turns - 1) OR budget_spent
  if NOT force_final:
      params.tools = tool_schemas             # ← tools dropped when spent
```

Each agent sets its own cap: monitoring 6, diagnostic 6, recommendation 4, query 6. The recommendation agent gets fewer because its prompt says it "mostly reasons from the diagnosis" — it does not need the exploration budget the others do. The prompts reinforce the same number in prose: "Make at most 6 tool calls" (monitoring, diagnostic), "at most 4 tool calls" (recommendation). The cap lives in two places — the code enforces it, the prompt tells the model so it spends its budget wisely instead of being cut off mid-exploration.

```
each Observation ≤ 16k chars   AND   at most N Observations
        │                                    │
   truncate (per result)              max_tool_calls (per-agent: 6/6/4/6)
        └────────────── together bound transcript size ──────────────┘
```

---

### The output reservation — `max_tokens` per call

`max_tokens` is not a quality knob; it is a hard cap on output that the provider *subtracts from the window before generating*. blooming insights sizes it to the job:

```
max_tokens by call site
─────────────────────────────────────────────────────────────
 agent loop (default)   4096    ← full structured answer
 synthesize retry       2048    ← diagnostic + recommendation
 intent classifier        16    ← one word
```

The classifier's `16` is the sharpest example of budgeting as design. The intent classifier asks for "ONLY the one word" and reserves exactly enough tokens to return one — `monitoring`, `diagnostic`, or `recommendation`. There is no room for the model to ramble even if it wanted to; the budget enforces the format. The synthesis retry uses 2048 because a single diagnosis or recommendation array is smaller than a full exploratory turn. The default 4096 covers the agent's normal structured output. Notably, the query agent passes no `max_tokens` of its own — its prose answer rides the 4096 default.

```
"reply with ONLY one word"  +  max_tokens: 16   →  format enforced by the budget,
                                                    not just requested in prose
```

---

### Move 2.5 — current state vs. the prefix-caching gap

Here is what blooming insights does *not* do, and it is the most consequential omission in its token economics: it uses no prompt caching. Anthropic's prefix caching (`cache_control` on a content block) lets you mark a stable prefix so repeated calls reuse it at a fraction of the input-token cost. blooming insights never sets it — there is no `cache_control` anywhere in the shared agent loop, the intent classifier, or the agent classes.

The static prefix is the *ideal* cache target: the same system prompt and schema are re-sent on every turn of every loop, and the schema is identical across the diagnostic and recommendation calls of a single investigation (both inject the same bounded schema summary). That prefix is exactly the "stable content kept at the front" that caching rewards.

But there is a structural anti-pattern even before caching is added. The canonical rule is *keep the most stable content at the front of the prompt so the cacheable prefix is as long as possible.* blooming insights does the opposite for its largest stable input: `{schema}` is appended **last** in all four prompt files, *after* the volatile placeholders. The schema varies *less* than `{anomaly}` (diagnostic) or `{intent}` (query) — it changes per workspace, not per call — yet it sits behind them.

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

Budget every source that fills the window — the prefix, the transcript, the output reservation — and place the most stable content first so it stays cacheable. blooming insights caps the prefix (schema summarizer), the per-observation size (truncate), the turn count (`max_tool_calls`), and the output (`max_tokens`) — four independent caps, each on one source. It leaves two things on the table: no prefix caching at all, and a prompt layout that puts its largest stable input (`{schema}`) last, where it cannot anchor a long cacheable prefix. The caps are the hygiene that ships; the caching is the optimization not yet taken.

---

## Token budgeting — diagram

This diagram spans the full budget. The Service layer assembles a bounded prefix and a per-call cap; the Loop layer grows a capped transcript; the Provider layer enforces the output reservation. A reader who sees only this should grasp that four independent caps keep the call inside the practical window, and that the prefix is in the wrong order for caching.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (agent classes)                                       │
│                                                                       │
│  PROMPT.replace("{schema}", schema_summary(schema))                   │
│     summarizer caps 20 events / 10 props / 30 cprops                  │
│     {schema} appended LAST in the markdown  (anti-pattern for caching)│
│  run_agent_loop({ max_tool_calls: 6|6|4|6, max_tokens: 4096 })        │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  system + user prompt
┌───────────────────────────▼───────────────────────────────────────────┐
│  LOOP LAYER (shared agent loop)                                       │
│                                                                       │
│  per turn: append Thought/Action, run tool, append Observation        │
│    Observation = truncate(serialize(result))   ≤16k chars             │
│    budget_spent = tool_calls.length >= max_tool_calls                 │
│    force_final → drop tools, append synthesis_instruction             │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  max_tokens reserved from window
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER LAYER                                                       │
│                                                                       │
│  provider.messages.create({ max_tokens })                             │
│    agent 4096 · synthesize 2048 · classifier 16                       │
│    NO cache_control anywhere — prefix re-sent in full every turn      │
└────────────────────────────────────────────────────────────────────────┘

  Four caps (prefix · per-observation · turn-count · output) keep the call
  under the practical window. Prefix caching is unused; {schema} is last.
```

The window is finite; four caps keep the sum under the practical fraction, and the one optimization left on the table is the cacheable prefix.

---

## Implementation in codebase

**Case A — implemented (with a named gap).**

### Prefix cap — `schemaSummary`

- **File:** `lib/agents/monitoring.ts`
- **Function / class:** `schemaSummary(schema: WorkspaceSchema): string`
- **Line range:** L16–L57 (caps at L22 `MAX_EVENTS=20`, L23 `MAX_PROPS_PER_EVENT=10`, L34 `MAX_CPROPS=30`); the one-liner `Data horizon: <from> → <to>` appended at L40–L49 when the live adapter is Olist (synthetic, fixed-horizon) and omitted under Bloomreach.
- **Role:** Compacts the ~112KB raw workspace schema (noted at L15) into a bounded summary injected as `{schema}`; imported and reused by `query.ts` L7/L26 and the diagnostic/recommendation agents. The horizon line is the cheapest possible date anchor — one line in the prefix that earns a 5x loose-recall lift on detection eval (→ 01-anatomy.md for the structural framing, → 05-eval-driven-iteration.md for the measured before/after).

### Per-observation cap — `truncate`

- **File:** `lib/agents/base.ts`
- **Function / class:** `truncate(s)` + `MAX_TOOL_RESULT_CHARS`
- **Line range:** L29–L34; applied at L150 (success) and L155 (error) before `messages.push` at L171
- **Role:** Clips every tool result to 16,000 chars so one large observation cannot flood the transcript.

### Turn-count cap — `maxToolCalls`

- **File:** `lib/agents/base.ts` (gate) + each agent (value)
- **Function / class:** `budgetSpent` / `forceFinal` in `runAgentLoop`
- **Line range:** gate `base.ts` L90–L91, L101; values monitoring `monitoring.ts` L101 (6), diagnostic `diagnostic.ts` L61 (6), recommendation `recommendation.ts` L57 (4), query `query.ts` L41 (6)
- **Role:** Bounds how many Observation blocks ever enter the transcript; recommendation uses 4 because it reasons from the diagnosis rather than exploring.

### Output cap — `max_tokens`

- **File:** `lib/agents/base.ts` + `intent.ts` + synthesize calls
- **Function / class:** `maxTokens` default; classifier and synthesis call sites
- **Line range:** default 4096 `base.ts` L74; classifier 16 `intent.ts` L20; synthesize 2048 `diagnostic.ts` L94, `recommendation.ts` L98; query rides the 4096 default (no `maxTokens` passed, `query.ts` L30–L45)
- **Role:** Reserves output space sized to the job; the classifier's 16 enforces the one-word format through the budget itself.

### The gap — no prefix caching, `{schema}` placed last

- **File:** the four prompt files + `base.ts`
- **Function / class:** prompt layout; absence of `cache_control`
- **Line range:** `{schema}` last at `monitoring.md` L99–L101, `diagnostic.md` L83–L85, `recommendation.md` L73–L75, `query.md` L38–L40; no `cache_control` in `base.ts` L92–L102
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

## Interview defense

### What an interviewer is really asking

"How do you manage the context window?" tests whether you stop at "the window is big, it fits" or go to "I cap every source that fills it and I count what I bill." The senior signal is naming the four sources, pointing to the cap on each in code, and *volunteering* the gap — no caching, schema placed last — rather than presenting the budget as complete.

### Likely questions

**[mid] "The workspace schema is 112KB. How does it not blow the context window on every call?"**

`schemaSummary` (`monitoring.ts` L16–L49) compacts it before injection — top 20 events, 10 properties each, 30 customer properties — so the `{schema}` placeholder always carries a bounded summary, not the raw blob. The cap is constant regardless of workspace size.

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

- `lib/agents/monitoring.ts` L16–L49 — `schemaSummary`: caps the prefix to 20/10/30.
- `lib/agents/base.ts` L29–L34 — `truncate` + `MAX_TOOL_RESULT_CHARS=16_000`: per-observation cap.
- `lib/agents/base.ts` L90–L91 — `budgetSpent` / `forceFinal`: the `maxToolCalls` gate.
- `lib/agents/intent.ts` L20 — `max_tokens: 16`: output budget enforcing a one-word format.
- `monitoring.md` L99–L101 — `{schema}` appended last: the prefix-caching anti-pattern.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the context window as a buffer filled from four sources (prefix, transcript, output reservation) and name the cap on each: `schemaSummary` for the prefix, `truncate` + `maxToolCalls` for the transcript, `max_tokens` for the output. State which source has no cap and is unbounded (the underlying tool result, before `truncate`).

### Level 2 — Explain

Out loud: why does the recommendation agent use `maxToolCalls: 4` (`recommendation.ts` L57) when the others use 6? Tie it to `recommendation.md` L10 ("You mostly reason from the diagnosis") — fewer observations are needed because it is not exploring, so a smaller transcript cap fits the job.

### Level 3 — Apply

Scenario: you are adding prefix caching. Open `lib/agents/prompts/diagnostic.md` and find where `{schema}` is (L83–L85) and where `{anomaly}` is (L14–L16). State why the current order defeats caching, and write the reordered layout (static → `{schema}` → `{anomaly}`) with the `cache_control` boundary, citing the line in `base.ts` (L98–L102) where you would set it.

### Level 4 — Defend

A reviewer says: "The schema is 112KB and re-sent every turn — that's wasteful, rewrite the agents to fetch schema on demand." State what is *already* done (`schemaSummary` caps it to a bounded summary, `monitoring.ts` L16–L49), what the reviewer's real target should be (no prefix caching, `{schema}` placed last), and the measured condition — rising investigation volume — under which caching pays for itself.

### Quick check — code reference test

What is `MAX_TOOL_RESULT_CHARS`, where is it defined, and what does `truncate` append when it clips? (Answer: `16_000`, defined at `lib/agents/base.ts` L29; `truncate` returns `s.slice(0, 16_000) + '\n…[truncated]'` — L31–L34.)

## See also

→ 01-anatomy.md · → 02-structured-outputs.md · → 03-prompts-as-code.md · → 08-few-shot.md

---
Updated: 2026-05-29 — Resynced monitoring refs after the `{categories}` shift: `schemaSummary` L15–48→L16–49, monitoring `maxToolCalls` L74→L101, `{schema}` placement L75–77→L99–101, plus the ~112KB comment L14→L15 and the `.replace('{schema}',…)` call L62→L84.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-16 — Updated `schemaSummary` range to L16–L57 (was L16–L49) and noted the new `Data horizon: <from> → <to>` line appended at L40–L49 under Olist — a single-line prefix anchor that drove a measured 5x loose-recall lift on the Phase 3 detection eval.
