# 02 — Normalization and duplication

**Normalization / single source of truth · Case B (no DB) · information-hiding for data**

## Zoom out — where this concept lives

Normalization is *information-hiding for data*: a fact lives in exactly one place, and everyone who needs it reads from that one place. Duplication is the opposite — the same fact stored twice, editable in two places, drifting silently.

```
  Zoom out — where duplication risk shows up in this repo

  ┌─ Client (browser) ─────────────────────────────────────┐
  │  sessionStorage[bi:insight:{id}]  ← Insight copy #1     │
  │  in-memory hook state             ← Insight copy #2     │
  └────────────────────────┬────────────────────────────────┘
                           │ HTTP
  ┌─ Service ──────────────▼────────────────────────────────┐
  │  Map<sessionId, SessionFeed>                            │
  │    insights:  Insight  ─┐ ← same 4 fields               │
  │                          │   (metric/scope/change/sev)   │
  │    anomalies: Anomaly  ─┘   are in both by design       │
  │                                                          │
  │  ★ THIS FILE ★ — where is the same fact stored twice,   │
  │  where is that OK, and where is it a bug?               │
  │                                                          │
  │  Investigation.diagnosis     ← shape drift vs            │
  │  Diagnosis (types.ts)          same conceptual entity    │
  │                                                          │
  │  Receipt[N] × 10 cases       ← anomaly denormalized      │
  │  eval/receipts/*.json          into every receipt        │
  └──────────────────────────────────────────────────────────┘
```

The question this file answers: **for every fact in this app, is there a single source of truth — and where the fact is copied, is the copy deliberate (a read optimization) or accidental (a bug in waiting)?**

## The structure pass — layers, one axis, seams

Hold one axis constant: **who owns the write for this fact?**

```
  Axis: "which tier is authoritative — and who owns the copy in each other tier?"

  ┌── fact: the current Insight[] for a session ─────────────────┐
  │                                                              │
  │  authoritative   Map<sessionId, SessionFeed>.insights         │
  │                     (tier 2, in-memory server)                │
  │                                                              │
  │       │ read + copy on stream                                 │
  │       ▼                                                       │
  │  DERIVED         sessionStorage[bi:insight:{id}]              │
  │                     (tier 1, browser) — read-only copy        │
  │                                                              │
  │  SEAM: the network. The copy on tier 1 is a cache; if it     │
  │  drifts from tier 2, "stale" — no correctness bug because    │
  │  the next stream replaces it.                                │
  └──────────────────────────────────────────────────────────────┘

  ┌── fact: Insight.evidence ←── Anomaly.evidence ───────────────┐
  │                                                              │
  │  authoritative   Anomaly.evidence (tier 2)                   │
  │  DERIVED         Insight.evidence (tier 2, same map!)         │
  │                                                              │
  │  SEAM: none — same tier, same session, same request. The     │
  │  copy is a *layout* choice, not a persistence choice.        │
  │  Risk: if either is ever mutated independently, drift bug.   │
  └──────────────────────────────────────────────────────────────┘
```

The seam matters: when the copy crosses a tier boundary, it's a **cache** (staleness = OK; next refresh replaces). When the copy stays in the same tier, it's a **layout** decision (drift = correctness bug).

## How it works

### Move 1 — the mental model

You already know this from React: when you `useMemo(() => deriveX(state), [state])`, you're storing a derived copy of `state`. That's fine because React re-runs the memo when `state` changes — the invariant "`derived === deriveX(state)`" is machine-enforced by the reactivity system.

In this app there's no reactivity. Copies are hand-made in code, and the invariant "the copy matches the source" is enforced by **the write shape**: writes only ever *replace* whole entities, never mutate parts of them. That's the whole discipline — it's not a database enforcing referential integrity, it's a coding pattern enforcing "if you change the source, replace the copy too."

```
  The pattern — write-atomicity as the invariant enforcer

    write shape                    invariant it enforces
    ───────────                    ─────────────────────

    putInsights(insights, anom):   Insight[N] and Anomaly[N] always
      s.insights.clear()             cleared and set together — never
      s.anomalies.clear()            just one or the other
      items.forEach((i, idx) => {
        s.insights.set(...)
        if (rawAnom) s.anomalies.set(...)
      })
                                   → drift impossible IF nothing else
                                     mutates either map afterwards
```

The pattern generalizes: **when you can't enforce an invariant with a foreign key, enforce it with the write path.** Every place two facts must stay in sync gets one function that writes both, atomically, and no other write path.

### Move 2 — the specific copies, ranked

Not every copy is a bug. Rank them.

#### Copy 1 (deliberate) — `Insight.evidence` ← `Anomaly.evidence`

Where: `lib/state/insights.ts:25-45`, `anomalyToInsight()`.

The `Insight` returned to the UI carries the same `evidence` array the `Anomaly` had, plus other denormalized fields (`impact`, `history`, `category`, `affectedCustomers`). That's a **read-optimization**: the UI never has to join `Insight` to its `Anomaly` to render the card.

Why it's fine here: the write path (`putInsights`) always writes both, always in the same call, and never mutates them afterward. The invariant "`Insight.evidence` matches `Anomaly.evidence`" is enforced by "nobody ever writes just one."

Verdict: **deliberate denormalization, correctness enforced by the write shape.** Fine.

#### Copy 2 (lossy round-trip) — `insightToAnomaly` drops fields

Where: `lib/state/insights.ts:53-55`.

```typescript
export function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change,
           severity: i.severity, evidence: [] };
}
```

The comment above it (line 47-52) admits it: *"Intentionally drops evidence/impact/history/category — the agent loop only needs metric/scope/change/severity to investigate; the rest is regenerated downstream."*

Why this is a *modeling* decision: the reverse mapper is **not a bijection with the forward mapper**. `anomalyToInsight ∘ insightToAnomaly` loses information. In a database this would be modeled as *"the `Anomaly` table has these 4 required columns and these 4 optional"* — and the loss would be obvious in the schema. In this codebase it's obvious only if you read the comment.

```
  Round-trip lossiness — annotated

  Anomaly (full)                     Insight (denormalized)
  ┌──────────────────┐                ┌──────────────────┐
  │ metric           │──────────────► │ metric           │
  │ scope            │──────────────► │ scope            │
  │ change           │──────────────► │ change           │
  │ severity         │──────────────► │ severity         │
  │ evidence         │──────────────► │ evidence          │
  │ impact           │──────────────► │ impact            │
  │ history          │──────────────► │ history           │
  │ category         │──────────────► │ category          │
  └──────────────────┘                └──────────────────┘

  reverse:  Anomaly'  ◄────────────  Insight
  ┌──────────────────┐    lossy!
  │ metric           │◄─── metric
  │ scope            │◄─── scope
  │ change           │◄─── change
  │ severity         │◄─── severity
  │ evidence: []     │  ← dropped
  │ (no impact)      │  ← dropped
  │ (no history)     │  ← dropped
  │ (no category)    │  ← dropped
  └──────────────────┘
```

Verdict: **intentional, tested (see `test/state/insights.test.ts`), but a source of surprise.** A newcomer reading the code will assume round-trip preserves shape. It doesn't.

#### Copy 3 (shape drift, real risk) — `Investigation.diagnosis` vs `Diagnosis`

Where: `lib/mcp/types.ts:94-104` (canonical `Diagnosis`) and `lib/mcp/types.ts:132-141` (`Investigation.diagnosis`).

Two shapes, same conceptual entity, same file:

```typescript
// The canonical one — the diagnostic agent's output.
export interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: {
    hypothesis: string;
    supported: boolean;
    reasoning: string;
  }[];
  affectedCustomers?: { count: number; segmentDescription: string };
  confidence?: 'high' | 'medium' | 'low';
  timeSeries?: { day: string; value: number }[];
}

// The other one — embedded in Investigation.
export interface Investigation {
  insightId: string;
  reasoning: ReasoningStep[];
  diagnosis: {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: string[];   // ← DIFFERENT SHAPE
  };
  recommendations: Recommendation[];
}
```

`hypothesesConsidered` is `{hypothesis, supported, reasoning}[]` in one place and `string[]` in the other. Same field name, same file, same conceptual entity. That's textbook "same fact editable in two places" — the DB analog of the information leakage red flag.

Verdict: **latent bug in waiting.** If someone edits `Diagnosis.hypothesesConsidered` to add a field, the sibling shape in `Investigation.diagnosis` doesn't change. The two will drift until code that reads one under the wrong assumption panics at runtime.

The fix, when it becomes real:

```typescript
export interface Investigation {
  insightId: string;
  reasoning: ReasoningStep[];
  diagnosis: Diagnosis;         // ← reuse the canonical shape
  recommendations: Recommendation[];
}
```

That's the whole change. Single source of truth for the shape.

#### Copy 4 (deliberate blob) — `Anomaly` denormalized into every `Receipt`

Where: `eval/receipts/*.json`.

Every receipt (~400 lines, 28 committed) carries the full `anomaly` field even though the anomaly comes from the golden case, which is the ground truth for the same case ID. That's ~10 KB duplicated across 28 files = ~280 KB of redundant JSON on disk.

```
  Receipts denormalize the anomaly on purpose

  ┌── eval/goldens/01-conversion-drop-mobile-checkout.ts ─┐
  │  goldenCase.anomaly  ← authoritative                   │
  └───────────────────────┬────────────────────────────────┘
                          │  run.eval.ts copies into every receipt
                          ▼
  ┌── eval/receipts/01-conversion-drop-*-2026-07-03*.json ┐
  │  { "anomaly": {...same shape, copied...}, ... }        │
  │                                                        │
  │  three receipts committed for this one golden case     │
  └────────────────────────────────────────────────────────┘
```

Why it's fine: a receipt is *the whole story of one investigation run*. Opening one file has to show you the anomaly it started from, otherwise you have to cross-reference the golden by hand. The receipt is designed to be *self-contained* — that's an explicit choice, and the disk cost is negligible.

Verdict: **deliberate, and the right call for the artifact's purpose.** The tradeoff is named: disk = cheap, human-review effort = expensive; optimize for the latter.

#### Copy 5 (partial-shape mirror) — `MemoRAG`-style stashing in sessionStorage

Where: `lib/hooks/useInvestigation.ts:54, 76, 135, 141` (`stashKey`, `diagHandoffKey`).

Each investigation step's result is stashed to `sessionStorage` so re-visits / back-nav don't re-fetch. That's a browser-side cache of a server-side fact.

Verdict: **cache, seam-crossing, so staleness only.** Fine — the copy lives on the wrong side of the network from the source, and if it drifts, the worst case is showing yesterday's diagnosis for two seconds before the new one loads.

### Move 3 — the principle

The principle: **when normalization can't be enforced by the storage engine (because there is no storage engine), enforce it by the write shape.** For every fact that appears in two places:

  1. Name the authoritative source.
  2. Make the write path that touches the source *always* touch the copy too, atomically.
  3. Never let another write path touch just the copy.

Where you can't meet those three conditions, the fact will drift. The `Diagnosis` vs `Investigation.diagnosis` drift is real because nothing enforces "if you edit one, edit the other" — they're separately declared, separately imported, separately used.

## Primary diagram — the copy map, ranked

```
  Every copy in this repo — ranked by risk

  ────────────────────────────────────────────────────────────────────
  copy                                    risk         mitigation
  ────────────────────────────────────────────────────────────────────
  Investigation.diagnosis                 HIGH         reuse Diagnosis
    vs Diagnosis (types.ts)                            interface
    ← shape drift, same file

  insightToAnomaly round-trip             MEDIUM       comment + tests
    ← lossy, silent
    (drops evidence/impact/history/                    (better: mark
     category)                                          Anomaly fields
                                                        as required or
                                                        model explicitly)

  Insight.evidence ← Anomaly.evidence     LOW          write-atomicity
    ← same tier, same map                              in putInsights
    (deliberate denormalization)

  sessionStorage[bi:insight:{id}]         LOW          stream re-writes
    ← cache across the network                         on every briefing
    (stale = OK, replaced next stream)

  Receipt.anomaly ← Golden.anomaly        NEGLIGIBLE   disk is cheap;
    ← disk-committed duplication                       self-contained
    (~10 KB per file × 28 files)                       receipt is worth
                                                        the redundancy
  ────────────────────────────────────────────────────────────────────
```

## Elaborate

Where the pattern comes from: this is the DB analog of the *information hiding* rule from *A Philosophy of Software Design* (Ousterhout, ch. 5). In a schema, information hiding = normalization: put a fact in one column of one table, and every query reaches through the row to read it. In this codebase, there's no row — but the rule still applies. Every fact should have one *declaration site*, and every consumer should reach through a type import to read it. The `Diagnosis` case violates the rule because the fact has two declaration sites.

Related pattern: *derived fields as first-class members* (from Fowler's PoEAA — "Derived Property"). `Insight.affectedCustomers` is a derived field (denormalized from `Diagnosis.affectedCustomers.count`); the honest thing is to mark it with a comment saying so, which the code does (`lib/mcp/types.ts:58`). When derived fields drift, the fix isn't to remove the field — it's to move the derivation into a `deriveInsightFields()` helper that runs every time. `lib/insights/derive.ts` does exactly this for a subset of them.

## Interview defense

### Q1 — "you have `Insight` and `Anomaly` with overlapping fields. Isn't that a smell?"

> It's a deliberate denormalization — a read-optimized `Insight` that carries the render-ready copy of `Anomaly`'s core fields. The invariant "they don't drift" is enforced by the write path: `putInsights` clears both maps and rewrites both together, atomically, and nothing else writes to either. There's no partial-update path, so drift can't happen.
>
> The one real smell in this space is *`Investigation.diagnosis` vs `Diagnosis`* — two shapes for the same conceptual entity, same file, `hypothesesConsidered` typed differently in each. That one's a bug in waiting; I'd fix it by reusing the `Diagnosis` interface in `Investigation`.

```
  the ranked answer

  ┌── deliberate: Insight ↔ Anomaly ──┐   OK — write-atomicity
  │  same tier, atomic write path      │   enforces invariant
  └────────────────────────────────────┘

  ┌── smell: Investigation.diagnosis ──┐   real drift risk —
  │  vs Diagnosis (two shapes)         │   two declaration sites
  └────────────────────────────────────┘   for one fact
```

Anchor: "atomic write path = the DB constraint substitute."

### Q2 — "`insightToAnomaly` drops fields. Why isn't that a bug?"

> It's intentional and tested. The comment names it (`lib/state/insights.ts:47-52`) and there's a round-trip test in `test/state/insights.test.ts`. The reason it works: the reverse mapper is used exactly one place — the agent loop, which only needs the four required fields (metric, scope, change, severity) to open an investigation. The dropped fields (evidence, impact, history, category) are *regenerated* downstream by the diagnostic and recommendation agents.
>
> That said, it's still surprising. A cleaner model would split `Anomaly` into `MinimalAnomaly` (the 4 required fields, what the agent needs) and `EnrichedAnomaly extends MinimalAnomaly` (what the monitoring agent emits). Then `insightToAnomaly` returns `MinimalAnomaly` and the type system makes the loss explicit.

Anchor: "lossy round-trip, tested + commented, but a modeling improvement is available."

### Q3 — "if you added a `favorites` feature (users can favorite an insight, favorites survive a session), how would you extend the model?"

> That's the question that breaks the tier lattice. Favorites need to survive the session cookie's ~10-day lifetime and follow the user across devices. Tier 2 (in-memory Map) dies too fast; tier 3 (bi_auth cookie) is per-browser; tier 5 (git-committed) is engineer-write-only. So I'd need a new tier — a real database.
>
> The minimal shape: a `Favorite` table with `(userId, insightId, createdAt)`, unique on `(userId, insightId)`. `insightId` becomes a *durable identifier*, which means Insight can't be UUID-per-session anymore — it needs a stable ID scheme (probably `hash(metric + scope + baseline)` so the same anomaly re-firing on Tuesday points at the same favorite from Monday).
>
> That's the modeling change that's actually load-bearing: **once a fact has to survive the session, it needs a stable key that isn't a random UUID.** The current UUID scheme is a shortcut that works only because nothing outlives the session.

```
  the model change forced by "favorites"

  today:   Insight.id = randomUUID()     ← ok, session-scoped
             ↑ unstable across sessions

  needed:  Insight.stableKey =
             hash(metric + scope + baseline)   ← survives session boundary

  Favorite table:
    userId       string   FK → User
    insightKey   string   FK → Insight.stableKey
    createdAt    datetime
    UNIQUE (userId, insightKey)
```

Anchor: "durable identifiers are the first thing that breaks when you add persistence."

## See also

- `01-the-data-model-and-its-shape.md` — the ERD showing where each copy lives.
- `04-transactions-and-integrity.md` — how the write-atomicity discipline in `putInsights` is a stand-in for DB transactions.
- `05-migrations-and-evolution.md` — why optional-fields-as-forward-compat lets denormalized copies survive schema growth.
- `07-data-modeling-red-flags-audit.md` — the `Diagnosis` vs `Investigation.diagnosis` finding is marked here.
