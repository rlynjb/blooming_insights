# The data model and its shape

**Industry name(s):** Schema · entity model · data model · TypeScript interface as schema · duck-typed interface (the `WorkspaceSchema` bridge)
**Type:** Industry standard · Language-agnostic · Project-specific (the typed-schema variant)

> The model. The **agent contract** is 8 TypeScript interfaces in `lib/mcp/types.ts` that pin every shape the four agents pass between each other — this file walks them. As of 2026-06-19, the Olist SQLite second domain is gone (PR #8, commit 62c24d7); the dual-derivation `WorkspaceSchema` story now bridges **Bloomreach** (live MCP) and the **in-process synthetic fixture** (`lib/data-source/synthetic-data-source.ts`). The bridge interface is the same `WorkspaceSchema` in `lib/mcp/schema.ts` derived two different ways: `bootstrapSchema(BloomreachDataSource)` from MCP introspection, and `syntheticWorkspaceSchema` — a top-level `const` literal in `synthetic-data-source.ts`. Same shape, two sources — the duck-typed-interface pattern, applied to "this is what an analyst-readable workspace looks like." The compiler enforces the model across module boundaries; the only seam where it can't see is the LLM output (file 04). The center of gravity for the agent contract is `Insight`, the enriched view of `Anomaly` the UI consumes. File 11 zooms in on the synthetic fixture as a data-modeling-for-test pattern.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This concept lives at the seam between the **MCP wrapper band** (where the upstream Bloomreach schema is parsed) and the **agent loop band** (where the typed shapes get produced, validated, and stored). The interfaces in `lib/mcp/types.ts` are the contracts every layer above this seam relies on; the parser in `lib/mcp/schema.ts` is how the *upstream* model crosses into the repo.

```
  Zoom out — where the data model lives

  ┌─ UI client band ───────────────────────────────────────────┐
  │  app/page.tsx, components/*                                 │
  │  reads:    Insight, Diagnosis, Recommendation               │
  │  the UI is a typed-shape consumer; never sees raw MCP data  │
  └──────────────────────────┬─────────────────────────────────┘
                             │  Insight[], Investigation
  ┌─ Route handler band ─────▼─────────────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                          │
  │  produces:  Insight[]  via anomalyToInsight()               │
  │  consumes:  Insight    via insightToAnomaly() (the leak)    │
  └──────────────────────────┬─────────────────────────────────┘
                             │  Anomaly[], Diagnosis, Recommendation[]
  ┌─ Agent loop band ────────▼─────────────────────────────────┐
  │  monitoring/diagnostic/recommendation/query .ts             │
  │  validates JSON-from-LLM with the three guards in           │
  │  lib/mcp/validate.ts            ★ THE SCHEMA MODEL ★        │
  │                                  (lib/mcp/types.ts)         │
  └──────────────────────────┬─────────────────────────────────┘
                             │  schemaSummary(WorkspaceSchema)
  ┌─ MCP wrapper band ───────▼─────────────────────────────────┐
  │  lib/mcp/schema.ts: parseWorkspaceSchema()                  │
  │  the UPSTREAM model — Bloomreach workspace, projected       │
  │  into one TypeScript shape this repo owns                   │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when an agent emits a JSON object and another agent or the UI consumes it, what guarantees the shape? Two layers: TypeScript at compile time (`types.ts`), runtime guards at the LLM seam (`validate.ts`). That's the schema model — interfaces above, type guards at the boundary, in-memory `Map`s as the store.

---

## Structure pass

**Layers.** Same four-layer stack: UI → route → agent loop → MCP wrapper. For data modeling, the load-bearing layer is the **agent loop band** — that's where the shapes are produced and validated. The UI is a downstream consumer; the route is a pass-through with one notable conversion (`insightToAnomaly`, the leak).

**Axis: schema ownership.** For each shape, which file owns its definition? This is the right axis because every data-modeling question reduces to ownership: where does the field list live, who's allowed to add to it, who has to be updated when it changes. Cost is wrong (shapes are free to define); failure is wrong (TypeScript catches most failures at compile time). Schema ownership pops the seams — where the owner is clear (`types.ts` owns every interface), the model is clean; where it's split (the Insight↔Anomaly round-trip), there's a leak.

**Seams.** Three matter here. **Seam 1: types.ts ↔ everything.** Single source of truth for the 8 interfaces. Clean ownership. **Seam 2: validate.ts ↔ LLM output.** The runtime narrowing at the boundary where TypeScript blinds itself (the model emits `string`, not a typed object). Clean ownership — three guards, one per shape the LLM produces. **Seam 3: state/insights.ts + api/agent/route.ts.** Both write field-copy logic for the `Insight↔Anomaly` round-trip. Not clean — the field list is implicitly co-owned. That's where the model fractures.

```
  Structure pass — schema ownership

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · Agent loop · MCP wrapper                    │
  │  the agent loop band is where shapes are produced         │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  schema ownership: which file owns this shape?            │
  │  owned cleanly = one file; co-owned = two = a leak        │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: types.ts ↔ everyone         ★ CLEAN (single source) │
  │  S2: validate.ts ↔ LLM output    ★ CLEAN (three guards)  │
  │  S3: state ↔ route field-copy    ★ LEAKED (file 02)      │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the model as a picture

You know how a DB schema is "a list of tables, each with columns and types, and FK arrows between them"? Same shape here, except the "tables" are TypeScript interfaces, the "columns" are properties, and the "FK arrows" are reference fields (`Anomaly.category` references a `CategoryId` enum; `Investigation.insightId` references an `Insight.id`). The store is in-memory `Map`s instead of relational tables, but the model-shape question — *which entities, with which fields, related how* — is the same.

```
  the model — entities and their relationships

       ┌────────────────────┐
       │  WorkspaceSchema   │  ← upstream, not owned (parsed from Bloomreach)
       │  (events, props,   │
       │   catalogs, totals)│
       └─────────┬──────────┘
                 │ projected into capability set, then…
                 ▼
       ┌────────────────────┐                ┌──────────────────────┐
       │  AnomalyCategory   │◄─────fk────────│  Anomaly             │
       │  (one of 10 ids)   │   category?    │  metric, scope[],     │
       └────────────────────┘                │  change, severity,    │
                                             │  evidence[], impact?  │
                                             │  history?, category?  │
                                             └──────────┬───────────┘
                                                        │ anomalyToInsight()
                                                        ▼
                                             ┌──────────────────────┐
                                             │  Insight             │
                                             │  id (uuid) ★PK★      │
                                             │  + all Anomaly fields│
                                             │  + 6 derived fields  │
                                             └──────────┬───────────┘
                                                        │ insightId
       ┌────────────────────┐                           ▼
       │  Diagnosis         │◄───────────────┐  ┌──────────────────────┐
       │  conclusion,       │                └──│  Investigation       │
       │  evidence[],       │                   │  insightId ★FK★      │
       │  hypotheses[]      │                   │  reasoning[],         │
       └────────────────────┘                   │  diagnosis,           │
       ┌────────────────────┐                   │  recommendations[]    │
       │  Recommendation    │◄──────────────────│                       │
       │  id, title,        │                   └──────────────────────┘
       │  bloomreachFeature,│
       │  steps[], impact   │
       └────────────────────┘
```

### Move 2 — the eight interfaces, one at a time

The model has 8 interfaces. Walk each by what role it plays. **One operation per part — never two interfaces at once.**

#### `WorkspaceSchema` — one interface, two derivations (duck-typed bridge)

`WorkspaceSchema` is a single TypeScript shape that two completely different domains derive into. The **Bloomreach** domain calls `bootstrapSchema(dataSource)` which fans out across the MCP introspection tools and projects the result into the typed shape. The **Synthetic** domain is the *literal constant* `syntheticWorkspaceSchema` exported from `lib/data-source/synthetic-data-source.ts` — no I/O, no DB read, no derivation: 10 events with their property lists, customer properties, two catalogs, totals, and a `dataHorizon` are baked into the source. Both produce the same shape; both feed the same `schemaCapabilities()` projection; the agent loop above this seam cannot tell which one it's reading.

```
  the duck-typed bridge — same shape, two domains

  ┌─ BLOOMREACH derivation ─────────────────────────────────┐
  │  bootstrapSchema(BloomreachDataSource)                    │
  │    list_cloud_organizations  ─┐                           │
  │    list_projects              │  4 MCP round-trips        │
  │    get_event_schema           ├─ parseWorkspaceSchema()   │
  │    get_customer_property_schema│                          │
  │    list_catalogs              │                           │
  │    get_project_overview     ──┘                           │
  └────────────┬────────────────────────────────────────────┘
               │
               ▼
       WorkspaceSchema {
         projectId, projectName,
         events: { name, properties[], eventCount }[],
         customerProperties[], catalogs[],
         totalCustomers, totalEvents, oldestTimestamp,
         dataHorizon?: { from, to, durationDays }      ← ★ Synthetic sets it
       }
               ▲
               │
  ┌─ SYNTHETIC derivation ──────────────────────────────────┐
  │  syntheticWorkspaceSchema   ← top-level const literal    │
  │    (lib/data-source/synthetic-data-source.ts L85–L108)   │
  │    projectId  = 'synthetic-blooming-project'              │
  │    projectName = 'Synthetic Blooming Workspace'           │
  │    10 events (with hand-authored property lists):         │
  │      'purchase'      52,840  total_price, product_id,     │
  │                              category, payment_type,      │
  │                              state, campaign_id,          │
  │                              voucher_code, inventory_level│
  │      'view_item'    241,900  product_id, category, state,│
  │                              device_type, referrer        │
  │      'session_start' 198,400 device_type, state,         │
  │                              utm_source, campaign_id,     │
  │                              landing_page                 │
  │      'cart_update'   91,360  product_id, category,        │
  │                              quantity, cart_value, state  │
  │      'checkout'      73,610  · 'search'        44,220    │
  │      'email_open'    38,540  · 'voucher_redeemed' 9,420  │
  │      'return'         4,860  · 'payment_failure' 2,360   │
  │    totalEvents     = 757,710                              │
  │    totalCustomers  = 126,420                              │
  │    dataHorizon: 2025-12-01 → 2026-06-01 (182 days)        │
  └────────────┬────────────────────────────────────────────┘
               │
               ▼ both feed:
       schemaCapabilities()  ← projects into Set<string>
       schemaSummary()       ← interpolated into agent prompts
```

The interesting part is `dataHorizon` — set on the synthetic branch, absent on Bloomreach. The synthetic window is fixed (we own the const); the Bloomreach branch is open-ended (live workspace, data flows in). The agent prompts read `dataHorizon` if present and anchor `time_range` inside it; without the field, the prompts fall back to "90-day windows of recent data." This is **forward-compatible extension** — the optional field carries domain-specific information the universal interface deliberately leaves open.

What breaks if `WorkspaceSchema` is wrong: the prompt the agent sees (`schemaSummary` interpolates this shape) becomes inconsistent with what the tools can actually query. Wrong on the Bloomreach side, the agent writes EQL against events that don't exist. Wrong on the synthetic side (specifically the event-property lists), the agent issues `execute_analytics_eql` calls referencing properties the dispatcher in `SyntheticDataSource.dispatch()` never returns — and every query collapses to the same fixed `analyticsResult` constant. File 11 walks the in-process synthetic fixture pattern; the rest of this section stays on the agent contract.

What breaks if a third derivation appears (say, a Shopify adapter): no compiler-level enforcement that the new derivation produces the same shape — only TypeScript's structural typing. Today there's no abstract base class, no Zod schema both branches conform to; the contract is "produce something with these fields." That's enough for two derivations; at three or more, the unenforced parallel structure would start to drift.

#### `CategoryId`, `AnomalyCategory`, `CategoryCoverage`, `CoverageItem`, `CoverageReport` — the schema-capability layer

Five tightly-coupled shapes that together form the **schema-aware coverage gate**. `CategoryId` is the closed enum (10 categories). `AnomalyCategory` is the row in the static registry. `CategoryCoverage` is a 3-state value. `CoverageItem` and `CoverageReport` are the per-briefing summary.

```
  the coverage chain

  CATEGORIES[]                    Set<string>
  (static registry,               (capabilities the workspace exposes)
   10 rows)                              │
        │                                │
        └──────────┬─────────────────────┘
                   │ coverageFor()  ← pure: subset check on requires + enriches
                   ▼
        CategoryCoverage  ('full' | 'limited' | 'unavailable')
                   │
                   │ wrapped per category
                   ▼
        CoverageItem[]  = CoverageReport
                   │
                   │ rendered as the coverage grid + injected into prompts
                   ▼
        UI tile + agent checklist
```

What breaks if `CategoryId` and the `CATEGORIES` registry drift apart: `runnableCategories()` returns rows the agent doesn't recognize, or skips rows the registry needs. The compiler enforces the `id: CategoryId` link.

#### `Anomaly` — what the monitoring agent emits

The output of the monitoring agent. **8 required fields, 3 optional.** Required: `metric`, `scope`, `change` (a 3-field nested object), `severity`, `evidence`. Optional: `impact`, `history`, `category`. This is the shape `isAnomalyArray` validates at the LLM seam.

```
  Anomaly — required vs optional, with what each is for

  required (compile-time + runtime enforced):
    metric         string         "purchase_revenue"
    scope          string[]       ["mobile", "checkout"]
    change         { value, direction, baseline }
    severity       'critical' | 'warning' | 'info' | 'positive'
    evidence       { tool, result }[]   ← what query found this

  optional (enrichments — newer; older snapshots lack them):
    impact         string         agent-written business-impact sentence
    history        number[]       12 weekly values for sparkline
    category       CategoryId     which coverage-grid tile fired this
```

What breaks if `evidence` is empty: `deriveInsightFields()` can't compute `revenueImpact`, the UI loses the dollar figure, but the Insight still renders. That's the optional-field design choice — fields degrade gracefully when absent.

#### `Insight` — the enriched view the UI consumes

The center of gravity. **8 required fields + 9 optional Tier-1 enrichments.** Most of the required fields are copies of `Anomaly` fields (severity, metric, change, scope) plus three stamped at write-time (`id`, `timestamp`, `source`). The Tier 1 enrichments (`revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `history`, `downstreamReady`) are *derived* — they exist so the UI doesn't have to recompute the same values on every render.

```
  Insight — three groups of fields

  COPIED FROM ANOMALY (via anomalyToInsight)
    severity, metric, change, scope, evidence?, impact?,
    history?, category?
    └─ this is the field-copy list. it lives in:
       1. the Insight interface itself  (truth source)
       2. anomalyToInsight()             (copies 8)
       3. insightToAnomaly()             (copies 4 ← THE LEAK)

  STAMPED AT WRITE TIME
    id            crypto.randomUUID()  ← PK
    timestamp     ISO string
    headline      derived from scope + metric + change
    summary       derived from metric + change
    source        'monitoring' | 'query'

  DERIVED (Tier 1 business-owner enrichments)
    revenueImpact?         { lostUsd, expectedUsd, currency }
    aov?                   { current, prior }
    funnel?                { view, cart, checkout, purchase }
    affectedCustomers?     number ← denormalized from Diagnosis
    history?               number[]
    downstreamReady?       { diagnosis, recommendations }
```

What breaks if you add a new field to `Anomaly` and forget to update `insightToAnomaly`: TypeScript will not catch it (the function returns an Anomaly literal with a *subset* of fields, which is a valid Anomaly). The round-trip silently drops the new field on the agent route path. That's the leak that file 02 unpacks.

#### `Diagnosis` — what the diagnostic agent emits

5 fields. Three required: `conclusion`, `evidence`, `hypothesesConsidered`. Two optional: `affectedCustomers`, `confidence`, `timeSeries`. The optional `confidence` is the interesting one — when the agent emits it, the UI uses it; when it doesn't, the UI derives it client-side from `hypothesesConsidered`. Both paths converge on the same enum.

#### `Recommendation` — what the recommendation agent emits

The richest shape. 6 required, 5 optional. The **canonical** shape; the spec contains two different `Recommendation` definitions, and the code uses the richer one with a comment naming the choice (`lib/mcp/types.ts` L114–L130). That comment is itself a schema-evolution artifact — the spec drifted, the code picked, the comment names the choice.

```
  Recommendation — the canonical (richer) shape, with the dual-spec context

  the spec contains TWO definitions of Recommendation:
    1. "data model" section            ← simpler, older
    2. "recommendation agent" section  ← richer, current

  the comment in types.ts L114 names the choice:
    "Use this RICHER one … everywhere — it has `id`, `steps`,
     and the 5-member `bloomreachFeature` union."

  required (compile + runtime):
    id, title, rationale,
    bloomreachFeature: 'scenario'|'segment'|'campaign'|'voucher'|'experiment',
    steps[], estimatedImpact, confidence

  optional (Tier 1 enrichments):
    effort, timeToSetUpMinutes, readResultInDays,
    prerequisites[], successMetric
```

What breaks if a future spec edit re-introduces the simpler shape: the comment is the only thing flagging the divergence. There's no compile-time enforcement that the spec and the code agree — the spec is markdown, the code is TypeScript. File 05 covers this as a "migration" concern (the spec IS the schema in a soft sense; the code has to drift consciously).

#### `ToolCall`, `ReasoningStep` — the trace shape

Two trace shapes used by `Investigation.reasoning[]`. `ToolCall` records what a tool call did (agent, name, args, result/error, durationMs). `ReasoningStep` wraps a `ToolCall` with a step kind (`thought | tool_call | hypothesis | conclusion`). Both are append-only; they're never updated.

#### `Investigation` — the full agent run

The final aggregate. 4 fields: `insightId` (FK), `reasoning[]`, `diagnosis`, `recommendations[]`. Stored under `insightId` in the `investigations` Map. **Note:** `Investigation.diagnosis` is a *narrower* shape than the standalone `Diagnosis` interface — it has only `conclusion`, `evidence`, and `hypothesesConsidered` as `string[]`. This is a denormalization smell (file 02): the same data, two shapes, with the wider one losing fidelity when it's nested.

### Move 3 — the principle

The model is what every other module relies on. When it's a single source of truth (`types.ts`), every boundary is clean. When two files implicitly co-own a piece of it (the field-copy list), every change has to land in N files at once and TypeScript can't help. The test: **for any field, can you point at one file where adding it lands?** If yes, the model is clean. If the answer is "you add it to the interface, but you also have to remember to update X and Y," the model has fractured.

---

## Primary diagram

The full picture — the 8 interfaces, with the upstream model on top, the owned model in the middle, and the leak boundary at the bottom.

```
  the model — full recap

  ┌─ UPSTREAM ───────────────────────────────────────────────┐
  │                                                            │
  │   WorkspaceSchema    ← parseWorkspaceSchema (pure)         │
  │   ↓ schemaCapabilities                                     │
  │   Set<string>        ← coverageFor + AnomalyCategory       │
  │                                                            │
  └────────────────┬─────────────────────────────────────────┘
                   │ checklist injected into monitoring prompt
                   ▼
  ┌─ OWNED (types.ts is the single source) ─────────────────┐
  │                                                            │
  │   Anomaly  ── anomalyToInsight ──►  Insight                │
  │      ▲                                  │                  │
  │      │                                  │ stored by id     │
  │      │ insightToAnomaly (LOSSY)         ▼                  │
  │      │                          insights: Map<id, Insight> │
  │      │                          anomalies: Map<id, Anomaly>│
  │      │                                                     │
  │   Diagnosis  ───┐                                          │
  │                  ├──► Investigation { reasoning[],         │
  │   Recommendation──┘                    diagnosis,           │
  │                                         recommendations[] } │
  │                                          │                  │
  │                                          ▼                  │
  │                               investigations: Map<iid, Inv> │
  │                                                            │
  │   ToolCall, ReasoningStep — embedded in Investigation       │
  │                                                            │
  └────────────────┬─────────────────────────────────────────┘
                   │ all reads at the LLM boundary
                   ▼
  ┌─ VALIDATE.TS (the runtime narrowing) ───────────────────┐
  │   isAnomalyArray, isDiagnosis, isRecommendationArray      │
  │   (the only schema check TypeScript can't do on its own)  │
  └──────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The 8 interfaces, with the canonical comment

```
lib/mcp/types.ts  (lines 36–141)

  export interface Insight {
    id: string;                              ← PK, stamped by crypto.randomUUID
    timestamp: string;
    severity: Severity;
    headline: string;
    summary: string;
    metric: string;
    change: { value: number; direction: 'up' | 'down'; baseline: string };
    scope: string[];
    source: 'monitoring' | 'query';
    evidence?: { tool: string; result: unknown }[];   ← optional, agent-emitted
    impact?: string;                                   ← optional, agent-emitted
    // ── business-owner enrichments (Tier 1). All optional + derived from the
    //    existing evidence, so older snapshots still validate and render. ──
    revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' };
    aov?: { current: number; prior: number };
    funnel?: { view: number; cart: number; checkout: number; purchase: number };
    affectedCustomers?: number;
    history?: number[];
    downstreamReady?: { diagnosis: boolean; recommendations: number };
    category?: CategoryId;
  }
       │
       │  the "All optional + derived from the existing evidence, so older
       │  snapshots still validate and render" comment IS the migration policy
       │  for this interface. when a new field is added, it goes here as
       │  optional. old data still validates. file 05 walks this.
       └──
```

### The capacity-set projection (the upstream → owned bridge)

```
lib/agents/categories.ts  (lines 116–127)

  export function schemaCapabilities(schema: {
    events: { name: string; properties: string[] }[];
    catalogs?: { name: string }[];
  }): Set<string> {
    const set = new Set<string>();
    for (const e of schema.events ?? []) {
      set.add(e.name);                          ← event names as bare strings
      for (const p of e.properties ?? [])
        set.add(`${e.name}.${p}`);              ← properties as "event.prop"
    }
    for (const c of schema.catalogs ?? [])
      set.add(`catalog:${c.name}`);             ← catalogs as "catalog:name"
    return set;
  }
       │
       │ this is the model-level translation: the upstream nested
       │ WorkspaceSchema becomes a flat Set<string> the coverage gate
       │ can test membership against. the namespaced keys ("event.prop",
       │ "catalog:name") are the shape; they're THE schema for the gate.
       └──
```

### Where the leak sits in code (UPDATED — partly retired)

Both conversion functions now live in `lib/state/insights.ts` — `anomalyToInsight` at L25–L45, `insightToAnomaly` at L53–L55. The doc comment on `insightToAnomaly` names the deliberate drop explicitly: "Intentionally drops evidence/impact/history/category — the agent loop only needs metric/scope/change/severity to investigate; the rest is regenerated downstream." A round-trip test lives in `test/state/insights.test.ts`. The point for *this* file: the `Insight` interface is still the schema; the two functions are now colocated implementations of the field-copy. File 02 walks the updated status (the schema-side leak is retired; a wire-format leak is still live).

---

## Elaborate

The interesting structural choice here is that **`types.ts` carries no logic** — it's pure shape. Every type guard, every conversion, every derivation lives elsewhere. This is the right call for a small TypeScript repo: the file is read as a reference, not maintained as code. When a new field is added, the diff is one line in the interface (and *should* be one line in each conversion function, but the leak makes that two).

The repo doesn't use a schema-as-code tool (no Zod, no io-ts, no JSON Schema). The argument for adding one would be that the runtime guards in `validate.ts` are hand-rolled (every new field is a new line in `isAnomalyArray`); a schema-as-code tool would derive both the TypeScript type and the runtime validator from one source. The argument against: this repo has 3 guards (anomaly, diagnosis, recommendation) and they're 50 lines total. The complexity tax of Zod would exceed the maintenance saving until the count grows.

The dual-shape `Diagnosis` (full vs nested-in-Investigation) is the most surprising thing in the model. `Investigation.diagnosis` is `{ conclusion, evidence: string[], hypothesesConsidered: string[] }` — three string arrays. The standalone `Diagnosis` is richer (`hypothesesConsidered` is an object array with `{ hypothesis, supported, reasoning }`). The nested form is a *narrower projection* of the wider type. Two options to clean this up: (a) make `Investigation.diagnosis: Diagnosis` and accept the breaking change in stored data; (b) keep the projection but name it `DiagnosisSummary` so it doesn't look like a typo. The current state — same name, different shape — is the worst of both worlds.

## Interview defense

**Q: What's the schema in blooming insights?**
A: It's typed interfaces, not a relational schema. The 8 interfaces in `lib/mcp/types.ts` are the model — `Insight`, `Anomaly`, `Diagnosis`, `Recommendation`, plus supporting shapes (`WorkspaceSchema`, `CoverageReport`, `ToolCall`, `Investigation`). The store is three in-memory `Map`s in `lib/state/insights.ts`. The compiler enforces the model at every module boundary. The one place it can't see is the LLM seam — the model emits JSON-as-string — so three type guards in `lib/mcp/validate.ts` re-narrow at that boundary.

**Q: Walk me through the Insight↔Anomaly relationship.**
A: `Anomaly` is the monitoring agent's output. `Insight` is the UI's input — same data plus derived fields (`headline`, `summary`, `revenueImpact`, etc.) plus identity (`id`, `timestamp`). `anomalyToInsight` in `lib/state/insights.ts` (L8–L28) does the forward conversion — copies 8 fields, derives 5. The reverse is in `app/api/agent/route.ts` (L29–L31) and copies only 4 — it drops `evidence`, `impact`, `history`, and `category`. The reverse exists because the browser sends the `Insight` shape to the agent route and the diagnostic agent wants `Anomaly`. The leak: the field-copy list lives in three files, no compiler enforcement that they agree.

```
  diagram while you talk

  types.ts        Anomaly { metric, scope, change, severity, evidence,
                            impact?, history?, category? }
                  Insight { id, timestamp, severity, headline, summary,
                            metric, change, scope, source,
                            evidence?, impact?, history?, category?,
                            + 6 derived Tier 1 fields }

  state/insights.ts  anomalyToInsight(a) → copies 8 + derives 5
  api/agent/route.ts insightToAnomaly(i) → copies 4, DROPS 4 ★ leak
```

## See also

- `02-normalization-and-duplication.md` — the Insight↔Anomaly story, now partly fixed; the wire-format leak that still lives.
- `04-transactions-and-integrity.md` — what `validate.ts` does at the LLM seam; what the session-scoped `Map`s now enforce.
- `05-migrations-and-evolution.md` — how the typed schema evolves under git.
- `08-the-olist-relational-schema.md` — RETIRED. Historical pattern.
- `09-deterministic-synthetic-data.md` — RETIRED. The pattern still applies (see file 11); the mulberry32/SQLite anchors are gone.
- `11-in-process-synthetic-fixture.md` — the SyntheticDataSource as a data-modeling-for-test pattern: same agent-facing interface as the live adapter, in-process deterministic data.
- `study-software-design/audit.md#information-hiding-and-leakage` — the original framing of the Insight↔Anomaly leak as a hiding/leakage problem.

---
Updated: 2026-06-16 — added `WorkspaceSchema` dual-derivation section; flagged the leak as code-fixed (colocated + tested) with the wire-format follow-on still live.
Updated: 2026-06-19 — swapped Olist for the in-process synthetic fixture as the second derivation of `WorkspaceSchema`; anchored event/property lists to `lib/data-source/synthetic-data-source.ts`; added file-11 cross-link.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
