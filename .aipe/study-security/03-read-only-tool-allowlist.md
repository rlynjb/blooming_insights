# Read-only tool allowlist (and the per-agent gate that regressed)

## Subtitle

Capability allowlist for MCP tool dispatch · Language-agnostic pattern, Project-specific implementation (`ALL_KNOWN` at `/api/mcp/call` + per-agent subsets)

---

## Zoom out — where this concept lives

The MCP server exposes tens of tools — some read (`list_customers`, `get_event_schema`, `execute_analytics_eql`), some potentially write. The app should call *only the ones it means to*. Two independent surfaces reach the MCP server: the debug/dev POST endpoint at `/api/mcp/call` (used by `/debug`), and the agent loops (which decide what to call based on the model's tool choices).

Both surfaces get a whitelist. One works. One regressed.

```
  Zoom out — where the allowlist sits

  ┌─ Browser layer ────────────────────────────────────────┐
  │  /debug page → POST /api/mcp/call {name, args}           │
  │  agent UI reads insight/investigation streams            │
  └────────────────┬─────────────────────────────────────────┘
                   │
  ┌─ Service layer ▼─────────────────────────────────────────┐
  │  ┌ /api/mcp/call ─────────────────────────────────────┐  │
  │  │ ★ ALL_KNOWN allowlist — WORKS ★                    │  │
  │  │ if !ALL_KNOWN.has(name) → 403                       │  │
  │  └────────────────────────────────────────────────────┘  │
  │                                                            │
  │  ┌ Agent loops (diagnostic, monitoring, ...) ──────────┐  │
  │  │ per-agent tool subsets in lib/mcp/tools.ts EXIST    │  │
  │  │ ★ but the live path passes allTools unfiltered ★    │  │
  │  │ filterToolSchemas() only used by *-legacy.ts        │  │
  │  └────────────────────────────────────────────────────┘  │
  └──────────────────┬───────────────────────────────────────┘
                     │  MCP tool call
                     ▼
              Bloomreach loomi connect
```

---

## Structure pass — layers, axis, seams

**Layers.** Two paths converge on the same MCP transport:

1. Route handler → `BloomreachDataSource.callTool` → `SdkTransport` → MCP server
2. Agent → AptKit's `BloomingToolRegistryAdapter` → `BloomreachDataSource.callTool` → `SdkTransport` → MCP server

**Axis: trust — what tool can the caller reach?**

- Route path: whatever passed the `ALL_KNOWN.has(name)` check.
- Agent path: whatever tools were in `allTools` when the adapter was constructed.

**Seams.**

1. **`/api/mcp/call` request-body ↔ dispatch** — the classical allowlist seam. Name in, either 403 or forwarded to the MCP server. Clean.
2. **`allTools` array ↔ `BloomingToolRegistryAdapter`** — this is where the per-agent gate *should* be, and isn't. Pre-migration (`base-legacy.ts` era), each agent narrowed the tool schemas via `filterToolSchemas`. Post-migration (AptKit), each agent hands `this.allTools` to the registry unfiltered.

Hand off — the story is a working gate and a regressed one.

---

## How it works

### Move 1 — the mental model

You know how a firewall rule says "allow only ports 80 and 443, deny everything else"? A capability allowlist is the same idea for API calls: a fixed set of names is legal; everything else is denied by default. The set gets bigger deliberately — nothing sneaks in.

The pattern's shape:

```
  Capability allowlist — the pattern

              incoming call
                    │
                    ▼
         ┌────────────────────┐
         │ requested capability│  (a name / a method / a tool)
         └──────────┬─────────┘
                    │
                    ▼
         ┌────────────────────┐
         │  name ∈ ALLOWLIST ? │
         └──────┬──────────┬──┘
                │ yes      │ no
                ▼          ▼
         ┌───────────┐  ┌────────┐
         │ dispatch  │  │ 403    │
         └───────────┘  └────────┘
```

The load-bearing part: the check is `contains(name)` against a *finite set*, not `matches(pattern)` against a regex. Regex allowlists are how gates start silently permissive.

### Move 2 — walkthrough

**The working gate: `/api/mcp/call`.**

**File:** `app/api/mcp/call/route.ts`
**Function:** `POST`
**Line range:** 15-42

```ts
// Allowlist of tool names this app intends to call. Built once per warm
// instance. Sourced from the same constants the agents use, so the boundary
// stays in sync with what the rest of the system already speaks.
const ALL_KNOWN = new Set<string>([
  ...monitoringTools,
  ...diagnosticTools,
  ...recommendationTools,
  ...bootstrapTools,
]);

export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
    }
    // ... connects and dispatches
```

Three trust decisions in five lines:

1. **`typeof name !== 'string'`** — if the client sent `name: { $ne: null }` (NoSQL-injection-style trick) the `Set.has` would return false anyway, but the explicit type check makes the intent visible and closes any exotic-value path.
2. **`ALL_KNOWN.has(name)`** — the allowlist itself. Sourced from the constants the agents use (`lib/mcp/tools.ts`), so there's no separate list to drift.
3. **`{ error: 'tool not allowed' }`** — the 403 is deliberately generic. It doesn't confirm whether the tool name exists on the MCP server or not, which is minor but keeps the response uninformative to a prober.

What breaks if you drop the check: the route becomes a general MCP proxy. A caller can invoke any tool the connected server exposes. Even given the current server is read-only, "read-only today" is a property of the current tool set, not of the transport — a future write tool added upstream would be reachable.

**Why sourcing from `tools.ts` matters.**

**File:** `lib/mcp/tools.ts`
**Line range:** 6-59

```ts
const monitoringToolsBloomreach = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  // ...
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

// ... more constants ...

export const monitoringTools = monitoringToolsBloomreach;
export const diagnosticTools = diagnosticToolsBloomreach;
export const recommendationTools = recommendationToolsBloomreach;

export const bootstrapTools = [
  'list_cloud_organizations', 'list_projects',
  'get_event_schema', 'get_customer_property_schema',
  'list_catalogs', 'get_project_overview',
] as const;
```

Every whitelisted name is a reader. Zero write tools. This is *the* property that lets the app run against a production Bloomreach workspace without a rollback plan — the agent literally cannot mutate the analyst's data.

**The regressed gate: per-agent tool scope in the AptKit path.**

This is the finding. It fires as red flag #7 in `audit.md`. The three per-agent subsets exist, and `filterToolSchemas` (the helper) still works, but the live agents don't use them.

**File:** `lib/agents/tool-schemas.ts`
**Function:** `filterToolSchemas`
**Line range:** 9-21

```ts
export function filterToolSchemas(
  all: McpToolDef[],
  allowed: readonly string[],
): Anthropic.Messages.Tool[] {
  const set = new Set(allowed);
  return all
    .filter((t) => set.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));
}
```

The pure function is fine. The problem is who calls it.

**Legacy path (unused at runtime):**

**File:** `lib/agents/diagnostic-legacy.ts`
**Line:** 62

```ts
toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),
```

**Live path (what the routes actually invoke):**

**File:** `lib/agents/diagnostic.ts`
**Line range:** 47-59

```ts
const agent = new AptKitDiagnosticInvestigationAgent({
  model: new AnthropicModelProviderAdapter(...),
  tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
  //                                                     ^^^^^^^^^^^^^^
  //                                     ★ full catalog, unfiltered ★
  workspace: this.schema,
  trace: new BloomingTraceSinkAdapter(...),
});
```

Same pattern in `monitoring.ts:83`, `recommendation.ts:40`, `query.ts:27`.

`BloomingToolRegistryAdapter.listTools()` (`aptkit-adapters.ts:130-136`) returns exactly what it was constructed with — no filtering. AptKit then hands the full catalog to the model as available tools.

**Comparison — before vs after the migration:**

```
  Per-agent tool scope — Phase A (legacy) vs Phase B (AptKit live)

  ┌─ Phase A: legacy classes ──────────────┐
  │                                          │
  │  DiagnosticAgent (base-legacy)           │
  │    │                                     │
  │    │ toolSchemas: filterToolSchemas(     │
  │    │   this.allTools, diagnosticTools    │
  │    │ )                                    │
  │    ▼                                     │
  │  ~15 tools visible to the model         │
  └─────────────────────────────────────────┘

  ┌─ Phase B: live AptKit path ────────────┐
  │                                          │
  │  DiagnosticAgent (diagnostic.ts)         │
  │    │                                     │
  │    │ tools: BloomingToolRegistryAdapter( │
  │    │   this.dataSource, this.allTools   │
  │    │ )                                    │
  │    │       ▲                              │
  │    │       └── no filter                  │
  │    ▼                                     │
  │  ~25 tools visible to the model         │
  └─────────────────────────────────────────┘
```

**The trust assumption named.** The migration assumed AptKit's adapter would enforce scope; it doesn't — it's a registry, not a gate. The fix has two shapes:

1. **Filter at the agent constructor.** Pass `filterToolSchemas`-narrowed `allTools` (or the raw `McpToolDef[]` filtered by `.name`) when instantiating the registry adapter:
   ```ts
   new BloomingToolRegistryAdapter(
     this.dataSource,
     this.allTools.filter(t => diagnosticTools.includes(t.name as any)),
   )
   ```
2. **Filter inside the adapter.** Add an `allowlist: readonly string[]` constructor arg to `BloomingToolRegistryAdapter` (`aptkit-adapters.ts:124`), narrow inside `listTools`, and reject inside `callTool` if the name isn't in the set.

Option 2 is stronger — it defends `callTool` too, catching a model that emits a tool name not present in `listTools` (unlikely with a well-behaved model, but the gate should not depend on model politeness). Option 1 is a smaller diff.

The tests: `test/agents/tool-schemas.test.ts` covers the pure function. Add a companion test for the registry adapter (`test/agents/aptkit-adapters.test.ts` or an inline scope suite) that asserts the constructed adapter's `listTools()` only returns the allowlist, and that `callTool` rejects an out-of-list name.

### Move 2.5 — current state vs future state

The mechanism is built, the wiring regressed. The fix does not require new infrastructure; it requires threading the existing constants through the adapter boundary.

```
  Now                            Target
  ───                            ──────
  route → agent → allTools       route → agent → filter → agent-scoped tools
                     │                                          │
                     ▼                                          ▼
                model sees ALL                          model sees ONLY
                whitelisted tools                       this agent's subset

  Cost: ~10 lines diffed across 4 files.
  Test cost: one adapter-scope suite (~5 assertions).
```

### Move 3 — the principle

Capability allowlists are the pattern any system with "many possible operations, few intended ones" should use. The specific decision that carries the weight: whitelist by *name*, not by *shape*. A regex or a prefix rule ("tools starting with `list_` are safe") is how gates go silently permissive when the upstream renames.

The generalization: least-privilege is not a property you get from the transport, it's a property you enforce at the boundary. The transport in this repo is read-only *today*, and the allowlist is what makes that a property of the system, not a property of the upstream.

---

## Primary diagram — the two allowlists side by side

```
  Two allowlist surfaces in blooming_insights

  ┌─ Surface 1: /api/mcp/call (route allowlist — WORKS) ─────────────────┐
  │                                                                        │
  │   POST { name: "list_customers", args: {...} }                         │
  │        │                                                                │
  │        ▼                                                                │
  │   ALL_KNOWN.has("list_customers")   ← Set built from tools.ts constants│
  │        │                                                                │
  │        ├─ yes → connectMcp → conn.mcp.callTool(name, args)             │
  │        │                                                                │
  │        └─ no  → 403 { error: "tool not allowed" }                      │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Surface 2: agent registry (per-agent scope — REGRESSED) ────────────┐
  │                                                                        │
  │   DiagnosticAgent.investigate(anomaly)                                 │
  │        │                                                                │
  │        │ new BloomingToolRegistryAdapter(dataSource, this.allTools)    │
  │        │                                              ▲                 │
  │        │                            ┌─── should be ───┤                 │
  │        │                            │   this.allTools.filter(...)      │
  │        │                            │   or an allowlist ctor arg       │
  │        ▼                                                                │
  │   adapter.listTools() → returns ALL of allTools                        │
  │        │                                                                │
  │        ▼                                                                │
  │   AptKit passes full catalog to the model as `tools:`                  │
  │        │                                                                │
  │        ▼                                                                │
  │   model chooses freely from ~25 tools (should be ~15 for diagnostic)   │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

**Why does the regression matter given the tool set is read-only?** Three reasons:

1. **Defense in depth.** "Read-only" is a property of the current tool inventory, not the transport. A future upstream tool named `send_campaign` in the recommendation-tools set (as an actual dispatch, not a proposal) is one PR away. When it lands, the un-scoped diagnostic agent could call it during an investigation.
2. **Prompt-injection blast radius.** With per-agent scope, a prompt-injected diagnostic model can only call diagnostic tools — no reach into `execute_analytics_eql` if it's not in that agent's set (it is, currently, but that's a choice you'd make explicit). Without per-agent scope, prompt injection has the full catalog.
3. **Cost and drift.** A larger tool list means more tokens per model turn (tool schemas ride along in the API call). The subsets exist partly for cost — narrowing to the agent's set is ~40% fewer tool schemas on the diagnostic path.

**Where the pattern comes from.** Capability-based security (Dennis & Van Horn, 1966) is the original: instead of "who is this caller, and what are they allowed to do," it's "what capability do they hold, and can they exercise it." Modern allowlist gates are the pragmatic version — a Set of names is a Set of capabilities.

**Adjacent concept: bootstrap tools.** `bootstrapTools` (`lib/mcp/tools.ts:55-59`) is a separate list for the schema-discovery phase — `list_cloud_organizations`, `list_projects`, etc. These fire once per session at connect-time. Also read-only, also in `ALL_KNOWN`. Kept separate from the per-agent sets because the agents don't call them at runtime.

**What to read next in this repo:** `04-model-output-type-guards.md` — the other half of "the model is not fully trusted" story.

---

## Interview defense

### Q: "You have a whitelist. Why is that the load-bearing part?"

**Answer:** Because the alternative — trusting the upstream to only expose safe tools — is a property of the upstream, not the system. Bloomreach could add a `delete_customer` tool tomorrow. If the code paths that reach `client.callTool(name, ...)` accept any string, the app becomes a general MCP proxy. The Set makes least-privilege a property of my code: whatever the server exposes, only these names dispatch. Adding a new tool is a code change, not a config change.

**Diagram to sketch:**

```
  Without allowlist:               With allowlist:
  ─────────────────                ───────────────
  any name → dispatch              name ∈ ALL_KNOWN → dispatch
             │                                  │
             │                                  │ else 403
             ▼                                  ▼
  vulnerable to upstream           least-privilege is
  adding writes                    a property of MY code
```

**Anchor:** `app/api/mcp/call/route.ts:15-30` — the Set is built from `tools.ts` constants, so the whitelist can't silently grow.

### Q: "You mentioned the per-agent gate regressed. Walk me through what changed and how you'd fix it."

**Answer:** Pre-migration, each agent class extended a base loop that took `toolSchemas` as an argument and passed only that filtered list to `anthropic.messages.create({ tools })`. `filterToolSchemas(allTools, diagnosticTools)` produced the narrow list. Post-migration to AptKit, each agent builds `new BloomingToolRegistryAdapter(dataSource, this.allTools)` — the full catalog — and AptKit's loop is what decides what to pass to the model.

The registry adapter doesn't gate. It's a registry, not a gate. So the model sees every tool.

**Fix (small):** filter at the agent constructor, pass a narrower `McpToolDef[]` into the registry adapter. Ten lines diffed across four files.

**Fix (stronger):** add an allowlist to `BloomingToolRegistryAdapter` so BOTH `listTools` AND `callTool` enforce it. Then a model that ignores `listTools` and just tries to call a non-listed tool by name also gets blocked. That's the version I'd ship.

**Anchor:** `lib/agents/diagnostic.ts:56`, `lib/agents/aptkit-adapters.ts:124-146` (the adapter that would carry the allowlist).

### Q: "Isn't 'the tool set is read-only' enough of a defense?"

**Answer:** For the current threat model, mostly. For the durable design, no. Three reasons: (1) "read-only" is a property of the current tool inventory that a future upstream release can change silently; (2) even read-only, unscoped access widens the exfil surface for prompt injection — the diagnostic agent shouldn't need `list_voucher_pools` to do its job; (3) defense in depth is cheap here — the Set + one filter — so paying nothing for the belt-and-braces version is the right call.

**Anchor:** `audit.md` § 7, red flag #7.

---

## See also

- `04-model-output-type-guards.md` — the other side of the "don't trust the model" story
- `05-budget-ceiling-defense.md` — the cost side of runaway tool calls
- `01-encrypted-cookie-auth-store.md` — what happens after auth succeeds and the tools become callable
- `audit.md` § 1 (attack surface) and § 7 (LLM/agent) — the lens findings
