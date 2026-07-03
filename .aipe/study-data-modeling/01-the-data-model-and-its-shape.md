# 01 — The data model and its shape

**Entity-relationship map · Case B (no relational DB) · zoom-out**

## Zoom out — where this concept lives

Every data-modeling audit starts the same way: draw the entities and their relationships. For a normal app that's an ERD from `schema.sql`. Here, there's no schema.sql, so the drawing has to come from the *TypeScript types* + the *tier they live in*. That's the whole zoom-out for this file.

```
  Zoom out — the whole system, one picture

  ┌─ Client (browser) ─────────────────────────────────────────┐
  │  React components                                           │
  │     ↓ persist                                               │
  │  localStorage[bi:mode, bi:mcp_config]                       │  ← tier 1
  │  sessionStorage[bi:insight:{id}]                            │
  └─────────────────────────┬───────────────────────────────────┘
                            │  HTTP (fetch + x-bi-mcp-config header)
  ┌─ Service (Next.js route handlers) ─▼───────────────────────┐
  │  ★ THIS FILE draws all of the below as one ERD-style map ★  │
  │                                                             │
  │  in-memory Map<sessionId, SessionFeed>       ← tier 2       │
  │     ├── insights:       Map<id, Insight>                    │
  │     ├── anomalies:      Map<id, Anomaly>                    │
  │     └── investigations: Map<insightId, Investigation>       │
  │                                                             │
  │  signed cookie: bi_auth (AES-256-GCM)         ← tier 3      │
  │     └── SessionAuthState (tokens, PKCE verifier, DCR info)  │
  │                                                             │
  │  dev-only files: .auth-cache.json,            ← tier 4      │
  │                  .investigation-cache.json                  │
  │                                                             │
  │  eval subsystem (separate concern):                         │
  │     GoldenCase → Receipt → Baseline (git-committed) ← tier 5 │
  │     Worksheet ↔ Agreement (calibration artifacts)           │
  └─────────────────────────────────────────────────────────────┘
```

The concept for this file: **the data model here is a lattice, not a schema.** Every entity has a home tier, and every relationship crosses at most one tier boundary. Draw the lattice, then draw the entities inside it — that's the ERD.

## The structure pass — layers, one axis, seams

Before the ERD walk, hold one question constant across the tiers: **who owns the write?**

```
  Axis: "who has write authority for this fact?"

  ┌── tier 1: localStorage / sessionStorage ──┐
  │  the BROWSER owns the write               │  → user-agent controls durability
  └─────────────┬─────────────────────────────┘
                │  seam A (crosses the network)
  ┌── tier 2: in-memory Map (server) ────────▼┐
  │  the running REQUEST owns the write       │  → dies with the instance
  └─────────────┬─────────────────────────────┘
                │  seam B (survives instance death)
  ┌── tier 3: signed cookie (bi_auth) ───────▼┐
  │  the SERVER writes, the BROWSER carries    │  → who owns it split
  └─────────────┬─────────────────────────────┘
                │  seam C (crosses restart)
  ┌── tier 4: dev-only file ─────────────────▼┐
  │  the DEV SERVER owns the write            │  → gone in prod
  └─────────────┬─────────────────────────────┘
                │  seam D (crosses deploys)
  ┌── tier 5: git-committed JSON ────────────▼┐
  │  the ENGINEER (you) owns the write        │  → durable across everything
  └───────────────────────────────────────────┘
```

Every seam is a place the *write-authority answer flips*. That's what makes them load-bearing: the moment a fact needs to survive a seam, it has to be *copied* into the next tier, and that copy is where duplication risk (file 02) lives.

## How it works

### Move 1 — the mental model

Think of it like the layered state you already know from a React app: `useState` inside a component (dies with unmount), `useContext` at the tree root (dies on refresh), `localStorage` (survives refresh, dies on browser data clear). Same pattern, longer stack. What React calls "component state → context → localStorage," this app calls "in-memory Map → cookie → localStorage → dev file → git." Each rung is more durable, harder to write, and more explicit about ownership.

```
  The pattern — durability ladder, ranked

  short-lived   ┌── in-memory Map (per warm instance) ──┐   fast, disposable
      ▲         │  Map<sessionId, SessionFeed>          │
      │         └───────────────────────────────────────┘
      │         ┌── localStorage / sessionStorage ──────┐
      │         │  bi:mode, bi:mcp_config, bi:insight:* │
      │         └───────────────────────────────────────┘
      │         ┌── signed cookie (bi_auth) ────────────┐
      │         │  encrypted SessionAuthState per sess. │
      │         └───────────────────────────────────────┘
      │         ┌── dev-only file (.auth-cache.json) ───┐
      │         │  gitignored, dev-server-only          │
      │         └───────────────────────────────────────┘
      ▼         ┌── git-committed JSON ─────────────────┐   slow, permanent
  long-lived    │  eval/baseline.json, demo-*.json      │
                └───────────────────────────────────────┘
```

Higher up = the *hot path* fact ("the current briefing feed"). Lower down = the *durable proof* fact ("what the eval baseline was on 2026-07-03"). The rung tells you a *ton* about the fact's lifecycle without opening any code.

### Move 2 — the entities, one at a time

Each sub-heading below picks one entity, names its tier, and shows the shape.

#### `Insight` — the primary feed entity (tier 2, in-memory)

The insight is what the user actually sees on the home feed. Big shape — 15 fields including three optional enrichment groups.

The industry term for what's happening here is a *denormalized read model*: it holds copies of facts that live authoritatively elsewhere (the raw `Anomaly` in the same map, the `Diagnosis` yet to be computed) so the client render doesn't have to fan out.

Real code (`lib/mcp/types.ts:36-62`) — annotated:

```typescript
export interface Insight {
  id: string;                                        // ← primary key (crypto.randomUUID)
  timestamp: string;                                 // ← ISO 8601
  severity: Severity;                                // ← 4-value discriminant
  headline: string;                                  // ← rendered directly, no i18n
  summary: string;
  metric: string;
  change: { value: number; direction: 'up'|'down'; baseline: string };
  scope: string[];                                   // ← ["mobile", "checkout step"]
  source: 'monitoring' | 'query';                    // ← origin discriminant
  evidence?: { tool: string; result: unknown }[];    // ← denormalized from Anomaly
  impact?: string;                                   // ← denormalized from Anomaly
  revenueImpact?: { lostUsd; expectedUsd; currency };// ← Tier 1 enrichment
  aov?: { current: number; prior: number };          // ← Tier 1 enrichment
  funnel?: { view; cart; checkout; purchase };       // ← Tier 1 enrichment
  affectedCustomers?: number;                        // ← denormalized from Diagnosis
  history?: number[];                                // ← Tier 2 sparkline
  downstreamReady?: { diagnosis; recommendations };  // ← pre-computed availability
  category?: CategoryId;                             // ← denormalized from Anomaly
}
```

The load-bearing part: **the fields marked "denormalized from" are copies.** `Insight.evidence` is copied from `Anomaly.evidence`; `Insight.impact` is copied from `Anomaly.impact`; `Insight.affectedCustomers` is copied from `Diagnosis.affectedCustomers.count`. That copy happens once — at `anomalyToInsight()` in `lib/state/insights.ts:25-45` — and is never re-synced. If the underlying `Anomaly` were mutated, the `Insight` wouldn't know. In this app that never happens (writes are always "replace whole feed"), so the risk is latent, not live. File 02 walks it in detail.

#### `Anomaly` — the monitoring agent's raw output (tier 2, in-memory)

The `Anomaly` is what the monitoring agent emits *before* the coordinator lifts it into an `Insight`. Same map, same session, different sub-map.

Shape (`lib/mcp/types.ts:83-92`):

```typescript
export interface Anomaly {
  metric: string;
  scope: string[];
  change: { value: number; direction: 'up'|'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;
  history?: number[];
  category?: CategoryId;
}
```

The `Anomaly` has **no primary key**. It's stored in `SessionFeed.anomalies: Map<string, Anomaly>` keyed by the `Insight.id` that was minted for it (see `putInsights` at `lib/state/insights.ts:57-71`, `if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx])`). That's fine, but it means the `Anomaly` map is *dependent* on the `Insight` map — if you cleared insights without clearing anomalies, the anomaly rows would be orphans. `putInsights` clears both together (line 65-66) and that's the invariant the shape depends on.

#### `Investigation` — the deep-dive artifact (tier 2, in-memory + tier 4 dev cache)

Investigation is the diagnosis + recommendations for one insight. It lives in the same session `Map`, but *also* has a second home in `.investigation-cache.json` (dev-only) and a third in `lib/state/demo-investigations.json` (committed demo seed).

Shape (`lib/mcp/types.ts:132-141`):

```typescript
export interface Investigation {
  insightId: string;                                 // ← foreign key back to Insight
  reasoning: ReasoningStep[];
  diagnosis: {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: string[];                  // ← DIFFERENT shape than
                                                     //   Diagnosis.hypothesesConsidered!
  };
  recommendations: Recommendation[];
}
```

Watch the two-source-of-truth risk: `Investigation.diagnosis.hypothesesConsidered` is `string[]`, while `Diagnosis.hypothesesConsidered` is `{hypothesis, supported, reasoning}[]`. Same field name, different shape, different file. That's a modeling debt file 07 marks as a red flag.

The three-source persistence chain is worth showing as a diagram — it's how the app achieves demo-mode fallback without a database:

```
  Investigation lookup — the three-source read chain

  ┌── read: getCachedInvestigation(insightId) ────┐
  │                                                │
  │  1. mem.get(insightId)          ← in-process   │  fastest
  │     ↓ miss                                     │
  │  2. .investigation-cache.json   ← dev only     │  survives HMR
  │     ↓ miss OR in production                    │
  │  3. demo-investigations.json    ← git-committed│  always available
  │     ↓ miss                                     │
  │  4. null                                       │
  └────────────────────────────────────────────────┘

  writes go to memory always; to the dev file in development;
  never to the committed demo (that's a hand-edited seed).
```

Code lives at `lib/state/investigations.ts:22-28`. This is a real modeling decision: the same entity (`AgentEvent[]` per `insightId`) has *three homes*, and the read walks them in durability order. It's a poor person's cache hierarchy — L1 (in-memory), L2 (dev file), L3 (committed seed) — expressed as three JSON sources.

#### `SessionAuthState` — the OAuth state (tier 3, encrypted cookie)

Shape (`lib/mcp/auth.ts:12-17`):

```typescript
interface SessionAuthState {
  clientInformation?: OAuthClientInformationMixed;   // ← from Dynamic Client Reg
  tokens?: OAuthTokens;                              // ← the actual bearer + refresh
  codeVerifier?: string;                             // ← PKCE
  state?: string;                                    // ← OAuth CSRF nonce
}
type Store = Record<string, SessionAuthState>;       // ← keyed by app sessionId
```

The critical modeling call: **the entire `Store` fits in one cookie.** In production the `Store` is JSON-serialized, AES-256-GCM encrypted, base64url-encoded, and stuffed into `bi_auth`. Every request decrypts the whole store, mutates it in an `AsyncLocalStorage` context, then re-encrypts and re-sets on the way out (`lib/mcp/auth.ts:86-104`). That works because there's only ever one entry per browser — the `sessionId` inside is the app's own, and the cookie carries state for that one session only.

If two sessions ever shared one cookie you'd overwrite each other. The `SameSite=None` config (`lib/mcp/auth.ts:97-98`) makes this a real concern to reason about — file 04 walks the integrity story.

#### `McpConfigOverride` — the wire-format entity (tier 1 localStorage + wire)

New in Session D. Persisted in `localStorage['bi:mcp_config']`, base64-JSON-encoded onto every fetch as the `x-bi-mcp-config` header, decoded server-side and merged over env defaults.

Shape (`lib/mcp/config.ts:27-31`):

```typescript
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;      // 'oauth-bloomreach' | 'bearer' | 'anonymous'
  bearerToken?: string;
}
```

All fields optional — that's the "partial override merges into env" contract. The shape is *validated on both ends* (`isMcpConfigOverride` at `lib/mcp/config.ts:50-60`), which is the strongest integrity story in the codebase. File 04 gives it the walkthrough.

#### `GoldenCase` / `Receipt` / `Baseline` — the eval entities (tier 5, git-committed)

These are the durable, git-committed shapes. The chain:

```
  Eval subsystem — the durable data flow

  ┌── GoldenCase[10]  ────┐    hand-written, kebab-case-id, committed
  │  eval/goldens/*.ts    │    signalClass ∈ {has-signal, partial-signal,
  └──────────┬────────────┘                   no-signal, positive}
             │  run.eval.ts   ← reads goldens, drives agents
             ▼
  ┌── Receipt[per run × 10]  ┐  denormalized per case: anomaly + tool calls +
  │  eval/receipts/          │  diagnosis + judgments + durations + cost
  │  {case}-{runId}.json     │  ~400-line JSON blob per file
  └──────────┬───────────────┘
             │  baseline.eval.ts   ← aggregates dims across cases
             ▼
  ┌── Baseline (one file) ─┐  aggregate: perDimensionPassRate,
  │  eval/baseline.json    │  perDimensionScoreCounts, verdictDistribution
  └────────────────────────┘  committed; regression-gate reference
```

Real numbers as of this writing: 10 goldens × 3 runs = 28 receipt files in `eval/receipts/`, plus one committed `baseline.json` from run `2026-07-03T04-08-28-644Z`. The receipt shape is *the* denormalized big-blob — everything for one case (anomaly, tool calls, tool results, diagnosis JSON, judge verdicts, durations, model IDs) in one file. That's an explicit tradeoff: it makes each receipt self-contained (open one file, see the whole story) at the cost of duplicating the anomaly across every receipt for the same case. Discussed in file 02.

### Move 3 — the principle

The principle: **when you don't have a database, your type system becomes your schema.** Every persistent fact is defined by a TypeScript interface, validated by a type guard, and homed in a tier. The ERD is the *tier ladder* × the *type registry*. The moment you can draw both together, you can reason about the whole persistence story.

The strong version of this principle: *tier ladder + type unions + validation guards ≥ a database schema*. The weak version: without discipline, you get shape drift across tiers (see the `Diagnosis` vs `Investigation.diagnosis` mismatch above).

## Primary diagram — the full ERD

The one recap picture the reader returns to. Every entity, every foreign key, every tier band.

```
  Blooming Insights — the schema, as a lattice

  ┌─────────────────────────── tier 1: browser storage ──────────────────────────┐
  │                                                                              │
  │   ┌──── localStorage ────┐        ┌──── sessionStorage ────┐                 │
  │   │  bi:mode             │        │  bi:insight:{id}       │                 │
  │   │  bi:mcp_config       │        │    → Insight (JSON)    │                 │
  │   │    → McpConfigOverride│       │  bi:step:{id}:*        │                 │
  │   └──────────────────────┘        └────────────────────────┘                 │
  └──────────────────────────────────┬──────────────────────────────────────────┘
                                     │  x-bi-mcp-config header (base64 JSON)
  ┌──────────────────────────── tier 2 + 3: server ─▼────────────────────────────┐
  │                                                                              │
  │   Map<sessionId, SessionFeed>  ─────  the primary hot-path store             │
  │   ┌────────────────────────────────────────────────┐                         │
  │   │ SessionFeed {                                   │                        │
  │   │   insights:       Map<id, Insight>  ────────┐   │                        │
  │   │   anomalies:      Map<id, Anomaly>  ────┐   │   │                        │
  │   │   investigations: Map<insightId, Inv.>  │   │   │                        │
  │   │ }                                        │   │   │                        │
  │   └──────────────────────────────────────────┼───┼──┘                         │
  │                                              │   │                            │
  │   Insight ──id────► Anomaly (siblings)  ◄────┘   │                            │
  │       ▲                                          │                            │
  │       │ FK: insightId                            │                            │
  │       │                                          │                            │
  │   Investigation                                  │                            │
  │     └── reasoning: ReasoningStep[]               │                            │
  │     └── diagnosis: { conclusion, evidence,       │                            │
  │                       hypothesesConsidered: str[]}◄─── shape drift vs         │
  │     └── recommendations: Recommendation[]        │      lib/mcp/types Diagnosis│
  │                                                  │                            │
  │   ┌── tier 3: bi_auth cookie (AES-256-GCM) ─────▼──┐                          │
  │   │  Store = Record<sessionId, SessionAuthState>    │                          │
  │   │    { clientInformation, tokens, codeVerifier,   │                          │
  │   │      state }                                    │                          │
  │   └─────────────────────────────────────────────────┘                          │
  └──────────────────────────────────┬───────────────────────────────────────────┘
                                     │  fallback reads on cache miss
  ┌───────────────────── tier 4 (dev): file system ─▼──────────────────────────┐
  │  .auth-cache.json           mirrors bi_auth store, dev-only                 │
  │  .investigation-cache.json  Record<insightId, AgentEvent[]>, dev-only       │
  └──────────────────────────────────┬───────────────────────────────────────────┘
                                     │  fallback reads on ALL misses
  ┌───────────────────── tier 5: git-committed JSON ▼─────────────────────────┐
  │  lib/state/demo-insights.json         seed for demo mode                    │
  │  lib/state/demo-investigations.json   seed for demo mode                    │
  │  public/demo/*.json                   baked golden fixtures                 │
  │  eval/baseline.json                   regression-gate reference             │
  │  eval/goldens/*.ts                    10 GoldenCase entities                │
  │  eval/receipts/*.json                 28 committed receipts (Case × Run)    │
  │  eval/calibration/*.json              worksheet + agreement per calib pass  │
  └────────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Where this shape comes from: the app is a hackathon build (June 2026 deadline in the spec) that lived its whole life as a serverless Next.js app on Vercel. No relational database was ever added because the domain didn't demand one — the *briefing* is ephemeral (a new one each morning), the *deep dive* is short-lived (one session), and the *durable* stuff (evals, demo fallback) can be committed as JSON. That decision — "keep everything at the type-system level, use tiers instead of tables" — is the load-bearing choice this whole guide walks.

Where it stops working: the moment a *user* accumulates history that outlives a session (bookmarks, subscriptions, saved investigations), the tier ladder runs out. Tier 2 dies with the instance; tier 3 dies at 10-day cookie expiry or on `AUTH_SECRET` rotation; tier 4 doesn't exist in production. There's no per-user durable tier, which means adding user-scoped history means adding tier 6: a real database. That's the next architectural inflection point.

Related reading: *A Philosophy of Software Design* on information hiding (Ch. 5) — the tier-ladder is information-hiding for time. Each tier hides the fact from queries against tiers below it. Also worth: Fowler's *Patterns of Enterprise Application Architecture* on the *Data Mapper* pattern — the `anomalyToInsight` / `insightToAnomaly` pair in `lib/state/insights.ts:25-55` is a hand-rolled data mapper between two shapes of the same fact.

## Interview defense

### Q1 — "you don't have a database. Talk me through your data model."

Model answer, ~90 seconds:

> Right. There's no relational DB in this codebase. What I have instead is a **five-tier persistence lattice**, and my entity model is defined by TypeScript interfaces that live in one of those tiers. Let me sketch it.

```
  the five tiers, ranked

  tier 1 → localStorage / sessionStorage           (browser, ~forever)
  tier 2 → Map<sessionId, SessionFeed> in memory   (server, until instance cools)
  tier 3 → bi_auth cookie (AES-256-GCM)            (server writes, browser carries, ~10 days)
  tier 4 → dev-only JSON files                     (dev server only, until deleted)
  tier 5 → git-committed JSON                      (permanent — baseline, demo, goldens)
```

> My primary entity is `Insight` — that's the feed item. It lives in tier 2, keyed by a UUID, inside a per-session sub-map so warm serverless instances don't leak between users. It has a sibling `Anomaly` — the raw monitoring output before I lift it into an Insight — also in tier 2. And it has a foreign-key-style relationship to `Investigation`, which lives in tier 2 with fallbacks to tier 4 and tier 5.
>
> The reason it works without a real DB: the domain is ephemeral. Briefings are per-day, investigations are per-session, and the durable stuff (evals, demo fallback) is small enough to commit as JSON. The moment I add per-user persistent history, the lattice runs out and I need a tier 6 — a real DB.

Anchor: "five tiers × the type registry."

### Q2 — "your `Insight` denormalizes a lot from `Anomaly`. How do you keep them consistent?"

Model answer:

> I don't, really, and that's fine given the write pattern. Insights and Anomalies are both stored in `SessionFeed`, both cleared together in `putInsights`, and never mutated after write. So the copy from `Anomaly.evidence` into `Insight.evidence` happens once, at `anomalyToInsight()`, and stays consistent because nothing edits either side.
>
> If I *did* start mutating them, I'd have to either normalize (store `evidence` on `Anomaly` only, join at read) or add a version field and enforce joint updates. Right now the invariant is enforced by the write path — replace-whole-feed atomically.

```
  invariant: Insight.evidence === Anomaly.evidence, always

  write path (enforcer):        Anomaly[]  ──anomalyToInsight──►  Insight[]
                                    │                                │
                                    └───────── same putInsights ─────┘
                                        (clears both, sets both)

  no partial-update path exists → invariant can't drift
```

Anchor: "invariant enforced by the write shape."

### Q3 — "how do you version schemas without migrations?"

> I don't have a versioning story, and that's a real gap. What I have is **optionality as forward compatibility**: every new field on `Insight` is `?`, so old snapshots in `lib/state/demo-insights.json` still validate. That's not a migration strategy — it's *lucky-additive*. The moment I need a *destructive* change (rename `impact` to `businessImpact`, change `history: number[]` to `history: {ts, val}[]`), the committed demo JSONs break with no migration path.
>
> The fix, when it becomes real: a `schemaVersion` field on `Insight`, and a `migrateInsight(anyShape) → InsightV{n}` at the read boundary. File 05 in my study covers this.

Anchor: "optional fields = forward compat; not a strategy for destructive change."

## See also

- `02-normalization-and-duplication.md` — where the `Insight` copies from `Anomaly` and where that copy goes wrong.
- `04-transactions-and-integrity.md` — the wire-format validation on `McpConfigOverride`, and the invariant enforcement in `putInsights`.
- `06-access-patterns-and-storage-choice.md` — why "no relational DB" was the right call given the access shape.
- `07-data-modeling-red-flags-audit.md` — the two-source-of-truth on `Recommendation` and the round-trip lossiness on `insightToAnomaly` are marked here.
