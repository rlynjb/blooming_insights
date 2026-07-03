// lib/state/in-flight-briefings.ts
//
// Per-session in-flight briefing gate. Prevents concurrent /api/briefing
// requests with the same sessionId from clobbering each other's
// `putInsights` call at the end of their pipeline.
//
// The bug this closes — see:
//   .aipe/drills/l1-correctness-induce-concurrent-briefing-race.md
//
// Mechanism: the `state` Map at `lib/state/insights.ts:14` IS correctly
// session-keyed (cross-user bleed cannot happen). What isn't guarded is
// two overlapping /api/briefing requests on the SAME sessionId — a user
// with two tabs, or a fast-refresh scenario where a stale request slips
// in behind a new one. Both requests do their ~30–90s of async MCP + agent
// work, then both call `putInsights(sid, …)`; the second call's
// `s.insights.clear()` at insights.ts:65 wipes the first's writes and the
// first briefing's results silently disappear.
//
// This module is the smallest coordinator that fixes it: a
// Map<sessionId, AbortController> where the first request in acquires the
// gate, concurrent requests see `acquired: false` and the route returns
// 409. The winner releases on completion, cancellation, or error via the
// returned `release` function.
//
// Alternative options considered (see the drill's option matrix):
//   B — Append-only insights with a `briefingId` field. Semantic upgrade
//       reworking putInsights and every reader; ~40 LOC + schema churn.
//       Kept in pocket if multi-briefing history ever becomes a feature.
//   C — Client-level guard (disable button while in-flight). Bypassable
//       via curl / dev tools; a UX hint, not a fix.
//   D — Per-session mutex. Full concurrency primitive; over-engineering
//       for a bug whose realistic trigger is "user opens two tabs."
// Route-level 409 wins because it's server-side, small, and preserves
// the "each briefing is authoritative" semantic that putInsights encodes.

const inFlight = new Map<string, AbortController>();

export type BriefingAcquisition =
  | { acquired: true; controller: AbortController; release: () => void }
  | { acquired: false; existing: AbortController };

/**
 * Try to acquire the in-flight gate for a sessionId.
 *
 * - Success: `{ acquired: true, controller, release }`. The controller is
 *   scoped to this request; the caller MUST call `release()` on completion,
 *   cancellation, or error (put it in a `finally` block).
 * - Concurrent: `{ acquired: false, existing }`. The route should reject
 *   the request (409) rather than proceed.
 */
export function tryAcquireBriefing(sessionId: string): BriefingAcquisition {
  const existing = inFlight.get(sessionId);
  if (existing) {
    return { acquired: false, existing };
  }
  const controller = new AbortController();
  inFlight.set(sessionId, controller);
  return {
    acquired: true,
    controller,
    release: () => {
      // Only delete if this is still OUR controller. If a subsequent
      // request raced past a stale entry (shouldn't happen with proper
      // finally-block release, but defense-in-depth), the current holder
      // should not be released by this stale caller.
      if (inFlight.get(sessionId) === controller) {
        inFlight.delete(sessionId);
      }
    },
  };
}

/** Test-only. Wipe all gates and abort any in-flight controllers. */
export function _clearAllBriefings(): void {
  for (const c of inFlight.values()) c.abort();
  inFlight.clear();
}

/** Test-only. Number of sessions currently holding the gate. */
export function _inFlightCount(): number {
  return inFlight.size;
}
