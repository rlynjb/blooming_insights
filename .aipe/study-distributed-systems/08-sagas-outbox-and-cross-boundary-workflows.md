# Sagas, Outbox, and Cross-Boundary Workflows

*Industry name: saga pattern · transactional outbox · reconciliation · Type: Industry standard*

## Zoom out — where this concept lives

Multi-step workflows that span multiple services — where a partial failure could leave the system in a half-committed state — are **not yet exercised** in this repo. The two-step diagnose → recommend flow is a client-side handoff, not a saga. Explained here so you know when it becomes relevant.

```
  Zoom out — the workflow surface in this repo

  ┌─ Client (browser) ─────────────────────────────────────┐
  │  investigate flow: step 2 (diagnose) → step 3 (recommend)│
  │  handoff mechanism: sessionStorage carries the diagnosis│
  │  ★ THIS IS NOT A SAGA — it's a client-side handoff ★    │
  └─────────────────────────┬──────────────────────────────┘
                            │  fetch /api/agent?step=diagnose
                            │  fetch /api/agent?step=recommend&diagnosis=…
                            ▼
  ┌─ Server (Vercel function) ─────────────────────────────┐
  │  route.ts: each step is a separate function invocation │
  │  no cross-request state coordination                    │
  │  no compensating action if step 3 fails                 │
  └────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

A saga is a sequence of local transactions across services, where each step has a compensating transaction that undoes it if a later step fails. Classic example: order → charge card → reserve inventory → ship. If shipping fails, you have to unreserve inventory AND refund the card. That's the saga.

**Nothing in this repo has that shape** because nothing writes to more than one service. The diagnose → recommend flow *looks* like a two-step workflow, but it's:

- All reads (no state to compensate).
- Client-orchestrated, not server-orchestrated.
- No commitment made by step 2 that step 3 needs to undo.

## Structure pass

### Layers — where cross-boundary workflows *could* live if they mattered

- **Route** — currently: one HTTP request runs one phase (diagnose OR recommend, not both). Sequenced by the client via `?step=` param.
- **AsyncLocalStorage auth store** — the closest thing to a per-request transaction context. Reads seed at start, writes flush at end. Not multi-service, though.
- **State layer** — no database, no queue, no shared write log.

### One axis held constant — "what happens if step N fails after step N-1 committed?"

```
  Axis: partial-failure recovery in the diagnose → recommend flow

  step 2 diagnose success   → diagnosis returned to browser
                              (browser stores it in sessionStorage)
                              → NO write to any shared state
                              → NO commitment to undo

  step 3 recommend fails    → browser sees an error
                              → user can retry step 3
                              → no compensating action needed
                              → because step 2 wrote nothing

  the "workflow" doesn't need compensation
  because it doesn't commit anything.
```

The answer: **no compensation because no commitment**. That's the honest answer, and it's a design decision — write no shared state until the whole workflow succeeds.

## How it works

### Move 1 — the mental model

You've written a two-page form: page 1 collects name + email, page 2 collects address, submit at the end. If the user closes the tab on page 2, page 1's data lives in `sessionStorage` and is retried when they come back. That's the shape of a "workflow with in-flight state" — but crucially, nothing was written to the server between page 1 and page 2.

```
  The pattern — client-side workflow, no server-side transaction

  step 2 (diagnose):                   step 3 (recommend):
      │                                    │
      │  server writes NOTHING             │  server writes NOTHING
      │                                    │
      │  → returns diagnosis object        │  → returns recommendations
      │                                    │
      ▼                                    ▼
   browser stores in sessionStorage    browser displays
   ────────────────────►                   │
                       user clicks "next"  │
                       browser sends       │
                       diagnosis back      │
                                           │
   if step 3 fails: user retries; no cleanup needed.
```

The kernel: **defer all writes to the last step, OR write only to per-request state that dies naturally.** Either way, no compensation. That's the "just don't have a saga" pattern.

### Move 2 — the walkthrough

#### The diagnose step — reads only, returns a value

`app/api/agent/route.ts:278` (approx):

```ts
// STEP 2 (diagnose)
if (step === 'diagnose') {
  stepFor('diagnostic', 'thought', `investigating "${inv.metric}"…`);
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  const diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  send({ type: 'diagnosis', diagnosis });
}
```

What this DOES: streams reasoning + tool calls, ends with a `diagnosis` event carrying the structured `Diagnosis` object. What this does NOT: write to any shared state. The `saveInvestigation` call at line 307 is guarded — it only fires on the *combined* run, not the split steps.

The browser reads the `diagnosis` event, stashes it in `sessionStorage`, and moves the user to step 3.

#### The recommend step — reads the client's payload, generates fresh

`app/api/agent/route.ts:272`:

```ts
if (step === 'recommend') {
  // The diagnosis was handed over from step 2.
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
```

The `?diagnosis=…` URL param carries the JSON that step 2 produced. `parseDiagnosis` validates the shape (`route.ts:85`). If it's missing or malformed, the route errors out clearly — the user is told to reopen the diagnosis step.

**This is the failure mode**: step 3 can fail because step 2's diagnosis is missing. What compensates? *Nothing*, because step 2 wrote nothing. The user just re-runs step 2.

```
  Failure modes and their compensation

  step 2 succeeds, step 3 fails:
    → browser retries step 3 (with same diagnosis)
    → NO server-side cleanup needed

  step 2 diagnosis missing at step 3:
    → route throws; browser shows error
    → user reopens step 2

  step 2 succeeds, browser closes tab:
    → diagnosis lives in sessionStorage (per-tab)
    → tab reopen → diagnosis still there → step 3 works
    → tab closed permanently → diagnosis lost, user re-runs step 2
```

#### The AsyncLocalStorage auth store — a mini transaction context

The closest thing to a transaction boundary in this codebase is the ALS-scoped auth store (`lib/mcp/auth.ts:86`):

```ts
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {…});
  }
  return result;
}
```

- **Read at the start**: decrypt the cookie into ALS.
- **All reads/writes during**: go through ALS, not the cookie API.
- **Flush at the end**: encrypt + re-set the cookie if `dirty`.

This is **transactional-ish** at the request scope: either the entire request's mutations land (cookie is re-set) or none do (early throw → no set). But it's not a saga — there's only one participant (the cookie), no compensating action needed because a throw simply leaves the previous cookie value in place.

**What would break the pattern**: if the auth flow needed to write to TWO places (say, a Redis session AND the cookie) and one write succeeded but the other failed, that's when a saga vocabulary would enter. Today: one place, one commit point, no compensation.

#### The load harness — sequential per-investigation semantics

`eval/load.eval.ts` runs N investigations at concurrency K. Each investigation is atomic-per-worker: it either completes (diagnose + recommend) or throws. Failures are recorded but don't cascade — other workers keep running. That's **at-most-once per investigation**, at-least-once for the load harness as a whole (which is what a load harness is *supposed* to do).

```
  Load harness — each investigation is its own transaction

  worker 1: [inv 1 diag → inv 1 rec] → done or FAILED
  worker 2: [inv 2 diag → inv 2 rec] → done or FAILED
  worker 3: [inv 3 diag → inv 3 rec] → done or FAILED

  no cross-investigation state → no cross-investigation compensation
```

### Move 2.5 — current state vs future state

```
  Phase A (now):                    Phase B (when writes land):
  ──────────────                    ──────────────────────────

  · all tools read-only              · read tools + write tools
  · no shared writes                 · write tools go through a
  · diagnose → recommend is a          transactional outbox
    client-side handoff              · sagas compose write tools:
  · no compensation needed             each step has a compensating
                                        action (e.g. delete_campaign
                                        as compensation for
                                        create_campaign)
                                     · reconciliation job runs on
                                        boundaries: "for each in-flight
                                        saga older than N minutes,
                                        replay the compensation chain"
```

The migration cost is real: any write-service you integrate with needs an idempotency-key contract AND a compensation contract. If Bloomreach ever exposes a write API (create a segment, update a campaign), that's the moment sagas earn their complexity.

### Move 3 — the principle

**Don't have a saga if you can avoid it.** The right pattern for multi-step workflows is:

1. **Defer all writes to the last step.** If steps 1-N are reads, only step N+1 writes, and step N+1 is atomic, you don't need compensation.
2. **Failing that, make writes idempotent.** Idempotent writes tolerate retries; no compensation needed for a duplicate.
3. **Failing that, use a transactional outbox.** Write the intent to your own DB in the same transaction as the local state change; a background worker replays the outbox to external services.
4. **Failing that, use a saga.** Named steps, compensating actions, reconciliation on partial failure.

This repo lives at level 1: defer all writes to nothing. That's the cleanest option; it just requires that the workflow shape supports it.

## Primary diagram

The two-step flow, one frame, with the "no writes" property called out:

```
  Diagnose → recommend — client-orchestrated handoff, no saga

  ┌─ Browser ──────────────────────────────────────────────┐
  │  step 2 UI                                              │
  │    fetch('/api/agent?step=diagnose&insight=…')          │
  │                                                         │
  │    reads NDJSON stream:                                 │
  │      reasoning_step, tool_call, ..., diagnosis, done    │
  │                                                         │
  │    sessionStorage.setItem('diagnosis', JSON.stringify(d))│
  │                                                         │
  │  user clicks "propose actions"                          │
  │                                                         │
  │  step 3 UI                                              │
  │    fetch('/api/agent?step=recommend&diagnosis=' + enc)  │
  │                                                         │
  │    reads NDJSON stream:                                 │
  │      reasoning_step, tool_call, ..., recommendation×N,  │
  │      done                                               │
  └─────────────────────────────────────────────────────────┘

  ┌─ Server (per-request, no cross-request state) ─────────┐
  │  step=diagnose invocation:                              │
  │    reads MCP tools                                      │
  │    → returns diagnosis in stream                        │
  │    → NO writes to shared state                          │
  │    → NO commitment to undo                              │
  │                                                         │
  │  step=recommend invocation:                             │
  │    reads MCP tools + client-supplied diagnosis          │
  │    → returns recommendations in stream                  │
  │    → NO writes to shared state                          │
  │    → NO commitment to undo                              │
  └─────────────────────────────────────────────────────────┘

  compensation: not needed because nothing was committed.
```

## Elaborate

**Sagas** were named by Garcia-Molina and Salem in 1987, revived by microservices literature (Chris Richardson's *Microservices Patterns*). Two flavors: *choreography* (each service publishes events, others subscribe and compensate) and *orchestration* (a central coordinator drives the workflow, calling each service and compensating on failure).

**The transactional outbox pattern** — write the intent to your own DB row in the same transaction as the local state change, then a background worker reads the outbox and calls the external service — is the standard way to get "exactly-once" semantics for cross-service writes. Debezium + Kafka is one implementation.

**Reconciliation** is the "eventual consistency of last resort" — a periodic job compares your local state to a source of truth (billing provider, inventory system) and repairs drift.

**None of this exists here** because this repo doesn't cross a write boundary. When the app grows a write tool — creating a campaign, updating a segment, saving an investigation to a durable store — the vocabulary above becomes load-bearing. Until then, "no saga because no writes" is the honest description.

Related: the diagnose → recommend flow *is* a coordinated workflow — just not a distributed one. The coordination lives in the browser (sessionStorage carries the diagnosis; the user drives the transition). That's a valid design: keep the workflow orchestration where the state naturally lives, and don't manufacture server-side state you don't need.

## Interview defense

**Q: "Do you have sagas or multi-step transactional workflows?"**

A: No. The two-step diagnose → recommend flow looks like a workflow, but it's a client-side handoff — the diagnosis lives in `sessionStorage` between requests, and the server writes nothing between step 2 and step 3. If step 3 fails, the browser retries; there's no compensating action because there was no commitment.

**Load-bearing gotcha**: this works only because every MCP tool is read-only. The moment a write tool lands (create a campaign, update a segment), the workflow can't stay this simple — I'd need either an outbox pattern or a saga with compensating actions.

**Q: "What would push you toward a saga?"**

A: Any write that touches more than one service atomically. Say we grew a "save this investigation as a monitored alert" feature: it'd write a row in our own DB and register a webhook with Bloomreach. If the webhook registration fails after our row is written, we'd have a stale row. The two moves I'd consider:

1. **Transactional outbox**: write the row + an outbox row in one local transaction; a background worker replays the webhook registration. Retries are safe because the outbox worker is idempotent.
2. **Saga with orchestration**: a coordinator state machine — "register webhook, then write row" (both idempotent). If webhook succeeds but row write fails, cancel the webhook.

For a small team, outbox first. Sagas are for when you have many write-services and clear ownership boundaries.

**Q: "What ordering guarantees do you have across the two steps?"**

A: Strict, but client-driven. The browser sends step 3 only after step 2 completes and the user clicks. Server never re-orders. If two tabs of the same investigation ran concurrently, they'd each do their own step 2 and step 3 independently — no shared state, no conflict.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the read-only tool invariant that lets this be simple.
- `06-queues-streams-ordering-and-backpressure.md` — the streaming surface that carries the diagnosis.
- `09-distributed-systems-red-flags-audit.md` — where "we don't need a saga yet" is a documented assumption.
