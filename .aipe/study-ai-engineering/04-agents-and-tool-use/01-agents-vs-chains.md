# Agents vs chains

**Industry name(s):** agentic tool-use loop vs prompt chain, orchestration topology, LLM-decides-control-flow vs code-decides-control-flow
**Type:** Industry standard · Language-agnostic

> blooming insights uses both shapes deliberately: a deterministic CHAIN sequences the agents at the top (diagnostic→recommendation, run as two separate `/api/agent` calls — `step=diagnose` then `step=recommend` — with the diagnosis handed between them), and inside each node an AGENT loop lets the model decide which tools to call and how many — chain at the top, bounded agent at each node.

**See also:** → 02-tool-calling.md · → 03-react-pattern.md · → 04-tool-routing.md · → 06-error-recovery.md · → ../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md

---

## Why care

You have written two kinds of async control flow. The first is a fixed pipeline you wrote by hand: `const a = await stepOne(input); const b = await stepTwo(a); return stepThree(b)` — the order is hard-coded in your TypeScript, and you, the author, decided every step at write-time. The second is a `while` loop whose continuation depends on data you do not have until runtime: paginating until the server stops returning a `nextPageToken`, where the *response* decides whether you loop again. Both are valid. The difference is **who owns the control flow** — your code, or the data coming back.

The question this file answers: when do you let the LLM decide the next step (an agent), and when do you fix the sequence in code (a chain)?

**Answering it matters because the two failure modes are opposite, and choosing wrong is expensive in both directions.** A chain is predictable, debuggable, and cheap — but it cannot adapt; if the next step depends on what the previous step *found*, a chain forces you to either over-fetch everything up front or build a combinatorial tree of `if` branches. An agent adapts — it reads the evidence and decides what to query next — but it can loop forever, burn tokens exploring dead ends, and produce non-deterministic traces that are hard to test. The right architecture is almost never "all agent" or "all chain." It is a chain of agents: a deterministic spine where each vertebra is a bounded agent.

Before naming the two shapes, here is the same investigation expressed each way:

```
Pure chain (no model decides anything):           Pure agent (model decides everything):
─────────────────────────────────────────         ─────────────────────────────────────────
run query_funnels  (always)                        loop:
run query_events   (always)                          model: "which tool next? when do I stop?"
run query_segments (always)                          run whatever it picked
synthesize(all three results)                        feed result back
                                                     until model says "done"
adaptive? NO — same 3 queries every time           adaptive? YES — but unbounded, untestable
```

blooming insights picks neither extreme. It runs a 2-step chain (`investigate` then `propose`) where each step is an agent that runs a *bounded* loop. The two steps are even split across two HTTP requests — `step=diagnose` runs only the diagnostic agent, `step=recommend` runs only the recommendation agent on the diagnosis handed over from step 2 — so the chain order is enforced by the route's `step` param, not just by code sequencing. One-line summary: **the topology is a chain; the nodes are agents; the boundary between them is the source of both predictability and adaptivity.**

---

## How it works

**Mental model.** Think of the route as a `step`-keyed dispatcher and each agent as a `useReducer` whose actions are chosen at runtime by a model instead of by user clicks. The outer flow is deterministic — diagnostic always runs before recommendation, and the `step` param enforces it: `step=diagnose` produces the diagnosis, `step=recommend` consumes it. The inner flow is data-driven — you cannot read `base.ts` and know how many tool calls the model will make, because that depends on what the model sees.

```
TOP LEVEL = CHAIN (code owns the order)            NODE LEVEL = AGENT (model owns the order)
────────────────────────────────────────          ────────────────────────────────────────
route.ts (split across two calls):                  runAgentLoop (base.ts):
  step=diagnose:                                      for turn in maxTurns:
    diagnosis = await diag.investigate(inv)             res = model.create(messages + tools)
    send(diagnosis)  → stashed for step 3              if res has tool_use:
  step=recommend:                                         run them, feed back  ← model chose
    recs = await rec.propose(inv, diagnosis)            else: return            ← model chose
    for r in recs: send(r)
fixed: always diagnose → recommend                   variable: 0..6 tool calls, model decides
```

There is a THIRD shape hiding inside the second one: when an agent's loop fails to emit valid JSON, the agent runs a dedicated tool-less `synthesize()` call. That `runAgentLoop(...)` then `synthesize(...)` pair is a 2-step **micro-chain** — a fixed sequence inside a single agent. So blooming insights uses all three at once: chain of agents (route), agent loop (base), micro-chain (diagnostic/recommendation synthesize).

---

### The chain at the top (route.ts)

The route is the only place agents are sequenced, and it does so with plain `await` gated on the `step` param. There is no graph library, no state machine, no framework — `step=diagnose` runs node 1, `step=recommend` runs node 2 on the handed-over diagnosis, and a `step==null` combined run (dev demo-capture only) runs both back to back.

```
app/api/agent/route.ts — start(controller)  (L170–L254)
─────────────────────────────────────────────────────────
 if (q && !insightId)                          ← branch A: free-form query  (L210)
   classifyIntent(anthropic, q)                  (one agent, see 04-tool-routing.md)
   QueryAgent.answer(q, intent)                  L214
   send(done); return                            L216–217

 else (insightId path)                          ← branch B: investigation chain
   if (step !== 'recommend')                      ← node 1: diagnose only  (L231)
     diagnosis = await DiagnosticAgent.investigate(inv)   L238
     send({ type:'diagnosis', diagnosis })               L239  → stashed for step 3
   if (step !== 'diagnose')                        ← node 2: recommend only  (L244)
     diagnosis = parseDiagnosis(diagnosisParam)            (handed over on step 3)
     recs = await RecommendationAgent.propose(inv, diagnosis)  L247 (consumes node 1)
     for r of recs: send({ type:'recommendation', recommendation:r })  L248
   send({ type:'done' })                          L251
   if (step == null) saveInvestigation(insightId, collected)  L254  ← combined run only
```

The order is hard-coded. `propose` receives `diagnosis` as an argument (route.ts L247) — the data flows through a function parameter, not a shared blackboard. On the two-step path the diagnosis crosses an HTTP boundary: `step=diagnose` emits the `diagnosis` event, the client stashes it (`bi:diag:<id>` in sessionStorage), and `step=recommend` reads it back via `parseDiagnosis(diagnosisParam)` (route.ts L227) before running node 2. Either way it is a chain in its purest form: step N+1 reads step N's typed output. Note the morning-briefing's *third* agent, monitoring, runs in a different route (`app/api/briefing/route.ts`) and produces the `Insight` rows that become the `insightId` this route investigates — the full briefing pipeline monitoring→diagnostic→recommendation is a chain spread across two routes.

---

### The agent at each node (runAgentLoop)

Inside `investigate` and `propose`, control flow inverts. `runAgentLoop` (`base.ts` L48–L176) does not know how many tools will run. It sends the conversation to Claude, and Claude's response decides whether the loop continues.

```
base.ts — for (turn=0; turn<maxTurns; turn++)   (L85–L172)
─────────────────────────────────────────────────────────
 res = anthropic.messages.create(messages, tools?)   L102
 messages.push(assistant: res.content)               L105
 toolUses = res.content.filter(b => b.type==='tool_use')  L116
 if (toolUses.length === 0) return { finalText }     L121–124  ← MODEL ended the loop
 for tu of toolUses:                                 L129       ← MODEL chose these tools
   mcp.callTool(tu.name, tu.input)                   L144
 messages.push(user: toolResults)                    L171       ← loop again, model decides next
```

The line that makes this an agent and not a chain is L121: `if (toolUses.length === 0) return`. The model, not the code, signals termination by *choosing not to emit a tool-use block*. A chain has no equivalent line — its termination is the last statement in the function.

The loop is bounded, which is what makes it safe (see 06-error-recovery.md): `maxTurns = 8` (L73), and a per-agent `maxToolCalls` budget (diagnostic 6, recommendation 4) that flips `forceFinal` to strip the tools and force a text-only answer. So the node is an agent — the model owns the path — but a *bounded* one: the budget is the guardrail that a chain does not need because a chain cannot run away.

---

### The micro-chain inside an agent (synthesize)

When `runAgentLoop` returns text that does not parse as the required JSON shape, `DiagnosticAgent.investigate` runs a second, dedicated model call: `synthesize()` (`diagnostic.ts` L87–L126). That second call has no tools and no loop — it is a single deterministic step that takes the gathered evidence and asks for JSON only.

```
DiagnosticAgent.investigate  (diagnostic.ts L45–L83)
─────────────────────────────────────────────────────────
 step 1 (AGENT):  runAgentLoop(...)         → { finalText, toolCalls }   L51
 step 2 (CHAIN):  tryParseDiagnosis(finalText)        ← parse the loop output  L75
                  ?? await synthesize(anomaly, toolCalls)  ← fixed fallback call  L75
                  ?? FALLBACK                          ← static default          L75
 step 3 (DERIVE): diagnosisConfidence(diag), downgraded if any query errored  L80–82
```

Steps 1→2 are a 2-step micro-chain: a variable-length agent loop followed by a fixed synthesis step (then a deterministic `confidence` derivation appended to the result). `recommendation.ts` L69–L73 has the identical shape minus the confidence step. This is the cleanest demonstration of "chain of agents" at the smallest scale — one agent's public method is itself an agent step chained to a deterministic step.

---

### Current state vs future state

Today the chain is exactly two business steps (`investigate → propose`), run as two `step`-gated calls, plus the monitoring step in the sibling route. The `step` param plus a plain `await` per node is the right tool: there is no branching, no parallelism, no conditional skip. The diagnosis now carries a derived `confidence` field (`diagnostic.ts` L80–82), but the route does *not* branch on it — `step=recommend` runs regardless. The moment the chain needs to *branch* — for example, "if `diagnosis.confidence` is low, re-investigate with a different tool subset instead of recommending" — the `step`-gated `if/await` structure becomes a hand-rolled state machine and should move to a graph runner (LangGraph). That breakpoint is named in Tradeoffs; it has not been crossed.

---

### The principle

**Push control flow down to the model only where adaptivity pays for its unpredictability.** The top-level order (diagnose then recommend) never changes, so it lives in code where it is readable and testable. The query path within a diagnosis *does* change per anomaly, so it lives in the model where it can adapt. The dividing line is not "use agents" or "use chains" — it is "make the deterministic parts deterministic and bound the adaptive parts." Every layer of blooming insights' orchestration restates this: deterministic spine, bounded adaptive nodes.

---

## Agents vs chains — diagram

The diagram spans three layers. The Route layer is a chain (fixed order). The Agent layer is where each node runs an agent loop (model-chosen order). The micro-chain (loop → synthesize) lives inside the Agent layer. The Provider boundary is where the model's decisions become real API calls.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER (CHAIN — code owns order, gated by ?step)   route.ts     │
│                                                                       │
│  branch A: q only ───→ classifyIntent ─→ QueryAgent.answer ─→ done    │
│  branch B: insightId                                                  │
│   step=diagnose:  await DiagnosticAgent.investigate(inv) ──┐ (node 1) │
│                   send(diagnosis) → client stashes bi:diag │          │
│   step=recommend: parseDiagnosis(diagnosisParam) ←─────────┘          │
│                   await RecommendationAgent.propose(inv,    (node 2,   │
│                          diagnosis) ──→ send(recs) ──→ done  consumes 1)│
└───────────────────────────────┬───────────────────────────────────────┘
                                │ each node is an agent
┌───────────────────────────────▼───────────────────────────────────────┐
│  AGENT LAYER (AGENT — model owns order)   lib/agents/                  │
│                                                                       │
│  investigate() / propose():                                          │
│   ┌─────────────────────────────────────────────────────────┐        │
│   │ runAgentLoop (base.ts L85–172)   ← variable # of steps   │        │
│   │   for turn in maxTurns:                                  │        │
│   │     model decides: emit tool_use?  ──yes──→ run, feed back│        │
│   │                                    ──no───→ return text   │        │
│   │   bounded by maxToolCalls (6 / 4)                        │        │
│   └───────────────────────┬─────────────────────────────────┘        │
│                           │ finalText, toolCalls                       │
│   MICRO-CHAIN (fixed 2 steps inside the agent):                       │
│     tryParse(finalText) ?? await synthesize(toolCalls) ?? FALLBACK    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ mcp.callTool(name, args)
┌───────────────────────────────▼───────────────────────────────────────┐
│  PROVIDER BOUNDARY   lib/mcp/ + @anthropic-ai/sdk                     │
│  Anthropic Messages API (model decisions)  ·  Bloomreach MCP (tools)  │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: the route is fixed, the nodes adapt, and the adaptation is bounded.

---

## In this codebase

**Case A — implemented.** Both topologies coexist; this is the defining architectural choice of the codebase.

### The chain (top-level orchestration)

- **File:** `app/api/agent/route.ts`
- **Function / class:** `GET` → the `ReadableStream` `start(controller)` body, gated by the `step` param
- **Line range:** L231–L240 (`step=diagnose` node 1); L244–L249 (`step=recommend` node 2); L210–L218 (single-agent query branch); `saveInvestigation` gated on `step == null` at L254
- **Role:** Runs `DiagnosticAgent.investigate` on `step=diagnose` and `RecommendationAgent.propose` on `step=recommend`, each with plain `await`; `diagnosis` is passed into `propose` as an argument (L247) and crosses the HTTP boundary via `parseDiagnosis(diagnosisParam)` (L227). No graph, no framework — `step`-gated `if/await`.

### The agent (per-node loop)

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop`
- **Line range:** L48–L176; termination on model choice at L121 (`if (toolUses.length === 0) return`); turn loop L85–L172
- **Role:** The model decides which tools to call (L116) and when to stop (L121). Bounded by `maxTurns = 8` (L73) and per-agent `maxToolCalls`.

### The micro-chain (loop → synthesize, inside one agent)

- **File:** `lib/agents/diagnostic.ts`
- **Function / class:** `DiagnosticAgent.investigate` (agent step) → `synthesize` (chain step) → `diagnosisConfidence` (derive step)
- **Line range:** L51 (`runAgentLoop`) → L74–L75 (`tryParseDiagnosis ?? synthesize ?? FALLBACK`) → L80–L82 (confidence derive); `synthesize` body L87–L126
- **Role:** A bounded agent loop followed by a fixed, tool-less synthesis call, then a deterministic confidence derivation. Same shape in `recommendation.ts` L69–L73 / L82–L133 (minus the confidence step).

### Shared constants

- **File:** `lib/agents/base.ts` L9 — `AGENT_MODEL = 'claude-sonnet-4-6'` (every node + every synthesize call).
- **File:** `lib/agents/intent.ts` L14 — `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` (the query branch's routing step).

**Pseudocode — chain of bounded agents** (route.ts L231–L249 + diagnostic.ts L74–L75):

```typescript
// CHAIN (route.ts): fixed order, typed handoff — split across two ?step calls
// step=diagnose:
const diagnosis = await diag.investigate(inv);        // node 1 (an agent)
send({ type: 'diagnosis', diagnosis });               // → client stashes bi:diag:<id>
// step=recommend (separate request):
const diagnosis = parseDiagnosis(diagnosisParam);     // handed over from step 2
const recs      = await rec.propose(inv, diagnosis);  // node 2 (an agent), reads node 1

// AGENT + MICRO-CHAIN (diagnostic.ts): variable loop, then fixed fallback
const { finalText, toolCalls } = await runAgentLoop({ ... });  // model owns the path
const diag = tryParseDiagnosis(finalText)   // micro-chain step 1
    ?? (await this.synthesize(anomaly, toolCalls))  // micro-chain step 2
    ?? FALLBACK;                            // micro-chain step 3
return { ...diag, confidence: diagnosisConfidence(diag) };  // derive step
```

---

## Elaborate

### Where this pattern comes from

The agent-vs-chain distinction is the spine of Anthropic's "Building effective agents" (2024), which draws a hard line between **workflows** (LLM calls orchestrated through predefined code paths) and **agents** (LLM dynamically directs its own process and tool use). The paper's central advice: start with the simplest workflow, and only reach for an agent when the task genuinely needs the model to decide the path. blooming insights follows this to the letter — the route is a workflow, each node is an agent, and the agent is used only where the query path is genuinely data-dependent. The prompt-chaining workflow (decompose a task into fixed sequential LLM calls) is exactly the `investigate → propose` route shape; the agent loop is exactly the paper's "autonomous agent" with a tool-use cycle.

### The deeper principle

Determinism and adaptivity are not a spectrum you slide along once — they are a property you choose *per layer*. A system can be fully deterministic at the orchestration layer and fully adaptive at the execution layer simultaneously. The mistake juniors make is treating "use an agent" as a system-wide decision. The senior move is to draw the determinism boundary tightly: as much fixed code as possible, as little model-directed control flow as the task requires. blooming insights' boundary is drawn at the agent's public method: above it, code; below it, model.

### Where this breaks down

A 2-step chain of agents is the comfortable case. It breaks when the chain needs to *branch on a node's output*. Concretely: if `diagnosis.confidence === 'low'` you want to re-investigate with a different tool subset rather than recommend; if it is high you proceed. With sequential `await` that becomes nested `if/else`, and with three branch points it becomes an unreadable hand-rolled state machine. It also breaks under parallelism — running two diagnostic hypotheses concurrently and merging — which `await a; await b` cannot express without `Promise.all` plumbing that the route does not have. At that point the orchestration layer itself should become a graph.

### What to explore next

- **LangGraph** — a graph-based runner where nodes are agents/functions, edges are conditional transitions, and typed state flows between them; the replacement for the route's `if/await/await` when branching arrives.
- **Anthropic Agent SDK** — a higher-level loop with built-in memory and observability; `runAgentLoop` is a hand-rolled version of its core.
- **Anthropic "Building effective agents"** — read the workflow-vs-agent taxonomy (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer) and map each onto where it would live in this repo.

---

## Tradeoffs

### Comparison: chain-of-bounded-agents vs the obvious alternatives

| Dimension | This codebase (chain of agents) | One mega-agent (all tools, one loop) | Pure chain (fixed queries, no agent) |
|---|---|---|---|
| Control-flow ownership | Code at top, model at node | Model owns everything | Code owns everything |
| Adaptivity | Query path adapts per anomaly | Adapts, but tool sprawl | None — same queries every run |
| Predictability of order | High — route is fixed | Low — model picks step order too | Total — every step is code |
| Testability | Each node tested with fake MCP | One large surface, harder to isolate | Trivial — deterministic |
| Runaway risk | Bounded per node (`maxToolCalls`) | Single budget for the whole task | Zero |
| Token cost | 2 nodes × bounded budget + synth | 1 loop, same total calls, no savings | Cheapest (no exploration) |

**What we gave up.** The chain cannot react to a node's output by changing the *next node*. If the diagnosis comes back hollow, the route still calls `propose` — it does not skip recommendation or loop back to re-diagnose. We accept running a recommendation step against a `FALLBACK` diagnosis (which returns `[]`) rather than building branch logic that is not yet justified. We also gave up cross-node memory: the only thing node 2 knows about node 1 is the `diagnosis` argument; there is no shared scratchpad.

**What the alternative would have cost.** A single mega-agent with all of `monitoringTools ∪ diagnosticTools ∪ recommendationTools` in one loop would collapse the route to one call — but the model would see ~40 tools and a bloated system prompt, increasing the odds it reaches for the wrong tool (the exact failure 04-tool-routing.md prevents), and a single budget would have to cover monitor + diagnose + recommend, making per-phase tuning impossible. A pure chain (always run the same N queries, no model in the loop) would be the cheapest and most testable, but it cannot ask the follow-up query an anomaly demands — it would over-fetch every dimension on every run or miss the relevant one.

**The breakpoint.** This design stops being right the moment the chain needs a third decision point that depends on a node's output — e.g., a confidence-gated re-investigation or a parallel two-hypothesis split. Concretely: when the route accumulates more than one `if (diagnosis.x)` branch around an `await`, replace the `if/await` spine with a graph runner. Until then, two `await`s are strictly simpler and equally correct.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk Messages API (the agent substrate)

- **Codebase uses:** `anthropic.messages.create(params)` inside `runAgentLoop` (`base.ts` L102); the model's `tool_use` blocks are the "next step" signal that makes a node an agent.
- **Why it's here:** It is the only API that turns model output into control flow — the presence or absence of a `tool_use` block at L116/L121 decides whether the loop continues.
- **Leading today:** Anthropic Messages API and OpenAI Responses/Chat Completions are the two adoption-leading agent substrates in 2026.
- **Why it leads:** First-class tool-use blocks, large context windows, and strong instruction-following make hand-rolled loops viable without a framework.
- **Runner-up:** Google Gemini function calling — capable, growing adoption, less mature tool-loop ergonomics.

### Sequential `await` (the chain mechanism)

- **Codebase uses:** Two `await` calls in `route.ts` (L153, L158) with the diagnosis threaded between them — the entire orchestration layer.
- **Why it's here:** A 2-step linear pipeline needs nothing more; a framework would add dependency weight for zero capability.
- **Leading today:** Plain `async/await` is the adoption-leading orchestration for linear LLM chains in 2026; LangGraph is the innovation-leading choice for graphs.
- **Why it leads:** Linear chains do not need a runtime; `await` is readable, typed, and trivially testable.
- **Runner-up:** LangChain Expression Language (LCEL) `|` pipes — declarative, but unnecessary abstraction for two steps.

### LangGraph (the future graph runner)

- **Codebase uses:** Not used — named as the migration target when the chain needs to branch.
- **Why it's here:** It is the standard answer to "my `if/await` spine became a state machine."
- **Leading today:** LangGraph is the adoption-leading agent-graph runtime in 2026.
- **Why it leads:** Typed state, conditional edges, checkpointing, and human-in-the-loop nodes that sequential `await` cannot express.
- **Runner-up:** OpenAI Swarm / Agents SDK — lighter, handoff-oriented, less mature checkpointing.

---

## Project exercises

### Add a confidence gate that converts the chain into a small branch

- **Exercise ID:** C1.10 (adapted to blooming insights)
- **What to build:** In `app/api/agent/route.ts`, on the `step=recommend` branch, gate on the handed-over `diagnosis.confidence`: if it is `'low'` (or the diagnosis is the empty `FALLBACK`), skip `RecommendationAgent.propose` and emit a `reasoning_step` explaining why no recommendations were produced, instead of running `propose` against a weak diagnosis.
- **Why it earns its place:** Demonstrates you understand the chain/agent boundary — you are adding ONE deterministic branch in code, not pushing the decision into a model.
- **Files to touch:** `app/api/agent/route.ts` (L244–L249); the `confidence` field is already on the `Diagnosis` (`diagnostic.ts` L80–82).
- **Done when:** A run whose diagnosis is `FALLBACK` emits a `reasoning_step` and `done` with zero `recommendation` events, and a non-fallback run is unchanged.
- **Estimated effort:** 1–4hr

### Express the chain as a typed graph spec (without adopting a framework)

- **Exercise ID:** C4.11 (adapted to blooming insights)
- **What to build:** A small `lib/agents/pipeline.ts` that declares the investigation chain as a typed array of nodes `[{ name, run, consumes, step }]` and a runner that executes the node matching the request's `step` (threading each node's output to the next on the combined run) — then have `route.ts` call the runner instead of the inline `step`-gated `if/await`.
- **Why it earns its place:** Shows you can separate orchestration topology from execution, the prerequisite for ever migrating to LangGraph.
- **Files to touch:** new `lib/agents/pipeline.ts`; `app/api/agent/route.ts` (replace L231–L249); `test/agents/pipeline.test.ts`.
- **Done when:** The route's behavior is byte-identical in the NDJSON stream, and adding a node is a one-line array edit with a passing unit test using fake agents.
- **Estimated effort:** 1–2 days

---

## Summary

blooming insights runs a deterministic chain of bounded agents. The route (`route.ts` L231–L249) fixes the order — diagnose then recommend — splitting it across two `step`-gated calls with a typed handoff (the diagnosis stashed and re-parsed via `parseDiagnosis`). Each node (`runAgentLoop`, `base.ts` L48–L176) is an agent: the model chooses which tools to call and signals termination by emitting no `tool_use` block (L121), bounded by `maxTurns` and `maxToolCalls`. Inside an agent, the loop-then-`synthesize` pair (`diagnostic.ts` L74–L75) is a 2-step micro-chain. The architecture is the same idea at three scales: fixed spine, adaptive node, fixed fallback.

Key points:
- A chain is code-owned control flow; an agent is model-owned control flow; blooming insights uses both, layered.
- The line that makes a node an agent is `base.ts` L121 — the model ends the loop by choosing not to call a tool.
- The route is a chain because the order never changes; the node is an agent because the query path changes per anomaly.
- `synthesize()` chained after `runAgentLoop` is a micro-chain inside an agent — the pattern recurses.
- The chain breaks down when a node's output must change the *next node* (branching/parallelism); that is the LangGraph breakpoint.

---

## Interview defense

### What an interviewer is really asking

"Is this an agent or a chain?" is a trap with a single correct answer: "both, at different layers — and here is why each layer chose what it chose." They want to hear that you draw the determinism boundary deliberately, that you know an agent's defining property is model-owned termination, and that you can name the condition under which the chain must become a graph.

### Likely questions

**[mid] "Point to the single line that makes a node an agent rather than a chain."**

`lib/agents/base.ts` L121: `if (toolUses.length === 0) return { finalText, toolCalls }`. The model decides whether the loop continues by choosing to emit (or not emit) a `tool_use` block. A chain has no such line — its termination is the last statement the author wrote.

```
chain termination               agent termination (base.ts L121)
──────────────────              ─────────────────────────────────
return stepThree(b)             res = model.create(...)
  ↑ author decided              toolUses = res.content.filter(tool_use)
                                if (toolUses.length === 0) return   ← MODEL decided
```

**[senior] "Why is the route a chain instead of one big agent with all the tools?"**

Three reasons, all concrete to this repo. First, tool scoping: a mega-agent sees ~40 tools and is likelier to misfire; each node sees only its subset (04-tool-routing.md). Second, budget tuning: diagnostic gets `maxToolCalls: 6`, recommendation gets `4` — impossible to tune separately under one loop. Third, testability: each agent is unit-tested with a fake MCP in isolation. The route order never changes, so there is no adaptivity to gain by moving it into the model.

```
mega-agent: 1 loop, ~40 tools, 1 budget    chain: 2 nodes, scoped tools, per-node budget
─────────────────────────────────────      ──────────────────────────────────────────────
model picks from everything                diag: 6-call budget, diagnosticTools only
hard to tune / test / scope                rec:  4-call budget, recommendationTools only
```

**[arch] "When does this 2-step chain have to become a graph?"**

When a node's output must determine the *next node*, not just the next tool call. A single confidence gate (skip recommendation on a fallback diagnosis) is one `if` and fine. The breakpoint is the second branch point — e.g., low-confidence re-investigation plus a parallel two-hypothesis split — at which the `if/await` spine becomes a hand-rolled state machine. Then move to LangGraph: nodes stay as `runAgentLoop` calls, edges become typed conditional transitions.

```
today (2 step-gated await):  becomes a graph when:
step=diagnose                diagnose ──low?──→ reinvestigate ──┐
  ↓ (stash diagnosis)             │high                        │
step=recommend                    ↓                            ↓
                              recommend ←──────── merge ←── hypothesis split
```

### The question candidates always dodge

**"If the diagnosis is hollow, why does the route still call `propose`?"**

The honest answer: because today there is no branch, and `propose` against a `FALLBACK` diagnosis safely returns `[]` (recommendation.ts L73), so the cost of not branching is one wasted bounded agent run, not a correctness bug. Adding the branch is justified the moment that wasted run becomes expensive or user-visible — that is the first exercise above. Candidates dodge this because admitting "we run a step we could skip" feels like a flaw; it is actually a deliberate "do not build branching until a branch is needed" decision.

### One-line anchors

- `app/api/agent/route.ts` L238 / L247 — the chain: `await investigate` (step=diagnose) then `await propose(diagnosis)` (step=recommend).
- `lib/agents/base.ts` L121 — the agent: model ends the loop by emitting no tool_use.
- `lib/agents/base.ts` L91 — `forceFinal` — the bound that keeps the agent from running away.
- `lib/agents/diagnostic.ts` L74–L75 — the micro-chain: loop → synthesize → FALLBACK.
- `lib/agents/base.ts` L9 — `AGENT_MODEL = 'claude-sonnet-4-6'` — one model for every node.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three layers: (a) the route as a fixed chain naming both `await` steps; (b) one node as an agent loop naming the line where the model ends it; (c) the micro-chain `tryParse ?? synthesize ?? FALLBACK`. Label which layer is code-owned and which is model-owned.

### Level 2 — Explain

Out loud: explain why "is this an agent or a chain?" has no single answer for this codebase, and why the determinism boundary is drawn at the agent's public method (above it code, below it model).

### Level 3 — Apply

Scenario: a PM wants the system to run the diagnostic and recommendation steps *in parallel* to cut latency. Why does the current architecture forbid this, and what specifically would break? Check against `app/api/agent/route.ts` L247 — note that `propose` takes `diagnosis` as an argument, and on the two-step path `step=recommend` cannot even start until the client has stashed the diagnosis from `step=diagnose` and passed it back via `parseDiagnosis(diagnosisParam)` (L227). Explain that the dependency is a data dependency, not a code-style choice, and that true parallelism would require a different decomposition.

### Level 4 — Defend

A reviewer says: "Collapse the route into a single agent with all tools — fewer moving parts." Defend the chain using prompt size, per-node `maxToolCalls` (diagnostic 6 vs recommendation 4), and isolated testability. Then concede the one case where the reviewer is right (a task with no fixed sub-step order).

### Quick check — code reference test

Which line in `lib/agents/base.ts` is the single point where the *model*, not your code, decides the agent loop is finished? (Answer: L121 — `if (toolUses.length === 0) return { finalText, toolCalls }`.)

---
Updated: 2026-05-28 — Re-anchored the chain to the two-step `?step=diagnose`/`?step=recommend` split (separate calls, sessionStorage diagnosis handoff via `parseDiagnosis`), added the derived `confidence` step, and refreshed all route/diagnostic line refs.
