# 04 — Transactions and integrity

**Atomicity / invariants enforcement · Industry standard**

## Zoom out, then zoom in

The classical question — *if two writes must succeed together, what makes
that atomic?* — usually answers with `BEGIN ... COMMIT`. In
**blooming_insights** there's no DB, no transaction primitive, and no
SQL-style `CHECK` constraints. So the question becomes: **what enforces
the invariants the app needs, and where can they drift?**

```
  Zoom out — where invariants live in this codebase

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  TypeScript types are the compile-time contract                   │
  │  (Insight, Diagnosis, Recommendation — UI can't render an off-    │
  │   shape value because tsc rejects the code)                       │
  └─────────────────┬─────────────────────────────────────────────────┘
                    │  NDJSON over fetch
  ┌─ Route layer ───▼─────────────────────────────────────────────────┐
  │  lib/mcp/validate.ts — runtime type guards                        │
  │  (isAnomalyArray / isDiagnosis / isRecommendationArray)           │
  │  the LLM emits text → parsed JSON → validated → stored            │
  └─────────────────┬─────────────────────────────────────────────────┘
                    │
  ┌─ State layer ───▼──── ★ THIS CONCEPT ★ ──────────────────────────┐
  │  per-session Map isolation                                        │ ← we are here
  │  putInsights clear-and-fill (not atomic, but isolated)            │
  │  no rollback if a write throws mid-sequence                       │
  └─────────────────┬─────────────────────────────────────────────────┘
                    │  callTool
  ┌─ Substrate ─────▼─────────────────────────────────────────────────┐
  │  Bloomreach has its own consistency story — we don't write to it  │
  │  (every write would be an EQL UPDATE; the app only READS)         │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Three layers enforce things: **TypeScript at compile time**,
**`validate.ts` at runtime**, and **per-session Map scoping** at the data
layer. None of the three is a transaction. The audit needs to call out
where the *absence* of a transaction matters.

---

## Structure pass — the axis is "what could go wrong, and what catches it?"

```
  Trace ONE axis — "what catches a corrupt write?" — across layers

  axis: validation / containment

  ┌─ compile time ─────────────────┐
  │  TypeScript types: hand-written │   ← guards code that mutates
  │  code can't construct a bad     │     internal shapes
  │  Insight                        │
  └────────────┬───────────────────┘
               │  seam: LLM output is `string`, not Insight
  ┌────────────▼───────────────────┐
  │  runtime validators (validate.ts)│   ← guards untrusted JSON
  │  parse → guard → reject         │     from the model
  └────────────┬───────────────────┘
               │  seam: agent emits, route writes
  ┌────────────▼───────────────────┐
  │  state layer write              │   ← no further check; assumes
  │  putInsights clears + sets      │     validated data arrives
  └────────────┬───────────────────┘
               │  seam: cross-session contamination
  ┌────────────▼───────────────────┐
  │  per-session Map scoping        │   ← prevents Session A from
  │  outer Map keyed by sessionId   │     reading/clobbering Session B
  └────────────────────────────────┘
```

Three seams; each one a different kind of integrity question. The axis
flips at each: compile-time guards code shape; runtime guards model
output; isolation guards multi-tenant coexistence.

---

## How it works

### Move 1 — the mental model

Think of it like `fetch().then(res => res.json())` in a frontend app. You
know the response *should* match a shape, but it came from over the
network so you treat it as untrusted. You either validate it with a
schema library (Zod, Yup) or `as` cast and hope. Same setup here: the
agent's output is *string*, parsed into untrusted JSON, then validated
before it touches the store. The store itself is trusted (only this
codebase writes to it).

```
  The three layers of "is this data OK?"

  TRUSTED                                    UNTRUSTED
                                                │
  TypeScript types ◄─── compile-time guard ─────┤
  (handwritten code can't construct bad data)   │
                                                │
  validate.ts      ◄─── runtime guard ──────────┤
  (LLM output is JSON.parse()'d, then           │
   shape-checked before storage)                │
                                                │
  per-session      ◄─── isolation guard ────────┤
  Map scoping      (no other session can        │
  (clear+fill writes never cross sessions)      │
                                                ▼
  store ── trusted region ── write is just .set(k, v)
```

There's no fourth layer (no DB-side `CHECK`, no FK enforcement). If
anything corrupt makes it past the runtime guard, it lands in the store
and the next reader sees it.

### Move 2 — the integrity mechanisms, one at a time

#### **Mechanism 1: TypeScript types as the compile-time contract**

This is the cheapest layer — it catches every bug where the *code*
constructs the wrong shape. You can't write:

```typescript
const i: Insight = { id: 'x' }; // Property 'severity' is missing
```

…and get past `tsc`. So every code path that builds an `Insight` is
guarded by the type system. `anomalyToInsight` returns `Insight`, so the
return statement must include every required field — the compiler
catches a missed field before the code ever runs.

The hole this layer leaves: **anything that came from outside the type
system.** Three sources:

```
  Sources outside the TypeScript guarantee

  ┌─ LLM output ────────────┐    JSON.parse → unknown
  │  agent emits a string   │ ──────────────────────► must validate
  └─────────────────────────┘
  ┌─ committed JSON ────────┐    JSON.parse → unknown
  │  demo-insights.json     │ ──────────────────────► trusted (we wrote it)
  └─────────────────────────┘                          but no test enforces shape
  ┌─ MCP tool result ───────┐    `unknown` field
  │  evidence[].result      │ ──────────────────────► UI defensively scans
  └─────────────────────────┘
```

The LLM output gets a runtime guard (next mechanism). The committed JSON
is *discipline-trusted* (humans regenerate it via the capture script and
the script writes proper shapes). The MCP `result: unknown` is the
intentional escape hatch — the UI degrades silently if the shape isn't
what it expected.

#### **Mechanism 2: `validate.ts` runtime guards on agent output**

The agents emit *text* — they're LLMs talking to JSON. The parsed JSON
has to be checked before it can be cast to `Anomaly[]` or `Diagnosis`.

```typescript
// lib/mcp/validate.ts:17-27
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
```

Annotation by line:

- **L18 `Array.isArray(v)`** — first defense, since the agent might emit
  a single object or a string by mistake.
- **L20–22** — checks each required field individually. **Optional fields
  are not checked here** (`impact`, `history`, `category`, all enrichments)
  — they're allowed to be missing or *malformed* and the UI just doesn't
  render them.
- **L23–26 `change`** — checks the whole nested object. If `change.value`
  isn't a number, the entire anomaly is rejected.

```
  validation flow for monitoring agent output

  LLM emits text
       │
       ▼
  parseAgentJson(text)         lib/mcp/validate.ts:3
   ├─ strips ```json fences
   ├─ JSON.parse
   └─ falls back to substring scan if parse fails
       │
       ▼
  isAnomalyArray(parsed)?
       │
   ┌───┴────┐
   │        │
   no       yes
   │        │
   ▼        ▼
  retry     putInsights(sessionId, items)
  loop      → enters the store
  in agent
```

What this gets right: the validators check the *required* shape and let
optional fields slide. If the agent emits a malformed `revenueImpact`
the system doesn't crash — the UI just shows the fallback.

What this misses (audit flag): there's no **value-range check**. An
`Anomaly` with `change.value = -10000` (impossibly large %) passes the
type guard. A `change.direction = 'up'` with `change.value = -5` is
internally inconsistent and passes. The DB analog would be a `CHECK`
constraint; here the discipline is "trust the agent prompt to emit
sane numbers." A real DB would refuse the row; this layer doesn't.

#### **Mechanism 3: per-session Map isolation**

This is the most important integrity mechanism in the codebase, and it's
called out in a load-bearing comment:

```typescript
// lib/state/insights.ts:7-13
// Session-scoped feed state. A single warm Vercel instance serves many users
// concurrently, so module-level Maps would bleed between sessions — and
// putInsights' clear() would wipe another user's feed mid-briefing. Each
// session gets its own sub-feed; the outer map is never cleared by a request.
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
```

The invariant: **Session A's writes never touch Session B's data.** The
mechanism: the outer `Map<sessionId, SessionFeed>` is keyed by the
`bi_session` cookie UUID, and **only** the sub-map for that session is
ever cleared or written to.

```
  Per-session isolation as the integrity boundary

  WITHOUT isolation:                  WITH isolation (this codebase):

  state: Map<insightId, Insight>      state: Map<sessionId, SessionFeed>
       │                                   │
       │  user A's briefing                │  user A's briefing
       │  → clear() wipes EVERYONE         │  → sessionState(A).insights.clear()
       │                                   │     only A's sub-map is wiped
       ▼                                   ▼
  CROSS-USER DATA LOSS                  ISOLATION PRESERVED
```

The comment is doing real work — it's the explanation for why the data
layer is two-level Maps instead of one flat Map. Anyone refactoring this
file has to see the comment first and understand the invariant before
flattening it "for simplicity."

#### **Mechanism 4: the clear-then-fill write (NOT a transaction, but isolated)**

The closest the app gets to a multi-write operation is `putInsights`:

```typescript
// lib/state/insights.ts:64-71
const s = sessionState(sessionId);
s.insights.clear();
s.anomalies.clear();
items.forEach((i, idx) => {
  s.insights.set(i.id, i);
  if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
});
```

This is **NOT atomic.** If `items.forEach` throws midway through, the
session is left with a *partial* feed — the first few insights set, the
rest missing, but `s.insights.clear()` already ran so the *previous*
briefing is gone too. The data is in a degraded state until the next
briefing repairs it.

```
  What "no transaction" looks like in practice

  t=0: putInsights called with [i1, i2, i3, i4, i5]
  t=1: clear() — previous briefing gone
  t=2: set(i1) — OK
  t=3: set(i2) — OK
  t=4: set(i3) — throws (e.g. crypto.randomUUID rejection, OOM)
  t=5: → exception bubbles up
  t=6: state is now { i1, i2 } — partial briefing, no rollback

  with a transaction:
  t=5: rollback — state back to previous briefing
  t=6: error propagates, state intact
```

How serious is this? **In practice, not very.** The next briefing call
will run `clear()` again and start fresh. The user sees a half-empty feed
for one render cycle, then either retries (auto-reconnect path) or
refreshes. There's no permanent corruption because the data isn't
durable in the first place — it's all recomputable from the substrate.

But the *principle* matters for the audit: if this state ever became
durable (e.g. you moved insights to Postgres), the same code pattern
would leave you with permanent partial state. The fix at that point
would be a real transaction.

#### **Mechanism 5: invariant gaps — what nothing enforces**

These are real:

- **`Insight.affectedCustomers` agrees with `Diagnosis.affectedCustomers.count`.**
  Two independent writers, no reconciliation. See
  `02-normalization-and-duplication.md` policy 2.
- **`change.direction = 'up'` implies `change.value > 0`** (and vice
  versa). Type system says both are allowed values; `validate.ts` doesn't
  cross-check them. An agent emitting `{ direction: 'up', value: -5 }`
  would pass.
- **`evidence[].tool` is a known tool name.** Anything string-shaped
  passes. A typo in the agent's emission (e.g. `executes_analytics_eql`)
  wouldn't be caught at validation; it'd show as an unrenderable evidence
  bullet on the card.
- **`demo-insights.json` matches the current `Insight` type.** No test
  re-validates the demo against the type on every commit.

```
  invariants that nothing enforces today

  invariant                                     | enforced by
  ──────────────────────────────────────────────┼───────────────────────
  type shape of Insight (compile)               | TypeScript ✓
  required fields present (runtime, LLM output) | validate.ts ✓
  per-session write isolation                   | Map scoping ✓
  ────────────────────────────────────────────────────────────────────
  affectedCustomers consistent across Insight   | NOTHING (audit flag)
   and Diagnosis                                |
  change.direction ↔ sign(change.value)         | NOTHING
  evidence[].tool ∈ known tool names            | NOTHING
  demo JSON matches current type                | discipline only
  putInsights atomicity                         | NOTHING (acceptable
                                                | because state is
                                                | recomputable)
```

Each gap has a different cost. The first three are real (would cause UI
weirdness if violated); the demo-JSON one is a CI-test-shaped problem;
the atomicity one is acceptable because of the recomputability story.

### Move 3 — the principle

**Without transactions, integrity comes from three places: the type
system, runtime validators, and access discipline (who can write what,
where).** In a SQL database, the DB enforces all three. In an in-memory
app, you have to write the enforcement yourself, and the choice of
*what* to enforce is a design call.

The generalisation: when you read someone's "no-database" codebase, ask
three questions in order — (1) does the type system describe the data?
(2) is there a runtime guard at every untrusted boundary? (3) is
concurrent access bounded so writers don't step on each other? If yes
to all three, the absence of a DB isn't a bug. If no to any one, the
absence is a latent disaster waiting for the first concurrent user.

---

## Primary diagram

The full integrity story in one frame.

```
  Integrity layers in blooming_insights

  ┌─ UNTRUSTED EDGE ──────────────────────────────────────────────────┐
  │                                                                   │
  │   LLM output (string)             Committed demo JSON              │
  │   ──────────────────              ─────────────────────            │
  │           │                                │                       │
  │           ▼                                ▼                       │
  │   parseAgentJson + validate.ts        readJson (no validation)     │
  │   ┌────────────────────────────┐      ┌────────────────────────┐  │
  │   │ isAnomalyArray             │      │ trusted by discipline; │  │
  │   │ isDiagnosis                │      │ no test re-validates   │  │
  │   │ isRecommendationArray      │      │ → LATENT RISK          │  │
  │   │ → rejects bad shapes       │      └────────────────────────┘  │
  │   └─────────────┬──────────────┘                                  │
  │                 │ valid shape                                      │
  │                 ▼                                                  │
  │                                                                   │
  └─ TRUSTED REGION ──────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─ STATE LAYER (per-session Map) ───────────────────────────────────┐
  │                                                                   │
  │   sessionState(sessionId).insights.set(id, insight)                │
  │   ★ ISOLATION GUARANTEE: writes scoped to this session             │
  │                                                                   │
  │   putInsights: clear + fill, NOT atomic                            │
  │   acceptable because state is recomputable from substrate          │
  │                                                                   │
  │   GAPS:                                                            │
  │     - no cross-write check on affectedCustomers                    │
  │     - no value-range check on change.value                         │
  │     - no whitelist on evidence[].tool                              │
  │                                                                   │
  └─────────────────┬─────────────────────────────────────────────────┘
                    │  read
                    ▼
  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  TypeScript types catch construction errors at compile time       │
  │  defensive helpers (findCurrentPrior, impactRange) handle missing  │
  │  optional fields gracefully                                        │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Where this comes from: the ACID properties (Atomicity, Consistency,
Isolation, Durability) define what a DB transaction promises. This
codebase has **Isolation** (per-session Maps) but skips the other three —
no atomicity, weaker consistency (cross-shape invariants unenforced), no
durability. That's a deliberate tradeoff: the data is recomputable, so
losing it doesn't matter; the consistency gaps haven't been load-bearing.

The seam to **distributed systems**: the substrate is a third-party
system (Bloomreach), so the app inherits *its* consistency story for
reads. The agent loops are read-only against the substrate — no writes,
no need to reason about substrate transactions.

What this codebase consciously doesn't do — and is right not to:

- **No `BEGIN ... COMMIT` simulation.** Building a transaction primitive
  for the in-memory Maps would be theatre — restart kills all state
  anyway.
- **No write-ahead log.** Again, restart kills state; logging it would
  buy nothing.

What it consciously does — and would still be right at scale:

- **Type-first contracts.** Even with a real DB, the TypeScript types in
  `lib/mcp/types.ts` would still be the right place for the schema
  source of truth (you'd generate migrations from them, not the other
  way around).
- **Runtime validators on untrusted boundaries.** LLM output is always
  untrusted, even with a DB underneath; `validate.ts` still earns its
  keep.

What to read next: `05-migrations-and-evolution.md` walks the "new fields
are optional" discipline that keeps the demo JSON valid as types grow.

---

## Interview defense

**Q: "How do you handle atomicity when multiple writes have to succeed
together?"**

Verdict first: today, **I don't**, and that's deliberate. The state layer
is in-process Maps that get cleared and rebuilt every briefing. If a
write throws midway through `putInsights`, the session is left with a
partial feed — the next briefing repairs it. The data is recomputable
from the substrate, so a partial state isn't permanent corruption.

```
  what makes the no-atomicity choice OK here

  durable store with no transactions:  unrecoverable partial state
       │
       ▼
  ephemeral store, recomputable input: partial state is repaired by
                                       the next briefing — no permanence,
                                       no corruption.
  the app doesn't OWN data; the substrate does. losing the cache
  costs a re-run, not data.
```

Anchor: "the load-bearing thing here is *recomputability* — if the
substrate owns the truth, the cache layer doesn't need atomicity. The
moment the app owns any user-authored data, atomicity becomes mandatory
— and at that point I'd reach for a real DB, not simulate transactions
in memory."

**Q: "What's the strongest integrity guarantee in the codebase?"**

Verdict first: **per-session Map isolation.** It's the only real
multi-tenant safety guarantee — without it, a warm Vercel instance
serving many users would let Session A's `putInsights().clear()` wipe
Session B's feed mid-render. The comment in `lib/state/insights.ts:7-13`
is the load-bearing explanation; the Map-of-Maps shape is the
enforcement.

```
  isolation as the integrity guarantee

  ┌─ WITHOUT isolation ─────┐    ┌─ WITH isolation ───────────┐
  │  flat Map<id, Insight>  │    │  Map<sessionId, SessionFeed>│
  │                         │    │                             │
  │  Session A briefing     │    │  Session A briefing         │
  │  → .clear() wipes ALL   │    │  → clears A's sub-map only  │
  │                         │    │  → B is untouched           │
  └─────────────────────────┘    └─────────────────────────────┘
       cross-user data loss              correct multi-tenant
```

Anchor: "the strongest guarantee isn't a `CHECK` constraint — it's the
*scoping* that prevents one writer from being able to see another's
data at all."

---

## See also

- [`02-normalization-and-duplication.md`](./02-normalization-and-duplication.md)
  — the `affectedCustomers` duplication that nothing enforces
- [`03-indexing-vs-query-patterns.md`](./03-indexing-vs-query-patterns.md)
  — the Map shape that makes isolation cheap
- [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md)
  — type evolution as the migration story
- [`audit.md`](./audit.md) — checklist with this file's findings
