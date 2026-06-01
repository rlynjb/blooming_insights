# Shared state and message passing

**Industry name(s):** Shared state vs message passing, blackboard pattern vs message passing, multi-agent context routing
**Type:** Industry standard · Language-agnostic

> Two models for how agents communicate — a shared blackboard everyone reads/writes, or typed messages handed agent-to-agent. blooming insights firmly uses MESSAGE PASSING: the typed `Diagnosis` is handed step→step (function arg or `sessionStorage`), and each agent's context is scoped to what it's handed. Scoped context = cheaper and less noise, but you must decide what to pass.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This concept lives at the seam between the Pipeline coordinator and the Per-agent definitions — the place where one agent's output becomes another agent's input. blooming insights' implementation here is *message passing*: the typed `Diagnosis` (defined in `lib/schemas/*`) is handed as a function argument from the diagnostic stage to `recommendation.propose(anomaly, diagnosis, hooks)`. There's no shared blackboard; each agent's window holds exactly what was handed to it. The cross-request carrier is `sessionStorage` plus a URL param, but the principle is identical: explicit typed messages, not global state.

```
  Zoom out — where shared-state vs message-passing lives

  ┌─ Pipeline coordinator ──────────────────────────┐
  │  lib/agents/pipeline.ts (the orchestrator)       │
  └─────────────────────────┬────────────────────────┘
                            │  ★ THIS ★ — the handoff
                            ▼
  ┌─ Per-agent definitions ─┴────────────────────────┐  ← we are here
  │  diagnostic.ts produces  ──► Diagnosis (typed)    │
  │       │                                            │
  │       ▼  (message passing — function argument)     │
  │  recommendation.propose(anomaly, diagnosis, hooks)│
  │                                                    │
  │  Alternative (shared state, NOT here):             │
  │    a global WorkspaceState every agent reads/      │
  │    writes; every agent's window carries every      │
  │    other agent's content                           │
  └─────────────────────────┬────────────────────────┘
  ┌─ Schemas (orthogonal) ──▼────────────────────────┐
  │  lib/schemas/* — the typed message contracts      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do agents communicate — through a shared blackboard or through explicit messages? Shared state is simple to reason about but expensive at scale (every window carries every other agent's content) and unsafe (one bad write poisons every reader). Message passing costs schema-design effort up-front but keeps each agent's context scoped to its job. blooming insights picked message passing — the typed `Diagnosis` is the contract. Below, you'll see both shapes, the cost ledger, and why a curated message beats a blackboard for this codebase's shape.

---

## Structure pass

**Layers.** Four layers carry this concept: the **Pipeline coordinator** (the orchestrator that owns the inter-agent handoff), the **Per-agent definitions** (each one's own conversation history, prompt, and tool subset), the **Message contracts** (the typed schemas — `lib/schemas/*` — that define what crosses an agent boundary), and the **Cross-request carrier** (in-process function args today; `sessionStorage` + URL param for the two-step UI). The would-be alternative — a shared blackboard — would replace the second and third layers with a single global store every agent reads and writes.

**Axis: state.** Who owns each piece of conversational data, where does it live, and who is allowed to mutate it? This is the right axis because the entire choice between message passing and shared state is *who owns context at the inter-agent boundary*. Trust is a real concern (a shared blackboard is unsafe because anyone can poison it) but trust is downstream of state ownership: trust matters because ownership is diffuse in the shared-state model.

**Seams.** Two seams matter. Seam 1 sits between one agent's output and the next agent's input — state-ownership flips from "agent A owns its scratchpad" to "the orchestrator owns the typed message it built from A's output." That seam IS message passing; in the shared-state variant the flip never happens because no one owns anything (everyone reads/writes the blackboard). Seam 2 sits between in-request state (function args in a single request) and cross-request state (`sessionStorage` + URL param across the two-step UI) — state-ownership flips from "the call stack carries it" to "the browser carries it" — but the *principle* is identical (explicit typed message, not global state). Seam 1 is the load-bearing one for the concept; Seam 2 is the same shape recurring across a request boundary.

```
  Structure pass — Shared state vs message passing

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Pipeline coordinator                          │
  │  Per-agent definitions (own conversation each) │
  │  Message contracts (typed schemas)             │
  │  Cross-request carrier (sessionStorage + URL)  │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: who owns context at the inter-agent    │
  │         boundary, and who can mutate it?       │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Agent A output ↔ Agent B input        │
  │          (A owns scratch → orchestrator owns   │
  │          typed message → B owns its scratch)   │
  │          ★ load-bearing — this IS the choice   │
  │  Seam 2: in-request ↔ cross-request            │
  │          (call stack → sessionStorage)         │
  │          same shape, different carrier         │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks both shapes, the cost ledger, and why a curated typed message beats a blackboard for this codebase.

---

## How it works

**The mental model: explicit props vs global Redux store, applied to agent context.** Each agent's input is curated by whoever called it. The schema of the input is the contract between agents. No agent reads another agent's scratchpad.

```
Message passing in this codebase

   user request
       │
       ▼
   route.ts (orchestrator owns the messages)
       │
       │ hands DiagnosticAgent: { anomaly }
       ▼
   ┌──────────────────────┐
   │ DiagnosticAgent       │   sees: { anomaly } + diag prompt
   │  - own conversation   │   does NOT see: other agents' state
   │  - own tool subset    │
   │  - own scratchpad     │
   └────────┬──────────────┘
            │ returns Diagnosis (typed)
            ▼
   route.ts (curates the next message)
       │
       │ hands RecommendationAgent: { anomaly, diagnosis }
       ▼
   ┌──────────────────────┐
   │ RecommendationAgent   │   sees: { anomaly, diagnosis }
   │  - own conversation   │   does NOT see: diag's tool calls,
   │  - own tool subset    │                  scratchpad, history
   │  - own scratchpad     │
   └────────┬──────────────┘
            │ returns Recommendation[]
            ▼
        user
```

The strategy in plain English: **decide what each agent needs to know, hand them exactly that, and nothing else.** The schema of the handoff message is the contract. Schema changes are visible; ad-hoc shared-state additions aren't.

### Layer 1 — shared state (the blackboard pattern)

The technical thing: a *shared mutable context object* that every agent reads from and writes to. In LangGraph this is the `StateGraph`'s state schema; in older multi-agent systems this is literally a "blackboard" object. Agents pull what they need; the state grows as the run progresses.

If you're coming from frontend, this is a global Redux store: every component can subscribe to any slice, every dispatched action mutates a shared state. Powerful, simple to start with, expensive at scale because everyone sees everything.

```
Shared state — the blackboard

  ┌──────────────────────────────────────────┐
  │   Shared state (one object)              │
  │                                          │
  │   anomaly: {...}                         │
  │   diagnostic_history: [...]              │
  │   diagnostic_scratchpad: "..."           │
  │   diagnosis: {...}                       │
  │   recommendation_history: [...]          │
  │   recommendations: [...]                 │
  │   user_feedback: "..."                   │
  │                                          │
  └──────────────────────────────────────────┘
        ▲ reads          ▲ writes
        │                │
    Diagnostic        Recommendation
    Agent             Agent
        ▲                ▲
       reads everything  reads everything

   the recommendation agent's context window now
   includes diagnostic_history (potentially 30k tokens
   of EQL responses and intermediate reasoning)
```

The practical consequence: when the recommendation agent runs, its system prompt is wrapped around the whole shared state — every prior agent's output, every tool call, every intermediate thought. The model has to *find* the relevant signal in the noise. This is the "lost-in-the-middle" failure mode scaling with the number of agents.

The condition under which it works: total shared content stays small. With 2 agents and short outputs, the blackboard is fine. With 6 agents and long tool responses, it explodes.

### Layer 2 — message passing (this codebase's choice)

The technical thing: a *typed message* handed from one agent to the next. The next agent's input is the message + its own prompt + its own tool subset — nothing else.

If you're coming from frontend, this is React props: a parent component owns state and passes only what each child needs. The child can't reach up and read the parent's other state. Coupling is explicit and traceable.

```
Message passing — typed handoff

  ┌─ DiagnosticAgent's world ──┐
  │ input: { anomaly }         │
  │ scratchpad: [...]          │
  │ tool calls: [...]          │ ── these live and die with
  │ messages[]: [...]          │    this agent's loop
  └────────┬───────────────────┘
           │
           │ returns Diagnosis (CURATED)
           ▼
   { conclusion: "...",
     evidence: [...],
     hypothesesConsidered: [...] }    ← the message
           │
           │ route hands it over
           ▼
  ┌─ RecommendationAgent's world ──┐
  │ input: { anomaly, diagnosis }  │  ← receives ONLY this
  │ scratchpad: [...]              │
  │ tool calls: [...]              │
  │ messages[]: [...]              │
  └────────────────────────────────┘
```

The practical consequence: the recommendation agent's context window stays small (the `Diagnosis` is ~1-2k tokens at most). Its prompt is sharper because there's less noise. Tool selection accuracy is higher because the model isn't choosing between tools needed for different agents' jobs.

The condition under which it works: the message schema is expressive enough. If the recommendation agent ever needs something not in `Diagnosis`, you either widen the schema (preferred) or accept that recommendation will be missing context. The schema is the contract.

### Layer 3 — the in-process carrier (function argument)

The technical thing: when both agents run inside the same HTTP request, the message is a *function argument*. The diagnostic agent's `investigate(...)` returns a `Diagnosis`; the recommendation agent's `propose(anomaly, diagnosis, hooks)` takes it as the second parameter. No serialization, no storage in between.

If you're coming from frontend, this is literal function composition: `const dx = await diagnostic(); const recs = await recommendation(dx);`. The type system enforces the contract.

```
In-process function-arg handoff

  // in the route handler
  diag_agent  = new diagnostic_agent(...)
  diagnosis   = await diag_agent.investigate(inv, hooks)
  // ▲ diagnosis is a Diagnosis object, typed by the return signature
  send({ type: 'diagnosis', diagnosis })

  rec_agent       = new recommendation_agent(...)
  recommendations = await rec_agent.propose(inv, diagnosis, hooks)
  //                                              ▲
  //                                              │ the message
```

The practical consequence: the handoff is type-checked at compile time. If you ever changed `Diagnosis`'s shape, TypeScript would flag every call site that passes or receives it. The handoff has zero serialization cost.

The condition under which it works: both agents run in the same process. For cross-request handoffs (the user-gated split-step UX), Layer 4's carrier applies.

### Layer 4 — the cross-request carrier (sessionStorage + URL param)

The technical thing: when the pipeline is split across two HTTP requests (user clicks "see recommendations" between them), the message is *persisted to `sessionStorage` and re-passed via URL query param*. Same typed `Diagnosis` schema, different carrier.

If you're coming from frontend, this is a multi-step form persisting state via `sessionStorage` and reloading it on the next page — the React equivalent of "the message survives a page navigation."

```
Cross-request handoff

  Step 2 (diagnose request) — client:
   ─────────────────────────────────────────
    receives Diagnosis from SSE stream
    in the investigation hook's 'done' handler:
      session_storage.set(
        'bi:diag:<id>',
        serialize({ diagnosis: c_diag })
      )

  User clicks "see recommendations"
       │
       ▼
  Step 3 (recommend request) — client:
   ─────────────────────────────────────────
    reads 'bi:diag:<id>' from session storage
    constructs ?diagnosis=<encoded JSON> URL param
    sends GET /api/agent?insightId=...&step=recommend&diagnosis=...

  Step 3 — server:
   ─────────────────────────────────────────
    in the route handler:
      diagnosis_param = req.searchParams.get('diagnosis')
      diagnosis       = parse_diagnosis(diagnosis_param)
      if not diagnosis: throw 'no diagnosis was handed over'

    parse_diagnosis validates the shape:
      - conclusion: string
      - evidence: array
      - hypothesesConsidered: array
```

The practical consequence: the *carrier* changes (function arg → session storage + URL param), but the *message* is the same typed Diagnosis. The validation function enforces the schema at the trust boundary — if the client sent a malformed object, the route rejects it before resuming the pipeline.

The condition under which it works: the message has to fit in a URL query param (a `Diagnosis` does, comfortably — usually under 4KB). For larger messages, you'd POST them or use a server-side session store.

### Layer 5 — per-agent tool subsets are part of context scoping

The technical thing: each agent's tool subset is *part of its scoped context*. The recommendation agent can't even attempt to call analytics tools — they're not in its toolbox. Tools are scoped the same way messages are.

If you're coming from frontend, this is component scoping for which side effects can fire: a child component with no `onSubmit` prop literally can't submit the form. The capability isn't there.

```
Tools as scoped context

  Stage           Tool subset                          Cannot call
  ──────────────  ──────────────────────────────────   ────────────────
  diagnostic      execute_analytics_eql, segments,     feature catalog,
                  funnel, comparison                    scenario specs
  recommendation  feature catalog, scenario specs,     analytics tools
                  campaign templates                    (cannot reach
                                                        the data layer)
```

The practical consequence: scoping is enforced not just at the message layer (what data the agent sees) but at the capability layer (what tools the agent can call). The recommendation agent reasoning over the typed `Diagnosis` cannot decide to "verify" the diagnosis by re-running an EQL — it doesn't have that tool.

### Phase A vs Phase B — what would force a move toward shared state

```
        Now (message passing)                 If shared state was forced
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ DiagnosticAgent sees: anomaly       │  │ Both agents share a WorkspaceState   │ ←
│ RecommendationAgent sees:            │  │   anomaly                            │
│   anomaly + diagnosis                │  │   diagnostic_history                 │
│ each agent's scratchpad/history     │  │   diagnostic_scratchpad              │
│   stays in its loop                  │  │   diagnosis                          │
│ ▼                                    │  │   recommendation_history             │
│ small context windows                │  │   recommendations                    │
│ schema-enforced contracts            │  │ ▼                                    │
│                                      │  │ context windows grow with the run    │
│                                      │  │ no schema enforcement on shape       │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   moving to shared state buys: a graph-style state engine,
   easier "free-form" agent access to prior context.
   costs: larger windows, weaker contracts, harder debugging.
```

*Now:* each agent's context is curated by the route. Diagnostic sees the anomaly. Recommendation sees anomaly + diagnosis. Neither sees the other's scratchpad. Schema is enforced at the type level (TypeScript) and the validation level (`parseDiagnosis`).

*If shared state was forced:* the day the codebase adopts a graph runtime (`./07-graph-orchestration.md`), the engine's state schema becomes a kind of shared state. The mitigation that real graph runtimes apply: the state schema is *typed and curated* — adding a field is intentional, and graph viewers show every reader/writer of every field. So shared state in a graph runtime is closer to "Redux with TypeScript and strict reducer signatures" than to "blackboard free-for-all" — but the context-window cost still applies, and you have to actively curate what each node reads.

The takeaway: **message passing is the cheapest, most isolated, most type-safe option for inter-agent communication — at the cost of having to design the schema.** blooming insights chose it deliberately. Shared state would be a deliberate choice in a different direction, with different costs.

This is what people mean by "multi-agent context routing" — passing role-specific context to each agent, instead of sharing everything. It's a direct application of the context-engineering discipline: most agent failures are context failures, and bloated shared state is one of the biggest context failures.

The full picture is below.

---

## Shared state vs message passing — diagram

```
Shared state vs message passing — full picture

  ┌─ SHARED STATE (blackboard) ──────────────────────────────────┐
  │                                                              │
  │      ┌─────────────────────────────────────┐                 │
  │      │   Shared workspace state             │                 │
  │      │   (every agent reads + writes)      │                 │
  │      │                                     │                 │
  │      │   anomaly, diagnostic_history,      │                 │
  │      │   diagnostic_scratchpad, diagnosis, │                 │
  │      │   recommendation_history, recs,     │                 │
  │      │   tool_responses[...]               │                 │
  │      └─────────────────────────────────────┘                 │
  │              ▲                ▲                              │
  │              │                │                              │
  │         ┌────┴───┐        ┌──┴────┐                          │
  │         │Agent A │        │Agent B│                          │
  │         └────────┘        └───────┘                          │
  │                                                              │
  │   cost:  large windows, no curation, lost-in-the-middle      │
  │   win:   simple to reason about ("everyone sees everything") │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ MESSAGE PASSING (this codebase) ────────────────────────────┐
  │                                                              │
  │   ┌──────────────┐    Diagnosis (typed)    ┌──────────────┐  │
  │   │DiagnosticAg.  │ ──────────────────────►│Recommendation│  │
  │   │              │                          │Agent         │  │
  │   │ scratchpad,  │   in-process: function   │              │  │
  │   │ history,     │     argument             │ scratchpad,  │  │
  │   │ tool calls   │   cross-request:         │ history,     │  │
  │   │ ── stay      │     sessionStorage +     │ tool calls   │  │
  │   │ scoped here  │     URL param           │ ── stay      │  │
  │   │              │                          │ scoped here  │  │
  │   └──────────────┘                          └──────────────┘  │
  │                                                              │
  │   cost:  schema design upfront                                │
  │   win:   small windows, type-safe contracts,                 │
  │          stage-isolated debugging, no context bloat           │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  Carriers for the message in this codebase:
  ┌──────────────────────────────────────────┐
  │ in-process:   function arg               │
  │   diagnosis: Diagnosis                   │
  ├──────────────────────────────────────────┤
  │ cross-request:                            │
  │   write:  session_storage.set(            │
  │            'bi:diag:<id>', serialize(     │
  │            { diagnosis }))                │
  │   read:   parse_diagnosis(URL ?diagnosis=)│
  └──────────────────────────────────────────┘
  Schema (the contract): interface Diagnosis     (the typed inter-agent message)
```

---

## Implementation in codebase

**Case A — blooming insights firmly uses message passing.**

There is no shared blackboard, no shared mutable state object, no agent that reads another agent's scratchpad. Each agent's context is exactly what's handed to it — the anomaly object, the typed `Diagnosis` message (for the recommendation agent), and its own per-stage prompt + tool subset.

**The typed inter-agent message**
**File:** `lib/mcp/types.ts`
**Function / class:** `interface Diagnosis`
**Line range:** L95–L104 — `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers`, `confidence`, `timeSeries`

**The in-process carrier (function argument)**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body
**Line range:** L237–L247 — `diagAgent.investigate(inv, hooks)` returns `Diagnosis`; passed to `recAgent.propose(inv, diagnosis!, hooks)`

**The cross-request carrier (client side, write)**
**File:** `lib/hooks/useInvestigation.ts`
**Function / class:** `case 'done':` of the SSE handler
**Line range:** ~L138 — `sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }))`

**The cross-request carrier (server side, validate-and-resume)**
**File:** `app/api/agent/route.ts`
**Function / class:** `parseDiagnosis()`
**Line range:** L86–L97 — validates `conclusion: string`, `evidence: array`, `hypothesesConsidered: array` before resuming the pipeline

**Per-stage tool subsets (scoping at the capability layer)**
**File:** `lib/mcp/tools.ts`
**Function / class:** per-agent allow-list functions
**Line range:** entire file — each function returns the tool names that agent can call; recommendation cannot reach analytics tools, diagnostic cannot reach feature-catalog tools

**The coverage gate (the typed Diagnosis is *also* the contract for category coverage)**
**File:** `lib/agents/categories.ts`
**Function / class:** category coverage check
**Line range:** entire file — used to verify the diagnosis touched the expected coverage categories

```
shape (not full impl):

  // The message
  interface Diagnosis {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: { hypothesis; supported; reasoning }[];
    affectedCustomers?: { count; segmentDescription };
    confidence?: 'high'|'medium'|'low';
    timeSeries?: { day; value }[];
  }

  // The in-process carrier
  const diagnosis: Diagnosis = await diagAgent.investigate(inv, hooks);
  const recs = await recAgent.propose(inv, diagnosis, hooks);  // typed arg

  // The cross-request carrier (client)
  sessionStorage.setItem('bi:diag:<id>', JSON.stringify({ diagnosis }));

  // The cross-request carrier (server, validation at trust boundary)
  function parseDiagnosis(param: string | null): Diagnosis | null {
    if (!param) return null;
    try {
      const d = JSON.parse(param);
      if (d && typeof d.conclusion === 'string'
            && Array.isArray(d.evidence)
            && Array.isArray(d.hypothesesConsidered)) {
        return d as Diagnosis;
      }
    } catch { /* ignore */ }
    return null;
  }
```

---

## Elaborate

### Where this pattern comes from

The blackboard pattern goes back to 1970s AI research (the HEARSAY-II speech understanding system was the canonical example) — a shared "blackboard" data structure where multiple specialist "knowledge sources" read and write. Message passing is older still — it's the foundational paradigm of distributed computing (Hoare's CSP, Actor model from Hewitt 1973, Erlang's actor model). In the LLM-multi-agent era, the same dichotomy applies: LangGraph's `StateGraph` is shared-state by default (one state schema, every node reads/writes); OpenAI Agents SDK's handoffs and the manually-constructed multi-agent designs (like blooming insights) tend toward message passing.

### The deeper principle

**Curating context per role is cheaper, safer, and clearer than sharing everything.** Bloated shared state is one of the biggest causes of agent failures — the lost-in-the-middle problem scales with both context length and number of irrelevant items. Message passing forces you to ask "what does this agent actually need?" — and the answer is almost always less than "everything everyone else produced."

```
   Shared state                       Message passing
   ────────────────────────────       ────────────────────────────
   write anything, read anything      typed input, typed output
   easy to start                      schema design up front
   cheap PR ("just add a field")      schema change = visible PR
   expensive at scale (window bloat)  scoped windows, scoped costs
   safe-by-default? NO — one bad      safe-by-default? YES — bad
    write poisons every reader         output stays in one agent
```

This is the same principle as React's "lift state up" + "pass via props" advice vs "throw everything in Redux." Both work; the latter is one PR away from a 200-field global store no one can reason about.

### Where this breaks down

Message passing breaks when the message schema can't keep up with the agents' actual context needs. If you find yourself adding fields to the message every PR, the cost of schema migration starts to dominate. At that point you either accept that "the message is large" (it's a typed shared state, basically) or you adopt a graph runtime's state schema with first-class reducer signatures.

It also breaks when the agents genuinely benefit from inspecting each other's *process* (not just output). For some debate/critic shapes (cross-ref `./05-debate-verifier-critic.md`), the critic needs to see the producer's *reasoning*, not just the conclusion — message passing of just the final output loses that signal. The mitigation is to include reasoning in the schema (`hypothesesConsidered[]` already does this for blooming insights' diagnosis) or to switch that specific path to shared state.

### What to explore next
- `./03-sequential-pipeline.md` → the pipeline shape that uses message passing as its native communication
- `./07-graph-orchestration.md` → state graphs typically use shared state (with curated schemas)
- `./09-coordination-failure-modes.md` → "context bloat" is the failure mode this avoids
- `../../study-system-design-dsa/01-system-design/07-client-stream-handoff.md` → the cross-request carrier (`sessionStorage` + URL param) from a system-design perspective

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do your agents share data" they're testing whether you know the difference between shared state and message passing — and whether you chose the model deliberately or by default. The strong signal is naming the typed `Diagnosis` as the message and explaining why curation matters (context window cost, debug shape, type safety). The weak signal is calling all inter-agent communication "the agents talk to each other" without naming the mechanism.

### Likely questions

[mid] Q: How does the diagnostic agent's output get to the recommendation agent?

A: It's handed as a typed `Diagnosis` object — defined in `lib/mcp/types.ts` L95–L104 with `conclusion`, `evidence[]`, `hypothesesConsidered[]`, optional `affectedCustomers`, `confidence`, `timeSeries`. In-process (combined run), the diagnostic agent's `investigate(...)` returns it and the route passes it as the second arg to `recommend.propose(anomaly, diagnosis, hooks)`. Cross-request (split-step UX), the client persists it to `sessionStorage` with key `bi:diag:<id>` and re-sends it as a URL query param when the user clicks "see recommendations"; the route's `parseDiagnosis()` validates the shape before resuming.

Diagram:
```
  In-process:                    Cross-request:
   diagAgent.investigate(...)     diagAgent.investigate(...)
        │ returns Diagnosis            │ returns Diagnosis
        ▼                              ▼
   recAgent.propose(_, dx, _)      sessionStorage.setItem(
        ▲                            'bi:diag:<id>', JSON.stringify({...}))
        │ typed arg                    │
                                       ▼ user clicks
                                  ?diagnosis=<encoded> URL
                                       │
                                       ▼ next request
                                  parseDiagnosis(URL param)
                                       ▼
                                  recAgent.propose(_, dx, _)
```

[senior] Q: Why didn't you use a shared workspace state instead?

A: Three reasons. First, context bloat: shared state means every agent's window carries every prior agent's history — for the recommendation agent, that's ~30k tokens of diagnostic tool calls and intermediate reasoning, vs ~2k for the curated Diagnosis. At Anthropic Sonnet pricing, ~10x more tokens per recommendation call. Second, debug surface: with message passing, "recommendation went wrong" is investigated by reading the Diagnosis and the recommendation agent's loop — two places. With shared state, you have to figure out which field of the shared state the recommendation agent latched onto from any prior agent. Third, type safety: the TypeScript interface `Diagnosis` is enforced at compile time and at the request boundary via `parseDiagnosis`; a shared mutable workspace state would require either a graph runtime's reducer signatures or weaker conventions. The cost of message passing is up-front schema design — I had to decide what `Diagnosis` carries before writing the recommendation prompt — but it's a one-time cost.

Diagram:
```
  Shared state                     Message passing (this codebase)
  ──────────────────────────       ──────────────────────────────
  rec agent window:                rec agent window:
   anomaly                          anomaly
   + diagnostic_history (~30k)      + Diagnosis (~2k)
   + diagnostic_scratchpad
   + diagnosis
                                   ─►  10x cheaper per call
   ─► high context, drift risk     ─►  stage-localized debugging
   ─► hard to debug "which field    ─►  schema is the contract
       did rec latch onto?"
```

[arch] Q: What would you have to change to scale this codebase past 6+ agents?

A: Eventually I'd move to a graph runtime's *curated* shared state — not a free-for-all blackboard, but a typed state schema where each node declares what it reads and what it writes. The typed `Diagnosis` would become one field in a larger `InvestigationState` (along with `anomaly`, `recommendations`, `userFeedback`, etc.), and each node's reader/writer surface would be explicit. The schema design discipline I have today with `Diagnosis` scales to that — I just need a state engine to enforce it. What I would NOT do is move to free-form shared state (every agent reads/writes any field); the context-window cost and debug surface make it a regression at any scale.

Diagram:
```
Scaling path

  blooming insights today        At 6+ agents (refactor target)
  ────────────────────────       ───────────────────────────────
  message passing                graph runtime + typed state
  Diagnosis (1 typed message)    InvestigationState (typed schema)
  agents see only what's          each node DECLARES reads/writes
   handed
  in-process: function args      engine routes state to nodes
  cross-request: sessionStorage   checkpoint store persists state

   message passing                  curated shared state
   (small N)                       (graph engine + schema)
   ▲                                       ▲
   │       NOT free-for-all blackboard ────┘
   └─ stay here until N forces the move
```

### The question candidates always dodge

Q: If you're doing message passing, doesn't that mean the recommendation agent is missing context it might need? What if a critical detail was in the diagnostic agent's scratchpad?

A: Yes — and that's the deliberate cost. The recommendation agent operates on the *curated* `Diagnosis`, not on the diagnostic agent's full reasoning. If a critical detail wasn't in the schema, the recommendation agent misses it. The mitigation isn't to dump shared state on the recommendation agent (which would re-introduce all the costs we just talked about); it's to make the schema *expressive enough*. `Diagnosis.hypothesesConsidered[]` exists specifically because we knew the recommendation agent would want to know which hypotheses were tested and rejected, not just the conclusion. If a future need surfaces — say, "the recommendation agent wants to know which EQL tools the diagnostic agent ran" — I add that field to the schema. It's a visible PR that the diagnostic agent has to write it and the recommendation agent can read it; TypeScript flags every call site. The honest version: message passing forces context engineering to be *explicit*. Shared state lets it be implicit — and implicit context is where lost-in-the-middle failures live. I'd rather pay the schema-design tax than the per-run context-bloat tax. If the schema ever feels too restrictive, the answer is a graph runtime with curated state, not a free-for-all blackboard.

Diagram:
```
The cost of message passing — and the response

  Cost:  rec agent sees only the typed Diagnosis
         (not diag's full history)

  Risk:  a critical detail might be in diag's scratchpad
         and not in the schema

  Response:
   1. design the schema to be expressive
      (hypothesesConsidered[], evidence[], etc.)
   2. when a new context need surfaces:
      ─► add a field to Diagnosis (visible PR)
      ─► TypeScript flags every call site
      ─► both agents are aware of the change
   3. if Diagnosis grows past ~15 fields:
      ─► time to adopt a graph runtime + state schema
      ─► but still curated, never free-for-all
```

### One-line anchors

- "blooming insights uses message passing — the typed `Diagnosis` is the message, function args and `sessionStorage` are the carriers."
- "Each agent's context is scoped to what's handed in plus its own prompt and tool subset; no agent reads another's scratchpad."
- "Curated context = cheaper LLM bills + smaller windows + type-safe contracts + stage-localized debugging."
- "Schema growth is visible (TypeScript flags every call site); shared-state additions are silent — that's the architectural difference."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw both models from memory: shared state (blackboard with agents on the outside) and message passing (agents in a chain with typed messages between them). Annotate which one blooming insights uses and what the message type is.

Open the file. Compare.

✓ Pass: you drew both models, named `Diagnosis` as the message in blooming insights, and pointed to message passing as the choice
✗ Fail: re-read How it works Layers 1–2, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who asked "where does the agents' shared state live?" — under 90 seconds, no notes.

Checkpoints — did you:
- Correct the framing (there's no shared state; it's message passing)?
- Name the `Diagnosis` type and where it's defined?
- Name both carriers (function arg and sessionStorage)?
- Name the tradeoff (schema design up front for context-cost win and debug-shape win)?

If you skipped any: you accepted a wrong framing.

### Level 3 — Apply it to a new scenario

A product manager wants the recommendation agent to know which EQL tools the diagnostic agent ran during its investigation. They suggest "just give the recommendation agent access to the diagnostic agent's message history."

Without looking at the file: is that shared state or message passing? Which approach does blooming insights' architecture support? What would you change — the `Diagnosis` schema, the route's handoff, both? What's the right way to surface this information to the recommendation agent without re-introducing context bloat?

Write your answer (3–5 sentences). Then open `lib/mcp/types.ts` L95–L104 (`Diagnosis`) and `app/api/agent/route.ts` L237–L247 (the handoff) and check whether adding a field is the cleanest fix.

### Level 4 — Defend the decision you'd change

"If you were building this today and you knew the codebase would grow to 6 agents (e.g. adding a SummarizationAgent, a CritiqueAgent, and a HistoricalContextAgent), would you still use message passing, or would you adopt a graph runtime with a typed shared state from day one? Why? What's the cost of getting it wrong in either direction — premature graph state for 3 agents, or message-passing-then-rewrite when the agent count grows?"

Reference the code: `lib/mcp/types.ts` L95–L104 (current Diagnosis schema), `app/api/agent/route.ts` L237–L247 (current in-process handoff), `lib/hooks/useInvestigation.ts` L138 (current cross-request handoff).

### Quick check — code reference test

Without opening any files:
- Does blooming insights use shared state or message passing?
- What's the type of the inter-agent message between diagnostic and recommendation?
- What's the key the client uses to persist the message between step 2 and step 3?
- What function validates the message when the server resumes step 3?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `./03-sequential-pipeline.md` · → `./07-graph-orchestration.md` · → `./09-coordination-failure-modes.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → client handoff: `../../study-system-design-dsa/01-system-design/07-client-stream-handoff.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
