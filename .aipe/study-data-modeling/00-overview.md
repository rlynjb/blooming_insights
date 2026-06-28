# Overview — the data shapes in this repo

One page. Every place persistent or quasi-persistent data lives in
**blooming_insights**, drawn from the actual code.

## The whole picture, one diagram

```
  blooming_insights — every place data lives

  ┌─ Browser ────────────────────────────────────────────────┐
  │  localStorage 'bi:mode'      (demo | live-bloomreach |    │
  │                               live-synthetic)             │
  │  sessionStorage 'inv:<id>'   (one investigation per key,  │
  │                               survives StrictMode rerun)  │
  └─────────────────┬────────────────────────────────────────┘
                    │  fetch — NDJSON stream
                    ▼
  ┌─ Next.js route handler (Vercel, serverless) ─────────────┐
  │  Cookie: bi_session = uuid    (httpOnly, SameSite=None)   │
  │  Cookie: bi_auth = AES-256-GCM encrypted OAuth tokens     │
  │         (prod only — AsyncLocalStorage in request scope)  │
  └─────────────────┬────────────────────────────────────────┘
                    │
  ┌─ Module state (per warm Vercel instance) ────────────────┐
  │  lib/state/insights.ts                                    │
  │    Map<sessionId, SessionFeed>                            │
  │      ├─ insights:       Map<insightId, Insight>           │
  │      ├─ investigations: Map<insightId, Investigation>     │
  │      └─ anomalies:      Map<insightId, Anomaly>           │
  │                                                           │
  │  lib/state/investigations.ts                              │
  │    Map<insightId, AgentEvent[]>   (event log cache)       │
  │                                                           │
  │  lib/mcp/schema.ts                                        │
  │    let cached: WorkspaceSchema | null    (process-global) │
  └─────────────────┬────────────────────────────────────────┘
                    │  written through (dev only)
                    ▼
  ┌─ Disk (gitignored, dev server only) ─────────────────────┐
  │  .auth-cache.json           plaintext OAuth tokens        │
  │  .investigation-cache.json  AgentEvent[] per insight      │
  └─────────────────┬────────────────────────────────────────┘
                    │  read fall-through (demo path)
                    ▼
  ┌─ Disk (committed, demo replay) ──────────────────────────┐
  │  lib/state/demo-insights.json       665 lines             │
  │    { insights[], workspace, coverage[] }                  │
  │  lib/state/demo-investigations.json 3,487 lines           │
  │    { <insightId>: AgentEvent[] }                          │
  └─────────────────┬────────────────────────────────────────┘
                    │  every metric — ad-hoc, on demand
                    ▼
  ┌─ External substrate (the "real" workspace) ──────────────┐
  │  LIVE      Bloomreach Engagement (loomi MCP)              │
  │            event stream — purchase / view_item /          │
  │            session_start / cart_update / checkout         │
  │  SYNTHETIC SyntheticDataSource (in-process)               │
  │            same shape, deterministic counts                │
  │            (52,840 purchases · 241,900 view_items · ...)   │
  └──────────────────────────────────────────────────────────┘
```

Read top to bottom: the browser caches a mode pick; the route handler holds
a session cookie; module state is the actual feed; disk is a cache of the
last good run; the substrate is where the *real* data lives, and the app
never tries to own it.

---

## What's interesting about this data model

Three things worth noticing before opening any concept file.

### 1. There's no database, and that's deliberate

The repo has zero migrations because it has zero schema to migrate. State
falls into one of four buckets:

| Bucket | Lifetime | Examples |
|---|---|---|
| **Ephemeral** (Map in a warm instance) | minutes to hours | the current feed, in-flight investigations |
| **Dev-only cache** (gitignored JSON) | until you `rm` it | `.auth-cache.json`, `.investigation-cache.json` |
| **Committed snapshot** (versioned JSON) | until you recapture | `lib/state/demo-insights.json`, `demo-investigations.json` |
| **External substrate** (Bloomreach or synthetic) | owned by Bloomreach | the actual event stream |

The choice is right for the product: the agents recompute everything from
raw events anyway, so there's nothing the app needs to *own* across
restarts. The serverless filesystem is read-only in production, which would
force you to pick a real DB the day you wanted real persistence — see
`06-access-patterns-and-storage-choice.md` for that buildable target.

### 2. The same data exists in two shapes — on purpose

The monitoring agent emits an **`Anomaly`** — a minimal "the metric moved"
record. The route handler enriches it into an **`Insight`** — the UI-shaped
card with `headline`, `summary`, `revenueImpact`, `affectedCustomers`. Both
shapes are kept around, both keyed by the same `id`. That's denormalization
as a read optimization — the UI never has to re-derive a headline.

`02-normalization-and-duplication.md` walks the duplication policy: what's
duplicated deliberately, what's a leak the audit caught.

### 3. The "schema" lives in TypeScript types

When `validate.ts` checks an agent's output it's checking against
`Anomaly` / `Diagnosis` / `Recommendation` interfaces. When the demo JSON
files were written they were emitted *as instances of those types*. When
the field set grows (the `revenueImpact`, `aov`, `funnel` enrichments are
recent), new fields land as `Optional` so older snapshots still validate.

That optional-field discipline is the migration story — no `ALTER TABLE`,
just `field?: T`. See `05-migrations-and-evolution.md`.

---

## What this repo does NOT exercise

Honest list, so the audit doesn't have to be defensive:

- **No relational schema.** No tables, FKs, JOINs, B-tree indexes.
- **No transactions.** No `BEGIN ... COMMIT`. Every write is a single Map
  assignment.
- **No migration tool.** No Drizzle/Prisma/Knex. Type changes are
  TypeScript edits.
- **No query language.** EQL is the *external* substrate's query language;
  the app just sends strings.
- **No write durability.** Restart a warm Vercel instance and the feed is
  gone — but the next briefing recomputes it from scratch.

The concept files name each of these honestly with the buildable target,
not as flaws to apologize for.

---

## Reading map

If you remember one thing per file:

| File | The one thing |
|---|---|
| `01-the-data-model-and-its-shape.md` | The entities are TypeScript interfaces; `WorkspaceSchema` is the substrate, `Insight`/`Anomaly`/`Diagnosis`/`Recommendation` are the agent outputs, `AgentEvent` is the streaming wire format. |
| `02-normalization-and-duplication.md` | `Anomaly` → `Insight` is deliberate denormalization for read speed; `id` is the join key. |
| `03-indexing-vs-query-patterns.md` | The `Map<id, value>` *is* the index. The repo never needs a query plan because every access is by primary key. |
| `04-transactions-and-integrity.md` | There's no DB to run transactions in; integrity is enforced by **TypeScript types + runtime validators in `lib/mcp/validate.ts`**, plus the per-session Map isolation that stops two users overwriting each other's feed. |
| `05-migrations-and-evolution.md` | Schema evolution = adding `field?:` to the interface. The demo JSON snapshots are the regression suite — old snapshots must still parse. |
| `06-access-patterns-and-storage-choice.md` | The access pattern is "write once per briefing, read N times per page render." A Map fits that. A DB would fit a different access pattern (cross-session aggregation) the app doesn't have. |
| `audit.md` | The 7-lens checklist applied to every code path above. |

---

## A note on the substrate

The data the *business* analyzes lives outside this repo — Bloomreach
Engagement. blooming_insights is a thin orchestrator on top of an external
event stream it doesn't own. That's why data modeling here is about the
*derivation pipeline* (substrate → Anomaly → Insight → Investigation) and
the small set of in-memory caches, not about table layout. The schema audit
that matters most for this app is **the WorkspaceSchema interface** in
`lib/mcp/schema.ts:8` — it's the contract that both live and synthetic
substrates must satisfy.
