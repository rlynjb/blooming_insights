# 08 — sagas, outbox, cross-boundary workflows

**Industry name(s):** saga · transactional outbox · compensating transactions · workflow orchestration · long-running workflows
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** blooming insights has **one cross-boundary workflow** worth naming: the **two-step investigation** (diagnose → recommend) — and it's a saga implemented in the simplest possible way, with the *user* as the orchestrator and `sessionStorage` as the outbox. There's no compensation logic because each step is a read-only call against external services; there's nothing to roll back. There's no formal saga library, no state machine, no durable workflow engine — Temporal-style infrastructure is NOT YET EXERCISED. What IS here is the load-bearing observation that **two route invocations coordinate through state the client carries between them** (`bi:diag:<id>`), and that the cached `AgentEvent[]` array in `lib/state/investigations.ts` IS a poor-man's outbox — a durable log of "what the agent did" that can be replayed deterministically. The day a write step is added (executing a recommendation), this entire chapter changes from "trivially safe" to "needs real saga discipline."

---

## Zoom out, then zoom in

```
  Zoom out — the workflow in the system

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  /investigate/[id]                /investigate/[id]/recommend │
  │  step 2: diagnose                 step 3: decide               │
  │                                                                 │
  │  user click  ────hand off────►  user click                    │
  │  diagnosis via sessionStorage                                  │
  │  ★ USER IS THE ORCHESTRATOR ★                                 │ ← we are here
  └─────────────────────────┬─────────────────────────────────┘
                            │ two route invocations
  ┌─ Service layer ─────────▼─────────────────────────────────┐
  │  /api/agent?step=diagnose   /api/agent?step=recommend       │
  │  each: read-only agent loop; no rollback needed              │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼─────────────────────────────────┐
  │  Bloomreach MCP — every called tool is a read              │
  │  (no transactional consistency needed; nothing to undo)    │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *how does this app coordinate a multi-step user-facing workflow that spans multiple route invocations and external service calls, and what would change if any of those steps had side effects?* The current answer is "trivially, because every step is a read and the user drives the flow." This file walks the mechanism, names the absent infrastructure (Temporal, BullMQ workflows, outbox pattern), and pinpoints the boundary where the absent infrastructure starts to matter.

---

## Structure pass

**Layers.** Three. UI (the user driving the workflow by clicking) · Service (two independent route invocations, no cross-request memory) · Provider (read-only external calls).

**Axis: who owns the workflow state.** Hold one question: *at any point between step 2 completing and step 3 starting, who knows the diagnosis exists?* Answer: only the client (in `sessionStorage`). The server does not remember it; Bloomreach doesn't know about it; Anthropic doesn't either. The workflow exists *only in the user's tab* during the interregnum. That's the load-bearing observation — the workflow's persistence layer is the browser.

**Seams.** Two real, one absent.

- **Seam: step 2 completion ↔ step 3 start.** State carrier is `sessionStorage.bi:diag:<id>` (`lib/hooks/useInvestigation.ts:18-19`). User click is the trigger. No automated handoff, no server-side queue.
- **Seam: agent activity ↔ replayable record.** The route's local `collected: AgentEvent[]` (`app/api/agent/route.ts:171`) buffers every event for the duration of the request; on `done`, `saveInvestigation` persists it. That IS an outbox-shaped artifact — every "thing the agent did" lands in an ordered log usable for replay.
- **Seam: workflow ↔ compensation logic** — *does not exist*. No step has side effects, so no rollback is possible or necessary.

```
  Structure pass — the workflow's persistence story

  ┌─ step 2 invocation ─────────────────────────────┐
  │  diagnostic agent runs                            │
  │  emits NDJSON events                              │
  │  buffers events in `collected`                    │
  │  client writes diagnosis to bi:diag:<id>          │
  │  request ends — server forgets everything         │
  └─────────────────┬───────────────────────────────┘
                    │  interregnum: STATE LIVES ONLY ON CLIENT
                    │  (user reading, deciding, clicking)
                    ▼
  ┌─ step 3 invocation ─────────────────────────────┐
  │  client reads bi:diag:<id>                        │
  │  sends to /api/agent?step=recommend&diagnosis=…   │
  │  recommendation agent runs                        │
  │  emits NDJSON events                              │
  │  request ends                                     │
  └──────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know how a database transaction works — wrap N operations, commit or rollback as one unit. A saga is what you reach for when those N operations cross service boundaries and no single transaction can wrap them. Instead of one atomic commit, you do N steps with explicit compensations for the steps that already succeeded.

```
  The saga kernel — the smallest thing that's still the pattern

  step 1 — DO operation A (with compensation A')
  step 2 — DO operation B (with compensation B')
  step 3 — DO operation C (with compensation C')

  if step 3 fails:
    run C' (no-op if C didn't run)
    run B'
    run A'
    end

  vs. transaction:
    BEGIN; A; B; C; COMMIT  ← all-or-nothing, ONE store
    or ROLLBACK              ← undo everything atomically
```

Three load-bearing parts of a saga:
- **explicit step boundaries** — each step is a separate, independently-observable event
- **compensations** — for each step that has side effects, the inverse operation
- **a durable record of what happened** — so on crash you know what to compensate

In blooming insights' two-step investigation, the first part is present (diagnose / recommend are two clear steps), the second is *absent because not needed* (both steps are reads — nothing to compensate), and the third is partially present (the `AgentEvent[]` buffer is a durable record once `saveInvestigation` runs).

### Move 2 — the moving parts

#### Part 1 — the two-step investigation as a saga (with the user as orchestrator)

```
  The investigation workflow — user as orchestrator

  user opens /investigate/<id>
       │
       ▼
  ┌─ step 2 — diagnose ────────────────────────────────┐
  │  GET /api/agent?step=diagnose&insightId=<id>        │
  │  → diagnostic agent runs                            │
  │  → events stream to client                          │
  │  → diagnosis event arrives                          │
  │  → on 'done': client writes bi:diag:<id>            │
  │  → user sees diagnosis rendered                     │
  └──────────────────┬─────────────────────────────────┘
                     │  user reads, thinks, clicks "next"
                     ▼
  user navigates to /investigate/<id>/recommend
       │
       ▼
  ┌─ step 3 — recommend ───────────────────────────────┐
  │  client reads bi:diag:<id>                          │
  │  GET /api/agent?step=recommend                     │
  │              &insightId=<id>                        │
  │              &diagnosis=<json>                      │
  │  → recommendation agent runs                        │
  │  → recommendation events stream                     │
  │  → user sees cards                                  │
  └────────────────────────────────────────────────────┘

  no automated handoff. no server-side queue.
  the user click is what fires step 3.
```

The user being the orchestrator is the cheap version of the workflow pattern. Temporal would give you durable execution: the workflow keeps running even if both client and server die, the engine remembers where it was, it eventually runs step 3 to completion. blooming insights doesn't need that because both steps are interactive and the user *should* drive the flow — automating it would remove the read-the-diagnosis-then-decide UX, which is the whole point of splitting them.

Boundary conditions:
- **User abandons after step 2.** No problem. Nothing is in flight; the diagnosis is in sessionStorage and the cached `AgentEvent[]` is on disk (in dev) or in the in-memory Map. The user can come back later (same tab) and click through.
- **Tab close after step 2, before step 3.** sessionStorage dies. The diagnosis is lost from the client's perspective. The cached events on the server can still replay step 2 in the demo path, but the live path requires the diagnosis in the query string. So a fresh tab can re-run step 2 (via cached replay if available) and then step 3.
- **Step 3 fails mid-run.** The recommendation agent throws or times out. The route emits `{ type: 'error' }` and closes. The diagnosis is still in sessionStorage. The user can retry by reloading step 3.

#### Part 2 — the cached AgentEvent[] as a poor-man's outbox

The **transactional outbox pattern** says: when you do a database write, also write a row to an "outbox" table in the same transaction. A separate process polls the outbox and publishes those rows as events to a message bus. The point is: the DB write and the event publication can't get out of sync — they're in the same transaction.

```
  Real transactional outbox (industry pattern)

  BEGIN
    INSERT INTO orders (...) VALUES (...);
    INSERT INTO outbox (event_type, payload) VALUES ('OrderPlaced', ...);
  COMMIT

  separate poller:
    SELECT * FROM outbox WHERE published = false
    publish to Kafka
    UPDATE outbox SET published = true
```

blooming insights doesn't write to a DB and doesn't publish to a bus. But the `collected: AgentEvent[]` array in `/api/agent` (line 171) plays a similar role: it's an *append-only ordered log of everything the agent did*, and at the end of a successful run, `saveInvestigation(insightId, collected)` persists it. The replay path reads that log and re-emits it as a stream — the consumer cannot tell the live run from the replay.

```
  The agent's collected[] — outbox-shaped

  during the run:
    collected.push(event)  ← every reasoning step, tool call,
                              diagnosis, recommendation appended
  on 'done':
    saveInvestigation(insightId, collected)  ← persist the log

  on a future request:
    cached = getCachedInvestigation(insightId)
    for e in cached: enqueue(e); sleep(REPLAY_DELAY_MS)
    ← deterministic replay from the persisted log
```

It's outbox-*shaped*, not outbox-*correct*. Correct outbox requires the log write and the side-effect write to be in the same transaction; here, the only "side effect" is the events streamed to the client, and they were emitted *during* the run (not after — there's no separate publish step). It's closer to a write-ahead log than a true outbox.

The point of naming it: when the day comes that the agent has a *write* side effect (e.g. "create a Bloomreach voucher"), the existing `collected[]` pattern is already shaped right to track "did this side effect happen?" — you'd add an `event_kind: 'side_effect_succeeded'` to the log and use it as the durable record of what to NOT redo on retry.

#### Part 3 — what compensation would look like (and why it's absent today)

Compensation is the rollback of a step that has already succeeded. Since every step in blooming insights is a read, there's nothing to compensate.

```
  What compensation would look like (HYPOTHETICAL)

  saga: diagnose → recommend → execute

  step:  diagnose         (READ — no compensation needed)
  step:  recommend        (READ — no compensation needed)
  step:  execute recommendation (WRITE — needs compensation)
         e.g. create_voucher → compensation: delete_voucher
              start_campaign → compensation: stop_campaign

  if "execute" fails after creating the voucher but before
  starting the campaign:
    DELETE the voucher (compensation for step "execute" partial)

  this is what would force a real saga library
  (Temporal, AWS Step Functions, custom state machine)
```

The other absent piece: **idempotency on retry** (file 03 walks this in detail). A saga retry of step "execute" without idempotency would create a second voucher. With an idempotency key, the second attempt sees "this key already succeeded" and no-ops. Sagas and idempotency are inseparable — you can't have a robust saga without idempotent steps.

#### Part 4 — what NOT YET EXERCISED looks like

The standard saga / workflow infrastructure is absent.

```
  NOT YET EXERCISED at this lens

  - dedicated workflow engine (Temporal, AWS Step Functions, etc.)
    no need; workflow has 2 steps, both interactive

  - explicit state machine (XState, statecharts)
    the "states" of an investigation are: not-started, diagnosed,
    recommended, error — encoded implicitly in the route URL and
    sessionStorage presence, not modeled as a typed machine

  - retry-with-checkpoint
    no checkpointing; a step failure means re-run the whole step

  - compensating actions
    no actions to compensate (all reads)

  - distributed transactions (2PC, etc.)
    no transactions across services; explicitly designed to avoid this

  - workflow versioning
    no formal workflow contract; if the diagnosis shape changes, old
    stashed bi:diag:<id> entries would break — silently
```

The right next move IF a write step lands: pick one tool (Temporal Cloud is the heavyweight; a simple Postgres-backed state machine is the lightweight option) and model the workflow explicitly, with idempotency keys per step and explicit compensations. Not before.

### Move 3 — the principle

**The cheapest workflow infrastructure is the user clicking through.** When every step is read-only and every step is meant to be interactive (the user reads the diagnosis before deciding to fetch recommendations), the user is the right orchestrator — they bring durability (their attention persists), idempotency (clicking twice just opens the page twice), and intent (they decide whether to proceed). The infrastructure layered on top of this (Temporal, BullMQ workflows, state machines) is for workflows where the steps are mechanical, automated, or have side effects that must not retry naively. blooming insights' two-step investigation is none of those things, so the user-driven approach is correct, not lazy.

---

## Primary diagram

```
  The two-step investigation workflow — full picture

  ┌─ Client (one tab) ────────────────────────────────────────────────────┐
  │                                                                        │
  │  /investigate/<id>                                                     │
  │     useInvestigation(id, 'diagnose')                                   │
  │        │                                                               │
  │        ├──── fetch /api/agent?step=diagnose ──────────────►           │
  │        │       receive NDJSON: reasoning, tools, diagnosis, done       │
  │        │                                                               │
  │        ├──── on 'done': sessionStorage.bi:diag:<id> = {diagnosis} ────►│
  │        │                                                               │
  │        └──── render diagnosis + "next step" button                    │
  │                                                                        │
  │  user click                                                            │
  │                                                                        │
  │  /investigate/<id>/recommend                                           │
  │     useInvestigation(id, 'recommend')                                  │
  │        │                                                               │
  │        ├──── sessionStorage.read(bi:diag:<id>) ◄─────                 │
  │        │                                                               │
  │        ├──── fetch /api/agent?step=recommend                          │
  │        │           &diagnosis=<json> ──────────────────►              │
  │        │       receive NDJSON: reasoning, recommendations, done        │
  │        │                                                               │
  │        └──── render recommendation cards                              │
  │                                                                        │
  └─────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼  HTTPS — two independent requests
  ┌─ Server (Vercel) — stateless between requests ───────────────────────┐
  │                                                                        │
  │  request 1 (step=diagnose):                                            │
  │     collected: AgentEvent[] = []                                       │
  │     for each event: collected.push, controller.enqueue                 │
  │     on done: saveInvestigation(insightId, collected)                   │
  │              ← outbox-shaped persistent log                            │
  │     request ends                                                       │
  │     ← server forgets everything in memory (except the saved log)       │
  │                                                                        │
  │  ───── interregnum: nothing in memory, possibly different instance ──  │
  │                                                                        │
  │  request 2 (step=recommend):                                           │
  │     parses diagnosis from URL                                          │
  │     no in-process memory of step 1                                     │
  │     runs recommendation agent                                          │
  │     ends                                                               │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘

  workflow state during interregnum lives ONLY on the client.
  no compensation logic exists because no step has side effects.
  collected[] is outbox-SHAPED but not outbox-CORRECT (no separate
  publish/commit boundary).
```

---

## Implementation in codebase

**Use cases.**
- The user opens an insight, sees the diagnosis stream in over ~30s, reads it for a minute, then clicks "next step" to see recommendations. The user is the orchestrator; the server is two independent runs.
- The user closes the tab between steps. Reopens the recommend URL directly. sessionStorage is empty → no `diagnosis` query param → step 3 throws "no diagnosis was handed over." Fix: navigate back to step 2 (which can replay from the cached `AgentEvent[]`), then forward to step 3.
- A future scenario: the recommendation agent gets a "execute" button per card. Clicking it would issue a write call. This is the boundary where the existing pattern stops being sufficient — you'd need an idempotency key per click and a server-side record of "this recommendation has been executed."

**Code side by side.**

```
  app/api/agent/route.ts  (lines 169-264)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];                ← the outbox-shaped log
      const send = (e: AgentEvent) => {
        collected.push(e);                                 ← append-only,
        controller.enqueue(encoder.encode(encodeEvent(e))); ordered, complete
      };
      // ...
      try {
        // STEP 2 (diagnose) or combined: run diagnostic agent
        if (step === 'recommend') {
          diagnosis = parseDiagnosis(diagnosisParam);    ← workflow STATE comes
          if (!diagnosis) {                                from the URL param
            throw new Error('no diagnosis was handed over — open the diagnosis step first');
          }
        } else {
          diagAgent = new DiagnosticAgent(...);
          diagnosis = await diagAgent.investigate(inv, hooks);
          send({ type: 'diagnosis', diagnosis });        ← the handed-over data
        }
        // STEP 3 (recommend) or combined: run recommendation agent
        if (step !== 'diagnose') {
          recAgent = new RecommendationAgent(...);
          const recommendations = await recAgent.propose(inv, diagnosis!, hooks);
          for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
        }
        send({ type: 'done' });
        if (step == null) saveInvestigation(insightId!, collected);  ← persist
      } catch (e) {                                                     the log
        send({ type: 'error', message: ... });
      } finally {
        controller.close();
      }
    },
  });
       │
       └─ note that saveInvestigation only runs when `step == null`
          (the combined run, used by demo capture). The two-step split
          DOES NOT persist its events — they live only in the stream.
          This is a deliberate limit: live two-step runs are not
          replayable on disconnect. The user must re-run a failed step.
```

```
  lib/hooks/useInvestigation.ts  (lines 72-84, 137-140)

  // for the recommend step, load the handed-over diagnosis:
  if (step === 'recommend') {
    try {
      const raw = sessionStorage.getItem(diagHandoffKey(id));
      if (raw) {
        const d = JSON.parse(raw) as { diagnosis?: Diagnosis };
        handedDiagnosis = d.diagnosis ?? null;
        cDiag = handedDiagnosis;
        if (handedDiagnosis) setDiagnosis(handedDiagnosis);
      }
    } catch { /* ignore */ }
  }

  // on 'done' during the diagnose step:
  if (step === 'diagnose' && cDiag) {
    sessionStorage.setItem(
      diagHandoffKey(id),
      JSON.stringify({ diagnosis: cDiag }),
    );
  }
       │
       └─ this is the workflow's persistence layer. The diagnosis is
          handed from step 2 to step 3 through the user's browser. No
          server-side store, no queue, no workflow engine. The user
          click between sessionStorage.setItem and sessionStorage.getItem
          is the workflow trigger.
```

```
  lib/state/investigations.ts  (lines 22-41)

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];
    return fromDemo ?? null;
  }

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);                       ← in-memory always
    if (PERSIST) {                                       (dev / same-process)
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try { writeFileSync(CACHE_FILE, JSON.stringify(all)); }
      catch { /* best effort */ }
    }
  }
       │
       └─ this IS the workflow's durable record — for cached/demo
          replays. The committed demo-investigations.json fixture is
          a frozen snapshot of one investigation; the dev file is
          a sliding cache; the in-memory Map is the production layer.
          NOTE: production Vercel has no FS write capability, so the
          persistence is in-memory-only there — meaning a recycle
          loses the saved log entirely. The fallback chain (mem → dev
          file → demo file) is the only durability story for replays.
```

---

## Elaborate

The reason this app doesn't need Temporal is that the workflow has exactly two interactive steps and both are read-only. Temporal earns its keep when you have N steps, side effects, automated transitions, retry-with-progress, and the workflow needs to survive process death. The two-step investigation has none of those — if the agent dies mid-step, the user reloads the page and re-runs that step from scratch; no progress is lost because the only progress to lose was the in-flight LLM tokens.

The genuinely interesting question: at what point does the user-as-orchestrator model break? Three thresholds.
1. **A step has a side effect** (executing a recommendation, sending an email). Then idempotency keys + compensations become essential, and you need a workflow engine — or at minimum, a state machine modelled in Postgres.
2. **A step is long enough that the user shouldn't have to wait** (a 5-minute analytical query). Then you need a job queue + background worker + notification when done. BullMQ + a webhook to the client.
3. **The workflow spans multiple users** ("user A diagnoses, user B reviews, user C approves"). Then you need a shared workflow state visible to all parties, with permissions per step. Worker + queue + a Postgres state table.

blooming insights crosses none of these today. The user-as-orchestrator pattern is correct precisely because the workflow stays interactive, read-only, and single-user. Naming the thresholds is the lesson.

---

## Interview defense

**Q: Walk me through your multi-step investigation flow as a workflow.**

It's a two-step saga where the user is the orchestrator and `sessionStorage` is the carrier. Step 2 runs the diagnostic agent; when it finishes, the client writes the diagnosis to `sessionStorage.bi:diag:<id>`. The user clicks "next step." Step 3 reads the diagnosis from sessionStorage and sends it back to the server in a query param; the recommendation agent runs against it. The server is stateless between the two — no workflow engine, no state machine, no Temporal-style infrastructure. The persistence between steps lives in the browser.

```
  the saga, simplified

  step 2 → diagnosis → write to sessionStorage
              │
              ▼ user click
  step 3 → read from sessionStorage → send in URL → run recommendation
```

**Q: Why does this not need Temporal?**

Three reasons. Every step is interactive — the user reads the diagnosis before deciding to fetch recommendations, so automating the handoff would remove the UX. Every step is read-only — no side effects to compensate. The workflow has exactly two steps — the overhead of a workflow engine would dwarf the workflow itself. Temporal is for N-step automated workflows with side effects and durability requirements; this is a 2-step interactive read-only flow.

**Q: What changes if you add an "execute recommendation" button?**

Everything in this file. Each execute is a write — needs an idempotency key (a UUID per click sent to the server, so the server can dedup if the user double-clicks). Needs server-side record of "this recommendation has executed" — Postgres or KV. Needs compensation logic if step 4 fails after step 3 succeeded — the recommendation undo (delete voucher, stop campaign). Needs a workflow state machine because the user shouldn't be the only orchestrator anymore — the execute should retry on transient failure, not require the user to refresh. That's the day you reach for Temporal or for a Postgres-backed state machine, depending on how heavy your workflow needs are.

```
  what would force real saga infrastructure

  idempotency       →  UUID per execute click + server-side dedup
  durable execution →  Postgres state table OR Temporal
  compensation      →  per-step inverse actions
  retry policy      →  not a refresh; an automated retry with budget
```

---

## Validate

- **Reconstruct.** Without looking, draw the two-step saga: client states, server states, the carrier (sessionStorage key), and what happens during the interregnum.
- **Explain.** Why does `app/api/agent/route.ts:254` only call `saveInvestigation` when `step == null` (combined run)? Because the split-step runs (`diagnose` and `recommend` separately) are the live two-step user flow; persisting their events would require keying by step *and* merging, and would be redundant with the client's sessionStorage handoff. The combined run is only used by the demo-capture path, which IS meant to be replayed.
- **Apply.** A new product spec: "user can save an investigation to come back to tomorrow." Walk through the changes. (Need cross-instance persistence — Vercel KV keyed by `insightId` storing the diagnosis + recommendations. The client-side sessionStorage handoff stops being the source of truth; the server-side store does. The persistence layer changes, but the workflow shape doesn't.)
- **Defend.** Why no compensating actions? Because no step has side effects. Compensation is for undoing writes; this saga has no writes to undo. The day a write step lands, compensations become required — and that's the day you reach for a real workflow library.

---

## See also

- `01-distributed-system-map.md` — the cross-request seam where the workflow's state lives
- `03-idempotency-deduplication-and-delivery-semantics.md` — what changes if any step becomes a write
- `04-consistency-models-and-staleness.md` — read-your-writes is the consistency property that makes the handoff work
- `06-queues-streams-ordering-and-backpressure.md` — `collected[]` as an outbox-shaped artifact
- `.aipe/study-system-design/audit.md#request-response-and-data-flow` — the architectural take on the request flow
- `.aipe/study-agent-architecture/` — the agents inside each step

---
Updated: 2026-06-16 — No mechanism drift in the two-step workflow; the workflow shape is unchanged by Phase 2 (both adapters speak the same DataSource interface, so the saga reads identically against either backend). Changelog stamp only.
