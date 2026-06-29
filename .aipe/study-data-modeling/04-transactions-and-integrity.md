# Transactions and integrity

*Invariant enforcement at the trust boundary (industry standard) · Language-agnostic*

## Zoom out, then zoom in

In a SQL database, integrity is enforced by the engine: `NOT NULL`, `UNIQUE`, foreign keys, `CHECK` constraints, and atomic transactions. The database is the *last* line of defense — even if every app layer is buggy, an `INSERT` that violates a constraint fails loudly. The schema is the contract no app code can route around.

This repo has none of that. No FK enforcement, no `UNIQUE` index, no transactional boundary that fences a multi-write into all-or-nothing. The integrity story has to live somewhere else: in **type guards at the trust boundary** (LLM output, JSON file, query string) and in **single-writer conventions** that mean atomicity doesn't matter.

```
  Zoom out — where integrity is enforced

  ┌─ UI layer (consumer) ───────────────────────────────┐
  │  trusts: every Insight has metric/scope/change      │
  │  trusts: every Diagnosis has the 3 required fields  │
  └────────────────────────┬───────────────────────────┘
                           │ NDJSON of AgentEvents
  ┌─ Service layer (writer) ▼──────────────────────────┐
  │  ★ THE INTEGRITY LAYER ★                            │ ← we are here
  │  isAnomalyArray(v)         ┌─ LLM JSON              │
  │  isDiagnosis(v)            ├─ JSON.parse boundary   │
  │  isRecommendationArray(v)  ├─ ?insight= URL param   │
  │  parseAgentJson(text)      └─ demo snapshot file    │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Storage layer ────────▼───────────────────────────┐
  │  Map<id, Entity> — no constraints, no checks       │
  │  putInsights(sid, items, anomalies) — write both    │
  │  but no atomicity between the two maps              │
  └─────────────────────────────────────────────────────┘
```

**Zoom in.** The integrity model rests on **type guards at every untrusted input** and **conventions that sidestep atomicity**. The trust boundaries you need to name: anything the LLM emits, anything that comes from a URL param, anything read from a JSON file. The atomicity questions you need to answer: when `putInsights` writes both `.insights` and `.anomalies` maps, what if it crashes between them? The answer here is *single-writer, no concurrency, no rollback needed* — and that's defensible only as long as it's true.

## Structure pass

**Layers.** Integrity enforcement lives at three altitudes:

- **Compile-time** (type layer) — TypeScript types reject malformed values at build. `bloomreachFeature: 'scenario' | 'segment' | …` rejects `'newsletter'` before the code runs.
- **Run-time at the trust boundary** (service layer) — type guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) validate JSON the moment it crosses an untrusted seam.
- **Run-time inside the system** (storage layer) — almost nothing. The `Map`s accept whatever you put in.

**Axis traced — "what stops an invalid value from reaching the UI?"** Hold that question across the layers:

```
  Trace the integrity axis through the boundaries

  compile-time:    TypeScript rejects wrong shape AT BUILD
                   (but the LLM emits JSON at runtime → TS can't help)

  run-time guard:  isAnomalyArray / isDiagnosis / isRecommendationArray
                   throw / return false → caller bails before write
                   (THIS IS WHERE INTEGRITY ACTUALLY LIVES)

  storage:         Map.set() takes anything
                   no constraint, no validation, no rollback
                   (relies on the run-time guard above)
```

**Seams.** Four trust boundaries:

1. **LLM output** — text from `anthropic.messages.create`. The agent loop calls `parseAgentJson` to extract JSON from a maybe-fenced code block, then runs `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` to validate the shape.
2. **URL params** — `?insight=` and `?diagnosis=` on `/api/agent`. Validated by inline shape checks in `resolveAnomaly` and `parseDiagnosis`.
3. **JSON files on disk** — `demo-insights.json`, `demo-investigations.json`, `.investigation-cache.json`, `.auth-cache.json`. Validated implicitly: the optional-field discipline (every additive field is `?`) means old files keep passing.
4. **The encrypted auth cookie** — AES-256-GCM with auth tag verification. A tampered cookie decrypts to `{}` (treated as no auth) rather than letting bad state through.

The OAuth cookie's tampering check is the *one* place this codebase has a real "constraint" — and it's a cryptographic one, not a schema one.

## How it works

### Move 1 — the mental model

You know how `Number.parseInt('abc')` returns `NaN` instead of throwing? That's a type-coercion failure with no boundary — the bad value just propagates as `NaN` and you find the bug three frames later. Type guards in this codebase are the opposite: they're a **hard boundary at the JSON-parse step** where bad input gets caught and rejected *before* it enters the system.

```
  The pattern — type guards as the boundary

  untrusted input
       │
       ▼
  ┌─────────────────┐
  │  JSON.parse     │  → unknown
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │  TYPE GUARD     │  isAnomalyArray(v): v is Anomaly[]
  │  the boundary   │  → narrows or rejects
  └────────┬────────┘
           │ passes ──► entity ── flows into Map
           │ fails  ──► throw / return null
           ▼
  the system never sees an invalid value
```

The thing to notice: the guard returns `v is Anomaly[]` — a TypeScript type predicate. Once `isAnomalyArray(v)` returns true, the compiler *narrows* `v` to `Anomaly[]` for the rest of the function. So the guard is doing double duty: runtime gate AND compile-time proof. This is the cheapest, smallest integrity layer that still catches the failure modes that matter — LLM output drift, malformed snapshots, query param tampering.

### Move 2 — the guards and the conventions

#### Guard 1 — `parseAgentJson` (the parse-then-validate step)

The LLM is asked to emit JSON, but it often wraps it in a markdown code fence (\`\`\`json … \`\`\`) or adds prose around it. `parseAgentJson` is the lenient front-door:

```ts
// lib/mcp/validate.ts:3-13
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through to substring scan */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
```

Three attempts, in order: (1) try the fenced block, (2) try the whole text, (3) substring-scan from the first `[`/`{` to the last `]`/`}`. The return type is `unknown` — not `Anomaly[]` — which forces the caller to validate. The function throws if no JSON is extractable; everything else gets a chance.

This is **integrity at the lexical boundary** — it ensures the bytes coming out parse as JSON, but says nothing about whether the parsed value is an Anomaly. That's the next guard.

#### Guard 2 — `isAnomalyArray` (the shape gate)

The shape validator. Returns a type predicate.

```ts
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

The guard checks **only required fields**. `evidence`, `impact`, `history`, `category` are all skipped — they're optional on `Anomaly` and the snapshot-survival rules in `05` mean the validator can't reject missing optional fields. That's the deliberate trade: the gate is permissive about optional fields and strict about the four invariants that make a row an Anomaly at all.

```
  isAnomalyArray — what it checks, what it doesn't

  ┌─ required (rejects if missing/wrong type) ──────┐
  │   metric: string                                 │
  │   scope: array                                   │
  │   change: { value: number,                       │
  │             direction: 'up' | 'down',            │
  │             baseline: string }                   │
  │   severity: 'critical' | 'warning'               │
  │           | 'info' | 'positive'                  │
  └──────────────────────────────────────────────────┘

  ┌─ optional (NOT checked) ────────────────────────┐
  │   evidence  · impact  · history  · category     │
  │   (snapshot-survival: must accept absence)       │
  └──────────────────────────────────────────────────┘
```

Two more guards in the same file do the same job for `Diagnosis` (`validate.ts:29-35`) and `Recommendation[]` (`validate.ts:42-57`). `isRecommendationArray` also encodes the **dual-shape `estimatedImpact`** check:

```ts
// lib/mcp/validate.ts:46-48
const impactOk =
  typeof x.estimatedImpact === 'string' ||
  (!!x.estimatedImpact && typeof x.estimatedImpact === 'object' && typeof x.estimatedImpact.range === 'string');
```

— either the legacy string form OR the rich `{ range, ... }` object. That's the integrity layer accommodating schema evolution. Covered in `05`.

#### Guard 3 — inline URL param validation (`resolveAnomaly`)

The `/api/agent` route accepts `?insight=<JSON>` so the client can hand the route an Insight that survives a Vercel instance hop. The route validates the shape inline before trusting it:

```ts
// app/api/agent/route.ts:35-44 (inside resolveAnomaly)
if (insightParam) {
  try {
    const i = JSON.parse(insightParam) as Insight;
    if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
      return insightToAnomaly(i);
    }
  } catch {
    /* malformed param — fall through to the server-side lookup */
  }
}
```

Same shape rules as `isAnomalyArray`, inlined because the surrounding fallback ladder (4 tiers — see `03-indexing-vs-query-patterns.md`) makes it easy to just *fall through* on validation failure rather than throw. The `parseDiagnosis` validator at `route.ts:84-95` does the same for `?diagnosis=`:

```ts
// app/api/agent/route.ts:84-95
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch {
    /* ignore */
  }
  return null;
}
```

Fail-silent-then-fall-through is the integrity stance for URL params: a tampered param doesn't crash the request, it just degrades to the next tier of the lookup ladder.

#### Guard 4 — the encrypted cookie (cryptographic integrity)

The OAuth state in production lives in an encrypted httpOnly cookie. Tampering is caught by the AES-GCM auth tag at decryption:

```ts
// lib/mcp/auth.ts:69-79
function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

This is the one place in the codebase with a *real* integrity constraint: the auth tag verifies that the ciphertext wasn't modified and was encrypted with `aesKey()`. Any tampering decrypts to `{}` — the user is treated as logged out, not granted spurious auth.

```
  Cookie integrity — AES-256-GCM auth tag

  cookie:   [ 12 bytes IV │ 16 bytes tag │ ciphertext ]
                                  │
                                  │ verifyTag(tag, ciphertext, aesKey)
                                  ▼
                          ┌── valid ──┐    ┌── invalid ──┐
                          ▼            ▼    ▼              ▼
                    plain JSON      decrypt fails       throw
                    Store           catch ── return {}    ↓
                                                    no auth state
                                                    (safe fallback)
```

### Move 2 — atomicity (the part that isn't there)

#### Multi-write 1 — `putInsights` (writes two maps)

The feed write touches both `insights` and `anomalies`:

```ts
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();          // ← side effect 1: wipe insights
  s.anomalies.clear();         // ← side effect 2: wipe anomalies
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);   // ← side effect 3: write insight N
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);  // ← side effect 4
  });
}
```

Four side effects, no transaction. If the process crashed between `s.insights.clear()` and the first `set`, you'd have an empty feed and orphaned (cleared) anomalies. **Why this doesn't matter here:**

1. **The writes are synchronous.** No `await` between them, so no interleaving point. The Node event loop doesn't preempt mid-function.
2. **The "crash" mode that matters in serverless is the warm instance dying.** When that happens, the *whole* `Map<sessionId, SessionFeed>` is gone — there's no partial state to recover, the next request starts from scratch.
3. **There's a single writer.** Only `/api/briefing` calls `putInsights`. A client can't trigger two briefings that run concurrently on the same instance because the route holds the cookie's session id and the user has one browser tab.

The closest analog is a database's `BEGIN; DELETE ...; INSERT ...; COMMIT;` — and the move here is "skip the wrapper because the process model gives you the same guarantee for free." It works because (a) the operation is synchronous, (b) the failure mode is whole-process, and (c) there's no concurrent writer.

#### Multi-write 2 — `saveInvestigation` (memory + disk)

The investigation cache writes mem first, then file:

```ts
// lib/state/investigations.ts:30-41
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch {
      /* best effort */
    }
  }
}
```

Three side effects: `mem.set`, then `readJson + JSON.stringify + writeFileSync`. The disk write is **best-effort, in dev only** (`PERSIST = process.env.NODE_ENV === 'development'`). If the file write fails (disk full, permission, concurrent writer corrupting JSON), the in-memory write survives. The atomicity that matters — "the user sees the investigation they just ran" — is met by the mem write alone. The file write is a *bonus* for surviving the dev server restart.

The risk that's accepted: **two dev processes writing the same file** can produce a corrupt JSON (one's write half-overwrites the other's). The mitigation is "you don't run two dev servers at once" — a convention, not a check.

### Move 2 variant — the integrity skeleton

Three load-bearing parts. Strip any one and a real failure mode emerges:

1. **The type guards at the trust boundary** (`validate.ts` + inline checks). Drop these and the LLM's "creative" JSON propagates into the Map — a missing `change.direction` field becomes a runtime `undefined.value` somewhere deep in the UI. The test that pins this is `test/mcp/validate.test.ts` (covers the four required-field validators).

2. **The optional-field discipline on entities** (every added field is `?`). Drop this and the validators reject perfectly good old snapshots the moment you add a new field. The discipline is what lets the guards stay strict on required fields and forgiving on additive ones. Covered in `05`.

3. **The "single writer, synchronous write" convention.** Drop this — say, by making `putInsights` async and `await`-ing between map writes — and you reopen the half-written-state failure mode that databases use transactions to prevent. The Node event loop's synchronous-block guarantee is the substitute for `BEGIN/COMMIT`.

Hardening on top: the AES-GCM tag on the auth cookie is hardening (the cookie *is* tamper-resistant); the four-tier `resolveAnomaly` fallback is hardening (multiple paths to find the same fact).

### Move 3 — the principle

The DB-equivalent of "no schema constraints" isn't "no integrity" — it's "integrity enforced at the trust boundary, not inside the store." Every system that doesn't have a transactional database has to pick *some* layer to enforce its invariants. The choice this repo makes — type guards at the JSON-parse step + single-writer conventions — is defensible *as long as* the inputs are limited (LLM, URL param, JSON file) and the writers are few (one per route). The moment user-generated data lands or concurrent writers show up, the same layer stops being enough — and you're rebuilding `BEGIN/COMMIT` from scratch.

## Primary diagram

The full integrity map: every trust boundary, every guard, every multi-write that skips atomicity on purpose.

```
  Integrity boundaries — every untrusted input, every guard, every multi-write

  ┌─ TRUST BOUNDARIES ──────────────────────────────────────────────────┐
  │                                                                      │
  │  1. LLM output                                                       │
  │     anthropic.messages.create                                        │
  │           │                                                          │
  │           ▼                                                          │
  │     parseAgentJson(text)               ← lexical guard               │
  │     isAnomalyArray(v)                  ← shape guard                 │
  │     isDiagnosis(v)                     ← shape guard                 │
  │     isRecommendationArray(v)           ← shape guard                 │
  │                                                                      │
  │  2. URL params                                                       │
  │     /api/agent ?insight=... ?diagnosis=...                           │
  │           │                                                          │
  │           ▼                                                          │
  │     inline shape checks in resolveAnomaly / parseDiagnosis           │
  │     fail-silent → fall through to next lookup tier                   │
  │                                                                      │
  │  3. JSON files on disk                                               │
  │     demo-*.json · .investigation-cache.json · .auth-cache.json       │
  │           │                                                          │
  │           ▼                                                          │
  │     implicit: optional-field discipline lets old shapes pass         │
  │     (no explicit re-validation on read)                              │
  │                                                                      │
  │  4. Encrypted auth cookie                                            │
  │     bi_auth (production only)                                        │
  │           │                                                          │
  │           ▼                                                          │
  │     AES-256-GCM auth tag verifies ciphertext + key                   │
  │     fail → decryptStore returns {} (no auth)                         │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  ┌─ MULTI-WRITE WITHOUT TRANSACTIONS ──────────────────────────────────┐
  │                                                                      │
  │  putInsights(sid, items, anomalies)                                  │
  │     s.insights.clear()                                               │
  │     s.anomalies.clear()                                              │
  │     forEach: insights.set + anomalies.set                            │
  │                                                                      │
  │     SAFE BECAUSE: synchronous (no await between writes),             │
  │                   single writer per session,                         │
  │                   crash = whole process gone, not partial state      │
  │                                                                      │
  │  saveInvestigation(insightId, events)                                │
  │     mem.set                                                          │
  │     PERSIST: readJson + writeFileSync                                │
  │                                                                      │
  │     SAFE BECAUSE: mem.set is the source of truth for the request;    │
  │                   disk write is best-effort, dev-only                │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The integrity model here is "validation at the door, conventions inside." That's a defensible posture for any system where (a) inputs are well-bounded (no user-generated rows), (b) writers are few and uncoordinated writes are impossible (one client per session, one route per writer), and (c) crashes destroy whole-process state rather than corrupting persistent state. The moment any of those three premises break, you need real transactions and real constraints. In this repo, the only premise that's *close* to breaking is (c) — the dev-mode JSON file *is* persistent state, and two concurrent dev processes would corrupt it. The mitigation is convention ("don't run two dev servers").

The closest analog to the type-guards-as-boundary pattern is **Zod / Yup / io-ts in TypeScript apps** — schema-validation libraries that produce a runtime check AND a TypeScript type from one declaration. This codebase hand-rolls the same idea with `v is X` predicates. The reason not to pull in Zod: the validation surface is *four functions*, and the cost of a runtime dep at every API route's edge would dwarf the win. When the validation surface grows to ten+ shapes, the calculus flips.

For the atomicity story: the closest contrast is buffr's SQLite (where multi-step writes wrap in `BEGIN/COMMIT` because SQLite is a real database with real concurrency). Here, the "transaction" is the synchronous block — and the proof it's enough is that the writes don't `await` anywhere mid-sequence. If you ever added `await` inside `putInsights` (say, to persist to disk), you'd reopen the partial-state window and have to think about it.

## Interview defense

**Q: How do you enforce data integrity without a database?**

> Three layers. First, **type guards at the trust boundary** — `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` in `lib/mcp/validate.ts`. They validate the LLM's JSON output the moment it crosses out of the agent loop. Type predicates (`v is Anomaly[]`) make them runtime gates AND compile-time proofs. Second, **inline shape checks on URL params** in `/api/agent` — same idea, fail-silent so the lookup ladder falls through to the next tier. Third, **the encrypted auth cookie's AES-GCM auth tag** — the one cryptographic integrity check in the codebase.
>
> The thing I lose without a DB: referential integrity across entities. If an `Investigation` references an `insightId` that doesn't exist, nothing catches it. The substitute is the `Investigation` envelope structure — `Diagnosis` literally cannot exist without an `insightId` because it lives inside an `Investigation` object.

```
   integrity layers

   compile-time:      TypeScript types
   run-time gate:     isAnomalyArray / isDiagnosis / isRecommendationArray
   crypto integrity:  AES-GCM auth tag on the auth cookie
   structural:        Diagnosis can't exist outside an Investigation envelope
```

**Q: `putInsights` writes two maps and doesn't wrap them in anything. What if it crashes mid-write?**

> The writes are synchronous — no `await` between `insights.set` and `anomalies.set` in the same iteration. The Node event loop doesn't preempt inside a synchronous block, so there's no interleaving point where a partial state is visible to another request. The failure mode that matters in serverless is the whole instance dying, and when that happens the entire `Map<sessionId, SessionFeed>` is gone — there's no "partial state on disk" to recover.
>
> The day this stops being safe is the day someone makes `putInsights` async — say, to persist to disk between maps. Then you've reopened the partial-state window and need a real transaction.

**Q: What's the load-bearing detail people miss about the type guards?**

> They check **only required fields**. The optional fields on `Anomaly` — `evidence`, `impact`, `history`, `category` — are not validated. That's deliberate, and it pairs with the `?` discipline on every added field: every new entity field is optional so old demo snapshots keep passing the same validator. If the guard rejected snapshots that lacked a newly-added field, the committed demo would break on every release. The forgiveness on optional fields is what lets the schema evolve.

```
   the trade

   required fields → strict (must be present and well-typed)
   optional fields → permissive (absence is allowed, presence is unchecked)

   this is what makes the validator survive schema evolution
```

## See also

- `02-normalization-and-duplication.md` — the "never mutate" convention that makes denormalization safe in the absence of triggers.
- `05-migrations-and-evolution.md` — why every additive field is `?` and what that buys for the validators.
- `06-access-patterns-and-storage-choice.md` — when this integrity layer stops being enough.
