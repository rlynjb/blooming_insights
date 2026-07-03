# 06 · Single-purpose chains

**Industry name:** *single-purpose chains* / *pipeline pattern* / *one job per prompt* · Industry standard

## Zoom out — the three-chain pipeline

The pipeline in this repo is monitor → diagnose → recommend. Three chains, three jobs, composed. The output of one is the input to the next.

```
  Zoom out — the three-chain pipeline

  ┌─ Trigger (briefing route) ─────────────────────────────────┐
  │  fetch('/api/briefing') → NDJSON stream                     │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ MonitoringAgent ──────▼────────────────────────────────────┐
  │  one job: FIND anomalies                                     │
  │  in: workspace, categories                                   │
  │  out: Anomaly[]                                              │
  └────────────────────────┬────────────────────────────────────┘
                           │  for each anomaly:
  ┌─ DiagnosticAgent ──────▼────────────────────────────────────┐
  │  one job: EXPLAIN why                                        │
  │  in: Anomaly                                                 │
  │  out: Diagnosis { conclusion, evidence, hypotheses }         │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ RecommendationAgent ──▼────────────────────────────────────┐
  │  one job: PROPOSE actions                                    │
  │  in: Anomaly + Diagnosis                                     │
  │  out: Recommendation[]                                       │
  └─────────────────────────────────────────────────────────────┘
```

## Zoom in — one job, one prompt, one output shape

Each chain has:

- **One job.** Verbally nameable in five words.
- **One prompt.** Sized to that job, not to the whole pipeline.
- **One output shape.** Downstream can parse it without knowing what the chain did internally.

The composition is *code* (TypeScript orchestrator), not more prompt. The next chain doesn't need to see the previous chain's tool calls or reasoning — it only needs the structured output.

## Structure pass — layers, axis, seams

Trace one axis: *who decides what happens next*, across the three chains.

- **Chain 1 (monitor) — code decides.** The categories list is a fixed input; the monitoring agent walks it.
- **Chain 2 (diagnose) — model decides (bounded).** The agent generates 2-3 hypotheses and queries to test each. The ReAct loop is model-driven within a 6-tool-call budget.
- **Chain 3 (recommend) — model decides (bounded).** The agent picks 2-3 actions from the diagnosis.

**The seam:** between chains. Every seam has a typed contract — `Anomaly`, `Diagnosis`, `Recommendation` in `lib/mcp/types.ts`. When chain N returns a `Diagnosis`, chain N+1 knows what to expect at compile time. When a chain's output shape changes, the compiler catches every callsite. This is why the composition is code, not prompt.

## How it works

### Move 1 — the shape

You've written a Unix pipe. `find | grep | wc -l`. Each program does one job; the composition is the shell. Nobody writes a single super-program that does find-and-grep-and-wc in one binary, because the moment you need one of those jobs in a different context you're re-implementing it. Same shape here. Chain each thing to its narrow job; compose the chain in code.

```
  Pattern — pipes as the mental model

  monitor(workspace)             ──►  Anomaly[]
                                        │
  diagnose(anomaly)              ◄──────┘
                                 ──►  Diagnosis
                                        │
  recommend(anomaly, diagnosis)  ◄──────┘
                                 ──►  Recommendation[]

  each stage: one job, one prompt, one output shape.
  the composition is code — briefing/route.ts — not a bigger prompt.
```

The alternative — one giant "you are the analyst; find anomalies, explain them, and recommend actions" prompt — sounds simpler until you try to debug it, iterate on any one step, model-route (small model for classification, big model for generation), or run three copies in parallel. Then you'd wish you had it decomposed.

### Move 2 — walking the chain

#### Chain 1 — `MonitoringAgent`

`lib/agents/monitoring.ts:73-93`:

```
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
    const agent = new AptKitAnomalyMonitoringAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
      tools: toolRegistry,
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
      categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
    });

    return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
  }
}
```

Job: `.scan()` returns `Anomaly[]`. Nothing else. It doesn't explain. It doesn't recommend. If the workspace has no anomalies, `[]`. If it finds five, five.

The retired prompt at `lib/agents/legacy-prompts/monitoring.md:5-7` says this explicitly:

> "You do not diagnose causes or propose actions — you detect, measure, and report."

That "you do not do X" scoping is characteristic of single-purpose prompts. Cross-cutting instructions ("also, whenever you notice X, also do Y") are what erode the single-purpose discipline. The monitoring prompt refuses.

#### Chain 2 — `DiagnosticAgent`

`lib/agents/diagnostic.ts:46-63`:

```
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', ...),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });

  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

Job: `.investigate(anomaly)` returns a `Diagnosis`. From `lib/agents/legacy-prompts/diagnostic.md:5-7`:

> "You do not propose remediation — you diagnose causes only."

Same discipline. Explicit non-scope. The agent generates 2-3 hypotheses, tests each with tool calls (6-call budget), then concludes. It does not propose actions.

The Diagnosis shape from `lib/agents/legacy-prompts/diagnostic.md:60-82`:

```
{
  "conclusion": "string",
  "evidence": ["string"],
  "hypothesesConsidered": [{ "hypothesis": "string", "supported": true, "reasoning": "string" }],
  "affectedCustomers": { … },
  "timeSeries": [ … ]
}
```

That's the seam. The next chain reads these fields. It doesn't need to know how the diagnostic agent got here.

#### Chain 3 — `RecommendationAgent`

`lib/agents/recommendation.ts:26-46`:

```
async propose(
  anomaly: Anomaly,
  diagnosis: Diagnosis,
  hooks: AgentHooks = {},
): Promise<Recommendation[]> {
  const agent = new AptKitRecommendationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'recommendation', ...),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'recommendation'),
  });

  return agent.propose(anomaly, diagnosis, { signal: hooks.signal });
}
```

Job: takes an `Anomaly` and a `Diagnosis`, returns `Recommendation[]`. From `lib/agents/legacy-prompts/recommendation.md:1`:

> "You are read-only: you do NOT execute anything — your recommendations are suggestions for a human to act on."

Third discipline layer: the chain doesn't just have a scoped job, it has a scoped *permission model*. Recommend only. Never execute.

#### The composition — briefing route

```
  Layers-and-hops — the pipeline as composed in code

  ┌─ briefing route ─────────────────────────────────────┐
  │                                                       │
  │  const anomalies = await monitor.scan()               │
  │                                                       │
  │  for (const anomaly of anomalies) {                   │
  │    const diagnosis = await diag.investigate(anomaly)  │
  │    const recs = await rec.propose(anomaly, diagnosis) │
  │    stream({ anomaly, diagnosis, recs })               │
  │  }                                                    │
  │                                                       │
  └───────────────────────────────────────────────────────┘

  the loop is code. each stage is one prompt. the composition
  is not a prompt.
```

The eval harness at `eval/run.eval.ts:199-269` uses the same composition — for each golden case, `diagnose` then `recommend`, sharing a `BudgetTracker` across both. Same pipeline as production. That's the payoff of decomposition: the eval can test each stage independently *and* the composition end-to-end, because the stages are typed and small.

### Move 2 variant — the load-bearing skeleton

Kernel of single-purpose chains:

1. **Each chain has one job, statable in one sentence.** Drop this and prompts start "and also" growing.
2. **Each chain returns a typed shape.** Drop this and the composition has to parse loose strings between stages.
3. **The composition is code, not prompt.** Drop this and you've re-created the giant super-prompt in a different form.
4. **The prompt explicitly names its non-scope.** Drop this and the model happily starts freelancing into adjacent jobs.

Hardening on top: retry policies per stage, per-stage timeouts, per-stage budget, different models per stage (smaller for classifiers, bigger for generation). None of that is the skeleton — the skeleton is: one job per chain, typed hand-off, code composition, explicit non-scope.

### Move 3 — the principle

**Decomposition is the debug-ability move.** When the pipeline breaks, decomposed chains let you point at which chain broke. Was the anomaly wrong? Monitor failed. Was the diagnosis wrong? Diagnose failed. Was the recommendation wrong given a correct diagnosis? Recommend failed. One-giant-prompt architectures make this diagnosis impossible — the whole thing works or the whole thing doesn't. And the moment production breaks, you'll wish you could point at a stage.

## Primary diagram

```
  Single-purpose chains — the full recap

  ┌─ MonitoringAgent ──────────────────────────────────────┐
  │  job: FIND                                              │
  │  prompt says: "you do NOT diagnose or propose"          │
  │  in:  workspace, categories                             │
  │  out: Anomaly[]                                         │
  └────────────────────────┬───────────────────────────────┘
                           │  typed hand-off
  ┌─ DiagnosticAgent ──────▼───────────────────────────────┐
  │  job: EXPLAIN why                                       │
  │  prompt says: "you do NOT propose remediation"          │
  │  in:  Anomaly                                           │
  │  out: Diagnosis { conclusion, evidence, hypotheses }    │
  └────────────────────────┬───────────────────────────────┘
                           │  typed hand-off
  ┌─ RecommendationAgent ──▼───────────────────────────────┐
  │  job: PROPOSE actions                                   │
  │  prompt says: "you are read-only; do NOT execute"       │
  │  in:  Anomaly + Diagnosis                               │
  │  out: Recommendation[]                                  │
  └─────────────────────────────────────────────────────────┘

  composition: briefing route (production) + run.eval.ts (test)
  both compose stages with typed hand-offs; neither wraps them
  in a bigger prompt.
```

## Elaborate

The model-routing benefit is real and this repo hasn't fully exploited it yet. Right now every stage runs the same model (`claude-sonnet-4-6`, see `AGENT_MODEL` in `lib/agents/base.ts`). A monitoring pass that walks a category checklist doesn't need Sonnet — a Haiku-class model would classify anomalies just as well at a fraction of the cost. The reason for uniformity right now is developer ergonomics (one API key, one pricing model to track). If cost pressure grew, the natural first move would be: swap monitoring to Haiku, keep diagnose + recommend on Sonnet. The decomposition is what makes that a one-line change per stage.

The related pattern from other repos in Rein's portfolio: `loopd` runs 5 single-purpose chains (intent classifier, caption generator, tag extractor, memory writer, memory reader) with different models per stage. Same discipline. Same payoff — small models for classifiers, big for generation.

The counter-argument some engineers make: "but latency stacks up if you have 3 sequential model calls." True. It's a real cost, and for user-facing chatbot flows it can be prohibitive. The counter-move: parallelize where you can, and accept the trade-off where you can't. The briefing pipeline is not latency-sensitive (it runs on schedule, streams progress to the UI). If the query route needed sub-second responses, you'd fold multiple jobs into one prompt and eat the debug-ability cost — because you have no choice.

The failure mode single-purpose chains prevent: when a "one giant prompt" chain fails, you can't tell which sub-task failed. The output is a JSON blob that's supposed to contain 4 fields (anomaly + diagnosis + rec + confidence). One field is wrong. Was it the anomaly detection that was wrong? The diagnostic reasoning? The recommendation? You have to reverse-engineer the model's internal reasoning from output text, and the model itself doesn't necessarily know. With decomposed chains, each intermediate is on disk — you have `receipts/*` files that show the diagnosis as its own artifact, separate from the recommendation. Debug is a one-hop lookup.

## Interview defense

**Q: Why not one prompt that does everything?**

Three reasons. One, debug-ability — when the pipeline breaks, decomposed chains tell you *which* chain broke. One-giant-prompt architectures make this impossible; the whole thing is a black box. Two, model-routing — small models for classifiers, big models for generation. You can't route inside a giant prompt. Three, iteration — a single-purpose prompt fits in a paragraph and iterates in an afternoon. A giant prompt is a maintenance albatross. Anchor: `lib/agents/monitoring.ts`, `lib/agents/diagnostic.ts`, `lib/agents/recommendation.ts` — three chains, three sub-100-line files, composed in briefing route.

```
   monitor  ──►  Anomaly[]
   diagnose ──►  Diagnosis     ← each stage debuggable in isolation
   recommend──►  Recommendation[]
```

**Q: What does "explicit non-scope" look like in a prompt?**

Every single-purpose prompt in this repo explicitly names what it does *not* do. Monitoring prompt says "you do not diagnose causes or propose actions." Diagnostic says "you do not propose remediation." Recommendation says "you are read-only; you do NOT execute anything." Those "do NOT" clauses are load-bearing. Without them, models drift into adjacent jobs — a diagnostic agent starts proposing fixes, a recommendation agent starts asking for confirmation to execute. The explicit non-scope is what keeps the seam clean.

```
   monitor:   "you do NOT diagnose or propose"
   diagnose:  "you do NOT propose remediation"
   recommend: "you do NOT execute"
                    ▲
              the whole permission model of the pipeline
              lives in these three clauses
```

Anchor: `lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation}.md`.

## See also

- 01 · anatomy — the four sections of each single-purpose prompt.
- 07 · output mode mismatch — typed hand-offs are how single-purpose chains stay compatible.
- 02 · structured outputs — the typed hand-off is exactly the structured-output shape.
- 05 · eval-driven iteration — the eval harness uses the same composition as production because both are code.
