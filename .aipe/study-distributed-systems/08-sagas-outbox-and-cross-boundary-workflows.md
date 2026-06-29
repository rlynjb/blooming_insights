# Sagas, outbox, and cross-boundary workflows

*Industry standard — multi-step distributed workflows, compensating actions, transactional outbox, reconciliation.*

## Verdict — `not yet exercised`, and the absence is load-bearing

There are no sagas, no transactional outbox, no compensating actions, no two-phase commit, no reconciliation jobs. The reason isn't omission — it's that **the recommendation agent's output is prose, not POSTs**. The system proposes Bloomreach actions; it never executes them across a boundary. That single product decision is what keeps this entire chapter out of the codebase.

```
  Zoom out — what cross-boundary workflows would even look like here

  ┌─ L1: Browser ──────────────────────────────────────────────────┐
  │  user reads a recommendation                                    │
  │  user copies steps                                              │
  │  user opens Bloomreach UI in another tab                        │
  │  user does the work manually                                    │
  │  ★ THE HUMAN IS THE WORKFLOW EXECUTOR ★                          │
  └─────────────────────────┬──────────────────────────────────────┘
                            │
  ┌─ L2: Route ─────────────▼──────────────────────────────────────┐
  │  /api/agent runs three agents (monitoring/diagnostic/recommend) │
  │  each agent runs IN-PROCESS — no cross-boundary writes          │
  │  output: a Recommendation object (rationale, steps, impact)      │
  └─────────────────────────┬──────────────────────────────────────┘
                            │
  ┌─ L3 + L4 ───────────────▼──────────────────────────────────────┐
  │  no write to Bloomreach                                          │
  │  no write to a queue                                             │
  │  no compensating write on failure                                │
  │  ★ nothing to roll back, because nothing committed ★              │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the question this file answers

> What would saga / outbox / compensating-action mechanisms be doing in this codebase if they existed, and why is it correct that they don't?

One answer: the codebase has zero multi-step writes that span a boundary. The recommendation agent emits a `Recommendation { steps[], bloomreachFeature, … }` JSON object the UI renders as a card; the human applies it via Bloomreach's own UI. **The cross-boundary workflow is offloaded to the human; the system commits nothing externally.**

This file walks what would change if "one-click apply" ever shipped.

## Structure pass — the skeleton (of an absent thing)

### Axes — trace "where do writes commit?"

```
  One axis: "where does this operation commit, and who can roll it back?"

  L1 Browser              writes commit to sessionStorage / DOM
                          rollback: trivial (overwrite or refresh)

  L2 Route                writes commit to in-memory Maps
                          rollback: process restart wipes them anyway

  L3 DataSource           NO WRITES — reads only
                          (rollback question doesn't arise)

  L4 Bloomreach           NO WRITES from us
                          (the human writes through the Bloomreach UI;
                           Bloomreach handles its own rollback)
```

The axis-answer is "nowhere external" at every layer below L1. **No commit → no rollback question → no saga.** The whole chapter is downstream of one product decision.

### Seams — where a cross-boundary workflow *would* attach

```
  Where multi-step distributed workflows WOULD show up

  if/when the product…                       …this file would teach…
  ──────────────────────                     ────────────────────────

  ships "apply recommendation" buttons        the saga: a multi-step write
   that POST scenarios/segments/vouchers       to Bloomreach with explicit
   to Bloomreach                                rollback steps if any fails

  ships nightly briefings that email           the outbox: persisted "send
   summaries to users                           email" intents with an
                                                idempotent sender

  ships webhooks that notify external          the outbox: same pattern;
   systems on anomalies                         retries until ack, dedup
                                                on receiver

  ships imports from external systems          reconciliation: periodic
   (e.g. ingest customer data into              jobs to detect and repair
   Bloomreach)                                  divergence between sides
```

Each row maps a hypothetical product feature to the canonical pattern that would handle it. None are present today.

## How it works — the absent picture in detail

### Move 1 — the mental model

You've seen this pattern in any e-commerce checkout: "create order → charge card → reserve inventory → email confirmation." Each step touches a different service. If step 3 fails after steps 1 and 2 succeeded, you need to *compensate* (refund the card, cancel the order). That's a saga.

> **A saga is a multi-step workflow across services where each step has an explicit compensating action, run if any later step fails. It's the distributed-systems pattern for "I can't do this in one transaction; I'll do it as many small ones with documented rollback."**

```
  The saga kernel — the shape that's NOT here

  step 1: create order               compensate: cancel order
  step 2: charge card                compensate: refund
  step 3: reserve inventory          compensate: release reservation
  step 4: send confirmation email    compensate: send "we couldn't fulfill"

  forward path:  1 → 2 → 3 → 4 → done
  failure at 3:  3 fails → compensate(2) → compensate(1) → done with failure
  failure at 4:  4 fails → no rollback (email is best-effort) → done OK

  this codebase: NONE of this is present, because nothing commits across
  a boundary that needs rollback.
```

The whole chapter is "what would this look like if the recommendation agent's `Recommendation.steps` became *executable* instead of *advisory*."

### Move 2 — walk the parts (against absence)

#### Part 1 — the recommendation output today (the prose endpoint)

`lib/mcp/types.ts` defines:

```ts
type Recommendation = {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: string;
  confidence: 'high' | 'medium' | 'low';
};
```

`steps` is a `string[]`. The UI renders them as numbered list items in `RecommendationCard`. **A human reads them and follows them in Bloomreach.** That's the entire workflow.

```
  Today's workflow — the human IS the workflow engine

  recommendation agent
       │
       ▼
   emits Recommendation { steps: ["create segment...", "save it...", ...] }
       │
       ▼
   UI renders steps as numbered list
       │
       ▼
   human reads steps
       │
       ▼
   human opens Bloomreach UI in a new tab
       │
       ▼
   human performs each step
       │
       ▼
   Bloomreach acks each step (its own internal commit)

   the system observes none of this — there's no callback,
   no "applied" state, no follow-up briefing keyed to the change.
```

This is honest about what the product currently is: an analyst that shows its work, not an analyst that *does* work. The work is delegated to the user with provenance.

#### Part 2 — what saga + outbox would do if we shipped "one-click apply"

```
  Hypothetical "apply" — what would have to change

  step                                  pattern needed
  ─────                                  ──────────────
  validate the recommendation against   read-side (we already do this
   current Bloomreach state              indirectly via the diagnostic
                                         agent's evidence)

  POST to Bloomreach for each step:      saga, with explicit compensation
   create segment, create scenario,      per step
   wire scenario to segment, etc.

  if any step fails partway,             compensating actions:
   undo earlier steps                     • created segment? DELETE it
                                          • created scenario? DELETE it
                                          • wired them? UNWIRE them

  if the user closes the tab mid-apply,  outbox: persist the intent so a
   we still need to complete or rollback  worker can resume / compensate
   the saga                               after the request dies

  idempotency for each POST              idempotency key per step
                                          (so a retry doesn't double-create)

  observability for users (did it         streaming step status, like the
   work? which step are we on? what       agent's current trace, but for
   failed?)                                writes instead of reads
```

The honest assessment: this is a *lot* of new machinery, and it shouldn't be added speculatively. The current shape (prose recommendations + human execution) defers the entire chapter without losing the product value.

#### Part 3 — the transactional outbox (and why we don't need it)

The outbox pattern: write the intent ("send this email," "POST this webhook") to a local store inside the same transaction as the business write, then a separate worker reads the outbox and performs the side-effect. Solves the "what if we crash between commit and side-effect?" problem.

```
  The outbox kernel — the shape that's NOT here

  business transaction (your DB):
    BEGIN
      INSERT INTO orders (...)
      INSERT INTO outbox (event_type, payload) VALUES ('order_created', {...})
    COMMIT

  outbox worker (separate process, polling or CDC):
    SELECT * FROM outbox WHERE processed_at IS NULL
    for each row:
      try: post webhook / send email / call downstream
      mark processed_at = NOW() if success
      retry with backoff on failure
      give up after N attempts → DLQ
```

We don't have this because:
- No business writes to local DB → no transaction
- No webhooks emitted → no side-effects to defer
- No emails sent → same
- No need for "exactly-once side-effect" semantics

If the product ever ships "email me a weekly summary," the outbox is the right pattern: persist the "send email" intent in the same transaction as creating the briefing record, then a separate worker (or Vercel Cron) drains the outbox and posts to SendGrid/Postmark. That's the world this file would describe.

#### Part 4 — reconciliation (and why we don't need it either)

Reconciliation: a periodic job that detects and repairs divergence between two sides of a system. Examples: nightly comparison between your billing system and Stripe; sweeping for orphan records after a partial failure; retrying outbox entries stuck for >24h.

We don't have any divergence to detect because **we don't write to the other side**. The diagnostic agent reads Bloomreach; if its conclusions are wrong, the next briefing will produce different conclusions — which is reconciliation by *re-reading*, not by *repair*.

```
  Reconciliation — when it earns its place

  needs reconciliation                       does NOT need it (today's shape)
  ──────────────────────                     ─────────────────────────────────
  two systems each accept writes              one read-side (us) + one source-
   for the same logical entity                of-truth (Bloomreach)

  async side-effects that may                no side-effects emitted
   silently fail

  long-running workflows that                no long-running workflows;
   may be interrupted                         every request is request-scoped
```

### Move 2.5 — current state vs future state

```
  Phase A (today — read-only advisory)         Phase B (one-click apply)
  ──────────────────────────────────           ────────────────────────────────

  recommendation agent emits                   recommendation agent emits the
   prose steps                                  SAME prose AND emits an
                                                executable plan (op log)

  human applies in Bloomreach UI               "Apply" button POSTs the plan
                                                to /api/recommendation/apply

  no cross-boundary writes                     /api/recommendation/apply runs
                                                a saga:
                                                  - validates current state
                                                  - executes each step against
                                                    Bloomreach with idempotency
                                                    key
                                                  - compensates on failure

  no outbox needed                             outbox: persist intent before
                                                returning to user; worker drains;
                                                survives Vercel function death

  no reconciliation needed                     periodic job: detect "applied
                                                but no impact observed after N
                                                days" and surface as alert

  observability: stream the agent's            observability: stream the apply
   reasoning trace                              status per step + saga overall
                                                state
```

The honest framing: Phase A is shipped and tested. Phase B is a substantial engineering project. The migration cost: ~3-5 new files (apply route, saga runner, outbox table, worker, compensation helpers), ~2 new infra dependencies (persistent store for the outbox, scheduler for the worker), plus the per-tool idempotency story (file 03). **What doesn't have to change:** the recommendation agent's output shape stays the same; the UI for displaying recommendations stays the same; the streaming surface stays the same.

### Move 3 — the principle

> **A saga is the answer to "I had to commit a write across services and one step might fail." If you never commit a write across services, you never need a saga. Pushing execution to the human is a valid, often-better answer when the writes are infrequent, high-judgment, and reversible by other means.**

The deeper move: **count your cross-boundary writes before you reach for saga/outbox machinery.** If the count is zero, the chapter doesn't apply. If the count is one and the operation is naturally idempotent (e.g. an upsert with a stable key), you might not need the full saga apparatus — just idempotent retries with compensating reads. The full saga + outbox + reconciliation triad is for systems with *many* such writes and *strict* end-to-end semantics. Reach for it then; not before.

## Primary diagram — the absent workflow

```
  Cross-boundary workflows — what's here, what's not

  what IS here                          what is NOT here
  ─────────────                          ────────────────

  recommendation agent                   apply-recommendation endpoint
  → emits prose steps                    → would POST scenarios/segments/etc.

  human applies in Bloomreach UI         saga runner
                                         → with compensating actions per step

  no persisted intent                    transactional outbox
                                         → persist intent before side-effect

  no follow-up worker                    outbox worker (Vercel Cron / similar)
                                         → drains outbox; retries; gives up to DLQ

  no impact tracking after apply         reconciliation job
                                         → detects "applied but no impact"

  ★ the entire right column is absent because the product decided
    "show your work, don't do the work" — that decision is the load-bearing
    one; the absence is correct.
```

## Elaborate

The references for the absent material:

- **Sagas** (Garcia-Molina & Salem, 1987). The original paper. The pattern was originally about *long-lived transactions* in single databases; modern microservices repurpose it for cross-service flows. The mental model is the same: each forward step has a compensating backward step.
- **Transactional outbox** (Chris Richardson, *microservices.io*). The pattern for atomic "write business data + emit event" without distributed transactions. The CDC-based variant (Debezium) reads the outbox via log mining; the polling variant is simpler and good enough for many workloads.
- **Choreography vs orchestration** for sagas. Orchestration: one component runs the saga, knows all steps, sends commands. Choreography: each service reacts to events, no central coordinator. Choreography scales but is harder to debug; orchestration is easier to reason about but creates a coordinator dependency. *If we ever ship Phase B, orchestration is the right starting point — small team, small surface, easy debugging.*
- **Compensating actions vs retry-forward.** When a step fails: roll back (compensate) or push forward (retry until success)? Depends on the operation. POST-to-Bloomreach feels retry-forward (the failure is usually transient); a "send irrevocable email" feels compensate (the recipient already has it).

The cleanest current example to study, even though it's not in this codebase: **Stripe's "idempotency keys + webhooks + retry-forward + reconciliation by event ID" stack.** It's the textbook modern shape for one-to-one external-write coordination, and it's roughly what Phase B here would look like if shipped.

## Interview defense

### "Why no sagas?"

Because there are no cross-boundary writes. The recommendation agent emits prose steps that a human applies in Bloomreach's own UI; the system never POSTs anything that needs rollback. The product shape is "an analyst that shows its work" — provenance + reasoning + advice, not execution. If the product ever ships "one-click apply," that's when the saga conversation starts, and the first decision is per-step idempotency (so retries don't double-create scenarios) rather than rollback machinery (compensating actions). Today the human is the workflow engine, and the system observes none of the execution — which is a legitimate product choice for the current scale and user expectations.

*Anchor:* `lib/mcp/types.ts` defines `Recommendation.steps: string[]` — strings, not executable operations. That type signature *is* the design decision.

### "What would the transactional outbox look like in this system, and why isn't it there?"

The outbox would be a persistent table (Postgres or KV-with-ordering) where each row is an intent: `{ event_type, payload, attempts, processed_at }`. A route handler that wanted to perform a side-effect — say, "send a weekly summary email" — would INSERT the intent in the same transaction as creating the briefing record, then return to the user immediately. A separate worker (Vercel Cron firing every minute, or an external scheduler) would poll the outbox, perform the side-effect (post to SendGrid), and mark the row processed. Retries with backoff for transient failures, DLQ after N attempts.

It's not there because there are zero side-effects to defer. No emails, no webhooks, no async work that has to survive a function death. The day the product adds one — the first emailed summary, the first Slack webhook — is the day the outbox earns its place.

### "If you had to add execution tomorrow, what would you build?"

Three pieces, in this order: (1) per-tool idempotency at the DataSource layer — every write call carries a stable idempotency key derived from `(insight_id, recommendation_id, step_index)`, so retries don't double-create. (2) An orchestration layer in a new route, `/api/recommendation/apply`, that runs the steps as a saga: validate → POST step → on failure, run compensating DELETE for already-completed steps → stream status events back to the UI (using the existing NDJSON pipeline). (3) An outbox in KV or Postgres so that if the Vercel function dies mid-saga, a worker can resume or compensate; the route hands the saga off and returns immediately.

The hardest part is *not* the saga code — it's the per-Bloomreach-action contract: which actions are reversible, which idempotency keys does Bloomreach accept, what does each error mean. That's research time, not coding time. The mechanics are well-trodden; the integration knowledge is the work.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the per-call idempotency layer this would build on.
- `04-consistency-models-and-staleness.md` — why we don't have the consistency hazards sagas exist to manage.
- `05-replication-partitioning-and-quorums.md` — same shape of absence, different chapter.
- `09-distributed-systems-red-flags-audit.md` — the day "apply" ships, the audit picks up new rows.
- `.aipe/study-system-design/` — the product decision (advisory vs executive) at architectural altitude.
