# Data-modeling red-flags audit

*Consolidated checklist (industry standard) · Project-specific*

## Zoom out, then zoom in

The previous six files walked the model concept-by-concept. This one is the capstone: the canonical data-modeling red flags, each scored against this codebase. The format is intentionally blunt — green / yellow / red, with a one-line verdict and a pointer to where in the codebase the answer lives.

```
  Zoom out — what an audit looks like across the stack

  ┌─ UI layer ─────────────────────────────────────────┐
  │  reads: cards, panels, recommendations             │
  │  flags audited here: bidirectional facts (none)    │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────────┐
  │  flags audited here:                                │
  │   • multi-write without transactions                │
  │   • N+1 patterns on the read path                   │
  │   • integrity enforced only in app code             │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Storage layer ────────▼───────────────────────────┐
  │  ★ THE AUDIT TARGET ★                                │ ← we are here
  │  flags audited here:                                 │
  │   • no discernible model (everything in one blob)    │
  │   • the same fact editable in two places             │
  │   • frequent query with no supporting index          │
  │   • destructive migration with no rollback           │
  │   • schema shape vs access shape mismatch            │
  └─────────────────────────────────────────────────────┘
```

**Zoom in.** Seven flags from the spec, scored. The headline: **the biggest risk in this repo isn't IN the data model — it's the absence of one when the product grows beyond demo + briefing-scoped data.** Everything else is well-contained for what the product is today.

## Structure pass

**Layers.** Three altitudes of severity:

- **Green** — the flag genuinely doesn't apply, or the codebase's substitute is appropriate to its scale and context.
- **Yellow** — the flag applies in a bounded way; the mitigation is convention-only, and the right-time-to-revisit is the day the convention breaks.
- **Red** — the flag is live and would burn engineering time if hit today.

**Axis traced — "how bounded is the risk?"** Hold that across the seven flags:

```
  Trace the bounded-vs-unbounded axis through the flags

  green flags:   risk is bounded by product shape
                 (data has no users, no concurrent writers, no
                  cross-session queries)

  yellow flags:  risk is bounded by convention
                 (single writer per route, never mutate entities,
                  recapture demo on breaking changes)

  red flags:     risk is unbounded — would compound with use
                 (would still hurt even at today's scale)
```

For this codebase, zero red, four yellow, three green. Detail below.

## How it works

### Move 1 — the mental model

Score each flag against three questions: *does it apply here?* (no → green); *if yes, is the mitigation a runtime guard or a convention?* (guard → less risk, convention → bounded risk); *what's the failure mode if the mitigation breaks?*

```
  The audit kernel — three questions per flag

   flag → does it apply here?
            │
            ├── NO  → GREEN  (record why it doesn't apply)
            │
            └── YES → what mitigates it?
                          │
                          ├── runtime guard → YELLOW (lower-risk)
                          ├── convention    → YELLOW (bounded risk)
                          └── nothing       → RED
```

### Move 2 — the seven flags, walked

#### Flag 1 — "no discernible model (everything in one JSON blob / one table)"

**Verdict: GREEN.** The model is explicit — five named entities (`WorkspaceSchema`, `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`) plus the discriminated union (`AgentEvent`). Lives in `lib/mcp/types.ts:36-142` and `lib/mcp/events.ts:4-12`. Every entity has a defined shape, defined relationships (`Insight.id` is the join key), and a defined lifecycle.

```
  Flag 1 — discernible model? YES

  five named entities + one envelope:
     WorkspaceSchema · Insight · Anomaly · Diagnosis · Recommendation
                                 ↑
                                 │ Insight.id is the join key
                          AgentEvent (8-variant discriminated union)

  → covered in 01-the-data-model-and-its-shape.md
```

**Where to look:** `lib/mcp/types.ts:36-142`. The types ARE the schema; reading the file gives you the model in one scroll.

**What would flip this to yellow:** packing two unrelated entities into the same shape ("Insight" growing to absorb Diagnosis fields rather than the Investigation envelope wrapping them). Not happening today.

#### Flag 2 — "the same fact editable in two places (DB analog of information leakage)"

**Verdict: YELLOW, bounded by convention.** Three duplications exist (covered in `02-normalization-and-duplication.md`): four shared fields between `Anomaly` and `Insight`, `Diagnosis.affectedCustomers.count` denormalized onto `Insight`, and `Anomaly.history` carried onto `Insight`. **The "editable in two places" risk is mitigated by the "never mutate entities" convention.**

```
  Flag 2 — same fact in two places? YES, three times

  Anomaly ⊂ Insight        4 shared fields (raw → enriched)
  Diagnosis → Insight      affectedCustomers.count denormalized
  Anomaly → Insight        history copied wholesale

  mitigation: NEVER MUTATE — convention, not enforced
       writes are bulk-replace at end-of-run, not in-place edits
       round-trip test (test/state/insights.test.ts:104-130)
       pins reference-equality and intentional drops

  → covered in 02-normalization-and-duplication.md
```

**Where to look:** `lib/state/insights.ts:25-55` (the copy point); `test/state/insights.test.ts:104-130` (the round-trip pins).

**What would flip this to red:** adding an "edit this insight" feature (annotation, dismissal). The moment a user mutates an Insight, the copy from Anomaly drifts, and there's nothing on the write side to keep them in sync.

#### Flag 3 — "a frequent query with no supporting index"

**Verdict: GREEN.** Every read in the codebase is a `Map.get(id)` — O(1), primary-key-indexed by definition. Covered in `03-indexing-vs-query-patterns.md`. The one O(N) — `.find()` over the demo snapshot's `insights[]` — is a fallback tier hit only when the warm instance has no memory of the requested id, and N is 5.

```
  Flag 3 — frequent query with no index? NO

  every "query":
     listInsights(sid)              → 1 Map.get + .values()
     getAnomaly(sid, id)            → 2 Map.get (nested)
     getInsight(sid, id)            → 2 Map.get (nested)
     getCachedInvestigation(id)     → 1 Map.get
     bootstrapSchema()              → 1 variable check
     resolveAnomaly tier 4 (cold)   → 1 file read + .find() over 5

  → covered in 03-indexing-vs-query-patterns.md
```

**Where to look:** every `getX` function in `lib/state/insights.ts` and `lib/state/investigations.ts`.

**What would flip this to red:** a product ask for a secondary query — "show me all critical insights from the last 7 days." No index supports that today; satisfying it would require either a new `Map<severity, Set<id>>` per session (cheap, ugly) or moving to a real store.

#### Flag 4 — "a loop issuing one query per row (N+1)"

**Verdict: GREEN.** No N+1 patterns on the read path. The feed render reads `listInsights(sid)` once (one lookup, returns the whole list). The investigate page reads one Investigation by id. The cards on the feed do NOT call back per-card to load anything — every field rendered is already on the `Insight` (including the denormalized `affectedCustomers`, covered in `02`). The denormalization is *what prevents* the N+1: each card has everything it needs without joining.

```
  Flag 4 — N+1 query pattern? NO

  feed render:                    no per-card lookup
     listInsights(sid)            → 1 read
     for card of cards:           → 0 reads, all data in card
        render(card)

  detail page:                    one read, render the tree
     getCachedInvestigation(id)   → 1 read
     render(diagnosis + recs)     → 0 reads, all in the tree

  the denormalization on Insight is what prevents N+1
```

**Where to look:** `app/page.tsx` (no per-card loaders); `app/investigate/[id]/page.tsx` (one investigation load).

**What would flip this to yellow:** a card-level "load details on hover" feature where each card kicks off an investigation lookup — that's an N+1 in the making and would be a Suspense / batching problem.

#### Flag 5 — "a multi-write operation with no transaction"

**Verdict: YELLOW, bounded by single-writer + synchronous-write conventions.** Two multi-writes exist (covered in `04-transactions-and-integrity.md`):

- `putInsights` writes both `insights` and `anomalies` maps. Safe because the writes are *synchronous* (no `await` between them) and there's *one writer per session* (only `/api/briefing` calls it).
- `saveInvestigation` writes both in-memory and to disk in dev. Safe because the disk write is best-effort and the in-memory write is the source of truth for the request.

```
  Flag 5 — multi-write with no transaction? YES, two of them

  putInsights(sid, items, anomalies)
     s.insights.clear()
     s.anomalies.clear()
     forEach: insights.set + anomalies.set
     ─────────────────────────────────
     mitigation: synchronous (no await), single writer per session,
                 partial-state failure mode = whole process dies

  saveInvestigation(id, events)
     mem.set + (PERSIST: writeFileSync)
     ─────────────────────────────────
     mitigation: mem is source of truth; file write is best-effort
                 dev-only convention

  → covered in 04-transactions-and-integrity.md
```

**Where to look:** `lib/state/insights.ts:57-71`; `lib/state/investigations.ts:30-41`.

**What would flip this to red:** making either function async with an `await` *between* the writes. The synchronous-block guarantee is what stands in for `BEGIN/COMMIT`; adding an await opens the partial-state window.

#### Flag 6 — "an invariant enforced only in app code the DB doesn't guard"

**Verdict: YELLOW, by design — there's no DB, so app code is the only layer.** Every integrity constraint in this codebase is in TypeScript types and runtime type guards (covered in `04-transactions-and-integrity.md`):

- `bloomreachFeature: 'scenario' | 'segment' | …` — closed enum, compile-time enforced
- `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` — runtime gates at the LLM boundary
- Inline shape checks in `resolveAnomaly` and `parseDiagnosis` — runtime gates at URL params
- AES-GCM auth tag — the only *cryptographic* integrity check, on the OAuth cookie

```
  Flag 6 — invariant only in app code? YES, by design

  compile-time invariants:    TypeScript types (rejected at build)
  runtime invariants:         type guards in lib/mcp/validate.ts
  cryptographic invariants:   AES-GCM auth tag on bi_auth cookie

  what's NOT enforced:
     referential integrity (no FKs)
     uniqueness across sessions (no UNIQUE constraint)
     value ranges (no CHECK constraint)
     not-null on optional fields (Anomaly.evidence can be missing
                                  on old snapshots)

  → covered in 04-transactions-and-integrity.md
```

**Where to look:** `lib/mcp/validate.ts:17-57`; `app/api/agent/route.ts:35-95`.

**What would flip this to red:** a feature where two requests can produce conflicting state (e.g. two clients editing the same Insight). The app-code-only layer has no mechanism to detect or resolve the conflict.

#### Flag 7 — "a destructive migration with no rollback" / "column drop with no backfill plan"

**Verdict: GREEN — no migrations exist.** Covered in `05-migrations-and-evolution.md`. Schema evolution happens by additive-only changes (every new field is `?`) and dual-shape acceptance for shape changes (`EstimatedImpact = string | { range; ... }`). Breaking changes force a *recapture* of the committed demo snapshot via the dev-only `/api/mcp/capture-demo` route — and that recapture is the entire migration story.

There's nothing to roll back because there's nothing to migrate.

```
  Flag 7 — destructive migration? N/A

  no migration framework exists
  evolution = optional-field discipline + dual-shape acceptance
  breaking change = recapture demo snapshot (not "migrate")

  → covered in 05-migrations-and-evolution.md
```

**Where to look:** `lib/mcp/types.ts:54-62` (optional-field comment); `lib/insights/derive.ts:4-9` (the normalizer pattern).

**What would flip this to red:** adding user-owned data. The day a user's saved annotation has to survive a release, the optional-field discipline isn't enough — you need a real migration framework, and the day-one migration risks are real (destructive `DROP COLUMN`, lossy renames, partial-deploy column-not-found errors).

### Move 2 — additional flags worth scoring (project-specific)

These aren't in the spec's seven, but they're load-bearing for this codebase.

#### Flag 8 — "module-level singleton cache with no key for multi-tenancy"

**Verdict: YELLOW, bounded by env-pinned single-project assumption.** `let cached: WorkspaceSchema | null = null` (`lib/mcp/schema.ts:138`) caches the WorkspaceSchema process-wide, no session key. Today it's safe because `BLOOMREACH_PROJECT_ID` (env-pinned, line 180) means one project per deployment. The day you serve two projects from one process, this singleton becomes a cross-tenant bug — instance A bootstraps project X, then a request for project Y comes in, gets project X's schema, and the monitoring agent runs the wrong prompt against the wrong workspace.

**Where to look:** `lib/mcp/schema.ts:138, 180-191`.

**What would flip this to red:** any feature that lets a user pick which project to analyze, OR any deployment that serves multiple Bloomreach projects from one Vercel project.

#### Flag 9 — "cross-session shared mutable state (the investigation cache)"

**Verdict: YELLOW, intentional but worth knowing.** `Map<insightId, AgentEvent[]>` in `lib/state/investigations.ts:11` is process-wide, not session-scoped. Two sessions investigating the same insight id share the cached result. **Safe today** because (a) insight bodies are anonymous Bloomreach analytics, no PII, and (b) the investigation result is deterministic enough that one user's run is fine for another.

The flag is here so the convention is named: *the cache is process-wide on purpose; if insights ever carry user-specific context, the cache key has to grow.*

**Where to look:** `lib/state/investigations.ts:11, 22-28`.

**What would flip this to red:** insights gaining user-specific context (e.g. "this is YOUR conversion drop, segmented by YOUR campaigns") where the cached investigation from another session would leak or be wrong.

### Move 2 variant — the audit skeleton

The skeleton of this audit is three parts:

1. **The seven canonical flags from the spec** — score green/yellow/red, with a pointer to the file in this guide that covers the detail.
2. **The project-specific flags** — flags this codebase has that the canonical seven don't cover. The singleton schema cache and the cross-session investigation cache are the load-bearing ones.
3. **The trigger conditions** — for every yellow, *what flips it to red*. This is the audit's forward-looking value: instead of "this is fine," "this is fine until X happens, then it isn't."

Drop part 3 and the audit becomes a snapshot — true today, useless tomorrow. The trigger conditions are what make the audit a planning document.

### Move 3 — the principle

A data-modeling audit isn't pass/fail. It's a map of which risks the codebase has accepted, which ones it has mitigated by convention, and which conventions are load-bearing. The right time to revisit each flag is named by the trigger condition — and the audit is most useful as a forward-looking checklist (what will break this) rather than a backward-looking grade (how good is this).

## Primary diagram

The full audit, one frame.

```
  Data-modeling red-flag audit — blooming insights

  ┌─ FLAG ──────────────────────────────────────┬─ VERDICT ─┬─ WHERE ────┐
  │                                              │            │             │
  │ 1. No discernible model                      │  GREEN     │ types.ts    │
  │    (everything in one JSON blob)             │            │ events.ts   │
  │                                              │            │ → see 01    │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 2. Same fact editable in two places          │  YELLOW    │ insights.ts │
  │    (denormalization without write-time sync) │  bounded   │ → see 02    │
  │                                              │  by "never │             │
  │                                              │   mutate"  │             │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 3. Frequent query with no supporting index   │  GREEN     │ every       │
  │    (unindexed scan on hot path)              │            │  Map.get    │
  │                                              │            │ → see 03    │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 4. N+1 query pattern                         │  GREEN     │ page.tsx    │
  │    (loop issuing one query per row)          │            │ → see 03    │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 5. Multi-write with no transaction           │  YELLOW    │ insights.ts │
  │    (atomicity skipped)                       │  bounded   │ investiga…  │
  │                                              │  by sync + │ → see 04    │
  │                                              │  single-   │             │
  │                                              │  writer    │             │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 6. Invariant only in app code                │  YELLOW    │ validate.ts │
  │    (no DB to guard)                          │  by design │ → see 04    │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 7. Destructive migration with no rollback    │  GREEN     │ no migra-   │
  │    (column drop, no backfill)                │  N/A       │ tions exist │
  │                                              │            │ → see 05    │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 8. Module-level singleton cache, no tenant   │  YELLOW    │ schema.ts   │
  │    key (project-specific flag)               │  bounded   │ :138        │
  │                                              │  by env    │ → see 06    │
  │                                              │  pin       │             │
  ├──────────────────────────────────────────────┼────────────┼─────────────┤
  │ 9. Cross-session shared mutable state        │  YELLOW    │ investiga…  │
  │    (project-specific flag)                   │  by design │ tions.ts:11 │
  │                                              │            │ → see 06    │
  └──────────────────────────────────────────────┴────────────┴─────────────┘

  HEADLINE:
   0 RED · 5 YELLOW · 4 GREEN
   Every yellow is convention-bounded. The trigger that flips ANY of
   them to red is the same: "the day this app gets users with data
   that has to survive a release." Until then, the model is correctly
   simple.
```

## Elaborate

Audit-style grades like this only mean something when they name the *trigger condition*. "YELLOW, bounded by convention" is half the answer; "the convention is broken the day someone adds an await between two writes" is the rest of it. A pure red/yellow/green table reads like a verdict; a trigger-condition table reads like a checklist for the next release.

The shape of the audit findings — *zero red, five yellow, four green, every yellow has a single named trigger* — is consistent with a system that picked the right complexity ceiling for its product stage. The same audit on a system that had outgrown its choices would show reds: the unindexed scan that's already slow, the multi-write that's already corrupting state, the migration that's already destructive. The absence of reds isn't proof the model is bulletproof — it's proof the model matches the current access pattern. The risk lives in the trigger conditions, not in the present state.

The closest portfolio analog is the dryrun project: its data lives in Git (GitHub-as-backend), and a similar audit would score zero red, multiple yellow, with triggers like "the day two users write to the same file at the same time." Same shape of finding: bounded today, planned trigger conditions.

## Interview defense

**Q: Walk me through the data-modeling risk profile.**

> Zero red, five yellow, four green. The yellows are all *convention-bounded* — denormalization safe because nothing mutates entities; multi-write safe because writes are synchronous and there's one writer per session; integrity safe because type guards at the JSON-parse boundary catch malformed input; singleton schema cache safe because there's one Bloomreach project per deployment; cross-session investigation cache safe because insight bodies have no PII.
>
> The greens are real wins: an explicit named entity model (five entities + one envelope), point-lookup-only access (no unindexed scans, no N+1), and no migrations because there's no schema-versioned long-lived data.
>
> The biggest risk isn't IN the data model — it's the absence of a migration framework when the product grows beyond "the demo snapshot is the only long-lived artifact." The day a user saves an annotation, every yellow needs revisiting and the migration story has to land.

```
   risk shape

   ┌─ green flags (4) ──┐  ┌─ yellow flags (5) ──┐  ┌─ red flags (0) ──┐
   │  discernible model │  │ denormalization w/  │  │     (none)        │
   │  no unindexed scan │  │  convention sync    │  │                   │
   │  no N+1            │  │ multi-write w/ sync │  │                   │
   │  no migrations     │  │ app-code integrity  │  │                   │
   │                    │  │ singleton cache     │  │                   │
   │                    │  │ cross-session memo  │  │                   │
   └────────────────────┘  └─────────────────────┘  └───────────────────┘
```

**Q: What's the single change you'd push back on hardest?**

> Adding an "edit this insight" feature without a real database. That's the single trigger that flips three yellows to red at once: the denormalization between Anomaly and Insight starts drifting (no in-place sync), the synchronous-write convention can't hold under user-initiated writes, and the integrity-by-type-guard layer has nothing to enforce "two users can't edit the same row at the same time." The right move there is to land Postgres (or KV) first, then ship the feature.

**Q: What's the load-bearing detail people miss when looking at this audit?**

> The trigger conditions, not the verdicts. "YELLOW, bounded by convention" sounds like fine; the load-bearing part is *which convention* and *what breaks the convention*. For the multi-write yellow, the convention is "no `await` between map writes in `putInsights`"; that's one line of code away from breaking. For the singleton schema cache, the convention is "one project per deployment"; that's one env var away from breaking. The audit is most useful as a watch-list for those specific trigger conditions, not as a grade.

## See also

- `01-the-data-model-and-its-shape.md` — flag 1 evidence (named entities).
- `02-normalization-and-duplication.md` — flag 2 detail (the three denormalizations).
- `03-indexing-vs-query-patterns.md` — flags 3 and 4 (indexes and N+1).
- `04-transactions-and-integrity.md` — flags 5 and 6 (multi-write and app-code integrity).
- `05-migrations-and-evolution.md` — flag 7 (no migrations, by design).
- `06-access-patterns-and-storage-choice.md` — flags 8 and 9 (cache scoping, multi-tenancy).
