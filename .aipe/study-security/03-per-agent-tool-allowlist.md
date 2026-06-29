# Per-agent tool allowlist

**Capability gating** at the model-tool boundary (Project-specific implementation of a language-agnostic primitive).

## Zoom out — where this concept lives

The allowlist sits at the seam between the agent loop and the MCP transport. Every tool the agent decides to call passes through it before reaching Bloomreach.

```
  Zoom out — capability gating in the request path

  ┌─ Browser (untrusted) ─────────────────────────────┐
  │  React UI · QueryBox · feed                        │
  └──────────────┬─────────────────────────────────────┘
                 │   GET /api/agent · GET /api/briefing
                 │   POST /api/mcp/call
  ┌─ Next.js routes (trusted boundary) ───────────────▼┐
  │  per-request agent loop                             │
  │  ┌──────────────────────────────────────────────┐   │
  │  │  ★ tool allowlist ★  ← we are here            │   │
  │  │  - bootstrap allowlist (BOOTSTRAP_TOOLS)       │   │
  │  │  - per-agent allowlist (READ_ONLY_TOOLS)       │   │
  │  │  - union allowlist (ALL_KNOWN)                 │   │
  │  └──────────────────────────────────────────────┘   │
  └──────┬──────────────────────────────────────────────┘
         │ hop 2: only allowed tool names ever cross
         ▼
  ┌─ Bloomreach MCP server ──────────────────────────┐
  │  loomi connect — exposes many tools per session   │
  └──────────────────────────────────────────────────┘
```

The principle: the model proposes; the allowlist disposes. The fewer tools each agent sees, the smaller the prompt-injection blast radius and the smaller the surface a steered agent can reach.

## Structure pass

**Axes:** trust (what can the model call?), control (who picks the tool list?), failure (what does the system do when a disallowed tool is requested?).

**Layers (outer → inner):**
- HTTP boundary — the `/api/mcp/call` route validates against a union allowlist before delegating.
- Agent boundary — each agent class composes its tool list before handing it to the LLM.
- Tool registry boundary — the registry adapter (`BloomingToolRegistryAdapter`) lists what the model can see.
- Transport boundary — `BloomreachDataSource.callTool` actually issues the call; no allowlist here.

**Seams:** the load-bearing seam is the *registry layer* — once the LLM has been told a tool exists, it will pick it. The HTTP boundary catches tools the model never should have known about; the registry boundary controls what the model *learns about*.

**Axis flip:** at the HTTP boundary, **the route** decides what's allowed (per `ALL_KNOWN`). At the agent boundary, **the agent class** should decide what's allowed (per `monitoringTools` / `diagnosticTools` / `recommendationTools`). When the agent layer skips the filter, the only remaining gate is the union allowlist — which is much wider than any single agent needs.

## How it works

### Move 1 — the mental model

Think of three concentric fences:

```
  Three fences — outer to inner, by who enforces

  ┌─ Bloomreach OAuth scope (server-side, outer fence) ─┐
  │                                                      │
  │  ┌─ Union allowlist — ALL_KNOWN (HTTP boundary) ─┐  │
  │  │                                                │  │
  │  │  ┌─ Per-agent allowlist (registry boundary) ─┐ │  │
  │  │  │  monitoringTools                            │ │  │
  │  │  │  diagnosticTools                            │ │  │
  │  │  │  recommendationTools                        │ │  │
  │  │  └──────────────────────────────────────────────┘ │  │
  │  └─────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────┘
```

The OAuth scope is the operator's; the union allowlist is the route's; the per-agent allowlist is each agent's. Today, the innermost fence is *configured but not enforced* — see Move 2.

### Move 2 — the step-by-step walkthrough

#### Per-agent allowlist (`READ_ONLY_TOOLS`)

The intended design lives in `lib/mcp/tools.ts`. Three constants name the tool subset each agent's job actually needs:

```ts
// lib/mcp/tools.ts:6-14
const monitoringToolsBloomreach = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

// lib/mcp/tools.ts:16-26
const diagnosticToolsBloomreach = [ /* read events + segments + campaigns */ ];

// lib/mcp/tools.ts:28-35
const recommendationToolsBloomreach = [ /* read scenarios + campaigns + vouchers */ ];
```

Each list is a **read-only** subset for that agent's task. The monitoring agent never needs `list_voucher_pools`; the recommendation agent never needs `execute_analytics_eql`. The narrower the list, the smaller the steering surface a prompt injection has.

**What breaks if the per-agent allowlist is removed (or unwired):** a prompt-injected diagnostic agent can call recommendation tools (and vice versa), and the union allowlist becomes the only fence between "agent's job" and "every tool the server exposes that the union happens to name."

#### Bootstrap allowlist (`BOOTSTRAP_TOOLS`)

The schema-bootstrap path uses its own narrow list — the four tools the orchestrator calls (`get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview`) plus the two project-resolution tools.

```ts
// lib/mcp/tools.ts:55-59
export const bootstrapTools = [
  'list_cloud_organizations', 'list_projects',
  'get_event_schema', 'get_customer_property_schema',
  'list_catalogs', 'get_project_overview',
] as const;
```

The dev-only capture route has its own literal `BOOTSTRAP_TOOLS` const (`app/api/mcp/capture/route.ts:12-21`) that overlaps but adds extras (`list_dashboards`, `list_funnels`, `list_segmentations`). Two near-duplicate lists is a smell — minor, but a drift risk.

**What breaks if `BOOTSTRAP_TOOLS` drifts from the orchestrator:** a tool the orchestrator calls but isn't in `bootstrapTools` won't pass the `/api/mcp/call` union check (since `ALL_KNOWN` includes it). Doesn't break the bootstrap (which doesn't go through `/api/mcp/call`), but breaks any manual `/debug` exercise of it.

#### Union allowlist (`ALL_KNOWN`)

The widest fence — every tool any agent or the bootstrap can ever call:

```ts
// app/api/mcp/call/route.ts:15-20
const ALL_KNOWN = new Set<string>([
  ...monitoringTools,
  ...diagnosticTools,
  ...recommendationTools,
  ...bootstrapTools,
]);
```

Used by the cookie-bound `POST /api/mcp/call` route:

```ts
// app/api/mcp/call/route.ts:22-32
export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
    }
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    ...
  }
}
```

This catches the case of a manual API client (or the `/debug` UI) trying to call a tool nobody on the agent side has any business using.

**What breaks if `ALL_KNOWN` is removed:** any cookie-bearing client could call any tool the Bloomreach OAuth scope allows — including write tools, if the scope grants them. The OAuth scope becomes the only gate.

#### The regression — registry adapter (`BloomingToolRegistryAdapter`)

Here's the gap. The live agent classes hand `this.allTools` (= every tool the server exposed at `listTools()` time) straight into the registry adapter:

```ts
// lib/agents/monitoring.ts:77-90
export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],      // ← every tool the server lists
    private sessionId?: string,
  ) {}

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
    //                                                                    ^^^^^^^^^^^^^^
    //                              passed straight through — no per-agent filter
    ...
  }
}
```

And the adapter's `listTools()` returns the lot:

```ts
// lib/agents/aptkit-adapters.ts:74-97
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,
    private readonly allTools: McpToolDef[],
  ) {}

  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
  ...
}
```

Contrast this with the legacy classes, which DO filter:

```ts
// lib/agents/diagnostic-legacy.ts:62
toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),

// lib/agents/monitoring-legacy.ts:108
toolSchemas: filterToolSchemas(this.allTools, monitoringTools),

// lib/agents/recommendation-legacy.ts:54
toolSchemas: filterToolSchemas(this.allTools, recommendationTools),

// lib/agents/query-legacy.ts:37
toolSchemas: filterToolSchemas(this.allTools, queryTools),
```

`filterToolSchemas` (`lib/agents/tool-schemas.ts:9-21`) is still exported and exercised by tests — it just has no live caller. **The per-agent fence has been disabled in the migration to AptKit.**

#### Defensive parser (`parseAgentJson`) — kept for context

In the legacy path, `parseAgentJson` (`lib/mcp/validate.ts:3-13`) extracts JSON from model output before a type guard runs. In the AptKit path, the SDK returns typed objects directly, so the parser isn't on the live boundary — but it's still relevant because the *trust assumption* the type guards encoded (that model output is untrusted) is the same assumption the per-agent allowlist enforces at a different layer. See `04-model-output-type-guard.md`.

### Move 2.5 — current state vs target state

```
  Allowlist enforcement — Phase A (today) vs Phase B (target)

  ┌─ Phase A (today) ─────────────────────┐  ┌─ Phase B (target) ─────────────────────┐
  │  HTTP route:    ALL_KNOWN              │  │  HTTP route:    ALL_KNOWN              │
  │  Agent class:   passes allTools through│  │  Agent class:   filterToolSchemas      │
  │  Registry:      returns everything     │  │  Registry:      returns the agent's    │
  │  Effective:     UNION                  │  │                 own allowlist          │
  │                                        │  │  Effective:     PER-AGENT              │
  └────────────────────────────────────────┘  └────────────────────────────────────────┘
```

Migration cost is small — three or four 2-line edits in the agent classes + one new parameter on `BloomingToolRegistryAdapter`. No data migration. No prompt change.

### Move 3 — the principle

**Trust at the registry, not just at the call.** The HTTP allowlist on `/api/mcp/call` catches the wrong client; the per-agent allowlist catches the wrong tool from the right client. Once the model has been told a tool exists, it WILL pick it under prompt pressure — so the time to remove a tool from an agent's choice set is before the LLM ever sees it, not after.

## Primary diagram

```
  Per-agent allowlist — what's enforced where (today)

  POST /api/mcp/call ─────┐
       client request      │
                           ▼
              ┌────────────────────────┐
              │ ALL_KNOWN (union)      │   ← cookie-bound HTTP gate
              │ tool ∈ ALL_KNOWN?      │     (active)
              └────────────┬───────────┘
                           │ yes
                           ▼
              ┌────────────────────────┐
              │ BloomreachDataSource   │
              │   .callTool            │
              └────────────────────────┘

  GET /api/agent ─────────┐
       agent loop          │
                           ▼
              ┌────────────────────────┐
              │ Agent class            │
              │ passes this.allTools   │   ← per-agent filter
              │ unfiltered             │     (designed, NOT wired)
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ BloomingTool-          │
              │ RegistryAdapter        │   ← returns everything
              │ .listTools()           │
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ LLM sees every tool    │
              │ → picks any of them    │
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ BloomreachDataSource   │
              │   .callTool            │   ← no allowlist here
              └────────────────────────┘
```

The dashed loop on the right is the regression. The HTTP path on the left is healthy.

## Elaborate

The pattern is **capability-based security** applied to LLM tool use. The general form: a principal (here, an agent) is granted exactly the capabilities (tools) it needs to do its job, no more. The narrower the grant, the smaller the consequence of an authority leak (here, a prompt injection).

The original tradeoff this codebase made: define the allowlists once in `lib/mcp/tools.ts` and consume them at two layers — the HTTP boundary (for the manual `/api/mcp/call` route) and the agent boundary (for the in-loop tool surface). The migration to AptKit kept the HTTP consumer but dropped the agent consumer. The fix is to restore the agent consumer; the migration didn't require dropping it, the registry adapter just needs to take a filter argument.

**Related reading inside this guide:**
- `04-model-output-type-guard.md` — the sibling control at the *output* boundary (this one is the *input* boundary, from the LLM's perspective).
- `06-session-isolation.md` — the boundary that scopes "whose tools" to "whose session."

**Related industry concepts:**
- POLA (Principle of Least Authority) — the design principle this is implementing.
- Capability-based security (Mark Miller, E language) — the original formalization.
- OAuth scopes — the same idea at the IdP layer; this is the same idea at the in-process layer.

## Interview defense

**Q: Why two allowlists?**
**A:** Different threat models. `ALL_KNOWN` is the *cookie-bound HTTP* gate — it catches a manual API client trying to call a tool no agent ever should. The per-agent lists are the *in-prompt* gate — they catch a prompt-injected agent trying to use a tool outside its job. Without the per-agent layer, the union is the only fence and the diagnostic agent has the same authority as the recommendation agent. The load-bearing part most people forget is that the LLM *will* pick a tool you put in front of it — so you remove tools by not telling the LLM they exist, not by filtering its output.

```
  Two fences, two threat models

  cookie-bound caller ──► ALL_KNOWN ──► transport
  in-prompt LLM       ──► per-agent ──► transport
                            ↑
                  this layer is the regression
```

**Q: Why kebab-case constants instead of an enum or class?**
**A:** They're the literal tool names the Bloomreach MCP server exposes; matching them against the server-side names is a string compare. An enum would just add a layer that has to convert back to strings before the gate compares them — same correctness, more code.

**Q: What about write tools?**
**A:** The current Bloomreach surface the lists name is read-only by convention (`list_*`, `get_*`, `execute_analytics_eql` against a read-only engine). The `execute_analytics_eql` tool is the broadest — it can run arbitrary EQL — but EQL is analytics-only; no mutation verbs. If the server ever exposes a write tool, the per-agent filter is the place to make sure no agent (or only one explicitly-named recommend agent) sees it.

## See also

- `04-model-output-type-guard.md` — the output-boundary control.
- `02-oauth-pkce-dcr-boundary.md` — the outer OAuth-scope fence.
- `audit.md` § 7 (LLM and agent security) — the lens this finding falls under.
- `lib/mcp/tools.ts` — the canonical allowlists.
- `lib/agents/tool-schemas.ts:9-21` — `filterToolSchemas`, the helper waiting to be re-wired.
