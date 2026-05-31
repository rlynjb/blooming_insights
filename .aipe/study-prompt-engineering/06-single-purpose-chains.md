# Single-purpose chains (one job per link)

**Industry name(s):** single-purpose chains, prompt decomposition, agent specialization, pipeline-of-prompts
**Type:** Industry standard · Language-agnostic

> blooming insights splits the analyst into four single-job agents — detect, diagnose, recommend, answer — each prompt scoping itself and explicitly disclaiming the others (`monitoring.md` L5, `diagnostic.md` L5, `recommendation.md` L5), then chains diagnose→recommend in `route.ts` L145–162. One job per link buys you two things a monolith can't: you always know which link failed, and you can route cheap jobs to a cheap model.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Single-purpose chains span the Pipeline coordinator (where the diagnose→recommend chain is wired in code) and the Per-agent definitions band (where each prompt's `## Role` scopes itself to one verb and disclaims the others). The chain is not a single concept on one band — it is two cooperating mechanisms: scoping declared in the prompts, ordering enforced in `route.ts`. The model never decides "now I'll diagnose"; the code calls the agent and the prompt tells the model to do only that.

```
  Zoom out — where single-purpose chains live

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts (entry)                  │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Pipeline coordinator ──▼────────────────────────┐  ← we are here (ordering)
  │  ★ route.ts L145–162: wired in code ★            │
  │  DiagnosticAgent.investigate → Diagnosis         │
  │       │ typed handoff (L158)                     │
  │       ▼                                          │
  │  RecommendationAgent.propose                     │
  │  agent-tagged trace (L116–131) → failure localizes│
  └─────────────────────────┬────────────────────────┘
                            │  per-agent
  ┌─ Per-agent definitions ─▼────────────────────────┐  ← we are here (scoping)
  │  ★ four ## Roles, each disclaiming the others ★  │
  │  monitoring.md L5 · diagnostic.md L5             │
  │  recommendation.md L5 · query.md L5              │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider ──────────────▼────────────────────────┐
  │  classify→Haiku · agents→Sonnet (per-job routing) │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: how does blooming insights decompose "be an analyst" into separable steps, and what does the decomposition buy beyond tidiness? Two payoffs and two costs. The payoffs: failures localize to a named link (the trace tells you whether the diagnosis or the recommendation went wrong) and per-job model routing becomes possible (Haiku for the classify, Sonnet for the agents). The costs: more round-trips and a lossy typed handoff. Below, you'll see how the `## Role` disclaimers act as typed boundaries between links, why the `Diagnosis` handoff is what makes attribution real, and where decomposition stops paying off.

---

## How it works

**Mental model.** Picture a pipeline where each stage is a prompt scoped to exactly one verb, the stages are wired in code (not by the model deciding what to do next), and each stage's `## Role` carries an explicit disclaimer of the adjacent stages' jobs. The disclaimers are the typed boundaries — they keep a stage from bleeding into its neighbor's responsibility, the way a function signature keeps a transform from also making network calls.

```
detect ──▶ diagnose ──▶ recommend          answer (separate entry)
(monitoring) (diagnostic) (recommendation)   (query)
   │            │             │                 │
   │ "do not    │ "diagnose   │ "do NOT         │ "Never invent
   │  diagnose,  │  causes      │  execute"        │  numbers"
   │  do not     │  only"       │                  │
   │  propose"   │              │                  │
   │             │              │                  │
   ▼            ▼             ▼                 ▼
 each Role disclaims the others' jobs = the typed boundary between links
```

The wiring lives in the route handler; the scoping lives in each prompt's Role. The model never decides "now I'll diagnose" — the code calls the diagnostic agent, and the diagnostic prompt tells the model to do *only* that.

---

### The four single-job prompts

Read the first five lines of each prompt and you have the decomposition:

```
monitoring prompt      "You do not diagnose causes. You do not propose actions.
                        You detect, measure, and report changes — nothing more."
diagnostic prompt      "You do not propose remediation — you diagnose causes only."
recommendation prompt  "You are read-only: you do NOT execute anything —
                        your recommendations are suggestions for a human to act on."
query prompt           "Never invent numbers — only cite figures you genuinely observed"
```

Each agent's job is one verb: **detect**, **diagnose**, **recommend**, **answer**. The disclaimers are load-bearing. Without "You do not diagnose causes," the monitoring agent — being a helpful model — would notice a revenue drop and immediately explain it, then suggest a fix, producing one blob that overlaps the next two agents' jobs. The disclaimer is what keeps the link's output narrow enough to hand to the next link cleanly.

This is the same decomposition rule from → 01-anatomy.md, viewed through the chain: there, the disclaimers are part of the shared anatomy; here, they are the boundaries that make the pipeline composable.

---

### The chain is wired in code, not chosen by the model

The diagnose→recommend chain is plain control flow in the route handler, not an agent deciding what to do next:

```
  # investigation flow (in the route handler)
  diag_agent      = DiagnosticAgent(...)
  diagnosis       = await diag_agent.investigate(inv, hooks_for("diagnostic"))
  send({ type: "diagnosis", diagnosis })

  step_for("recommendation", "thought", "proposing actions based on the diagnosis…")
  rec_agent       = RecommendationAgent(...)
  recommendations = await rec_agent.propose(inv, diagnosis, hooks_for("recommendation"))
  for r in recommendations:
      send({ type: "recommendation", recommendation: r })

  save_investigation(insight_id, collected)
```

The diagnosis (a typed `Diagnosis`) is the output of link one and the input to link two — the recommendation agent's propose method takes it as a positional argument. That handoff is a typed value, not a free-text blob: the diagnostic agent's structured output (→ 02-structured-outputs.md) *is* the boundary the recommendation agent consumes. The query agent is a separate entry point in the route handler, not part of the diagnose→recommend chain — it answers a one-off free-form question.

```
investigation:  resolve_anomaly ─▶ diagnose ─(Diagnosis)─▶ recommend ─▶ save
query:          classify_intent ─▶ answer   (standalone, prose out)
```

Wiring the chain in code (rather than letting one agent orchestrate the others) means the orchestration is deterministic, inspectable, and testable — you can unit-test each agent in isolation with a fake MCP caller, and the chain order is a code path, not a model decision.

---

### Benefit 1 — debugging: you know which link failed

When a final recommendation is wrong, the trace tells you which link produced what. Every streamed event is tagged with its agent name through a per-agent hooks factory in the route handler: `reasoning_step`, `tool_call_start`, `tool_call_end` all carry the agent name. So a bad recommendation has a readable upstream trail:

```
trace (agent-tagged):
  diagnostic   thought  "investigating mobile conversion…"
  diagnostic   tool_call_end  execute_analytics_eql  (the queries it ran)
  diagnosis    { conclusion: "mobile checkout regression", … }   ← link-1 output
  recommendation thought "proposing actions…"
  recommendation { title: "A/B test the desktop flow", … }       ← WRONG, but
                                                                    diagnosis was RIGHT
→ failure localized to the recommendation link, not the diagnosis
```

In a monolith, the same wrong recommendation would be buried in one undifferentiated output and you couldn't tell whether the *detection* missed it, the *diagnosis* misread it, or the *recommendation* mis-acted. The chain makes "which job failed" a question the trace answers. This is the operational payoff I reach for every time: a wrong end-result in a four-job monolith is a debugging dead end; in a four-link chain it's a labeled crime scene.

---

### Benefit 2 — model routing: cheap jobs, cheap model

Single-purpose links let you match each job to the cheapest model that can do it. blooming insights routes the trivial classification to Haiku and the heavy agents to Sonnet:

```
classify_intent → "claude-haiku-4-5"   max_tokens 16, ONE word
the four agents → "claude-sonnet-4-6"  max_tokens 4096, tool loops
```

The intent classifier has one job — map a question to `monitoring | diagnostic | recommendation` — and it's a one-word output, so it runs on the cheap fast model with `max_tokens: 16`. The agents reason over tool results and emit structured artifacts, so they run on the more capable model. If "be an analyst" were one prompt, the trivial classification would ride along on the expensive model for no reason. Decomposition is what makes per-job model selection *possible* — you can't route a job you haven't separated.

```
one prompt:        everything on Sonnet  → pay top-tier for the 16-token classify
decomposed:        classify→Haiku, agents→Sonnet  → spend where capability is needed
```

---

### The failure mode of multi-purpose chains

The counter-case, named plainly. A prompt with two jobs fails in three ways the single-job version doesn't:

```
multi-purpose prompt ("detect AND diagnose AND recommend")
  1. unattributable failure  — wrong output, can't tell which job botched it
  2. no model routing        — the whole blob runs on one (expensive) model
  3. output-mode collision   — detect wants an array, diagnose an object,
                               recommend an array → one prompt can't cleanly
                               declare a single output shape (→ 07)
```

The third is subtle and worth holding onto: the three structured agents emit three *different* shapes (`Anomaly[]`, `Diagnosis`, `Recommendation[]`). A single prompt trying to emit all three at once can't have a clean `## Output` contract, so the validator boundary (→ 02-structured-outputs.md) has nothing crisp to check. Decomposition is what lets each link declare one shape and have one validator.

---

### The principle

One job per link is what turns a probabilistic feature into a debuggable, routable system. The disclaimers in each `## Role` are the typed boundaries between links; the wiring in the route handler makes the order deterministic and testable; the structured handoff (`Diagnosis` from link one to link two) is the typed value crossing the boundary. The payoff is operational, not aesthetic: failures localize to a named link, and each link runs on the cheapest model that can do its one job.

---

## Single-purpose chains — diagram

This diagram spans the prompt layer (four scoped Roles) and the orchestration layer (code-wired chain + standalone query). A reader who sees only this should grasp that each link does one verb, the disclaimers are the boundaries, the diagnosis is a typed handoff, and the trace is agent-tagged so failures localize.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROMPT LAYER — four single-job Roles, each disclaiming the others    │
│                                                                       │
│  monitoring prompt      detect    "not diagnose, not propose"         │
│  diagnostic prompt      diagnose  "diagnose causes only"              │
│  recommendation prompt  recommend "do NOT execute"                    │
│  query prompt           answer    "never invent numbers"              │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  wired in code (not model-chosen)
┌───────────────────────────▼───────────────────────────────────────────┐
│  ORCHESTRATION LAYER — the route handler                              │
│                                                                       │
│   INVESTIGATION:                                                      │
│     resolve_anomaly ─▶ diagnostic_agent.investigate                   │
│                         │ Diagnosis (typed handoff)                   │
│                         ▼                                             │
│                       recommendation_agent.propose                    │
│                         │ Recommendation[]                            │
│                         ▼  save_investigation                         │
│                                                                       │
│   QUERY (standalone):                                                 │
│     classify_intent (Haiku) ─▶ query_agent.answer                     │
│                                                                       │
│   every event tagged with `agent` → failure localizes                 │
│   model routing: classify→Haiku · agents→Sonnet                       │
└──────────────────────────────────────────────────────────────────────┘
```

Each link does one verb; the disclaimers are the boundaries; the diagnosis is a typed value crossing from link one to link two; the agent-tagged trace and per-job model routing are the two payoffs.

---

## Implementation in codebase

**Case A — implemented.**

### The four scoped prompts (the decomposition)

- **File:** `lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md`
- **Function / class:** the `## Role` section of each prompt
- **Line range:** `monitoring.md` L5 ("do not diagnose … do not propose actions"); `diagnostic.md` L5 ("diagnose causes only"); `recommendation.md` L5 ("you do NOT execute anything"); `query.md` L5 ("Never invent numbers").
- **Role:** each prompt scopes itself to one verb and disclaims the adjacent links' jobs — the typed boundaries of the pipeline.

### The chain wiring (diagnose → recommend)

- **File:** `app/api/agent/route.ts`
- **Function / class:** the `ReadableStream` `start()` investigation flow
- **Line range:** L145–162 — `DiagnosticAgent.investigate` (L153), the `Diagnosis` handoff into `RecommendationAgent.propose` (L158), `saveInvestigation` (L162); the standalone query flow at L135–143.
- **Role:** wires the chain in deterministic code; the diagnosis is a typed value passed from link one to link two.

### Model routing per link

- **File:** `lib/agents/base.ts`, `lib/agents/intent.ts`
- **Function / class:** `AGENT_MODEL` vs `CLASSIFIER_MODEL`
- **Line range:** `base.ts` L9 (`claude-sonnet-4-6`, the four agents), `intent.ts` L14 (`claude-haiku-4-5-20251001`, the classifier, `max_tokens: 16` at L20).
- **Role:** the one-job classifier runs on the cheap model; the heavy agents on the capable one — routing made possible by decomposition.

### Agent-tagged trace (failure localization)

- **File:** `app/api/agent/route.ts`
- **Function / class:** `hooksFor(agent)` and `stepFor`
- **Line range:** L116–131 — every `reasoning_step` / `tool_call_start` / `tool_call_end` carries the `agent` name.
- **Role:** the trace attributes each step to its link, so a wrong end-result localizes to the link that produced it.

### Why this is a codebase strength

The decomposition is enforced at two layers: the prompt Roles keep each model in its lane, and the code wiring keeps the orchestration deterministic and unit-testable (each agent takes an injected MCP caller). The typed `Diagnosis` handoff means the boundary between links is a checked shape, not a free-text blob — so a failure on either side of it is attributable.

---

## Elaborate

### Where this comes from

Prompt-chaining and task decomposition are core to both vendors' guidance — Anthropic's docs have a dedicated "chain complex prompts into subtasks" section, and the OpenAI cookbook's agent patterns lead with "give each step one responsibility." The deeper root is the same single-responsibility principle that governs functions and services; LLM chains inherit it because a probabilistic step is *more* prone to drift across responsibilities than a deterministic one, so the discipline matters more, not less. The model-routing payoff is newer and economic: once Haiku-class models got good enough at narrow tasks, routing trivial subtasks to them became the obvious cost win — which only works if the subtasks are separated.

### The deeper principle

```
monolith prompt                    single-purpose chain
────────────────────────────       ────────────────────────────
N jobs, 1 prompt                    1 job, N prompts
wrong output → which job? unknown   wrong output → link is named
one model for everything            cheapest model per job
one fuzzy output contract           one crisp shape per link
```

The unit of debuggability is the link. The moment two jobs share a prompt, you've merged two failure domains and lost the ability to attribute. Decomposition is the price of attribution — and attribution is the price of debuggability.

### Where this breaks down

1. **Chaining multiplies round-trips.** Each link is its own model loop (`runAgentLoop`), so diagnose→recommend is two full agent runs plus their `synthesize()` retries. A monolith would be fewer calls. The chain trades latency/cost for attributability and routing.
2. **The handoff can lose information.** The recommendation agent sees the `Diagnosis` (L158), not the diagnostic agent's full reasoning trace. If a recommendation needs context the diagnosis didn't capture, the lossy boundary hurts — the typed handoff is also a bottleneck.
3. **Disclaimers are advisory.** "You do not diagnose causes" (`monitoring.md` L5) is honored statistically (→ 01-anatomy.md); a model can still bleed across the boundary, and only the downstream validator catches output that doesn't match the link's declared shape.

### What to explore next

- **Conditional chaining:** skip the recommendation link when the diagnosis is `FALLBACK` (no cause found), saving a model run when there's nothing to act on.
- **Per-link model tuning:** route the recommendation link (which mostly reasons from the diagnosis, fewer tool calls) to a cheaper model than the diagnostic link, extending the routing benefit within the agent tier.
- **Richer handoff:** pass a curated slice of the diagnostic trace alongside the `Diagnosis` so the recommendation link has the context the typed boundary drops.

---

## Project exercises

### Skip the recommendation link on an inconclusive diagnosis

- **Exercise ID:** C1.10 (adapted) — conditional chaining.
- **What to build:** in the investigation flow, check whether the `Diagnosis` is the `FALLBACK` (`diagnostic.ts` L15–19, "Insufficient data…") and, if so, skip the `RecommendationAgent.propose` call — there's nothing to act on, so spending a model run on it is waste.
- **Why it earns its place:** demonstrates the chain is composable control flow you can branch, and turns a single-purpose-chain into a conditional one without merging links.
- **Files to touch:** `app/api/agent/route.ts` (L156–159 — guard the recommendation step), `lib/agents/diagnostic.ts` (export a `isFallback` check), `test/` (a flow test asserting no recommendation events on a fallback diagnosis).
- **Done when:** an investigation whose diagnosis is the fallback emits zero `recommendation` events and still sends `done`, and a conclusive diagnosis still runs the recommendation link.
- **Estimated effort:** 1–4hr

### Route the recommendation link to a cheaper model

- **Exercise ID:** C1.10 (adapted) — extend model routing within the agent tier.
- **What to build:** the recommendation agent reasons mostly from the diagnosis with few tool calls (`maxToolCalls: 4`, `recommendation.ts` L57). Add a per-agent model override so the recommendation link can run on a cheaper model than the diagnostic link, measuring whether output quality holds.
- **Why it earns its place:** pushes the per-job routing benefit (currently only classify-vs-agents) one level deeper, which is only possible because the links are separated.
- **Files to touch:** `lib/agents/base.ts` (accept a per-call model param instead of the fixed `AGENT_MODEL`), `lib/agents/recommendation.ts` (pass the cheaper model), `test/agents/recommendation.test.ts`.
- **Done when:** the recommendation link runs on the overridden model while the diagnostic link stays on `AGENT_MODEL`, and existing recommendation tests pass.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"Why split this into multiple prompts instead of one?" tests whether you reach for "cleaner" (junior) or name the operational payoffs (senior): attributable failures and model routing. The strongest answer also names what decomposition costs — round-trips and a lossy handoff — and when you'd merge links back.

### Likely questions

**[mid] "Map the four agents to their one job and show where the scope is declared."**

Monitoring detects (`monitoring.md` L5: "do not diagnose, do not propose"), diagnostic diagnoses (`diagnostic.md` L5: "diagnose causes only"), recommendation proposes (`recommendation.md` L5: "do NOT execute"), query answers free-form (`query.md` L5: "never invent numbers"). Each scope lives in the prompt's `## Role`.

```
detect / diagnose / recommend / answer  — one verb each, declared in ## Role L5
```

**[senior] "A recommendation comes back wrong. How do you tell whether the bug is in the diagnosis or the recommendation?"**

The trace is agent-tagged (`route.ts` L116–131). I read the `diagnosis` event (link-1 output, L154) and check whether the conclusion was correct. If the diagnosis was right and the recommendation was wrong, the failure localizes to the recommendation link. In a monolith the wrong recommendation would be buried in one undifferentiated output and unattributable. The typed `Diagnosis` handoff (L158) is the boundary I check across.

```
diagnosis event RIGHT + recommendation WRONG → failure is in the recommend link
(monolith: one blob → can't attribute)
```

**[arch] "Why does the classifier run on a different model than the agents?"**

Because it's a different job. `classifyIntent` (`intent.ts` L17–31) maps a question to one of three words — `max_tokens: 16` — so it runs on Haiku (L14). The agents reason over tool results and emit structured artifacts, so they run on Sonnet (`base.ts` L9). Decomposition is what makes that routing possible: you can only route a job you've separated. A single analyst prompt would pay top-tier rates for the trivial classification.

```
classify (16 tokens, 1 word) → Haiku    agents (tool loops, JSON) → Sonnet
routing requires the jobs be separated first
```

### The question candidates always dodge

**"What does chaining cost you?"** Round-trips and context. Each link is its own model loop, so the chain is more calls than a monolith, and the typed `Diagnosis` handoff (L158) drops the diagnostic agent's full reasoning — the recommendation link sees the conclusion, not the trail that produced it. Candidates dodge because admitting the cost complicates the "decomposition is just better" story. The honest answer: decomposition buys attribution and routing *at the price of* round-trips and a lossy handoff, and that trade is worth it here because failures must be attributable.

### One-line anchors

- `lib/agents/prompts/monitoring.md` L5 — "do not diagnose … do not propose" — the scoping disclaimer.
- `app/api/agent/route.ts` L145–162 — the diagnose→recommend chain wired in code.
- `app/api/agent/route.ts` L158 — `RecommendationAgent.propose(inv, diagnosis, …)` — the typed handoff.
- `app/api/agent/route.ts` L116–131 — agent-tagged trace events — failure localization.
- `lib/agents/intent.ts` L14 vs `lib/agents/base.ts` L9 — Haiku classifier vs Sonnet agents — per-job routing.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the four links with their one verb each, mark where the diagnose→recommend handoff happens, and name the two payoffs of decomposition (attribution, routing) and the two costs (round-trips, lossy handoff).

### Level 2 — Explain

Out loud: why is the chain wired in `route.ts` L145–162 as code rather than having one agent decide to call the others? What does code-wiring buy for testing and debugging?

### Level 3 — Apply

Scenario: a final recommendation is clearly wrong. Walk the agent-tagged trace (`route.ts` L116–131): which event do you read first to decide whether the *diagnosis* or the *recommendation* link failed, and what does the typed `Diagnosis` handoff at L158 let you check?

### Level 4 — Defend

A reviewer says: "Merge diagnose and recommend into one prompt — it'd be one call instead of two." State what merging would save (a round-trip, full shared context) and what it would cost (unattributable failures, no per-link routing, no crisp single-shape output for the validator), and the condition under which merging would actually be right (two links always run together and never debugged independently — which none of the current four meet).

### Quick check — code reference test

In the investigation flow, what is the typed value passed from the diagnostic link to the recommendation link, and on which line? (Answer: the `Diagnosis` returned by `diagAgent.investigate` (L153) is passed into `recAgent.propose(inv, diagnosis, …)` at `app/api/agent/route.ts` L158 — the typed handoff between the two single-purpose links.)

## See also

→ 01-anatomy.md · → 07-output-mode-mismatch.md · → 02-structured-outputs.md · → 09-chain-of-thought.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
