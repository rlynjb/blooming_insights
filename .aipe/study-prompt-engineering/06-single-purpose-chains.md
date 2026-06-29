# 06 — Single-purpose chains

*Pipeline pattern for LLM chains · Industry standard*

## Zoom out, then zoom in

Pull up the five agents in this codebase. Each one has *one* job. That's not an accident; it's the architectural commitment that makes the whole thing debuggable.

```
  Five agents, five jobs — pulled apart deliberately

  ┌─ user query / scheduled scan ───────────────────────────────────┐
  │                                                                  │
  └────┬──────────────────────────────────────────────────────────┘
       │
       ▼
  ┌─ intent.classifyIntent ──────────────────┐  one job: route the query
  │  haiku-4-5, single-shot, no tools          │  → returns 'monitoring' |
  │  ~30 tokens out                            │    'diagnostic' | 'recommendation'
  └────────────┬─────────────────────────────┘
               │
   ┌───────────┼─────────────┬──────────────────┐
   │           │             │                  │
   ▼           ▼             ▼                  ▼
  monitoring  diagnostic   recommendation     query
   one job:    one job:     one job:           one job:
   detect      explain      propose            answer free-form
   anomalies   ONE anomaly  actions for        question with
                            ONE diagnosis      grounded numbers
   ★          ★            ★                  ★
   one chain  one chain    one chain          one chain
```

Five chains. Five jobs. Composed into a longer flow (intent → monitoring → diagnostic → recommendation, when the user clicks through the UI). The alternative — *one* monolithic agent that does monitoring + diagnostic + recommendation in one prompt — is the version that ships and then dies in production the first time something goes wrong. Single-purpose chains are how you keep agent systems debuggable.

## Structure pass

**Layers.** Outer: the pipeline (the sequence of chains). Middle: the individual chains. Innermost: the per-chain prompt.

**Axis — what happens when something fails.** Walk it down:

```
  one axis — "what does failure mean here?" — three layers, three answers

  ┌─ pipeline (composition) ──────────┐
  │  failure: one chain returned       │  pause, surface, let user
  │  garbage → don't run the next      │  retry just that chain
  └───────────────────────────────────┘
       ┌─ chain (one job) ─────────────┐
       │  failure: parse error / budget │  return [] or null; UI degrades
       │  exhausted / schema mismatch    │  gracefully
       └───────────────────────────────┘
            ┌─ prompt (one purpose) ────┐
            │  failure: model misread     │  shows up in the eval set;
            │  this single job             │  fix is local to ONE .md file
            └────────────────────────────┘
```

The whole reason for the single-purpose discipline is in the bottom layer: **a failure stays local to one prompt file.** Monolithic chains spread their failures across everything.

**Seams.** The biggest seam is between *each chain* in the pipeline. Each chain's output is the next chain's input — those handoffs are the contracts you actually have to engineer. Concept 07 (output-mode mismatch) is exactly the failure mode at this seam.

## How it works

### Move 1 — the mental model

You know how Unix pipes work — `grep | sort | uniq -c`, each program one job, composed into a longer flow? Single-purpose LLM chains are the same shape:

```
  Pattern — the pipeline, Unix-style

  user query
       │
       ▼
  ┌─ intent ─┐   →   "monitoring"
  └──────────┘             │
                            ▼
                  ┌─ monitoring ─┐   →   Anomaly[]
                  └──────────────┘            │
                                               ▼
                                     ┌─ diagnostic ─┐  →  Diagnosis
                                     └──────────────┘         │
                                                                ▼
                                                      ┌─ recommendation ─┐  →  Recommendation[]
                                                      └──────────────────┘
```

Each box: one input shape, one output shape, one job. The whole pipeline is the *composition*. You can swap any single chain without touching the others as long as the input/output shapes hold.

### Move 2 — the walkthrough

**Each chain is a separate class with its own prompt.** Look at the file layout:

```
  lib/agents/
    intent.ts                       — intent classifier (haiku, no tools)
    monitoring.ts                   — anomaly detection
    diagnostic.ts                   — investigation
    recommendation.ts               — proposal
    query.ts                        — free-form Q&A

  lib/agents/legacy-prompts/
    monitoring.md                   — one prompt per chain
    diagnostic.md
    recommendation.md
    query.md
```

Five files, five prompts. Not "one giant prompt with sections." Five *separate* prompts that compose at runtime. This means:

  → A diagnostic prompt change is reviewed in isolation.
  → A monitoring regression doesn't touch the recommendation chain.
  → `git log lib/agents/legacy-prompts/monitoring.md` shows only monitoring-prompt history.

**Each chain has its own tool subset.** The tool registry (`lib/mcp/tools.ts`) defines which MCP tools each agent gets — `monitoringTools`, `diagnosticTools`, `recommendationTools`. The diagnostic agent doesn't have access to the recommendation-only tool `list_scenarios`. The monitoring agent doesn't have access to ancillary detail tools. **Constrained tool surfaces are what make budgets predictable.**

**Each chain has its own budget.** Compare two chains at `lib/agents/diagnostic-legacy.ts:66-68` and `recommendation-legacy.ts:59-61`:

```typescript
// diagnostic
maxTurns: 8,
maxToolCalls: 6,

// recommendation
maxTurns: 6,
maxToolCalls: 4,
```

Different budgets for different jobs. Diagnostic gets 6 tool calls because it's exploratory (testing 2–3 hypotheses). Recommendation gets 4 because it mostly reasons from the diagnosis (with optional checks against existing scenarios). A monolithic agent that did both would need a 12-call budget and the cognitive load of remembering which calls belong to which phase.

**The model-routing benefit — different models for different jobs.** `lib/agents/intent.ts:16`:

```typescript
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
```

The intent classifier uses Haiku — cheap, fast, perfectly capable of one-word classification. The other four agents use Sonnet (`AGENT_MODEL = 'claude-sonnet-4-6'` in `base-legacy.ts:10`). Three reasons this matters:

```
  Per-chain model routing — why it matters

  ┌──────────────┬─────────┬─────────────────────────┐
  │ chain        │ model   │ why                       │
  ├──────────────┼─────────┼─────────────────────────┤
  │ intent       │ haiku   │ one-word classification    │
  │              │         │ → cheap (5x cheaper)        │
  │              │         │ → fast (~200ms)             │
  │              │         │ → adequate                  │
  ├──────────────┼─────────┼─────────────────────────┤
  │ monitoring   │ sonnet  │ multi-step reasoning,       │
  │ diagnostic   │ sonnet  │ tool use, structured        │
  │ recommendation│ sonnet  │ output → needs the          │
  │ query        │ sonnet  │ heavier model               │
  └──────────────┴─────────┴─────────────────────────┘

  if you had ONE agent for all four jobs, you'd pay sonnet prices
  for the intent classification — a 5x markup for no quality lift.
```

**The debugging benefit — failures localize.** When something fails in production, the streaming trace (`StatusLog` in the UI) shows which chain was running. The agent name on every `ToolCall` (`'monitoring'`, `'diagnostic'`, etc., set in `aptkit-adapters.ts:133-141`) means logs are filterable by chain. If diagnosis is producing bad output, you investigate `diagnostic.md` and don't have to wade through monitoring or recommendation logic.

```
  Execution trace — where the bug landed, who owns the fix

  ┌─ user clicks an InsightCard → /investigate/[id] ─────────┐
  │                                                            │
  │  1. fetch /api/agent?step=diagnose                         │
  │     ↓ run DiagnosticAgent                                  │
  │     ↓ stream events: reasoning_step, tool_call_*, diagnosis │
  │  2. (chain 1 succeeded, structured Diagnosis returned)      │
  │                                                             │
  │  3. user clicks "see recommendations →"                     │
  │  4. fetch /api/agent?step=recommend (hands over Diagnosis)  │
  │     ↓ run RecommendationAgent                                │
  │     ↓ FAILS: returns []                                      │
  │                                                              │
  │  fix is local: investigate recommendation.md prompt          │
  │  monitoring + diagnostic + query are untouched               │
  └──────────────────────────────────────────────────────────┘
```

**The handoff contract — typed structured output at each seam.** Look at how `DiagnosticAgent.investigate()` returns `Diagnosis` (`lib/agents/diagnostic.ts:35`) and `RecommendationAgent.propose()` *takes* that `Diagnosis` as input (`lib/agents/recommendation.ts:26-30`):

```typescript
// diagnostic returns Diagnosis
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis>

// recommendation accepts Diagnosis
async propose(
  anomaly: Anomaly,
  diagnosis: Diagnosis,
  hooks: AgentHooks = {},
): Promise<Recommendation[]>
```

The handoff type (`Diagnosis`, defined in `lib/mcp/types.ts`) is the contract between the two chains. Validators (`isDiagnosis` in `lib/mcp/validate.ts`) enforce that contract at the boundary. The two chains can be developed, tested, and reasoned about independently because the seam between them is typed.

**Layers-and-hops view of the whole pipeline:**

```
  Layers-and-hops — five chains, four handoffs, one pipeline

  ┌─ User UI ──────────────────────────────────┐
  │  QueryBox text                              │
  └──────────────┬──────────────────────────────┘
                 │ hop 1: classifyIntent(haiku)
  ┌─ intent ▼ ──────────────────────────────────┐
  │  Intent = 'diagnostic'                      │
  └──────────────┬──────────────────────────────┘
                 │ hop 2: route based on intent
  ┌─ monitoring ▼ ──────────────────────────────┐
  │  Anomaly[] (when triggered by /api/briefing)│
  └──────────────┬──────────────────────────────┘
                 │ hop 3: user clicks an Anomaly card
  ┌─ diagnostic ▼ ──────────────────────────────┐
  │  Diagnosis (conclusion + evidence)          │
  └──────────────┬──────────────────────────────┘
                 │ hop 4: user clicks "see recommendations →"
  ┌─ recommendation ▼ ──────────────────────────┐
  │  Recommendation[] (≤3)                       │
  └─────────────────────────────────────────────┘
```

Every hop is a typed handoff. Every chain is replaceable. The pipeline is the composition; the chains are the parts.

**The failure mode of multi-purpose chains.** This is what you get if you collapse all five into one prompt:

```
  Anti-pattern — the monolithic "do everything" agent

  ┌─ giant prompt ───────────────────────────────────────────┐
  │  "You are an analyst. If the user is asking about what    │
  │   changed, do these queries. If they're asking why, do    │
  │   these. If they want a recommendation, propose actions   │
  │   from these features. Output in the appropriate shape    │
  │   for the question you decided they were asking. Also      │
  │   here are 50 tool calls available."                       │
  └──────────────────────────────────────────────────────────┘

  failure modes:
   - 50-tool budget the model wastes 20 calls "thinking"
   - output mode ambiguous (concept 07 — array? object? markdown?)
   - one prompt change ripples into 4 different jobs
   - one bug means investigating "monitoring OR diagnostic OR..."
   - haiku-cheapness for intent classification is unavailable
```

The monolithic shape isn't *wrong* in a small toy. It's wrong the moment the system has to be debugged in production by someone who didn't write it.

### Move 3 — the principle

Single-purpose chains are the LLM-system version of the single-responsibility principle. The reason it shows up here is the same reason it shows up in any complex system: when failures localize to one component, you can fix them without ripple. When the budget for "what this component does" is bounded, you can reason about the cost. When the input/output shapes are typed, the boundaries are contracts. Composition gives you the system; decomposition gives you the maintainability.

## Primary diagram — five chains, four handoffs, one pipeline

```
  ┌─ Pipeline (UI flow) ─────────────────────────────────────────────────┐
  │                                                                       │
  │  user query                                                            │
  │       │                                                                │
  │       ▼                                                                │
  │  ┌─ intent ─────────────────────┐                                      │
  │  │  classifier · haiku · 1-shot │  no tools, 30 tokens out             │
  │  │  prompt: ~50 tokens          │  → returns Intent                    │
  │  └─────────────┬────────────────┘                                      │
  │                │ Intent                                                 │
  │                ▼                                                        │
  │  ┌─ monitoring ──────────────────┐    ┌─ query ─────────────────────┐│
  │  │  sonnet · 8 turns · 6 calls    │    │  sonnet · 8 turns · 6 calls  ││
  │  │  prompt: monitoring.md         │    │  prompt: query.md             ││
  │  │  → Anomaly[]                    │    │  → prose answer              ││
  │  └─────────────┬─────────────────┘    └──────────────────────────────┘│
  │                │ Anomaly                                                │
  │                ▼                                                        │
  │  ┌─ diagnostic ─────────────────┐                                      │
  │  │  sonnet · 8 turns · 6 calls   │                                      │
  │  │  prompt: diagnostic.md        │                                      │
  │  │  → Diagnosis                   │                                      │
  │  └─────────────┬─────────────────┘                                      │
  │                │ Diagnosis                                                │
  │                ▼                                                          │
  │  ┌─ recommendation ───────────────┐                                       │
  │  │  sonnet · 6 turns · 4 calls    │                                       │
  │  │  prompt: recommendation.md     │                                       │
  │  │  → Recommendation[]             │                                       │
  │  └────────────────────────────────┘                                       │
  │                                                                            │
  │  Each chain: own prompt · own tool subset · own budget · own model         │
  │  Each handoff: typed structured output, validated at the boundary           │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern is sometimes called "agentic decomposition" or "task decomposition" in the literature. The shape is universal across multi-agent frameworks (LangGraph, CrewAI, AutoGen) — each frames it slightly differently, but the underlying move is the same: split the work along axes of *purpose*, give each piece its own prompt and tool surface, compose the results.

What this codebase does NOT do (and which the heavyweight frameworks do):

- **No central orchestrator agent.** LangGraph's "supervisor" pattern has one agent deciding which chain runs next. This codebase uses *code* for that — the routes handler decides which agent to instantiate based on the user's UI action (click anomaly → run diagnostic; click "see recommendations" → run recommendation). Code-as-orchestrator is more debuggable than LLM-as-orchestrator; the price is that the routing logic can't itself reason about whether to invoke a chain.
- **No agent-to-agent communication.** The chains don't talk to each other directly. Their outputs are typed objects (`Diagnosis`, `Recommendation[]`) passed through the route handler. This is a feature — it means each chain can be unit-tested with a fake input.

Where to read next: Anthropic's *"Building effective agents"* post (anthropic.com/engineering/building-effective-agents) is the cleanest treatment of the "chain vs. workflow vs. autonomous agent" distinction. The codebase here is firmly in *workflow* territory (deterministic composition of single-purpose chains), not autonomous-agent territory.

In this codebase, concept 02 (structured outputs) is what makes the handoffs reliable. Concept 07 (output-mode mismatch) is the failure class at chain boundaries. Concept 04 (token budgeting) is why decomposition keeps each chain affordable.

## Interview defense

**Q: "Why five agents instead of one?"**

Four reasons. *(Draw the pipeline diagram.)*

  → **Debugging.** When the output is wrong, the failure is local to one prompt file. Mono-prompt failures could be in any of the four jobs.
  → **Budget.** Each chain has its own tool-call cap (4–6) sized for *its* job. Monolithic would need a 12-call budget and the model would waste calls "thinking" about which phase it was in.
  → **Model routing.** Intent classification runs on Haiku (~5x cheaper than Sonnet). A monolithic agent would pay Sonnet prices for trivial classification.
  → **Typed handoffs.** Each chain's output is the next chain's typed input (`Anomaly` → `Diagnosis` → `Recommendation[]`). The seams are contracts I can validate.

```
  five chains, four handoffs:
  intent → monitoring → diagnostic → recommendation
                     (query is a parallel branch from intent)
```

Anchor: *"single-responsibility, applied to LLM chains. Failures localize, budgets stay tractable, model routing becomes possible."*

**Q: "What's the load-bearing part most people miss?"**

The *constrained tool surface per chain*. The diagnostic agent doesn't have access to `list_scenarios`; the recommendation agent doesn't have access to `execute_analytics_eql`. Cutting the tool surface to what *this chain* needs is what keeps the budget predictable and the prompt focused. If you give every agent every tool, you've collapsed back to a monolithic agent with extra steps.

```
  diagnostic tools                  recommendation tools
  ────────────────                  ────────────────────
  execute_analytics_eql            list_scenarios
  get_event_segmentation           list_initiatives
  list_email_campaigns             list_recommendations
  ...                              list_segmentations
                                   list_voucher_pools
                                   list_email_campaigns
                                   ...
```

Anchor: *"constrained tool surface per chain. Without it, you have a monolithic agent in pieces."*

**Q: "What about latency? Five chains in sequence sounds slow."**

The chains don't all run in sequence on every request. *(Pull up the UI flow diagram.)* Intent runs once per query. Monitoring runs on the briefing scan. Diagnostic runs when the user clicks an anomaly. Recommendation runs when they click "see recommendations" — a deliberate, on-demand action, not a chained block. The serial latency only adds up in the cases where the user is *walking through the pipeline*, and even then the UI streams each chain's reasoning trace immediately (via NDJSON) so perceived latency is fast. If I needed lower latency I could parallelize the monitoring scan by anomaly category, but I haven't needed to.

Anchor: *"on-demand staging, not all chains every request. Streaming gives perceived latency wins on top."*

## See also

- `01-anatomy.md` — each chain's prompt is its own four-section structure.
- `02-structured-outputs.md` — the handoff contracts are typed structured outputs; validators enforce them.
- `04-token-budgeting.md` — single-purpose chains keep budgets tractable; a monolithic agent would blow them.
- `07-output-mode-mismatch.md` — the failure class at chain boundaries; happens when chain A's output mode and chain B's expected input mode disagree.
- `09-chain-of-thought.md` — when a single chain needs internal reasoning, this is the technique; but it's *within* one chain, not across.
