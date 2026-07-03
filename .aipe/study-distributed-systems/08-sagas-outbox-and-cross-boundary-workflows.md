# sagas-outbox-and-cross-boundary-workflows

*Two-step workflow · Client-side handoff · Compensation · Industry standard*

## Zoom out — where this concept lives

The investigate flow runs in two agent-driven steps: diagnose (step 2)
then recommend (step 3). This is a lightweight saga — a workflow that
spans multiple invocations, each of which does external work, with a
handoff between them. Because there's no persistent database and the
tools are read-only, this saga doesn't need compensation for state
consistency. But it DOES have a real coordination surface: what
happens if step 3 fails after step 2 succeeded?

There's no transactional outbox (no DB, nothing to reconcile). The
"outbox" here is sessionStorage on the client. It's not a
distributed-systems textbook outbox; it's a stateless-runtime version
of the same idea.

```
  Zoom out — the two-step investigate saga

  ┌─ Client layer ──────────────────────────────────────────────────┐
  │  investigate/[id]/page.tsx           (step 2 — diagnose)         │
  │  investigate/[id]/recommend/page.tsx (step 3 — recommend)        │
  │  useInvestigation hook — stashes trace in sessionStorage         │
  │  ★ THE HANDOFF LIVES IN THE CLIENT ★                             │ ← we are here
  └────────────────────────┬────────────────────────────────────────┘
                           │
  ┌─ Service layer ─────── ▼────────────────────────────────────────┐
  │  /api/agent?step=diagnose  → DiagnosticAgent → diagnosis         │
  │  /api/agent?step=recommend&diagnosis=<JSON>                     │
  │                            → RecommendationAgent → recs         │
  │  each step is INDEPENDENT; server doesn't remember diagnosis    │
  └────────────────────────┬────────────────────────────────────────┘
                           │  hop B (each step)
                           ▼
  ┌─ Provider layer ────────────────────────────────────────────────┐
  │  Bloomreach — read-only calls; no rollback needed if step 3     │
  │  fails after step 2                                              │
  └─────────────────────────────────────────────────────────────────┘
```

## Structure pass

### Layers of "what does a workflow step commit?"

```
  "when a step completes, what has been permanently committed?"

  ┌───────────────────────────────────────────────┐
  │ step 2 completes                               │
  │   client:   diagnosis in sessionStorage        │  durable per-tab
  │   server:   nothing (agent returned)           │  ephemeral
  │   provider: N read-only EQL calls executed     │  no state change
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ step 3 completes                              │
      │   client:   recommendations in state           │  ephemeral (UI)
      │   server:   nothing (agent returned)           │  ephemeral
      │   provider: N read-only EQL calls executed     │  no state change
      └───────────────────────────────────────────────┘
```

Because Bloomreach commits nothing on our behalf (read-only), there
is nothing to compensate. **The saga's "compensation" is trivial**:
if step 3 fails, the user retries step 3 with the same diagnosis, or
starts the whole investigation over. No side effect to undo.

### One axis — "what does the server remember between steps?"

```
  "server-side memory of the workflow between steps"

  step 2 running    →   agent loop, diagnosis in RAM
  step 2 returns    →   RAM freed; server forgets
  ────────────────  ↓
                        (client stashes diagnosis in sessionStorage)
  ────────────────  ↑
  step 3 begins     →   server reads diagnosis from ?diagnosis=<JSON>
  step 3 running    →   agent loop, recommendations in RAM
  step 3 returns    →   RAM freed; server forgets
```

The server forgets between steps. The client remembers. Same pattern
as file 04's read-your-writes escape hatch, now applied to workflow
state.

### Seams

- **The `?step=diagnose | recommend | null` param** at
  `app/api/agent/route.ts:115-117` — the seam where "what to do next"
  is decided. Null is the legacy combined run (used by the
  capture-demo script), diagnose runs only the diagnostic agent,
  recommend runs only the recommendation agent.

- **`parseDiagnosis` at `app/api/agent/route.ts:84-95`** — the seam
  where "did step 2 hand something over?" is decided. If not, step 3
  hard-errors with `"no diagnosis was handed over — open the diagnosis
  step first"` (`route.ts:271`). No graceful reconstruction; the
  client must supply it.

- **`useInvestigation` hook** — the client-side seam where step 2's
  output is stashed to sessionStorage before navigating to step 3.
  Named in `.aipe/project/context.md` line 84 as deliberately NOT
  cancelling the in-flight fetch on cleanup (StrictMode-survivability).

## How it works

### Move 1 — the mental model: a two-step saga with the client as the carrier

You know how a checkout flow has multiple pages — enter shipping,
enter payment, confirm — and each step's data has to survive
navigating to the next page? Same idea here. Step 2 produces a
diagnosis; step 3 needs it. The client is the carrier.

```
  The pattern — two-step saga, client-side handoff

  step 2: investigate/[id]/page.tsx
      │
      ▼
  fetch('/api/agent?step=diagnose&insightId=X&insight=<JSON>')
      │
      ▼  NDJSON stream
      diagnostic agent runs
      emits reasoning_step, tool_call_*, diagnosis, done
      │
      ▼
  client reads diagnosis from stream
  stashes in sessionStorage[`bi:investigation:${id}`]
      │
      ▼
  user clicks "see recommendations →"
      │
      ▼
  step 3: investigate/[id]/recommend/page.tsx
      │
      ▼
  reads diagnosis from sessionStorage
  fetch('/api/agent?step=recommend&insightId=X&diagnosis=<JSON>')
      │
      ▼
  recommendation agent runs against the passed diagnosis
```

Bridge: this is a saga in the loose sense — a workflow that spans
multiple invocations, each with its own external work. Not a saga in
the strict compensation-required sense (nothing to compensate).

### Move 2 — walk the mechanism

#### Step 2 — diagnosis is produced and sent

The route runs the diagnostic agent when `step === 'diagnose'` or when
`step === null` (the combined-run path). The diagnosis is emitted as
a NDJSON event before the stream closes:

```typescript
// app/api/agent/route.ts:273-285 (excerpt)
} else {
  req.signal.throwIfAborted();
  stepFor(
    'diagnostic',
    'thought',
    `investigating "${inv.metric}" (${inv.change.direction} ${inv.change.value}% vs ${inv.change.baseline})…`,
  );
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  const t_diag = performance.now();
  diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  recordPhase('diagnostic_investigate', t_diag);
  send({ type: 'diagnosis', diagnosis });
}
```

The `send({ type: 'diagnosis', diagnosis })` is the wire event. The
client's stream reader picks it up. What the client does with it —
stash to sessionStorage, render into the EvidencePanel — is the
important part.

**Load-bearing part: the diagnosis is emitted BEFORE the recommendation
agent runs**, so a step-2-only invocation streams it out and then
`send({ type: 'done' })`. The client has the full diagnosis before the
`done` event, so it can navigate away confidently.

#### The handoff — sessionStorage as the client-side outbox

`lib/hooks/useInvestigation.ts` (referenced in
`.aipe/project/context.md`) stashes the trace and diagnosis in
sessionStorage. When the user clicks "see recommendations," the
recommend page reads it back and passes it to the server as a query
param.

Bridge from what you know: this is the same shape as a form wizard
that passes state through URL params or React context between pages
— you'd write the same code for a checkout flow. Here the params are
JSON-encoded objects rather than plain values.

**Why sessionStorage and not localStorage?** sessionStorage is
per-tab. Two tabs running two investigations don't overwrite each
other's state. If the user closes the tab, the investigation is
abandoned; that's the correct behavior.

**Why not just keep the whole thing on the server across the two
requests?** Because the server can't remember. A warm instance cycle
between step 2 and step 3 would lose the diagnosis. The client-side
outbox survives.

#### Step 3 — the server reads the handoff or hard-errors

```typescript
// app/api/agent/route.ts:266-272 (excerpt)
if (step === 'recommend') {
  // STEP 3: the diagnosis was handed over from step 2.
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
```

`parseDiagnosis` at `route.ts:84-95` validates the shape:

```typescript
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch {
    /* ignore */
  }
  return null;
}
```

Returns null on missing, malformed, or wrong-shape input. The route
converts null to a hard error. This is the strict boundary — no
graceful reconstruction, no fallback to "run diagnostic on the fly."
The user MUST have completed step 2 first.

**A rough edge worth naming honestly:** the step-3 hard error is a
poor UX if the user hits `/investigate/[id]/recommend` cold (no step 2
run yet). The natural fallback would be "run diagnose, then continue
to recommend" — the combined-run path exists in code (`step === null`)
but the split-step UI doesn't use it here. A follow-up would be to
detect the missing-diagnosis case client-side and either redirect to
step 2 or auto-run the combined path.

#### The demo path — replay the saga from a snapshot

`getCachedInvestigation` at `lib/state/investigations.ts:22-28` reads
in this order: in-memory Map → dev cache file → committed
`demo-investigations.json`. In production the disk cache is empty
(serverless FS), so only demo hits.

When it hits, the route replays the events with `filterByStep` at
`route.ts:64-82`:

```typescript
function filterByStep(events: AgentEvent[], step: Step): AgentEvent[] {
  return events.filter((e) => {
    const agent =
      e.type === 'reasoning_step'
        ? e.step.agent
        : e.type === 'tool_call_start' || e.type === 'tool_call_end'
          ? e.agent
          : null;
    if (step === 'diagnose') {
      if (e.type === 'recommendation') return false;
      if (agent === 'recommendation') return false;
      return true;
    }
    if (e.type === 'diagnosis') return false;
    if (agent && agent !== 'recommendation') return false;
    return true;
  });
}
```

This is a filter over a combined-run recording — the demo captures
step 2 + step 3 as one stream, and the replay separates them by
step. This means the demo path doesn't need the sessionStorage
handoff — the client can navigate step 2 → step 3 and the server
replays the appropriate subset.

The tradeoff: any event whose `agent` field is missing/null is
included in BOTH steps. Coordinator-tagged events (from the query
flow) don't collide because they don't appear in insight-based
investigations, but the filter is loose enough that a future
event type without an `agent` tag would leak across steps. Named
here for future maintenance.

#### The other rough edge — cache saves only on the combined run

```typescript
// app/api/agent/route.ts:302 (excerpt)
if (step == null) saveInvestigation(insightId!, collected);
```

Only the combined-run path (used by the demo-capture script) writes
to the cache. Split-step runs don't write. In the live flow, this
means step 2 + step 3 execute fresh every time — no server-side
persistence of the investigation trace. Which is fine (the client
stashes it), but named honestly: this saga has NO server-side
durable record of what happened.

### The skeleton — what a two-step client-carried saga reduces to

Isolate the kernel. The pattern is: "N discrete server invocations,
each stateless; the client carries the state that connects them;
if any invocation fails, the retry starts from that invocation
with the same client-carried state."

What breaks without each part:

- **Drop the diagnosis-in-stream emission** — step 2 completes but the
  client never sees the diagnosis; step 3 can't happen because the
  client has nothing to hand forward.
- **Drop the client-side stash** — step 2 completes and shows the
  diagnosis; user navigates to step 3; no state carried forward;
  server errors. Same rough-edge scenario.
- **Drop the `parseDiagnosis` shape check** — malformed diagnosis
  reaches the recommendation agent as unknown; agent misbehaves in
  hard-to-debug ways. Named here as defensive validation.
- **Drop the demo-mode `filterByStep`** — demo path replays the full
  combined run on both step-2 and step-3 pages; each step shows all
  events (including the other step's), UX breaks.

### What a real distributed-systems saga would need that this doesn't

Because most concepts don't apply, name them explicitly:

- **Transactional outbox** — the pattern where a service atomically
  writes its state change AND an outbox message to the same DB
  transaction, then a poller ships the outbox message to a queue.
  Not applicable here: no DB, no queue. If we grew persistent
  investigations, this pattern would matter for "save investigation +
  publish to team-feed" atomicity.
- **Compensation** — the pattern where saga step N's failure triggers
  a "undo" of steps 1..N-1. Not applicable here: read-only tools mean
  nothing to undo.
- **Long-running orchestrator** — a stateful coordinator that survives
  each step and drives the workflow. Not applicable here: the client
  IS the coordinator, and Vercel's stateless runtime is deliberately
  the wrong platform for a stateful orchestrator.

If we grew mutation tools (voucher issue, campaign send), all three
above become load-bearing. Named honestly.

### Move 3 — the principle

**When the workflow spans invocations but the invocations are
stateless, the client is the natural orchestrator.** Sagas in the
textbook sense assume a stateful orchestrator that survives each
step. In a stateless-runtime architecture, either you buy that
statefulness (Temporal, AWS Step Functions, Vercel Workflows) OR
you push the coordination to the client. This app pushes it to the
client, correctly, because the workflow is user-facing and the
user's browser is the natural anchor. Recognize which shape you're
building and lean into it — a hybrid where the client thinks it's
orchestrating but the server also has half a saga runtime is the
worst of both worlds.

## Primary diagram — the two-step saga in one frame

```
  Diagnose → Recommend, client-carried

  step 2 page                             server                        Bloomreach
  ─────────                               ──────                        ──────────
  loads investigate/[id]/page.tsx
     │
     │  fetch('/api/agent?step=diagnose&insightId=X&insight=<JSON>')
     ├──────────────────────────────────►
     │                                   dsResult = makeDataSource(...)
     │                                   bootstrap(schema)
     │                                   DiagnosticAgent.investigate(inv)
     │                                        │
     │                                        │  callTool('execute_analytics_eql', ...)
     │                                        ├──────────────────────────────►
     │                                        │  4-band defense: cache/spacing/timeout/retry
     │                                        │◄──────────────────────────────
     │  reasoning_step, tool_call_*, ...      │
     │◄───────────────────────────────────────┤
     │  diagnosis event                       │
     │◄───────────────────────────────────────┤
     │  done event                            │
     │◄───────────────────────────────────────┤
     │
     │  useInvestigation stashes in sessionStorage[`bi:investigation:${id}`]
     │
  user clicks "see recommendations →"
     │
     ▼
  step 3 page (recommend)
     │
     │  reads diagnosis from sessionStorage
     │  fetch('/api/agent?step=recommend&insightId=X&diagnosis=<JSON>')
     ├──────────────────────────────────►
     │                                   parseDiagnosis(diagnosisParam)
     │                                   ↑ if null → hard error
     │                                   RecommendationAgent.propose(inv, diagnosis)
     │                                        │
     │                                        │  callTool(...) same 4-band defense
     │                                        ├──────────────────────────────►
     │                                        │
     │                                        │◄──────────────────────────────
     │  reasoning_step, tool_call_*, ...      │
     │◄───────────────────────────────────────┤
     │  recommendation events (N of them)     │
     │◄───────────────────────────────────────┤
     │  done event                            │
     │◄───────────────────────────────────────┤
     │
     │  UI renders RecommendationCards

  Note: server holds NOTHING between step 2 and step 3.
  Note: split-step runs do NOT save to cache. Only combined-run (step=null) saves.
  Note: no compensation needed — every call is read-only.
```

## Elaborate

The "client-orchestrated workflow" pattern shows up in:

- **Multi-page form wizards** — same shape, state in URL/localStorage
- **OAuth flows** — the browser IS the state carrier between authorize
  and callback (see file 07)
- **Sequential AI agent workflows in browser apps** — often built this
  way when the server can't survive between steps

Real distributed-systems saga tooling (Temporal, AWS Step Functions,
Vercel Workflows, Cadence, Camunda) buys you: durable state, retry
policies, timeouts, compensating actions, observability of the whole
workflow. When would you buy it?

- **When the workflow can outlive any user's browser session** — a
  three-day fraud investigation, a nightly data pipeline
- **When compensation is real** — mutations that must be undone on
  downstream failure
- **When you need whole-workflow observability** — regulatory audit,
  incident replay, "which step failed"

None of these are here. The current shape works.

The rough edges named above (step 3 hard-error on missing diagnosis,
split steps don't cache) are real but low-priority. The first is a
one-day fix (client-side check for missing state → redirect to step 2
or auto-run combined). The second is a design decision (do you want
split-step traces to persist? if so, key them by step). Both are named
in file 09.

## Interview defense

### Q: "Do you have any long-running or multi-step workflows?"

Sketch this:

```
  step 2 (diagnose)        step 3 (recommend)
       │                        │
       │                        │
   diagnosis ──stashed in─► sessionStorage ──> ?diagnosis=<JSON>
                                                     │
                                                     ▼
                                           passed to server
                                           parseDiagnosis or fail
```

"Yes — the investigate flow is two steps: diagnose then recommend.
Each step is a separate /api/agent invocation. The diagnosis is
handed forward client-side via sessionStorage → ?diagnosis=<JSON>
query param on the step-3 request. The server holds nothing between
steps; if a warm instance cycles between them, the state survives
because the client carries it. It's a saga in the loose sense — a
multi-invocation workflow — but not in the compensation-required
sense, because all Bloomreach calls are read-only. Nothing to undo
if step 3 fails."

Anchors: `app/api/agent/route.ts:115-117` (step param),
`route.ts:266-285` (step branching),
`route.ts:84-95` (parseDiagnosis).

### Q: "What's the rough edge in this saga?"

"Two. First: step 3 hard-errors with 'no diagnosis was handed over'
if the user opens `/investigate/[id]/recommend` cold. The natural
fallback is to redirect to step 2 or auto-run the combined path.
Second: split-step runs don't cache — the trace is stashed
client-side but never written to `saveInvestigation`. If we wanted
server-side persistence of split-step traces, we'd key them by step.
Both are named honestly."

### Q: "When would you introduce a real workflow engine like Temporal?"

"Three conditions: the workflow can outlive a user's browser (a
multi-day process), mutations require compensation on failure, or
we need whole-workflow observability for audit. None apply now. The
moment we shipped a 'schedule this investigation to run nightly' or
'act on the recommendation by sending a campaign,' the calculus
shifts — Temporal or Vercel Workflows becomes the natural fit."

## See also

- 04-consistency-models-and-staleness.md — the client-carried-state
  pattern from the consistency angle
- 03-idempotency-deduplication-and-delivery-semantics.md — why
  compensation isn't needed (read-only tools)
- 09-distributed-systems-red-flags-audit.md — the step-3 hard-error
  as a ranked usability risk
