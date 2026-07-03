# The data model and its shape

**Industry term:** Entity relationship model (type-first / no-DB variant) · **Type:** Language-agnostic pattern, applied to a client-plus-server TS repo with no relational store.

## Zoom out, then zoom in

**Zoom out — where the data model lives.** blooming_insights has no database and no ORM. The "schema" is a set of TypeScript interfaces in `lib/mcp/types.ts` and `eval/goldens/types.ts`, materialized as in-memory objects during a request and (sometimes) serialized to JSON files. This is the whole persistence surface:

```
  blooming_insights — the persistence surface, layered

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  React components read Insight[]                               │
  └────────────────────────────┬───────────────────────────────────┘
                               │ JSON over NDJSON stream
  ┌─ Service layer ─────────────▼──────────────────────────────────┐
  │  app/api/briefing, app/api/agent — Next.js route handlers      │
  │                             │                                   │
  │            ┌────────────────▼──────────────────┐                │
  │            │ ★ THE DATA MODEL ★                │ ← we are here  │
  │            │ TypeScript interfaces in          │                │
  │            │ lib/mcp/types.ts + eval/goldens   │                │
  │            └────────────────┬──────────────────┘                │
  └─────────────────────────────┼───────────────────────────────────┘
                                │  serialize
  ┌─ Storage layer ─────────────▼──────────────────────────────────┐
  │  Map<sessionId, SessionFeed>   (in-memory, dies on cold start)  │
  │  demo-insights.json / demo-investigations.json  (committed)    │
  │  .investigation-cache.json / .auth-cache.json   (dev-only)     │
  │  eval/receipts/*.json                           (per run)      │
  └─────────────────────────────┬──────────────────────────────────┘
                                │  fetch
  ┌─ Provider layer ────────────▼──────────────────────────────────┐
  │  Bloomreach loomi connect MCP · Anthropic API                  │
  │  (the real source of truth for events + LLM outputs)           │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** The entities *aren't* rows in tables; they're **discriminated unions and interface trees** that get shaped by which stage of the pipeline you're in (`Anomaly` → `Insight` → `Investigation` → `Receipt`). There's one canonical source (`lib/mcp/types.ts`) plus one satellite (`eval/goldens/types.ts`) for eval-specific shapes. Everything downstream — the demo snapshots, the receipts, the load results — validates against these types.

## Structure pass

Skeleton before mechanics: name the layers, pick one question, trace it, then find where the answer flips.

### The three layers of entities

```
  Data-model layers — coarse to fine

  ┌─ Domain entities (the analyst's world) ─────────────────┐
  │  WorkspaceSchema · Insight · Anomaly · Diagnosis        │
  │  Recommendation · AgentEvent (8-variant DU)             │
  │  → lib/mcp/types.ts + lib/mcp/events.ts + lib/mcp/schema│
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Eval-subsystem entities (grading + regression) ────────┐
  │  GoldenCase · Receipt · Baseline · Worksheet            │
  │  Agreement · LoadReceipt · BudgetSnapshot               │
  │  → eval/goldens/types.ts + shapes inline in run.eval.ts │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Wire / persistence shapes (thin wrappers) ─────────────┐
  │  SessionFeed{ Map, Map, Map }   demo snapshot JSON keys │
  │  → lib/state/insights.ts + lib/state/demo-*.json        │
  └─────────────────────────────────────────────────────────┘
```

### One axis: **who owns this entity's identity?**

Trace "which layer mints the id, and where is that id load-bearing?" down the stack:

```
  "who owns identity?" — one question, trace the answer down

  Domain:   Insight.id      → minted at anomalyToInsight (crypto.randomUUID())
            Recommendation.id → minted by the agent's LLM output
            AgentEvent      → no id (streams are ordered, not addressed)

  Eval:     GoldenCase.caseId → hand-written literal (01-…, 02-…) — stable
            Receipt          → composite key: (caseId, runId) → filename
            Baseline         → single-file, self-identifying by content

  Storage:  SessionFeed      → keyed by sessionId (opaque, request-scoped)
            demo-*.json      → no id; the file *is* the whole snapshot

  the answer flips: domain uses UUIDs (ephemeral), eval uses
  hand-authored ids (stable), storage uses request-scoped opaque keys
```

### The seams — where the answer flips

- **`anomalyToInsight` boundary (`lib/state/insights.ts:25`)** — the shape flips from a *pure agent output* (`Anomaly`) to a *presentation-enriched record* (`Insight` with derived fields spliced in). This is the seam where denormalization enters. → walked in `02-normalization-and-duplication.md`.
- **The eval-receipt boundary (`eval/run.eval.ts:341`)** — a set of independently-produced facts (diagnosis, judgment, tool calls, cost, budget) get merged into a single denormalized JSON blob. This is the seam where a document store shape gets born from what could have been a set of related tables.
- **The demo-snapshot boundary (`lib/state/investigations.ts:9`)** — the runtime `AgentEvent[]` stream gets frozen into a committed JSON file. That file is now the source of truth for demo mode. Live regenerates, demo replays.

Skeleton mapped. Now walk the mechanics.

## How it works

### Move 1 — the mental model

Think of the data model as a **pipeline of shapes** rather than a schema. The workspace's raw events (in Bloomreach) never enter your process directly — instead, each pipeline stage produces a *typed record* that summarizes the last stage plus the last stage's decision. Each shape is denser than the one before it.

```
  The pipeline of shapes — each stage produces a denser record

  Bloomreach raw events
        │
        │ (queried via MCP)
        ▼
  Anomaly          { metric, scope, change, severity, evidence }
        │
        │ anomalyToInsight() splices in derived fields
        ▼
  Insight          Anomaly + { revenueImpact?, aov?, funnel?,
                               affectedCustomers?, history?, ... }
        │
        │ diagnostic agent investigates
        ▼
  Diagnosis        { conclusion, evidence[], hypotheses[],
                     affectedCustomers? }
        │
        │ recommendation agent proposes
        ▼
  Recommendation[] { title, rationale, feature, steps, impact }
        │
        │ eval run wraps all of the above + judgments + costs
        ▼
  Receipt          the whole trail as one denormalized document
```

Every arrow is *code* — a pure function that maps one shape to the next. There's no shared mutable state across stages, which is why the in-memory Map in `lib/state/insights.ts` can be as thin as it is: it's a cache of the final shape, not a database.

### Move 2 — the entities, walked one at a time

Each sub-section names one entity, shows the type from the actual file, and points at where it's created and read.

#### The core five — `WorkspaceSchema`, `Anomaly`, `Insight`, `Diagnosis`, `Recommendation`

The core of the domain. Every route handler and UI component you'll read is passing one of these five around.

```
  Domain entity relationships (all in lib/mcp/types.ts)

  WorkspaceSchema  (bootstrap-once, cached in module scope)
        │
        │ constrains what queries the agents can run
        ▼
  Anomaly ────► Insight ────► (Investigation)
                                    │
                                    ├── Diagnosis
                                    │        │
                                    │        │ Diagnosis.affectedCustomers.count
                                    │        │ is COPIED into Insight.affectedCustomers
                                    │        ▼ (denormalization — see file 02)
                                    │      Insight
                                    │
                                    └── Recommendation[]
```

Straight from `lib/mcp/types.ts:82-92` — the `Anomaly` shape:

```typescript
export interface Anomaly {
  metric: string;
  scope: string[];                          // ["mobile", "checkout"]
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;                          // one-sentence business impact (agent-written)
  history?: number[];                       // 12 weekly values for the sparkline
  category?: CategoryId;                    // the coverage-grid category
}
```

Read the annotations left to right: `metric` + `scope` + `change` is the *composite key* — nothing else identifies the anomaly. `evidence` is a **JSON blob field** (`result: unknown`) — the tool result is stored as-is, un-parsed. `impact` and `history` are **optional** because older snapshots produced by earlier agent code lacked them; the shape stays backward-compatible with committed demo data. This "optional-as-version-marker" trick recurs everywhere — → walked in `05-migrations-and-evolution.md`.

`Insight` (`lib/mcp/types.ts:36-62`) is the presentation-facing version — `Anomaly` **plus** a headline, an id, a timestamp, and five derived-for-the-UI fields (`revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `history`, `downstreamReady`). Not a subtype — a *superset with copies*. That's the load-bearing shape choice; it makes rendering trivial but makes edits impossible without recomputation, which is the whole story of file 02.

`Diagnosis` and `Recommendation` (`lib/mcp/types.ts:95-130`) are agent outputs — one struct each, with optional business-owner enrichments (`effort`, `timeToSetUpMinutes`, `readResultInDays`, `prerequisites`, `successMetric`). Same optional-fields-as-capability-signals pattern.

#### The discriminated union — `AgentEvent`

`lib/mcp/events.ts:4-12`. This one type carries **the entire streaming contract** between the route handlers and the UI:

```typescript
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Eight variants, one tag field (`type`). Discriminated unions **are the type-system equivalent of a polymorphic table** — one "table" with a `kind` column and different columns filled per variant. TypeScript's exhaustiveness check on the tag is the equivalent of a DB `CHECK` constraint on the discriminator, enforced at compile time instead of runtime. This is the *only* place in the codebase where the data shape is genuinely polymorphic, and it's shaped exactly right for the wire — one JSON object per NDJSON line, self-describing.

#### The eval-subsystem shapes — `GoldenCase`, `Receipt`, `Baseline`

Different lineage: these live in `eval/`, not `lib/`. `GoldenCase` (`eval/goldens/types.ts:20-38`) is the test-fixture record — 10 of them, one per file, hand-authored, imported into `eval/goldens/index.ts` as an ordered `readonly` array.

```typescript
export interface GoldenCase {
  caseId: string;
  signalClass: SignalClass;   // 'has-signal' | 'partial-signal' | 'no-signal' | 'positive'
  intent: string;
  anomaly: Anomaly;           // reused from lib/mcp/types.ts
  knownCorrect: Record<string, unknown>;   // free-form judge context
}
```

Notice `signalClass` — a **string-literal discriminated union with four variants**, but it's flat data (a field, not a tag on a variant). It's used at `run.eval.ts:413-415` to decide whether a case is *gated* (has-signal / partial-signal — a fail is a bug) or *measured* (no-signal / positive — a fail is a data point). This is the classical "type as data" pattern — the value picks the code path.

`Receipt` (constructed at `eval/run.eval.ts:341-395`) is the giant one — the entire trail of one case in one document. About 35KB serialized. There's no `Receipt` interface anywhere; the shape is defined by construction and re-derived at read time (`eval/baseline.eval.ts:26-39` names only the fields the baseline reader needs). That's a real cost — see file 04.

`Baseline` (`eval/baseline.eval.ts:70-85`) is the committed reference — one file, one snapshot of aggregate stats, keyed by `runId`. It's the *only* eval artifact that's checked into git; every other receipt is gitignored.

#### The three runtime shapes — `SessionFeed`, `cached: WorkspaceSchema | null`, `BudgetTracker`

Tiny, but every one of them is the entire "storage layer" for its concern.

`SessionFeed` (`lib/state/insights.ts:8-14`):

```typescript
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
const state = new Map<string, SessionFeed>();
```

Nested Map-of-Maps — the outer partitions by `sessionId` (opaque, cookie-supplied), the inner is by entity id. The comment on lines 5-11 is worth reading in full: this partitioning is defensive against warm serverless instances leaking one user's feed into another's. Without it, `putInsights`'s `clear()` on line 66 would wipe every user's feed.

`cached: WorkspaceSchema | null` at `lib/mcp/schema.ts:138`. One module-level `let`. It's a manually-managed **process-wide singleton cache** with an explicit reset (`_resetSchemaCache`, line 211). The schema doesn't change during a process lifetime — the pattern fits.

`BudgetTracker` (`lib/agents/budget.ts:41-77`) is a class, created fresh per investigation. It holds three counters (`inputTokens`, `outputTokens`, `turns`) and exposes `snapshot()` + `exceeded()`. Its persistence is *its object lifetime* — it dies when the investigation finishes.

#### Move 2 variant — the load-bearing skeleton

The **kernel of this data model** is small. Strip everything you can:

```
  kernel:  Anomaly ──► Insight ──► Diagnosis ──► Recommendation[]
                                                  │
                                                  ▼
                                                Receipt
                    (a single denormalized envelope
                     with every prior shape inlined)
```

Name each part by what breaks if you drop it:

- **Drop `Anomaly`** and the monitoring agent has no target output type — nothing to hand off to `anomalyToInsight`, the UI has no cards.
- **Drop `Insight`** and the UI has to derive its presentation fields from `Anomaly` on every render, or two components disagree about what the "affected customers" count means.
- **Drop `Diagnosis`** and step 2 of the investigate flow has no output; step 3 (recommendations) has no input.
- **Drop `Recommendation`** and the whole product has no *decision* stage — this is the payoff shape.
- **Drop `Receipt`** and the eval subsystem has nothing to aggregate; there's no baseline, no gate.
- **Drop `AgentEvent`** and the UI streaming surface has no wire format; NDJSON is untyped garbage.

Everything else — `revenueImpact`, `funnel`, `Insight.affectedCustomers`, `WorkspaceSchema.dataHorizon`, `BudgetTracker` — is **hardening.** Nice to have, doesn't break the pipeline if it's absent.

### Move 3 — the principle

**When the shape is the schema, use the type system as the schema tool.** blooming_insights has no ORM, no migration file, no `CREATE TABLE`. What it has is a single canonical TypeScript file (`lib/mcp/types.ts`) that every producer and every consumer imports. That file *is* the DDL. TypeScript exhaustiveness checks on discriminated unions replace `CHECK` constraints. Optional fields replace nullable columns. The pipeline of shapes replaces a set of joined tables — because the app never needs to *join* one shape to another; each successor already inlines what it needs from its predecessor. The principle transfers: **before reaching for a database, ask whether your access pattern is "join across time" or "hand off along the pipeline." If it's the latter, a set of well-typed records in memory + one document per outcome is often the right shape.** Reach for a database when you need to *query across* outcomes, not when you need to *store* them.

## Primary diagram

The whole data model in one frame — every entity, every relationship, every persistence bucket.

```
  blooming_insights — complete data-model recap

  ┌─ lib/mcp/types.ts (canonical type file) ─────────────────────┐
  │                                                              │
  │   WorkspaceSchema ──► (constrains what queries agents run)   │
  │                                                              │
  │   Anomaly ─► Insight ─► Investigation ─┬─► Diagnosis         │
  │                                        │      │              │
  │                                        │      │ (copied into│
  │                                        │      ▼   Insight)  │
  │                                        │    Insight         │
  │                                        │                    │
  │                                        └─► Recommendation[] │
  │                                                              │
  │   AgentEvent (8-variant DU) — wire format only               │
  └──────────────────────────┬───────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  ┌─ Runtime ─────┐  ┌─ Committed ────┐  ┌─ Eval-only ────────┐
  │ SessionFeed:  │  │ demo-insights  │  │ eval/goldens/*.ts  │
  │ Map<sid,{ ...}│  │ demo-investig- │  │   GoldenCase × 10  │
  │ 3-Map object} │  │ ations.json    │  │                    │
  │               │  │                │  │ eval/baseline.json │
  │ cached:       │  │ (source of     │  │   Baseline (agg)   │
  │  WorkspaceSch │  │  truth for     │  │                    │
  │  ema | null   │  │  demo mode)    │  │ eval/receipts/*    │
  │               │  │                │  │   Receipt × N × R  │
  │ BudgetTracker │  │                │  │ eval/load-receipts │
  │ (per invest.) │  │                │  │   LoadReceipt      │
  └───────────────┘  └────────────────┘  │ eval/calibration/  │
                                          │   Worksheet+Agree │
                                          └────────────────────┘
```

## Elaborate

The type-first, no-DB shape isn't unusual for a **demo-heavy Next.js app** — it's actually the correct fit when the "real" data source is another system (Bloomreach) and your app is a *presentation + reasoning layer* over it. What's worth naming is the discipline it demands: because there's no schema migration to force the issue, changes to shapes have to be **additive** (new optional field) or **coordinated across every producer and consumer at once.** The commit history for `lib/mcp/types.ts` is where the "migrations" actually live — see file 05.

If this app ever grows a need to *query across* investigations ("which recommendations that we labeled as 'campaign' failed most often?" or "show me every diagnosis in the last month where evidence_grounding scored ≤ 2"), the file-per-receipt layout hits its wall. That's the moment to introduce a store — probably SQLite for local eval work, Postgres if it goes to a product feature. → `06-access-patterns-and-storage-choice.md` names the trigger.

## Interview defense

**Q: "Walk me through your data model."**
Answer: "It's not a database — it's a pipeline of typed records. There are five domain entities in `lib/mcp/types.ts`: `Anomaly` from the monitoring agent, `Insight` (the presentation-enriched version of `Anomaly`), `Diagnosis` from the diagnostic agent, `Recommendation` from the recommendation agent, and `AgentEvent` — an eight-variant discriminated union that's the wire format for the streaming UI. Then there are eval-subsystem shapes for goldens, receipts, and baselines. Nothing is normalized; every downstream shape inlines what it needs from upstream. The persistence is a session-partitioned `Map` in memory plus JSON files on disk — committed for demo, gitignored for run artifacts." Draw the pipeline-of-shapes diagram from Move 1.

**Q: "Why no database?"**
Answer: "Two reasons. First, the real source of truth for the data being analyzed is Bloomreach — we re-query it on every run. Second, the access pattern is write-once-per-request, read-many-times-within-that-request. A `Map` fits that exactly. The cost is that nothing survives a cold start, which we accept because the flow is architected around 'reconnect and re-run.' If we ever needed to query *across* runs — trend recommendations over time, find every case where a judgment dimension scored ≤ 2 — that's the moment SQLite or Postgres enters." Anchor: `lib/state/insights.ts:7-23` for the session-partitioned map; `eval/baseline.eval.ts:87-118` for the current cross-run aggregation, which is a linear file scan.

## See also

- `02-normalization-and-duplication.md` — the `anomalyToInsight` seam where denormalization enters.
- `03-indexing-vs-query-patterns.md` — how the receipt layout is queried.
- `06-access-patterns-and-storage-choice.md` — why the storage choice matches the access pattern (and where it doesn't).
