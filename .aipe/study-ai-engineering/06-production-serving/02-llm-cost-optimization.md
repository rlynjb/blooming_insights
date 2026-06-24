# LLM cost optimization

**Industry name(s):** model routing / model cascading, token budgeting, prompt caching, cost-per-request accounting
**Type:** Industry standard · Language-agnostic

> blooming insights routes a cheap haiku classifier at the edge, caps every agent with a hard `maxToolCalls` budget, truncates tool results to 16k chars, and caches tool calls — but every *agent* still runs on sonnet, never caches the prompt prefix, and emits no cost telemetry, so the output-token-heavy `synthesize()` call quietly dominates the bill.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Cost optimization is the *shape of decisions* the Provider wrappers band carries, plus a meter that does not yet exist. The levers span layers: the haiku classifier at the Intent-parsing boundary (`lib/agents/intent.ts` L14), the `maxToolCalls` budgets in each Per-agent file, the `truncate` cap and `budgetSpent`/`forceFinal` in the Agent loop, and the TTL tool cache at `lib/mcp/client.ts`. The one piece missing — `res.usage` logging — would sit right at the Provider call.

```
  Zoom out — every layer holds a lever (and one is missing)

  ┌─ Intent parsing ─────────────────────────────────┐
  │  HAIKU classifier  intent.ts L14  ← tier lever    │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent ─────────────▼────────────────────────┐
  │  maxToolCalls 6/6/4/6  ← bound calls              │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Agent loop ────────────▼────────────────────────┐
  │  truncate 16_000 chars  base.ts L31–34            │
  │  budgetSpent → forceFinal L90–91                  │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider wrappers ─────▼────────────────────────┐  ← we are here
  │  ★ TTL cache  mcp/client.ts L18 (60s) ★            │
  │  (would-be) prompt prefix cache — ABSENT          │
  │  (would-be) res.usage logging — ABSENT (no meter) │
  │  SONNET on every agent — no escalation tiering    │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: where does the money go per request, and which lever actually moves it? The levers are not equal — output tokens cost several times more than input tokens, and a single long structured-output call (`synthesize()`) can outweigh a dozen short tool calls. blooming insights made the right edge calls (haiku for the one-word job, hard budgets, truncation, the TTL cache) but runs every agent on sonnet and has no cost meter, so the biggest line item is the one nobody is watching. How it works walks each lever, the asymmetric input/output pricing, and the one-field meter (`res.usage`) that would turn guesses into facts.

---

## Structure pass

**Layers.** Four layers, each holding one cost lever: intent parsing (haiku classifier — *route* lever), per-agent definitions (`maxToolCalls` — *bound calls* lever), agent loop (`truncate` + `forceFinal` — *shrink* lever), and provider wrappers (TTL cache + would-be prompt prefix cache + would-be `res.usage` logging — *cache* and *see* levers). The "see" lever is the meter; without it, every other lever is pulled blind.

**Axis: cost.** What does each layer pay per request, and which lever moves *that* line item? This axis is the right lens because the file is a per-layer cost lever inventory. Where token-economics (`01-llm-foundations/06`) asks "what's the bill?", this file asks "which lever moves it?" — same axis, different cut. The unifying observation: output tokens cost ~5× input, and one long `synthesize()` call can outweigh a dozen short tool calls, so the *biggest* line item is whichever layer touches output token volume.

**Seams.** The cosmetic seam is between intent parsing and per-agent — both are CODE-decided pre-spend bounds. The load-bearing seam is between the agent loop's shrink levers and the provider wrappers: cost flips here from "bounded by my code" to "billed by their meter (or unbilled because I don't read it)." The would-be prompt prefix cache and `res.usage` logging both sit at this seam. A pointed observation: the file's tagline is the failure mode of pulling levers without a meter — you optimize the wrong line item.

```
  Structure pass — LLM cost optimization

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  intent parsing (haiku — route lever)          │
  │  per-agent (maxToolCalls — bound)              │
  │  agent loop (truncate, forceFinal — shrink)    │
  │  provider wrappers (cache + meter)             │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: which lever at which layer moves which  │
  │  line item — and is there a meter?             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  intent↔per-agent: cosmetic (both pre-spend)   │
  │  agent loop↔provider wrappers: LOAD-BEARING    │
  │    bounded by code → billed by meter           │
  │    meter is absent → optimize blind            │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** A request's cost is `input_tokens × in_price + output_tokens × out_price`, summed over every model call in the request. Three families of lever exist: **route** (send the request to a cheaper model when the task is easy), **shrink** (reduce the tokens — cap exploration, truncate context, cache the prefix), and **see** (measure per-request cost so you optimize the right line). You pull the route lever once at the edge, pull most shrink levers, and pull no see lever at all.

```
 cost = Σ over calls ( in_tokens·in$ + out_tokens·out$ )
        ▲              ▲                ▲
        │              │                └─ SHRINK: cap output, route to cheap model
        │              └─ SHRINK: truncate, prompt-cache prefix, maxToolCalls
        └─ SEE: measure per-request so you know which lever to pull
```

The trap is that `out$` is several times `in$`, and the agents' `synthesize()` calls are output-heavy (a full JSON diagnosis), so the dominant line item is the one place the codebase spends *output* tokens — not the many input-heavy tool-call turns.

---

### Route — model selection at the edge (the intent classifier)

The one place this system routes by cost is intent classification. A free-form `?q=` query first goes to a cheap-tier model to decide which agent surface should answer it — a one-word output.

```
 ?q="why did conversion drop?"
        │
        ├─ classify_intent  →  cheap tier  (max_tokens: 16)   ← cheap, one word
        │                       "diagnostic"
        ▼
   QueryAgent.answer        →  dear tier (full agent loop)    ← expensive, the work
```

The classifier model is a cheap-tier model and the call sets `max_tokens: 16` plus a system prompt that forces exactly one word. Routing a classification to the cheap tier instead of the dear tier is the textbook cheap-model-for-an-easy-task move: the task has one bit of decision content, so it does not need the strong model's reasoning.

```
  task: "pick one of three labels"
   ┌──────────────────────────────┐
   │ cheap tier  max_tokens 16   chosen
   │ dear tier   full reasoning  overkill for a label
   └──────────────────────────────┘
```

That is the *only* model-routing decision. Inside every agent, the model is a shared `AGENT_MODEL` constant (the dear-tier model), used uniformly for the loop turns *and* the dedicated synthesis calls.

---

### Shrink — hard tool-call budgets (`maxToolCalls`)

Each agent caps the total number of tool calls it may make. Once the cap is hit, the loop forces a tool-less final turn (see `../04-agents-and-tool-use`), bounding both token spend and latency.

```
agent                maxToolCalls
─────────────        ────────────
MonitoringAgent           6
DiagnosticAgent           6
RecommendationAgent       4
QueryAgent                6
```

A `budgetSpent` check is true once `toolCalls.length >= maxToolCalls`; the `forceFinal` flag flips on when the budget is spent. Without this cap an agent could explore until the route's `maxDuration = 300` limit killed it — burning tokens the whole way with nothing to show.

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
 MCP result ──► truncate(16_000) ──► fed back as tool_result   (the agent-loop cap)
 tool result ──► trunc(4000) ──────► sent to UI as NDJSON       (the route stream cap)
```

The 16,000-character cap on each tool result is critical because the full message history is re-sent on every turn, so an un-truncated 50k result would be re-charged 5+ times. The route's 4,000-character cap is a separate, smaller cap for what streams to the browser. The schema-summary helper further caps the schema injected into prompts (20 events / 10 props / 30 customer-props).

---

### Shrink — caching (cross-reference)

The 60s exact-match tool cache removes repeat network round-trips and the tokens of re-feeding an identical result. The investigation replay cache removes entire runs. Both are covered in `01-llm-caching.md`. The cost lever they do *not* pull — prompt caching of the static prefix — is the unbuilt shrink lever below.

---

### Shrink — gate before spend (the coverage gate)

There is a fourth shrink lever that costs nothing per request: refuse to spend on work the data cannot support. Before the monitoring agent runs, the briefing route computes `runnable = runnableCategories(schemaCapabilities(schema))` — a pure in-memory schema check — and passes only those categories into `agent.scan({…}, runnable)`. The agent's prompt checklist therefore lists only categories this workspace's events can support, so the agent never burns one of its ~1 req/s MCP calls querying a category the schema cannot answer.

```
 gate-before-spend (free) ── then the agent spends (metered)
 ─────────────────────────────────────────────────────────────
 schema_capabilities(schema)       ← in-memory Set build, $0
        │
 runnable_categories(...)          ← filter 10 → runnable, $0
        │ runnable
 agent.scan({…}, runnable)         ← only runnable categories enter the prompt
        │
 runAgentLoop (≤6 MCP calls)       ← spends the ~1 req/s budget here, gated set only
```

The lever is "do not pay the metered cost (MCP budget, tokens, latency) for work a cheap free check already proved impossible." It is the same discipline as the intent classifier — decide cheaply before committing the expensive resource — applied to *which categories* rather than *which model*. See `../04-agents-and-tool-use/07-capability-gating.md` for the full treatment of the gate.

---

### The output-token line item — where the bill actually concentrates

Input tokens are many but cheap; output tokens are few but several times more expensive each. The agents' loop turns are input-heavy (re-sending history, tool results). The `synthesize()` calls are output-heavy: they emit a complete structured JSON object.

```
 call type            tokens               $ weight
 ───────────────      ──────────────       ─────────────────────
 loop turn (tools)    input-heavy          low per token, many tokens
 synthesize()         output-heavy (JSON)  HIGH per token  ← line item
```

The diagnostic agent's `synthesize` call is a dedicated model call with `max_tokens: 2048` on the dear tier, emitting a full diagnosis JSON. The recommendation agent's `synthesize` mirrors it at `max_tokens: 2048`. These output-heavy dear-tier calls are the dominant cost per investigation — and the codebase has no telemetry pointing at them.

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

Three gaps: (1) **no in-agent cascade** — every agent runs the dear tier from the first turn; a cheap-first pass (try the cheap tier, escalate to the dear tier only when the cheap output fails validation) is not attempted. (2) **no prompt caching** — the static prefix re-costs at full input price every turn (see `01-llm-caching.md`). (3) **no cost visibility** — `res.usage` (returned on every provider response) is read by nobody, so the output-heavy `synthesize()` line item is invisible.

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
  │  │  intent.ts — max_tokens 16, 1 word │                     │
  │  └────┬──────────────────────────────────────┘                     │
  │       │                                                             │
  │  ╎ SEE  per-request cost meter from res.usage  (ABSENT) ╎          │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/  — all sonnet (AGENT_MODEL base.ts L9)     │
  │                                                                       │
  │  ┌────────────────────────────────────────────────────┐             │
  │  │  SHRINK  maxToolCalls 6/6/4/6  (BUILT)  base.ts      │             │
  │  │  SHRINK  truncate 16k         (BUILT)  base.ts       │             │
  │  └────────────────────────────────────────────────────┘             │
  │       │                                                               │
  │  ╎ SHRINK  prompt cache (cache_control)  (ABSENT)  base.ts ╎     │
  │  ╎ ROUTE   cheap-first-then-escalate     (ABSENT)              ╎     │
  │       │                                                               │
  │  ┌────▼───────────────────────────────────────────────┐            │
  │  │  synthesize()  sonnet, max_tokens 2048, JSON out     │            │
  │  │  OUTPUT-HEAVY → dominant line item                   │            │
  │  │  diagnostic.ts / recommendation.ts          │            │
  │  └─────────────────────────────────────────────────────┘            │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  mcp.callTool
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER / MCP LAYER                                                 │
  │  SHRINK  60s tool cache (BUILT)  lib/mcp/client.ts                    │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: routing and shrinking are mostly built, the output-heavy synthesis call is the cost center, and there is no meter watching it.

---

## Implementation in codebase

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

## See also

→ 01-llm-caching.md · → 04-rate-limiting-backpressure.md · → ../01-llm-foundations/README.md · → ../04-agents-and-tool-use/README.md

---
Updated: 2026-05-28 — maxDuration 60→300 (route.ts L20); re-derived drifted refs: synthesize ranges (diagnostic L87–L126, recommendation L82–L132), route TRUNC/start()/done (L99/L170/L251), tool-cache range (client.ts L97–L146), monitoring maxToolCalls L84.

---
Updated: 2026-05-29 — Added a "gate before spend" shrink lever: `runnableCategories(schemaCapabilities(schema))` (briefing route L202–204) gates the monitoring agent's category checklist before it spends any of the ~1 req/s MCP budget (monitoring.ts L73–86 / scan call L223/240). Verified maxDuration L20 already cites 300. Cross-ref ../04-agents-and-tool-use/07-capability-gating.md.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
