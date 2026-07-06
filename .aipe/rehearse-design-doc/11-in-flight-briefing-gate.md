# RFC-11 — In-flight briefing gate (per-session request coordination)

**Decision in one line:** Route-level `Map<sessionId, AbortController>` gate at `/api/briefing`. First request in wins; concurrent requests on the same sessionId get HTTP 409 with `{ error: 'briefing_in_flight', message, retry_after_ms: 30_000 }`. The winner releases in the existing stream `finally`. New module `lib/state/in-flight-briefings.ts` (~85 LOC) so the primitive is testable in isolation and stays out of the state module whose semantics are already correct.

---

## Context

The state map at `lib/state/insights.ts:14` is correctly session-keyed. Cross-user bleed is impossible — the outer `Map<sessionId, SessionFeed>` was fixed in an earlier phase and the comment at `insights.ts:4-7` names the exact broken-then-fixed history. So far, so good.

What isn't guarded is two concurrent `/api/briefing` requests on the SAME sessionId. The realistic triggers:

- A user opens two tabs against the same session and kicks off briefings in both.
- A fast-refresh scenario where a stale request slips in behind a new one before the first has landed its writes.
- Any pathway where the client fires a second briefing before the first's ~30–90s async pipeline has released.

Both requests traverse independent `bootstrapSchema → listTools → MonitoringAgent.scan → putInsights` pipelines. `putInsights` at `insights.ts:57-71` is synchronous — no `await` inside — so two calls can't interleave *within* one call. The race lives *between* calls, gated by all the async work that runs before each call: 30–90s of MCP calls, LLM turns, and coverage scans.

Then both calls arrive at `putInsights(sid, …)`. The second call's `s.insights.clear()` at `insights.ts:65` deterministically wipes the first's writes. Reader (`listInsights(sessionId)`) after both complete sees ONLY the second briefing's items. No error, no warning, no telemetry — the first briefing's results silently evaporate.

Four fresh study audits (runtime, database, system, distributed — the drill at `.aipe/drills/l1-correctness-induce-concurrent-briefing-race.md` records the convergence) named the same finding from four different angles. That's the load-bearing signal: the bug is small, well-scoped, and named enough times to be a real receipt when fixed.

---

## Decision

Introduce a route-level in-flight gate. Three parts:

```
The gate — first-in wins, concurrent requests get 409

  ┌─ new module ───────────────────────────────────────────────────┐
  │ lib/state/in-flight-briefings.ts (~85 LOC)                     │
  │                                                                │
  │   const inFlight = new Map<sessionId, AbortController>()       │
  │                                                                │
  │   tryAcquireBriefing(sessionId) →                              │
  │     · { acquired: true, controller, release }                  │
  │     · { acquired: false, existing }                            │
  │                                                                │
  │   release() only deletes if the entry is still OUR controller  │
  │   (stale-release defense-in-depth)                             │
  └────────────────────────────────────────────────────────────────┘

  ┌─ route wiring at app/api/briefing/route.ts ────────────────────┐
  │                                                                │
  │   const acquisition = tryAcquireBriefing(sid);                 │
  │   if (!acquisition.acquired) {                                 │
  │     await dsResult.dispose().catch(() => {});                  │
  │     return NextResponse.json(                                  │
  │       { error: 'briefing_in_flight',                           │
  │         message: '…already in progress',                       │
  │         retry_after_ms: 30_000 },                              │
  │       { status: 409 });                                        │
  │   }                                                            │
  │   // …stream body…                                             │
  │   } finally {                                                  │
  │     await disposeDataSource().catch(…);                        │
  │     acquisition.release();  ← always released                  │
  │   }                                                            │
  └────────────────────────────────────────────────────────────────┘
```

Three shape decisions live in that structure:

- **Reject, don't queue.** A 409 with a `retry_after_ms` hint is honest — the second tab knows to back off ~30s and try again. Queuing would tie up a Vercel function slot for minutes waiting on the first briefing, and the second caller usually just wants "did A finish? then let me start B."
- **Route-scoped, not app-wide.** The gate lives at the composition seam of `/api/briefing`. Nothing about `insights.ts` changes. That's the load-bearing separation-of-concerns call — see the reviewer preemption below.
- **A separate module, not inlined in the route.** `lib/state/in-flight-briefings.ts` exists because the gate is a testable primitive: 8 unit tests exercise it directly (acquire → concurrent-rejected → release → different-sids-don't-block → the drill's documented race is closed → stale-release is a no-op → 100-session cleanup → rejected caller gets the holder's controller for future abort-and-retry). Route-only inlining would have hidden the primitive behind HTTP integration tests.

The controller returned by `tryAcquireBriefing` is deliberately an `AbortController`, not a bare boolean flag. Future evolution (abort-and-retry: the second request cancels the first instead of getting rejected) is one caller change away — the surface is already the right noun. Today the controller isn't used to abort; the winner just runs to completion.

---

## Alternatives considered

**(a) Append-only insights with a `briefingId` field.** The state-level fix — restructure `putInsights` so each briefing's writes go under a unique `briefingId`, and readers pick which briefing they want. Semantically nicer: both concurrent briefings land, no data loss. Loses on scope and shipping cost: ~40 LOC in `insights.ts` plus reader-side changes at every `listInsights` / `getInsight` call site, plus a UI story for "which briefing do I show?" that doesn't exist as a product feature yet. The "multi-briefing history" semantic upgrade is a real future move — deferred until the product asks for it. Kept in pocket, not built.

**(b) Client-level button-disable.** Disable the "start briefing" button in `useBriefingStream.ts` while one is in flight. Cheapest surface, and useful as a UX hint. Loses as a *fix* because it's bypassable — a curl request from dev tools sails right past the button state, and the race lands on the server anyway. UX hint layered on top is fine; UX hint as the entire fix is not.

**(c) Per-session mutex.** A full concurrency primitive — the second request awaits the first, then runs, and readers see both briefings' results in sequence. Loses on over-engineering: it's a lot of primitive for a bug whose realistic trigger is "user opens two tabs." A mutex is the shape you reach for when many workers coordinate on shared state; here the workers are the same user hitting the same route twice, and rejection is the honest outcome.

**(d) Combined B + C** (append-only insights + client disable). Loses to do-one-thing-well: A alone closes the race deterministically at the correct layer. Ship A; treat B and C as separately-motivated moves if they earn their way in later.

---

## Consequences

**What this buys:**
- **The silent-data-loss race is closed.** Deterministic: two overlapping same-session briefings can no longer produce a `putInsights` clobber. The second request gets a 409 before it enters the pipeline; the first runs to completion; the gate releases in `finally`.
- **A testable primitive.** 8 new unit tests exercise the gate directly at `test/state/in-flight-briefings.test.ts`. The suite went 268 → 276. The tests are on the primitive, not on the HTTP route — so a route rewrite doesn't force a test rewrite.
- **The seam abstraction paid off again.** This is the second-order receipt for RFC-05: the fix landed at the route layer without touching `insights.ts` or any DataSource-facing agent code. When the seam is right, unrelated fixes stay unrelated.
- **The `AbortController` surface leaves room for a future move.** If "abort the first briefing when a second arrives" ever becomes the desired behavior, the caller change is small — the primitive already exposes the running controller to the rejected caller.

**What it costs:**
- **A user with two tabs sees a 409 on the second tab.** Not silent — the `retry_after_ms: 30_000` hint tells the client to back off — but it is a visible reject, where before it was silently-corrupt success. The UX tradeoff is deliberate: loud correctness over quiet corruption.
- **One more module scope to maintain.** `lib/state/in-flight-briefings.ts` is ~85 LOC and joins `insights.ts`, `investigations.ts`, and `demo-*.json` in the `lib/state/` folder. Small, but real.
- **Process-scoped, like the other state modules.** The `inFlight` map lives in-process. Two Vercel function instances serving the same sessionId concurrently would each hold their own gate and miss the coordination. This matches the semantics of `lib/state/insights.ts` itself (also in-process) — the gate is exactly as strong as the state module it protects. See Open Questions.
- **Best-effort teardown on rejection.** The 409 path calls `dsResult.dispose().catch(() => {})` before returning, so a rejected request doesn't leak MCP state. Silent-swallow is intentional here — a dispose failure on a rejected request is not worth surfacing to the client.

**What the reviewer will push on:**
> "Why not fix it in `insights.ts`?"

Own it. The framing: the state semantics of `putInsights` are correct for its scope — each briefing IS authoritative, and "the newest completed briefing replaces the last" is the right rule for a single-briefing feed. What's missing isn't a state-model change; it's **request coordination**, which belongs one layer up at the route where the request boundary actually lives. Fixing it in `insights.ts` would either bake concurrency semantics into a module whose current job is pure storage (leaky), or force a schema upgrade (option B) for a use case the product doesn't have yet. The route is the right owner because the route is what enforces "one briefing at a time per session."

The convergent audit findings (runtime + database + system + distributed) all named the bug at `insights.ts`, but the fix surface was one layer up. That's the L3 signal from the drill: convergent findings ≠ the fix is exactly where the finding points. Reading the code changed the surface choice.

---

## Open questions

- **Multi-instance coordination.** If Blooming ever runs on more than one warm Vercel function serving the same sessionId, the in-process `inFlight` map can't coordinate across processes. The two candidates are (a) a shared KV (Upstash / Vercel KV) keyed by sessionId with a TTL, or (b) sticky-session routing so the same sessionId always lands on the same instance. Not built because the product runs single-instance today; the same constraint applies to `insights.ts` itself.
- **Abort-and-retry semantics.** The `AbortController` returned to the rejected caller is currently unused — the caller just gets a 409. A future move: the second request `abort()`s the first's controller and takes over. The `req.signal.throwIfAborted()` calls throughout `route.ts` already honor this if wired up. Deferred until "user opens a second tab and expects it to preempt" becomes a real complaint.
- **Metric on 409 rate.** The 409 path is silent server-side today (no `console.log` counter). If concurrent-briefing rejects become common, the summary-log line in the route's `finally` is the natural place to add a `rejected: true` flag. Cheap; not built yet.
- **The append-only migration.** Option B (per-briefing history) is the semantic upgrade that arrives with "let users compare this week's briefing to last week's." When that product feature lands, the gate can stay (rejecting concurrent writes within one briefing lifecycle) or come out (if the append-only model makes concurrent writes safe). Deferred; not a blocker either way.
