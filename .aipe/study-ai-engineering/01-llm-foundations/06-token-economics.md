# Token economics (the cost controls present, the cost meter absent)

**Industry name(s):** token economics, LLM cost engineering, model-tiering / cost-aware routing
**Type:** Industry standard · Language-agnostic

> Every model call costs money proportional to tokens, with output tokens ~5× the price of input; blooming insights controls cost with hard tool-call budgets, character truncation, and a cheap haiku classifier in front of expensive sonnet agents — but it has *no* cost meter: nothing logs `res.usage`, so the spend is bounded but unmeasured.

**See also:** → 02-tokenization.md · → 03-sampling-parameters.md · → 07-heuristic-before-llm.md · → 08-provider-abstraction.md

---

## Why care

You profile a slow page and find one component re-fetching on every render. You do not guess — you open the network tab, see 40 requests where there should be 4, and fix the one that matters. The fix is cheap; *finding* it required a meter. Without the network tab you would be optimizing blind, "improving" things that were already fine and missing the one that was not.

LLM cost is the same problem with the meter missing. Every `anthropic.messages.create` call bills by tokens consumed, and a multi-agent investigation makes many calls. The question is two-part: how do you *bound* the cost so a runaway loop cannot rack up an unbounded bill, and how do you *measure* it so you know which call is the expensive one?

**The pivot: bounding cost and measuring cost are different jobs, and a system can do the first well while doing the second not at all.** A turn budget caps the worst case; a cost log tells you the typical case. blooming insights invests heavily in the bounds and skips the meter entirely — defensible for a demo, a real gap for production tuning.

Before cost controls:
- A diagnostic agent loops until the 300-second route timeout, burning tokens the whole way
- Every classification uses the full sonnet model
- A 60KB tool result re-enters the conversation in full, inflating every subsequent turn

After:
- `maxToolCalls` caps each agent at a fixed number of round-trips
- A cheap haiku model classifies intent; expensive sonnet does the analysis
- Tool results are truncated to 16,000 chars before re-entering the context

But still missing: any record of how many tokens that investigation actually cost.

It is the network-tab discipline — bound the request count *and* watch the meter — with the meter not yet built.

---

## How it works

**Mental model.** Token cost is `input_tokens × input_price + output_tokens × output_price`, summed over every call in a run, where `output_price ≈ 5 × input_price`. So three levers move the bill: how many *calls* you make (budget), how *big* each call's input is (truncation), and how *expensive* each call's model is (tiering). blooming insights pulls all three on the bounding side and pulls none on the measuring side.

```
cost(run) = Σ over calls  (input_tokens · p_in  +  output_tokens · p_out)
                                                         ▲
                                              p_out ≈ 5 · p_in
levers:
  fewer calls   → maxToolCalls budget        (bound)
  smaller input → truncate / schemaSummary   (bound)
  cheaper model → haiku classifier vs sonnet (bound)
  know the bill → log res.usage              (MEASURE — absent)
```

The first three are dials you can turn before the call; the fourth is a gauge you read after. The codebase has the dials and not the gauge.

---

### Lever 1 — call-count budgets (`maxToolCalls`)

Each agent caps total tool calls, which caps the number of agent-turn model calls (each tool round-trip is a model call). The budgets (`lib/agents/monitoring.ts` L74, `lib/agents/diagnostic.ts` L61, `lib/agents/recommendation.ts` L57, `lib/agents/query.ts` L41):

```
agent           maxToolCalls   why
──────────────  ────────────   ────────────────────────────────────
monitoring          6          bound scan latency under 1 req/s MCP limit
diagnostic          6          bound investigation depth
recommendation      4          fewer queries needed to propose actions
query               6          free-form, broad tool access
```

`budgetSpent` flips `forceFinal` once `toolCalls.length >= maxToolCalls` (`lib/agents/base.ts` L90–L91), forcing the model to stop querying and emit its answer. Without this, the loop runs until `maxTurns` (8) or the route's `maxDuration = 300` (`app/api/agent/route.ts` L20) — burning tokens on every wasted turn. The budget is the primary defense against a runaway bill.

```
turn 0  2 calls
turn 1  4 calls            (diagnostic, budget 6)
turn 2  6 calls → budgetSpent → forceFinal → emit JSON, STOP
                                             no turn 3+ → no extra tokens
```

---

### Lever 2 — input truncation

Output tokens cost ~5×, but *input* tokens accumulate fast in a multi-turn loop because every prior tool result rides along in `messages` on every subsequent call. Truncation caps that growth: `truncate` slices each tool result to `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts` L29, L31–L34), and `schemaSummary` caps the static schema prefix (`lib/agents/monitoring.ts` L15–L48). See → 02-tokenization.md for the full character-budget story.

```
without truncation:           with truncation:
turn 0: schema + 60KB result  turn 0: schema + 16KB result
turn 1: + 60KB result         turn 1: + 16KB result
turn 2: + 60KB result         turn 2: + 16KB result
input grows ~60KB/turn        input grows ~16KB/turn  ← ~3.75× cheaper input
```

---

### Lever 3 — model tiering (haiku classifier vs sonnet agents)

The cheapest routing decision: do not pay the expensive model to do a trivial job. Intent classification — mapping a query to one of three labels — uses haiku (`CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'`, `lib/agents/intent.ts` L14), while the actual analysis uses sonnet (`AGENT_MODEL = 'claude-sonnet-4-6'`, `lib/agents/base.ts` L9):

```
classify intent   → haiku   (cheap, fast)   intent.ts L14, max_tokens 16
analyze / diagnose → sonnet  (capable, dearer) base.ts L9, max_tokens 4096
```

A haiku call capped at `max_tokens: 16` (→ 03-sampling-parameters.md) costs a tiny fraction of a sonnet agent turn. Putting the cheap model on the routing decision and the expensive model on the reasoning is textbook cost-aware tiering.

---

### Where the big line item is, and the meter that would show it

The single most expensive call in an investigation is the **synthesis pass** when it runs. `synthesize()` (`lib/agents/diagnostic.ts` L87–L126, `lib/agents/recommendation.ts` L82–L132) is a *full sonnet call* with `max_tokens: 2048` of output, and it formats up to six tool results as evidence text in its input — large input, large output, on the dear model. It only fires when the loop's final turn fails to produce valid JSON (→ 04-structured-outputs.md), so its cost is conditional: zero on the happy path, ~2× the agent's tokens on the unlucky path.

```
investigation token cost (sonnet)
  diagnostic loop   : up to 6 turns × growing input + 4096 output
  synthesis (maybe) : large evidence input + 2048 output   ← the spike
  recommendation    : up to 4 turns × input + 4096 output
  + synthesis (maybe): another spike
```

The meter to see this is `res.usage` — the SDK returns `input_tokens` and `output_tokens` on every `create` response. **Nothing in the codebase reads it.** There is no `ai_call_log`, no per-run token total, no cost dashboard. The spend is *bounded* (the three levers guarantee a worst case) but *unmeasured* (no one knows the typical case, or which call dominates it).

---

### Current state vs. future state

```
CURRENT (bounded, blind)              FUTURE (bounded, metered)
────────────────────────────────     ────────────────────────────────
maxToolCalls caps worst case          + res.usage logged per call
truncation caps input growth          + per-agent token totals
haiku tiering on classification       + cost = tokens × price table
NO record of actual spend             + ai_call_log row per run
"which call is expensive?" = guess    "which call is expensive?" = query
```

The bounds make a runaway bill *impossible*; the missing meter makes the *typical* bill *invisible*. You cannot tune what you cannot see — the first optimization after shipping is the meter, not another bound.

---

### The principle

Cost engineering is two disciplines: bound the worst case before the call (budgets, truncation, tiering) and measure the typical case after the call (`res.usage` logging). blooming insights does the first thoroughly — a runaway loop cannot happen — and skips the second entirely, so it has guarantees without observability. That is a fine posture for a bounded demo and a liability the moment you need to tune cost against real traffic, because the meter is the prerequisite for every targeted optimization.

---

## Token economics — diagram

This diagram spans the call path and marks where each cost lever acts and where the missing meter would sit. Service-layer dials bound the spend; the Provider response carries the usage the codebase never reads.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (cost levers — all on the bounding side)              │
│                                                                       │
│  classifyIntent → HAIKU  intent.ts L14   ← tier: cheap model         │
│       │                                                              │
│  runAgentLoop (SONNET base.ts L9)                                    │
│   maxToolCalls budget  monitoring 6 / diag 6 / rec 4 / query 6       │
│       │  budgetSpent → forceFinal  base.ts L90–91   ← fewer calls    │
│   truncate tool result → 16_000 chars  base.ts L31–34  ← smaller in  │
│   schemaSummary caps   monitoring.ts L15–48            ← smaller in  │
│       │                                                              │
│   synthesize() (conditional)  diagnostic L87–126, 2048 out  ← spike  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  create(params)  base.ts L102
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic — where the bill is set)                 │
│                                                                       │
│  cost = input_tokens · p_in  +  output_tokens · p_out                │
│                                          (p_out ≈ 5 · p_in)          │
│  res.usage = { input_tokens, output_tokens }   ◀── NEVER READ        │
│                                                    (no meter)         │
└────────────────────────────────────────────────────────────────────────┘
```

Every lever the codebase pulls is upstream of the call (bound the spend); the one thing it never touches is `res.usage` downstream of the call (measure the spend).

---

## In this codebase

**Partially addressed — bounds present, meter absent.** Cost is controlled by `maxToolCalls` budgets, input truncation, and haiku-vs-sonnet tiering, but nothing reads `res.usage`; there is no `ai_call_log`, per-run token total, or cost dashboard.

### Files, functions, and line ranges

- **Call-count budgets (`maxToolCalls`):** monitoring `6` (`lib/agents/monitoring.ts` L74), diagnostic `6` (`lib/agents/diagnostic.ts` L61), recommendation `4` (`lib/agents/recommendation.ts` L57), query `6` (`lib/agents/query.ts` L41); enforced via `budgetSpent`/`forceFinal` at `lib/agents/base.ts` L90–L91.
- **Input truncation:** `MAX_TOOL_RESULT_CHARS = 16_000` / `truncate` — `lib/agents/base.ts` L29, L31–L34; `schemaSummary` caps — `lib/agents/monitoring.ts` L15–L48.
- **Model tiering:** `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` — `lib/agents/intent.ts` L14; `AGENT_MODEL = 'claude-sonnet-4-6'` — `lib/agents/base.ts` L9.
- **The big line item:** `synthesize()` sonnet calls — `lib/agents/diagnostic.ts` L87–L126 (`max_tokens: 2048` at L99), `lib/agents/recommendation.ts` L82–L132 (L98).
- **The absent meter:** no read of `res.usage` anywhere; the model call at `lib/agents/base.ts` L102 returns it and discards it.

### Where the meter would live

A token-accounting field would accumulate on `AgentRunResult` (`lib/agents/base.ts` L24–L27), populated by reading `res.usage` after `create` (L102) and after each `synthesize()` call. The route (`app/api/agent/route.ts`) would sum per-agent totals and either stream a final `usage` event or write an `ai_call_log` row alongside `saveInvestigation` (called at `app/api/agent/route.ts` L254; the store is `lib/state/investigations.ts` L30).

---

## Elaborate

### Where this pattern comes from

Token-based billing is universal across LLM providers, and the asymmetry — output tokens priced several times higher than input — reflects that generation is autoregressive (each output token requires a full forward pass) while input is processed in parallel. The ~5× figure is an order-of-magnitude rule across Anthropic and OpenAI tiers; the exact multiple varies by model. Cost-aware *model tiering* (cheap model for routing/classification, expensive model for reasoning) is the LLM analog of putting a cheap regex check before an expensive parse, or a CDN cache before an origin server.

Reading `res.usage` and logging it is the LLM equivalent of request-level observability — the same instinct as logging response time and status code on every HTTP call. Production LLM systems treat per-call token logging as table stakes precisely because the bill is otherwise invisible.

### The deeper principle

```
bound (before the call)              measure (after the call)
──────────────────────────────      ──────────────────────────────
guarantees a worst case              reveals the typical case
prevents runaway bills               enables targeted tuning
maxToolCalls, truncate, tiering      res.usage logging, ai_call_log
present in this codebase             ABSENT in this codebase
```

Bounding answers "can this ever cost too much?" — no, the budget caps it. Measuring answers "what does it actually cost, and where?" — unknown here. The two are independent: you can have airtight bounds and zero visibility, which is exactly this codebase's state.

### Where this breaks down

1. **No way to find the expensive call.** Without `res.usage`, you cannot confirm the `synthesize()` pass is the line item, or how often it fires. Every cost optimization after shipping would be a guess — the network-tab-missing problem.

2. **Bounds are in *calls*, not *tokens*.** `maxToolCalls` caps round-trips, but a single turn with a huge truncated-but-still-16KB input and a full 4096-token output can cost more than two small turns. The budget bounds the wrong unit for fine cost control (it bounds latency well; cost only coarsely).

3. **Conditional synthesis cost is invisible.** The `synthesize()` spike is exactly the cost the team would want to track (it doubles an agent's tokens when it fires), and it is the one with no meter at all — its frequency is unknown.

### What to explore next

- **`res.usage` logging:** the single highest-value addition — exact input/output tokens per call, for free (already returned).
- **`ai_call_log` table / structured cost log:** persist per-run token totals to query "p50/p95 cost per investigation" and "how often does synthesis fire?"
- **Anthropic prompt caching (`cache_control`):** the system prompt and schema summary are identical across turns of one agent — caching them would cut repeated input-token cost; currently absent.
- **Token-unit budgets:** cap by accumulated tokens (read from `res.usage`) rather than only by call count, for tighter cost bounds.

---

## Tradeoffs

### Bounds-only cost control vs. bounds + metering

| Dimension | This codebase (bounds, no meter) | Bounds + `res.usage` metering |
|---|---|---|
| Worst-case bill | Capped (budgets + truncation) | Capped |
| Typical-case visibility | None | Per-call, per-agent, per-run |
| Find the expensive call | Guesswork | Direct query |
| Cost of adding it | N/A | Read a field already returned + a log sink |
| Tune cost against traffic | Blind | Data-driven |
| Synthesis-spike frequency | Unknown | Counted |

**What we gave up.** All cost *visibility*. The system guarantees an investigation cannot cost more than its budgets allow, but cannot say what one actually costs, which call dominates, or how often the synthesis spike fires. Every post-launch cost optimization starts blind. This is the same observability gap noted for `FALLBACK` in → 01-what-an-llm-is.md — the bounds work, but their effect is unmeasured.

**What the alternative would have cost.** Almost nothing. `res.usage` is already on every `create` response; logging it is reading a field and writing a row. The cost is the discipline of threading a usage total through `AgentRunResult` and persisting it — hours, not days. The reason it is absent is scope (a demo does not pay a real bill), not difficulty.

**The breakpoint.** Bounds-only is fine while no one pays a per-token bill and runs are short. It breaks the instant the system serves real traffic at real prices: the first cost-reduction ask ("our LLM bill is too high — cut it 30%") is unanswerable without the meter, because you cannot target what you cannot see. At that point `res.usage` logging is the prerequisite, not an enhancement.

**Not actually a tradeoff:** the haiku-vs-sonnet tiering. Using the cheap model for classification costs nothing in capability (it is a three-way label) and saves real tokens — a free win with no downside.

---

## Tech reference (industry pairing)

### model tiering (haiku classifier / sonnet agents)

- **Codebase uses:** `CLASSIFIER_MODEL` haiku (`lib/agents/intent.ts` L14) for routing; `AGENT_MODEL` sonnet (`lib/agents/base.ts` L9) for analysis.
- **Why it's here:** classification is trivial; paying the dear model for it is waste. Cheap model routes, capable model reasons.
- **Leading today:** cost-aware routing (cheap model first, escalate to capable on hard inputs) is standard practice (2026); frameworks like RouteLLM formalize it.
- **Why it leads:** most requests are easy; routing them to a small model captures the majority of the savings.
- **Runner-up:** a single mid-tier model for everything — simpler, leaves savings on the table.

### `res.usage` token logging (the absent meter)

- **Codebase uses:** nothing — `res.usage` is returned at `lib/agents/base.ts` L102 and discarded.
- **Why it's here (absent):** a demo pays no real bill, so the meter was out of scope; the bounds were prioritized.
- **Leading today:** per-call usage logging plus a cost dashboard (Helicone, Langfuse, LangSmith) is table stakes for production LLM apps (2026).
- **Why it leads:** the LLM bill is invisible without it; you cannot tune what you cannot measure.
- **Runner-up:** provider-side usage dashboards — coarser (per-key, not per-run/per-agent), no app-level attribution.

### Anthropic prompt caching (`cache_control`) (also absent)

- **Codebase uses:** nothing — the repeated system prompt + schema summary are sent in full on every turn.
- **Why it's here (absent):** not yet adopted; the truncation levers address input growth from *tool results* but not the repeated *static prefix*.
- **Leading today:** prompt caching is standard for repeated-prefix workloads (2026), cutting input-token cost on cache hits.
- **Why it leads:** an agent loop re-sends the same large system prompt every turn — an ideal cache target.
- **Runner-up:** manual prompt trimming — smaller prefix, less reuse benefit.

---

## Project exercises

### Log `res.usage` per agent run

- **Exercise ID:** B1.2 (adapted) — token-economics instrumentation.
- **What to build:** read `res.usage.input_tokens` / `output_tokens` after every `create` in `runAgentLoop` and both `synthesize()` calls, accumulate per-agent totals on `AgentRunResult`, and stream a final `usage` event so the UI can show the run's token cost.
- **Why it earns its place:** turns a blind-but-bounded system into a measured one — the single highest-value, lowest-cost cost-engineering step.
- **Files to touch:** `lib/agents/base.ts` (`runAgentLoop`, `AgentRunResult`), `lib/agents/diagnostic.ts` / `lib/agents/recommendation.ts` (`synthesize`), `lib/mcp/events.ts` (a `usage` event), `app/api/agent/route.ts`.
- **Done when:** one investigation streams a final usage total, the synthesis spike is visible in the per-agent breakdown when it fires, and the numbers move with `max_tokens` and budget changes.
- **Estimated effort:** 1–4hr

### Persist an `ai_call_log` and report cost percentiles

- **Exercise ID:** B1.8 (adapted) — cost observability over time.
- **What to build:** write a per-run record (per-agent input/output tokens, whether synthesis fired, computed cost from a price table) alongside `saveInvestigation`, and add a small `/debug`-style view reporting p50/p95 tokens-per-investigation and synthesis-fire rate.
- **Why it earns its place:** shows you can answer "what does an investigation cost and how often does the expensive path trigger?" with data, not guesses.
- **Files to touch:** `lib/state/investigations.ts` (extend `saveInvestigation`), a new `lib/state/ai-call-log.ts`, `app/api/agent/route.ts` (write the row), a report under `app/debug/`.
- **Done when:** running several investigations produces queryable per-run cost records and a percentile report, including how often `synthesize()` fired.
- **Estimated effort:** 1–2 days

---

## Summary

Every model call bills by tokens, with output ~5× input, so cost engineering means pulling three bounding levers and reading one meter. blooming insights pulls all three bounds: `maxToolCalls` budgets (6/6/4/6) cap call count via `forceFinal`, `truncate` and `schemaSummary` cap input growth, and a haiku classifier fronts the sonnet agents. The big conditional line item is the `synthesize()` sonnet call. But the meter — `res.usage` logging, an `ai_call_log`, a cost dashboard — is entirely absent: spend is bounded but unmeasured. The bounds prevent a runaway bill; the missing meter hides the typical bill.

**Key points:**
- Cost = Σ (input·p_in + output·p_out), with p_out ≈ 5·p_in over every call in a run.
- `maxToolCalls` caps call count; truncation caps input growth; haiku-vs-sonnet tiering caps per-call model cost.
- The `synthesize()` pass is the big conditional line item — a full sonnet call that fires only on parse failure.
- Nothing reads `res.usage`: the system is bounded but blind, with no record of actual spend.
- Bounding (before the call) and measuring (after the call) are independent; this codebase has the former, not the latter.

---

## Interview defense

### What an interviewer is really asking

"How do you control LLM cost?" tests whether you know the levers (budget, truncation, tiering) *and* whether you separate bounding from measuring. The senior signal is volunteering the gap: "we bound it well but never log `res.usage`, so we can't say what it actually costs" — honesty plus the named fix.

### Likely questions

**[mid] What stops an agent from running up an unbounded token bill?**

`maxToolCalls` (e.g. `6` for diagnostic, `lib/agents/diagnostic.ts` L61). Once `toolCalls.length >= maxToolCalls`, `budgetSpent` flips `forceFinal` (`lib/agents/base.ts` L90–L91), the model loses its tools and must emit its answer — no further turns, no further tokens.

```
6 calls reached → budgetSpent → forceFinal → emit JSON, STOP
```

**[senior] Output tokens cost ~5× input. Which call in an investigation is the expensive one, and how would you confirm it?**

The conditional `synthesize()` pass — a full sonnet call with up to 2048 output tokens and large evidence input (`lib/agents/diagnostic.ts` L87–L126). It only fires when the loop's final turn fails to produce valid JSON. To *confirm* it, you would read `res.usage` per call — which this codebase does not do, so today it is a reasoned guess, not a measurement.

```
loop ok      → no synthesis → cheaper
loop fails   → synthesis spike (2048 out, big in) → ~2× the agent's tokens
confirm: log res.usage  ← absent
```

**[arch] You're asked to cut the LLM bill 30%. First step?**

Build the meter. Read `res.usage` per call and persist a per-run total (`ai_call_log`), because you cannot target what you cannot see. *Then* the data tells you whether to attack the synthesis fire rate (better synthesis prompt), the repeated system prompt (prompt caching), or input size (tighter truncation). Optimizing before measuring is the network-tab-missing mistake.

```
1. log res.usage → find the dominant cost
2. attack THAT (caching / synthesis rate / truncation)
   not a guess
```

### The question candidates always dodge

**"What does one investigation actually cost?"** The honest answer in this codebase: unknown — nothing logs `res.usage`. The spend is *bounded* by the budgets but never *measured*. A candidate who quotes a dollar figure is fabricating; the real answer is to name the absent meter and the one-field fix.

### One-line anchors

- `lib/agents/diagnostic.ts` L61 / `recommendation.ts` L57 — `maxToolCalls` budgets (6 / 4).
- `lib/agents/base.ts` L90–L91 — `budgetSpent`/`forceFinal`, the call-count cap.
- `lib/agents/intent.ts` L14 — haiku classifier; `lib/agents/base.ts` L9 — sonnet agents (tiering).
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize()`, the conditional big line item.
- `res.usage` returned at `base.ts` L102 and discarded — no cost meter exists.

---

## Validate

### Level 1 — Reconstruct

From memory, list the three cost-bounding levers and the one missing meter. State the output-vs-input price asymmetry and which call in an investigation is the conditional spike.

### Level 2 — Explain

Out loud: why does input-token cost grow across turns of a single agent even though each *new* increment is small? How does `truncate` (`lib/agents/base.ts` L31–L34) bound that growth, and why does it bound *cost* only coarsely?

### Level 3 — Apply

Scenario: the LLM bill is 30% over target. Open `lib/agents/base.ts` L102 and explain why you cannot currently say which call is the offender, what single field on the `create` response would tell you, and where you'd accumulate it (`AgentRunResult`, L24–L27).

### Level 4 — Defend

A colleague says: "We have `maxToolCalls`, so cost is handled — skip the usage logging." Argue the difference between *bounded* and *measured*, name what stays invisible without the meter (the synthesis fire rate), and state the event that makes the meter non-optional.

### Quick check — code reference test

Which model classifies intent, and why is it the cheap choice rather than the agent model? (Answer: `claude-haiku-4-5-20251001` — `lib/agents/intent.ts` L14; classification is a trivial three-way label, so it runs on the cheap haiku model while sonnet (`AGENT_MODEL`, `base.ts` L9) does the reasoning.)

---
Updated: 2026-05-28 — `maxDuration` 60→300 (route.ts L20); re-derived the `synthesize()` line ranges (diagnostic L87–L126, recommendation L82–L132) and the `saveInvestigation` location (now `lib/state/investigations.ts` L30, called at route.ts L254).
