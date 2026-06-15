# Refactor: Session-key the insights Map

## What to refactor

- `lib/state/insights.ts:4-6` — the three module-level Maps (`insights`, `investigations`, `anomalies`).
- `lib/state/insights.ts:30-67` — every public function (`putInsights`, `getInsight`, `getAnomaly`, `listInsights`, `putInvestigation`, `getInvestigation`, `_clear`).
- Call sites that read/write feed state:
  - `app/api/briefing/route.ts:243` — `putInsights(insights, anomalies)` after monitoring scan.
  - `app/api/agent/route.ts:48-50` — `getAnomaly(insightId)` and `getInsight(insightId)` inside `resolveAnomaly`.
- The sessionId source is already at `lib/mcp/session.ts:16` (`getOrCreateSessionId`); both routes already call it for their own auth path, so no new cookie touch needed.

## Why

This is the only correctness bug in the audit. `lib/state/insights.ts:4` is a global `Map<id, Insight>` shared across every request that lands on the same warm Vercel instance. `putInsights` calls `insights.clear()` on every briefing, so two concurrent users wipe each other's feeds — user A's briefing 404s the moment user B's briefing starts. The trigger is ~10 concurrent users on a warm instance (`study-system-design/audit.md` Ceiling 1; cleanup-2026-06-02 fix-now #1). Severity: high. Cost: ~30 LOC, one afternoon. The fix is the cheapest correctness win in the codebase and unblocks the recon's L1 → L2 climb.

## Target structure

Replace the three module-level Maps with one outer `Map<sessionId, { insights, investigations, anomalies }>` (or three parallel session-keyed Maps). Each public function takes `sessionId` as the first argument and operates only on that session's sub-map. `putInsights(sessionId, items, rawAnomalies?)` clears only `state.get(sessionId)?.insights` — never the outer map.

The existing pattern to follow: `lib/state/investigations.ts` already key-scopes by `insightId` via a `Map<string, AgentEvent[]>`. This refactor extends that key-scoping discipline one level up to `sessionId` for the feed state.

Shape after refactor (sketch — exact API decided in the implementation session):

```
function sessionState(sessionId: string): SessionFeed { ... }  // lazy create
export function putInsights(sessionId: string, items: Insight[], raw?: Anomaly[]): void
export function getInsight(sessionId: string, id: string): Insight | null
export function getAnomaly(sessionId: string, id: string): Anomaly | null
export function listInsights(sessionId: string): Insight[]
export function _clear(sessionId?: string): void  // omit sessionId → wipe everything (test-only)
```

Call sites change from `putInsights(insights, anomalies)` to `putInsights(sid, insights, anomalies)`; from `getAnomaly(id)` to `getAnomaly(sid, id)`.

Behaviour-preserving claim: a single-user session sees exactly the same data flow as before — write under `sid`, read under `sid`, clear-on-rebriefing now clears only `sid`'s sub-map. Cross-session bleed (the bug) is the only behaviour removed.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
