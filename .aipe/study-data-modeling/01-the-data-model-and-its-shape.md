# 01 — The data model and its shape

**Entity-relationship sketch · Project-specific**

## Zoom out, then zoom in

Every data-modeling guide starts with the schema diagram. For
**blooming_insights** the "schema" is **TypeScript interfaces** — they're
what every layer agrees on, what `validate.ts` guards at runtime, and what
the demo JSON snapshots were emitted to match.

```
  Zoom out — where the type system lives

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  components/feed/InsightCard.tsx                            │
  │  components/investigation/EvidencePanel.tsx                 │
  │  reads Insight / Diagnosis / Recommendation                 │
  └───────────────────────────┬────────────────────────────────┘
                              │  NDJSON over fetch
  ┌─ Route layer ─────────────▼────────────────────────────────┐
  │  app/api/briefing/  app/api/agent/                          │
  │  emits AgentEvent (lib/mcp/events.ts)                       │
  └───────────────────────────┬────────────────────────────────┘
                              │  in-process function call
  ┌─ Agent + state layer ─────▼────────────────────────────────┐
  │  lib/agents/{monitoring,diagnostic,recommendation}.ts       │
  │  lib/state/{insights,investigations}.ts                     │
  │  ★ lib/mcp/types.ts  ←── the schema lives here              │ ← we are here
  │  ★ lib/mcp/schema.ts ←── WorkspaceSchema + parser           │
  └───────────────────────────┬────────────────────────────────┘
                              │  callTool(name, args)
  ┌─ Substrate ───────────────▼────────────────────────────────┐
  │  BloomreachDataSource (live)  or  SyntheticDataSource       │
  │  raw events: purchase / view_item / session_start / ...     │
  └────────────────────────────────────────────────────────────┘
```

The interfaces in `lib/mcp/types.ts` are this app's **data dictionary** —
the single source of truth that every layer reads from and writes to. The
fact that they're types rather than `CREATE TABLE` statements doesn't
change the role they play.

Now zoom in. There are five entities worth knowing by name, and one wire
format. The relationships are simple — almost everything keys off
`Insight.id`.

---

## Structure pass — layers, axis, seams

Before the mechanics, read the skeleton. The axis worth tracing across this
schema is **state ownership** — *who owns each piece of data, and where
does ownership change hands?*

```
  Trace ONE axis — "who owns this data?" — across the layers

  ┌─ substrate ──────────────────────────────────┐
  │  Bloomreach owns events; synthetic adapter   │   → SUBSTRATE owns
  │  owns its in-process facts                   │
  └───────────────────┬──────────────────────────┘
                      │  seam: callTool result envelope
  ┌─ adapter ─────────▼──────────────────────────┐
  │  WorkspaceSchema (parsed once, cached)       │   → APP owns the SHAPE,
  │  Anomaly / Diagnosis / Recommendation        │     substrate owns the FACTS
  └───────────────────┬──────────────────────────┘
                      │  seam: agent emits → state.put
  ┌─ state ───────────▼──────────────────────────┐
  │  Insight (enriched Anomaly) in session Map   │   → SESSION owns
  └───────────────────┬──────────────────────────┘
                      │  seam: NDJSON over fetch
  ┌─ UI ──────────────▼──────────────────────────┐
  │  InsightCard reads, never mutates            │   → UI is read-only
  └──────────────────────────────────────────────┘
```

Three seams pop out, each one a contract worth naming:

- **substrate → adapter** — the `WorkspaceSchema` and the raw event types
  cross this seam. Both adapters (Bloomreach, synthetic) must satisfy the
  *same* `WorkspaceSchema` shape, even though one is OAuth-backed MCP and
  the other is a hardcoded JS object.
- **agent → state** — `Anomaly` enters, `Insight` exits. The widening
  happens here (see `02-normalization-and-duplication.md`).
- **state → UI** — the wire format is `AgentEvent[]`, not raw `Insight[]`.
  The UI sees a *log*, not a snapshot.

Skeleton mapped. Now the mechanics.

---

## How it works

### Move 1 — the mental model

If you've ever drawn an ER diagram with three tables and a foreign key, you
already know the shape. The twist here is that the "tables" are interfaces
and the "rows" are `Map` values keyed by string IDs.

```
  The entity graph — six shapes, one join key

         ┌──────────────────────┐
         │   WorkspaceSchema    │   substrate metadata
         │  (1 per app process) │   — projectId, events[], counts
         └──────────┬───────────┘
                    │  read by every agent for context
                    │
         ┌──────────▼───────────┐
         │       Anomaly        │   "the metric moved"
         │  (N per briefing)    │   — metric, scope, change, evidence
         └──────────┬───────────┘
                    │  one-to-one widening (anomalyToInsight)
                    │
         ┌──────────▼───────────┐
         │       Insight        │ ◄──── id = primary key everywhere downstream
         │  (N per briefing)    │
         └──────────┬───────────┘
                    │  insightId
        ┌───────────┼───────────────────────────┐
        │           │                           │
   ┌────▼────┐ ┌────▼─────────┐  ┌──────────────▼──────┐
   │Diagnosis│ │Recommendation│  │  AgentEvent[]       │
   │ (0..1)  │ │   (0..N)     │  │  (stream replay)    │
   └─────────┘ └──────────────┘  └─────────────────────┘
```

`Insight.id` is the join key everything else hangs off — investigations,
event logs, the URL of the investigate page (`/investigate/[id]`). The
agents never see each other's data; they communicate by *writing* shapes
into this graph and *reading* shapes back out.

### Move 2 — the entities, one at a time

Six shapes, each one bolded sub-heading. Read in order; each one builds on
the one before it.

#### **WorkspaceSchema — the substrate dictionary**

This is the only "schema" the app stores about its substrate. It lists what
events exist, what properties they carry, how many customers, and the time
horizon of the data. The agents read it to know what they can query.

```typescript
// lib/mcp/schema.ts:8-25
export interface WorkspaceSchema {
  projectId: string;
  projectName: string;
  /** Events sorted by eventCount descending (most active first). */
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  /** Inclusive `from`, exclusive `to` ISO dates bounding the data — when known.
   *  `undefined` for live Bloomreach (open-ended). */
  dataHorizon?: { from: string; to: string; durationDays: number };
}
```

Line-by-line:

- `projectId` / `projectName` — substrate-scoped IDs. Bloomreach uses
  `'wobbly-ukulele'`-style slugs; synthetic uses
  `'synthetic-blooming-project'`.
- `events: { name, properties, eventCount }[]` — denormalized for read.
  Every event carries its own property list inline so the agents don't
  have to JOIN; the cost is that adding a property means re-emitting the
  whole record.
- `dataHorizon` — the load-bearing **optional** field. Synthetic substrates
  emit a concrete range (`2025-12-01` → `2026-06-01`); Bloomreach leaves
  it `undefined` because the substrate is open-ended. The agent prompts
  branch on its presence to set their EQL `time_range` window.

```
  WorkspaceSchema is a CACHED denormalized snapshot

  ┌─ source (4 MCP tool calls) ───────────────────────────────┐
  │  get_event_schema           → event names + properties     │
  │  get_customer_property_schema → customer properties        │
  │  list_catalogs                → catalogs                   │
  │  get_project_overview         → totals + per-event counts  │
  └────────────────┬──────────────────────────────────────────┘
                   │  parseWorkspaceSchema (pure)
                   ▼
  ┌─ destination (1 cached object, process-global) ───────────┐
  │  WorkspaceSchema                                           │
  │  — joined + sorted by eventCount desc                      │
  │  — `cached` in lib/mcp/schema.ts:138                       │
  └───────────────────────────────────────────────────────────┘
```

The bug-shaped detail: the cache is **process-global, not session-scoped**
(`lib/mcp/schema.ts:138`). Today both substrates expose the *same* schema
across sessions, so this is fine. The day a customer has two Bloomreach
workspaces and switches between them in one Vercel instance, the second
workspace sees the first's schema. The audit flags it — see
`audit.md` → migrations-and-evolution.

#### **Anomaly — the monitoring agent's output**

The minimal record of *something moved.* The monitoring agent emits these;
they enter the state layer through `putInsights` (which widens them into
`Insight`s on the way in).

```typescript
// lib/mcp/types.ts:83-92
export interface Anomaly {
  metric: string;
  scope: string[];                          // ["mobile", "checkout"]
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;
  history?: number[];                       // 12 weekly values (sparkline)
  category?: CategoryId;                    // coverage-grid bucket
}
```

Five fields are required, three optional. The required set is the *minimum
contract* the diagnostic agent needs to do its job — give it
`metric + scope + change + severity + evidence` and it can investigate. The
optional fields are downstream enrichments the monitoring agent *can*
emit but the schema doesn't force.

The shape is intentionally narrow. `evidence: { tool, result }[]` is the
escape hatch — `result` is `unknown`, so the agent can put whatever the
tool returned in there without the type system pinning it down. This is
flexibility bought at the cost of validation: the `result` could be
anything, and the UI has to defensively `findCurrentPrior(evidence)` to
extract `{current, prior}` numbers if they're present.

#### **Insight — the UI-shaped enrichment of Anomaly**

What the feed actually renders. Every `Anomaly` is widened into an
`Insight` by `anomalyToInsight` (`lib/state/insights.ts:25`); the widening
adds an `id`, a `headline`, a `summary`, and derives business-owner
fields like `revenueImpact`.

```typescript
// lib/mcp/types.ts:36-62
export interface Insight {
  id: string;
  timestamp: string;
  severity: Severity;
  headline: string;             // "mobile conversion dropped 18%"
  summary: string;              // one-line context
  metric: string;
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  scope: string[];
  source: 'monitoring' | 'query';
  evidence?: { tool: string; result: unknown }[];
  impact?: string;
  // ── business-owner enrichments (Tier 1) ──
  revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' };
  aov?: { current: number; prior: number };
  funnel?: { view: number; cart: number; checkout: number; purchase: number };
  affectedCustomers?: number;
  history?: number[];
  downstreamReady?: { diagnosis: boolean; recommendations: number };
  category?: CategoryId;
}
```

`Insight` is a **superset of `Anomaly`** — every field from `Anomaly` is
either copied verbatim or transformed into a display-shaped version. That
intentional overlap is what `02-normalization-and-duplication.md` is
about. Three things worth noticing in the field list:

- `id: string` is the **primary key** (a `crypto.randomUUID()` minted in
  `anomalyToInsight`). It's the join key for `Diagnosis`, `Recommendation`,
  and the cached event log.
- Every enrichment field (`revenueImpact`, `aov`, `funnel`, …) is
  `optional`. This is migrations-by-optional — see
  `05-migrations-and-evolution.md`.
- `source: 'monitoring' | 'query'` — a discriminator that says where the
  insight came from. The "query" path (free-form Q&A in `QueryBox`)
  produces single insights without going through the monitoring scan.

#### **Diagnosis — the diagnostic agent's output**

A single conclusion plus the evidence and hypotheses that got there.
Keyed implicitly by the `insightId` it answers (the `Investigation`
wrapper carries that key).

```typescript
// lib/mcp/types.ts:95-104
export interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
  confidence?: 'high' | 'medium' | 'low';
  timeSeries?: { day: string; value: number }[];
}
```

`evidence: string[]` here is **different** from `Anomaly.evidence` —
diagnosis evidence is *human-readable bullet points* (rendered as
markdown), not `{tool, result}` envelopes. Same field name, different
shape. That's a real overload of the word "evidence" in the type system;
the audit calls it out.

#### **Recommendation — the recommendation agent's output**

The "what to do" with steps and a Bloomreach feature chip. Multiple
recommendations can hang off one `insightId`.

```typescript
// lib/mcp/types.ts:116-130
export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact; // string (legacy) OR { range, rangeUsd?, assumption }
  confidence: 'high' | 'medium' | 'low';
  effort?: 'low' | 'medium' | 'high';
  timeToSetUpMinutes?: number;
  readResultInDays?: number;
  prerequisites?: { label: string; satisfied: boolean }[];
  successMetric?: string;
}
```

`estimatedImpact: EstimatedImpact` is a **discriminated union** that
carries both the new shape and the legacy shape:

```typescript
// lib/mcp/types.ts:108-110
export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };
```

That union is the most honest piece of migration evidence in the codebase.
Old demo snapshots have `estimatedImpact: "+$15K MRR"` (a string); new
agent output emits `{ range: "+$10K–$20K MRR", assumption: "..." }`. The
UI helper `impactRange(e)` (`lib/insights/derive.ts:5`) normalizes both
shapes so the card render code doesn't branch.

#### **AgentEvent — the wire format**

NDJSON streamed from `/api/agent` to the UI. Not stored long-term as such
— but the *cache* of an investigation is `AgentEvent[]`, so it's
de-facto persisted in `.investigation-cache.json` and in the demo
`demo-investigations.json` snapshot (3,487 lines).

```typescript
// lib/mcp/events.ts:4-12
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

This is a **discriminated union with `type` as the tag** — eight variants,
one per kind of thing that can happen during an agent run. The UI consumes
them in arrival order and renders the trace as a scrolling log. Because
the cache *is* the event array, the demo replay is literally
"re-emit this list of events in order."

The shape lets the UI render *progress*, not just a final result — which is
the product's whole "show your work" pitch. The cost: every change to
`Insight` or `Diagnosis` ripples into every cached `AgentEvent[]`, so the
demo JSON snapshots are the regression suite for type drift (see
`05-migrations-and-evolution.md`).

### Move 3 — the principle

**The schema is wherever the type system says it is.** In a Rails app
that's `db/schema.rb`. In a Drizzle app that's `migrations/0003_chunks.sql`.
In **blooming_insights** it's `lib/mcp/types.ts` plus `lib/mcp/schema.ts`
plus `lib/mcp/events.ts`. The role is identical — a single source of
truth that every layer reads against. The fact that no migration tool
runs against it doesn't change what it is.

The generalisation: when you don't have a database, you still have a
schema — it just lives in your type system, and the discipline you'd
apply to migrations (additive changes only, backfill before remove,
versioned snapshots as your regression suite) applies to your interfaces.

---

## Primary diagram

The whole entity graph in one frame, layers labelled, every arrow named.

```
  blooming_insights data model — entities, layers, and the join key

  ┌─ SUBSTRATE LAYER ──────────────────────────────────────────────────┐
  │  raw events (Bloomreach or synthetic)                              │
  │    purchase · view_item · session_start · cart_update · checkout   │
  └─────────────────┬──────────────────────────────────────────────────┘
                    │  callTool() — execute_analytics_eql etc.
                    ▼
  ┌─ ADAPTER LAYER ────────────────────────────────────────────────────┐
  │  ┌──────────────────────────┐                                       │
  │  │     WorkspaceSchema      │   built once, cached                  │
  │  │  events[] + counts +     │   lib/mcp/schema.ts:138               │
  │  │  customerProperties[]    │                                       │
  │  └──────────────────────────┘                                       │
  └─────────────────┬──────────────────────────────────────────────────┘
                    │  monitoring agent emits
                    ▼
  ┌─ STATE LAYER (per-session Map) ────────────────────────────────────┐
  │                                                                    │
  │   ┌─────────────┐   anomalyToInsight    ┌─────────────┐            │
  │   │   Anomaly   │ ─────────────────────►│   Insight   │            │
  │   │  (raw)      │                       │  (enriched) │            │
  │   └─────────────┘                       └──────┬──────┘            │
  │                                                │ id                │
  │              ┌─────────────────────────────────┼───────────┐       │
  │              ▼                                 ▼           ▼       │
  │       ┌──────────────┐               ┌────────────────┐ ┌────────┐ │
  │       │  Diagnosis   │               │ Recommendation │ │ Agent  │ │
  │       │  (0..1 per   │               │   (0..N per    │ │ Event[]│ │
  │       │   insightId) │               │    insightId)  │ │ cache  │ │
  │       └──────────────┘               └────────────────┘ └────────┘ │
  └─────────────────┬──────────────────────────────────────────────────┘
                    │  NDJSON stream (AgentEvent variants)
                    ▼
  ┌─ UI LAYER (read-only) ─────────────────────────────────────────────┐
  │  InsightCard · EvidencePanel · RecommendationCard · StatusLog      │
  │  joins by `insight.id`; never mutates                              │
  └────────────────────────────────────────────────────────────────────┘
```

`Insight.id` is the join key threaded from the state layer through the
URL (`/investigate/[id]`) and back into every downstream entity.

---

## Elaborate

Where this comes from: the type-as-schema pattern is the same one you'd
see in any "no-DB" event-driven backend — Cloudflare Workers with
Durable Object state, AWS Lambda with DynamoDB write-through, edge
functions that compose external APIs without owning data. The discipline
predates "serverless" by decades — RPC interfaces in CORBA, Protocol
Buffer messages, GraphQL types are all examples of *the schema is the
contract that the type system enforces.*

What it connects to in adjacent topics:

- **software design** — normalization-as-information-hiding. `Insight`
  hides the raw evidence behind a derived `revenueImpact`. See
  `02-normalization-and-duplication.md`.
- **distributed systems** — the substrate is a third-party system the app
  doesn't own. Every "schema" decision here is really *a contract with
  Bloomreach*, mediated by `WorkspaceSchema`.
- **system design** — the choice to not own a database is an architecture
  call. The schema audit doesn't second-guess it, but it does name the
  ceiling: if you ever wanted cross-session aggregation, you'd need a
  real store. See `06-access-patterns-and-storage-choice.md`.

What to read next: `02-normalization-and-duplication.md` walks the
`Anomaly` → `Insight` widening as a normalization-vs-denormalization case
study. `03-indexing-vs-query-patterns.md` shows how the Map structure
*is* the index.

---

## Interview defense

**Q: "Walk me through your data model."**

Verdict first: there's no database, so the schema is TypeScript interfaces
in `lib/mcp/types.ts`. Five entities, one join key.

```
  the answer, sketched

  WorkspaceSchema (substrate metadata, 1 per process)
        │
        ▼  agents query the substrate for events
  Anomaly (monitoring output)  ──►  Insight (UI-shaped, has id)
                                          │
                       ┌──────────────────┼─────────────────┐
                       ▼                  ▼                 ▼
                   Diagnosis    Recommendation[]    AgentEvent[]
                  (0..1)         (0..N)             (the cache)
                                                    
  Insight.id is the primary key everywhere downstream.
```

Anchor: "the load-bearing piece people forget is `WorkspaceSchema` — it's
the contract that lets the same agent code run against live Bloomreach OR
a synthetic adapter; both adapters return the same shape."

**Q: "Why TypeScript interfaces instead of a real schema?"**

Verdict first: because nothing the app produces needs to outlive a
request. Every metric is recomputed from the substrate on demand; the
state layer is a write-through cache of the most recent briefing, not a
record of truth.

```
  the test that picks the storage shape

  is the data RECOMPUTABLE from upstream?
       │
       │  yes — every metric is a fresh EQL query
       ▼
  in-memory cache is enough; a DB would buy nothing
       │
       │  if the answer were "no" — e.g. user-authored
       │  comments on an insight — the answer flips
       ▼
  THEN a real DB earns its keep
```

Anchor: "I'd add Postgres the day a user can edit an insight. Until then
the substrate IS the database."

**Q: "What's the riskiest part of this schema?"**

Verdict first: `evidence: { tool: string; result: unknown }[]`. The
`unknown` is doing a lot of work — the UI defensively scans evidence
arrays looking for `{ current, prior }` numbers, which means the schema
*allows* an evidence record that the UI can't render.

```
  the unknown escape hatch

  Anomaly.evidence: [{ tool, result: unknown }]
                                    │
                                    │  agent emits whatever the tool returned
                                    ▼
  UI: findCurrentPrior(evidence)  ──── tries every entry, may find nothing
                                       │
                                       │  if nothing: card shows '--' placeholders
                                       ▼
                                  silent degradation
```

Anchor: "the cost of the flexibility is silent degradation; the fix is a
discriminated union over the known tool families, with `unknown` as the
explicit fallback variant."

---

## See also

- [`02-normalization-and-duplication.md`](./02-normalization-and-duplication.md)
  — why `Anomaly` and `Insight` are both kept around
- [`03-indexing-vs-query-patterns.md`](./03-indexing-vs-query-patterns.md)
  — how `Map<id, T>` answers every query the UI makes
- [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md)
  — the optional-field discipline that keeps demo JSON parseable as
  fields grow
- [`audit.md`](./audit.md) — the consolidated red-flag checklist
