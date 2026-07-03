# Sequential pipeline (chain of specialized agents)

_Industry standard._

## Zoom out, then zoom in

Output of one agent feeds the next. In this repo the diagnose → recommend chain is the primary sequential pipeline: the diagnostic agent produces a `Diagnosis` artifact, the recommendation agent consumes it. The supervisor (`app/api/agent/route.ts`) is the plumbing between them.

```
  Zoom out — the sequential pipeline in this repo

  ┌─ /api/agent (SUPERVISOR: TypeScript) ─────────────────────────┐
  │                                                                │
  │  ┌─ Stage A ───────┐   Diagnosis   ┌─ Stage B ──────────┐      │
  │  │ DiagnosticAgent │ ─────────────►│ RecommendationAgent│      │
  │  │ (evidence loop) │  (artifact)   │ (action-shape loop)│      │
  │  └─────────────────┘               └────────────────────┘      │
  │           ▲                                    │               │
  │           │                                    ▼               │
  │       NDJSON stream forwarded to browser (both stages)         │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: this is a two-stage chain. Stage A's output is Stage B's input, plumbed by the supervisor. Both stages are agents (autonomous ReAct loops inside), but the *pipeline* between them is deterministic — the supervisor decides "run Stage A, hand its result to Stage B."

## Structure pass

**Layers:** stage A (produce artifact) · handoff (typed contract) · stage B (consume artifact) · trace (interleaved for the UI).
**Axis:** *who owns state between stages, and what shape does it travel as?*
**Seam:** the `Diagnosis` type. Stage A promises "returns a Diagnosis"; Stage B promises "accepts a Diagnosis." The seam is the type contract — swap Stage A's internal implementation and Stage B doesn't know.

```
  The handoff seam — one artifact, two agents

  ┌─ Stage A ─────────┐   returns Diagnosis    ┌─ Supervisor ────┐
  │  DiagnosticAgent  │ ─────────────────────► │  parses, plumbs │
  │  ~5 turns         │                        │                 │
  └───────────────────┘                        └────────┬────────┘
                                                        │ passes Diagnosis
                                                        ▼
                                               ┌─ Stage B ─────────┐
                                               │RecommendationAgent│
                                               │  ~5 turns         │
                                               └───────────────────┘
```

## How it works

### Move 1 — the mental model

You've written a `fetch(...).then(json => process(json))` chain before. The first call's output is the second call's input; either can fail; the browser sees them as a single flow. A sequential agent pipeline is the same shape, except each stage is a full ReAct loop instead of a single HTTP call.

```
  Pattern: sequential agent pipeline

  input (Anomaly)
       │
       ▼
  ┌──────────────┐
  │  Stage A     │  ← autonomous loop, ~5 turns
  │  Diagnostic  │
  └──────┬───────┘
         │ typed artifact (Diagnosis)
         ▼
  ┌──────────────┐
  │  Stage B     │  ← autonomous loop, ~5 turns
  │ Recommend    │
  └──────┬───────┘
         ▼
    output (Recommendation[])
```

### Move 2 — the walkthrough

**The handoff — `app/api/agent/route.ts:270-294`.**

```ts
// route.ts — Stage A
const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
send({ type: 'diagnosis', diagnosis });

// route.ts — Stage B (only if step !== 'diagnose')
if (step !== 'diagnose') {
  const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
  const recommendations = await recAgent.propose(inv, diagnosis!, {
    ...hooksFor('recommendation'), signal: req.signal
  });
  for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
}
```

Line-by-line:

- **`diagnosis = await diagAgent.investigate(...)`** — the `await` is the whole pipeline joint. The supervisor blocks on Stage A completing (~50s of ReAct loop, ~5 turns, ~$0.045). Nothing about Stage B starts until this returns.
- **`send({ type: 'diagnosis', diagnosis })`** — the artifact is streamed to the UI at the handoff boundary. The user sees "diagnosis complete" before Stage B starts. This is not just plumbing — it makes the pipeline *inspectable* mid-flight.
- **`recAgent.propose(inv, diagnosis!, ...)`** — Stage B takes the anomaly (original input) AND the diagnosis (Stage A output). Two arguments, both required. The `!` is the load-bearing part: at this point in the flow, TypeScript can't prove diagnosis is set, but the `if (step !== 'diagnose')` gate above ensures it is.
- **`for (const r of recommendations) send(...)`** — Stage B emits multiple recommendations; each streams as it lands. The UI renders them incrementally.

**Stage skipping — the same pipeline serves three product phases.** The route accepts `step=diagnose|recommend|null` and skips stages accordingly:

- `step=diagnose` — run Stage A only, emit diagnosis, stop. (The Investigate page.)
- `step=recommend` — skip Stage A, parse the diagnosis from the URL param, run Stage B only. (The Recommend page after the user navigated back.)
- `step=null` — run both (used by the demo capture).

This is a pipeline with a *resume point*. The seam between stages isn't just typed — it's serializable, so Stage B can be resumed against a prior Stage A output. The URL is the persistence layer.

**The trace is interleaved, not sequential.** Even though the stages run sequentially, the NDJSON stream shows Stage A's steps, then the `diagnosis` event, then Stage B's steps — all in one channel. The `hooksFor(agent)` factory (Move 2 in `02-supervisor-worker.md`) tags each event with the agent name so the UI can group them.

```
  Layers-and-hops — the two-stage pipeline

  ┌─ UI (browser) ──────────────────┐
  │  StatusLog reads NDJSON stream  │
  └─────┬────────────▲──────────────┘
        │            │ interleaved trace + `diagnosis` event
        ▼            │
  ┌─ /api/agent (SUPERVISOR) ─────────────┐
  │  awaits Stage A → forwards `diagnosis`│
  │  awaits Stage B → forwards each rec   │
  └────┬──────────────────────┬───────────┘
       │ new DiagnosticAgent   │ new RecommendationAgent
       ▼                       ▼
  ┌─ Stage A ────────┐   ┌─ Stage B ─────────┐
  │  AptKit ReAct     │   │  AptKit ReAct      │
  │  ~5 turns · ~50s │   │  ~5 turns · ~51s   │
  └──────────────────┘   └────────────────────┘
```

### Move 3 — the principle

Sequential pipelines are the right shape when the work has *inherent order* — you can't recommend without diagnosing first, you can't diagnose without an anomaly first. The type contract between stages is what makes the pipeline maintainable: each stage promises a shape, the next stage consumes it, either can be refactored independently as long as the seam holds. Latency is the sum of stages (no parallelism to buy back), but each stage is independently debuggable — when a run is bad, the trace tells you which stage produced the badness.

## Primary diagram

```
  Recap — the diagnose → recommend pipeline

  Anomaly (from feed click)
       │
       ▼
  ┌────────────────────────────────────────────────────┐
  │  Stage A — DiagnosticAgent                          │
  │  input:  Anomaly + workspace schema                 │
  │  loop:   ~5 turns (EQL evidence gathering)          │
  │  output: Diagnosis { conclusion, evidence[],        │
  │                       hypothesesConsidered[] }      │
  └────────────────────┬────────────────────────────────┘
                       │ typed handoff (Diagnosis)
                       ▼
       send({ type: 'diagnosis', diagnosis })  ← UI sees this
                       │
                       ▼
  ┌────────────────────────────────────────────────────┐
  │  Stage B — RecommendationAgent                      │
  │  input:  Anomaly + Diagnosis                        │
  │  loop:   ~5 turns (Bloomreach feature selection)    │
  │  output: Recommendation[]                           │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
       for each: send({ type: 'recommendation', ... })
```

## Elaborate

Sequential pipelines are the oldest orchestration shape — Unix pipes, ETL jobs, function composition. Agent pipelines add one twist: each stage is autonomous, so its runtime is variable (5-8 turns depending on how many EQL queries the model wants). That variability compounds — a 30s diagnose plus a 50s recommend can drift to a 60s + 80s outlier when a hard case makes both stages think harder.

The reason this shape works well for diagnose → recommend specifically: the two stages are *asymmetric* on tools (diagnostic uses evidence-gathering tools, recommendation uses action-shape tools like `list_scenarios`), *asymmetric* on prompts (investigate vs propose), and *asymmetric* on failure modes (bad evidence vs inappropriate feature). That's the three-criteria test from `01-when-not-to-go-multi-agent.md` — the split earns its keep.

The Recommendation input includes the original Anomaly, not just the Diagnosis. Recommendation needs both — the numeric change (from Anomaly) and the causal reasoning (from Diagnosis) — to write a proposal that says "given a 38% drop, run Scenario X for 14 days." Passing only the Diagnosis would starve Stage B of the metric baseline.

## Interview defense

**Q: Why not run diagnose and recommend in parallel?**
A: Recommend needs the diagnosis. It's not "diagnosis helps" — the recommendation prompt literally receives the `Diagnosis` object as input and reasons over it ("your evidence shows checkout latency was up 40%, therefore propose a Segment for the affected users"). Without the diagnosis, recommend has no basis. This isn't a parallel-eligible fan-out; it's an inherent-order pipeline. If we tried to parallelize, we'd get generic recommendations that don't ground in the evidence.

Diagram: the data-flow arrow from Diagnosis → RecommendationAgent, labelled "input dependency."
Anchor: `app/api/agent/route.ts:280` (`recAgent.propose(inv, diagnosis!, ...)`).

**Q: What happens if Stage A fails midway?**
A: The error propagates up through the `await`. The route handler's outer try/catch emits an NDJSON `error` event, the client sees the failure. Stage B never runs — no half-finished pipeline state. That's the safety property of sequential + await: either you get through Stage A cleanly, or the pipeline halts. Common failures are: schema-gate error (Bloomreach rejects an EQL), rate-limit retry ceiling hit, and BudgetExceededError from the tracker. All three surface as graceful `error` events, not silent hangs.

Diagram: the try/catch envelope around the pipeline; failure short-circuits before Stage B.
Anchor: `app/api/agent/route.ts` (the outer try/catch); `04-agent-infrastructure/04-guardrails-and-control.md` for BudgetTracker.

## See also

- `02-supervisor-worker.md` — the supervisor that plumbs the pipeline.
- `08-shared-state-and-message-passing.md` — the Diagnosis is a message (not shared state).
- `04-parallel-fan-out.md` — the other shape, and why it doesn't fit diagnose → recommend.
- `09-coordination-failure-modes.md` — synthesis failures at the handoff.
