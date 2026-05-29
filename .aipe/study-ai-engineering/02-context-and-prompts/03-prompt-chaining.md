# Prompt chaining (one job per step, output feeds the next)

**Industry name(s):** prompt chaining, sequential LLM pipeline, decomposed prompting, fixed-workflow orchestration
**Type:** Industry standard · Language-agnostic

> The morning briefing is a fixed three-step chain — monitoring → diagnostic → recommendation — where each step does one job and its typed output is the next step's input. The investigation half is split across TWO HTTP requests: `/api/agent?step=diagnose` runs the diagnostic agent, the client stashes the resulting `Diagnosis` in sessionStorage (`bi:diag:<id>`), then `/api/agent?step=recommend` runs the recommendation agent with that diagnosis handed back via the `?diagnosis=` param — not a single in-process `await` chain. (The legacy combined-capture run, `step == null`, still sequences both with `await` in one request.) Inside each step a smaller chain runs: the tool-use loop gathers evidence, then a separate `synthesize()` call turns it into JSON.

**See also:** → 01-context-window.md · → 02-lost-in-the-middle.md · → ../04-agents-and-tool-use/01-agents-vs-chains.md · → ../01-llm-foundations/04-structured-outputs.md

---

## Why care

You have written a `.then().then()` pipeline: fetch the user, then fetch their orders with the user id, then fetch shipping for each order. Each step is a separate function with one responsibility, and the output of one is the typed input of the next. If `fetchOrders` throws, you catch it there and the failure is isolated to that link — `fetchUser` already succeeded, `fetchShipping` never ran. A prompt chain is the same shape with language-model calls in the links instead of `fetch`.

The question a multi-step LLM workflow faces: when a task has distinct stages — detect, explain, act — do you hand the whole thing to one model call and hope, or do you split it into separate calls each with one job and a clean handoff?

**The pivot: a chain gives each step a focused prompt, a small tool set, and an isolated failure boundary, so a failure or a weak result in one stage is contained instead of corrupting the whole answer.** One giant prompt that detects, diagnoses, and recommends in a single call has a bloated context, all tools always visible, and no place to validate the intermediate results — and if it goes wrong, the whole answer goes wrong with no seam to catch it. blooming insights splits the briefing into three named steps so each is simple, testable, and bounded, and the route sequences them with `await`.

Before a chain:
- One prompt holds the detection rules, the diagnostic strategy, and the recommendation catalog
- Every tool is visible at every moment; the prompt is large and unfocused
- A failure anywhere fails everything; there is no intermediate output to validate

After a chain:
- `MonitoringAgent.scan` returns a validated `Anomaly[]`; `DiagnosticAgent.investigate` takes one anomaly and returns a `Diagnosis`; `RecommendationAgent.propose` takes the diagnosis and returns `Recommendation[]`
- Each step has its own prompt file, its own tool subset, its own validator
- A failure in one step degrades to a safe default for that step, and the route still emits a coherent stream

It is a `.then().then()` pipeline where each link is a model call with one responsibility.

---

## How it works

**Mental model.** A prompt chain is a fixed sequence of model calls wired by ordinary control flow — `await` within a request, or (in this codebase's live path) the client firing two `step`-gated requests in order — where step N's typed output is step N+1's input. The path is *predetermined*: the code decides the order (detect → diagnose → recommend), not the model. That distinction is the whole difference between a chain and an agent (→ ../04-agents-and-tool-use/01-agents-vs-chains.md): a chain's control flow is yours; an agent's control flow is the model's.

```
fixed chain — the code owns the order
┌──────────────┐   Anomaly   ┌──────────────┐  Diagnosis  ┌──────────────────┐
│ monitoring   │────────────▶│ diagnostic   │────────────▶│ recommendation   │
│ .scan()      │             │ .investigate │             │ .propose()       │
│ → Anomaly[]  │             │ → Diagnosis  │             │ → Recommendation[]│
└──────────────┘             └──────────────┘             └──────────────────┘
   one job: detect              one job: explain             one job: act
   tools: monitoring            tools: diagnostic            tools: recommendation
   each link: focused prompt + small tool set + own validator + isolated failure
```

Each link is independently the simplest possible call: a focused system prompt, a small tool subset, a validator, and a safe fallback. The chain's order is owned by the code — the route's `step` gating plus the client's request sequencing — never by the model.

---

### The briefing chain across two requests (monitoring → diagnostic → recommendation)

The investigation half of the chain is no longer one in-process `await` sequence — it is **split across two HTTP requests** driven by the client, with the `Diagnosis` handed over through sessionStorage. The route reads a `step` param (`'diagnose' | 'recommend' | null`, `app/api/agent/route.ts` L117–L118) and `filterByStep` (L66–L84) keeps only that step's events on the cached-replay path. The live branch runs each step's agent guarded by `step` checks (L224–L249):

```typescript
// STEP 2 (diagnose): run the diagnostic agent; emit the diagnosis event.
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);              // step 3 gets it from ?diagnosis=
  if (!diagnosis) throw new Error('no diagnosis was handed over…');  // L228–229
} else {
  const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
  diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));  // L238
  send({ type: 'diagnosis', diagnosis });                               // L239
}
// STEP 3 (recommend) — skipped on the diagnose step (L244):
if (step !== 'diagnose') {
  const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
  const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation')); // L247
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

The handoff is now *across the wire*, not in a local variable. After step 2 finishes, the `useInvestigation` hook stashes the streamed `Diagnosis` in sessionStorage under `bi:diag:<id>` (`lib/hooks/useInvestigation.ts` L138–L139); when the user opens step 3 (`/investigate/[id]/recommend`), the hook reads it back (L72–L84) and sends it to the route as `&diagnosis=<json>` (L162–L164), where `parseDiagnosis` (route L86–L97) re-validates it before `propose` runs. The order is still fixed and still the *code's* (the model never chooses what runs next) — but the seam between the two links is now an HTTP boundary plus a sessionStorage handoff, so each step is its own request with its own `maxDuration` budget and its own live stream.

```
client-driven two-step chain (the live path)
 ┌─ /api/agent?step=diagnose ──────────┐        ┌─ /api/agent?step=recommend ───────┐
 │  investigate(anomaly) → Diagnosis    │        │  parseDiagnosis(?diagnosis=)       │
 │  send 'diagnosis'                    │        │  propose(anomaly, diagnosis)       │
 └───────────────┬──────────────────────┘        └────────────▲──────────────────────┘
                 │ hook stashes Diagnosis                      │ hook reads bi:diag:<id>
                 ▼  sessionStorage  bi:diag:<id>  ─────────────┘  → &diagnosis=<json>
```

The monitoring step — step 1 — runs in the separate briefing path, `app/api/briefing/route.ts`; `/api/agent` enters at the diagnostic step because the anomaly is already resolved from the insight id. The **legacy combined-capture run** (`step == null`, used by the demo-snapshot capture) still sequences both agents with two `await`s in *one* request (the `else` + `step !== 'diagnose'` branches both fire) and caches the full stream via `saveInvestigation` (L254).

### One job, one prompt, one tool set per step

Each step is a class that loads its own prompt file and selects its own tool subset, so the link is focused and small:

```
step            prompt file                tool subset        validator             budget
─────────────   ────────────────────────   ────────────────   ───────────────────   ──────────────
monitoring      prompts/monitoring.md      monitoringTools    isAnomalyArray        maxToolCalls 6
diagnostic      prompts/diagnostic.md      diagnosticTools    isDiagnosis           maxToolCalls 6
recommendation  prompts/recommendation.md  recommendationTools isRecommendationArray maxToolCalls 4
```

The diagnostic step never sees the recommendation catalog; the recommendation step never sees the detection rules. Each prompt is scoped to its single job, which keeps the context small (→ 01-context-window.md) and the behavior testable in isolation.

### Errors are isolated per link

Each step degrades to a safe default for *that step* rather than failing the chain. `MonitoringAgent.scan` returns `[]` on any parse failure (`lib/agents/monitoring.ts` L95–L101); `DiagnosticAgent.investigate` falls through to `FALLBACK` (`lib/agents/diagnostic.ts` L74–L75); `RecommendationAgent.propose` falls through to `[]` (`lib/agents/recommendation.ts` L69–L73). And the whole route body is wrapped in `try/catch` (`app/api/agent/route.ts` L196–L263) that emits an `error` event and still closes the stream cleanly in `finally`.

```
each link's failure boundary
monitoring  parse fail  → []          (briefing has no anomalies, not a crash)
diagnostic  parse fail  → FALLBACK    (recommendation still runs on a hollow diagnosis)
recommend.  parse fail  → []          (UI shows diagnosis, no actions)
route       any throw   → 'error' event + finally{ controller.close() }
```

A failure at one link does not corrupt the others: a `[]` from monitoring is a clean "nothing to report," a `FALLBACK` diagnosis still flows into recommendation as valid input. The seam between steps is exactly where the failure is caught.

### The micro-chain inside each step (loop → synthesize)

Two of the three steps are *themselves* a small two-link chain. Inside `DiagnosticAgent.investigate` and `RecommendationAgent.propose`, the first link is the tool-use loop (`runAgentLoop`) that gathers evidence, and the second link is a separate `synthesize()` call that turns that evidence into validated JSON. `lib/agents/diagnostic.ts` L74–L75:

```typescript
return (
  tryParseDiagnosis(finalText)                    // loop's own final turn produced JSON?
  ?? (await this.synthesize(anomaly, toolCalls))  // micro-chain: gather → synthesize
  ?? FALLBACK                                      // safe default
);
```

`synthesize()` (`diagnostic.ts` L87–L126) is a distinct `anthropic.messages.create` call — `max_tokens: 2048`, no tools, a clean context built only from the formatted `toolCalls`. It is a separate prompt with one job (evidence → JSON), chained after the gather loop. So the briefing is a chain of steps, and the gather/synthesize split is a chain within a step.

```
inside one step (diagnostic)
runAgentLoop (gather)  ──toolCalls──▶  synthesize() (extract JSON)  ──▶  Diagnosis
   link 1: explore                       link 2: one job, clean context
```

### Current state vs. future state

```
CURRENT (one model, every step)         FUTURE (cheaper model on early steps)
────────────────────────────────       ────────────────────────────────────
AGENT_MODEL = sonnet for all three      monitoring/synthesize on haiku,
  (base.ts L9)                            diagnostic/recommendation on sonnet
no per-step model selection             model chosen per chain link by difficulty
```

The chain *enables* an optimization the codebase has not taken: every step runs on the same `AGENT_MODEL` (`'claude-sonnet-4-6'`, `lib/agents/base.ts` L9). Because each link is a separate call with a known difficulty, the earlier or simpler links (monitoring detection, the `synthesize()` extraction) could run on a cheaper model (haiku, already used for intent classification at `lib/agents/intent.ts` L14) while the reasoning-heavy links stay on sonnet. The seam exists — `runAgentLoop` reads `AGENT_MODEL` from one constant — but the per-step selection is not wired. This is a real, un-taken cost optimization, and it is honest to name it as not done.

### The principle

Decompose a multi-stage task into a fixed sequence of single-job model calls wired by ordinary control flow, with a typed handoff and an isolated failure boundary at each seam. The payoff is the same as any `.then().then()` pipeline: each step is simple, testable, and bounded; failures are contained at the link; and the seams are natural places to validate, log, stream, and later optimize (per-step model choice). Reach for a chain when the path is known in advance — and for an agent only when the model must choose the path (→ ../04-agents-and-tool-use/01-agents-vs-chains.md).

---

## Prompt chaining — diagram

This diagram spans the layers. The Route layer owns the chain order — across two `step`-gated HTTP requests for the live path (the `Diagnosis` handed over via the client's sessionStorage), or a single `await` sequence for the legacy combined-capture run; the Agent layer is the three single-job links, each running its own focused call (and a gather→synthesize micro-chain inside two of them); the Provider boundary is where each link's model call goes out.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts   (owns the order; step-gated)   │
│                                                                       │
│  GET ?step=diagnose  L224–240          GET ?step=recommend  L225–249  │
│     resolve anomaly                       parseDiagnosis(?diagnosis=)  │
│     investigate(anomaly) → Diagnosis      propose(anomaly, diagnosis)  │
│     send 'diagnosis'  L239                send each 'recommendation'   │
│              │ hook stash bi:diag:<id>             ▲ hook → &diagnosis= │
│              └────── sessionStorage handoff ───────┘                   │
│  body wrapped in try/catch → 'error' + finally{ close }   (L196–263)   │
└───────────────┬───────────────────────────────┬───────────────────────┘
                │ one job each                   │
┌───────────────▼───────────────┐ ┌─────────────▼─────────────────────────┐
│  AGENT LAYER (link 2)          │ │  AGENT LAYER (link 3)                  │
│  DiagnosticAgent.investigate   │ │  RecommendationAgent.propose           │
│  prompt: diagnostic.md         │ │  prompt: recommendation.md             │
│  tools: diagnosticTools (6)    │ │  tools: recommendationTools (4)        │
│  validator: isDiagnosis        │ │  validator: isRecommendationArray      │
│  fallback: FALLBACK            │ │  fallback: []                          │
│                                │ │                                        │
│  micro-chain:                  │ │  micro-chain:                          │
│   runAgentLoop (gather)        │ │   runAgentLoop (gather)                │
│      │ toolCalls               │ │      │ toolCalls                       │
│      ▼                         │ │      ▼                                 │
│   synthesize() (→ JSON) L87–126│ │   synthesize() (→ JSON) L82–132        │
└───────────────┬────────────────┘ └─────────────┬──────────────────────────┘
                │ anthropic.messages.create        │  (all on AGENT_MODEL, base.ts L9)
┌───────────────▼───────────────────────────────────▼──────────────────────┐
│  PROVIDER BOUNDARY   Anthropic Messages API                              │
│  every link is a separate call — focused prompt, small tool set          │
└────────────────────────────────────────────────────────────────────────────┘
```

The route owns the order — two `step`-gated requests live, one `await` sequence for capture; each agent is one focused link with its own prompt, tools, validator, and fallback; two links contain a gather→synthesize micro-chain. All links currently share one model — the seam for per-step model choice is open but unused.

---

## In this codebase

### Files, functions, and line ranges

- **The chain orchestration (two-step split):** `app/api/agent/route.ts` reads the `step` param (L117–L118), runs the diagnostic agent on `step !== 'recommend'` (`await diagAgent.investigate(...)` at L238, `send 'diagnosis'` at L239) and the recommendation agent on `step !== 'diagnose'` (`await recAgent.propose(inv, diagnosis!, ...)` at L247). On `step === 'recommend'` the diagnosis comes from the `?diagnosis=` param via `parseDiagnosis` (L227, parser L86–L97). The client (`lib/hooks/useInvestigation.ts`) drives the order: stash `bi:diag:<id>` after step 2 (L138–L139), read + forward it as `&diagnosis=` on step 3 (L72–L84, L162–L164). The combined-capture run (`step == null`) runs both `await`s in one request and caches via `saveInvestigation` (L254). `filterByStep` (L66–L84) keeps one step's events on cached replay. The whole stream body is wrapped in `try/catch` at L196–L263 (`finally { controller.close() }` at L261–L262).
- **Link 1 (detect):** `MonitoringAgent.scan` — `lib/agents/monitoring.ts` L68–L103; prompt `lib/agents/prompts/monitoring.md`; tools `monitoringTools`; validator `isAnomalyArray`; `maxToolCalls: 6` (L84); degrades to `[]` (L95–L101). Runs in the briefing path `app/api/briefing/route.ts`.
- **Link 2 (explain):** `DiagnosticAgent.investigate` — `lib/agents/diagnostic.ts` L45–L83; prompt `prompts/diagnostic.md`; tools `diagnosticTools`; validator `isDiagnosis`; `maxToolCalls: 6` (L62); fallback chain `tryParseDiagnosis ?? synthesize ?? FALLBACK` (L74–L75); confidence post-derived at L80–L82.
- **Link 3 (act):** `RecommendationAgent.propose` — `lib/agents/recommendation.ts` L36–L77; prompt `prompts/recommendation.md`; tools `recommendationTools`; validator `isRecommendationArray`; `maxToolCalls: 4` (L57); fallback chain `tryParseRecommendations ?? synthesize ?? []` (L69–L73); ids assigned and capped at 3 (L76).
- **The gather→synthesize micro-chain:** `synthesize()` at `lib/agents/diagnostic.ts` L87–L126 and `lib/agents/recommendation.ts` L82–L132 — separate tool-less `anthropic.messages.create` calls (`max_tokens: 2048`) chained after the gather loop in `runAgentLoop` (`lib/agents/base.ts` L48–L176).
- **The un-taken model optimization:** every link reads `AGENT_MODEL = 'claude-sonnet-4-6'` from `lib/agents/base.ts` L9; the cheaper-model-on-early-steps optimization is not wired (haiku is used only for intent at `lib/agents/intent.ts` L14).

---

## Elaborate

### Where this pattern comes from

Prompt chaining is the LLM specialization of a decades-old idea: pipeline decomposition. A complex transformation is split into a sequence of simple stages, each with one responsibility, where the output of one is the input of the next — Unix pipes, ETL stages, middleware chains, promise chains. Anthropic's "Building effective agents" (2024) names *prompt chaining* as the first and simplest agentic workflow pattern: decompose a task into fixed steps, optionally gate between them, and only graduate to an autonomous agent when the path cannot be fixed in advance.

The reason it is the default starting point is the same reason you split a god-function into small functions: smaller units are easier to prompt, test, validate, and reason about than one monolith.

### The deeper principle

```
chain (fixed path)                    agent (model-chosen path)
────────────────────────────────     ────────────────────────────────
code decides the order                model decides what runs next
detect → diagnose → recommend         "figure out what to do"
each step: one prompt, small tools    one loop, all tools, dynamic
errors isolated per link              errors recovered in-loop
predictable cost & latency            variable cost & latency
```

The chain trades flexibility for predictability and isolation. When the stages are known — and a morning briefing always detects, then explains, then acts — the fixed path is strictly better: it is cheaper to reason about, easier to test, and the seams are where validation and streaming live. blooming insights uses a chain at the top level (the briefing) and an agent loop *inside* each link (the tool-use loop), which is the standard hybrid: chain the known stages, give each stage a bounded agent for the part where the model must choose its queries (→ ../04-agents-and-tool-use/01-agents-vs-chains.md).

### Where this breaks down

1. **Sequential `await` cannot branch or parallelize.** The chain is a straight line. A workflow that needs "if diagnosis confidence is low, re-investigate with a different tool set; if high, skip a step" cannot be expressed in `if/await/if/await` without the route becoming a hand-rolled state machine. That is the point to reach for a graph runner (LangGraph).

2. **Latency compounds per link.** Each step is up to `maxToolCalls` round-trips plus a possible `synthesize()` call. The two-step split now gives *each* step its own `maxDuration = 300` route budget (`app/api/agent/route.ts` L20), so diagnose and recommend no longer share one timeout — but within a step the loop + `synthesize()` still compound. Adding a fourth sequential link inside one step is risky without trimming per-link budgets.

3. **One weak link sets the floor.** A `FALLBACK` diagnosis (`lib/agents/diagnostic.ts` L16–L20) is valid input to `propose`, so the chain keeps running — but it runs on hollow evidence and produces hollow recommendations. Error isolation prevents a crash; it does not guarantee a *good* result when an upstream link degrades.

### What to explore next

- **Per-step model selection:** route the simpler links (monitoring, `synthesize()`) to haiku and the reasoning-heavy links to sonnet — the un-taken cost optimization the chain already enables.
- **Gating between links:** add a check on `diagnosis.confidence` between investigate and propose to skip or re-run a step (Anthropic's "gated chain" pattern).
- **LangGraph / a graph runner:** when the path needs branching, cycles, or parallel links, replace the route's `await` sequence with a typed graph (→ ../04-agents-and-tool-use/01-agents-vs-chains.md).

---

## Tradeoffs

### Fixed prompt chain vs. one mega-prompt

| Dimension | This codebase (3-step chain) | One mega-prompt (detect+diagnose+recommend) |
|---|---|---|
| Prompt size per call | Small — one job each | Large — all rules, all catalogs at once |
| Tool surface per call | Subset (6/6/4) | All tools always visible |
| Failure isolation | Per link; degrades to a safe default | One failure corrupts the whole answer |
| Intermediate validation | `isDiagnosis` between steps; `diagnosis` event streamed | None — no intermediate to validate or stream |
| Latency | Compounds per link (3 sequential calls) | One call, but unbounded internal looping |
| Per-step optimization | Possible (cheaper model per link) | Impossible — one call, one model |

**What we gave up.** Latency and a small amount of token overhead. Three sequential links means three round-trips minimum, plus a possible `synthesize()` call per link — more wall-clock and more total tokens than one call. And the typed handoff means the intermediate `Diagnosis` is serialized and re-read by the next step — now literally *across the wire* (sessionStorage → `?diagnosis=` param) on the two-step live path, not just in a local variable. For a per-step 300-second budget those costs are real but affordable.

**What the alternative would have cost.** A single mega-prompt holding detection rules, diagnostic strategy, and the recommendation catalog would be large, would expose every tool at every moment (inviting the model to call the wrong one), and would have no seam to validate the intermediate diagnosis or to stream a `diagnosis` event before recommendations exist. A failure mid-prompt would yield a tangled partial answer with no clean fallback per stage.

**The breakpoint.** The sequential `await` chain is correct for a fixed 3-step path. It breaks when the workflow needs to branch on an intermediate result (low-confidence diagnosis → re-investigate) or to run links in parallel (two diagnostic hypotheses at once). At that point the route's `if/await` becomes a hand-rolled state machine and should be replaced with a graph runner. That event — branching or parallel links — is the trigger to graduate from a chain to a graph.

**Not actually a tradeoff:** splitting gather from `synthesize()` inside a link. The micro-chain costs one extra call only when the loop's final turn fails to produce JSON; on the happy path it costs nothing, and it buys a clean-context extraction that is far more reliable than parsing the loop's tangled final turn.

---

## Tech reference (industry pairing)

### prompt chaining (sequential LLM pipeline)

- **Codebase uses:** `step`-gated sequencing in the route (`app/api/agent/route.ts` L224–L249) across two client-driven requests for the live path — diagnostic then recommendation, the typed `diagnosis` handed between them via sessionStorage (`bi:diag:<id>`) → `?diagnosis=`; a single `await` sequence for the combined-capture run. No framework.
- **Why it's here:** the briefing's stages are fixed (detect → explain → act), so a hand-wired chain is simpler and more transparent than any orchestration library.
- **Leading today:** for fixed workflows, plain code (`await` / promise chains) leads adoption (2026); Anthropic's "Building effective agents" explicitly recommends starting with code-wired chains before reaching for a framework.
- **Why it leads:** a fixed path needs no graph engine; ordinary control flow is the most debuggable, lowest-overhead way to express it.
- **Runner-up:** LangChain LCEL (`|` pipe composition) — a declarative chain DSL when you want composability without a full graph.

### graph orchestration (when the chain must branch)

- **Codebase uses:** nothing — the chain is a straight `await` line with no branching.
- **Why it's here (absent):** the briefing path is fixed; there is no conditional or parallel step, so a graph engine would be overhead.
- **Leading today:** LangGraph leads adoption (2026) for branching, cyclic, and parallel agent/chain orchestration with typed state and checkpoints.
- **Why it leads:** it expresses conditional edges and parallel nodes that sequential `await` cannot, with state flowing through a typed schema.
- **Runner-up:** Anthropic Agent SDK / OpenAI Swarm — higher-level agent orchestration with built-in loops and handoffs.

### per-step model selection (the un-taken optimization)

- **Codebase uses:** one model for all links — `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9); haiku is used only for intent (`lib/agents/intent.ts` L14).
- **Why it's here (not wired):** the chain enables per-link model choice, but every link reads the same constant; routing simpler links to a cheaper model is deferred.
- **Leading today:** model tiering / model routing (cheap model for easy steps, strong model for hard steps) leads adoption (2026) as the first cost lever in multi-step pipelines.
- **Why it leads:** earlier/simpler links in a chain are often easy enough for a cheaper, faster model, cutting cost and latency with no quality loss on those steps.
- **Runner-up:** a learned router that picks the model per request by predicted difficulty (RouteLLM-style).

---

## Project exercises

### Route simpler chain links to a cheaper model

- **Exercise ID:** B1.8 (adapted) — per-step model tiering across the chain.
- **What to build:** thread a `model` option through `runAgentLoop` (defaulting to `AGENT_MODEL`) and the `synthesize()` calls, then set the monitoring step and both `synthesize()` extractions to haiku (`'claude-haiku-4-5-20251001'`, already used at `lib/agents/intent.ts` L14) while diagnostic and recommendation reasoning stay on sonnet.
- **Why it earns its place:** demonstrates you understand a chain's seams are where per-step cost optimization lives, and that you can pick the cheapest model that clears each link's difficulty bar.
- **Files to touch:** `lib/agents/base.ts` (`runAgentLoop` model option), `lib/agents/monitoring.ts`, `lib/agents/diagnostic.ts` (`synthesize`), `lib/agents/recommendation.ts` (`synthesize`).
- **Done when:** the monitoring scan and both synthesis calls run on haiku, the reasoning steps run on sonnet, and the full briefing still produces valid `Anomaly[]` / `Diagnosis` / `Recommendation[]`.
- **Estimated effort:** 1–4hr

### Add a confidence gate between diagnostic and recommendation

- **Exercise ID:** C1.10 (adapted) — gated chain link.
- **What to build:** in the route, between `investigate` and `propose`, branch on `diagnosis.confidence` (or a derived signal from the `Diagnosis` shape): if the diagnosis is the `FALLBACK` / low-confidence shape, skip `propose` and emit a "no actionable recommendations — diagnosis inconclusive" step instead of running the recommendation link on hollow input.
- **Why it earns its place:** shows you understand error isolation alone does not guarantee a good result, and that a gate between links prevents a weak upstream result from wasting a downstream call.
- **Files to touch:** `app/api/agent/route.ts` (the step-3 branch at L244–L249, where the handed-over diagnosis is already parsed at L227), `lib/mcp/types.ts` (`Diagnosis.confidence` already exists at L71 — derived by `diagnosisConfidence`, `lib/insights/derive.ts` L54–L63).
- **Done when:** a `FALLBACK` diagnosis short-circuits the recommendation link and the stream emits a clear inconclusive message instead of an empty `Recommendation[]`.
- **Estimated effort:** 1–4hr

---

## Summary

The morning briefing is a fixed three-step prompt chain — monitoring detects, diagnostic explains, recommendation acts — where each step does one job with its own prompt, tool subset, and validator, and its typed output is the next step's input. The investigation half is split across two `step`-gated HTTP requests (`app/api/agent/route.ts` L224–L249): `?step=diagnose` produces the `Diagnosis`, the client stashes it in sessionStorage (`bi:diag:<id>`), and `?step=recommend` runs `propose` with that diagnosis handed back via `?diagnosis=`. The whole stream body is wrapped in `try/catch` so a failure at one link degrades to a safe default (`[]`, `FALLBACK`, `[]`) instead of crashing. Inside two of the links runs a micro-chain: the tool-use loop gathers evidence, then a separate `synthesize()` call turns it into validated JSON. Every link currently runs on one model — the per-step model optimization the chain enables is real and un-taken.

**Key points:**
- A chain is a fixed sequence of single-job model calls — wired by `await` for the combined-capture run, or by two client-driven `step`-gated requests for the live path; the code owns the order, not the model.
- Each link has a focused prompt, a small tool set, a validator, and an isolated failure boundary.
- The handoff is typed — `diagnosis` flows from `?step=diagnose` into `?step=recommend` via sessionStorage `bi:diag:<id>` → `?diagnosis=` (route.ts L227, L238–L247).
- Two links contain a gather→synthesize micro-chain (loop → `synthesize()`).
- The chain enables per-step model tiering, which the codebase has not wired — all links use `AGENT_MODEL` (base.ts L9).

---

## Interview defense

### What an interviewer is really asking

"Why a chain instead of one big prompt — or instead of an agent?" tests whether you can decompose a task into single-job steps, whether you know a chain's control flow is yours while an agent's is the model's, and whether you can name what the seams between steps buy you (validation, streaming, isolation, per-step optimization). The senior signal is the hybrid: a chain at the top, a bounded agent inside each link.

### Likely questions

**[mid] What are the steps of the briefing chain and how is the order decided?**

Monitoring (detect) → diagnostic (explain) → recommendation (act). The order is decided by code, not the model. On the live path the investigation half is two `step`-gated requests (`app/api/agent/route.ts` L224–L249): `?step=diagnose` produces the `Diagnosis`, the client stashes it (`bi:diag:<id>`) and hands it to `?step=recommend` via `?diagnosis=`. (The combined-capture run does both `await`s in one request.)

```
?step=diagnose → Diagnosis ──[sessionStorage bi:diag:<id> → ?diagnosis=]──▶ ?step=recommend → propose
   code owns the arrow; the model never picks the next step
```

**[senior] Why split each step's gather from its synthesize into a micro-chain?**

The gather loop (`runAgentLoop`) accumulates a long, tangled context — tool_use/tool_result pairs, partial reasoning. Parsing JSON out of its final turn is unreliable. So when the final turn fails, a separate `synthesize()` call (`lib/agents/diagnostic.ts` L87–L126) runs with a clean context built only from the formatted evidence and one job: emit JSON. It is a chain within a step — gather, then extract — and the extract link has a focused prompt and no tools.

```
runAgentLoop (gather, long context) ──toolCalls──▶ synthesize (extract, clean context) → JSON
```

**[arch] When would you replace this chain with a graph, and what does it cost you today?**

When the workflow needs to branch on an intermediate result or run links in parallel — e.g. skip recommendation if the diagnosis is low-confidence, or run two diagnostic hypotheses at once. The current step-gating (`if (step === …)`) is a coarse two-way split, not a graph; expressing conditional or parallel edges would turn the route + client handoff into a hand-rolled state machine. Today each step gets its own `maxDuration = 300` budget (route.ts L20), so the timeout pressure is lower than a single combined request — but per-step model selection still isn't wired and adding real branching is the trigger to reach for a graph runner.

```
fixed path → await chain (now)      branching/parallel → graph runner (later)
```

### The question candidates always dodge

**"You run every step on the same expensive model — why?"** The honest answer is that the chain *enables* per-step model tiering but the codebase has not wired it: every link reads `AGENT_MODEL` (`lib/agents/base.ts` L9), and haiku is used only for intent classification (`lib/agents/intent.ts` L14). A candidate who claims it is already optimized is wrong; the strong answer names the un-taken optimization and where it would go (the exercise above).

### One-line anchors

- `app/api/agent/route.ts` L224–L249 — the step-gated diagnostic→recommendation chain; `step` param at L117–L118, diagnosis re-parsed at L227.
- `lib/hooks/useInvestigation.ts` L138–L139, L162–L164 — the `bi:diag:<id>` sessionStorage handoff between the two steps.
- `lib/agents/diagnostic.ts` L74–L75 — the gather→synthesize→FALLBACK micro-chain inside a link.
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize()`, the clean-context extract link.
- `lib/agents/base.ts` L9 — `AGENT_MODEL`, the single constant that makes per-step model tiering un-wired.
- A chain's order is the code's; an agent's order is the model's (→ ../04-agents-and-tool-use/01-agents-vs-chains.md).

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three-link briefing chain. For each link, name its one job, its tool subset, its validator, and its safe fallback. Mark which two links contain a gather→synthesize micro-chain and what the input and output type of each link is.

### Level 2 — Explain

Out loud: explain the difference between a chain (this codebase's briefing) and an agent (the loop inside each link). Who decides the order in each case? Then explain why the `diagnosis` is serialized and re-read by `propose` rather than living in one shared context.

### Level 3 — Apply

Scenario: the diagnostic link returns the `FALLBACK` diagnosis but the recommendation link still runs. Check `app/api/agent/route.ts` L244–L249 (and the diagnosis parsed at L227) — is there a gate on `diagnosis.confidence` between the two links? What does `propose` produce when handed a hollow `FALLBACK` diagnosis, and where would you add a confidence check so a weak upstream result stops wasting the downstream call?

### Level 4 — Defend

A reviewer says: "Collapse the three agents into one prompt that detects, diagnoses, and recommends — it'll be faster and simpler." Respond using this codebase: name what you lose in failure isolation (cite the three fallbacks), in intermediate streaming (the `diagnosis` event at route.ts L239), in per-step budgeting (each `step` is its own `maxDuration = 300` request), and in per-step model selection (`AGENT_MODEL` at base.ts L9). Then name the one thing the reviewer is right about.

### Quick check — code reference test

Which two `await` calls in `app/api/agent/route.ts` run the investigation chain's two links, and how does the `Diagnosis` get from the first to the second on the live path? (Answer: `await diagAgent.investigate(inv, …)` (L238) then `await recAgent.propose(inv, diagnosis!, …)` (L247); on the live path they run in *separate* `step`-gated requests, so the `Diagnosis` is handed over via the client's sessionStorage `bi:diag:<id>` → `?diagnosis=` param (re-parsed at L227), not a shared local variable.)

---
Updated: 2026-05-28 — Rewrote the chain orchestration as the two-step `?step=diagnose`/`?step=recommend` split with the `bi:diag:<id>` sessionStorage handoff (was a single in-process `await` chain); `maxDuration` 60→300; re-derived all route.ts/diagnostic.ts/recommendation.ts/monitoring.ts/useInvestigation.ts line refs.
