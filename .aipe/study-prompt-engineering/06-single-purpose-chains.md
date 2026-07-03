# 06 · Single-purpose chains

**Single-purpose agent chain / pipeline pattern / one job per chain — Industry standard**

## Zoom out, then zoom in

Give one agent four jobs and every job it does badly. Give four agents one job each and compose them into a pipeline and you have a system where each stage debugs in isolation, each stage picks the model that fits, and each stage can be swapped without rewriting the others. In this codebase the split is real: monitoring finds anomalies, diagnostic investigates them, recommendation acts on them, query answers free-form user questions. Four agents, four prompts, four eval surfaces.

```
  Zoom out — where single-purpose chains sit

  ┌─ User surface ───────────────────────────────────────────┐
  │  Feed page + Investigate pages + QueryBox                │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Coordinator / route ──▼─────────────────────────────────┐
  │  /api/briefing        → MonitoringAgent                   │
  │  /api/agent (step=…)  → DiagnosticAgent | RecommAgent    │
  │  /api/agent (query)   → classifyIntent → one of the three │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ ★ FOUR SINGLE-PURPOSE AGENTS ★ ─▼──────────────────────┐
  │  MonitoringAgent — anomalies, no diagnosis, no actions   │  ← we are here
  │  DiagnosticAgent — one anomaly's cause, no actions       │
  │  RecommendAgent  — actions from a diagnosis, no analysis │
  │  QueryAgent      — free-form Q&A, no anomaly scanning    │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Each agent has one job named in its role paragraph and one negation naming what it does *not* do. Monitoring says "Do not diagnose causes. Do not propose actions." Diagnostic says "You do not propose remediation." Recommendation says "you do NOT execute anything." The negations are what keep the pipeline from collapsing into one over-eager agent that tries to do all four jobs at once.

## Structure pass

### Axes — the dimension we're tracing

**Where a failure lands.** In a monolith agent that tries to detect + diagnose + recommend, a bad output could originate anywhere in the reasoning chain. In four single-purpose agents composed, a bad diagnosis is *diagnostic's* fault, a bad recommendation is *recommendation's* fault, and the two are debuggable in isolation. Trace this axis and the split shape justifies itself.

### Seams — where failure isolation flips

Three seams:

- **Detection → investigation** — monitoring hands an `Anomaly` to diagnostic. If the anomaly is wrong (e.g. bogus baseline), that's monitoring's bug regardless of what diagnostic does with it. If the anomaly is right and the diagnosis is nonsense, that's diagnostic's bug.
- **Investigation → action** — diagnostic hands a `Diagnosis` to recommendation. Same isolation: bad diagnosis = diagnostic's problem; good diagnosis followed by irrelevant recommendation = recommendation's problem.
- **Intent classification → agent selection** — for the free-form query surface, the classifier picks one of {monitoring, diagnostic, recommendation}. Classifier wrong = a diagnostic-flavored query goes to the recommendation agent = wrong-lever answer that looks superficially plausible.

### Layered decomposition

"Whose fault is a bad output?" traced down:

```
  "Whose fault is this bad output?" — same question, three altitudes

  ┌───────────────────────────────────────────────────┐
  │ outer: end-user complaint                          │  → "the recommendation
  │                                                    │    is wrong"
  └───────────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ middle: which agent produced it?               │  → RecommendationAgent
      │                                                │    OR upstream
      │                                                │    (diagnosis was wrong)
      └───────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ inner: which reasoning step?              │  → tool choice? feature
          │        (available in the ReAct trace)     │    fit? impact estimate?
          └──────────────────────────────────────────┘
```

The single-purpose split lets you answer the middle question in seconds instead of "somewhere in the 6-step chain that also did classification."

## How it works

### Move 1 — the mental model

You know how a Unix pipeline is `grep | awk | sort` — each command does one thing, reads stdin, writes stdout, composes with the next — and if you want to know why the final output is wrong, you comment out the last command, then the second-to-last, until you find the stage that broke? Single-purpose LLM chains are that discipline. Each agent reads a typed input, writes a typed output, and composes with the next through the type system.

```
  Single-purpose chain — the pipeline

  ┌── monitoring ──┐   ┌── diagnostic ──┐   ┌── recommendation ──┐
  │  workspace →   │   │  anomaly →      │   │  diagnosis →        │
  │  Anomaly[]     │──▶│  Diagnosis      │──▶│  Recommendation[]   │
  │                │   │                │   │                     │
  │  find changes  │   │  investigate    │   │  propose actions    │
  │  in the data   │   │  one anomaly    │   │  for one diagnosis  │
  │                │   │                │   │                     │
  │  no diagnosis  │   │  no actions     │   │  no re-diagnosis    │
  │  no actions    │   │                │   │                     │
  └────────────────┘   └────────────────┘   └─────────────────────┘

  each stage: one prompt, one job, one output type, one negation
```

The typed hand-off is the load-bearing part. `Anomaly` → `Diagnosis` → `Recommendation` — the TypeScript types (`lib/mcp/types.ts`) are the contract between stages. Change the contract on one side, the other side stops compiling.

### Move 2 — the step-by-step walkthrough

**Step 1 — each agent's role paragraph names its one job.**

Diagnostic (`@aptkit/prompts/dist/src/diagnostic.js:1-4`):

```
You are a diagnostic investigation agent for an analytics workspace.

Your job is to investigate why one specific anomaly occurred. You generate 2-3 competing hypotheses, query the available tools to test them, and return the best-supported explanation with evidence. You do not propose remediation.
```

Monitoring (`@aptkit/prompts/dist/src/monitoring.js:1-4`):

```
You are an anomaly-monitoring agent for an analytics workspace.

Your job is to detect measurable anomalies only. Do not diagnose causes. Do not propose actions.
```

Recommendation (`@aptkit/prompts/dist/src/recommendation.js:1-2`):

```
You are a recommendation agent for an ecommerce workspace. You are read-only: you do NOT execute anything.
```

Three prompts, three negations. Each one is the fence keeping the agent inside its lane.

```
  Role + negation — the fence per agent

  ┌── monitoring ──────────────────┐
  │  "Detect anomalies only.        │
  │   Do NOT diagnose causes.       │
  │   Do NOT propose actions."      │
  └────────────────────────────────┘
  ┌── diagnostic ──────────────────┐
  │  "Investigate ONE anomaly.      │
  │   You do NOT propose            │
  │   remediation."                 │
  └────────────────────────────────┘
  ┌── recommendation ──────────────┐
  │  "Read-only. You do NOT         │
  │   execute anything."            │
  └────────────────────────────────┘
```

Strip any negation and the agent starts to bleed. Diagnostic without "does not propose remediation" starts appending "and here's what to do next" to every diagnosis. Recommendation without "does not execute" starts saying "I've set up the segment for you" as if it took the action.

**Step 2 — the coordinator composes them.**

For the pre-planned three-stage flow (feed → investigate → recommend), the composition is UI-driven — the user clicks through stages, each step's route handler runs one agent. For free-form Q&A, `classifyIntent` picks which agent to run.

`lib/agents/intent.ts:21-38`:

```ts
export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(anthropic, 'coordinator', sessionId, CLASSIFIER_MODEL, 'agents/intent:classifyIntent'),
    query,
    { signal },
  );
}
```

The classifier is its *own* single-purpose chain — one job (classify into one of three), one model (Haiku 4.5, cheap), one output (`Intent`). It doesn't diagnose or recommend; it routes. This is the pipeline pattern recursing: even the coordinator's decision is itself a single-purpose chain.

```
  Composition — for free-form query

  user query
      │
      ▼
  ┌── classifyIntent ─────────┐   Haiku, one word out
  │   'monitoring'             │
  │   'diagnostic'             │
  │   'recommendation'         │
  └────────┬──────────────────┘
           │
           ▼  switch on intent
  ┌── one of three agents ────┐
  │  Monitoring | Diagnostic  │  Sonnet, full loop
  │  | Recommendation          │
  └───────────────────────────┘
```

**Step 3 — the model choice per chain.**

`lib/agents/base.ts:7`:

```ts
export const AGENT_MODEL = 'claude-sonnet-4-6';
```

`lib/agents/intent.ts:16`:

```ts
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
```

Two models, two roles. The classifier is a cheap fast model because the job is simple (single-word classification) and the volume is high. The three main agents share Sonnet 4.6 because their job is complex (multi-step tool-use investigation) and the volume is low per user. This is the model-routing benefit of single-purpose chains — each chain picks the model that fits its cost/quality point. In a monolith agent you'd have to pick one model for all four jobs; whatever you pick is wrong for at least one.

**Step 4 — the tool policy per chain.**

Each chain has its own tool allowlist. `@aptkit/agent-anomaly-monitoring` (`monitoring-agent.js:9-17`):

```js
export const anomalyMonitoringToolPolicy = {
    capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
    allowedTools: [
        'execute_analytics_eql',
        'get_metric_timeseries',
        'get_segments',
        'get_anomaly_context',
    ],
};
```

Monitoring gets four tools — the analytics queries. Recommendation gets a *different* allowlist — the feature-discovery tools (`list_scenarios`, `list_segmentations`, etc). The MCP server exposes ~50 tools; each single-purpose agent sees only the subset that matches its job. This is least-privilege at the LLM boundary: the agent literally cannot call a tool that's outside its lane.

```
  Tool allowlist per chain — least privilege at the LLM boundary

  monitoring    →  execute_analytics_eql, get_metric_timeseries,
                    get_segments, get_anomaly_context
  diagnostic    →  same analytics tools + get_anomaly_context
  recommendation →  list_scenarios, list_segmentations,
                    list_email_campaigns, list_voucher_pools, ...
  query         →  wider (whatever the intent demands)
```

**Step 5 — the debugging benefit realized.**

`eval/run.eval.ts` runs each stage separately and captures each stage's tool calls, usage, and judgment separately. If case #01's diagnosis judgment fails, you look at `receipt.diagnosisToolCalls` and `receipt.diagnosis` and `receipt.diagnosisJudgment`. If the recommendation judgment fails but the diagnosis judgment passed, you look at `receipt.recommendationToolCalls` and `receipt.recommendations` and `receipt.recommendationJudgments`. Two independent debugging surfaces.

The alternative — a monolith agent that does all three — would have one long trace and no way to say "the reasoning went sideways between the diagnosis step and the recommendation step." That's a real production bug I've watched teams debug for days on monolith chains.

### Move 2 variant — the load-bearing skeleton

The kernel of single-purpose chains is four moves:

```
  one job per prompt → typed hand-off → per-chain tool allowlist → per-chain eval
```

What breaks if you skip each:

- **Skip "one job per prompt"** — you have one Big Prompt™ that does everything. Each iteration risks regressing all four jobs. Eval scores become impossible to interpret ("did the change improve monitoring or hurt recommendation?").
- **Skip "typed hand-off"** — chains pass strings between each other. Chain B parses chain A's output ad-hoc. Every emission drift breaks the next stage. Instead of Anomaly / Diagnosis / Recommendation types, you pass free-form text.
- **Skip "per-chain tool allowlist"** — every agent sees every tool. Monitoring can call `list_email_campaigns` for no reason and burn tokens on irrelevant results. The role paragraph is your only defense, and it's soft.
- **Skip "per-chain eval"** — you eval end-to-end. Regression on one stage looks like generic drift. You can't attribute a failure to a specific chain, so you can't fix it.

Hardening layered on top: model routing (already in this codebase — Haiku for classifier), retry per chain (chain-specific back-off), per-chain observability (already in this codebase — `logSite = agents/<chain>:aptkit-model`).

### Move 3 — the principle

**Composition is what makes complex LLM systems debuggable.** Each chain does one job, and the type of its output is a contract the next chain reads. You don't get to skip the composition step; the alternative is one prompt that does four things badly and no way to tell which of the four is failing on any given output.

## Primary diagram

```
  Single-purpose chains — the full pipeline

  ┌── Coordinator ─────────────────────────────────────────────┐
  │  /api/briefing → MonitoringAgent                            │
  │  /api/agent    → DiagnosticAgent | RecommendationAgent      │
  │  /api/agent q  → classifyIntent → one of the three          │
  └──────────────────────────┬─────────────────────────────────┘
                             │
   ┌─────────────────────────┴─────────────────────────┐
   ▼                         ▼                         ▼
  MonitoringAgent          DiagnosticAgent          RecommendationAgent
  ─────────────           ────────────────          ────────────────────
  workspace →              anomaly →                diagnosis →
  Anomaly[]                Diagnosis                 Recommendation[]

  model: Sonnet 4.6        model: Sonnet 4.6         model: Sonnet 4.6
  tools: [analytics ×4]    tools: [analytics ×4]     tools: [feature-
                                                             discovery ×N]
  role: detect only        role: investigate ONE     role: read-only
        no diagnosis             one anomaly               no execute
        no actions               no remediation
       ─────────────           ────────────────          ───────────────

  ┌── each writes to per-chain eval ──────────────────────────┐
  │  receipt.diagnosisToolCalls | recommendationToolCalls      │
  │  receipt.diagnosisJudgment  | recommendationJudgments      │
  │  regression on one stage → attributable to that stage      │
  └────────────────────────────────────────────────────────────┘

  ┌── classifier is its OWN single-purpose chain ─────────────┐
  │  model: Haiku 4.5 (cheap)                                  │
  │  tools: none                                                │
  │  role: classify query into monitoring | diagnostic |        │
  │        recommendation. Reply with ONLY the one word.        │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The pipeline pattern is old — Unix pipes are its physical-world instance. In LLM systems it became a discipline around 2023 as production teams learned that "one long chain that does everything" was where every incident originated. The counterexample — where a single agent with tool use *is* the right shape — is when the reasoning has to interleave across what would otherwise be separate stages. Blooming's diagnostic agent is such an interleaved shape internally: it hypothesizes, queries, revises, queries again. Within one job (investigate one anomaly), the interleaving is a single agent's ReAct loop. Across jobs (investigate one anomaly, then propose actions), the split is worth it.

The tradeoff single-purpose chains don't get to skip: latency. Four agents composed = four full ReAct loops = 30-60 seconds of end-to-end wall time in Blooming. A monolith agent might finish in 20-30 seconds because it doesn't pay the round-trip between stages. This codebase's answer: stream every stage's reasoning as it happens (NDJSON `AgentEvent` events), so the user sees progress across the whole pipeline instead of a blank screen for 60 seconds. Streaming is what makes the pipeline latency acceptable at the UX layer.

Where I've watched this pattern get abused: too-fine slicing. Someone splits monitoring into "detect", "categorize", and "prioritize" as three separate chains — now you have three prompts to maintain, three eval sets, and the three chains together do the same job as one well-shaped monitoring agent. The heuristic: split when the sub-jobs would use different models, different tools, or would want different eval rubrics. Otherwise the split is ceremony.

Related concepts:
- **Anatomy** (`01-anatomy.md`) — each chain's role paragraph and negation.
- **Output mode mismatch** (`07-output-mode-mismatch.md`) — the specific bug at the typed hand-off.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — per-chain eval surfaces.
- **Prompts as code** (`03-prompts-as-code.md`) — each chain's prompt is its own package.

## Interview defense

**Q: Walk me through the four chains in this codebase. Why these four and not three, or five?**

Four because the domain has four distinct jobs the user cares about: **detect** what changed (monitoring), **explain** why one thing changed (diagnostic), **decide** what to do (recommendation), and **answer** free-form questions (query). Each is a job a human analyst would do in a distinct sitting. Not three because collapsing detect + explain leaves you with one agent doing two jobs — either the detect step becomes shallow because the explain reasoning drags it long, or the explain step becomes wide because the detect step's scope isn't narrow enough. Not five because the sub-jobs within each of these are interleaved reasoning, not separable pipeline stages. Diagnostic's hypothesize → query → revise loop is one job's internal shape; splitting it would just add ceremony.

```
  Four chains — why this split

  detect  ── monitoring   ── volume: 1 per session, all metrics
  explain ── diagnostic   ── volume: 1 per anomaly, one metric
  decide  ── recommendation ── volume: 1 per diagnosis, ~3 recs
  answer  ── query        ── volume: 1 per user question

  each has its own tool allowlist, its own rubric,
  its own model policy (all Sonnet 4.6 currently; the
  classifier that routes to them uses Haiku 4.5).
```

**Q: The recommendation agent starts hallucinating diagnoses instead of using the one it was passed. What's the fix?**

Look at the role paragraph and the input hand-off first. The role says "read-only, no execute" but doesn't say "do not re-diagnose." That's a negation gap. Add "The diagnosis is provided as context. Do not re-analyze; act on it." The other place to check is how the diagnosis is passed in. If the recommendation prompt says something like "here's what happened: {diagnosis}" without a clear delimiter, the model reads it as a suggestion and might override it. Wrapping the diagnosis in a delimiter block or a labeled section (`## The diagnosis to act on`) makes the boundary explicit. This codebase does exactly that at `@aptkit/prompts/dist/src/recommendation.js:35-37`: "## The diagnosis to act on / {diagnosis}".

```
  Role bleed — how to spot it

  agent's actual output ─── contains reasoning that
                            belongs to a neighboring
                            chain's job
              │
              ▼
  fix 1: add a negation to the role paragraph
         ("Do not re-analyze; act on the diagnosis provided")
  fix 2: wrap the passed-in artifact in a labeled section
         so the model reads it as data, not free-form context
```

**Q: What's the load-bearing part people forget?**

The negations. Everyone writes a role paragraph that says "you are a monitoring agent, you detect anomalies." Fine. Then production drift: the monitoring agent starts saying "and I'd recommend investigating this in more depth" at the end of each anomaly. That's a soft recommendation, produced by an agent whose role paragraph *didn't tell it not to*. The negations — "Do not diagnose causes. Do not propose actions." — are what keep each chain in its lane. Every multi-agent system I've shipped has needed at least one negation per role; every one where I forgot had a bleed-through bug within a month.

Anchor: monitoring prompt at `@aptkit/prompts/dist/src/monitoring.js:3-4`.

## See also

- `01-anatomy.md` — the role paragraph and negations.
- `03-prompts-as-code.md` — each chain's prompt as a package.
- `05-eval-driven-iteration.md` — per-chain eval surfaces.
- `07-output-mode-mismatch.md` — the failure at the typed hand-off between chains.
- `12-prompt-injection-defense.md` — least-privilege tool allowlist is a defense-in-depth layer.
