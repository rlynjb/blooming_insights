# Token economics (the cost controls present, the cost meter absent)

**Industry name(s):** token economics, LLM cost engineering, model-tiering / cost-aware routing
**Type:** Industry standard · Language-agnostic

> Every model call costs money proportional to tokens, with output tokens ~5× the price of input; blooming insights controls cost with hard tool-call budgets, character truncation, and a cheap haiku classifier in front of expensive sonnet agents — but it has *no* cost meter: nothing logs `res.usage`, so the spend is bounded but unmeasured.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Token economics is not in one band — it is the *shape of decisions* made across several. The bounds live in the Per-agent definitions (`maxToolCalls` budgets) and the Agent loop (`budgetSpent`/`forceFinal` in `lib/agents/base.ts` L90–L91, `truncate` at L31–L34); model tiering picks haiku for intent (`lib/agents/intent.ts` L14) vs sonnet for analysis (`lib/agents/base.ts` L9); and the Provider returns `res.usage` on every response — the one piece of cost data that nothing in this codebase ever reads.

```
  Zoom out — where cost levers live (and the missing meter)

  ┌─ Intent parsing + Pipeline ─────────────────────┐
  │  HAIKU classifier   intent.ts L14  ← tier lever │
  └─────────────────────────┬───────────────────────┘
                            │
  ┌─ Per-agent + Agent loop ▼───────────────────────┐  ← we are here
  │  maxToolCalls budgets (6/6/4/6)                 │
  │  budgetSpent → forceFinal   base.ts L90–91      │
  │  truncate (16_000 chars)    base.ts L31–34      │
  │  synthesize() spike (conditional)               │
  └─────────────────────────┬───────────────────────┘
                            │  create(params)
  ┌─ Provider ──────────────▼───────────────────────┐
  │  SONNET ($)   cost = in·p_in + out·(5·p_in)     │
  │  res.usage = { input_tokens, output_tokens }    │
  │                      ★ NEVER READ ★             │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is two parts: how do you *bound* cost so a runaway loop cannot rack up an unbounded bill, and how do you *measure* it so you know which call dominates? blooming insights answers the first with three levers (budgets, truncation, tiering) and answers the second not at all. How it works walks each lever, names the conditional `synthesize()` spike as the likely line item, and points at the one-field fix (`res.usage`) the codebase never makes.

---

## Structure pass

**Layers.** Four layers, each home to a cost lever or its absence: the intent classifier (tier lever — haiku vs sonnet), the per-agent definitions (call-count budgets `maxToolCalls`), the agent loop (input truncation via `truncate`, output bound via `max_tokens`), and the provider response (`res.usage` returning exact input/output token counts — never read).

**Axis: cost.** What does each layer contribute to the per-run bill, and is there a meter on it? This is the right axis because the file's whole frame is "three dials are present, the gauge is absent" — the layers cleanly partition into "bound" (turns the dial) and "measure" (reads the gauge), and only the cost lens makes that distinction visible. Control would flatten it (every layer is CODE-decided); failure would mis-frame (cost overrun is the failure, not the mechanism).

**Seams.** The cosmetic seam is between the per-agent definitions and the agent loop — both are *bounding* layers, just with different primitives. The load-bearing seam is between the agent loop (where the call is made) and the provider response (where `res.usage` comes back). Cost-knowledge flips here from "estimated by characters and call count" to "exactly known per call" — but the codebase doesn't cross it. The unread `res.usage` field *is* the missing meter; the load-bearing seam is open on both sides because nothing connects them.

```
  Structure pass — token economics

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  intent classifier (tier lever)                │
  │  per-agent definitions (call-count budgets)    │
  │  agent loop (truncate + max_tokens)            │
  │  provider response (res.usage — never read)    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: what does each layer contribute to the  │
  │  bill, and is there a meter on it?             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  per-agent↔loop: cosmetic (both bound)         │
  │  loop↔res.usage: LOAD-BEARING                  │
  │    "estimated by chars" → "exactly known"      │
  │    but this codebase NEVER crosses it          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

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

### Lever 1 — call-count budgets

Each agent caps total tool calls, which caps the number of agent-turn model calls (each tool round-trip is a model call). The budgets:

```
agent           maxToolCalls   why
──────────────  ────────────   ────────────────────────────────────
monitoring          6          bound scan latency under 1 req/s MCP limit
diagnostic          6          bound investigation depth
recommendation      4          fewer queries needed to propose actions
query               6          free-form, broad tool access
```

A `budgetSpent` check flips `forceFinal` once the count of tool calls hits the agent's budget, forcing the model to stop querying and emit its answer. Without this, the loop runs until `maxTurns` (8) or the route's `maxDuration` of 300s — burning tokens on every wasted turn. The budget is the primary defense against a runaway bill.

```
turn 0  2 calls
turn 1  4 calls            (diagnostic, budget 6)
turn 2  6 calls → budgetSpent → forceFinal → emit JSON, STOP
                                             no turn 3+ → no extra tokens
```

---

### Lever 2 — input truncation

Output tokens cost ~5×, but *input* tokens accumulate fast in a multi-turn loop because every prior tool result rides along in `messages` on every subsequent call. Truncation caps that growth: the agent loop slices each tool result to a 16,000-character ceiling, and the monitoring agent caps the static schema prefix via list-count caps. See → 02-tokenization.md for the full character-budget story.

```
without truncation:           with truncation:
turn 0: schema + 60KB result  turn 0: schema + 16KB result
turn 1: + 60KB result         turn 1: + 16KB result
turn 2: + 60KB result         turn 2: + 16KB result
input grows ~60KB/turn        input grows ~16KB/turn  ← ~3.75× cheaper input
```

---

### Lever 3 — model tiering (cheap classifier vs dear agents)

The cheapest routing decision: do not pay the expensive model to do a trivial job. Intent classification — mapping a query to one of three labels — uses a cheap-tier model (the haiku-class classifier), while the actual analysis uses a more capable model (the sonnet-class agent):

```
classify intent   → cheap tier   (fast)             max_tokens 16
analyze / diagnose → dear tier    (capable, costly)  max_tokens 4096
```

A classifier call capped at `max_tokens: 16` (→ 03-sampling-parameters.md) costs a tiny fraction of an agent turn. Putting the cheap model on the routing decision and the expensive model on the reasoning is textbook cost-aware tiering.

---

### Where the big line item is, and the meter that would show it

The single most expensive call in an investigation is the **synthesis pass** when it runs. The `synthesize()` call is a *full dear-tier call* with `max_tokens: 2048` of output, and it formats up to six tool results as evidence text in its input — large input, large output, on the dear model. It only fires when the loop's final turn fails to produce valid JSON (→ 04-structured-outputs.md), so its cost is conditional: zero on the happy path, ~2× the agent's tokens on the unlucky path.

```
investigation token cost (dear tier)
  diagnostic loop   : up to 6 turns × growing input + 4096 output
  synthesis (maybe) : large evidence input + 2048 output   ← the spike
  recommendation    : up to 4 turns × input + 4096 output
  + synthesis (maybe): another spike
```

The meter to see this is the response's `usage` field — the provider SDK returns `input_tokens` and `output_tokens` on every response. **Nothing in the codebase reads it.** There is no per-call log, no per-run token total, no cost dashboard. The spend is *bounded* (the three levers guarantee a worst case) but *unmeasured* (no one knows the typical case, or which call dominates it).

---

### Current state vs. future state

```
CURRENT (bounded, blind)              FUTURE (bounded, metered)
────────────────────────────────     ────────────────────────────────
maxToolCalls caps worst case          + usage logged per call
truncation caps input growth          + per-agent token totals
cheap-tier classification             + cost = tokens × price table
NO record of actual spend             + per-run cost log row
"which call is expensive?" = guess    "which call is expensive?" = query
```

The bounds make a runaway bill *impossible*; the missing meter makes the *typical* bill *invisible*. You cannot tune what you cannot see — the first optimization after shipping is the meter, not another bound.

---

### The principle

Cost engineering is two disciplines: bound the worst case before the call (budgets, truncation, tiering) and measure the typical case after the call (usage logging). This system does the first thoroughly — a runaway loop cannot happen — and skips the second entirely, so it has guarantees without observability. That is a fine posture for a bounded demo and a liability the moment you need to tune cost against real traffic, because the meter is the prerequisite for every targeted optimization.

---

### Code in this codebase

**Partially addressed — bounds present, meter absent.** Cost is controlled by `maxToolCalls` budgets, input truncation, and haiku-vs-sonnet tiering, but nothing reads `res.usage`; there is no `ai_call_log`, per-run token total, or cost dashboard.

#### Files, functions, and line ranges

- **Call-count budgets (`maxToolCalls`):** monitoring `6` (`lib/agents/monitoring.ts` L74), diagnostic `6` (`lib/agents/diagnostic.ts` L61), recommendation `4` (`lib/agents/recommendation.ts` L57), query `6` (`lib/agents/query.ts` L41); enforced via `budgetSpent`/`forceFinal` at `lib/agents/base.ts` L90–L91.
- **Input truncation:** `MAX_TOOL_RESULT_CHARS = 16_000` / `truncate` — `lib/agents/base.ts` L29, L31–L34; `schemaSummary` caps — `lib/agents/monitoring.ts` L15–L48.
- **Model tiering:** `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` — `lib/agents/intent.ts` L14; `AGENT_MODEL = 'claude-sonnet-4-6'` — `lib/agents/base.ts` L9.
- **The big line item:** `synthesize()` sonnet calls — `lib/agents/diagnostic.ts` L87–L126 (`max_tokens: 2048` at L99), `lib/agents/recommendation.ts` L82–L132 (L98).
- **The absent meter:** no read of `res.usage` anywhere; the model call at `lib/agents/base.ts` L102 returns it and discards it.

#### Where the meter would live

A token-accounting field would accumulate on `AgentRunResult` (`lib/agents/base.ts` L24–L27), populated by reading `res.usage` after `create` (L102) and after each `synthesize()` call. The route (`app/api/agent/route.ts`) would sum per-agent totals and either stream a final `usage` event or write an `ai_call_log` row alongside `saveInvestigation` (called at `app/api/agent/route.ts` L254; the store is `lib/state/investigations.ts` L30).

---

## Token economics — diagram

This diagram spans the call path and marks where each cost lever acts and where the missing meter would sit. Service-layer dials bound the spend; the Provider response carries the usage the codebase never reads.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (cost levers — all on the bounding side)              │
│                                                                       │
│  classifyIntent → HAIKU  intent.ts   ← tier: cheap model         │
│       │                                                              │
│  runAgentLoop (SONNET base.ts L9)                                    │
│   maxToolCalls budget  monitoring 6 / diag 6 / rec 4 / query 6       │
│       │  budgetSpent → forceFinal  base.ts   ← fewer calls    │
│   truncate tool result → 16_000 chars  base.ts  ← smaller in  │
│   schemaSummary caps   monitoring.ts            ← smaller in  │
│       │                                                              │
│   synthesize() (conditional)  diagnostic out  ← spike  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  create(params)  base.ts
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

## See also

→ 02-tokenization.md · → 03-sampling-parameters.md · → 07-heuristic-before-llm.md · → 08-provider-abstraction.md

---
