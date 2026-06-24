# Multi-agent orchestration

**Industry name(s):** agentic tool-use loop (ReAct-style), orchestrator + specialist agents, structured-output synthesis pass
**Type:** Industry standard · Language-agnostic

> One shared `runAgentLoop` function drives a multi-turn Claude conversation for each specialist agent, executing MCP tool calls between turns and forcing a final tool-less synthesis turn to guarantee parseable JSON output.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Multi-agent orchestration centers on the Pipeline/Route coordinator (`app/api/agent/route.ts`) and the per-agent classes in `lib/agents/`, which all share one `runAgentLoop` in `lib/agents/base.ts`. blooming insights is a **sequential pipeline** (chains-of-agents, not agentic-router): monitoring → diagnostic → recommendation, with the diagnostic→recommendation handoff split across two HTTP requests and carried by the client via `sessionStorage` (`07-client-stream-handoff.md`). One shared loop, three specialist agents, each with its own prompt + tool subset + JSON validator + safe fallback.

```
Zoom out — where multi-agent orchestration lives

┌─ UI / client handoff ──────────────────────────┐
│  app/page.tsx (briefing)                       │
│  app/investigate/[id]/page.tsx (step 2)        │
│  app/investigate/[id]/recommend/page.tsx (step 3)│
│  bi:diag:<id> sessionStorage (step 2 → step 3) │
└─────────────────────┬──────────────────────────┘
                      │  /api/briefing  /api/agent?step=...
┌─ Route coordinator ─▼──────────────────────────┐  ← we are here
│  app/api/briefing/route.ts (Monitoring only)   │
│  app/api/agent/route.ts (Diagnostic OR Reco)   │
│  step param routes to one agent per request    │
└─────────────────────┬──────────────────────────┘
                      │  per-agent
┌─ Per-agent definitions ────────────────────────┐
│  ★ monitoring.ts ★ scan(hooks, runnable)      │
│  ★ diagnostic.ts ★ investigate()              │
│  ★ recommendation.ts ★ propose(diagnosis)     │
│  each: prompt + tool subset + validator       │
└─────────────────────┬──────────────────────────┘
                      │  all call →
┌─ Shared agent loop ────────────────────────────┐
│  runAgentLoop (lib/agents/base.ts)             │
│  for turn in maxTurns: forceFinal? + tool exec │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Provider wrappers + MCP ──────────────────────┐
│  McpClient → Bloomreach                        │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does an LLM agent run a bounded tool-use loop and reliably end with structured JSON a downstream function can parse — and how do you compose three of those agents into an investigation without losing the diagnosis between two HTTP requests? The answer is a `while` loop with a hard turn budget (`maxToolCalls`, `maxTurns`), a `forceFinal` flag that omits the tool definitions on the last turn so the model *must* emit text, a `synthesisInstruction` nudge appended to the system prompt on that turn, and a three-tier fallback chain per agent (`tryParse(finalText) ?? synthesize(toolCalls) ?? FALLBACK`). The next sections walk the loop mechanics, the synthesis pass, the four agents that share the loop, and how the route + client carry the diagnosis across the step-2 → step-3 boundary.

---

## Structure pass

**Layers.** Multi-agent orchestration stacks five layers across two HTTP requests: the **client handoff** (`sessionStorage` carries the diagnosis from step-2 to step-3), the **route coordinator** (`route.ts` files that map a step param → one specialist agent per request), the **per-agent definition** (monitoring/diagnostic/recommendation — each owns its prompt + tool subset + JSON validator + fallback), the **shared agent loop** (`runAgentLoop` — the while loop, the forceFinal nudge, the tool execution), and the **provider/MCP** (the actual tool calls). The first three layers are *per-stage*; the last two are *per-turn-within-a-stage*.

**Axis: control.** Who decides what happens next at each layer? This is the right axis because multi-agent orchestration IS a control-topology decision (single agent vs sequential pipeline vs supervisor vs parallel) — the architecture name *is* the control name. Pick anything else and the diagram flattens. State is tempting because of the sessionStorage handoff, but state is downstream of control: the handoff exists because the pipeline is sequential, which is a control choice. Failure also competes, but the fallback chain (`tryParse ?? synthesize ?? FALLBACK`) is interesting only once you know which level of control owned that choice.

**Seams.** Three seams matter; one is load-bearing. **Seam 1: route coordinator → per-agent definition.** Control flips from CODE (route's step-param if-ladder picks the agent) to CODE-still (the per-agent class picks the prompt + tools). Procedural-to-procedural; bookkeeping seam. **Seam 2 (load-bearing): per-agent definition → agent loop.** Control flips from CODE-DECIDES (the agent class set up the call) to MODEL-DECIDES (Claude picks which tool to call, how many turns to take, when to emit final JSON). This is the procedural→agentic joint — the same one as in request-flow, but here it's repeated three times, once per agent. **Seam 3: step-2 response → step-3 request.** Control flips from SERVER (route finished, response sent) to CLIENT (must persist diagnosis, must initiate next request). The whole reason blooming insights is "sequential pipeline" not "supervisor" is that the client owns this seam — no orchestrator survives the round-trip.

```
Structure pass — multi-agent orchestration

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Client handoff · Route coordinator · Per-agent def │
│  · Shared agent loop · Provider/MCP                  │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  control: who decides what happens next? (topology   │
│  IS a control structure)                             │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: route → per-agent def (CODE → CODE; bookkeeping)│
│  S2: per-agent def → agent loop ★load-bearing        │
│      (CODE-DECIDES → MODEL-DECIDES; repeated 3×)     │
│  S3: step-2 response → step-3 request                │
│      (SERVER → CLIENT; why "sequential pipeline")    │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S2 seam — "who picks the next tool call?" answered two ways

┌─ Per-agent def ───┐    seam     ┌─ Agent loop ─────────┐
│  CODE picks:      │ ═════╪═════►│  MODEL picks:         │
│  prompt + tool    │  (it flips) │  which tool, when     │
│  subset + budget  │             │  to stop, final JSON  │
└───────────────────┘             └───────────────────────┘
        ▲                                       ▲
        └────── same axis (control), two answers ─┘
                → this seam exists once per agent stage
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

**Mental model.** Think of the shared agent loop as the `while` loop in your paginator, except the "next-page token" is replaced by tool-use blocks in the model's response. Each iteration: ask the model → if the response contains tool-use blocks, execute them and push their results back as the next user message → if no tool-use blocks, the loop is done and you return whatever text the model produced.

The loop iterates until one of three conditions:
- the model returns a response with no `tool_use` blocks (natural end)
- the hard tool-call budget `maxToolCalls` is spent
- the turn counter reaches `maxTurns`

The diagram below shows one full traversal from the caller's perspective.

```
 caller
   │
   └── runAgentLoop(opts)
         │
         │  turn 0
         ├─────────────────────────────────────────────────────────┐
         │  send messages + toolSchemas to Claude                   │
         │  ◀── response with tool_use blocks                       │
         │  execute each tool via mcp.callTool()                    │
         │  push tool_result messages back                          │
         │  ↓ next turn                                             │
         │  turn 1 … turn N                                         │
         │  (same: send → tool_use → execute → feed back)           │
         │                                                          │
         │  forceFinal turn (budget spent OR turn === maxTurns-1)   │
         │  send messages WITHOUT toolSchemas                       │
         │  ◀── response with text only (no tool_use possible)      │
         └── return { finalText, toolCalls }
```

The caller receives `{ finalText, toolCalls }` and then decides whether `finalText` parses as valid structured output. The `toolCalls` array is the complete log of every query the agent ran — it is the raw material for the dedicated synthesis call.

---

### The shared loop

The shared agent loop is the only place where provider API calls happen inside the agent system. Every specialist agent calls it; none of them drive the provider SDK client directly.

The message accumulation pattern mirrors what you do when managing form state in a reducer: each action produces a new entry appended to the array, and the full array is always passed to the next render. Here the array is `messages: MessageParam[]`, starting with the initial user prompt and growing with each assistant turn and each batch of tool results.

```
messages array grows across turns
─────────────────────────────────────────────────────────────
[0] { role: 'user',      content: userPrompt }          ← initial
[1] { role: 'assistant', content: [tool_use, ...] }     ← turn 0
[2] { role: 'user',      content: [tool_result, ...] }  ← turn 0 results
[3] { role: 'assistant', content: [tool_use, ...] }     ← turn 1
[4] { role: 'user',      content: [tool_result, ...] }  ← turn 1 results
[5] { role: 'assistant', content: [text] }              ← forceFinal turn
─────────────────────────────────────────────────────────────
```

The model sees the full conversation on every call — it reads its own previous queries and their results before deciding what to do next. This is why it can build a diagnosis over multiple tool calls rather than needing to re-query on every turn.

---

### The tool-call budget + forced-final turn

`maxToolCalls` is a hard cap on the total number of tool calls across all turns. `budgetSpent` is `true` as soon as `toolCalls.length >= maxToolCalls`. `forceFinal` is `true` when either the budget is spent or the turn counter is at `maxTurns - 1`.

On a `forceFinal` turn, `params.tools` is not set (the pseudocode rule is `if not forceFinal: params.tools = toolSchemas`). The model receives a request with no tool definitions, so it cannot emit `tool_use` blocks — it must produce text. This is the "omit the next-page token and the loop must stop" equivalent.

The turn timeline for the diagnostic agent (`maxTurns: 8, maxToolCalls: 6`) looks like this:

```
turn  toolCalls  budgetSpent  forceFinal  tools sent?
────  ─────────  ───────────  ──────────  ───────────
  0       0         false       false        yes   ← query 1, 2
  1       2         false       false        yes   ← query 3, 4
  2       4         false       false        yes   ← query 5, 6
  3       6          true        true         NO   ← must emit text
  ↑
  budget hit at turn 3; forceFinal forces a text-only response
```

Even if the natural loop would have continued, `forceFinal` stops further exploration at turn 3 and forces a synthesis response. This bounds latency to `maxToolCalls` round-trips plus one final API call.

---

### The `synthesisInstruction` nudge

`synthesisInstruction` is an optional string that is appended to the `system` prompt on the `forceFinal` turn only (the rule is: if `forceFinal && synthesisInstruction`, `system = system + "\n\n" + synthesisInstruction`).

It is the equivalent of appending a final instruction to a prompt mid-conversation: "you have what you need now, stop asking for more, give me the answer". For the diagnostic agent the instruction reads roughly:

> You have NO more tool calls available. Stop investigating now and output your final answer. Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape (conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — state your best-supported explanation, even if partial. Do not say you need more queries.

This nudge is why `forceFinal` usually produces valid JSON: the system prompt explicitly tells the model what shape to emit and prohibits further exploration. When it works, the parse helper returns a valid `Diagnosis` and the dedicated synthesis call is never reached.

---

### The dedicated synthesis call

The model sometimes emits partial JSON, reasoning prose, or a hybrid on the `forceFinal` turn even with `synthesisInstruction`. When `tryParseDiagnosis(finalText)` returns `null`, a fresh, tool-less call is made.

The diagnostic agent's `synthesize()` is a completely separate provider call — not part of the shared loop. It takes the `toolCalls` array (the complete log), formats each as `"Query N: toolName args\nResult: payload"`, and sends a single-turn prompt to the model with the instruction to emit ONLY the structured JSON. There is no conversation history from the loop — no tool definitions, no accumulated messages. The model sees the gathered evidence as plain text and is asked for exactly one thing.

The fallback chain inside `investigate()` is:

```
tryParseDiagnosis(finalText)                       # loop produced valid JSON?
  ?? (await synthesize(anomaly, toolCalls))         # dedicated call
  ?? FALLBACK                                       # { conclusion: 'Insufficient data…', evidence: [] }
```

After the chain resolves a `Diagnosis`, the agent **derives a confidence** before returning. A `diagnosisConfidence(diag)` helper reads `hypothesesConsidered` — `'high'` when at least one hypothesis is supported AND every hypothesis was tested, `'medium'` when at least one is supported, `'low'` otherwise. It then downgrades a `'high'` to `'medium'` if any tool call errored (`toolCalls.some(tc => tc.error)`), so the surfaced confidence reflects the data actually gathered (rate-limited queries shouldn't read as high confidence).

The recommendation agent's `propose()` uses the same chain:

```
tryParseRecommendations(finalText)
  ?? (await synthesize(anomaly, diagnosis, toolCalls))
  ?? []                                             # safe empty array
```

This is a three-tier reliability guarantee: the loop's nudged final turn, the dedicated synthesis call, and the safe empty-array fallback. The recommendation shape the agent emits is richer than `{ title, rationale, steps }`: each recommendation also carries `effort` (`'low'|'medium'|'high'`), `timeToSetUpMinutes`, `readResultInDays`, `prerequisites` (`{ label, satisfied }[]`), `successMetric`, and an `estimatedImpact` with a dollar `rangeUsd: { low, high }` computed from affected-customer count × AOV × a reactivation % range (the synthesis prompt spells this out).

The reason for a dedicated call rather than extending the loop is that the loop's message history contains partial reasoning and tool_use/tool_result pairs. The model "knows" it was in investigation mode and tends to continue that mode. A fresh single-turn call with no prior context and no tool definitions breaks the mode — the model sees only evidence + instruction and reliably produces JSON.

---

### Four agents, one loop

Each specialist agent is a class that builds a system prompt, selects a subset of MCP tool schemas via a `filterToolSchemas` helper, and delegates to the shared agent loop. The only differences between agents are the prompt, the tool subset, the validator (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`), and the budget numbers.

```
MonitoringAgent.scan(hooks, categories)
  system = monitoring prompt + schema summary + per-category checklist
           (checklist built from the passed `categories` — the
            route's runnable set; empty array → "scan for any change")
  tools  = monitoringTools subset
  budget = maxTurns:8, maxToolCalls:6
  valid  = isAnomalyArray → sort by severity → slice(0,10)
  fallback = []

DiagnosticAgent.investigate()
  system = diagnostic prompt + schema + anomaly JSON
  tools  = diagnosticTools subset
  budget = maxTurns:8, maxToolCalls:6
  valid  = isDiagnosis → derive confidence → return
  fallback chain: tryParse ?? synthesize() ?? FALLBACK

RecommendationAgent.propose()
  system = recommendation prompt + schema + diagnosis JSON
  tools  = recommendationTools subset
  budget = maxTurns:6, maxToolCalls:4
  valid  = isRecommendationArray → assign ids → slice(0,3)
  emits  = title, rationale, bloomreachFeature, steps,
           effort, timeToSetUpMinutes, readResultInDays,
           prerequisites, successMetric, estimatedImpact(rangeUsd)
  fallback chain: tryParse ?? synthesize() ?? []

QueryAgent.answer()
  system = query prompt + schema
  tools  = all or intent-filtered
  budget = varies
  valid  = plain text (no JSON validator needed)
```

All four share the same shared loop with no special-casing inside the loop itself. The loop is "dumb" — it executes tool calls and accumulates messages. The agents are where the domain logic lives.

The shared loop is also **adapter-agnostic** since the 2026-06 `DataSource` seam landed: `runAgentLoop`'s `mcp` parameter is structurally a `DataSource` (`callTool` + `listTools`), and the route picks the adapter via `makeDataSource(mode, sessionId)` — `live-bloomreach` returns a `BloomreachDataSource`, `live-sql` returns an `OlistDataSource` spawned over the mcp-server-olist subprocess. The loop never sees the difference; the agents never see the difference; the only place the choice is visible is the route's call to the factory. Topology unchanged, backend swappable. See `03-provider-abstraction.md`.

---

### The schema gate — bounding monitoring to runnable categories

The monitoring agent's `scan` signature is `scan(hooks?, categories: AnomalyCategory[] = []): Promise<Anomaly[]>`. The second argument is the list of anomaly categories the agent should actually check — and it does NOT decide that list itself. The briefing route gates it **upstream of the shared loop**: before constructing the agent it runs `schemaCapabilities(schema)` then `runnableCategories(capabilities)` from a categories module and passes the result into `scan`. A category is "runnable" only when the live workspace emits the events (and, for `enriches`, the properties/catalogs) it needs — `runnableCategories` keeps the `full` + `limited` ones and drops the `unavailable` ones.

Inside `scan`, the passed `categories` are turned into a per-category checklist string — one bullet per category with its `whyItMatters`, suggested EQL recipe, and threshold gates — which is substituted into the `{categories}` placeholder of the monitoring prompt. An empty array falls back to `'(no checklist provided — scan for any significant recent change)'`. The agent then runs the normal shared loop against that prompt. The gate changes WHAT the agent is told to look for; it does not touch the loop mechanics.

```
schema  (bootstrapped in the route)
  │
  ├─ schemaCapabilities(schema)   → Set{ event, event.prop, catalog:name }
  │
  └─ runnableCategories(caps)     → AnomalyCategory[] (full + limited only)
        │
        └─► MonitoringAgent.scan(hooks, runnable)
                │
                ├─ build per-category checklist from `runnable`
                ├─ inject into prompt at {categories}
                └─ runAgentLoop(...)   ← UNCHANGED; gate is upstream of the loop
```

The consequence: the monitoring agent never spends its `maxToolCalls: 6` EQL budget probing a category this workspace can't support (e.g. no `return` event → the return-spike category is dropped before the loop ever runs). The shared loop is identical for all four agents — the gating happens entirely in the route + the `scan` prompt assembly, never inside the shared loop.

---

### The route orchestration — two steps, not one run

The investigation route handler is the controller. The investigation is no longer one combined diagnostic→recommendation run; it is **two separate requests**, keyed by a `step` query param (`'diagnose' | 'recommend' | null`). Each request runs exactly one agent and streams its reasoning as NDJSON. The `null` step is the legacy *combined* run, kept only for the dev demo-capture path (it runs both agents and persists the snapshot).

The orchestration body (inside the stream):

```
send(reasoning_step 'reading the workspace schema…')   # bootstrap inside stream
schema = await bootstrapSchema(mcp)

if q and not insightId:
    QueryAgent.answer()              # free-form query, single agent
    send({ type: 'done' })

else  // investigation
    if step == 'recommend':          # STEP 3
        diagnosis = parseDiagnosis(diagnosisParam)   # handed over from step 2
        if not diagnosis: throw 'no diagnosis was handed over'

    else:                            # STEP 2 (diagnose) or combined
        diagnosis = DiagnosticAgent.investigate()  # runs the shared loop internally
        send({ type: 'diagnosis', diagnosis })

    if step != 'diagnose':           # STEP 3 or combined
        recs = RecommendationAgent.propose(inv, diagnosis)
        for r in recs: send({ type: 'recommendation', recommendation: r })

    send({ type: 'done' })
    if step is null: saveInvestigation(insightId, collected)   # combined run only
```

The key structural change: on `step === 'diagnose'` the recommendation agent is **never reached** (the `if step != 'diagnose'` guard skips it) — the decision is not run yet. On `step === 'recommend'` the diagnostic agent is **never reached**; instead the diagnosis arrives as a `&diagnosis=` query param handed over from step 2.

The handoff lives client-side in the investigation hook. Step 2 (the diagnose page) writes the diagnosis to `sessionStorage` under `bi:diag:<id>` when it sees the `done` event. Step 3 (the recommend page) reads it back and, in live mode, appends it to the request URL as `&diagnosis=`. Each step also stashes its own result under `bi:inv:<step>:<id>` so re-visits and back-nav hydrate instantly without re-running the agents.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Two-request investigation + diagnosis handoff                            │
│                                                                            │
│  STEP 2  /investigate/[id]                                                │
│  useInvestigation(id,'diagnose') → GET agent?...&step=diagnose            │
│        └── DiagnosticAgent.investigate()  (recommendation NOT run)        │
│        on done: stash bi:inv:diagnose:<id>                                │
│                 + hand off bi:diag:<id> = { diagnosis }   ◀──┐            │
│                                                              │ sessionStorage│
│  STEP 3  /investigate/[id]/recommend                         │            │
│  useInvestigation(id,'recommend') ── reads bi:diag:<id> ─────┘            │
│        → GET agent?...&step=recommend&diagnosis=<json>  (live mode)       │
│        └── RecommendationAgent.propose(inv, diagnosis)  (diagnostic NOT run)│
│        on done: stash bi:inv:recommend:<id>                               │
└──────────────────────────────────────────────────────────────────────────┘
```

The route still sequences agents with plain `await`, not a framework or graph — but the sequencing is now split across two HTTP requests with the diagnosis carried between them by the client. A `hooksFor(agent)` factory wires each agent's `onText`, `onToolCall`, and `onToolResult` callbacks to `send()` calls that push NDJSON events to the client with the agent name attached — so the UI knows whether a `reasoning_step` came from the diagnostic or recommendation agent.

In demo (cached) mode there is no live agent at all: the route replays the combined snapshot through `filterByStep(cached, step)` to show only the requested step's events — see 05-streaming-ndjson.md.

---

### The principle

Separate exploration from synthesis. The loop's job is to gather evidence (tool calls + results). The synthesis step's job is to produce a typed output from that evidence. Keeping them separate means you can bound the loop (prevent runaway exploration) and give the synthesis step a clean context (no tool_use scaffolding, no partial reasoning chains). The `forceFinal` mechanism is the handoff between the two modes.

---

## Multi-agent orchestration — diagram

The diagram below shows the full service layer. `runAgentLoop` sits at the center, receiving a prompt and tool subset from each agent and handing tool calls to the MCP/Provider boundary. The synthesis/validation step sits outside the loop.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Route layer   app/api/agent/route.ts  (?step=diagnose|recommend|∅) │
│                                                                     │
│  GET /api/agent  → bootstrap inside stream → branch on step:        │
│  ├── free-form q       : QueryAgent.answer()                        │
│  ├── step=diagnose     : DiagnosticAgent.investigate()  (rec NOT run)│
│  │                        send(diagnosis) → client stashes bi:diag  │
│  ├── step=recommend    : RecommendationAgent.propose(handed diagnosis)│
│  │                        (diagnostic NOT run; diagnosis via &diagnosis=)│
│  └── step=∅ (combined) : both agents + saveInvestigation (demo only)│
│  hooksFor(agent) → NDJSON stream to client                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ await (sequential, one agent per request)
┌──────────────────────────▼──────────────────────────────────────────┐
│  Agent layer   lib/agents/                                          │
│                                                                     │
│  MonitoringAgent    DiagnosticAgent    RecommendationAgent          │
│  .scan(hooks,       .investigate()     .propose()                   │
│   runnable)         prompt: diagnostic prompt: recommendation       │
│  prompt: monitoring tools: diagnostic  tools: recommendation        │
│   + runnable        subset             subset                       │
│   checklist                                                         │
│  tools: monitoring                                                  │
│  subset                                                             │
│  (briefing route gates runnable categories upstream — categories.ts)│
│         │                  │                   │                    │
│         └──────────────────┼───────────────────┘                   │
│                            │ all call                               │
│                ┌───────────▼────────────┐                           │
│                │   runAgentLoop()       │  lib/agents/base.ts       │
│                │                        │                           │
│                │  for turn in maxTurns  │                           │
│                │   forceFinal?          │                           │
│                │    send w/o tools ─────┼──→ finalText              │
│                │   else                 │                           │
│                │    send w/ tools ──────┼──→ tool_use blocks        │
│                │    execute via MCP ────┼──← tool results           │
│                │    feed back           │                           │
│                │  return finalText,     │                           │
│                │         toolCalls      │                           │
│                └───────────────────────┘                           │
│                            │                                        │
│  Synthesis/validation step (per agent):                             │
│  tryParse(finalText) ──── valid? ──→ typed output ──┐               │
│       │ null                                        │               │
│       ▼                                             ▼               │
│  synthesize(toolCalls) ── valid? ──→ typed output → diagnostic:     │
│       │ null                          diagnosisConfidence(diag),    │
│       ▼                               downgrade high→med if errors  │
│  FALLBACK / []                        recommendation: assign ids,   │
│                                       slice(0,3)                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ callTool()
┌──────────────────────────▼──────────────────────────────────────────┐
│  MCP / Provider boundary   lib/mcp/                                 │
│                                                                     │
│  McpCaller interface  ←  McpClient (prod)  /  buildFakeMcp (tests)  │
│  Anthropic SDK client ←  real API key      /  injected fake         │
│                                                                     │
│  callTool(name, args) → { result, durationMs, fromCache }           │
└─────────────────────────────────────────────────────────────────────┘
```

Each agent owns its prompt and tool subset. `runAgentLoop` owns the conversation mechanics. The synthesis/validation step owns the contract: a typed output or a safe default.

---

## Implementation in codebase

| File | Function | Lines | Role |
|------|----------|-------|------|
| `lib/agents/base.ts` | `runAgentLoop` | L48–L176 | The shared loop: turn iteration, forceFinal logic, tool execution, message accumulation |
| `lib/agents/base.ts` | `AGENT_MODEL` | L9 | `'claude-sonnet-4-6'` — single constant used by all agents and the synthesize calls |
| `lib/agents/diagnostic.ts` | `DiagnosticAgent.investigate` | L45–L83 | Calls `runAgentLoop`, the fallback chain, then derives `confidence` |
| `lib/agents/diagnostic.ts` | confidence derivation | L80–L82 | `diagnosisConfidence(diag)`; downgrade high→medium if any tool call errored |
| `lib/insights/derive.ts` | `diagnosisConfidence` | L54–L63 | high/medium/low from supported & tested hypotheses |
| `lib/agents/diagnostic.ts` | `DiagnosticAgent.synthesize` | L87–L126 | Dedicated tool-less synthesis call; formats `toolCalls` as evidence text |
| `lib/agents/diagnostic.ts` | `FALLBACK` | L16–L20 | Last-resort `Diagnosis` with empty evidence |
| `lib/agents/recommendation.ts` | `RecommendationAgent.propose` | L36–L77 | Same loop + fallback chain pattern; assigns `id`s after validation |
| `lib/agents/recommendation.ts` | `RecommendationAgent.synthesize` | L82–L132 | Same as diagnostic synthesize; emits effort/time/prereqs/successMetric/rangeUsd |
| `lib/agents/monitoring.ts` | `MonitoringAgent.scan` | L69–L120 | `scan(hooks?, categories=[])`; builds a per-category checklist from `categories` (L73–86), calls `runAgentLoop`; degrades to `[]` on any parse failure |
| `lib/agents/categories.ts` | `schemaCapabilities` / `runnableCategories` | L116–127 / L158–160 | The upstream schema gate; the route passes `runnableCategories(caps)` into `scan` |
| `app/api/agent/route.ts` | `maxDuration = 300` | L20 | Vercel Pro ceiling; the step-split keeps each request well under it |
| `app/api/agent/route.ts` | `step` query param | L117–L118 | `'diagnose' \| 'recommend' \| null`; selects which agent runs |
| `app/api/agent/route.ts` | `GET` (stream + orchestration) | L112–L268 | Bootstrap inside stream → branch on step → one agent per request |
| `app/api/agent/route.ts` | step-split run (diagnose / recommend / combined) | L220–L254 | `step==='recommend'` parses handed diagnosis; `step!=='diagnose'` runs propose |
| `app/api/agent/route.ts` | `parseDiagnosis` (handoff in) | L86–L97 | Parses the `&diagnosis=` query param for step 3 |
| `app/api/agent/route.ts` | `hooksFor` | L181–L195 | Wires `onText`/`onToolCall`/`onToolResult` to `send()` per agent |
| `lib/hooks/useInvestigation.ts` | step orchestration + diagnosis handoff | L37–L213 | Runs one step; stashes `bi:inv:<step>:<id>`; hands off `bi:diag:<id>` |
| `lib/hooks/useInvestigation.ts` | `done` → stash + handoff | L130–L144 | Writes step result; writes `bi:diag:<id>` on diagnose |
| `lib/hooks/useInvestigation.ts` | read handoff + `&diagnosis=` | L72–L84, L162–L164 | Step 3 reads diagnosis, appends to URL in live mode |
| `app/investigate/[id]/page.tsx` | step 2 | L38 | `useInvestigation(id, 'diagnose')` |
| `app/investigate/[id]/recommend/page.tsx` | step 3 | L36 | `useInvestigation(id, 'recommend')` |

**Pseudocode: the loop core** (`lib/agents/base.ts` L85–L175):

```typescript
for (let turn = 0; turn < maxTurns; turn++) {
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal  = turn === maxTurns - 1 || budgetSpent;          // L91

  const params = { model, max_tokens, system, messages };
  if (!forceFinal) params.tools = toolSchemas;                        // L101
  if (forceFinal && synthesisInstruction)
    params.system = `${system}\n\n${synthesisInstruction}`;           // L98

  const res = await anthropic.messages.create(params);
  messages.push({ role: 'assistant', content: res.content });         // L105

  const toolUses = res.content.filter(b => b.type === 'tool_use');
  if (toolUses.length === 0) return { finalText, toolCalls };         // L121-124

  for (const tu of toolUses) {
    const result = await mcp.callTool(tu.name, tu.input);             // L144
    toolCalls.push(tc);
    toolResults.push({ type:'tool_result', tool_use_id: tu.id, ... });
  }
  messages.push({ role: 'user', content: toolResults });              // L171
}
return { finalText: '', toolCalls };  // maxTurns exhausted            // L175
```

**Pseudocode: the fallback chain + confidence derivation** (`lib/agents/diagnostic.ts` L74–L82):

```typescript
const diag =
  tryParseDiagnosis(finalText)                    // L74
  ?? (await this.synthesize(anomaly, toolCalls))  // L75
  ?? FALLBACK;                                    // L75

const confidence = diagnosisConfidence(diag);     // L80 — derive.ts L54–L63
const hadErrors = toolCalls.some((tc) => tc.error);                 // L81
return { ...diag, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };  // L82
```

**GitHub links:**
- `lib/agents/base.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/base.ts
- `lib/agents/diagnostic.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/diagnostic.ts
- `lib/agents/recommendation.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/recommendation.ts
- `lib/agents/monitoring.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/monitoring.ts
- `lib/agents/categories.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/categories.ts
- `lib/insights/derive.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/insights/derive.ts
- `lib/hooks/useInvestigation.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts
- `app/api/agent/route.ts`: https://github.com/rlynjb/blooming_insights/blob/main/app/api/agent/route.ts

---

## Elaborate

### Where it comes from

The loop pattern has a formal name: **ReAct** (Reason + Act), introduced by Yao et al. 2022. The idea is that a model alternates reasoning steps with action steps (tool calls), updating its belief state (the message history) after each action. The Anthropic tool-use API implements the action step as `tool_use` blocks in the assistant message and `tool_result` blocks in the subsequent user message.

The "forced final turn" trick is a production-grade addition not in the original ReAct paper. Papers assume the model stops cleanly; production models often want to keep querying. The budget + synthesis pass is the engineering solution.

### The deeper principle

Exploration and synthesis are different cognitive modes and they benefit from different prompt contexts. Exploration needs tool definitions and conversation history so the model can build on prior queries. Synthesis needs a clean slate — just the evidence and a precise output schema — so the model is not distracted by the "I could run one more query" pattern.

```
Exploration mode                   Synthesis mode
────────────────────────────────   ────────────────────────────────
tools available                    no tools
full conversation history          no history (or evidence-only)
prompt: "investigate X"            prompt: "given this evidence, output JSON"
model output: tool_use blocks      model output: structured text
terminates on: budget hit          terminates on: always (one turn)
```

The loop runs in exploration mode. `synthesize()` runs in synthesis mode. Keeping them separate prevents the model from "re-entering" exploration reasoning during the synthesis call.

### Where it breaks down

**Deep multi-step chains.** A 2-step diagnose→recommend chain works well with sequential `await`. A 5-step chain with branching (e.g., diagnose → split on hypothesis → two parallel sub-investigations → merge → recommend) breaks this pattern. Sequential `await` cannot express branching, and the combined latency compounds per step.

**Cost and latency compound.** Each agent runs up to `maxToolCalls` round-trips plus one `synthesize()` call. The investigation is split so each request runs one agent under the `maxDuration: 300` ceiling; collapsing back to a combined run (the `step=null` demo-capture path) runs both agents (~100–115s) and would not fit Hobby's 60s. Stacking more agents into a single request is risky without reducing per-agent budgets.

**No inter-agent memory beyond the route.** Agents share data only through the route's `await` chain (`diagnosis` is passed to `propose()`). There is no shared context store, no vector memory, no cross-agent message history. If two agents need to discuss a finding, the route has to explicitly pass that finding as a constructor argument or prompt variable.

### What to explore next

- **LangGraph** — a graph-based agent orchestration library where nodes are agents or functions, edges are conditional transitions, and state flows through a typed schema. Adds branching, cycles, and checkpointing that the sequential `await` chain here cannot express.
- **Anthropic Agent SDK** — Anthropic's higher-level agent SDK adds built-in tool-use loops, memory primitives, and observability hooks. The `runAgentLoop` in this codebase is a hand-rolled version of what the SDK provides.
- **Structured outputs / function-calling JSON modes** — OpenAI and some other providers support constrained decoding that forces the model to emit valid JSON at the token level, eliminating the need for `tryParse ?? synthesize ?? FALLBACK`. Claude's `tool_use` JSON mode is a partial equivalent.

---

## Interview defense

### What the interviewer is really asking

When an interviewer asks "how does your agent avoid running forever?" they want to know if you understand the gap between "the model will naturally stop" (hope) and "the loop enforces a budget and forces a text-only final turn" (production). When they ask "how do you guarantee structured output from an agent?" they want `tryParse ?? synthesize ?? FALLBACK`, not "I prompt it to return JSON."

---

### Q+A

**[mid] "Walk me through what happens when `maxToolCalls` is hit mid-turn."**

`budgetSpent` becomes `true` at the top of the next iteration (L90 of `base.ts`). `forceFinal` is set to `true` (L91). `params.tools` is not populated (L101). If `synthesisInstruction` is set, it is appended to `params.system` (L98). The Anthropic API call goes out with no tool definitions — the model cannot emit `tool_use` blocks and must produce text. The loop's next check at L121 (`if toolUses.length === 0`) is always `true` on a forced-final turn, so the function returns `{ finalText, toolCalls }`.

```
turn N   toolCalls.length >= maxToolCalls
  │
  └── budgetSpent = true
      forceFinal  = true
      params.tools NOT set
      params.system += synthesisInstruction
         │
         ▼
      anthropic.messages.create()   ← no tool_use possible
         │
         ▼
      toolUses.length === 0  ──true──→  return { finalText, toolCalls }
```

**[senior] "Why do you need a dedicated `synthesize()` call? Can't you just improve the `synthesisInstruction`?"**

Yes, you can improve the `synthesisInstruction` — and that is the first thing to try. But the `synthesisInstruction` runs inside the loop's conversation context, which contains `tool_use`/`tool_result` block pairs, partial reasoning, and potentially mid-sentence thoughts from earlier turns. The model has "momentum" toward the exploration pattern. A fresh single-turn call with no prior context and no tool definitions breaks that momentum. The model sees only: "here is the evidence, here is the schema, output JSON." Empirically, the clean-context call is more reliable. The cost is one extra API call per agent that fails the first parse — zero cost when the loop's final turn succeeds.

```
Loop context (exploration mode)       Synthesize context (synthesis mode)
─────────────────────────────────     ─────────────────────────────────
[user] investigate anomaly            [user] evidence + schema + "output JSON"
[asst] tool_use: query_events              ↓
[user] tool_result: {...}             [asst] {"conclusion": ..., "evidence": [...]}
[asst] tool_use: query_funnels             (reliable)
[user] tool_result: {...}
[asst] synthesisInstruction in system
       "stop, output JSON now"
       → sometimes prose, sometimes JSON
         (unreliable without clean context)
```

**[arch] "This is a 2-agent sequential chain. How would you extend it to a branching graph?"**

Today the two steps are sequenced across two HTTP requests, with the diagnosis handed between them by the client (`sessionStorage`). Branching would require `if/else` either in the route or in the client. The hook gives us a head start: the diagnostic agent already derives `diagnosis.confidence` (`high`/`medium`/`low`), so a real branch is available — e.g., low-confidence diagnosis → re-investigate with a different tool subset, medium → skip recommendation, high → proceed. Expressed in `if/else` this becomes a hand-rolled state machine spread across route + client. At that point, replace the control flow with LangGraph: define nodes for each agent and conditional edges based on typed state (`diagnosis.confidence`). LangGraph handles the branching, provides checkpoints for debugging mid-graph failures, and can parallelize independent branches. The agents themselves (`runAgentLoop` calls) do not change — only the orchestration layer changes.

```
Current (2 requests + client handoff):  LangGraph equivalent:
────────────────────────────────────    ────────────────────────────────────
step 2: investigate()                    diagnose_node
  → diagnosis stashed (bi:diag:<id>)           │
step 3: propose(handed diagnosis)        ┌─────┴────────────────┐
  → recommendations                      ▼                       ▼
done                                 high/med confidence     low confidence
                                     │                       │
                                     ▼                       ▼
                                 recommend_node         reinvestigate_node
                                     │                       │
                                     └───────────┬───────────┘
                                                 ▼
                                              done_node
```

---

### The dodge

**"Why a second synthesis call instead of just prompting the loop to return JSON?"**

The honest answer is: prompting is the first line of defense and the `synthesisInstruction` is exactly that prompt. The second synthesis call is a safety net for the cases where the first-line prompt does not work. If the `synthesisInstruction` were 100% reliable, `synthesize()` would never be invoked and its cost would be zero. In practice, the model has a tendency to emit partial JSON or reasoning prose wrapped around JSON on the forced-final turn, especially when the conversation history is long (6 tool-call pairs = 12 messages). The clean-context call breaks that tendency. The tradeoff is explicit: accept up to 2× token cost for an agent that fails the first parse in exchange for a non-empty, valid diagnosis that produces actionable recommendations.

```
First line:  synthesisInstruction appended to system on forceFinal turn
             ├── success (most runs): tryParse(finalText) = Diagnosis
             │   synthesize() not called; no extra cost
             └── failure (some runs): finalText = prose or partial JSON
                 tryParse returns null
                 │
                 ▼
Second line: synthesize(anomaly, toolCalls)
             ├── success: returns Diagnosis from clean-context call
             └── failure: returns null
                          └── FALLBACK (safe empty result)
```

---

### Anchors

- `lib/agents/base.ts` L91 — `forceFinal = turn === maxTurns - 1 || budgetSpent`; the single line that converts an exploration loop into a synthesis step
- `lib/agents/base.ts` L101 — `if (!forceFinal) params.tools = toolSchemas`; omitting tools is what forces the model to produce text
- `lib/agents/diagnostic.ts` L74–L75 — the three-tier fallback chain; cite this when asked "what happens when the model fails to produce JSON?"
- `lib/agents/diagnostic.ts` L80–L82 — confidence derivation (`diagnosisConfidence` + error downgrade); cite when asked how confidence is set
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize()`: a completely separate API call with no loop history; cite this when asked about the dedicated synthesis call
- `app/api/agent/route.ts` L220–L254 — the step-split orchestration (one agent per request); cite this when asked how agents are sequenced
- `lib/hooks/useInvestigation.ts` L130–L144, L72–L84 — the client-side diagnosis handoff (`bi:diag:<id>`); cite when asked how step 3 gets the diagnosis

---

## See also

→ [audit.md](./audit.md) (request-response-and-data-flow + failure-handling lenses — the CODE → MODEL control flip and the parse → synthesize → FALLBACK chain) · [05-streaming-ndjson.md](./05-streaming-ndjson.md) · [03-provider-abstraction.md](./03-provider-abstraction.md) (the `DataSource` upper seam the agents now ride over) · [07-client-stream-handoff.md](./07-client-stream-handoff.md) · [08-schema-gated-coverage.md](./08-schema-gated-coverage.md) · [09-eval-pipeline.md](./09-eval-pipeline.md) (how this orchestration is measured by the 4-pillar eval suite) · `.aipe/study-dsa-foundations/06-sorting-searching-and-selection.md` (parse-helper mechanism)
