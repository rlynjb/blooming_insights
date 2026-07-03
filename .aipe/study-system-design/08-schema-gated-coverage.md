# 08 — Schema-gated coverage

**Industry name:** capability-based gating driven by remote schema introspection. *Type: Project-specific (idiomatic).*

## Zoom out, then zoom in

The monitoring agent has a 10-category anomaly checklist: revenue,
conversion, traffic, funnel, session dropoff, and so on. Not every
workspace supports every category — a workspace with no
`view_item` event can't do funnel analysis; a workspace with no
`checkout` event can't do checkout dropoff. Running the agent
against categories the workspace doesn't support wastes EQL budget
(remember: ~1 req/s per user, hard rate limit) and produces
useless "no data" anomalies.

Schema-gated coverage fixes this: after `bootstrapSchema` returns
the `WorkspaceSchema`, a pure function classifies each of the 10
categories as *runnable* or *skipped* based on which events and
properties the workspace actually exposes. The agent only spends
budget on runnable categories.

```
  Zoom out — where schema-gated coverage sits

  ┌─ Service layer ────────────────────────────────────────┐
  │  /api/briefing                                         │
  │  schema = bootstrap(signal)                            │
  │  ★ capabilities = schemaCapabilities(schema) ★          │
  │  ★ runnable = runnableCategories(capabilities) ★        │
  │  agent.scan(runnable, ...)                             │
  └────────────────────────┬───────────────────────────────┘
                           │  narrated as a UI checklist
  ┌─ UI layer ─────────────▼───────────────────────────────┐
  │  StatusLog shows: "matching schema to 10-category      │
  │                    checklist..." then per-category     │
  │                    ✓ / — (skip reason)                 │
  └────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is capability negotiation via
introspection — "ask the server what it supports, then only ask
for what makes sense." Standard shape (HTTP `OPTIONS`, GraphQL
introspection, gRPC reflection), applied here to a specific product
concern: don't spend LLM + EQL budget on categories the workspace
can't answer.

## Structure pass

Two layers (schema / agent policy), one axis: **what determines
whether a category runs?**

```
  Axis "what gates each category?" — trace it down

  ┌─ Schema (owned by MCP server) ──────────────────────────┐
  │ events available:      purchase, view_item, session_    │
  │                        start, cart_update, checkout ...  │
  │ customer properties:   state, city, lifecycle_stage ...  │
  │ catalogs:              products, inventory_level         │
  └────────────────────────┬────────────────────────────────┘
                           │  seam: schemaCapabilities(schema)
  ┌─ Capabilities (pure) ──▼────────────────────────────────┐
  │ derived:  { hasPurchase, hasViewItem,                    │
  │             hasCheckout, hasSessionStart,                │
  │             hasCountrySegment, hasCatalog, ... }         │
  └────────────────────────┬────────────────────────────────┘
                           │  seam: runnableCategories(capabilities)
  ┌─ Categories (10 total) ▼────────────────────────────────┐
  │ ✓ revenue                (needs hasPurchase)             │
  │ ✓ conversion             (needs hasPurchase+hasViewItem) │
  │ ✓ traffic                (needs hasSessionStart)         │
  │ — checkout_dropoff       (needs hasCheckout) — skipped   │
  │ — funnel                 (needs view+cart+checkout) — skipped│
  │ ... etc                                                  │
  └─────────────────────────────────────────────────────────┘
```

Two seams. The first (schema → capabilities) is where remote
truth becomes local booleans. The second (capabilities →
runnable set) is where local booleans become a run policy. The
axis "what gates this category?" starts as "does the workspace
have the event?" and ends as "is the category in the runnable
set?"

## How it works

### Move 1 — the mental model

You've written a form that hides fields based on the selected
country (state dropdown for US, region dropdown for UK). Same
shape, one altitude up: the "form" is the monitoring agent's
plan, the "selection" is the workspace schema, and the
"hidden fields" are the categories that don't apply.

```
  Pattern — introspect → derive → gate

  ┌─ 1. introspect ─┐  bootstrapSchema calls MCP tools:
  │  ask the server │    list_cloud_organizations,
  │  what's there   │    get_event_schema,
  └────────┬────────┘    get_customer_property_schema,
           │             list_catalogs, get_project_overview
           ▼
  ┌─ 2. derive ─────┐  pure function on the schema:
  │  compute local  │    hasPurchase = 'purchase' in events
  │  capabilities   │    hasCheckout = 'checkout' in events
  └────────┬────────┘    hasCountrySegment = 'country' in
           │             customerProperties
           ▼
  ┌─ 3. gate ───────┐  pure function on capabilities:
  │  filter the     │    revenue     needs hasPurchase
  │  10 categories  │    funnel      needs view+cart+checkout
  │  to runnable    │    countrySegs needs hasCountrySegment
  └─────────────────┘  → returns runnable[] + skip reasons
```

Three pure functions, one live call. That's the shape.

### Move 2 — step by step

**Part 1: bootstrap runs first.** The route calls
`bootstrap(req.signal)` before it does anything else in the
stream (`app/api/briefing/route.ts:225`). For live-mcp, that's
`bootstrapSchema(mcpDs, { signal })` in `lib/mcp/schema.ts:186`,
which runs the five-tool orchestrator (`list_cloud_organizations`,
`list_projects`, `get_event_schema`,
`get_customer_property_schema`, `list_catalogs`,
`get_project_overview`) and produces one `WorkspaceSchema`.

For live-synthetic, `bootstrap` returns the hardcoded
`syntheticWorkspaceSchema` immediately (10 events including
`purchase`, `view_item`, `checkout`, `session_start` — so
almost all categories are runnable in the synthetic path).

**Part 2: derive capabilities (pure).** The
`schemaCapabilities` function in `lib/insights/derive.ts` (the
only file in that folder — pure logic, unit-tested) reads the
schema and produces a booleans-only capability object. No I/O.

```
  Pattern — the derivation

  input:   WorkspaceSchema
             ↓
  events available:  ['purchase', 'view_item', 'session_start',
                      'cart_update', 'checkout', ...]
  customer props:    ['state', 'city', 'lifecycle_stage', ...]

  output:  Capabilities
    hasPurchase:      true   ← 'purchase' ∈ events
    hasViewItem:      true   ← 'view_item' ∈ events
    hasCheckout:      true   ← 'checkout' ∈ events
    hasCartUpdate:    true   ← 'cart_update' ∈ events
    hasSessionStart:  true   ← 'session_start' ∈ events
    hasCountrySegment: false ← 'country' ∉ customer props
    ...
```

Purity is the property that matters here. `schemaCapabilities`
is called from the route (to gate the run) and from tests (to
check every branch). Being a pure function on `WorkspaceSchema`
makes both cheap.

**Part 3: gate the categories (pure).** `runnableCategories`
takes the capabilities object, walks the 10-category list, and
returns the runnable subset. `coverageReport` produces the
UI-facing checklist including skip reasons.

```
  Layers-and-hops — the gating decision

  ┌─ schema ──────────────┐  hop 1: derive (pure)
  │  events + props +     │
  │  catalogs             │
  └────────┬──────────────┘
           │
  ┌─ capabilities ─▼──────┐  hop 2: gate (pure)
  │  { hasPurchase: true, │
  │    hasCheckout: true, │
  │    hasCountry: false, │
  │    ... }              │
  └────────┬──────────────┘
           │
  ┌─ policy ──▼───────────┐  hop 3: emit coverage
  │  runnable:            │  narrate as UI checklist,
  │    [revenue, ..., funnel]│ send per-item events
  │  skipped:             │
  │    [country_segments  │
  │      "no 'country'    │
  │      property"]       │
  └───────────────────────┘
```

**Part 4: narrate the gate as a checklist.** The route sends
one `{ type: 'coverage_item' }` event per category as it
resolves the checklist — turns the pure-function output into
the UI's "matching the workspace schema to the 10-category
anomaly checklist..." animation.

```ts
// app/api/briefing/route.ts:239-252
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);

step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);
  send({ type: 'coverage_item', item });
});
```

The user sees each category resolve in turn — ✓ for runnable,
— with reason for skipped. The `ProcessStepper` and
`StatusLog` fill in step with the checklist.

**Part 5: only runnable categories reach the agent.** The
monitoring agent's `scan` accepts the runnable list; it never
sees the skipped ones, so it can't spend budget on them. The
agent's system prompt and tool selection are also pruned to
match — nothing gets asked about categories the workspace
can't answer.

### Move 2 variant — the load-bearing skeleton

The kernel is three moves:

1. **Introspect** — call the workspace-schema-fetch path
   before you do anything else. This is `bootstrapSchema` in
   this repo; it's the boot-time "ask what's here" step.
2. **Derive capabilities as pure booleans on the schema.** No
   I/O in the derivation — it's just about the shape you got
   back.
3. **Gate the run policy against the capabilities.** Filter,
   don't try-and-fail. Categories the workspace can't answer
   don't get asked.

What breaks if any part is missing:

- Drop the introspection → you're guessing what the workspace
  supports; every miss costs a rate-limited call.
- Drop the pure derivation → the gating decision lives in
  route code, entangled with I/O — hard to test, hard to
  refactor.
- Drop the gate → agent spends EQL budget on categories that
  return no data; the checklist becomes noise.

Optional hardening — not the kernel:

- The user-facing checklist narration (nice UX, but the gating
  works without it).
- The `coverage_item` NDJSON event (again, UX, not policy).
- Skip-reason strings (help debugging, but a boolean gate is
  the mechanism).

### Move 3 — the principle

Capability-based gating is the same idea whether you're doing
HTTP OPTIONS negotiation, GraphQL introspection, gRPC
reflection, or WorkspaceSchema classification. Ask what the
server actually supports before you plan work against it. The
alternative — plan optimistically and handle "not supported"
errors in-flight — burns latency and rate budget on things
that were knowable up front. The general rule: any time you
have a rate limit and a plan, capability-negotiate.

## Primary diagram

```
  Schema-gated coverage — recap end to end

  ┌─ Route: /api/briefing ─────────────────────────────┐
  │  schema = await bootstrap(req.signal)              │
  │  //  live-mcp → bootstrapSchema (5 tool calls)     │
  │  //  live-synthetic → syntheticWorkspaceSchema     │
  │                                                     │
  │  capabilities = schemaCapabilities(schema)         │
  │  //  pure: booleans off events + props + catalogs  │
  │                                                     │
  │  coverage = coverageReport(capabilities)           │
  │  //  { category, runnable: bool, reason?: string } │
  │                                                     │
  │  runnable = runnableCategories(capabilities)       │
  │  //  filtered list — the run policy                │
  │                                                     │
  │  ── narrate the gate ──                            │
  │  step('matching the workspace schema...')          │
  │  for each item:                                    │
  │    send({ type: 'coverage_item', item })           │
  │                                                     │
  │  ── run the gated set ──                           │
  │  await monitoringAgent.scan(runnable, {            │
  │    onText: send-reasoning-step,                    │
  │    onInsight: send-insight,                        │
  │  })                                                 │
  └────────────────────────────────────────────────────┘
```

## Elaborate

This pattern is common in any product where the environment
determines capability — feature flags respecting subscription
tier, database migrations checking column existence before
altering, analytics UIs hiding controls for missing dimensions.
The interesting piece for LLM-agent systems is the *reason*
the gating is worth doing: rate limits and cost.

An agent that tries and fails will keep trying (that's what
they do — the ReAct loop retries with different arguments).
Each retry is a rate-limited call. Ten skipped categories
that fail three times each = 30 wasted calls at ~1s spacing
= 30 seconds of wall-clock burned before the useful work
starts. Schema-gated coverage collapses that to zero. The
audit's ranking of the 8 lenses puts this pattern in the
scale-bottleneck seam for exactly that reason.

Where the pattern shows up elsewhere: `sqlite3_column_type` in
SQLite (know before you cast), `pg_catalog` inspections before
running migrations, GraphQL client-side codegen from
introspection, and Kubernetes API discovery before applying a
manifest.

## Interview defense

**Q: Why gate at boot rather than let the agent discover
capabilities on the fly?**

A: Rate limit + cost. The MCP server allows ~1 req/s per user
globally. A category that fails takes at least one tool call
plus retries; ten missing categories with three retries each
is ~30s of wall clock burned before useful work starts. Gating
at boot collapses that to zero — the agent never asks for
categories the schema can't answer.

**Q: What's the one part of the coverage checklist people
forget?**

A: The narration. The pure gate is `runnable = filter(list,
capabilities)` — 10 lines and done. What makes the pattern
land in the UI is that the route *shows the resolution
happening*: one `coverage_item` event per category, each
resolving to ✓ or —. The user sees the plan being made, not
just the results. That's what turns "agents that show their
work" from a pitch into a screenshot.

**Q: What breaks if the schema changes mid-session?**

A: The `bootstrapSchema` module-scope cache
(`lib/mcp/schema.ts:138`) holds the schema for the process
lifetime. If the workspace adds a new event type, the gate
won't pick it up until the process cold-starts (or `_reset
SchemaCache()` runs — used in tests). This is called out in
the audit's ranked red flags; the mitigation for the swappable-
MCP case is that changing the config in the modal triggers a
page reload, which restarts the process for the browser.

**Q: When would you NOT reach for this pattern?**

A: When your capability set is small and stable, or when the
cost of failure is negligible. If your agent talks to a
service with unlimited rate and cheap calls, "try and handle
the failure" can be cheaper than the upfront introspection.
The pattern earns its keep exactly when introspection is
cheap and per-call failure is expensive.

## See also

- `01-request-flow.md` — where bootstrap fits in the request
  path
- `03-provider-abstraction-and-datasource-seam.md` — the
  DataSource `bootstrapSchema` reads through
- `05-streaming-ndjson.md` — the `coverage_item` event ships
  over the same NDJSON contract as everything else
