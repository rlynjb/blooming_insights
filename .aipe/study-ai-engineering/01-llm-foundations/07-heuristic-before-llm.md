# 07 — heuristic-before-LLM

**Subtitle:** Deterministic gates before the model call · Industry standard

## Zoom out, then zoom in

Before the LLM ever runs, deterministic code gates what it sees. In this
codebase the heuristic-before-LLM pattern shows up in three places:

  1. **Bootstrap.** Fixed MCP tool sequence resolves the project + schema
     BEFORE any agent runs. The LLM never picks `list_cloud_organizations`.
  2. **Coverage gating.** `runnableCategories(available)` filters the
     monitoring category checklist down to ones whose required signals are
     in the workspace's schema — the LLM only sees categories it can
     actually run.
  3. **Intent classification routing.** A cheap haiku call routes a
     free-form query to one of three agent shapes BEFORE the expensive
     sonnet loop starts.

```
  Zoom out — heuristics gate the LLM, not vice versa

  ┌─ Route handler ──────────────────────────────────────┐
  │  1. resolveAnomaly        (deterministic — sessionStorage > │
  │                            in-memory > demo file)    │
  │  2. bootstrap schema      (deterministic — fixed MCP │
  │                            tool chain)               │
  │  3. listTools             (deterministic)            │
  │  4. coverage filter       (deterministic — runnable- │
  │                            Categories vs schema caps)│
  │  5. classifyIntent        (cheap LLM — haiku)         │  ← guard layer
  │  ───────────────────────────────────────────────────  │
  │  6. ★ EXPENSIVE LLM ★     (sonnet agent loop)        │  ← what we protect
  └──────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — cost.** Steps 1-4 are free (no LLM tokens). Step
    5 is cheap (~$0.0003, haiku). Step 6 is expensive (~$0.20). The
    pattern is: cheap-first, expensive-second. Every step that can resolve
    the request without calling the expensive layer is worth taking.

  → **The seam:** between "what the route handler does" and "what AptKit's
    agent classes do." Blooming owns everything *up to* and *including*
    intent classification; AptKit owns everything from "agent.investigate"
    onward.

## How it works

### Move 1 — the mental model

You already use this pattern: a typed router (Next.js App Router, Express) is
a heuristic-before-handler — the path / method / params determine which
handler runs *before* the handler runs. Heuristic-before-LLM is the same
shape one layer down: the *content* of the request determines which agent
shape runs before the agent.

```
  Heuristic-before-LLM — three gates in this codebase

  request
    │
    ▼
  ┌─ gate 1: resolveAnomaly ──┐  (deterministic lookup)
  │  insightId → Anomaly      │
  └───────────┬───────────────┘  miss → 404 (no LLM)
              │ hit
              ▼
  ┌─ gate 2: bootstrap ────────┐  (deterministic MCP chain)
  │  list_cloud_organizations  │
  │  → list_projects           │
  │  → get_event_schema → …    │
  └───────────┬────────────────┘  miss → 500 (no LLM)
              │ ok
              ▼
  ┌─ gate 3: runnableCategories ┐  (deterministic schema-vs-caps)
  │  Set<available signals> ∩   │
  │  category.requires           │
  └───────────┬─────────────────┘  empty → fall back to canonical metrics
              │ filtered list
              ▼
  ┌─ gate 4 (free-form only):    ┐
  │  classifyIntent (haiku, ~$0.0003)│
  └───────────┬─────────────────┘
              │ intent
              ▼
  ┌─ EXPENSIVE: agent loop (sonnet) ─┐
  └───────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Gate 1 — anomaly resolution.** `resolveAnomaly()` in
`app/api/agent/route.ts:35-60`:

```typescript
function resolveAnomaly(sessionId: string, insightId: string, insightParam?: string | null): Anomaly | null {
  if (insightParam) {                          // 1. try the client-handed insight (best)
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
        return insightToAnomaly(i);
      }
    } catch { /* fall through */ }
  }
  const a = getAnomaly(sessionId, insightId); // 2. same-instance in-memory
  if (a) return a;
  const i = getInsight(sessionId, insightId); // 3. same-instance insight cache
  if (i) return insightToAnomaly(i);
  try {                                        // 4. fall back to the demo snapshot
    if (existsSync(DEMO_FILE)) {
      const snap = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as { insights?: Insight[] };
      const di = (snap.insights ?? []).find((x) => x.id === insightId);
      if (di) return insightToAnomaly(di);
    }
  } catch { /* ignore */ }
  return null;
}
```

The pattern: try the cheapest, most-trusted source first; fall through to the
next. The most-trusted source is the client-handed insight (passed via
`?insight=` from `sessionStorage`) — it survives Vercel's per-instance memory
boundary. The fallback chain handles the cases where session is fresh, the
demo is loaded, or the lookup is happening on a different Vercel instance
than the one that produced the briefing.

**No LLM ran to find this anomaly.** The page click → query parameter →
lookup is pure data plumbing.

**Gate 2 — bootstrap schema.** Inside `bootstrapSchema()`
(`lib/mcp/schema.ts`, called from the route at line 235), the *fixed* MCP
tool chain is:

```
  list_cloud_organizations   →  get the org list
  list_projects              →  get projects under the org
  get_event_schema           →  get events + properties
  get_customer_property_schema → get customer props
  list_catalogs              →  get catalog list
  get_project_overview       →  get totals + oldest timestamp
```

These six calls run in a fixed sequence (with parallelization where the
results don't depend). The LLM never picks any of them. They're listed in
`lib/mcp/tools.ts:55-59` as `bootstrapTools`. The comment in that file is
explicit:

```typescript
// The exact tools the bootstrap path calls (see lib/mcp/schema.ts):
//   resolveProject  → list_cloud_organizations, list_projects
//   bootstrapSchema → get_event_schema, get_customer_property_schema,
//                     list_catalogs, get_project_overview
```

The agents never see these tools in their allowlists. The schema arrives
pre-parsed as `WorkspaceSchema`; that's what the LLM gets.

**Gate 3 — coverage gating.** `runnableCategories()` in
`lib/agents/categories.ts:44-46`:

```typescript
export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available)
    .map(toBloomingCategory);
}
```

The set of "available" signals comes from `schemaCapabilities(schema)` —
deterministic analysis of which events + properties exist. Each category
declares `requires: string[]` (e.g. `revenue_drop` requires
`purchase.total_price`); if the workspace doesn't emit that property, the
category is dropped from the checklist. The monitoring agent then sees only
runnable categories in its prompt, and *cannot* try to run a category whose
data isn't there.

This is the load-bearing version of heuristic-before-LLM in this codebase.
Without it, the model would burn tool calls testing for data that doesn't
exist, get empty results, and have to figure out from the absence whether to
report `no signal` or `bad query`. With the gate, the prompt only mentions
categories that *will* return data.

**Gate 4 — intent classification.** Inside the free-form query branch
(`app/api/agent/route.ts:247-260`):

```typescript
if (q && !insightId) {
  req.signal.throwIfAborted();
  const t_intent = performance.now();
  const intent = await classifyIntent(anthropic, q, sid, req.signal); // ← haiku
  recordPhase('intent_classify', t_intent);
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  // … sonnet agent loop using `intent` to shape the prompt
}
```

The intent classify is the cheap LLM gate — a haiku call (~$0.0003) routes
the query before the expensive sonnet loop. If the user asks "what's our
purchase trend?", the classify returns `diagnostic`, and the query agent
knows to lean on diagnostic-style tools. If the user asks "give me revenue
last month", classify returns `monitoring`, and the agent picks monitoring
tools.

The classify itself is heuristic-before-LLM in miniature: a one-shot, no-tools
call with a tight prompt. `parseIntent` (`lib/agents/intent.ts:12-14`) is
lenient — defaults to `diagnostic` on parse failure, so a junky model
response doesn't 500 the request.

### Move 3 — the principle

**Gate the expensive layer with cheaper layers above it.** Anything you can
resolve with a lookup, a deterministic schema-cap intersection, or a haiku
classify is work the sonnet loop doesn't have to do. Each gate is a place
where you converted "the model figures it out at $0.05 / call" into "the
code or the cheap model figures it out at ~$0 / call."

The reverse anti-pattern is common: handing the LLM the whole problem and
hoping it sorts out what's relevant. Cheap, fast, and wrong, in that order.

## Primary diagram

```
  Three heuristic gates, one LLM loop — blooming insights' layering

  request
    │
    ▼
  ┌────────────────────────────────────────────────────────┐
  │ GATE 1 — resolveAnomaly (deterministic)                │
  │ - try ?insight= JSON                                   │
  │ - try in-memory by sessionId                           │
  │ - try demo snapshot                                    │
  │ → null = 404, no LLM                                   │
  └──────────────────────┬─────────────────────────────────┘
                         │ Anomaly
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ GATE 2 — bootstrap (deterministic MCP chain)           │
  │ list_cloud_organizations → list_projects →             │
  │ get_event_schema → get_customer_property_schema →      │
  │ list_catalogs → get_project_overview                   │
  │ → WorkspaceSchema (~30k chars raw, summarised to ~1.5k)│
  └──────────────────────┬─────────────────────────────────┘
                         │ schema
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ GATE 3 — runnableCategories (deterministic schema cap) │
  │ available = schemaCapabilities(schema)                 │
  │ checklist = CATEGORIES.filter(c =>                     │
  │   c.requires.every(r => available.has(r)))              │
  │ → only categories whose data is present                │
  └──────────────────────┬─────────────────────────────────┘
                         │ checklist
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ GATE 4 (free-form only) — classifyIntent (haiku)       │
  │ ~$0.0003 routes query to monitoring/diagnostic/        │
  │ recommendation shape                                   │
  └──────────────────────┬─────────────────────────────────┘
                         │ intent
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │ EXPENSIVE — agent loop (sonnet, ~$0.20)                │
  │ Now operating on filtered data, a known schema, and a  │
  │ confirmed shape.                                       │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern transcends LLM apps. Caching is heuristic-before-DB. Rate limiting
is heuristic-before-handler. ETag validation is heuristic-before-render. In
LLM-shaped systems the pattern is louder because the expensive layer is
*expensive*, and because the expensive layer is *unreliable* — gating it
both saves money and keeps your error surface small.

The case for *removing* a gate is when it's filtering wrong — when
`runnableCategories` excludes a category that the model could have stretched
to fit (e.g. proxying for missing `event.category` with `event.product_id`).
In blooming insights this hasn't happened; the categories were designed
conservatively. If it did, the move would be to relax the `requires` list and
let the monitoring prompt note the substitution, not to remove the gate.

## Project exercises

### Exercise — add a "free-form query is actually a saved-insight click" heuristic

  → **Exercise ID:** `study-ai-eng-07.1`
  → **What to build:** Before running `classifyIntent`, check whether `q`
    matches a saved insight's `headline` (e.g. user pasted back the
    headline). If so, redirect to the investigation flow with the matching
    `insightId`. Saves an entire LLM loop.
  → **Why it earns its place:** Demonstrates "another cheap gate" thinking
    — every time a user does something the deterministic layer can recognize,
    we should bypass the model.
  → **Files to touch:** `app/api/agent/route.ts:247-260`, plus a helper in
    `lib/state/insights.ts` to do the headline lookup.
  → **Done when:** Typing an insight's headline verbatim into QueryBox
    triggers an investigation, not a query loop. Verified by a unit test.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: Where do you avoid calling the LLM in this codebase?**

Four gates before the expensive layer:

  1. **`resolveAnomaly`** — lookup-only; the anomaly already exists.
  2. **Bootstrap** — fixed MCP tool chain; the LLM never picks
     `list_cloud_organizations`.
  3. **`runnableCategories`** — schema-vs-capability intersection filters the
     category checklist deterministically.
  4. **`classifyIntent`** — cheap haiku gate (~$0.0003) routes free-form
     queries before the sonnet agent loop.

Then the LLM runs.

**Anchor line:** "Cheap-first, expensive-second. Each gate is a place where
deterministic code saves a sonnet call."

**Q: What's the load-bearing gate of the four?**

`runnableCategories`. Without it, the monitoring agent would burn tool calls
testing for properties that don't exist in the workspace and have to
distinguish "no signal" from "bad query." With it, the prompt only mentions
categories whose required signals are in the schema, and the agent operates
on data that's guaranteed to be there.

**Anchor line:** "Filter the model's options before it picks. The cheapest
gate is the one that prevents wasted tool calls."

## See also

  → `04-agents-and-tool-use/04-tool-routing.md` — heuristic-vs-LLM tool routing within the agent
  → `06-token-economics.md` — what the gates save in dollars
