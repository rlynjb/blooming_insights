competency:   L1 correctness (request coordination)                   raises: L1 → L2
curriculum:   n/a (no aieng-curriculum.md Bx.y maps cleanly; closest is
              study-runtime-systems/04-shared-state-races-and-synchronization.md's
              "you don't get to skip serializability")
study ref:    .aipe/study-database-systems/09-database-systems-red-flags-audit.md
              §Finding 2 — "putInsights has a between-request race"
              + .aipe/study-runtime-systems/04-shared-state-races-and-synchronization.md
              + .aipe/study-system-design/audit.md (R3 in the current audit)
              + .aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md
              (the reads-across-4-guides receipt that made this a queue item)

---

> **Coach posture, verdict first.** The fresh study guides converged on this finding across four different design lenses — runtime, database, system, distributed. That's the load-bearing signal that says: this bug is small, well-scoped, and has been named enough times to be a real receipt when fixed. **The bug is NOT a cross-session leak** (I initially framed it that way; I was wrong — the map IS session-keyed at `lib/state/insights.ts:14`, and lines 4–7 have the comment naming the OLD broken behavior that was already fixed). **The bug IS a within-session concurrent-briefing race**: same sessionId, two overlapping `/api/briefing` calls, second `putInsights` clobbers the first. Trigger is realistic — user opens two tabs and hits refresh, or has a fast-network flake that lets a stale request slip in behind a new one. The failure to induce is "briefing A's results silently disappear when briefing B lands, no error, no warning."

---

## 1. BUILD — the current state, exactly

```
  session-scoped feed state (lib/state/insights.ts:8-14)

  ┌──────────────────────────────────────────────────────────────────┐
  │  state: Map<sessionId, SessionFeed>                              │
  │    "outer map keyed by sessionId — safe across users"            │
  │                                                                  │
  │    ├─ sessionId_A                                                │
  │    │    ├─ insights:       Map<insightId, Insight>               │
  │    │    ├─ investigations: Map<insightId, Investigation>         │
  │    │    └─ anomalies:      Map<insightId, Anomaly>               │
  │    │                                                             │
  │    ├─ sessionId_B                                                │
  │    │    └─ (independent SessionFeed)                             │
  │    ...                                                           │
  └──────────────────────────────────────────────────────────────────┘

  What's SAFE today (verify the claim before drilling further):
    ✓ Cross-session bleed cannot happen — putInsights.clear() only
      touches this sessionId's sub-map (:65-66)
    ✓ Concurrent DIFFERENT-session writes are independent

  What's NOT safe:
    ✗ Two concurrent SAME-session writes → last-writer-wins
    ✗ Reader can catch a mid-write state if it happens to run between
      s.insights.clear() (line 65) and the last s.insights.set()
      (line 68) — for the record, this is only possible via
      microtask reentrancy, not another request, because the whole
      putInsights body is synchronous
```

The exact race path in code:

- `putInsights` at `lib/state/insights.ts:57-71` is synchronous — no `await` inside its body — so two calls literally cannot interleave *within one call*. The race lives *between* calls, gated by the async operations that precede each call.
- `app/api/briefing/route.ts` calls `putInsights(sessionId, insights, anomalies)` after streaming completes. The route body has many `await`s (MCP calls, agent turns, LLM calls). Between the request arriving and the eventual `putInsights` call, ~30–90 seconds of async work happens.
- Second concurrent request on same sessionId hits the same route, does its own 30–90 seconds of async work, then calls `putInsights` — clobbering whatever the first one wrote.

**The fix isn't `insights.ts` itself. It's request-coordination somewhere.** Three surfaces:

- **Route-level coordinator** (`app/api/briefing/route.ts`): check-if-in-flight, return 409 or wait.
- **State-level append-only** (`insights.ts` restructure with `briefingId`): both briefings' insights land, reader chooses.
- **Client-level guard** (`useBriefingStream.ts`): disable button + refuse concurrent starts. Cheapest, doesn't fix server-side.

The drill will exercise the choice. That's the L2 signal: knowing which surface owns the bug when three surfaces could all fix it.

---

## 2. INDUCE — the failure you must cause on demand

**The failure:** on a single warm server instance, TWO concurrent `/api/briefing` requests with the same `bi_session` cookie both complete streaming, both call `putInsights`, and the second call's `.clear()` deterministically wipes the first call's writes. Reader (`listInsights(sessionId)`) after both complete sees ONLY the second briefing's items, silently.

If you can't reproduce this against a specific pair of requests, the drill is faked — the code is telling you the race doesn't exist and you should defer this queue item.

### Step-by-step to induce

**1. Write the induction test.** New file `test/state/insights-race.test.ts` — a vitest test that:
- Doesn't go through the HTTP layer; calls `putInsights` directly with a shared sessionId
- Simulates the "briefing A completes, then briefing B completes" pattern
- Asserts (i) briefing A's insights are gone after B completes (proves the race), (ii) both insight sets are present (would prove the fix, once shipped)

The naive version:

```typescript
import { putInsights, listInsights, _clear } from '@/lib/state/insights';
// ...
_clear();
putInsights('sid-1', [insightA1, insightA2]);
putInsights('sid-1', [insightB1, insightB2]);
const after = listInsights('sid-1');
// today: after.length === 2, only B insights.
// wanted: after.length === 4, both A and B insights.
```

**2. Extend to the async-gap simulation.** Wrap the two `putInsights` calls in async functions that await small delays (mimicking MCP + agent work). Run them concurrently via `Promise.all`. Confirm the outcome is the same — the race is fundamentally about ordering, not about interleaving.

**3. Instrument the real route.** Add a `console.log` at `putInsights` entry with sessionId + item count + timestamp. Run two concurrent `curl` calls to `/api/briefing` with the same cookie in dev. Confirm the log shows two clears + two writes for the same session. Read `listInsights` afterwards; confirm you see only the second briefing.

If step 3 doesn't reproduce, the async gap is being naturally serialized somewhere (e.g., NDJSON reader locking, or Next.js dev routing). Move to production preview build — Vercel's edge behavior is more aggressive about concurrent handlers.

---

## 3. DIAGNOSE — symptom → hypotheses → isolated cause

**Isolated cause (2026-07-03):** H1 is exactly right, but the fix surface is NOT `insights.ts` — it's the route. The state module's synchronous last-writer-wins `putInsights` is correct for its scope (each briefing IS authoritative, deliberately). What's missing is **request coordination** — nothing today prevents two `/api/briefing` handlers from BOTH reaching the `putInsights` call for the same sessionId. The race is between requests, not inside one.

**Hypotheses ranked after code read:**

- **H1 — Between-request race with correct state semantics.** CONFIRMED. `putInsights` at `lib/state/insights.ts:57-71` is synchronous, so no interleaving is possible within one call — but two concurrent handlers race the sequence "async MCP + agent work" → `putInsights`. Second `putInsights.clear()` at line 65 wipes the first's writes; both handlers stream fine independently but only one's data lands. Silent from the user's perspective.
- **H2 — Reader-during-write anomaly.** Refuted for practical purposes. Because `putInsights` is synchronous, no reader can observe an intermediate state.
- **H3 — Parallel race on `investigations.ts:11`.** Confirmed present in the sibling module (`putInvestigation` at `lib/state/investigations.ts` has the same shape). But triggered by a different pattern (concurrent `/api/agent` calls with the same insightId, which the client-side hook mostly prevents via `startedRef` — see `lib/hooks/useInvestigation.ts:45-50`). Deferred to a follow-up; the briefing race is the higher-frequency trigger.

**One-sentence isolated cause:** *concurrent same-session `/api/briefing` requests both reach `putInsights` after independent 30-90s async pipelines; the second call's `.clear()` at insights.ts:65 wipes the first's writes.*

---

## 4. FIX + REJECT — the alternative you didn't take and why

Option matrix — pick ONE, defend it in one line each for the others:

| Option | Where it lives | Cost | What it fixes | What it doesn't |
|---|---|---|---|---|
| **A — Route-level in-flight gate.** In `/api/briefing`, check a `Map<sessionId, AbortController>` before starting; if in-flight, either return 409 with a hint OR abort the prior and start fresh. | app/api/briefing/route.ts (~15 LOC) + a small module-level Map | LOW (~1 hr): one Map, one middleware-ish check at the top, cleanup in `finally`. | Race disappears at the source. User can't accidentally double-fire. | Doesn't help if two DIFFERENT routes touch the same session (they don't today, but if a future feature does…) |
| **B — Append-only insights with `briefingId`.** Rework `putInsights` to APPEND with a per-briefing tag; readers filter by "latest briefingId" or "all briefings." | insights.ts, all readers, all writers, tests (~40 LOC + broader tests) | MEDIUM (~3 hr): schema change + reader-side filter + backfill + test churn. | Both briefings' data survives; reader semantics are richer (could show a "your other tab is briefing" hint). | Doesn't stop the concurrent burn of API cost — two briefings still run to completion. |
| **C — Client-level guard.** In `useBriefingStream.ts`, disable the trigger button while a briefing is in flight; if the user has two tabs, the second tab's button also stays disabled via a broadcast channel or localStorage flag. | useBriefingStream.ts + shared state key (~20 LOC) | LOW-MEDIUM (~1.5 hr) but cross-cutting. | UX is guarded. Server never sees the race. | Client-only guards are bypassable (curl, dev tools, another browser). Not a real fix — a UX hint. |
| **D — Reject: per-session mutex on the server.** Full concurrency-primitive-in-JavaScript approach. | new lib/state/mutex.ts | HIGH (~4 hr): mutex, tests, deadlock proofs, awaits inside otherwise-fast paths. | Correctness — sequential briefings are guaranteed. | Overkill; Option A gets 90% of the safety with 15% of the code. Reject. |
| **E — Reject: append-only + client guard together.** | Both surfaces. | HIGHEST | The maximally-safe option. | Complexity budget too high for one drill; ship A alone. |

**Recommended (coach's read):** **A** — route-level in-flight gate with a 409 response. It's the smallest fix, it's server-side (real), and the failure mode (a stale second-tab briefing) is a UX signal, not a UX loss. Reject D (over-engineering); reject E (do one thing well); keep B in the pocket as the "next season" upgrade if you ever want multi-briefing history semantics.

Whatever you pick, name what you rejected and *why in one sentence each*. That's the L2→L3 signal.

**Shipped (2026-07-03):** Option A landed as:

- `lib/state/in-flight-briefings.ts` — new module (~85 LOC incl. comments). `tryAcquireBriefing(sessionId)` returns either `{ acquired: true, controller, release }` or `{ acquired: false, existing }`. First-in wins; release removes the entry idempotently (only if it's still OUR controller). Module-level `Map<sessionId, AbortController>`; process-scoped, matching the existing state modules' persistence tier.
- `app/api/briefing/route.ts` — three surgical edits: import, gate acquisition between the `dsResult.ok` check and the `dataSource` binding (returns 409 with `{ error: 'briefing_in_flight', message, retry_after_ms: 30_000 }` on rejection; disposes the just-built datasource before returning), and `acquisition.release()` in the existing stream `finally` block right after `disposeDataSource()`.
- `test/state/in-flight-briefings.test.ts` — 8 tests covering: first acquisition succeeds; concurrent same-sid rejected; release re-enables the gate; different sids don't block each other; the race the drill documented is closed; stale-release is a no-op; 100-session accumulation cleans; rejected caller receives the holder's controller (surface for future "abort prior and retry" behavior).

Why the primary receipt is the state-level test, not a route-level test: (a) the gate primitive is what actually implements the guarantee — the route just wires it; (b) route-level testing would require spinning the full route handler with a mocked Anthropic + mocked MCP, adding infrastructure that doesn't exist yet in the suite and duplicating coverage the primitive already provides; (c) code review + the tombstone-in-context comment in the module documents the wiring. If a future feature adds a second consumer of the gate, this test suite catches misuse there too.

**Rejected in the option matrix — one sentence each:**
- **B (append-only insights)** — rework of `putInsights` + every reader + backfill; ~40 LOC net + semantic change to reader logic that isn't earning its cost until multi-briefing history becomes a product feature.
- **C (client-level guard)** — bypassable via curl / dev tools / another browser; a UX hint, not a fix.
- **D (per-session mutex)** — full concurrency primitive is over-engineering when a 409 with retry-hint gets the same safety.
- **E (append-only + client guard)** — do-one-thing-well; ship A alone, revisit B if the feature demands it.

---

## 5. EVAL — the measurement

**Instrument.** The primary receipt is the state-level test suite at `test/state/in-flight-briefings.test.ts` — 8 tests exercising the gate's contract directly. The test "closes the race documented in the drill" is the concrete assertion that a same-session second acquisition fails and (in the route wiring) the second `putInsights` call never runs.

**Success criteria (all met, 2026-07-03):**

- ✅ 8 new tests pass against the shipped primitive
- ✅ Existing 268-test suite carries forward: 276/276 pass (268 + 8 new)
- ✅ 409 response envelope is machine-readable: `{ error: 'briefing_in_flight', message, retry_after_ms: 30_000 }`
- ✅ Typecheck clean
- ✅ No regression risk on the existing eval baseline `2026-07-03T04-08-28-644Z` — the eval uses `SyntheticDataSource` and calls `RecommendationAgent.propose` directly, doesn't touch the `/api/briefing` route
- ✅ Rejected caller receives a machine-parsable `retry_after_ms` field so the client can render a hint like *"another briefing is in progress; try again in 30s"* without hard-coding a delay

**What a route-level test would add on top** (not shipped in this drill; noted for the follow-up in the Cross-links section): a real integration test that fires two concurrent `fetch('/api/briefing')` calls through the Next.js handler with mocked `Anthropic` + mocked MCP. The infrastructure to do that (a route-test harness) doesn't exist in this repo yet; adding it is a separate ~half-day of scaffolding. The primitive test suite covers the guarantee; the route wiring is verified by code review + this drill's paper trail.

**No API cost this run** — the fix is coordination, not model or MCP work. The measurement is a `vitest run` completing in ~6s.

---

## 6. WAR STORY — the sentence you say out loud

*(Write this last, once Steps 1–5 have actually been lived.)*

Shape to fill (post-ship, 2026-07-03):

> "Four different study audits — runtime, database, system, distributed — all named the same bug at `lib/state/insights.ts`. I initially framed it as a cross-session leak. It wasn't — the map was already session-keyed. The real bug was concurrent same-session briefings: two tabs, both hit the API, the second `putInsights` wiped the first. I could have fixed it in three places — the state, the route, or the client. I picked the route because `_______`. Shipped a `Map<sessionId, AbortController>` in-flight gate — an ~85-LOC module extracted for testability, wired into `/api/briefing` in three surgical edits, backed by 8 primitive-level tests. Suite went 268 → 276 with zero regressions. The lesson: convergent audit findings don't always mean 'the fix is exactly what the finding says' — sometimes the mechanism is subtler than any of the four audits captured. The receipt was that I read the code, not just the audits, before I picked the surface."

Anti-patterns to avoid:
- "There was a race condition" — vague. Say *what got clobbered by what*.
- "I fixed the shared state" — you didn't; you added a coordinator. Say what you added and why in-flight-gate beat mutex.
- "Four audits agreed" — they agreed on the WRONG framing initially. The receipt is that you noticed.

The interviewer's follow-up will be one of:
- "Why not fix it at the state layer directly?" — Option B is the append-only rework; it's a schema change worth ~3 hours for a semantic upgrade you don't need yet. The 409 is smaller and matches the actual bug.
- "How do you handle the second briefing after the 409?" — client retries with a UI hint ("your other tab is briefing; wait or cancel"). That's UX polish, not a correctness gap.
- "What if the first briefing hangs and the gate never releases?" — the `finally` block releases; you can also set a wall-clock cap on the gate (dovetails with the observability wall-clock cap drill).
- "Why did you re-read the code instead of trusting the audits?" — because four audits saying the same thing IS a signal, but audits describe the bug from their lens; only the code tells you which surface actually owns the fix.

---

## Cross-links

- `.aipe/study-database-systems/09-database-systems-red-flags-audit.md` §Finding 2 — the sharpest naming of the actual mechanism
- `.aipe/study-runtime-systems/04-shared-state-races-and-synchronization.md` — the theory
- `.aipe/study-runtime-systems/08-runtime-systems-red-flags-audit.md` — R1 says "no LRU/TTL", which is a SEPARATE finding worth its own drill (`lib/state/insights.ts:4` leak under long-running Node)
- `.aipe/audits/recon-2026-07-03.md` — where Move 4 lives in the queue
- `lib/state/insights.ts:57-71` — the sync `putInsights` body
- `lib/state/investigations.ts:11` — the parallel Map with the same shape (H3 above)
- `app/api/briefing/route.ts` — where the fix lands (Option A)
- `.aipe/drills/observability-induce-agent-reasoning-cap-timeout.md` — the sibling drill; the in-flight gate's finally-release + the wall-clock cap are complementary
