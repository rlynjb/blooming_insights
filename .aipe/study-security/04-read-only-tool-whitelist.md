# 04 · read-only-tool-whitelist

**Capability scoping by curated allowlist** · Industry standard
(principle of least authority for LLM agents)

## Zoom out — where this lives

Claude is the model. Bloomreach exposes ~50+ MCP tools (reads,
writes, deletes, scenario triggers). The agents in this app should
never be able to send a write. The way that's enforced isn't a
runtime check after-the-fact — it's a **curated set of tool names
passed to Claude in the first place.**

```
  Zoom out — the tool surface, by layer

  ┌─ UI ─────────────────────────────────────────────────────────┐
  │ user asks the monitoring agent to scan                        │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ Service ──────────────▼─────────────────────────────────────┐
  │ route handler builds an Anthropic request                     │
  │  ├─ system prompt: "you are the monitoring agent"             │
  │  └─ tools: [ ★ monitoringTools ★ ]   ← we are here            │
  │                       │                                       │
  │                       │ only these 13 names exist             │
  │                       │ in the request                        │
  │                       ▼                                       │
  │ Claude sees a 13-tool surface. The other ~40 don't exist      │
  │ from its point of view.                                       │
  └──────────────────────────────────────────────────────────────┘
```

The pattern: **the agent's authority is the size of its tool list.**
A tool the model doesn't know about is a tool it can't call.

## Structure pass

  → **Layers.** Three: the *server's* full catalog of tools (~50+,
    discovered via `listTools`); each *agent's* curated subset
    (`monitoringTools`, `diagnosticTools`, …); the *bootstrap* set
    used at session start.

  → **Axis to hold constant: "which agent can call which tool, and
    why that one?"**

    ```
      altitude            answer
      ──────────────      ──────────────────────────────────────────
      Bloomreach server   exposes everything the OAuth scope permits
                          (catalog, customers, scenarios, voucher
                          pools, write tools, …)
      our agent layer     each agent gets a job-shaped subset:
                            monitoring  → metric reads only
                            diagnostic  → reads needed to investigate
                            recommend.  → reads needed to propose
                          NONE of the three include a write tool
      Claude              sees only the subset the route passed it
                          for this turn
    ```

    The answer flips between layers: full → curated → curated. The
    boundary between "Bloomreach can do this" and "this app can do
    this" is the per-agent allowlist.

  → **Seams.** Two load-bearing joints:
    - **tool catalog ↔ allowlist** (`lib/mcp/tools.ts`). The
      hand-written union of names is the contract.
    - **allowlist ↔ Anthropic request** (the agent class passes its
      `allowedTools` slice when building the `tools:` array). The
      request body is where the contract becomes enforcement.

## How it works

### Move 1 — the mental model

Same shape as a Unix process running with limited capabilities
(`setcap`, OS sandbox profiles). The kernel won't honor a syscall the
process doesn't have the capability for. Here, the model won't *attempt*
a tool it wasn't told about, because the request to Anthropic doesn't
include it. Same effect — limit the verbs before you start the program.

```
  the pattern — the verb list IS the boundary

  Bloomreach exposes (server side):
  ─────────────────────────────────
    list_customers      ◄── read
    get_event_schema    ◄── read
    execute_analytics   ◄── read
    update_customer     ◄── WRITE
    delete_customer     ◄── WRITE
    trigger_scenario    ◄── WRITE
    create_segment      ◄── WRITE
    … (many more)


  Monitoring agent receives (in the Anthropic request):
  ────────────────────────────────────────────────────
    list_dashboards
    get_dashboard
    list_trends
    get_trend
    list_funnels
    get_funnel
    list_running_aggregates
    get_running_aggregate
    list_reports
    get_report
    execute_analytics
    execute_analytics_eql       ← all 13 are read tools
    get_customer_prediction_score
                                ← no write tool exists in this list
                                  → Claude cannot ask for one
                                  → blast radius bounded to reads
```

### Move 2 — the step-by-step walkthrough

#### a · the per-agent allowlists — `lib/mcp/tools.ts`

Three sibling consts, one per agent. Each is a hand-written `as const`
array of tool names. Read top-to-bottom: the file *is* the
authorization policy.

```
  the per-agent allowlists — three small lists, one rule

  monitoringTools     (13 read tools — "detect changes")
  diagnosticTools     (16 read tools — "investigate causes")
  recommendationTools (7  read tools — "propose actions")
  bootstrapTools      (6  read tools — "discover schema")
                       ────────────────────────────────────
                       UNION = ALL_KNOWN (used by /api/mcp/call)
```

Real code (`lib/mcp/tools.ts:5-35`):

```ts
const monitoringToolsBloomreach = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

const diagnosticToolsBloomreach = [
  'execute_analytics', 'execute_analytics_eql',
  'get_funnel', 'get_event_segmentation',
  'list_customers', 'list_customer_events',
  'list_customers_in_segment', 'list_segmentations',
  'list_email_campaigns', 'list_sms_campaigns',
  'list_in_app_messages', 'list_banners',
  'list_experiments', 'list_scenarios',
  'list_catalog_items', 'get_catalog_item',
  'get_customer_prediction_score',
] as const;

const recommendationToolsBloomreach = [
  'list_scenarios', 'get_scenario',
  'list_initiatives', 'get_initiative_items',
  'list_recommendations', 'get_recommendation',
  'list_segmentations', 'list_email_campaigns',
  'list_voucher_pools',
  'get_frequency_policies',
] as const;
```

What breaks if removed: drop the per-agent split → every agent sees
every tool, the monitoring agent (driven by a high-level "scan for
anomalies" prompt) could decide that listing every email campaign
serves the goal and burn the rate-limit budget. Drop the read-only
discipline (add `update_customer` "just for testing") → a prompt
injection that says "the user wants you to delete customer X" can
now actually delete customer X.

The list is intentionally *small*. Bloomreach exposes many more
tools; the agents only get the ones they need for their job. That
the names map verb-by-verb (`list_*`, `get_*`, `execute_*`) makes
the read-only nature visible at a glance during review.

#### b · the bootstrap allowlist (`bootstrapTools`) — different consumer, different scope

The session-start path is a different beast. It runs once at the top
of every briefing/investigation to discover schema. It needs a few
tools the agents don't (`list_cloud_organizations` to find the right
project, `get_event_schema` for prompt context). It's also small and
read-only.

Real code (`lib/mcp/tools.ts:55-59`):

```ts
export const bootstrapTools = [
  'list_cloud_organizations', 'list_projects',
  'get_event_schema', 'get_customer_property_schema',
  'list_catalogs', 'get_project_overview',
] as const;
```

What breaks if removed: drop `list_cloud_organizations` → the resolve
chain in `lib/mcp/schema.ts:166-184` can't find the project id, every
subsequent call fails with "no cloud organizations." The bootstrap
list is the *minimum* shape the schema-discovery orchestrator needs.

#### c · the union allowlist (`ALL_KNOWN`) — gating the proxy route

`POST /api/mcp/call` is the only route that lets the *client* name a
tool. It takes the union of all four lists (so the UI's debug page
can introspect any tool the app ever uses) and rejects anything
outside.

```
  ALL_KNOWN — the union allowlist for the proxy route

  monitoringTools ∪ diagnosticTools ∪ recommendationTools ∪ bootstrapTools
       │                  │                  │                   │
       └──────────────────┴────────┬─────────┴───────────────────┘
                                   ▼
                              ALL_KNOWN
                              (POST /api/mcp/call gates on this)
```

Real code (`app/api/mcp/call/route.ts:14-27`):

```ts
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
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });   // ← gate
    }
    …
```

What breaks if removed: drop the `ALL_KNOWN.has(name)` check → a
session-auth'd caller can name *any* tool the Bloomreach server
exposes for this tenant, including the write tools the agents are
specifically prevented from calling. The whole rest of the
defense-in-depth (per-agent allowlist, type guards, FALLBACK) is
about constraining the *agents*; this check is about constraining
the *client* calling through the proxy. See
`05-open-tool-surface-gap.md` for the residual concern (union ≠
per-agent scoping).

#### d · why hand-written vs auto-derived

The allowlist could be auto-generated from a "give me all read tools"
filter on the server-discovered catalog. It isn't. Two reasons:

  → **You'd trust the server's classification of read vs write.** The
    Bloomreach catalog doesn't categorize tools that way; the
    distinction lives in the tool *behavior*, which is documented
    elsewhere. A hand-curated list is auditable in one read.
  → **You'd add tools the agent doesn't *need*.** The monitoring
    agent has 13 tools, not "every read tool" (~25+). Smaller
    surface = smaller prompt = cheaper inference + less for Claude
    to get distracted by.

The cross-check tool (`lib/mcp/tool-coverage.ts`, exposed at
`GET /api/mcp/tools/check`) verifies every name in the curated lists
exists in the live catalog. That catches the inverse failure: a
configured tool name that the server doesn't expose (rename,
removal) is detected before Claude wastes a rate-limited call on
it.

### Move 3 — the principle

**Principle of least authority (POLA): an agent gets only the
capabilities its job needs, no more.** For LLMs this is concrete: the
agent's tool list IS its authority. A tool not in the list cannot be
called even by a perfectly-prompt-injected model. Same shape as Unix
capabilities, AWS IAM scoped roles, OAuth scopes — the only LLM-
specific bit is that the substrate is "the JSON array in the
`tools:` field" rather than a kernel/cloud check.

## Primary diagram

```
  the full read-only-by-construction picture

  ┌─ Bloomreach catalog (server-side) ─────────────────────────────┐
  │ list_*  · get_*  · execute_*  · update_*  · delete_*  · trigger│
  │ create_segment  · update_customer  · …                          │
  └─────────────────────────┬──────────────────────────────────────┘
                            │ listTools()
                            ▼
  ┌─ Service: agent setup ─────────────────────────────────────────┐
  │                                                                 │
  │  ┌─ monitoringTools (13) ─┐  ┌─ diagnosticTools (16) ─┐  ┌─ rec.Tools (7) ─┐  │
  │  │ list/get/execute reads │  │ list/get/execute reads │  │ list/get reads  │  │
  │  └────────┬───────────────┘  └────────┬──────────────┘  └────────┬────────┘  │
  │           │                            │                          │           │
  │           ▼                            ▼                          ▼           │
  │   anthropic.messages.create   anthropic.messages.create   anthropic.messages  │
  │   { tools: monitoringTools }  { tools: diagnosticTools }  { tools: rec…Tools }│
  │                                                                                │
  └────────────────────┬───────────────────┬──────────────────────────┬───────────┘
                       │                   │                          │
                       ▼                   ▼                          ▼
                  ┌─ Claude ──────────────────────────────────────────────┐
                  │ sees only the tools in this turn's request            │
                  │ — write tools literally not in the surface to call    │
                  └───────────────────────────────────────────────────────┘

                       │                   │                          │
                       └─── union (∪) ─────┴────────── + bootstrap ───┘
                                  │
                                  ▼
                          ALL_KNOWN (Set)
                                  │
                                  ▼
                   ┌─ POST /api/mcp/call gates here ─┐
                   │  tool name must be in ALL_KNOWN │
                   │  else 403 'tool not allowed'    │
                   └─────────────────────────────────┘
```

## Elaborate

The "agent loop" with tools is barely two years old, but the security
shape is older. SELinux type enforcement, AppArmor profiles, AWS IAM
role-based scopes, OAuth scope strings — all variations of "name the
verbs this principal is allowed to invoke." For LLM agents the
substrate happens to be JSON in a chat completion request, not a
kernel attribute. The threat model differs in one key way: the agent
is *intelligent and probabilistic*, so you can't rely on it to
"choose not to call X" — you have to remove X from its surface.

Adjacent concepts:
  → **OpenAI Assistants API** — same shape: you pass `tools` per
    assistant; the model can call any of them.
  → **MCP server-side scoping** — a future Bloomreach feature could
    expose per-OAuth-scope tool catalogs (the catalog returned by
    `listTools` is already filtered by token scope server-side, but
    the granularity is coarse).
  → **Tool-call structured-output validation** — Anthropic validates
    each tool call's `arguments` against the tool's `input_schema`
    before invoking your handler. That's a *second* boundary (input
    validation) layered on top of the *first* (tool existence).

## Interview defense

### Q1. "Why not let the model call any read tool — what's wrong with the broader allowlist?"

```
  three reasons — interest scope, prompt size, audit cost

  ┌─ interest scope ────────────────────────────────────────┐
  │ a smaller surface means the model's reasoning stays on  │
  │ the job. give it list_voucher_pools when its job is     │
  │ "detect a revenue anomaly" and you've handed it 8       │
  │ irrelevant ways to spend a rate-limited call            │
  └─────────────────────────────────────────────────────────┘
  ┌─ prompt size ───────────────────────────────────────────┐
  │ each tool's schema goes into the request. 50 tools per  │
  │ call ≈ 5-10kB of extra prompt tokens, every turn        │
  └─────────────────────────────────────────────────────────┘
  ┌─ audit cost ────────────────────────────────────────────┐
  │ a 13-tool list is one screen; "every read tool" is a    │
  │ moving target. the security review is one diff away     │
  └─────────────────────────────────────────────────────────┘
```

The bound is operational, not security. The security bound is "no
write tools, anywhere, in any agent's list." The per-agent split is
how you keep that bound *and* a manageable prompt size *and* an
auditable file.

**One-line anchor:** "Three reasons — keeps the model on-task, keeps
the prompt small, keeps the security review one screen. The write-
free bound is the security part; the per-agent split is the practical
part."

### Q2. "What about the queryTools union — that's broad?"

The free-form QueryAgent (`lib/agents/query.ts`) handles "ask
anything about your workspace." Its tools are the union of all three
agent tool lists (`lib/mcp/tools.ts:42-45`). That's deliberate: the
user could ask a monitoring question OR a diagnostic question OR a
recommendation question, and the agent classifies intent at request
time (`classifyIntent`) but still needs the tools to actually answer.

```
  queryTools — the deliberate-union tradeoff

  user asks free-form question
        │
        ▼
  classifyIntent(q) ──► 'monitoring' | 'diagnostic' | 'recommendation'
        │
        │ (the intent FRAMES the answer; it doesn't pre-scope tools)
        ▼
  QueryAgent.answer(q, intent)
        │
        │ tools = queryTools (union of all read tools)
        ▼
  Claude calls 1-6 tools, answers

  fix-up if it ever matters: intersect queryTools with the per-intent
  allowlist. Today the cost of being broad = "lists email campaigns
  when answering a revenue question" — annoying, not unsafe.
```

The fix is one diff (intersect on intent), but the security floor is
still "no write tools." The lens-7 finding in `audit.md` calls this
out as a partial fire (red flag #9 in the capstone table).

**One-line anchor:** "Deliberate union — the intent classifies the
*answer*, not the tools. Fix is one diff (intersect on intent); the
write-free floor still holds."

### Q3. "What if Bloomreach adds a write tool with the same prefix — would the agent suddenly call it?"

No, and that's the design. The allowlist is a hand-written
positive list, not a pattern (`list_*`, `read_*`). A new tool from
Bloomreach is invisible to the agent until someone adds it explicitly
to the file. The cross-check route
(`GET /api/mcp/tools/check`) verifies the list against the live
catalog — if Bloomreach *removes* a tool the allowlist names, the
report flags it.

```
  positive-list discipline — no pattern, only names

  ❌ allow:  /^(list|get|execute)_/    ← would auto-grant new tools
  ✅ allow:  ['list_dashboards', 'get_dashboard', …]
                                       ← explicit; new tools are
                                         invisible until reviewed
```

**One-line anchor:** "Positive list, not a pattern. A new Bloomreach
tool is invisible to the agent until someone adds it; the cross-check
route flags removals."

## See also

  → `03-type-guard-trust-boundary.md` — the matching control on the
    *output* side: the model's response is validated before it flows
    into the UI.
  → `05-open-tool-surface-gap.md` — the residual concern: the
    `/api/mcp/call` proxy's allowlist is the *union*, not per-agent
    or per-args.
  → `audit.md` § lens 7 (llm-and-agent-security) for the wider context.
