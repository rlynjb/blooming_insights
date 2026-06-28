# RFC 03 — Deterministic supervisor, not an LLM router

**Decision:** The agent topology is **a sequential pipeline (monitoring →
diagnostic → recommendation) plus a deterministic intent classifier**. The
"who runs next" decision is **CODE**, not a coordinator LLM. The only place an
LLM picks a path is the intent classifier (free-form chat → diagnostic vs
query), and even there the surface is a single classify-then-dispatch step,
not a recursive supervisor.

## Context

The product runs the analyst loop — **monitoring → diagnosis → recommendation**
— end-to-end. There are five agents in code today:

  → `MonitoringAgent` (`lib/agents/monitoring.ts`)
  → `DiagnosticAgent` (`lib/agents/diagnostic.ts`)
  → `RecommendationAgent` (`lib/agents/recommendation.ts`)
  → `QueryAgent` (`lib/agents/query.ts`) — free-form Q&A surface
  → `classifyIntent` (`lib/agents/intent.ts`) — pure router, no tools

The architectural question is **how the agents are wired together**. The
trendy 2024–2025 answer is a "supervisor agent" or "coordinator agent" — an
LLM that picks which sub-agent runs next (e.g. AutoGen, CrewAI, LangGraph's
supervisor pattern). The alternative is to wire them as a code-driven
pipeline.

The pipeline won.

## Goals

  → **Predictable cost.** Every briefing should fire the same N model calls
    in the same order. No "supervisor decides to loop back and re-monitor."
  → **Predictable latency.** A 30–90s budget is the upper bound. A supervisor
    LLM adds its own thinking time on top of every transition.
  → **Debuggable trace.** The `StatusLog` panel reads as a linear sequence of
    agent steps. The user sees the monitoring agent finish, then the
    diagnostic agent start. There is no "coordinator paused to think" gap.
  → **Loop budget enforcement.** The agent loop itself (now AptKit's) has a
    `maxToolCalls` ceiling. A supervisor that can dispatch loops within loops
    multiplies the worst case.
  → **One LLM call where an LLM call is genuinely required.** Intent
    classification needs the LLM's understanding. "What should I run next?" in
    the diagnose-then-recommend pipeline does not.

## Non-goals

  → **Free agent composition.** The product does not need ad-hoc
    multi-agent collaboration. The shape is fixed: detect → diagnose →
    recommend.
  → **Hot-swapping agents at runtime via LLM choice.** The pipeline is
    declared in the route handlers; new agents land via code changes, not at
    inference time.
  → **Agent-to-agent message passing.** Agents do not call each other. The
    route handler is the only thing that calls agents.

## The decision

Three places make routing decisions. All three are code; one of them uses an
LLM as input.

```
  Routing topology — where decisions are made

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  user clicks "investigate this anomaly"                      │
  │  → POST /api/agent { step: 'diagnose', insight }             │
  │  user clicks "see recommendations →"                         │
  │  → POST /api/agent { step: 'recommend', diagnosis }          │
  └─────────────────┬────────────────────────────────────────────┘
                    │
                    ▼
  ┌─ Decision #1: ROUTE = url path (deterministic) ──────────────┐
  │  /api/briefing   → MonitoringAgent.scan()                    │
  │  /api/agent      → branch on `step` (code switch)            │
  └─────────────────┬────────────────────────────────────────────┘
                    │
       ┌────────────┼─────────────┬─────────────────┐
       │            │             │                 │
       ▼            ▼             ▼                 ▼
   ┌────────┐  ┌─────────┐  ┌──────────┐    ┌──────────────┐
   │monitor │  │diagnose │  │recommend │    │ free-form Q  │
   │  scan  │  │evidence │  │  steps   │    │              │
   └────────┘  └─────────┘  └──────────┘    └──────┬───────┘
                                                   │
                                                   ▼
  ┌─ Decision #2: classifyIntent (the only LLM router) ──────────┐
  │  agents/intent.ts — claude-haiku-4-5 → 'diagnostic'|'query'  │
  │  ONE call, ONE output, no loop, no follow-up tool calls       │
  └─────────────────────┬────────────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
        ┌──────────┐        ┌──────────┐
        │diagnostic│        │  query   │
        │  agent   │        │  agent   │
        └──────────┘        └──────────┘
                        │
                        ▼
  ┌─ Decision #3: inside each agent — AptKit loop, model picks ─┐
  │  Within an agent's tool-use loop, the LLM decides WHICH tool│
  │  to call next. This is "LLM picks tool", not "LLM picks      │
  │  agent". Bounded by maxToolCalls in the AptKit loop.         │
  └──────────────────────────────────────────────────────────────┘
```

**Verdict-first:** the supervisor is the **URL of the request**. The
classifier is a single haiku call with no tools. The agent loop's LLM
freedom is bounded to "which tool to call next, within this agent."

### Three layers of routing, three different control models

This is the cleanest way to read the topology — same question ("who decides
the next step?") asked at three altitudes:

```
  One question, held constant down the layers

  "who decides the next step?"

  ┌─────────────────────────────────────┐
  │ outer:  pipeline order              │   → CODE (route handler)
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ middle:  free-form intent       │   → LLM (one classify call)
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ inner:   which tool to call │   → LLM (bounded loop)
          └─────────────────────────────┘
```

Two things flip across the seams:
  → outer → middle: control flips from `code` to `LLM`, but inside a
    *single* haiku call, not a loop.
  → middle → inner: still LLM, but bounded by a `maxToolCalls` budget and a
    forced synthesis turn.

The supervisor pattern (the rejected alternative) would put a loop with an
LLM at the outer layer too — "supervisor decides whether monitoring is
done." That's the layer where determinism is most valuable.

### The intent classifier — the one LLM router we do use

`lib/agents/intent.ts` is 38 lines. It is the entire LLM-based routing
surface in the codebase:

```ts
// lib/agents/intent.ts:16-38
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(
      anthropic, 'coordinator', sessionId,
      CLASSIFIER_MODEL,
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
```

Three things keep this from sliding into "supervisor":
  → **A cheap, fast model** (`claude-haiku-4-5`, not sonnet). Wrong tool for
    deep reasoning by design.
  → **No tools.** The classifier cannot call MCP, cannot kick off
    diagnostics. It returns one of two enum values.
  → **Pure function below.** `parseIntent(raw)` defaults to `'diagnostic'`
    on any unrecognized output. A bad model response cannot brick the
    router.

## Alternatives considered

### Alternative A — Coordinator agent (LLM supervisor)

A `CoordinatorAgent` that owns the full briefing loop. Given the workspace
schema, it decides: do we monitor? Now? With which categories? Then it
decides whether the monitoring output warrants diagnosis. Then it decides
whether the diagnosis warrants a recommendation. Each transition is an LLM
call.

This is what most "multi-agent framework" demos look like.

**Why it lost:** Three things make it the wrong default for this product.

  1. **The pipeline shape is fixed by the product, not by inference.** The
     analyst loop IS monitor → diagnose → recommend. An LLM that "decides"
     to skip diagnosis is wrong. We do not need that flexibility; we need
     reliability that the pipeline runs end-to-end on every briefing.
  2. **Latency cost.** Each supervisor turn adds ~1-3s of model thinking on
     top of the agent it dispatches. Across a 4-step briefing that's 5-10s
     of pure routing overhead the user waits for, for a decision the code
     could make instantly.
  3. **Failure surface explodes.** A supervisor that calls sub-agents in a
     loop can recurse, oscillate, or hang. Bounding it requires a budget on
     the outer loop AND every inner loop — two budgets to manage instead of
     one. The deterministic pipeline has one bound (`maxToolCalls` inside
     each agent's loop) and the outer order cannot misbehave because there
     is no outer loop.

### Alternative B — Single mega-agent

One agent with all the tools and a long prompt. "You are a monitoring +
diagnostic + recommendation agent."

**Why it lost:** Loses the per-agent prompt specialization. The diagnostic
agent's prompt is dense with the hypothesis-formation rubric; the
recommendation agent's prompt is dense with the Bloomreach feature catalog.
Cramming both into one system prompt blows context and degrades both jobs.
The `StatusLog` UI also depends on agent identity (the agent badge per line)
to be useful — a single agent collapses that signal.

### Alternative C — Sub-agent dispatch via tool calls

Each agent exposes itself as a "tool" the supervisor can call. The
supervisor's tool registry includes `run_monitoring`, `run_diagnostic`,
`run_recommendation`.

**Why it lost:** This is alternative A wearing a different costume. Same
latency cost, same failure surface, plus the additional cost of tool-call
serialization for each transition. Adds nothing over the direct call.

## Tradeoffs accepted

  → **No ad-hoc agent composition.** The system cannot "decide on the fly"
    to run two diagnoses in parallel. Acceptable — the product doesn't ask
    for it.
  → **A new "kind of work" is a new agent + a new pipeline step in code.**
    Not a config change. Acceptable — agents land via PR, not via prompt
    engineering at runtime.
  → **The intent classifier is a single point of failure for chat routing.**
    A haiku call that returns garbage routes to the default ('diagnostic').
    Mitigated by `parseIntent`'s safe default — wrong route is better than
    crashed route.
  → **The diagnostic → recommendation handoff is a manual user click.** The
    user clicks "see recommendations →" on the investigation page. We chose
    not to auto-cascade because the user often wants to read the diagnosis
    first. A supervisor pattern would have had to make this same decision
    anyway; making it in the UI is cleaner.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| The classifier model gets cheaper/dumber and starts misrouting | `parseIntent` default of `'diagnostic'` keeps the worse path "useful but slower," never broken. Eval suite spot-checks classification when it returns. |
| A new agent (e.g. forecast, segment-explorer) doesn't fit the linear pipeline | The route handler adds another deterministic switch on a new query-string param. Pipeline shape stays declarative in code. |
| The forced synthesis turn (inside each agent's loop) is wasted on simple queries | Measured in `res.usage` logs at `lib/agents/aptkit-adapters.ts:60,65`. Synthesis turn adds ~500-1000 output tokens; affordable. |
| The route-as-router pattern leaks Next.js coupling into the agent layer | Counter: the agents take a `DataSource` and an `Anthropic` instance. The route layer is the only thing that knows it's a Next.js route. The coupling is in one direction (Next → agents), which is fine. |

## Rollout / migration

Already shipped. The order of operations was:

  1. Build `runAgentLoop` (hand-rolled, deliberately bounded — see RFC 06).
  2. Build the three pipeline agents on top of `runAgentLoop`, each with
     its own prompt.
  3. Add `classifyIntent` as a separate haiku-backed function — never
     wrapped into the supervisor.
  4. Migrate to AptKit (RFC 06) — the agent loop moves into the library;
     the topology decision in *this* RFC stays unchanged. AptKit is the
     loop, not the supervisor.

The eval flywheel built on the Olist substrate (Phase 3, 4-pillar suite —
detection / diagnosis / recommendation / regression) measured this pipeline
end-to-end. LLM-as-judge calibration ran 8/8 + 3/3 manual spot-check and
surfaced three real bugs (BRL cents-vs-Reais, binary calibration,
conclusion-instability at 30%). The pipeline shape itself never produced a
"wrong agent ran" failure — the bugs were all *inside* an agent's reasoning,
not in routing. Evidence the routing decision was correct.

## Open questions

  → **When does the product earn a supervisor?** Probably the day we add a
    fourth agent kind that can run in parallel with another (e.g. a
    segmentation agent that runs concurrently with diagnosis). At that
    point the route handler's switch becomes a small DAG, and a supervisor
    might be the cleaner expression. Today it isn't.
  → **Should `classifyIntent` short-circuit on regex matches?** "What
    happened with revenue last week" is a diagnostic intent every time. A
    pre-classifier regex layer could save a haiku call per chat. Not done
    today — the haiku call is cheap enough that the optimization isn't
    worth the rule maintenance.
  → **The auto-handoff from diagnosis to recommendation.** Today the user
    clicks. Should we offer an "auto-cascade" mode? Open — would change the
    UX, not the topology.

---

**Coach note:** The verbal move that lands this decision in an interview is
*"the route handler is my supervisor."* It re-anchors the listener — they
expected an LLM, you handed them a URL path. Then walk them through the
intent classifier as the one place an LLM does pick a path, and why that
one is bounded and safe.
