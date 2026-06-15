# Design refactor — colocate `insightToAnomaly` with `anomalyToInsight`

> Source: `.aipe/audits/design-2026-06-14.md` Lens 1 finding 1.2 / Lens 3 finding 3.1 (information leakage, fires red-flag #2).
> Cross-ref: `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` (12-day comprehension walk).
> Cross-ref: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-later #6.

---

## What to refactor

The `Insight ↔ Anomaly` field-copy decision lives in three places that have to be edited together when the schema changes — and TypeScript only catches one of them:

- `lib/mcp/types.ts` — the `Anomaly` and `Insight` interfaces (truth source).
- `lib/state/insights.ts:25-45` — `anomalyToInsight(a: Anomaly): Insight` (8-field copy + `deriveInsightFields` spread).
- `app/api/agent/route.ts:30-32` — `insightToAnomaly(i: Insight): Anomaly` (4-field copy, **silently drops** `evidence`, `impact`, `history`, `category`).

The round-trip `insight → anomaly → insight` loses four fields silently. Add a new field to `Anomaly` and TypeScript catches case (1) at compile time but NOT cases (2) or (3) — the mappers go on copying the old field set, the new field shows up in the type but never lands in the converted object, and the only signal is a runtime "wait, why is impact empty?" question from a user months later.

Move `insightToAnomaly` from `app/api/agent/route.ts` to `lib/state/insights.ts` next to `anomalyToInsight`. Both mappers live in one file. Add a round-trip test pinning which fields are intentional to drop (today: all four — evidence/impact/history/category — are dropped on the insight→anomaly side because the agent loop only needs the metric/scope/change/severity to investigate; the rest is generated downstream).

---

## Why

Three reasons, in order of leverage:

1. **AOSD red flag #2 (information leakage) fires here directly.** The 12-day study named this as the worst hide-violation in the codebase. The test for "is this leaking?" is: search for the secret; count files. Here the "secret" is "what fields are in the Insight↔Anomaly mapping" — and three files match (`grep -nE "metric|scope|change|severity" lib/mcp/types.ts lib/state/insights.ts app/api/agent/route.ts`). Two files would be the right number (the interface + the mappers). Three is the leak.

2. **The 4 silently-dropped fields are a real bug-class waiting to fire.** Today the round-trip happens only at one site (`app/api/agent/route.ts:43, 52, 57` — three places `insightToAnomaly` is called when the agent needs to re-investigate from a `?insight=` query-param or cached insight). The agent doesn't need `evidence/impact/history/category` to do its work, so the drop is currently harmless. But the drop is **not documented as intentional** — there's no comment at `insightToAnomaly` explaining the four-field choice. The next person to add a field to `Anomaly` won't know the mapper exists.

3. **Colocation is the cheap fix; id-only wire is the deep fix.** This stub is the cheap fix (move the function, add a test, document the intentional drops). The deeper fix — change the wire format so `/api/agent` accepts only the insight id and looks up the cached anomaly server-side — is a feature change (the client has to stop passing `?insight=...`; the server has to handle the cache-miss path), which is out of scope for a refactor stub. The cleanup audit notes this same split (`fix-later #6`'s "Cheap version" vs "Deeper version").

---

## Refactor type

**Move Function** (the primary move — `insightToAnomaly` migrates from route to lib) + **Locality of Behaviour** (the principle — code that changes together should live together).

Not Extract Function (the function already exists; this is moving it). Not Introduce Adapter (the two functions ARE the adapter; they're just spread across two files). Not DRY (the two functions aren't duplicated logic; they're a forward + reverse pair that share a schema dependency).

---

## Current structure

```
  lib/mcp/types.ts                    ← truth source
  ┌──────────────────────────────────┐
  │ interface Anomaly { metric;       │
  │   scope; change; severity;        │
  │   evidence; impact; history;      │
  │   category; }                     │
  │ interface Insight { id; ts;       │
  │   severity; headline; summary;    │
  │   metric; change; scope; source;  │
  │   evidence; impact; history;      │
  │   category; ...derived; }         │
  └──────────────────────────────────┘
              │  schema referenced by:
              ▼
  ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
  │ lib/state/insights.ts:25-45       │    │ app/api/agent/route.ts:30-32      │
  │                                   │    │                                   │
  │ anomalyToInsight(a: Anomaly):     │    │ insightToAnomaly(i: Insight):     │
  │   Insight                         │    │   Anomaly                         │
  │                                   │    │                                   │
  │ // copies 8 fields:               │    │ // copies 4 fields:               │
  │ metric, scope, change, severity,  │    │ metric, scope, change, severity   │
  │ evidence, impact, history,        │    │                                   │
  │ category                          │    │ // silently drops:                │
  │                                   │    │ // evidence, impact, history,     │
  │ + deriveInsightFields(a)          │    │ // category                       │
  │                                   │    │                                   │
  │ + generated: id, timestamp,       │    │ + sets evidence: []               │
  │   headline, summary, source       │    │                                   │
  └──────────────────────────────────┘    └──────────────────────────────────┘
                                                      │ called from:
                                                      ▼
                                          ┌──────────────────────────────────┐
                                          │ app/api/agent/route.ts:43, 52, 57 │
                                          │ resolveAnomaly() — three branches │
                                          │ all call insightToAnomaly()       │
                                          └──────────────────────────────────┘
```

The two converters are forward + reverse of the same decision; one is in `lib/`, the other is in `app/`. Add a field to `Anomaly`; remember to update `anomalyToInsight` (TS will help if it's a required field), **forget** to update `insightToAnomaly` (TS won't catch this because the function's return value is `Anomaly` and the missing field defaults to the interface's optional-or-undefined behavior, or — if required — the function won't even compile but the error message points at `app/api/agent/route.ts`, not at the schema source).

---

## Target structure

```
  lib/mcp/types.ts (unchanged)
                  │
                  ▼
  ┌──────────────────────────────────────────────────────────┐
  │ lib/state/insights.ts                                     │
  │                                                           │
  │ anomalyToInsight(a: Anomaly): Insight { ... }            │
  │                                                           │
  │ /** Reverse mapper. Intentionally drops evidence /        │
  │  *  impact / history / category — the agent loop only     │
  │  *  needs metric/scope/change/severity to investigate;    │
  │  *  the rest is regenerated downstream. The dropped       │
  │  *  fields are tested in test/state/insights.test.ts. */  │
  │ insightToAnomaly(i: Insight): Anomaly { ... }            │
  └──────────────────────────────────────────────────────────┘
                  │  imported by:
                  ▼
  ┌──────────────────────────────────────────────────────────┐
  │ app/api/agent/route.ts                                    │
  │                                                           │
  │ import { insightToAnomaly } from '@/lib/state/insights';  │
  │                                                           │
  │ // resolveAnomaly()'s three branches now call the         │
  │ // colocated function; route.ts no longer carries the     │
  │ // mapping decision.                                      │
  └──────────────────────────────────────────────────────────┘

  test/state/insights.test.ts (NEW or extended)
  ┌──────────────────────────────────────────────────────────┐
  │ describe('Insight ↔ Anomaly round-trip', () => {         │
  │   it('preserves metric, scope, change, severity', ...);  │
  │   it('intentionally drops evidence on insight→anomaly',  │
  │      ...);                                                │
  │   it('intentionally drops impact on insight→anomaly',    │
  │      ...);                                                │
  │   it('intentionally drops history on insight→anomaly',   │
  │      ...);                                                │
  │   it('intentionally drops category on insight→anomaly',  │
  │      ...);                                                │
  │ });                                                       │
  └──────────────────────────────────────────────────────────┘
```

End state: one file owns the mapping decision; one comment documents the intentional drops; one test pins the contract so the next schema change has a forcing function.

---

## Must not change

- The signatures of `anomalyToInsight` and `insightToAnomaly` — same input type, same output type.
- The fields each function copies — `anomalyToInsight` still copies its 8 fields + derives; `insightToAnomaly` still copies its 4 fields and **still intentionally drops** evidence/impact/history/category. This stub is colocation + documentation + a contract test, NOT a field-set change.
- The three call sites in `app/api/agent/route.ts:43, 52, 57` — same return value, same `resolveAnomaly` shape; the only diff is an import statement at the top of the file.
- The wire format — the agent route still accepts `?insight=...` JSON query params and still falls back to `getAnomaly` / `getInsight` / demo snapshot. The deeper "id-only wire" fix is out of scope.
- Do not touch `lib/insights/derive.ts` (`deriveInsightFields`). It is consumed by `anomalyToInsight` and the consumption is unchanged.
- Do not touch the existing `test/state/insights.test.ts` file if it exists — extend it; do not replace it.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond the comment block and the test file. Do not invent an `InsightAnomalyMapper` class; do not introduce a "mappers" subdirectory; do not generalize to "a generic schema-pair mapper."
- No additional refactors discovered along the way — if the executor session notices that `anomalyToInsight`'s `deriveInsightFields` spread could itself be moved, that's a separate finding and a separate spec. Do not fold it in.
- Do not change the demo-snapshot file format (`.demo-snapshot.json`). The mapping happens at runtime; the snapshot is the persisted form of `Insight[]` and stays that way.

---

## Done when

- `insightToAnomaly` is exported from `lib/state/insights.ts` and removed from `app/api/agent/route.ts`.
- `app/api/agent/route.ts` imports `insightToAnomaly` (and the existing `getAnomaly` / `getInsight`) from `@/lib/state/insights`.
- A comment above `insightToAnomaly` in `lib/state/insights.ts` names the four intentionally-dropped fields and points to the test file as the contract.
- `test/state/insights.test.ts` (extended or created) carries at least 5 round-trip cases: 1 for the four preserved fields, 1 each for the four intentionally-dropped fields.
- All existing Vitest tests still pass (`npm test` — 183 + the new 5 round-trip cases).
- `grep -n "insightToAnomaly" app/api/agent/route.ts` shows only `import` + call sites; the function definition lives only in `lib/state/insights.ts`.
- A quick smoke test: run the demo replay (`/api/agent?insightId=...&insight={...}`) — same NDJSON event stream as before the move.
