# Schema-as-retrieval

*Project-specific — the workspace schema is the corpus*

## Zoom out — where this concept lives

Most LLM apps "retrieve" by embedding a query and looking up similar chunks in a vector DB. This codebase doesn't have a vector DB. The thing it retrieves *over* is the Bloomreach workspace schema — the list of event types, their properties, the customer properties, the catalogs. That shape is what the monitoring agent uses to decide which EQL queries make sense for this particular workspace.

```
  Zoom out — schema-as-retrieval in the stack

  ┌─ Agent layer ────────────────────────────────────────────┐
  │  MonitoringAgent decides which EQL to run                │
  │  needs to know: what events exist in THIS workspace?     │
  └──────────────────────┬───────────────────────────────────┘
                         │  reads from
                         ▼
  ┌─ ★ Schema (the corpus) ★ ─────────────────────────────────┐ ← we are here
  │  WorkspaceSchema {                                        │
  │    events[],   ← event types + their property names       │
  │    customerProperties[],                                  │
  │    catalogs[], totalCustomers, totalEvents,               │
  │  }                                                        │
  │  fetched ONCE per session, cached at module level         │
  └──────────────────────┬───────────────────────────────────┘
                         │  filled by
                         ▼
  ┌─ Bootstrap orchestrator ─────────────────────────────────┐
  │  list_cloud_organizations → list_projects                │
  │  → get_event_schema → get_customer_property_schema       │
  │  → list_catalogs → get_project_overview                  │
  │  (lib/mcp/schema.ts:174-200)                             │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The agent doesn't query "what events look like 'purchase'?" — it gets the *whole* schema (summarized) in its system prompt and decides what to ask about. The "retrieval" is the bootstrap-then-cache pattern; the "augmentation" is the schema summary that goes into the agent's prompt.

## Structure pass — layers · axes · seams

**Layers:** Bloomreach API → bootstrap orchestrator → cached `WorkspaceSchema` → schema summary → agent prompt.

**Axis: where does the corpus live?** In-memory, module-scoped (the `cached` variable at `lib/mcp/schema.ts:171`). Per-process, per-deployment-instance. No persistence across cold starts.

**Seam:** the `WorkspaceSchema` shape at `lib/mcp/schema.ts:9-26`. That's the contract between the bootstrap orchestrator (writer) and every agent (reader).

## How it works

### Move 1 — the mental model

You know how a SQL client opens a connection and reads `information_schema` once to know what tables exist? Same pattern. One walk through the workspace's "system catalog" at session start; everything that follows references the cached shape.

```
  Schema-as-retrieval — bootstrap once, read forever

  Session start:                       Every agent call:
   ─────────────────                    ──────────────────────
   bootstrapSchema()                    schemaSummary(schema)
     ├─ list_cloud_organizations          ↓
     ├─ list_projects                    cap to 20 events,
     ├─ get_event_schema                  10 props, 30 cprops
     ├─ get_customer_property_schema      ↓
     ├─ list_catalogs                    embed in system prompt
     └─ get_project_overview              ↓
   → WorkspaceSchema                    agent decides which
   cached at module level               EQL to run from the
                                        shape it can see
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the bootstrap is six tool calls in order.**

`bootstrapSchema()` at `lib/mcp/schema.ts:174-200`:

```typescript
export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const args = { project_id: projectId };

  // Sequential — the server allows ~1 req/s; BloomreachDataSource already spaces calls.
  const eventSchema = await callOrThrow(dataSource, 'get_event_schema', args, opts);
  const customerProps = await callOrThrow(dataSource, 'get_customer_property_schema', args, opts);
  const catalogs = await callOrThrow(dataSource, 'list_catalogs', args, opts);
  const overview = await callOrThrow(dataSource, 'get_project_overview', args, opts);

  cached = parseWorkspaceSchema({ projectId, projectName, eventSchema, customerProps, catalogs, overview });
  return cached;
}
```

Six calls (`resolveProject` makes two; the body makes four). Sequential because Bloomreach rate-limits at ~1 req/s. The result is a single `WorkspaceSchema` object.

**Part 2 — the cache is module-level.**

The `cached` variable at `lib/mcp/schema.ts:171`:

```typescript
let cached: WorkspaceSchema | null = null;
// ...
if (cached) return cached;
```

Lives for the lifetime of the Node process (the warm Vercel instance). Multiple sessions on the same instance share the same schema cache. That's fine because the schema is per-project, not per-user — every session in the same Bloomreach workspace gets the same shape.

The bytes are reset only by an explicit `_resetSchemaCache()` (`lib/mcp/schema.ts:202`), used in tests.

**Part 3 — the summary is the augmentation that lands in the prompt.**

`schemaSummary()` at `lib/agents/monitoring.ts:18-58` transforms the full `WorkspaceSchema` into the prose block that goes into the monitoring agent's system prompt:

```typescript
export function schemaSummary(schema: WorkspaceSchema): string {
  // Top 20 events, each capped at 10 properties
  const MAX_EVENTS = 20;
  const MAX_PROPS_PER_EVENT = 10;

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  // ... customer properties, capped at 30
  // ... project meta line, catalogs line, total customers + events

  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Total events: ${schema.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizonLine ? [horizonLine] : []),
    `Catalogs: ${schema.catalogs.map((c) => c.name).join(', ') || 'none'}`,
    '',
    `Top events (name, eventCount: properties):`,
    eventsText,
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}
```

Three caps (`MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10`, `MAX_CPROPS = 30`) keep the summary under ~500 tokens.

**Part 4 — events are sorted by count descending.**

The "retrieval" decision is encoded at `lib/mcp/schema.ts:106-108`:

```typescript
const events = (eventPayload?.events ?? [])
  .map((e) => ({ ... }))
  .sort((a, b) => b.eventCount - a.eventCount);
```

Top 20 by event count = the 20 most-active event types. Low-volume events drop out of the summary. That's a load-bearing call: it favors recall on the head (the big numbers, where anomalies are most user-visible) over recall on the tail.

### Move 3 — the principle

**The corpus is the schema, not the data.** Retrieval here means "give the agent enough of the workspace shape to ask intelligent questions" — and the shape is finite (events, properties, catalogs), not infinite (every row of every event stream). Bootstrap once, summarize aggressively, let the agent's EQL queries fetch the actual values.

## Primary diagram — the full recap

```
  Schema-as-retrieval — bootstrap → cache → summarize → prompt

  ┌─ Bloomreach MCP server ──────────────────────────────────────┐
  │  raw tool responses for the 6 bootstrap calls                │
  └──────────────────────────┬───────────────────────────────────┘
                             │  callOrThrow, sequential, ~1 req/s
                             ▼
  ┌─ bootstrapSchema (lib/mcp/schema.ts:174) ────────────────────┐
  │  parseWorkspaceSchema combines the 6 raw payloads            │
  │   into one typed WorkspaceSchema                             │
  │  cached at module level (per-process)                        │
  └──────────────────────────┬───────────────────────────────────┘
                             │  read forever (until process exit)
                             ▼
  ┌─ Agent layer ────────────────────────────────────────────────┐
  │  schemaSummary(schema) at lib/agents/monitoring.ts:18        │
  │   - cap to 20 events × 10 props                              │
  │   - cap to 30 customer properties                            │
  │   - serialize to ~500 token prose block                      │
  │  embedded into the monitoring agent's system prompt          │
  └──────────────────────────┬───────────────────────────────────┘
                             │  augments the prompt
                             ▼
  ┌─ Anthropic API ──────────────────────────────────────────────┐
  │  model sees the workspace shape and decides which EQL to run │
  │  via tool calls (execute_analytics_eql, ...)                 │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why this isn't traditional RAG.** Three differences:

  1. **The corpus is small and structured.** Workspace schemas are ~50-200 events, ~30-100 customer properties. The whole shape fits in ~500 tokens after summarization. No need for similarity-based selection — just take it all.
  2. **The "query" is implicit.** Traditional RAG embeds the user's question; here the agent reads the *whole* schema and decides what's relevant on its own. The schema serves all agent decisions, not just one query.
  3. **The data the agent acts on isn't retrieved — it's queried at decision time.** The EQL the agent runs (`execute_analytics_eql`) is the actual data fetch, parameterized by the agent's reading of the schema. Two layers: schema (cached, all agents) vs. data (per-call, per-query).

**Why the cache is process-scoped.** Vercel cold starts re-bootstrap the schema. With ~6 tool calls × ~1.1s rate spacing = ~6.6s cold-start penalty. On a warm instance, the cache amortizes that to zero across many sessions. The trade is acceptable because schemas change slowly (Bloomreach event schemas are stable over hours/days, not minutes).

**Where this would need to grow.** If a future feature wants per-event property *values* in the prompt (e.g. "the most common `category` value is `'apparel'`"), the schema would need value retrieval — a small per-property `topN` sample. That's the natural extension. Vector retrieval still wouldn't be the right shape; structured retrieval would.

## Project exercises

### Exercise — Sample top-N property values into the schema summary

  → **Exercise ID:** B3.1
  → **What to build:** Extend `bootstrapSchema` to fetch the top 3 most-common values per high-cardinality property (e.g. `country`, `category`, `payment_type`). Add them to the schema summary as `"category: top values = apparel, electronics, home"`. Use `execute_analytics_eql` with `select distinct property group by property order by count desc limit 3`.
  → **Why it earns its place:** the monitoring agent currently guesses at value names when writing EQL — sometimes calling `where customer.country = "USA"` when the actual value is `"United States"`. Surfacing the top values teaches the agent the data's actual vocabulary at zero extra per-call cost.
  → **Files to touch:** `lib/mcp/schema.ts` (extend `bootstrapSchema` with a value-sampling pass), `lib/agents/monitoring.ts` (update `schemaSummary` to render the top values), `test/mcp/schema.test.ts` (cover the value-sampling output shape).
  → **Done when:** the schema summary block now carries `"top values: ..."` lines for the 5 highest-cardinality properties, the monitoring agent's first EQL on a workspace where the country code is non-obvious uses the right value, and the cold-start cost stays under 10s.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Do you have RAG in this codebase?"**

Not in the traditional vector-embedding sense — no vector store, no embeddings, no chunking. What I do have is *schema-as-retrieval*: the Bloomreach workspace schema (events, properties, catalogs) is fetched once at session start via 6 sequential MCP tool calls, cached at module level, and summarized into the agent's system prompt. The agent uses the schema to decide what EQL to run.

The corpus is small (~50-200 events), structured (typed `WorkspaceSchema`), and the "query" is implicit (the agent reads the whole shape). Traditional RAG would be overhead.

*Anchor: "Schema is the corpus; bootstrap → cache → summarize → prompt. `lib/mcp/schema.ts:174`, `lib/agents/monitoring.ts:18`."*

**Q: "What happens on a cold start?"**

Six sequential MCP tool calls at ~1.1s rate spacing = ~7s cold-start penalty before the first agent call can run. On a warm Vercel instance, the module-level cache amortizes it to zero across many sessions in the same workspace. The cache is per-process, not per-user — different users on the same warm instance share the same cached schema, which is fine because the schema is per-project, not per-user.

*Anchor: "~7s cold start, ~0s warm. Cache is module-level, lifetime = process lifetime."*

## See also

  → `02-schema-gated-coverage.md` — the gating layer that sits on top of this retrieval
  → `04-agents-and-tool-use/02-tool-calling.md` — the loop that uses the schema to pick tools
  → `study-system-design/09-schema-gated-coverage.md` — the same pattern from the system-design lens
