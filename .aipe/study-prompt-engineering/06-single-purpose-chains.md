# Single-purpose chains

**Industry standard** · capability gating, model routing, debuggability

## Zoom out — where the chains live

blooming runs five LLM-backed agents. Each one has one job: monitoring detects anomalies, diagnostic investigates a single anomaly, recommendation proposes actions for a single diagnosis, query answers a free-form question, intent classifies which kind of query a free-form message is. They compose into a longer flow (monitoring → diagnostic → recommendation) but each agent is independently invokable, independently testable, and independently swappable.

```
  Zoom out — five agents, one job each, composed into flows

  ┌─ briefing flow (auto, app/api/briefing) ─────────────────┐
  │   monitoring.scan() ──► Anomaly[]                         │
  └──────────────────────────────────────────────────────────┘

  ┌─ investigation flow (user-clicked, app/api/agent) ───────┐
  │   diagnostic.investigate(anomaly)    ──► Diagnosis        │
  │   recommendation.propose(anomaly, diagnosis) ──► Rec[]    │
  └──────────────────────────────────────────────────────────┘

  ┌─ free-form Q&A (QueryBox, app/api/agent) ────────────────┐
  │   intent.classify(q)              ──► Intent              │
  │   query.answer(q, intent)         ──► prose               │
  └──────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: one chain per job, composed into longer flows. A single mega-agent ("you are an analytics platform; given anything, do everything") would be cheaper to set up and impossible to debug. Single-purpose chains are slower to design and faster to maintain. blooming picked the second. This concept is about why.

## Structure pass

**Layers.** Two altitudes: the *individual agent* (one prompt, one tool registry, one output shape, one validator) and the *composition* (the route that strings agents together with handoff types).

**Axis traced — debuggability.** Hold one question constant: *when the briefing produces a bad result, which chain do I open?*

```
  Axis = debuggability — which chain do I blame?

  ┌─ symptoms in the UI ────────────────────────────────────┐
  │   bad anomaly card            → monitoring agent         │
  │   wrong diagnosis              → diagnostic agent         │
  │   off-base recommendation      → recommendation agent     │
  │   query went off-topic         → query agent              │
  │   wrong agent picked up the Q  → intent classifier        │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ single-purpose chain wins ──▼──────────────────────────┐
  │   the symptom names the chain                            │
  │   you open ONE prompt file                               │
  │   you check ONE tool registry                            │
  │   you read ONE captured trace                            │
  └─────────────────────────────────────────────────────────┘

  contrast: with one mega-agent
  ┌─────────────────────────────────────────────────────────┐
  │   any symptom → "the prompt is bad somewhere"            │
  │   you grep a 3000-line system message                    │
  │   you read a 30-tool registry                            │
  │   you reason about why this agent didn't run that branch │
  └─────────────────────────────────────────────────────────┘
```

**Seams.** Two. Each agent's input/output (a typed handoff like `Anomaly` → `Diagnosis` → `Recommendation`) is one seam — the contract that lets you swap an agent without touching the rest of the chain. The tool-registry seam (`lib/mcp/tools.ts`) is the other — each agent gets only the tools its job needs, which keeps the prompt's tool catalog manageable and bounds the failure modes the agent can produce.

## How it works

### Move 1 — the chain pattern

You know how a Unix pipeline composes single-purpose programs (`cat`, `grep`, `sort`, `uniq`)? Each does one thing, well, and outputs to stdout for the next thing to consume. Single-purpose LLM chains are the same shape, scaled to agents. Each agent has one input shape, one output shape, and one job — and the composition is just calling the next one with the previous one's output.

```
  Pattern — chains as a pipeline of typed handoffs

  ┌─ monitoring ──┐    Anomaly[]    ┌─ diagnostic ──┐    Diagnosis
  │ one job:      ├──────────────►──┤ one job:      ├──────────────►
  │ detect        │                  │ investigate   │
  │ output: A[]   │                  │ output: D     │
  └───────────────┘                  └───────────────┘

  ┌─ recommendation ──┐    Recommendation[]
  │ one job:           ├──────────────────►
  │ propose actions    │
  │ output: R[]        │
  └────────────────────┘

  each box has:
    - one prompt file
    - one tool registry
    - one output shape
    - one type guard
    - one place to debug
```

### Move 2 — each agent has one tool registry

Read `lib/mcp/tools.ts`. The whole file is per-agent allowlists:

```
  // lib/mcp/tools.ts (excerpt) — capability gating per agent
  ┌────────────────────────────────────────────────────────────┐
  │ const monitoringToolsBloomreach = [                         │
  │   'list_dashboards', 'get_dashboard',                       │
  │   'list_trends', 'get_trend',                               │
  │   'list_funnels', 'get_funnel',                             │
  │   'execute_analytics_eql',                                  │
  │   'get_customer_prediction_score',                          │
  │ ] as const;                                                  │
  │                                                              │
  │ const diagnosticToolsBloomreach = [                         │
  │   'execute_analytics_eql',                                  │
  │   'get_funnel', 'get_event_segmentation',                   │
  │   'list_customers', 'list_customer_events',                 │
  │   'list_email_campaigns', 'list_experiments',               │
  │   'list_scenarios',                                         │
  │   'list_catalog_items', ...                                 │
  │ ] as const;                                                  │
  │                                                              │
  │ const recommendationToolsBloomreach = [                     │
  │   'list_scenarios', 'get_scenario',                         │
  │   'list_initiatives', 'get_initiative_items',               │
  │   'list_recommendations', 'get_recommendation',             │
  │   'list_segmentations', 'list_email_campaigns',             │
  │   'list_voucher_pools',                                     │
  │   'get_frequency_policies',                                 │
  │ ] as const;                                                  │
  └────────────────────────────────────────────────────────────┘
```

The monitoring agent gets the *measurement* tools. The diagnostic agent gets the *segmentation* and *catalog* tools. The recommendation agent gets the *Bloomreach-feature-catalog* tools. No agent gets the full set. The free-form query agent gets the union (it could be asked anything) — but that's the exception that proves the rule, because the query agent is also the one that doesn't produce structured output.

Two benefits compound. **Prompt clarity** — the monitoring prompt doesn't need to say "don't call `list_voucher_pools`, you're not the recommendation agent." It can't; the tool isn't in its registry. **Failure containment** — the monitoring agent literally cannot create a voucher (it can't call the tool that would). The capability boundary is enforced at the SDK call, not at the prompt-reasoning layer.

This is the *capability gating* pattern: limit what the agent can do by limiting what tools it can call. It's stronger than telling the model "don't do X" because it doesn't depend on the model obeying.

### Move 2 — the handoff types

The chain's contracts live in `lib/mcp/types.ts`:

```
  // lib/mcp/types.ts — the handoff types
  ┌────────────────────────────────────────────────────────────┐
  │ export interface Anomaly { ... }              ← monitoring out
  │   metric, scope, change, severity, evidence, impact?       │
  │                                                              │
  │ export interface Diagnosis { ... }            ← diagnostic out
  │   conclusion, evidence, hypothesesConsidered,               │
  │   affectedCustomers?, timeSeries?, confidence?              │
  │                                                              │
  │ export interface Recommendation { ... }       ← recommendation out
  │   id, title, rationale, bloomreachFeature,                  │
  │   steps, estimatedImpact, confidence, ...                   │
  └────────────────────────────────────────────────────────────┘
```

Each interface is a contract between agents. Diagnostic takes `Anomaly` in, produces `Diagnosis` out. Recommendation takes both `Anomaly` and `Diagnosis` in, produces `Recommendation[]` out. The handoff is typed; the chain is verifiable at compile time; swapping one agent for another (e.g. trying a different recommendation prompt) requires only that the new agent matches the same input/output signature.

The contracts also constrain what each agent's prompt has to say. The diagnostic prompt doesn't need to explain what an `Anomaly` looks like — the TypeScript type does that — it only needs to explain what to *do* with one. That keeps the prompt focused on the job, not on the data format.

### Move 2 — model routing per agent

Single-purpose chains let you size the model to the job. blooming does this in two places:

```
  // lib/agents/base.ts:7 + intent.ts:16
  ┌────────────────────────────────────────────────────────────┐
  │ export const AGENT_MODEL = 'claude-sonnet-4-6';            │
  │ // ─── monitoring, diagnostic, recommendation, query use ──│
  │                                                              │
  │ const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';      │
  │ // ─── intent uses the cheap classifier model ─────────────│
  └────────────────────────────────────────────────────────────┘
```

The intent classifier is a one-word output picker. Sonnet would be overkill; Haiku does it in 16 tokens for fractions of a cent. The other agents do multi-step reasoning over tool results — Haiku might cut corners; Sonnet earns its place. That's only possible *because* intent is its own agent with its own model constant. A mega-agent that "classifies + investigates + recommends" would have to use the most-capable model for the whole chain, paying the Sonnet cost for the work that Haiku could do.

### Move 2 — the failure mode of multi-purpose chains

The counterexample worth holding: what if monitoring, diagnostic, and recommendation were one agent? You'd write one prompt that says "first detect anomalies, then for each anomaly investigate it, then propose actions." It would work. It would also:

- **Blow the token budget.** The conversation history would carry every monitoring tool result, every diagnostic tool result, every recommendation tool result, all into the final turn. Sonnet's 200K context is generous; this still eats most of it on a multi-anomaly briefing.
- **Make partial failure expensive.** If the recommendation step fails, you've already paid for the monitoring + diagnostic tokens — and you have to retry the whole chain. With separate agents, only the failing step retries.
- **Make debugging hard.** "The briefing said the wrong thing" gives you no signal about which phase went off. You'd read the whole trace, find the phase, then start reading the prompt — and the prompt is the union of three jobs, so you can't tell which sentence caused the drift.
- **Make iteration slow.** Tweaking the monitoring rules means re-testing the whole 3-phase chain to make sure you didn't accidentally break recommendation. With separate agents, the monitoring eval suite covers monitoring; recommendation evaluates separately.

```
  Comparison — multi-purpose vs single-purpose

  ┌─ multi-purpose mega-agent ───────────────────────────────┐
  │   1 prompt (huge), all tools available, one big context  │
  │   debugging: which sentence in the prompt caused this?   │
  │   iteration: every change risks every other behavior     │
  │   cost: must use the biggest model for the whole chain   │
  │   failure: a late-stage failure costs all the prior work │
  └──────────────────────────────────────────────────────────┘

  ┌─ single-purpose chain ───────────────────────────────────┐
  │   3 prompts, each focused, per-agent tool registry       │
  │   debugging: the failing output names the failing agent  │
  │   iteration: scoped to one prompt, one eval suite        │
  │   cost: model sized per job (sonnet for hard, haiku for  │
  │         cheap)                                            │
  │   failure: only the failing step retries                 │
  └──────────────────────────────────────────────────────────┘
```

### Move 2 — the coordinator pattern (the routing agent)

The intent classifier *is* a single-purpose chain that exists *specifically* to route. It does one thing: take a user query, produce one of three labels. The query agent then runs with that label baked into its prompt's `{intent}` slot. The pattern: a tiny, cheap, fast classifier in front of an expensive, slow generator, routing the work.

```
  // app/api/agent/route.ts:250-255 — the routing call
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  stepFor('coordinator', 'thought',
          `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  const answer = await queryAgent.answer(q, intent, { ... });
```

The classifier costs ~$0.0001 and ~300ms. It buys you a focused prompt downstream (the query agent's prompt has a `{intent}` slot that frames the answer differently for monitoring vs diagnostic vs recommendation questions). Without the classifier, the query agent's prompt would have to handle all three framings simultaneously — longer, drift-prone, harder to iterate.

This is one of the most reused single-purpose-chain patterns in production LLM apps: *cheap classifier in front, expensive specialist behind*. blooming uses it in exactly one place; you'll see it in every LangChain demo and every production RAG app.

### Move 3 — the principle

Single-purpose chains are how you keep prompt engineering tractable at scale. One job per chain, one tool registry per chain, one output shape per chain, one model per chain. Compose into longer flows with typed handoffs. The cost is more files; the benefit is everything else — debugging by symptom name, iteration scoped to one prompt, cost sized to the job, failure containment per phase. The teams that try to consolidate to fewer-bigger agents are the teams that end up debugging by archaeology.

## Primary diagram

```
  Single-purpose chains — five agents, the contracts between them

  ┌─ briefing route ──────────────────────────────────────────────┐
  │  app/api/briefing/route.ts                                     │
  │                                                                 │
  │  ┌─ monitoring ──────────────────────────────────────────┐    │
  │  │  prompt:   legacy-prompts/monitoring.md                │    │
  │  │  tools:    monitoringTools (measurement)               │    │
  │  │  model:    claude-sonnet-4-6                            │    │
  │  │  output:   Anomaly[]                                    │    │
  │  │  guard:    isAnomalyArray                               │    │
  │  └────────────────────────────────────────────────────────┘    │
  └────────────────────────────┬───────────────────────────────────┘
                               │  Anomaly (user clicks one)
  ┌─ agent route (step=diagnose) ▼────────────────────────────────┐
  │  app/api/agent/route.ts                                        │
  │                                                                 │
  │  ┌─ diagnostic ─────────────────────────────────────────┐     │
  │  │  prompt:  legacy-prompts/diagnostic.md                │     │
  │  │  tools:   diagnosticTools (segmentation + catalog)    │     │
  │  │  model:   claude-sonnet-4-6                            │     │
  │  │  output:  Diagnosis                                    │     │
  │  │  guard:   isDiagnosis                                  │     │
  │  └───────────────────────────────────────────────────────┘     │
  └────────────────────────────┬───────────────────────────────────┘
                               │  Diagnosis (passed forward)
  ┌─ agent route (step=recommend) ▼───────────────────────────────┐
  │  ┌─ recommendation ─────────────────────────────────────┐     │
  │  │  prompt:  legacy-prompts/recommendation.md            │     │
  │  │  tools:   recommendationTools (Bloomreach features)   │     │
  │  │  model:   claude-sonnet-4-6                            │     │
  │  │  output:  Recommendation[]                             │     │
  │  │  guard:   isRecommendationArray                        │     │
  │  └───────────────────────────────────────────────────────┘     │
  └────────────────────────────────────────────────────────────────┘

  ┌─ free-form Q&A (separate flow) ────────────────────────────────┐
  │  ┌─ intent (classifier) ───────────┐  ┌─ query ────────────┐   │
  │  │  prompt: inline                  │  │  prompt: query.md  │   │
  │  │  tools:  none                    │──┤  tools: union      │   │
  │  │  model:  claude-haiku-4-5        │  │  model: sonnet-4-6 │   │
  │  │  output: 'monitoring' |          │  │  output: prose     │   │
  │  │          'diagnostic' |          │  │  no guard          │   │
  │  │          'recommendation'        │  └────────────────────┘   │
  │  │  max_tokens: 16                  │                            │
  │  └──────────────────────────────────┘                            │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern of small classifier + big specialist shows up in every production LLM stack worth studying. Linear's AI feature picks a route before generating; Notion's AI does the same. The reason is the same one blooming exercises: routing is a small, well-defined problem (pick one of N labels) where a cheap model is plenty; specialization is an open-ended generation problem where the expensive model earns its place. Combining them in one model wastes the cheap step and degrades the expensive one (because the model has to context-switch between routing and generating).

The capability-gating angle (per-agent tool registries) connects directly to the prompt-injection concept (concept #12). An agent that can't call `list_customers` can't be tricked into dumping the customer database, no matter what the user types. That's defense in depth: the prompt says "don't do X," the tool registry makes X unavailable. Belt and suspenders.

LangChain's "chains" abstraction is the bookended version of this pattern. blooming doesn't use LangChain (the agents are hand-written), but the conceptual moves — typed input/output per agent, composition by route, per-agent tool registry — are the same. The hand-written version is easier to debug (no abstraction between you and the SDK call) and harder to scale (no framework conventions for adding agents). For a five-agent system, hand-written wins. For a fifty-agent system, you'd reach for a framework.

The five-shape system-design portfolio the reader has shipped lines up with this pattern: each project is single-purpose at the system level (dryrun is a flashcard scheduler, not a generic note-taking platform; contrl is a rep counter, not a general fitness app). The instinct that drove those choices is the same instinct that should drive single-purpose chain design in LLM systems. Resist the urge to "make this one agent more capable"; reach for "give this one job a better-suited agent."

## Interview defense

**Q: Why not consolidate monitoring + diagnostic + recommendation into one agent that does the full briefing?**

A: Four reasons that show up the day after you'd ship the consolidation. **Cost** — the unified prompt would have to use the most-capable model for the whole chain, including the parts a cheaper model could do (anomaly *detection* is mostly threshold math; *diagnosis* needs more reasoning; *recommendation* needs domain breadth). Splitting them lets you size each agent to its job; blooming uses Sonnet across the structured agents but Haiku for the intent classifier — the savings are real. **Debuggability** — when the briefing produces a bad recommendation, "which agent caused it" is answerable in one query: open the recommendation prompt. With one mega-agent, you'd grep a 3000-line system message and read a 30-tool registry to figure out which sentence drifted. **Failure containment** — a recommendation-phase failure today costs only the recommendation tokens; a unified failure costs the monitoring + diagnostic tokens too, and retrying means redoing all the prior work. **Iteration speed** — tweaking the monitoring rules today is scoped to one prompt and one eval (when one exists); in a mega-agent, every monitoring change risks every other behavior, and you can't iterate confidently. Single-purpose chains are slower to design once and faster to iterate forever. That tradeoff almost always favors single-purpose.

```
  what I'd sketch:

  mega-agent:    one prompt   →  every change risks every behavior
                 one model    →  pay expensive-model rate for cheap work
                 one trace    →  symptom doesn't name the cause

  chain of 3:    3 prompts    →  each change scoped to one behavior
                 3 models     →  size each model to its job
                 3 traces     →  symptom names the chain to open
```

**Q: What's the role of the intent classifier — why have a separate agent for it?**

A: The classifier exists because the query agent's prompt is *better* when it can frame the answer around a known intent (monitoring vs diagnostic vs recommendation). Without a classifier, the query agent's prompt would have to handle all three framings simultaneously — longer, drift-prone, harder to iterate. With a classifier, the query prompt's `{intent}` slot gets filled with one of three values, and the rest of the prompt can lean on that. The classifier itself is the simplest possible LLM call: 16 max_tokens, Haiku model, one-word output. Costs essentially nothing per call, runs in ~300ms, buys real prompt quality downstream. It's the canonical *cheap router + expensive specialist* pattern that shows up everywhere in production LLM apps. blooming uses it in one place; many systems use it in several.

```
  cheap router · expensive specialist — the production routing pattern:

  ┌─ classifier ──────┐    label    ┌─ specialist ────────┐
  │ haiku · 16 tokens │ ──────────► │ sonnet · 4096 tokens │
  │ 300ms · ~$0.0001  │              │ 8s · ~$0.05         │
  └───────────────────┘              └─────────────────────┘

  why split: the specialist's prompt becomes simpler & sharper
             when the framing is decided upstream
```

## See also

- [01-anatomy.md](./01-anatomy.md) — each chain has its own anatomy; the prompt files are per-agent
- [02-structured-outputs.md](./02-structured-outputs.md) — the typed handoff between chains is what makes composition work
- [04-token-budgeting.md](./04-token-budgeting.md) — per-agent tool registries help keep the token surface manageable
- [12-prompt-injection-defense.md](./12-prompt-injection-defense.md) — capability gating is also an injection defense
