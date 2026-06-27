# Transactions and integrity

**Industry name(s):** Transactions · atomicity · constraints · invariants · type guards as integrity check · session isolation
**Type:** Industry standard · Language-agnostic

> **Three layers now.** (1) The **Olist SQLite layer** has real DB constraints — FKs with `PRAGMA foreign_keys = ON`, NOT NULL on every load-bearing column, `journal_mode = WAL` for concurrent reads. SQLite transactions wrap the seeder's bulk inserts. This activates topics that were "not yet exercised" in the original audit. (2) The **agent contract layer** still uses three runtime guards in `lib/mcp/validate.ts` at the LLM seam (the one boundary the compiler can't see) — still strong, fails closed. (3) The **in-memory UI state** has been refactored from "module-level globals with no atomicity" to **session-scoped sub-maps** (`Map<sessionId, SessionFeed>` in `lib/state/insights.ts`). The cross-session-isolation invariant — "putInsights for one session does not wipe another session" — is now testable AND tested (see `test/state/insights.test.ts`). The atomicity-within-a-session question is still "the runtime is single-threaded and the loop has no I/O," but the new invariant is real, named, and enforced.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Integrity questions span three layers in this repo, with sharply different mechanisms at each. The **LLM seam** uses runtime type guards (since TypeScript can't see what the model emits). The **route ↔ state seam** has no integrity check at all (two Maps are cleared and re-filled in sequence; the only invariant — "every insight in `insights` should have its raw `Anomaly` in `anomalies`" — has no enforcer). The **wire format seam** (browser → route via `?insight=`) parses + validates the shape inline.

```
  Zoom out — what enforces integrity, where

  ┌─ UI client band ──────────────────────────────────────────┐
  │  trusts the typed shape from the route                     │
  │  (no validation on read — assumes the route is honest)     │
  └────────────────────────────┬──────────────────────────────┘
                               │ Insight JSON (?insight=…)
  ┌─ Route handler band ───────▼──────────────────────────────┐
  │  app/api/agent/route.ts                                    │
  │  - inline shape validation on ?insight= param              │
  │  - putInsights() clears 2 Maps non-atomically              │
  │  - no cross-Map invariant enforcement                       │
  └────────────────────────────┬──────────────────────────────┘
                               │ Anomaly[] | Diagnosis | Recommendation[]
  ┌─ Agent loop band ──────────▼──────────────────────────────┐
  │  agents emit JSON-as-string                                │
  │  validate.ts narrows each shape  ★ THE INTEGRITY LAYER ★   │
  │  fails closed: invalid JSON → [] / null → graceful degrade │
  └────────────────────────────┬──────────────────────────────┘
                               │ JSON in tool results
  ┌─ MCP wrapper band ─────────▼──────────────────────────────┐
  │  McpClient parses tool results; error envelopes flagged    │
  │  via isError=true; surfaced as McpToolError                │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when something writes the model, what guarantees the result is consistent? Two paths matter here. At the **LLM seam**, three type guards are the integrity check — without them, the agent could emit `{ banana: true }` and the rest of the pipeline would crash later. At the **in-memory store**, nothing is the integrity check — the invariant "insights and anomalies stay paired" is held by the code that writes them, not by the store. That's the partial-applicability of this topic.

---

## Structure pass

**Layers.** Same four-layer stack. The two integrity-relevant layers are the **agent loop band** (where the LLM seam sits) and the **state module band** (where the in-memory Maps live).

**Axis: invariant enforcement.** For each invariant the model relies on, what enforces it — the compiler, a runtime check, a transaction, or hopeful code? This is the right axis because integrity is *literally* about which mechanism prevents which inconsistency. Cost is wrong (most checks are free); failure is wrong (these checks PREVENT failure, they don't propagate it). Invariant enforcement pops the seams: at every boundary, which side enforces which fact.

**Seams.** Three matter. **Seam 1: LLM ↔ agent code.** Enforced by `validate.ts` — three guards, fails closed. Strong. **Seam 2: route ↔ in-memory store.** Enforced by ... the code that calls `putInsights`, hoping it passes both `items` and `rawAnomalies` correctly. No transaction. **Seam 3: wire format ↔ route.** Enforced inline in `resolveAnomaly` — checks `metric`, `change`, `scope`, `severity` exist before trusting the JSON. Narrow but present.

```
  Structure pass — invariant enforcement across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · Agent loop · MCP wrapper                    │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  invariant enforcement: what guards each fact, at each    │
  │  layer boundary? (compiler / runtime / transaction / hope)│
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: LLM ↔ agent     ★ RUNTIME GUARDS (validate.ts)      │
  │  S2: route ↔ store   ★ HOPE (no atomicity, no FK check)  │
  │  S3: wire ↔ route    ★ INLINE SHAPE CHECK (narrow)       │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — integrity is the boundary, not the body

You know how a TypeScript type narrows `string | null` to `string` inside an `if (x != null)` block? That's a compile-time integrity check — the compiler refuses to let you reach `.length` until you prove it's non-null. Now imagine the value isn't `string | null` — it's a JSON blob you just parsed from an LLM response. The type system can't help; you're back to runtime checks at the boundary. That's exactly the situation at the LLM seam. The three guards in `validate.ts` do for runtime what the compiler does at compile time — narrow the type *at the boundary* before any downstream code touches it.

```
  the boundary picture — where integrity lives

  ┌─ untrusted ──────────────┐                ┌─ trusted ────────────────┐
  │ model output (string)    │  → guard? →    │ Anomaly[]                │
  │ JSON.parse → unknown     │                │ Diagnosis | null         │
  │ "anything could be here" │                │ Recommendation[]         │
  └──────────────────────────┘                └──────────────────────────┘
                              ▲
                              │
                       this is THE seam
                       (the only place TypeScript can't help)
```

**Skeleton parts of a runtime guard at this seam:**

1. **Parse step** — turn the model's string into a structured value (`parseAgentJson` in `validate.ts` handles fenced ```json blocks, falls back to substring scan).
2. **Shape check** — narrow to the expected interface (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` check field names + types).
3. **Fail-closed return** — when the check fails, return a neutral value the caller can degrade on (`[]`, `null`).

Drop step 1 and the guard chokes on the agent's typical fenced output. Drop step 2 and downstream code crashes on missing fields. Drop step 3 — return `throw` instead — and one malformed JSON crashes the whole briefing run.

### Move 2 — the LLM-seam guards, walked

`lib/mcp/validate.ts` has three guards plus a parser. **One operation per guard:**

#### `parseAgentJson(text)` — the parser

Handles three shapes the agent emits: a fenced ```json block (most common), bare JSON, or JSON embedded in prose. **One operation per fallback:**

```
  parseAgentJson — three fallbacks in order

  step 1:  fenced block?      /```(?:json)?\s*([\s\S]*?)```/
            yes → JSON.parse  the contents
            no  → step 2

  step 2:  trimmed input is direct JSON?
            yes → JSON.parse  the trimmed text
            no  → step 3

  step 3:  scan for first '[' or '{', last ']' or '}'
            extract substring → JSON.parse
            fail → throw 'no parseable json in agent output'

  what breaks if you drop step 1: 90% of agent outputs (fenced blocks)
                                  fail because the ``` confuses JSON.parse
  what breaks if you drop step 3: any agent output with leading prose
                                  ("Here are the anomalies: [...]") fails
```

#### `isAnomalyArray(v)` — the Anomaly[] shape guard

The richest guard. **One field per line, all required fields checked:**

```
  isAnomalyArray — the check, field by field

  Array.isArray(v) AND every element:
    typeof element === 'object'
    AND typeof metric === 'string'
    AND Array.isArray(scope)
    AND typeof change === 'object'
    AND typeof change.value === 'number'
    AND change.direction in ('up' | 'down')
    AND typeof change.baseline === 'string'
    AND severity in ('critical' | 'warning' | 'info' | 'positive')

  what's NOT checked:
    - evidence (required on the interface, but defaulted by callers)
    - impact, history, category (all optional)
    - that scope[] contains strings (Array.isArray is enough at this seam)

  what happens on a failed check:
    isAnomalyArray returns false → the calling agent returns []
    (the briefing degrades to "no anomalies" rather than crashing)
```

What breaks if you tighten this guard to require `evidence`: agents that happen to omit it (older runs, demo replays) fail the guard. The current guard is **permissive on optionals, strict on required-required-for-rendering** — a deliberate looseness so the pipeline degrades gracefully on the broadest set of agent outputs.

#### `isDiagnosis(v)` — the Diagnosis shape guard

Simpler. Three fields, all required:

```
  isDiagnosis — the check

  typeof v === 'object' && v !== null
    AND typeof conclusion === 'string'
    AND Array.isArray(evidence)
    AND Array.isArray(hypothesesConsidered)

  what's NOT checked:
    - whether hypothesesConsidered elements have the rich
      { hypothesis, supported, reasoning } shape — accepts string[]
      too (this is how Investigation.diagnosis's lossy form sneaks
      through; file 02 covers that)
    - confidence (optional, derived if missing)
    - affectedCustomers, timeSeries (both optional)

  what happens on a failed check:
    isDiagnosis returns false → the agent falls back to FALLBACK
    constant { conclusion: 'Insufficient data...', evidence: [], hypothesesConsidered: [] }
```

#### `isRecommendationArray(v)` — the Recommendation[] shape guard

Validates the **id-less** shape the agent emits (the system assigns ids after validation — see `recommendation.ts` L75). The `estimatedImpact` field is union-typed (string OR `{ range, ... }`) and both branches are checked:

```
  isRecommendationArray — the check

  Array.isArray(v) AND every element:
    typeof === 'object'
    AND typeof title === 'string'
    AND typeof rationale === 'string'
    AND bloomreachFeature in ('scenario'|'segment'|'campaign'|'voucher'|'experiment')
    AND Array.isArray(steps)
    AND estimatedImpact is:
       typeof === 'string'  OR  (object && typeof estimatedImpact.range === 'string')
    AND confidence in ('high'|'medium'|'low')

  what's NOT checked:
    - id (deliberate — agent emits id-less; system assigns)
    - effort, timeToSetUpMinutes, readResultInDays, prerequisites,
      successMetric (all Tier 1 optional)
    - estimatedImpact.rangeUsd structure (loose — accepted as-is)
```

### Move 2 — the in-memory store: session-scoped, with a real invariant

**This sub-section was rewritten 2026-06-16.** The 2026-06-01 version said "the in-memory Maps have no atomicity story" with module-level globals; the warning was "the moment two routes call putInsights concurrently, the integrity story collapses." That collapse mode wasn't theoretical — a warm Vercel instance serves many users, and `putInsights().clear()` on a global Map would wipe another user's feed mid-briefing. The fix shipped: the state is now keyed by `sessionId`, and each session has its own sub-feed.

```
  the new shape — Map<sessionId, SessionFeed>

  const state = new Map<string, SessionFeed>();

  type SessionFeed = {
    insights:       Map<string, Insight>;        ← per-session
    investigations: Map<string, Investigation>;  ← per-session
    anomalies:      Map<string, Anomaly>;        ← per-session
  };

  putInsights(sessionId, items, rawAnomalies):
    const s = sessionState(sessionId);    ← gets-or-creates this user's feed
    s.insights.clear();                    ← clears ONLY this user's insights
    s.anomalies.clear();                   ← clears ONLY this user's anomalies
    for each item:
      s.insights.set(i.id, i);
      s.anomalies.set(i.id, raw[idx]);

  the outer `state` map is never cleared by a request.
  the inner sub-maps are cleared by THAT session only.
```

**What this fixes:** the cross-session bug. Two users hitting `/api/briefing` concurrently no longer wipe each other's feeds. Each gets a stable, isolated sub-feed for the duration of their session. The test (`test/state/insights.test.ts`) names the bug directly: *"Cross-session isolation: the bug this refactor fixes. Two sessions writing concurrently must not overwrite or read each other's feed state."*

**What's still not atomic, within a session:** the same intra-session question remains. `putInsights` still does `s.insights.clear()` then `s.anomalies.clear()` then N pairs of `set()`. If a JS exception fired mid-loop the sub-maps would be half-populated. Today Node's event loop and the absence of I/O in the write path make this trivially safe — but it's the same "correct because the runtime model says so" story as before. The relational version would be:
```sql
BEGIN;
DELETE FROM insights WHERE session_id = ?;
DELETE FROM anomalies WHERE session_id = ?;
INSERT INTO insights ...;
INSERT INTO anomalies ...;
COMMIT;
```
…with `ON DELETE CASCADE` covering the parallel store. The session-scoping moves the question from "what about other users?" (now safe) to "what about a partial write WITHIN one session's clear-and-refill?" (still single-threaded fine).

### Move 2 — the Olist DB does have real transactions

The Olist seeder uses real SQLite transactions for the bulk insert path. The relevant pragmas:

```
  mcp-server-olist/src/db.ts

  pragma foreign_keys = ON   ← every FK is enforced at INSERT/UPDATE/DELETE
  pragma journal_mode = WAL  ← concurrent readers don't block writers; WAL log
                              gives crash-consistent durability

  the seeder (scripts/seed-olist.ts) wraps every bulk insert in a transaction:
    db.transaction(() => {
      for (const customer of customers) insertCustomer.run(customer);
      for (const product of products) insertProduct.run(product);
      ...
    })();

  better-sqlite3's `transaction()` wraps the closure in BEGIN/COMMIT, with
  automatic ROLLBACK on any thrown exception. atomic by construction.
```

**What this gives:** the seeder's "drop the DB and rebuild" path is atomic — either the whole dataset commits or none of it does. If the process is killed mid-seed, the next `npm run seed` rebuilds from a known-empty state. The FK + NOT NULL constraints provide the per-row integrity story: an `order_items` row that references a non-existent `order_id` would fail the insert, not silently corrupt the data.

**What's not exercised:** **multi-writer transactions on shared rows.** The Olist DB is single-writer (only the seeder writes) and many-reader (the tools all read). There's no story for "two writers contend on the same row." That's not a gap; it's a deliberate scope choice (the DB is read-only at runtime).

### Move 2 — the wire-format integrity check

The only place the route handler validates an *external* shape: `resolveAnomaly` in `app/api/agent/route.ts` (L37–L47) parses the `?insight=` query parameter as JSON and checks four fields before trusting it.

```
  resolveAnomaly — the inline guard

  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string'
            && i.change
            && Array.isArray(i.scope)
            && i.severity) {
        return insightToAnomaly(i);    ← trusted path
      }
    } catch {
      /* malformed param — fall through to server-side lookup */
    }
  }
  // fallthrough: try in-memory, then demo seed

  what's checked:    metric (string), change (truthy), scope (array), severity (truthy)
  what's NOT checked: that change has value/direction/baseline; that severity is a valid enum
                      value; that scope is a string array
  why fail-soft:     wire-format manipulation shouldn't crash the route. fall through
                     to the server-side lookup; if that also fails, return 404.
```

This is **defense-in-depth** for one specific seam: the browser can send anything in the URL query string, so the route validates inline. The check is intentionally loose — it's a sanity gate, not a full schema validation. The compiler can't help (the cast `as Insight` is a *promise*, not a check).

### Move 3 — the principle

Integrity lives at boundaries. The compiler covers the in-language boundaries; runtime guards cover the language boundaries (JSON-from-LLM, JSON-from-URL); transactions cover the store boundaries. This repo's strong half is the LLM-seam guards — correctly placed, fail-closed, permissive on optionals. Its weak half is the missing store-level integrity: no atomicity, no FK, no cross-Map invariant enforcement. That weakness is **inherited from the storage choice** (in-memory `Map`), not from the code. The moment the store grows up — Postgres, SQLite, even a disk-backed kv — the FK constraint plus the transaction will retire the weakness for free.

### Code in this codebase

The repo anchors for each integrity layer Move 2 walked — the LLM-seam guards, the fail-closed pattern, the session-scoped store write, the Olist FK + WAL story, and the wire-format check.

#### The three runtime guards

```
lib/mcp/validate.ts  (lines 1–57)

  export function parseAgentJson(text: string): unknown {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fence ? fence[1] : text).trim();
    try { return JSON.parse(candidate); }
    catch { /* fall through to substring scan */ }
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('no parseable json in agent output');
  }
       │
       └─ three-fallback parser. the fenced-block case is the
          common path; the substring scan is the "agent wrote prose
          around the JSON" recovery.

  const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

  export function isAnomalyArray(v: unknown): v is Anomaly[] {
    return Array.isArray(v) && v.every((a) =>
      !!a && typeof a === 'object' &&
      typeof (a as any).metric === 'string' &&
      Array.isArray((a as any).scope) &&
      !!(a as any).change && typeof (a as any).change.value === 'number' &&
      ((a as any).change.direction === 'up' || (a as any).change.direction === 'down') &&
      typeof (a as any).change.baseline === 'string' &&
      SEVERITIES.includes((a as any).severity)
    );
  }
       │
       └─ the workhorse. note the `v is Anomaly[]` type predicate —
          this is how TypeScript narrows the type for callers after a
          true return. cast through `as any` for the field accesses
          (the input is `unknown`); the predicate then rebinds the
          narrowed type at the call site.
```

#### The fail-closed pattern at the agent layer

```
lib/agents/monitoring.ts  (lines 112–119)

  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];                       ← fail-closed: empty briefing
  }
  if (!isAnomalyArray(parsed)) return [];   ← fail-closed: empty briefing
  return [...parsed]
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
    .slice(0, 10);
       │
       └─ the two return-[] paths are the integrity gate. invalid JSON
          OR wrong shape → empty array. the briefing renders "no
          anomalies found" rather than crashing on a malformed field
          access in the UI.
```

#### The session-scoped store write (UPDATED 2026-06-16)

```
lib/state/insights.ts  (lines 57–71)

  export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing for THIS session — each run IS the current
    // feed, not an addition. Without clearing, a warm serverless instance (or a
    // long-running dev server) accumulates stale insights from earlier runs, so
    // the feed shows yesterday's anomalies alongside today's. Investigations are
    // keyed separately and untouched here. Only this session's sub-maps are
    // cleared — never the outer map, never another session's feed.
    const s = sessionState(sessionId);          ← per-session sub-feed
    s.insights.clear();                          ← clears ONLY this session
    s.anomalies.clear();                         ← clears ONLY this session
    items.forEach((i, idx) => {
      s.insights.set(i.id, i);
      if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ cross-session safe: the outer Map is never cleared. test/state/
          insights.test.ts has the explicit cross-session-isolation test.
          intra-session: still single-threaded + no I/O, still safe by the
          runtime model. for a real durable store the fix would be:
            session_id INDEX + DELETE WHERE session_id=? + INSERT
            wrapped in BEGIN/COMMIT (Postgres) or db.transaction (sqlite).
```

#### The Olist FK + WAL story

```
mcp-server-olist/src/db.ts  (lines 38–43)

  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');     ← concurrent readers don't block
  db.pragma('foreign_keys = ON');      ← FKs enforced at runtime
       │
       └─ readers run against the DB the seeder produced. WAL means a future
          writer could append without blocking these reads. foreign_keys=ON
          is critical — SQLite's default is OFF, so a fresh DB with FK
          DDL but no pragma will silently accept orphans.


mcp-server-olist/scripts/seed-olist.ts  (the schema, lines 184–245)

  CREATE TABLE order_items (
    order_id    TEXT NOT NULL REFERENCES orders(id),    ← FK + NOT NULL
    product_id  TEXT NOT NULL REFERENCES products(id),  ← FK + NOT NULL
    price_brl   INTEGER NOT NULL,                        ← cents, NOT NULL
    freight_brl INTEGER NOT NULL
  );
       │
       └─ every join column is FK-constrained AND NOT NULL. orphan inserts
          fail. NULL price/freight inserts fail. the schema enforces the
          domain rule that every order_items row references a real order
          and a real product, with real cents.
```

#### The wire-format inline check

```
app/api/agent/route.ts  (lines 37–47)

  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string'
            && i.change
            && Array.isArray(i.scope)
            && i.severity) {
        return insightToAnomaly(i);
      }
    } catch {
      /* malformed param — fall through to the server-side lookup */
    }
  }
       │
       └─ narrow 4-field check. fail-soft: any malformed input falls
          through to the in-memory lookup, then the demo seed. the
          route returns 404 only if all three sources are empty.
```

---

## Primary diagram

The integrity layers, recap.

```
  Integrity — what guards what, where

  ┌─ LLM seam ────────────────────────────────────────────────┐
  │   model output (string)                                    │
  │         │                                                   │
  │         ▼                                                   │
  │   parseAgentJson — handles fenced/bare/embedded JSON       │
  │         │                                                   │
  │         ▼                                                   │
  │   isAnomalyArray | isDiagnosis | isRecommendationArray     │
  │         │                                                   │
  │         ▼                                                   │
  │   trusted typed value OR fail-closed neutral ([], null)    │
  │   ★ STRONG: 3 guards, narrow, fail-soft, well-placed       │
  └────────────────────────────────────────────────────────────┘

  ┌─ wire format seam ────────────────────────────────────────┐
  │   ?insight=<JSON> from browser                              │
  │         │                                                    │
  │         ▼                                                    │
  │   JSON.parse + inline 4-field shape check                   │
  │         │                                                    │
  │         ▼                                                    │
  │   trusted Insight OR fall through to server-side lookup     │
  │   ★ OK: narrow check, sensible fallback                     │
  └────────────────────────────────────────────────────────────┘

  ┌─ in-memory store ─────────────────────────────────────────┐
  │   putInsights:                                              │
  │     insights.clear() + anomalies.clear() + N pairs of set   │
  │         │                                                    │
  │         ▼                                                    │
  │   NO transaction. NO FK. NO cross-Map invariant enforcement │
  │   ★ WEAK: holds today only because the runtime is           │
  │     single-threaded and the loop has no I/O                 │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The interesting tension in this design: the LLM-seam guards are stricter than the wire-format guard. The LLM seam validates 7 fields (`isAnomalyArray`); the wire-format seam validates 4. Why? Because the LLM seam is *adversarial-by-default* — the model can hallucinate any shape. The wire-format seam is *trusted-by-default* — the JSON came from the same app's own `?insight=` link, just round-tripped through the browser. The asymmetry is correct, but worth noting: if the route ever accepts `?insight=` from outside the app (a saved link, a webhook), the 4-field check is too loose. Today the trust model is "the browser is honest"; if that breaks, tighten the gate.

A subtle point about the guards: they're hand-rolled, but they exist *because TypeScript can't help here*. A common reaction is "use Zod and derive both the type and the guard from one source." That would replace 50 lines of hand-rolled checks with 30 lines of Zod schemas, gain runtime introspection, and lose nothing — except the dependency. For this repo's size (3 guards), the hand-rolled path is fine. At 8+ guards or a single shape that's edited often, Zod earns its place.

The deeper integrity story: **the LLM seam is the only place where the system actively distrusts its own components.** Everywhere else, the code trusts: the route trusts the state module, the state module trusts the agent, the agent trusts the MCP wrapper. That trust is *fine* when both sides are typed and tested. At the LLM seam it isn't, because the model isn't typed and can't be tested for every shape it might emit. That's why the guards earn their place. Generalizing: any time you parse JSON from an untyped source, you're at an integrity seam — typed contract on one side, free-form text on the other. The guard is non-optional.

A point on FKs that don't exist: the closest thing to an FK in this repo is `Investigation.insightId`. Today it's "the key the investigation is stored under in the `investigations` Map" — which is trivially consistent because the only writer is `putInvestigation`, which uses the same id as both the field and the Map key. If those ever diverged (say, an investigation stored under a normalized hash but referencing the raw id), you'd want an FK constraint. The relational migration would catch this for free.

## Interview defense

**Q: How does this repo enforce data integrity?**
A: Three layers, three mechanisms. TypeScript at every in-language boundary — the compiler catches mismatched shapes between modules. Runtime guards at the **LLM seam** — `validate.ts` has three guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) that narrow `unknown` to the expected type before downstream code touches it. Inline shape checks at the **wire-format seam** — `resolveAnomaly` validates four fields of the `?insight=` query param before trusting it. The in-memory store has *no* atomicity — `putInsights` clears two Maps non-transactionally — but it holds today because Node is single-threaded and the write path has no I/O.

**Q: Walk me through the most important integrity check in the repo.**
A: The `isAnomalyArray` guard in `lib/mcp/validate.ts` (L17–L27). The monitoring agent emits a JSON string; `parseAgentJson` handles fenced/bare/embedded shapes; `isAnomalyArray` checks the seven required fields per element. The guard is a TypeScript type predicate (`v is Anomaly[]`) so callers get narrowing for free after a true return. The fail-closed return — `[]` on any malformed input — is the load-bearing piece: the briefing degrades to "no anomalies" rather than crashing the route. Drop that fail-closed and one bad LLM response takes down the whole feed.

```
  diagram while you talk

  model output (string)
        │
        ▼
  parseAgentJson  ← fenced ```json | bare | substring scan
        │
        ▼  unknown
  isAnomalyArray  ← checks 7 fields per element
        │
   ┌────┴────┐
   ▼         ▼
  true       false
   │           │
   ▼           ▼
  Anomaly[]   return []  ← fail-closed; briefing renders "no anomalies"
```

## See also

- `01-the-data-model-and-its-shape.md` — the 8 interfaces the guards narrow to.
- `02-normalization-and-duplication.md` — the cross-Map invariant within a session (`insights` ↔ `anomalies` keyed alignment); the wire-format leak that bypasses it.
- `05-migrations-and-evolution.md` — why the guards are deliberately permissive on optional fields (so older snapshots still validate); how Olist gets "migrations" by rebuilding from a deterministic seed.
- `06-access-patterns-and-storage-choice.md` — the three storage layers and what each enforces.
- `08-the-olist-relational-schema.md` — the FK and NOT NULL constraints in detail.
- `09-deterministic-synthetic-data.md` — `seeded_anomalies` as a ground-truth invariant; the determinism-vs-migrations tradeoff.
- `study-software-design/audit.md#information-hiding-and-leakage` — the LLM-seam parsing logic is a strong hide.

---
