# Supervisor-worker

*Industry name: supervisor-worker / orchestrator-workers / dispatcher-handler — Industry standard.*

The most common multi-agent topology — a supervisor decomposes the task, dispatches to specialized workers, synthesizes the results. **In this repo the supervisor exists but is CODE, not an LLM** — `app/api/agent/route.ts` plays the supervisor role deterministically.

## Zoom out — where this concept lives

The supervisor sits at the service layer; in a typical implementation it's an LLM agent that picks which worker runs and merges results. In this repo, that slot is filled by the route handler.

```
  Where supervisor-worker lives in blooming insights

  ┌─ Service layer ─────────────────────────────────────────┐
  │  app/api/agent/route.ts ← THE SUPERVISOR (in code form) │ ← we are here
  │   decomposes by URL `?step=`                            │
  │   dispatches to one worker                              │
  │   streams the worker's output back                      │
  └────────────────────┬────────────────────────────────────┘
                       ▼
  ┌─ Agent layer ── WORKERS ────────────────────────────────┐
  │  DiagnosticAgent   RecommendationAgent   QueryAgent     │
  │  (each is a single-agent ReAct loop, specialized prompt) │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **who decides which worker runs?**

```
  Two flavors of supervisor

  LLM supervisor (canonical pattern):       Code supervisor (this repo):
  ──────────────────────────────────        ───────────────────────────────
  → supervisor LLM reads the input          → route handler reads the URL
  → decides: "diagnostic agent next"        → `if (step === 'recommend')` decides
  → passes context to worker                → passes anomaly + diagnosis to worker
  → reads worker output                     → reads worker output
  → synthesizes / decides next worker       → maybe runs the next agent in series
  cost: full LLM call per dispatch          cost: zero tokens, zero latency
  buy: dynamic dispatch on unstructured input  buy: nothing extra; only works when
                                              the dispatch decision is deterministic
```

## How it works

### Move 1 — the mental model

You know the manager-and-team pattern in software: a manager component reads input, decides which sub-component handles it, hands off context, waits for the result, possibly chains to another. That's supervisor-worker. The only question is whether the manager is *code* or *another LLM agent*. Both are valid; the choice depends on whether the dispatch decision needs to be made dynamically by reading the user's intent.

```
  Supervisor-worker — the canonical shape

  ┌───────────────────────────────────────────────┐
  │              Supervisor agent                  │
  │   (decomposes task, delegates, synthesizes)   │
  └───────┬───────────────┬───────────────┬───────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

### Move 2 — what this repo's "code supervisor" actually does

The full supervisor logic is in `app/api/agent/route.ts`. Three jobs: dispatch, hand off, stream back.

**Job 1: dispatch.**

```typescript
// app/api/agent/route.ts:113-116 — read the dispatch key
const insightId = req.nextUrl.searchParams.get('insightId');
const q = req.nextUrl.searchParams.get('q')?.trim() || null;
const stepParam = req.nextUrl.searchParams.get('step');
const step: Step | null = stepParam === 'diagnose' || stepParam === 'recommend' ? stepParam : null;
```

The URL is the dispatch key. The supervisor reads it and picks the worker class. Compare to an LLM supervisor that would instead read the user's question and decide via an LLM call — same primitive, different mechanism.

**Job 2: hand off (anomaly → diagnostic; diagnosis → recommendation).**

```typescript
// app/api/agent/route.ts:280-294 (paraphrased)
const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
send({ type: 'diagnosis', diagnosis });

// then maybe...
const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
const recommendations = await recAgent.propose(inv, diagnosis!, {...});
```

This is the **handoff** part of supervisor-worker — the supervisor passes the upstream worker's output (`diagnosis`) as the downstream worker's input. In this repo the handoff happens through the URL between requests (step 2 returns the diagnosis, step 3 receives it as a URL param). That's the same handoff a within-process supervisor would do; the wire is just HTTPS.

**Job 3: stream back.**

```typescript
// app/api/agent/route.ts:196-210 (paraphrased)
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => { if (t.trim()) stepFor(agent, 'thought', t); },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) => send({ type: 'tool_call_end', ... }),
});
```

The supervisor wires each worker's trace into the response stream — `reasoning_step`, `tool_call_start`, `tool_call_end` events. This is the "synthesis" half, except in this repo synthesis is "stream the worker's output to the client" rather than "merge multiple workers' outputs."

**The key seam: tools-style vs handoff-style delegation.**

In a typical LLM supervisor, the question is *does the supervisor call workers as tools (it stays in control) or hand off to them (control transfers)?* In this repo, it's neither — the supervisor (route code) calls workers as *functions* (`await diagAgent.investigate(...)`). Control returns to the supervisor when the function returns. That's a stricter version of tools-style: the supervisor never loses control because it's TypeScript, not an LLM.

### Move 2.5 — current state vs full LLM-supervisor

The system as it is now vs the LLM-supervisor version is a useful contrast:

```
  Current state — code supervisor (deterministic dispatch)

  ┌─ app/api/agent/route.ts (TypeScript) ─────────────┐
  │  if (step === 'recommend') dispatch RecAgent      │
  │  else dispatch DiagAgent                          │
  │  if (step !== 'diagnose') also dispatch RecAgent  │
  │  cost: 0 tokens, 0ms latency                       │
  └────────────────────────────────────────────────────┘

  Hypothetical — LLM supervisor (dynamic dispatch)

  ┌─ SupervisorAgent (claude-sonnet-4-6) ──────────────┐
  │  prompt: "given user input + state, pick the next  │
  │   worker from {diagnostic, recommendation,         │
  │   query}; emit { worker: 'X', context: {...} }"    │
  │  cost: ~1 LLM call per dispatch (~2K tokens, ~1s)  │
  │  buy: nothing extra in this product (URL already   │
  │       knows the answer)                            │
  └─────────────────────────────────────────────────────┘
```

The LLM supervisor would be the right choice for a *different* product — one where the user types free-form requests and the system has to decide which capabilities to chain. For this product, the URL is the contract; the LLM supervisor would be tax without benefit.

### Move 3 — the principle

A supervisor's core job is *routing plus synthesis*. The routing part (which worker next) is sometimes deterministic (URL, MIME type, session state) and sometimes a real decision that needs an LLM. The synthesis part (what to do with the worker's output) is sometimes "pass through to the next worker" and sometimes "merge contradictory outputs into one answer." When the routing is deterministic AND the synthesis is pass-through, the supervisor is just code — and pretending otherwise is paying for an LLM to read an `if` statement.

## Primary diagram

This repo's supervisor-worker shape, end-to-end:

```
  Supervisor-worker in blooming insights — supervisor IS code

  ┌─ Supervisor (app/api/agent/route.ts) ─────────────────────────┐
  │                                                                │
  │  1. read URL: insightId, q, step                              │
  │  2. dispatch:                                                 │
  │     if (q && !insightId) → intent classify → QueryAgent       │
  │     else if (step === 'recommend') → RecommendationAgent only │
  │     else → DiagnosticAgent                                     │
  │     if (step !== 'diagnose' && diagnosis) → RecommendationAgent│
  │                                                                │
  │  3. hand off:                                                 │
  │     pass anomaly to DiagnosticAgent                           │
  │     pass anomaly + diagnosis to RecommendationAgent           │
  │     (handoff via URL between step 2 → step 3 requests)        │
  │                                                                │
  │  4. stream back:                                              │
  │     each worker's onText / onToolCall / onToolResult becomes  │
  │     an AgentEvent NDJSON line                                  │
  └──────────────────┬────────────────────────────────────────────┘
                     │
       ┌─────────────┼─────────────┬─────────────┐
       ▼             ▼             ▼             ▼
   ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐
   │DiagAgt │   │RecAgt  │   │QueryAgt│   │intent  │
   │ReAct   │   │ReAct   │   │ReAct   │   │1 call  │
   │6 tools │   │4 tools │   │union   │   │haiku   │
   └────────┘   └────────┘   └────────┘   └────────┘

   Each worker is one runAgentLoop() call. The supervisor never
   becomes an LLM — it stays as TypeScript dispatch logic.
```

## Elaborate

Supervisor-worker is the topology AutoGen, CrewAI, and LangGraph all default to. The pattern is older than LLMs — it's just the actor model with an explicit manager actor — but LLMs made the supervisor's "decide which worker next" decision interesting because the input space is unstructured text rather than a typed schema.

The production wisdom on LLM supervisors: they fail in three predictable ways. (1) the supervisor picks the wrong worker because the prompt didn't sufficiently distinguish their capabilities; (2) the supervisor loops — picks worker A, sees the result, picks worker A again, never escalates; (3) the supervisor synthesizes contradictory worker outputs by averaging instead of flagging the contradiction. All three are fixable with prompt engineering but are bugs you'll have if you ship an LLM supervisor without solving them up front.

This repo's "supervisor is code" choice sidesteps all three. The cost: when the product needs the dispatch decision to be dynamic — a user typing free-form intent rather than clicking a card — the code supervisor falls back to the intent classifier (`../01-reasoning-patterns/07-routing.md`) which is the cheapest possible LLM supervisor (one haiku call). The right escalation path isn't "replace code supervisor with sonnet supervisor"; it's "add an intent classifier inside the code supervisor."

## Interview defense

**Q: "Is your system supervisor-worker?"**

A: Yes, but the supervisor is code, not an LLM. `app/api/agent/route.ts` plays the supervisor role — reads the URL, dispatches to one of four workers (DiagnosticAgent, RecommendationAgent, QueryAgent, or the intent classifier in front of QueryAgent), and streams the worker's output back to the client. The workers are the four AptKit-backed agents. The reason the supervisor is code: the dispatch decision is deterministic — the URL `?step=` tells us which worker runs. An LLM supervisor here would burn ~2K tokens + ~1s latency to re-derive what the URL already encodes.

The case where I'd promote it to an LLM supervisor: when the dispatch decision genuinely needs to read the user's intent. That's already half-there — the intent classifier (`lib/agents/intent.ts`, one haiku call) labels free-form questions for the QueryAgent. If the product grew "user types whatever they want, system chains 2-3 agents to answer," the intent classifier would grow into a real LLM supervisor.

Diagram I'd sketch:

```
  ┌─ supervisor (CODE) ──────┐
  │  if step==X → diagAgent  │
  │  if step==Y → recAgent   │
  │  hand off output via URL │
  └──────────┬───────────────┘
             ▼
   ┌────────┬────────┬────────┐
   │DiagAgt │RecAgt  │QueryAgt│  ← workers (each is one ReAct loop)
   └────────┴────────┴────────┘
```

Anchor: "the supervisor is the URL routing table — `app/api/agent/route.ts:267-297`. Promoting it to an LLM is a real decision with a real cost; it earns its keep when dispatch needs to read intent, not URL params."

**Q: "How do the workers hand off to each other?"**

A: Through plain JSON, never through shared state. The diagnostic agent returns a `Diagnosis` object; the supervisor passes it to the recommendation agent as a function argument. Between requests (step 2 → step 3) the diagnosis is passed in the URL as a query string, carried by the browser's sessionStorage. This is message passing by force of architecture — Vercel's serverless instances are ephemeral, so there's no shared memory anyway. The DiagnosticAgent and RecommendationAgent might run on different physical instances; they can't share a blackboard even if we wanted them to.

## See also

- [`03-sequential-pipeline.md`](./03-sequential-pipeline.md) — the specific sequencing this supervisor enforces
- [`08-shared-state-and-message-passing.md`](./08-shared-state-and-message-passing.md) — why message passing (not blackboard) here
- [`../01-reasoning-patterns/07-routing.md`](../01-reasoning-patterns/07-routing.md) — the routing primitive the supervisor uses
- [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md) — the chain part is the supervisor
