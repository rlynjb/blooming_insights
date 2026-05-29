# LLM cost optimization

**Industry name(s):** model routing / model cascading, token budgeting, prompt caching, cost-per-request accounting
**Type:** Industry standard · Language-agnostic

> blooming insights routes a cheap haiku classifier at the edge, caps every agent with a hard `maxToolCalls` budget, truncates tool results to 16k chars, and caches tool calls — but every *agent* still runs on sonnet, never caches the prompt prefix, and emits no cost telemetry, so the output-token-heavy `synthesize()` call quietly dominates the bill.

**See also:** → 01-llm-caching.md · → 04-rate-limiting-backpressure.md · → ../01-llm-foundations/README.md · → ../04-agents-and-tool-use/README.md

---

## Why care

You ship a feature and the cloud bill jumps. You open the dashboard and it tells you *which service* and *which line item* drove it — compute here, egress there. You optimize the line item that actually grew, not the one that was easy to find. The dashboard is the whole point: you cannot cut a cost you cannot see.

An LLM application has the same problem with one missing piece — most teams have no dashboard at all. The question this concept answers is: *where does the money go per request, and which lever actually moves it?*

**The levers are not equal, and the obvious one is usually wrong.** Engineers reach for "use a cheaper model everywhere" first, but output tokens cost several times more than input tokens, and a single long structured-output call can outweigh a dozen short tool calls. blooming insights made the right edge call (a haiku classifier instead of sonnet for a one-word job) and the right structural calls (hard budgets, truncation, caching) — but it runs every agent on sonnet and has no cost meter, so the `synthesize()` call that emits a full diagnosis JSON is the biggest line item and nobody is watching it.

Before naming the levers:
- Every request, including a one-word classification, would default to the strongest model
- An agent loop could explore until it times out, burning tokens with no cap
- A 50k-char tool result would be fed back in full, re-charged on every subsequent turn
- Nobody could say what a single investigation costs

After what blooming insights built (and what it skipped):
- The intent classifier runs on haiku (`max_tokens: 16`) — pennies for a routing decision
- Every agent has a hard `maxToolCalls` cap (6/6/4/6) that bounds tokens and latency
- Tool results truncate at 16k chars before re-entering the context
- Identical tool calls hit the 60s cache — but the prompt prefix is never cached, no agent ever escalates from a cheaper model, and `res.usage` is read by nobody

It is three good cost decisions, two unbuilt levers, and zero visibility.

---

## How it works

**Mental model.** A request's cost is `input_tokens × in_price + output_tokens × out_price`, summed over every model call in the request. Three families of lever exist: **route** (send the request to a cheaper model when the task is easy), **shrink** (reduce the tokens — cap exploration, truncate context, cache the prefix), and **see** (measure per-request cost so you optimize the right line). blooming insights pulls the route lever once at the edge, pulls most shrink levers, and pulls no see lever at all.

```
 cost = Σ over calls ( in_tokens·in$ + out_tokens·out$ )
        ▲              ▲                ▲
        │              │                └─ SHRINK: cap output, route to cheap model
        │              └─ SHRINK: truncate, prompt-cache prefix, maxToolCalls
        └─ SEE: measure per-request so you know which lever to pull
```

The trap is that `out$` is several times `in$`, and the agents' `synthesize()` calls are output-heavy (a full JSON diagnosis), so the dominant line item is the one place the codebase spends *output* tokens — not the many input-heavy tool-call turns.

---

### Route — model selection at the edge (`classifyIntent`)

The one place blooming insights routes by cost is intent classification. A free-form `?q=` query first goes to a haiku model to decide which agent surface should answer it — a one-word output.

```
 ?q="why did conversion drop?"
        │
        ├─ classifyIntent  →  haiku  (max_tokens: 16)   ← cheap, one word
        │                     "diagnostic"
        ▼
   QueryAgent.answer       →  sonnet (full agent loop)  ← expensive, the work
```

`CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` at `lib/agents/intent.ts` L14. The call at L17–L31 sets `max_tokens: 16` (L20) and a system prompt that forces exactly one word. Routing a classification to haiku instead of sonnet is the textbook cheap-model-for-an-easy-task move: the task has one bit of decision content, so it does not need the strong model's reasoning.

```
  task: "pick one of three labels"
   ┌──────────────────────────────┐
   │ haiku   max_tokens 16  cheap  │  ← chosen
   │ sonnet  full reasoning  costly │  ← overkill for a label
   └──────────────────────────────┘
```

That is the *only* model-routing decision. Inside every agent, the model is `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9), used uniformly for the loop turns *and* the dedicated synthesis calls.

---

### Shrink — hard tool-call budgets (`maxToolCalls`)

Each agent caps the total number of tool calls it may make. Once the cap is hit, the loop forces a tool-less final turn (see `../04-agents-and-tool-use`), bounding both token spend and latency.

```
agent              maxToolCalls   where
─────────────      ────────────   ──────────────────────────
MonitoringAgent         6         lib/agents/monitoring.ts L84
DiagnosticAgent         6         lib/agents/diagnostic.ts L62
RecommendationAgent     4         lib/agents/recommendation.ts L57
QueryAgent              6         lib/agents/query.ts L41
```

`budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls` at `lib/agents/base.ts` L90; `forceFinal` at L91 flips on when the budget is spent. Without this cap an agent could explore until the `maxDuration = 300` route limit (`app/api/agent/route.ts` L20) killed it — burning tokens the whole way with nothing to show.

```
turn  toolCalls  budgetSpent  → tokens spent grow linearly per turn
  0       0        false        each turn re-sends full message history
  1       2        false        (input grows; output per turn capped)
  2       4        false
  3       6        true   → forceFinal: stop, emit answer (bounded)
```

---

### Shrink — context truncation

Two truncation points keep token counts from ballooning as tool results accumulate in the message history.

```
 MCP result ──► truncate(16_000) ──► fed back as tool_result   lib/agents/base.ts L29,L31
 tool result ──► trunc(4000) ──────► sent to UI as NDJSON       app/api/agent/route.ts L99
```

`MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts` L29) caps what re-enters the model's context — critical because the full message history is re-sent on every turn (L99), so an un-truncated 50k result would be re-charged 5+ times. The route's `TRUNC = 4000` (`app/api/agent/route.ts` L99) is a separate, smaller cap for what streams to the browser. `schemaSummary` (`lib/agents/monitoring.ts`) further caps the schema injected into prompts (20 events / 10 props / 30 customer-props).

---

### Shrink — caching (cross-reference)

The 60s exact-match tool cache (`lib/mcp/client.ts` L97–L146) removes repeat network round-trips and the tokens of re-feeding an identical result. The investigation replay cache (`lib/state/investigations.ts`) removes entire runs. Both are covered in `01-llm-caching.md`. The cost lever they do *not* pull — prompt caching of the static prefix — is the unbuilt shrink lever below.

---

### The output-token line item — where the bill actually concentrates

Input tokens are many but cheap; output tokens are few but several times more expensive each. The agents' loop turns are input-heavy (re-sending history, tool results). The `synthesize()` calls are output-heavy: they emit a complete structured JSON object.

```
 call type            tokens               $ weight
 ───────────────      ──────────────       ─────────────────────
 loop turn (tools)    input-heavy          low per token, many tokens
 synthesize()         output-heavy (JSON)  HIGH per token  ← line item
```

`DiagnosticAgent.synthesize` (`lib/agents/diagnostic.ts` L87–L126) is a dedicated `anthropic.messages.create` with `max_tokens: 2048` (L99) on sonnet, emitting a full diagnosis JSON. `RecommendationAgent.synthesize` mirrors it at `max_tokens: 2048` (`lib/agents/recommendation.ts` L98). These output-heavy sonnet calls are the dominant cost per investigation — and the codebase has no telemetry pointing at them.

---

### Current state vs future state — the unbuilt levers

```
            built                          absent
            ──────────────────────         ────────────────────────────
route       haiku classifier (edge)        cheap-first-then-escalate
                                           WITHIN agents (all sonnet)
shrink      maxToolCalls, truncate,        prompt caching (cache_control)
            tool cache
see         —                              cost dashboard / per-run meter
```

Three gaps: (1) **no in-agent cascade** — every agent runs sonnet from the first turn; a cheap-first pass (try haiku, escalate to sonnet only when the cheap output fails validation) is not attempted. (2) **no prompt caching** — the static prefix re-costs at full input price every turn (see `01-llm-caching.md`). (3) **no cost visibility** — `res.usage` (returned on every Anthropic response) is read by nobody, so the output-heavy `synthesize()` line item is invisible.

---

### The principle

Optimize the line item that dominates, and you cannot find it without measuring. The cheap-model-at-the-edge move is correct and easy. The harder, higher-value moves — caching the repeated prefix, escalating models only when needed, and above all *measuring per-request cost* — are where the real savings live, because output tokens on the strongest model are where the money concentrates.

---

## LLM cost optimization — diagram

This diagram spans the Route, Agent, and Provider layers and marks each cost lever as built (solid) or absent (dashed).

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  ROUTE LAYER   app/api/agent/route.ts                               │
  │                                                                     │
  │  GET /api/agent?q=...                                               │
  │       │                                                             │
  │  ┌────▼──────────────────────────────────────┐                     │
  │  │  ROUTE  classifyIntent → haiku  (BUILT)    │                     │
  │  │  intent.ts L14,L20 — max_tokens 16, 1 word │                     │
  │  └────┬──────────────────────────────────────┘                     │
  │       │                                                             │
  │  ╎ SEE  per-request cost meter from res.usage  (ABSENT) ╎          │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/  — all sonnet (AGENT_MODEL base.ts L9)     │
  │                                                                       │
  │  ┌────────────────────────────────────────────────────┐             │
  │  │  SHRINK  maxToolCalls 6/6/4/6  (BUILT)  base.ts L90  │             │
  │  │  SHRINK  truncate 16k         (BUILT)  base.ts L29   │             │
  │  └────────────────────────────────────────────────────┘             │
  │       │                                                               │
  │  ╎ SHRINK  prompt cache (cache_control)  (ABSENT)  base.ts L98 ╎     │
  │  ╎ ROUTE   cheap-first-then-escalate     (ABSENT)              ╎     │
  │       │                                                               │
  │  ┌────▼───────────────────────────────────────────────┐            │
  │  │  synthesize()  sonnet, max_tokens 2048, JSON out     │            │
  │  │  OUTPUT-HEAVY → dominant line item                   │            │
  │  │  diagnostic.ts L87–L126 / recommendation.ts L82–L132 │            │
  │  └─────────────────────────────────────────────────────┘            │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  mcp.callTool
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER / MCP LAYER                                                 │
  │  SHRINK  60s tool cache (BUILT)  lib/mcp/client.ts L35–L65            │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: routing and shrinking are mostly built, the output-heavy synthesis call is the cost center, and there is no meter watching it.

---

## In this codebase

Partially implemented — strong on routing-at-the-edge and shrinking, absent on prompt caching, in-agent cascade, and visibility.

### Edge model routing (Case A)

**File:** `lib/agents/intent.ts`
**Function / class:** `classifyIntent` + `CLASSIFIER_MODEL`
**Line range:** `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` L14; call L17–L31 (`max_tokens: 16` L20).

A cheap haiku model decides the agent surface; sonnet does the actual work. Contrast `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9), used by every agent uniformly.

### Token budgets + truncation (Case A)

**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop` budget logic + `truncate`
**Line range:** `budgetSpent`/`forceFinal` L90–L91; `MAX_TOOL_RESULT_CHARS = 16_000` L29, `truncate` L31–L34; default `maxTokens = 4096` L74.

Per-agent caps: monitoring 6 (`monitoring.ts` L84), diagnostic 6 (`diagnostic.ts` L62), recommendation 4 (`recommendation.ts` L57), query 6 (`query.ts` L41). Route-side `TRUNC = 4000` at `app/api/agent/route.ts` L99.

### The output-heavy synthesis cost (Case A — the line item)

**File:** `lib/agents/diagnostic.ts`
**Function / class:** `DiagnosticAgent.synthesize`
**Line range:** L87–L126 (sonnet at L98, `max_tokens: 2048` L99). Mirrored by `RecommendationAgent.synthesize` (`lib/agents/recommendation.ts` L82–L132, sonnet at L97, `max_tokens: 2048` L98).

### Cost telemetry + in-agent cascade + prompt caching (Case B — Not yet implemented)

**Not yet implemented.** Every `anthropic.messages.create` response carries a `usage` object (`input_tokens`, `output_tokens`, cache fields), but blooming insights reads it nowhere — there is no per-run cost meter, no in-agent escalation from a cheaper model, and no `cache_control` on the prefix.

Where it would live: a cost meter would accumulate `res.usage` inside `runAgentLoop` (`lib/agents/base.ts` L102) and the two `synthesize()` calls, summing per request in the route's `start()` block (`app/api/agent/route.ts` L170) and emitting a `cost` field on the `done` event (sent at L251). The cheap-first cascade would wrap the `model` choice in `runAgentLoop` (L93). Prompt caching attaches to the `system` field at L98 (see `01-llm-caching.md`).

---

## Elaborate

### Where this pattern comes from

**Model routing / cascading** comes from the cost-quality frontier: stronger models cost more, so you route easy requests to cheap models and reserve the strong model for hard ones. FrugalGPT (Chen et al., 2023) formalized the cascade — try the cheapest model, escalate only when its answer fails a verifier. **Token budgeting** is the LLM analog of a query timeout: bound the work so a runaway request cannot run up an unbounded bill. **Prompt caching** amortizes the repeated prefix (see `01-llm-caching.md`). **Cost accounting** is plain observability applied to the token meter the provider already returns.

### The deeper principle

```
  lever       removes                       blooming insights
  ─────────   ──────────────────────────    ─────────────────────
  route       strong-model cost on easy task  edge only (classifier)
  shrink-cap  unbounded exploration tokens    built (maxToolCalls)
  shrink-trunc re-fed large context tokens     built (16k / 4k)
  shrink-cache repeated prefix/result tokens   tool cache yes, prefix no
  see         the inability to prioritize      ABSENT
```

The "see" row is foundational: without it, every other optimization is a guess. blooming insights pulled the levers that were structurally obvious (cap, truncate, cache the network) and skipped the one that tells you whether any of it mattered.

### Where this breaks down

Edge routing has a ceiling: the classifier itself can be wrong, sending an easy query down an expensive agent path. The `maxToolCalls` budget trades cost for completeness — too low a cap and the agent synthesizes from thin evidence (the `FALLBACK` diagnosis). Truncation can cut the one number the model needed if a tool result's important data sits past the 16k boundary. And the absence of cost telemetry means a regression — say a prompt change that doubles output tokens — ships silently; the bill only reveals it weeks later.

### What to explore next

- FrugalGPT-style in-agent cascade — run a cheap pass first, escalate to sonnet only when the cheap output fails the validator (`isDiagnosis`, `isRecommendationArray`)
- Prompt caching (`cache_control`) — the unbuilt shrink lever; see `01-llm-caching.md`
- `res.usage` accounting + a `cost` field on the `done` event — the unbuilt "see" lever
- Helicone / Langfuse / OpenLLMetry — managed LLM cost-and-trace dashboards that wrap the provider client

---

## Tradeoffs

| Dimension | This codebase | Add in-agent cascade | Add cost meter (see) |
|---|---|---|---|
| Cost removed | strong model on classification | strong model on easy agent runs | none directly — enables targeting |
| Setup complexity | done | medium — verifier + escalation path | low — read `res.usage`, sum, emit |
| Failure mode | classifier misroutes | cheap pass fails → double-pay | none — pure observability |
| Quality risk | none added | cheap model may degrade output | none |
| Payoff visibility | invisible (no meter) | invisible without a meter | makes all payoffs visible |

**What we gave up.** Running every agent on sonnet means blooming insights pays the strong-model rate even for runs where a cheap pass would have produced a valid diagnosis. With no cost meter, the output-heavy `synthesize()` line item is invisible — a prompt edit that doubles its tokens would not be noticed until the monthly bill. The team gave up the ability to prioritize: they optimized the levers that were structurally obvious rather than the one the data would have pointed at.

**What the alternative would have cost.** An in-agent cascade adds a verifier-and-escalate path: run haiku, check `isDiagnosis`, fall back to sonnet on failure. When the cheap pass fails you pay *both* models, so the cascade only nets out if the cheap pass succeeds often enough. For a reasoning-heavy diagnosis task it might not — which is a legitimate reason to defer it. The cost meter, by contrast, is nearly free (read a field already returned) and is the prerequisite for knowing whether the cascade would even help.

**The breakpoint.** The current setup is right while live runs are rare and demos replay from cache (zero Claude cost). The moment live runs become frequent, the sonnet-everywhere choice and the absence of prompt caching compound, and the missing cost meter becomes the bottleneck to fixing either — you cannot optimize what you cannot measure. The trigger is the first month the LLM bill is large enough to question; at that point the cost meter is the first thing to build, before any other lever.

---

## Tech reference (industry pairing)

### model routing (haiku vs sonnet)

- **Codebase uses:** `classifyIntent` on `claude-haiku-4-5-20251001` (`lib/agents/intent.ts` L14) vs `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9) for agents.
- **Why it's here:** a one-word classification does not need sonnet's reasoning; haiku at `max_tokens: 16` is pennies.
- **Leading today:** Anthropic model tiers — haiku/sonnet/opus (adoption-leading for Claude apps, 2026); learned routers like RouteLLM (innovation-leading, 2026).
- **Why it leads:** explicit tiers make the cost-quality choice legible; learned routers pick the cheapest model that will pass per query.
- **Runner-up:** OpenAI's tiered models (gpt-mini vs full) with the same cheap-classifier pattern.

### token budgeting

- **Codebase uses:** `maxToolCalls` (6/6/4/6), `max_tokens` caps (4096 default, 2048 synthesis, 16 classifier), `truncate(16_000)`.
- **Why it's here:** bounds tokens and latency so an agent cannot run up the bill against the 300s route ceiling.
- **Leading today:** framework-level budgets (LangGraph `recursion_limit`, Anthropic Agent SDK turn caps) (adoption-leading, 2026).
- **Why it leads:** budgets are enforced by the orchestration layer, not hand-rolled per agent.
- **Runner-up:** a hand-rolled turn/tool counter — exactly what `runAgentLoop` does.

### cost accounting (`res.usage`)

- **Codebase uses:** nothing — `res.usage` is returned on every response and read nowhere.
- **Why it's here:** it is the missing "see" lever; the output-heavy `synthesize()` calls are the unmonitored line item.
- **Leading today:** Helicone, Langfuse, OpenLLMetry (adoption-leading LLM cost/trace dashboards, 2026); Vercel AI SDK usage hooks (innovation-leading for Next.js, 2026).
- **Why it leads:** they wrap the provider client and aggregate usage across requests with zero per-call code.
- **Runner-up:** a hand-rolled accumulator summing `res.usage` per request — the exercise below.

---

## Project exercises

### Per-run cost meter from `res.usage`

- **Exercise ID:** C5.3 (cost) / B5.3 (adapted) — provenance C5.2/C5.3.
- **What to build:** Accumulate `input_tokens` and `output_tokens` from every `res.usage` across an investigation — the loop turns in `runAgentLoop` plus both `synthesize()` calls — multiply by per-model rates, and emit a `cost` field (with a per-call breakdown) on the `done` NDJSON event so the UI can show what a run cost.
- **Why it earns its place:** it proves you know cost optimization starts with measurement, and it surfaces the output-heavy `synthesize()` line item that is currently invisible.
- **Files to touch:** `lib/agents/base.ts` (read `res.usage` after L102), `lib/agents/diagnostic.ts` + `lib/agents/recommendation.ts` (read `res.usage` in `synthesize()` after the create at L97/L96), `app/api/agent/route.ts` (sum per request in `start()` L170, emit on `done` L251), `lib/mcp/events.ts` (extend the `done` event shape).
- **Done when:** a live diagnostic run emits a `done` event whose `cost` breakdown shows the synthesis calls outweighing the loop turns, matching a hand calculation from the printed token counts.
- **Estimated effort:** 1–4hr.

### Cheap-first-then-escalate cascade in one agent

- **Exercise ID:** B5.2 (adapted) — provenance C5.2 (latency/cost cascade).
- **What to build:** In `DiagnosticAgent`, run the loop on haiku first; if the result fails `isDiagnosis`, escalate and re-run on sonnet. Gate it on the cost meter so you can prove whether the cascade nets out.
- **Why it earns its place:** demonstrates the FrugalGPT cascade and an honest reckoning with its double-pay failure mode using real measurement.
- **Files to touch:** `lib/agents/base.ts` (parameterize the `model` at L93), `lib/agents/diagnostic.ts` (`investigate` L45–L83 — add the escalation path).
- **Done when:** runs where haiku's output passes `isDiagnosis` cost measurably less; runs where it fails show the double-pay clearly in the cost meter — proving you measured the tradeoff rather than assumed it.
- **Estimated effort:** 1–2 days.

---

## Summary

blooming insights pulls the cost levers that were structurally obvious: a cheap haiku classifier at the edge (`lib/agents/intent.ts`), hard `maxToolCalls` budgets (6/6/4/6), 16k tool-result truncation, and a 60s tool cache. It skips the harder, higher-value levers — prompt caching of the repeated prefix, a cheap-first cascade *within* agents (all run sonnet), and any per-request cost telemetry. Because output tokens cost several times more than input tokens, the output-heavy `synthesize()` calls are the dominant line item — and with `res.usage` read nowhere, nobody is watching it. The cost meter is the prerequisite buildable target; it tells you whether any other lever is worth pulling.

**Key points:**
- Cost = input·in$ + output·out$ summed over calls; output tokens dominate, so the JSON-emitting `synthesize()` calls are the line item.
- Routing happens once at the edge (haiku classifier) but never *inside* agents — every agent is sonnet (`lib/agents/base.ts` L9).
- Shrink levers are mostly built: `maxToolCalls` budgets (L90), 16k truncation (L29), 60s tool cache.
- The unbuilt levers are prompt caching, an in-agent cascade, and cost telemetry — and `res.usage` is read by nobody.
- You cannot optimize the line item you cannot see; the cost meter comes before the cascade.

---

## Interview defense

### What an interviewer is really asking

"How do you control LLM cost?" tests whether you know that output tokens dominate and that measurement comes first. The weak answer is "use a cheaper model." The strong answer names the three lever families (route, shrink, see), identifies the output-heavy call as the line item, and says you cannot prioritize without a per-request cost meter.

### Likely questions

**[mid] Where does blooming insights route by cost, and where does it not?**

It routes once at the edge: `classifyIntent` uses haiku at `max_tokens: 16` (`lib/agents/intent.ts` L14, L20) for the one-word agent-selection decision. It does *not* route inside agents — `AGENT_MODEL` is sonnet (`lib/agents/base.ts` L9) for every loop turn and every synthesis call.

```
  edge:   haiku  (classify, 1 word)   ← routed
  agents: sonnet (all work)           ← uniform, not routed
```

**[senior] Which single call is the dominant cost in an investigation, and why?**

`synthesize()` (`lib/agents/diagnostic.ts` L87–L126, `max_tokens: 2048`, sonnet). Loop turns are input-heavy (cheap per token); synthesis emits a full JSON diagnosis — output tokens, which cost several times more each. The output-heavy call on the strong model is where the money concentrates.

```
  loop turns   : many input tokens × low $
  synthesize() : 2048 output tokens × HIGH $  ← dominant
```

**[arch] You have no cost dashboard. What do you build first and why before a cheaper-model cascade?**

The cost meter — accumulate `res.usage` per request and emit it. Without it you cannot prove a cascade nets out (the cascade double-pays when the cheap pass fails). Measure first, then decide whether haiku-first even helps for a reasoning task.

```
  res.usage (already returned) ── summed per run ──► cost on done event
        │
        └─ now you can tell if haiku-first saves or costs more
```

### The question candidates always dodge

**"Why not just put every agent on haiku to cut cost?"**

Because a diagnosis is a reasoning task — haiku may fail the `isDiagnosis` validator, forcing a sonnet re-run, so you pay *both*. The honest answer is that you don't know whether haiku-first wins without measuring, which is exactly why the cost meter is the first build. Blanket-downgrading the model is the move that sounds frugal and is often more expensive.

### One-line anchors

- `lib/agents/intent.ts` L14, L20 — haiku classifier, `max_tokens: 16` (the only routing)
- `lib/agents/base.ts` L9 — `AGENT_MODEL = 'claude-sonnet-4-6'` (uniform agent model)
- `lib/agents/base.ts` L90–L91 — `maxToolCalls` budget enforcement
- `lib/agents/base.ts` L29 — `MAX_TOOL_RESULT_CHARS = 16_000`
- `lib/agents/diagnostic.ts` L87–L126 — output-heavy `synthesize()`, the line item

---

## Validate

### Level 1 — Reconstruct

From memory, list the three lever families (route, shrink, see) and place each blooming insights mechanism under one: haiku classifier, `maxToolCalls`, 16k truncation, tool cache, prompt caching (absent), in-agent cascade (absent), cost meter (absent).

### Level 2 — Explain

Out loud: explain why "switch everything to a cheaper model" can *increase* cost for a reasoning task. Tie it to the `isDiagnosis` validator and the double-pay failure mode of a cascade.

### Level 3 — Apply

Scenario: the monthly LLM bill spiked. Open `lib/agents/diagnostic.ts` L87–L126. Explain why this `synthesize()` call is the first place to suspect, citing its `max_tokens: 2048` (L99) and that it emits JSON (output tokens). Then state exactly where you would read `res.usage` to confirm it (after the create at L97).

### Level 4 — Defend

A teammate wants to add a haiku-first cascade to every agent immediately. Defend the position that the cost meter must ship first: state what you cannot know without it (whether the cheap pass succeeds often enough to beat the double-pay), and name the file where the meter would live (`lib/agents/base.ts`, reading `res.usage` after L102).

### Quick check — code reference test

Which model does the intent classifier use, on which line, and what is its `max_tokens`? (Answer: `claude-haiku-4-5-20251001` at `lib/agents/intent.ts` L14, `max_tokens: 16` at L20.)

---
Updated: 2026-05-28 — maxDuration 60→300 (route.ts L20); re-derived drifted refs: synthesize ranges (diagnostic L87–L126, recommendation L82–L132), route TRUNC/start()/done (L99/L170/L251), tool-cache range (client.ts L97–L146), monitoring maxToolCalls L84.
