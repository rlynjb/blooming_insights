# Sagas, outbox, and cross-boundary workflows

**Industry name:** saga pattern (orchestrated / choreographed), transactional outbox, compensating transactions, two-phase commit · **Type:** Industry standard — Case B (not exercised in this repo)

## Zoom out, then zoom in

Verdict, first sentence: **this codebase has no cross-boundary write workflow, so it has no saga, no outbox, and no compensation logic.** The recommendation agent *proposes* Bloomreach actions (create a scenario, send a campaign, publish a voucher) — it does not execute them. That's the deliberate scope choice that keeps this whole chapter empty.

```
  Zoom out — where sagas WOULD live (and don't)

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  RecommendationCard: "create a scenario, here's how"      │
  │  (HTML + steps — the user clicks through manually in BR)  │
  └────────────────────────┬─────────────────────────────────┘
                           │ proposal, not execution
  ┌─ Service layer ────────▼─────────────────────────────────┐
  │  RecommendationAgent.propose                              │
  │  returns Recommendation[]                                 │
  │  ✗ never writes to Bloomreach                            │
  │  ✗ no side effects to orchestrate                        │
  │  ✗ no compensation needed                                 │
  └──────────────────────────────────────────────────────────┘

  ┌─ Provider layer ─────────────────────────────────────────┐
  │  Bloomreach loomi-MCP — we only call read tools           │
  │  (list_*, get_*, execute_analytics_eql)                   │
  └──────────────────────────────────────────────────────────┘
```

This file is here so you know the vocabulary, recognize when the gap would start mattering, and can defend the absence in an interview.

## Structure pass (compressed — there is no mechanism to walk)

### Axis: what side effects cross the boundary?

```
  Trace "side effects" across the stack

  Browser            — side effects: navigation, sessionStorage writes
                       — all local, all reversible by page reload

  Vercel function    — side effects: in-memory state, console.log
                       — process-local, ephemeral

  BloomreachDataSource — side effects: NONE — read tools only
                       — cache writes are also local-only

  Bloomreach upstream — side effects: NONE from our side
                       — (we don't call create_scenario, send_campaign,
                          publish_voucher, etc.)
```

The axis-answer is "none" at every layer beyond the browser. No side effects to orchestrate.

### Seams (load-bearing absences)

- **No write/read seam at Bloomreach.** Every tool call is a read; there's no "create-then-rollback" boundary to defend.
- **No multi-system saga.** We don't write to a local database AND to Bloomreach AND to Anthropic in one workflow. Anthropic is a stateless model call; Bloomreach is read-only; there's no local store. Zero coordination cost.
- **No outbox.** No "I committed locally, now ensure the message reaches the queue" boundary, because no queue and no local commit.

## Move 1 — what a saga would look like if it existed

For contrast, here's the shape this repo *would* take if a write workflow landed.

```
  Hypothetical: a saga for "publish a winback campaign" (not in this repo)

  user clicks "execute this recommendation"
            │
            ▼
  ┌─ Step 1: create_segment ─────────────────────────────────┐
  │  POST Bloomreach: define "high-value at-risk customers"   │
  │  success → segmentId                                       │
  │  failure → bail, nothing to compensate                     │
  └────────────────────┬─────────────────────────────────────┘
                       │
            ▼
  ┌─ Step 2: create_voucher_pool ────────────────────────────┐
  │  POST Bloomreach: 10% off pool for the segment            │
  │  success → voucherPoolId                                   │
  │  failure → compensate: delete the segment from step 1?    │
  │           (or leave it — segments are reusable)            │
  └────────────────────┬─────────────────────────────────────┘
                       │
            ▼
  ┌─ Step 3: create_scenario ────────────────────────────────┐
  │  POST Bloomreach: trigger on segment, send voucher        │
  │  success → scenarioId                                      │
  │  failure → compensate: delete voucher, delete segment?    │
  │  partial failure → did the scenario start or not?         │
  └────────────────────┬─────────────────────────────────────┘
                       │
            ▼
  ┌─ Step 4: activate_scenario ──────────────────────────────┐
  │  PATCH Bloomreach: status=active                          │
  │  this is the point of no return — customers may have     │
  │  already received vouchers                                 │
  └──────────────────────────────────────────────────────────┘

  This is what we would need:
    • orchestrator (a state machine tracking which step we're on)
    • compensation handlers (some reversible, some irreversible)
    • idempotency keys (so retry of step N doesn't create N copies)
    • outbox (so a crash between local-commit and Bloomreach-write
      doesn't lose the work; reconciliation worker drains it)
    • saga log (so an operator can see "step 3 failed, here's the partial state")
```

None of this is in the repo. The recommendation agent stops at "here's what to do" precisely because building "here's the system that does it" is a different scope.

## Move 2 — what's actually here, by way of counter-example

### Recommendations are inert HTML, by design

```ts
// lib/mcp/types.ts (referenced from project-context.md)
Recommendation {
  id, title, rationale,
  bloomreachFeature: scenario|segment|campaign|voucher|experiment,
  steps[],                          ← ordered text steps for the user
  estimatedImpact,
  confidence
}
```

The `steps[]` field is plain text instructions for the human to execute in Bloomreach's UI. The agent reasons over the workspace, picks an action shape, and writes the steps. The user reads them and decides to act (or not). No write call happens from our system.

### The agent loop only calls read-shaped tools

The tool catalogs in `lib/mcp/tools.ts` (referenced from project-context.md) enumerate `bootstrapTools`, `monitoringTools`, `diagnosticTools`, `recommendationTools`, `queryTools` — and *all of them* are reads. There's no `create_segment`, no `publish_scenario`, no `send_campaign`. The synthetic data source (`lib/data-source/synthetic-data-source.ts:314`) has the same shape — all reads.

This is the **deliberate scope decision** that keeps the saga chapter empty: by restricting the agent to reads, we never create the cross-boundary write problem.

### Local "transactions" don't exist either

There's no local database, so there's nothing to commit locally before talking to Bloomreach. The closest thing is `lib/state/insights.ts:57`:

```ts
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

A non-atomic in-memory replace. If the process crashed between `s.insights.clear()` and the `forEach`, the next request would see an empty Map and re-run the briefing. That's "self-healing by re-execution," which is the cheapest possible compensation pattern.

## What would change if a write workflow landed

A ranked list of what'd need to be added, in order of when each starts mattering:

1. **Idempotency keys.** First. The recommendation step says "POST /scenarios with `Idempotency-Key: <uuid>`" so a retry of the same logical step doesn't create two scenarios. Bloomreach's API would need to support this (or we'd implement client-side dedup against a local cache).
2. **A reconciliation log.** After step 1 succeeds and before step 2 starts, log "step 1 done, segmentId=…" somewhere durable. If the process dies, the next attempt reads the log and resumes from step 2.
3. **Compensation handlers.** For each forward step, a handler that undoes it (or marks "undo not possible — alert operator"). Some steps in the hypothetical above are reversible (delete the segment); some aren't (the campaign already went out).
4. **An outbox table.** If we ever introduce a local database alongside Bloomreach, the outbox pattern bridges the two-phase commit gap: write the local change AND an outbox row atomically (one local transaction), then a background worker drains the outbox to Bloomreach with retries. Solves the "local commit succeeded, Bloomreach call failed" problem.
5. **A saga orchestrator.** Either code-as-state-machine (functions that check the log and resume) or a real workflow engine (Temporal, AWS Step Functions, Inngest). At our scale, the code-as-state-machine option is fine.

This list is the migration path. We're at step 0 because we deliberately chose to be.

## Why this doesn't matter (yet)

The product framing keeps this corner empty:

- The product's pitch is **"an analyst that shows its work"** — proposing, not acting.
- The "what to do" output is consumed by a human, who has the agency (and accountability) to actually execute it in Bloomreach's UI.
- Bloomreach's UI is already a fine orchestrator for the manual write flow — we'd be re-implementing it.

The architectural pressure that *would* push us into real sagas: "execute this with one click" buttons in the recommendation cards, or an autonomous mode where the monitoring agent triggers actions without human approval. Both are real product directions; neither has shipped.

## Primary diagram

```
  Full picture — what's NOT here

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  RecommendationCard renders steps[] as text                        │
  │  user opens Bloomreach UI in another tab and executes manually     │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ no execute button
  ┌─ Vercel function ──────────▼──────────────────────────────────────┐
  │  RecommendationAgent.propose → Recommendation[]                    │
  │  ✗ no orchestrator                                                 │
  │  ✗ no outbox                                                       │
  │  ✗ no compensation log                                             │
  │  ✗ no idempotency keys (nothing to dedup against)                  │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS — read tools ONLY
  ┌─ Bloomreach loomi-MCP ─────▼──────────────────────────────────────┐
  │  list_scenarios, get_segment, execute_analytics_eql, ...            │
  │  ✗ create_scenario, publish_campaign, activate_voucher are not     │
  │    called from our system. The user calls them via Bloomreach UI.  │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The saga pattern was introduced by Garcia-Molina & Salem in 1987 — long-lived transactions composed of local subtransactions where each has a compensating action. The pattern survives because two-phase commit (2PC) doesn't scale across heterogeneous systems and synchronous coordination is brittle.

Industry vocabulary worth knowing even without exercising it:

- **Orchestrated saga** — a central orchestrator (Temporal, Step Functions, custom code) drives each step and decides whether to advance or compensate. Easier to reason about; the orchestrator is a single point of failure.
- **Choreographed saga** — each step emits an event; downstream services subscribe and react. No central orchestrator. Scales better, harder to debug.
- **Transactional outbox** — atomic local commit + outbox row in the same DB transaction; background worker drains the outbox to the message bus. Solves the "publish-after-commit" race that breaks when the local commit succeeds but the publish fails.
- **Compensating transaction** — the "undo" for a previously-committed step. Has to be designed in: not every operation is reversible (sent emails, charged cards, published campaigns). The job is to make the steps reversible enough to roll back to a sane state, AND to document what's irreversible.
- **Idempotency key** — client-supplied UUID so a retry of the same logical operation doesn't double-execute. Server stores the response in a dedup table for some window; replays it on retry. Stripe is the canonical example.
- **Two-phase commit (2PC)** — coordinator asks all participants to "prepare", then either "commit" or "abort" based on responses. Strong consistency, brittle to failures (the coordinator becomes a single point of failure; a failed coordinator can leave participants blocked indefinitely). Real systems use it within tight coupled boundaries (XA transactions in distributed databases) and avoid it across loose ones.

What to read next: the original Garcia-Molina & Salem saga paper; the Stripe idempotency-keys docs; the Temporal docs for what an orchestrated workflow engine actually does; the Outbox pattern entry in microservices.io.

## Interview defense

**Q: "How do you handle cross-service writes?"**

> "I don't. The recommendation agent proposes Bloomreach actions but doesn't execute them — `Recommendation.steps[]` is plain text rendered as a list in the UI, the user opens Bloomreach in another tab to actually click through. The deliberate scope choice keeps the whole saga chapter empty: by restricting the agent to read tools, I never create the cross-boundary write problem. Bloomreach's own UI is the orchestrator for the manual write flow."

Diagram:

```
  agent.propose → Recommendation[ {title, steps[], confidence} ]
                    ↓
                  UI renders steps as text
                    ↓
                  user reads + opens Bloomreach UI
                    ↓
                  user clicks through manually
```

**Q: "What would change if you added one-click execution?"**

> "Five things, roughly in this order. First, idempotency keys on every write so a retry of step N doesn't create N copies. Second, a reconciliation log — durable record of 'step 1 done, segmentId=X' so a crash mid-saga can resume. Third, compensation handlers per step — some reversible (delete segment), some not (the campaign already went out, customers got the email). Fourth, an outbox if we add a local DB — the standard pattern for atomic local-write + reliable downstream-publish. Fifth, an orchestrator — code-as-state-machine first, then a real engine like Temporal if it grows."

**Q: "What's the deepest saga concept you understand?"**

> "Compensation is where the saga vocabulary earns its place. Two-phase commit gives you ACID across services but it's brittle — a failed coordinator can block participants indefinitely. Sagas give up the ACID and accept *eventual* consistency, with compensating actions running in reverse order to roll back. The interesting part isn't the orchestrator — it's that you have to *design the steps to be compensable* in the first place. 'Send email' isn't compensable. 'Issue voucher' might be cancellable if no one used it yet. 'Reserve inventory then confirm or release' is the canonical reservation pattern that makes the saga work because the intermediate state — reserved-but-not-confirmed — is named and reversible. The pattern is more about the steps than the orchestrator."

**Q: "Why no outbox?"**

> "No local datastore. The outbox pattern bridges 'I committed locally, did the downstream write also succeed?' If I don't have a local commit, there's nothing to bridge. The day this repo grows a database — say, persistent investigations with user notes — the outbox would land at the same time, because that's the first time the local-write/downstream-publish gap exists."

## See also

- `01-distributed-system-map.md` — the picture this file is the counter-example to.
- `03-idempotency-deduplication-and-delivery-semantics.md` — idempotency keys would be the first add when this chapter starts mattering.
- `09-distributed-systems-red-flags-audit.md` — the "no write path" is listed there as a deliberate scope decision, not a gap.
