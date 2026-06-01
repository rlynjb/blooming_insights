# Prompt chaining (one job per step, output feeds the next)

**Industry name(s):** prompt chaining, sequential LLM pipeline, decomposed prompting, fixed-workflow orchestration
**Type:** Industry standard · Language-agnostic

> The morning briefing is a fixed three-step chain — monitoring → diagnostic → recommendation — where each step does one job and its typed output is the next step's input. The investigation half is split across TWO HTTP requests: `/api/agent?step=diagnose` runs the diagnostic agent, the client stashes the resulting `Diagnosis` in sessionStorage (`bi:diag:<id>`), then `/api/agent?step=recommend` runs the recommendation agent with that diagnosis handed back via the `?diagnosis=` param — not a single in-process `await` chain. (The legacy combined-capture run, `step == null`, still sequences both with `await` in one request.) Inside each step a smaller chain runs: the tool-use loop gathers evidence, then a separate `synthesize()` call turns it into JSON.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Prompt chaining is the shape of the *whole request flow*: the Pipeline coordinator (the Route + client) owns the order, and each link is a separate Per-agent invocation running its own focused model call. The chain spans Route → Per-agent → Agent loop → Provider, and the seams between links are HTTP requests (for the live diagnose→recommend split, with the `Diagnosis` handed over via sessionStorage `bi:diag:<id>`) or `await` calls (for the legacy combined-capture run).

```
  Zoom out — where the chain sits

  ┌─ Route + client (own the order) ─────────────────┐  ← we are here
  │  ?step=diagnose  ──[bi:diag:<id> handoff]──▶     │
  │                                ?step=recommend    │
  │  app/api/agent/route.ts L224–249                  │
  └─────────────────────────┬────────────────────────┘
                            │ one job per link
  ┌─ Per-agent (each link is its own focused call) ──┐
  │  ★ link 1: MonitoringAgent.scan      (briefing)   │
  │  ★ link 2: DiagnosticAgent.investigate ★          │
  │  ★ link 3: RecommendationAgent.propose ★          │
  │   each: own prompt + tool subset + validator     │
  │   each: gather→synthesize micro-chain inside    │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider ──────────────▼────────────────────────┐
  │  every link → its own anthropic.messages.create  │
  │  (all on AGENT_MODEL — per-step tiering not wired)│
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when a task has distinct stages — detect, explain, act — do you hand the whole thing to one model call and hope, or split it into separate calls each with one job and a clean handoff? A chain wins on focus (each prompt is small), isolation (each link has its own fallback), and observability (each seam is a streaming/validation point). How it works walks the briefing chain, the gather→synthesize micro-chain inside each link, and the un-taken per-step model optimization the chain already enables.

---

## Structure pass

**Layers.** Four layers form the chain: the route + client (own the order between links — via `await` for legacy combined-capture or via the `step`-gated HTTP handoff for the live diagnose→recommend split), each per-agent invocation (one link's focused model call with its own prompt + tool subset + validator), the agent loop inside each link (gather→synthesize micro-chain), and the provider call that fires per link.

**Axis: control.** Who decides the next step at each layer — CODE (the route/client/agent runs a fixed sequence) or MODEL (the agent loop picks tools within its stage)? This axis is the right lens because prompt chaining IS a control-structure decision: the chain says "CODE owns the order between links." That's what makes it a chain and not an agent. State is downstream (state flows from link to link), but the load-bearing question is whose control decides the next step.

**Seams.** The cosmetic seam is between the provider call and the agent loop inside one link — both are part of one link's execution. The load-bearing seam is between the per-agent invocations (link N → link N+1): control flips here from "MODEL was deciding what to do within link N" to "CODE is deciding what link comes next." This is the chain's defining seam — the moment when the model's autonomy ends and the route/client's hard-coded order picks up. A second load-bearing variant: in the live path this same seam is *also* an HTTP boundary (sessionStorage `bi:diag:<id>` handoff), which means failure-containment also flips across it.

```
  Structure pass — prompt chaining

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  route + client (own the order)                │
  │  per-agent invocations (one link each)         │
  │  agent loop (gather→synthesize micro-chain)    │
  │  provider call (per-link create)               │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: CODE owns order between links;       │
  │  MODEL owns step choice within a link          │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  provider↔agent loop: cosmetic                 │
  │  link N↔link N+1: LOAD-BEARING                 │
  │    MODEL control → CODE control                │
  │    (live path: also an HTTP boundary)          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "who picks the next step?" answered two ways

  ┌─ inside link ──┐  seam   ┌─ between links ─┐
  │ MODEL          │ ══╪═══► │ CODE            │
  │ (picks tool)   │  flips  │ (fixed order)   │
  └────────────────┘         └─────────────────┘
         ▲                              ▲
         └────── same axis, two answers ─┘
                 → this is what defines a chain
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

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

Each link is independently the simplest possible call: a focused system prompt, a small tool subset, a validator, and a safe fallback. The chain's order is owned by the code — the route's step gating plus the client's request sequencing — never by the model.

---

### The briefing chain across two requests (monitoring → diagnostic → recommendation)

The investigation half of the chain is no longer one in-process `await` sequence — it is **split across two HTTP requests** driven by the client, with the `Diagnosis` handed over through sessionStorage. The route reads a `step` param (`'diagnose' | 'recommend' | null`) and a step-filter helper keeps only that step's events on the cached-replay path. The live branch runs each step's agent guarded by `step` checks:

```
  # STEP 2 (diagnose): run the diagnostic agent; emit the diagnosis event.
  if step == "recommend":
      diagnosis = parse_diagnosis(diagnosisParam)         # step 3 gets it from ?diagnosis=
      if not diagnosis:
          throw "no diagnosis was handed over…"
  else:
      diagAgent  = new DiagnosticAgent(provider_sdk, mcp, schema, allTools)
      diagnosis  = await diagAgent.investigate(inv, hooksFor("diagnostic"))
      send({ type: "diagnosis", diagnosis })

  # STEP 3 (recommend) — skipped on the diagnose step:
  if step != "diagnose":
      recAgent       = new RecommendationAgent(provider_sdk, mcp, schema, allTools)
      recommendations = await recAgent.propose(inv, diagnosis, hooksFor("recommendation"))
      for r in recommendations:
          send({ type: "recommendation", recommendation: r })
```

The handoff is now *across the wire*, not in a local variable. After step 2 finishes, the investigation hook stashes the streamed `Diagnosis` in sessionStorage under `bi:diag:<id>`; when the user opens step 3, the hook reads it back and sends it to the route as `&diagnosis=<json>`, where a small parser re-validates it before `propose` runs. The order is still fixed and still the *code's* (the model never chooses what runs next) — but the seam between the two links is now an HTTP boundary plus a sessionStorage handoff, so each step is its own request with its own `maxDuration` budget and its own live stream.

```
client-driven two-step chain (the live path)
 ┌─ /api/agent?step=diagnose ──────────┐        ┌─ /api/agent?step=recommend ───────┐
 │  investigate(anomaly) → Diagnosis    │        │  parse_diagnosis(?diagnosis=)      │
 │  send 'diagnosis'                    │        │  propose(anomaly, diagnosis)       │
 └───────────────┬──────────────────────┘        └────────────▲──────────────────────┘
                 │ hook stashes Diagnosis                      │ hook reads bi:diag:<id>
                 ▼  sessionStorage  bi:diag:<id>  ─────────────┘  → &diagnosis=<json>
```

The monitoring step — step 1 — runs in the separate briefing path; the agent route enters at the diagnostic step because the anomaly is already resolved from the insight id. The **legacy combined-capture run** (`step == null`, used by the demo-snapshot capture) still sequences both agents with two `await`s in *one* request (the `else` + `step != "diagnose"` branches both fire) and caches the full stream.

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

### The monitoring link is gated to the workspace's runnable categories

The first link — monitoring detection — does not run a fixed 10-category sweep. The briefing route gates the anomaly checklist against the live schema *before* the agent call, then injects only the supported categories into the prompt, so the link never spends query budget on a category this workspace's events cannot support. The monitoring agent's `scan` takes the runnable categories as a parameter and builds a per-category checklist (one bullet per category: its rationale, its suggested query recipe, and its delta thresholds) that it interpolates into the prompt through a `{categories}` slot. The route computes the runnable set with a `runnableCategories` helper that drops any category missing a hard dependency, and hands it to `scan`.

```
schemaCapabilities(schema) → runnableCategories(…) → checklist → {categories} slot → scan
```

This is the prompt-chaining payoff applied to a single link: the detection step's prompt is sized to exactly the categories the data can answer, so the link is both cheaper (no wasted queries on unsupported categories) and more focused (the model is told precisely what to check). The gate itself — schema capabilities → coverage → runnable set — is the subject of → ../04-agents-and-tool-use/07-capability-gating.md.

### Errors are isolated per link

Each step degrades to a safe default for *that step* rather than failing the chain. The monitoring scan returns `[]` on any parse failure; the diagnostic investigation falls through to `FALLBACK`; the recommendation proposer falls through to `[]`. And the whole route body is wrapped in `try/catch` that emits an `error` event and still closes the stream cleanly in `finally`.

```
each link's failure boundary
monitoring  parse fail  → []          (briefing has no anomalies, not a crash)
diagnostic  parse fail  → FALLBACK    (recommendation still runs on a hollow diagnosis)
recommend.  parse fail  → []          (UI shows diagnosis, no actions)
route       any throw   → 'error' event + finally{ controller.close() }
```

A failure at one link does not corrupt the others: a `[]` from monitoring is a clean "nothing to report," a `FALLBACK` diagnosis still flows into recommendation as valid input. The seam between steps is exactly where the failure is caught.

### The micro-chain inside each step (loop → synthesize)

Two of the three steps are *themselves* a small two-link chain. Inside the diagnostic investigation and the recommendation proposer, the first link is the tool-use loop that gathers evidence, and the second link is a separate `synthesize()` call that turns that evidence into validated JSON:

```
  return (
    try_parse_diagnosis(finalText)             # loop's own final turn produced JSON?
    OR (await synthesize(anomaly, toolCalls))   # micro-chain: gather → synthesize
    OR FALLBACK                                 # safe default
  )
```

The `synthesize()` call is a distinct model call — `max_tokens: 2048`, no tools, a clean context built only from the formatted tool-call evidence. It is a separate prompt with one job (evidence → JSON), chained after the gather loop. So the briefing is a chain of steps, and the gather/synthesize split is a chain within a step.

```
inside one step (diagnostic)
runAgentLoop (gather)  ──toolCalls──▶  synthesize() (extract JSON)  ──▶  Diagnosis
   link 1: explore                       link 2: one job, clean context
```

### Current state vs. future state

```
CURRENT (one model, every step)         FUTURE (cheaper model on early steps)
────────────────────────────────       ────────────────────────────────────
one shared AGENT_MODEL for all three    monitoring/synthesize on cheap tier,
                                        diagnostic/recommendation on dear tier
no per-step model selection             model chosen per chain link by difficulty
```

The chain *enables* an optimization the codebase has not taken: every step runs on the same shared agent-model constant. Because each link is a separate call with a known difficulty, the earlier or simpler links (monitoring detection, the synthesis extraction) could run on a cheaper model (the same cheap tier already used for intent classification) while the reasoning-heavy links stay on the dear tier. The seam exists — the shared agent loop reads the model name from one constant — but the per-step selection is not wired. This is a real, un-taken cost optimization, and it is honest to name it as not done.

### The principle

Decompose a multi-stage task into a fixed sequence of single-job model calls wired by ordinary control flow, with a typed handoff and an isolated failure boundary at each seam. The payoff is the same as any `.then().then()` pipeline: each step is simple, testable, and bounded; failures are contained at the link; and the seams are natural places to validate, log, stream, and later optimize (per-step model choice). Reach for a chain when the path is known in advance — and for an agent only when the model must choose the path (→ ../04-agents-and-tool-use/01-agents-vs-chains.md).

---

## Prompt chaining — diagram

This diagram spans the layers. The Route layer owns the chain order — across two `step`-gated HTTP requests for the live path (the `Diagnosis` handed over via the client's sessionStorage), or a single `await` sequence for the legacy combined-capture run; the Agent layer is the three single-job links, each running its own focused call (and a gather→synthesize micro-chain inside two of them); the Provider boundary is where each link's model call goes out.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts   (owns the order; step-gated)   │
│                                                                       │
│  GET ?step=diagnose          GET ?step=recommend            │
│     resolve anomaly                       parseDiagnosis(?diagnosis=)  │
│     investigate(anomaly) → Diagnosis      propose(anomaly, diagnosis)  │
│     send 'diagnosis'                send each 'recommendation'   │
│              │ hook stash bi:diag:<id>             ▲ hook → &diagnosis= │
│              └────── sessionStorage handoff ───────┘                   │
│  body wrapped in try/catch → 'error' + finally{ close }   │
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
│   synthesize() (→ JSON)        │ │   synthesize() (→ JSON)                │
└───────────────┬────────────────┘ └─────────────┬──────────────────────────┘
                │ anthropic.messages.create        │  (all on AGENT_MODEL, base.ts L9)
┌───────────────▼───────────────────────────────────▼──────────────────────┐
│  PROVIDER BOUNDARY   Anthropic Messages API                              │
│  every link is a separate call — focused prompt, small tool set          │
└────────────────────────────────────────────────────────────────────────────┘
```

The route owns the order — two `step`-gated requests live, one `await` sequence for capture; each agent is one focused link with its own prompt, tools, validator, and fallback; two links contain a gather→synthesize micro-chain. All links currently share one model — the seam for per-step model choice is open but unused.

---

## Implementation in codebase

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

## See also

→ 01-context-window.md · → 02-lost-in-the-middle.md · → ../04-agents-and-tool-use/01-agents-vs-chains.md · → ../01-llm-foundations/04-structured-outputs.md

---
Updated: 2026-05-28 — Rewrote the chain orchestration as the two-step `?step=diagnose`/`?step=recommend` split with the `bi:diag:<id>` sessionStorage handoff (was a single in-process `await` chain); `maxDuration` 60→300; re-derived all route.ts/diagnostic.ts/recommendation.ts/monitoring.ts/useInvestigation.ts line refs.
Updated: 2026-05-29 — Added "The monitoring link is gated to the workspace's runnable categories": `scan(hooks?, categories=[])` (monitoring.ts L69) injects a per-category checklist via the `{categories}` slot (L73–L86), gated by `runnableCategories` (categories.ts L157–L160) at briefing route L204/L223; cross-refs the new capability-gating file.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
