# The data model and its shape

*Entity-relationship model (industry standard) · Language-agnostic*

## Zoom out, then zoom in

Most apps you've worked with put the data model in a SQL file: `CREATE TABLE customers …`, foreign keys, indexes. Open one file, you see the schema. Open another, you see the queries.

This repo puts the data model in TypeScript types. The "schema" is `lib/mcp/types.ts`; the "tables" are entity types; the "rows" are values that flow through the stream. There is no database file to grep — the file you read is the contract.

```
  Zoom out — where the data model lives

  ┌─ UI layer (app/, components/) ──────────────────────┐
  │  React reads Insight / Diagnosis / Recommendation    │
  │  from JSON over NDJSON stream                        │
  └──────────────────────────┬───────────────────────────┘
                             │  HTTP NDJSON
  ┌─ Service layer (app/api/) ─▼─────────────────────────┐
  │  /api/briefing  emits  AgentEvent  (the wire shape)  │
  │  /api/agent     emits  AgentEvent                    │
  └──────────────────────────┬───────────────────────────┘
                             │  in-process
  ┌─ Storage layer ───────────▼───────────────────────────┐
  │  ★ THE DATA MODEL ★                                   │ ← we are here
  │  lib/mcp/types.ts     entities + relationships        │
  │  lib/mcp/events.ts    discriminated union (wire)      │
  │  lib/state/insights.ts in-memory Maps                 │
  │  lib/state/*.json      committed snapshot             │
  └───────────────────────────────────────────────────────┘
```

**Zoom in.** The model has five entities (`WorkspaceSchema`, `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`) tied together by `Insight.id` as the join key. There's a sixth shape — the discriminated union (`AgentEvent`) — that isn't an entity; it's the **envelope** the entities travel in. The question this file answers: *what are the entities, how do they relate, and how does the model decide what's stored once vs what's recomputed?*

## Structure pass

**Layers.** The data model has three altitudes:

- **Type layer** — `lib/mcp/types.ts`, `lib/mcp/events.ts`, `lib/mcp/schema.ts`. Pure type definitions. No runtime.
- **State layer** — `lib/state/insights.ts`, `lib/state/investigations.ts`. The runtime homes: `Map`s and JSON files. The types from above are what gets stored.
- **Wire layer** — `app/api/briefing/route.ts`, `app/api/agent/route.ts`. NDJSON streaming. The discriminated union (`AgentEvent`) leaves over HTTP.

**Axis traced — "where does this fact live?"** Hold that one question across the three layers:

```
  One question down the layers: where does a fact live?

  type layer       →   nowhere yet; only the SHAPE is defined
                       (Anomaly says "metric is a string" but no
                        anomaly exists)

  state layer      →   in a Map, keyed by sessionId then insightId
                       (the fact is alive for the duration of the
                        warm serverless instance)

  wire layer       →   serialized as JSON, one line at a time
                       (the fact exists only as bytes in transit)

  the answer flips at each layer — and the shape stays the same
```

**Seams.** Two boundaries do real work:

1. **The `Anomaly` → `Insight` mapping** (`anomalyToInsight` in `lib/state/insights.ts`). One side is the LLM's output shape (minimal: just the change facts); the other is the UI's input shape (enriched: id, timestamp, headline, derived fields). The fact "this is a 18% drop in conversion" lives on both sides, in different shapes.
2. **The TypeScript ↔ JSON boundary** at `lib/state/demo-insights.json`. Optional fields are how the boundary stays bidirectional across releases — older snapshots still validate because every additive field is `?`. Covered in `05-migrations-and-evolution.md`.

Skeleton named: three altitudes, one fact moving through them via two seams. Now the entities.

## How it works

### Move 1 — the mental model

Think of the data model as five entity types and one envelope. The five entities answer "what is a thing in this system"; the envelope answers "how does a thing travel from server to client."

```
  The shape of the model — five entities + one envelope

  ┌─ entities (the things) ──────────────────────────────────┐
  │                                                           │
  │  WorkspaceSchema  (1 per project)                        │
  │       │                                                   │
  │       │ context for                                       │
  │       ▼                                                   │
  │  Anomaly  ──derived──►  Insight  ───── 1 ─────►  Diagnosis│
  │  (raw)                  (enriched)        │               │
  │                                           │               │
  │                                           └── 1 ── many ──►  Recommendation │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
                              │
                              │  wrapped in
                              ▼
  ┌─ envelope (how things travel) ───────────────────────────┐
  │                                                           │
  │  AgentEvent  ── discriminated union, 8 variants          │
  │      type: 'insight'         { insight: Insight }        │
  │      type: 'diagnosis'       { diagnosis: Diagnosis }    │
  │      type: 'recommendation'  { recommendation: Rec... }  │
  │      type: 'reasoning_step'  { step: ReasoningStep }     │
  │      type: 'tool_call_start' { toolName, agent }         │
  │      type: 'tool_call_end'   { result?, error? }         │
  │      type: 'done'            { }                         │
  │      type: 'error'           { message }                 │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
```

The thing to notice: `Insight` is the **center** of the model. Every other entity points at it through `Insight.id`. `Diagnosis` is *one per Insight* (an insight has at most one current diagnosis); `Recommendation` is *many per Insight* (an insight produces 1–3 recommendations). `Anomaly` is the *predecessor*: every Insight comes from one Anomaly, but Anomaly is the raw form the LLM emits.

### Move 2 — the entities, one at a time

Every Move 2 sub-section shows the type from the repo and names what each field is for. The line ranges are real — open the file and read along.

#### The workspace context — `WorkspaceSchema`

This is the static-ish context that prompts the monitoring agent. It describes the Bloomreach project being analyzed: what events exist, what customer properties are tracked, what catalogs are available.

```ts
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
  dataHorizon?: { from: string; to: string; durationDays: number };
}
```

Three things matter here. First, **`events[]` is pre-sorted by `eventCount` descending** (line 107 in the parser). The data model encodes ordering — the most active event types come first because the LLM reads only the head of the list. Second, **`events[].properties` is a flat string list, not a typed schema**. The model is telling you "the agent figures out semantics from names"; the data model itself is loose because the consumer is. Third, **the entire entity is cached in a module-level `let cached: WorkspaceSchema | null = null`** (`lib/mcp/schema.ts:138`). It's an in-memory singleton for the lifetime of the warm serverless instance — which makes the absence of `dataHorizon` (optional, only set for synthetic workspaces) a real cross-tenant concern if you ever served two Bloomreach projects from one process.

```
  WorkspaceSchema — the "what's in this workspace" entity

  ┌─ project identity ──────┐
  │  projectId · projectName│
  └─────────┬───────────────┘
            │
  ┌─ event catalog ─────────▼──────────────────────────┐
  │  events[]  sorted by eventCount DESC              │
  │     { name, properties[], eventCount }            │
  │     ▲                                             │
  │     │ the order IS data — head of list is what    │
  │     │ the LLM sees first                          │
  └───────────────────────────────────────────────────┘
```

#### The raw form — `Anomaly`

This is what the monitoring agent's LLM emits: the smallest viable description of "something changed." It's the entity *before* the system has assigned an identity or a timestamp.

```ts
// lib/mcp/types.ts:83-92
export interface Anomaly {
  metric: string;
  scope: string[];                          // ["mobile", "checkout"]
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;                          // one-sentence business impact (agent-written)
  history?: number[];                       // 12 weekly values for the sparkline (agent-emitted)
  category?: CategoryId;                    // the coverage-grid category this anomaly belongs to
}
```

The interesting choice: **no `id` field**. The LLM doesn't assign UUIDs; the system does, at the `anomalyToInsight` boundary. This means an `Anomaly` is *almost* a value type — two anomalies with identical fields are interchangeable. That's deliberate: anomalies are throwaway, insights are addressable.

#### The enriched form — `Insight`

This is the same fact as `Anomaly`, but with everything the UI needs to render and link to it. It's what gets stored, retrieved by id, and serialized to JSON.

```ts
// lib/mcp/types.ts:36-62 (selected fields)
export interface Insight {
  id: string;
  timestamp: string;
  severity: Severity;
  headline: string;             // "mobile conversion dropped 18%"
  summary: string;              // one-line context
  metric: string;               // "conversion_rate"
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  scope: string[];              // ["mobile", "checkout step"]
  source: 'monitoring' | 'query';
  evidence?: { tool: string; result: unknown }[];
  impact?: string;
  // ── business-owner enrichments (Tier 1) ──
  revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' };
  affectedCustomers?: number; // denormalized from Diagnosis.affectedCustomers.count
  downstreamReady?: { diagnosis: boolean; recommendations: number };
  category?: CategoryId;
}
```

Four fields are *carried* from `Anomaly` (metric, scope, change, severity). Three are *added* by the system (id, timestamp, source). Two are *derived* (headline, summary — built from metric + change). And `affectedCustomers` is **denormalized from `Diagnosis`** — that's the one duplication that costs you something. Covered in `02-normalization-and-duplication.md`.

The `?` matters everywhere. Every new Tier 1 / Tier 2 field is optional so old demo snapshots still satisfy the type. Covered in `05`.

#### The one-per-insight — `Diagnosis`

The diagnostic agent's output. One per `Insight` (an insight has at most one diagnosis at a time; a re-run replaces it).

```ts
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

`Diagnosis` doesn't carry an `insightId` — it lives *inside* the `Investigation` envelope (`{ insightId, reasoning, diagnosis, recommendations }`, types.ts:132-141), which is what gets stored by `putInvestigation(sessionId, inv)`. So the foreign key from `Diagnosis` back to `Insight` lives on the *container*, not on the entity itself. That's a modeling shortcut: it means a free-floating `Diagnosis` literally cannot exist in the wire format.

#### The many-per-insight — `Recommendation`

The recommendation agent's output. 1–3 per `Insight`. **The only entity with its own `id` independent of `Insight.id`** — because the UI iterates over them and needs stable React keys.

```ts
// lib/mcp/types.ts:116-130
export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact; // string (legacy) or { range, rangeUsd?, assumption }
  confidence: 'high' | 'medium' | 'low';
  // ── business-owner enrichments ──
  effort?: 'low' | 'medium' | 'high';
  timeToSetUpMinutes?: number;
  readResultInDays?: number;
  prerequisites?: { label: string; satisfied: boolean }[];
  successMetric?: string;
}
```

`bloomreachFeature` is a **closed enum** (literal union), not a string. That's the integrity layer: the type system rejects "newsletter" at compile time. `estimatedImpact` is a **discriminated union by shape** — `string` for legacy snapshots, `{ range, rangeUsd?, assumption }` for new ones. The model accommodates two formats simultaneously because the demo snapshot has both. Covered in `05`.

#### The envelope — `AgentEvent` (discriminated union)

This isn't an entity — it's how entities travel. Eight variants, tagged by `type`.

```ts
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

The discriminator (`type`) is the type guard: once you check `e.type === 'insight'`, TypeScript narrows `e` to `{ type: 'insight'; insight: Insight }` and the rest of the fields are accessible. This is how the UI consumer at `app/page.tsx` and the cache replay at `app/api/agent/route.ts:64-82` can do `switch (e.type)` without `any`.

The wire encoding is one line of JSON per event (NDJSON):

```ts
// lib/mcp/events.ts:15-17
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

That `\n` is the entire framing protocol. No length prefix, no sentinel — `\n` delimits, JSON.parse handles the rest.

```
  Layers-and-hops — one Insight from agent to UI

  ┌─ Service ────────────┐  hop 1: anomaly emitted by LLM
  │  MonitoringAgent     │  ──────────────────────────────►
  └─────────┬────────────┘
            │ hop 2: anomalyToInsight() — adds id, timestamp
            ▼
  ┌─ State ──────────────┐
  │  putInsights(sid,..) │  hop 3: write to Map<sessionId, SessionFeed>
  └─────────┬────────────┘  ──────────────────────────────►
            │ hop 4: send({ type: 'insight', insight })
            ▼
  ┌─ Wire (NDJSON) ──────┐
  │  encodeEvent(...)    │  hop 5: JSON.stringify + '\n'
  └─────────┬────────────┘  ──────────────────────────────►
            │ hop 6: fetch reader splits on '\n'
            ▼
  ┌─ Client ─────────────┐
  │  React renders card  │  hop 7: switch(e.type) narrows the union
  └──────────────────────┘
```

### Move 3 — the principle

A data model in TypeScript types is **the same kind of contract a SQL schema is**, just enforced at a different time. The schema file says "rows must have these columns"; the type file says "values must have these fields." Both fail loudly when violated — one at write time, one at compile time. The difference is *what* you can enforce: types catch shape; SQL catches referential integrity, uniqueness, and constraints across rows. Knowing which one you're using is most of the modeling decision.

## Primary diagram

The model recap, with every entity, every relationship, and every storage tier in one frame.

```
  blooming insights — the data model, one frame

  ─── TYPE LAYER (lib/mcp/) ─────────────────────────────────────────────

       WorkspaceSchema  (1 per project, cached singleton)
            │
            │ informs the agent's prompt
            ▼
       Anomaly  ── (LLM emits raw)
            │
            │ anomalyToInsight() — adds id, timestamp, derived fields
            ▼
       Insight  ◄────────── 1 ────────► Diagnosis     (one per Insight)
            │                                ◄── lives inside Investigation
            │
            └────────── 1 ── many ────► Recommendation (1-3 per Insight)

       AgentEvent  (discriminated union — the wire envelope)
            │
            │ wraps any of: Insight | Diagnosis | Recommendation
            │ + reasoning_step | tool_call_* | done | error
            ▼

  ─── STATE LAYER (lib/state/) ──────────────────────────────────────────

       Map<sessionId, SessionFeed>      ← never cleared (concurrency)
            │
            └── SessionFeed
                  ├── insights:        Map<insightId, Insight>
                  ├── anomalies:       Map<insightId, Anomaly>      (parallel)
                  └── investigations:  Map<insightId, Investigation>

       Map<insightId, AgentEvent[]>     ← investigation cache, process-wide

  ─── WIRE LAYER (app/api/) ─────────────────────────────────────────────

       /api/briefing  → stream of AgentEvent (one per line, NDJSON)
       /api/agent     → stream of AgentEvent (one per line, NDJSON)

  ─── DISK ──────────────────────────────────────────────────────────────

       lib/state/demo-insights.json         { workspace, insights[], ... }
       lib/state/demo-investigations.json   { [insightId]: AgentEvent[] }
       .investigation-cache.json            dev-only, gitignored
       .auth-cache.json                     dev-only, gitignored
```

## Elaborate

The decision to model in types comes from the runtime: Vercel serverless instances are ephemeral, so there's no persistent process to host a real ORM, and the data lifecycle is *briefing-scoped* (a session runs the agents, sees the result, and the result is replaced on the next run). A SQL schema would buy you nothing the in-memory `Map` doesn't already give you — and would cost you a database connection, a migration framework, and a deploy story.

The cost is what `05-migrations-and-evolution.md` walks through: every field on `Insight` / `Diagnosis` / `Recommendation` has to be optional, because committed JSON snapshots are the long-lived data — and old snapshots have to keep validating. That discipline is the substitute for migrations. It works because the snapshot is read-only and append-only; it would not work for an app where users edit records.

The closest analog in your portfolio: **buffr's SQLite-as-canonical + Supabase-as-mirror** split. There, the canonical store has a schema (SQLite migrations). Here, the canonical "store" is the LLM's output shape, and the schema is the TypeScript type that validates it. Both projects answer the same question — *where does the truth live, and what protects it* — with different answers because the truth moves at different speeds.

For the relational-vs-document framing: this model is **document-shaped**. `Insight` carries its `evidence[]` and `change` as nested objects, not foreign keys. A relational rebuild would explode it into `insights`, `evidence`, `change`, `scope` tables and pay 4 joins to assemble one card. The document shape matches the access pattern (always read the whole insight, never just one field). That's the right call. Covered in `06`.

## Interview defense

**Q: Walk me through the entities and how they relate.**

> Five entities and one envelope. `WorkspaceSchema` is the project context — one per project, cached in module memory. The agents produce three: `Anomaly` (monitoring), `Diagnosis` (diagnostic), `Recommendation` (recommendation). The system derives `Insight` from `Anomaly` by adding an id and a timestamp; that's what gets stored. The join key everywhere is `Insight.id`. `Diagnosis` is one-per-insight, lives inside an `Investigation` envelope. `Recommendation` is many-per-insight and gets its own `id` because the UI iterates over it.
>
> The wire envelope is the discriminated union (`AgentEvent`) — eight variants tagged by `type`, encoded as one JSON object per line of NDJSON. The `type` field is what lets the consumer narrow the union without `any`.

```
   the join: Insight.id

   Insight ──┬── Diagnosis        (1:1, via Investigation)
             └── Recommendation[] (1:many, each w/ own id)
```

**Q: Why types instead of a SQL schema?**

> Three reasons, in order: (1) no long-lived process to host an ORM — serverless instances die; (2) data lifecycle is briefing-scoped, so the only thing that survives between runs is the committed demo snapshot; (3) the model is document-shaped, so a relational schema would be a 4-join walk to read one card. The cost: I can't enforce referential integrity at the DB layer because there is no DB layer. The substitute is the type guard (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` in `lib/mcp/validate.ts`) checked at JSON-parse time.

**Q: What's the load-bearing detail people miss?**

> `Insight.id` is generated **inside `anomalyToInsight`**, not by the LLM. That means the agent's output is identity-free — two anomalies with identical fields are interchangeable until the system stamps them. This is also why `getAnomaly(sessionId, insightId)` exists as a parallel map: the agent emits Anomaly, the system stores both forms keyed by the same id, so the diagnostic agent can re-investigate against the *original* Anomaly without re-deriving from the enriched Insight.

```
   anomalyToInsight is where identity is born

   LLM emits ─► Anomaly (no id)
                   │
                   │  crypto.randomUUID() ───► id
                   ▼
              Insight (has id, timestamp, headline)
                   │
                   ├──► Map<sid, SessionFeed>.insights.set(id, ...)
                   └──► Map<sid, SessionFeed>.anomalies.set(id, ...)
```

## See also

- `02-normalization-and-duplication.md` — which fields are stored twice and why (`affectedCustomers`, the `Insight`/`Anomaly` overlap).
- `04-transactions-and-integrity.md` — the type guards that enforce the contract at the JSON boundary.
- `06-access-patterns-and-storage-choice.md` — why the document shape and why no database.
