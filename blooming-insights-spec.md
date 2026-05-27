# blooming insights — implementation spec

> a multi-agent AI analyst for bloomreach engagement, built natively on loomi connect mcp.

---

## context

### what this is

blooming insights is a next.js app that watches a bloomreach engagement workspace and answers three questions for ecommerce teams: **what changed, why, and what should i do about it.** it does this through a coordinated team of three specialist agents (monitoring, diagnostic, recommendation) orchestrated by a coordinator. all data access goes through the loomi connect mcp server. the agent's reasoning is a first-class ui surface, not a black box.

### why it exists

ecommerce teams drown in dashboards trying to answer "what happened and what should i do." manually correlating funnel, catalog, traffic, and behavior data takes hours, so most decisions end up driven by gut. existing analyst tools (conjura, graas, owly) surface insights but hide their reasoning. blooming insights differentiates on **transparent multi-agent reasoning, native to bloomreach via mcp**.

### what success looks like

- a daily auto-generated insight feed loads on app open, showing 3–5 notable changes in the workspace
- clicking any insight opens a deep-dive view that shows the agents' reasoning step by step, including which mcp tools were called
- a natural-language query box at the bottom of every screen accepts free-form questions
- a merchandising lead can go from "something feels off" to "i have a diagnosis with evidence and three recommended actions" in under a minute
- the agent's work is fully legible — every conclusion shows the hypotheses considered, the tool calls made, and the evidence collected
- recommendations are grounded in real bloomreach features (scenarios, segments, campaigns, vouchers) — not generic advice

### what this is not

- not a chatbot
- not a write-path tool (read-only mcp; recommendations are suggestions, not actions)
- not a generic analytics dashboard (no manual chart builder)
- not multi-tenant (single workspace: `wobbly-ukulele`)

---

## hackathon alignment

this project is built for the **loomi connect ai hackathon (june 2026)**, primary challenge **track 3 — analytics agents & decision intelligence**.

### key dates

| milestone | date |
|---|---|
| build window opens | may 26, 2026 (after kickoff) |
| final submission deadline | **jun 2, 2026, 4:00 pm pst** |
| demo day / closing ceremony | jun 4, 2026 |

upload demo video at least 24h before deadline. test the link in incognito to confirm accessibility.

### how this maps to the judging rubric

five criteria, 20% each. the build should be designed to hit all five intentionally:

| criterion | how blooming insights addresses it |
|---|---|
| **problem relevance & clarity (20%)** | named target user (merch leads, store operators without analysts). specific pain (hours of manual correlation). measurable value (30-second time-to-answer). |
| **mcp utilization & depth (20%)** | uses analytics + marketing mcp tools across three agents. not a wrapper — each agent uses 8–15 tools, with strategic tool selection per hypothesis. tool calls visible in the reasoning trace. |
| **agent behavior & intelligence (20%)** | three specialist agents coordinated by a fourth. demonstrable understand → decide → recommend flow. hypothesis-driven diagnostic agent makes the reasoning legible. |
| **execution quality & feasibility (20%)** | next.js + typescript + vercel. clean architecture, real auth, real mcp calls. demo runs reliably with cached fallback mode. |
| **innovation & differentiation (20%)** | the reasoning trace as a first-class ui surface — "transparent multi-agent reasoning" — is the differentiator vs existing analyst tools (conjura, graas, owly) that produce black-box outputs. |

### the agent workflow pattern

the kit specifies: **understand → decide → recommend / prepare / orchestrate**, with **human review** for any business-impacting action. blooming insights implements this directly:

1. **understand** — monitoring agent reads workspace state, detects what changed
2. **decide** — diagnostic agent generates hypotheses, queries to test each, concludes with evidence
3. **recommend** — recommendation agent proposes 2–3 actions grounded in real bloomreach features
4. **human review** — recommendations sit in the ui awaiting approval; nothing executes automatically. an optional "apply" button (phase 6) would simulate or prepare an action; never execute it autonomously.

### data handling

- **data source**: live `wobbly-ukulele` sandbox workspace via mcp (kit-approved)
- **synthetic fallback**: cached mode (`?demo=cached`) replays seeded responses for demo resilience (kit-approved and encouraged)
- **no production customer data**, no pii processed outside the approved sandbox
- **credentials**: bloomreach mcp credentials delivered via dedicated slack channel; never committed to repo or shown in screenshots
- **what is simulated vs executed**: every recommendation is a suggestion only. nothing is sent, applied, or executed without explicit human approval. if a "apply" button is built (stretch), it stays in simulation mode for the demo.

### slack channels

| channel | purpose |
|---|---|
| `#loomi-connect` | mcp surfaces, technical questions (tag @andrew-kumar, @peter-centgraf) |
| `#sandbox-support` | credentials, access issues |
| `#announcements` | deadlines, office hours |
| `#team-[name]` | team-level working channel |

---

## stack

- next.js 15 (app router)
- typescript
- tailwind css
- anthropic sdk for typescript (`@anthropic-ai/sdk`)
- mcp typescript sdk (`@modelcontextprotocol/sdk`)
- server-sent events (sse) for streaming agent responses
- vercel for deploy (not netlify — see deployment notes below)
- no database (state is per-session; insights cache in memory)

### deployment: vercel, not netlify

despite the rest of the personal stack defaulting to netlify, this project deploys to vercel. reasons:

- vercel built next.js; deployment is zero-config
- next.js streaming + sse works flawlessly on vercel; netlify has quirks with long-lived connections on free tier
- vercel free tier function timeout is 60s; netlify functions cap at 10s on free tier — agent calls will exceed this
- vercel preview urls per commit make demoing trivial (every push = a new shareable demo url)

### references

- official bloomreach mcp ts client sample: `github.com/bloomreach/loomi-connect-mcp-client-examples`
- community python demo (auth reference only): `github.com/gaborfekete85/bloomreach-mcp`
- loomi connect docs: `documentation.bloomreach.com/loomi-connect/docs/get-started-with-mcp`

---

## environment

```bash
# .env.local
ANTHROPIC_API_KEY=
BLOOMREACH_MCP_URL=https://loomi-mcp-alpha.bloomreach.com/mcp/
BLOOMREACH_PROJECT_ID=  # the wobbly-ukulele project id, discovered at bootstrap
NEXT_PUBLIC_APP_NAME="blooming insights"
```

---

## architecture

### tier diagram

```
[next.js ui] → [api/agent route (sse)] → [coordinator agent]
                                             ├─→ [monitoring agent]
                                             ├─→ [diagnostic agent]
                                             └─→ [recommendation agent]
                                                       ↓
                                              [mcp client layer]
                                                       ↓
                                          [loomi connect mcp server]
                                                       ↓
                                          [bloomreach engagement workspace]
```

### file structure

```
/app
  /api
    /agent/route.ts           # sse endpoint; main agent entry
    /briefing/route.ts        # morning briefing generation
  /investigate/[id]/page.tsx  # deep-dive view
  layout.tsx
  page.tsx                    # insight feed homepage

/components
  /feed
    InsightCard.tsx
    SeverityBadge.tsx
  /investigation
    ReasoningTrace.tsx
    ToolCallBlock.tsx
    EvidencePanel.tsx
    RecommendationCard.tsx
  /chat
    QueryBox.tsx
    StreamingResponse.tsx
  /shared
    AgentBadge.tsx            # visual indicator: which agent produced what

/lib
  /mcp
    auth.ts                   # oauth flow, token storage
    client.ts                 # callTool(name, args) with cache + rate limit
    tools.ts                  # typed tool definitions per agent
    types.ts                  # response shapes
    schema.ts                 # bootstrap: workspace schema discovery
  /agents
    coordinator.ts            # orchestrator
    monitoring.ts             # specialist 1
    diagnostic.ts             # specialist 2
    recommendation.ts         # specialist 3
    prompts/
      coordinator.md
      monitoring.md
      diagnostic.md
      recommendation.md
  /state
    insights.ts               # in-memory cache of generated insights
    session.ts                # session token storage
  /design
    tokens.ts                 # colors, fonts, spacing

/public
  /fonts                      # syne, jetbrains mono, inter
```

---

## design system

navy + accent palette from the aipe/dpth aesthetic. dark mode only.

```ts
// lib/design/tokens.ts
export const colors = {
  bg: {
    base: '#0f1923',
    surface: '#1a2332',
    elevated: '#243040',
    border: '#2d3a4d',
  },
  text: {
    primary: '#e8edf2',
    secondary: '#8b9bb0',
    tertiary: '#5a6878',
  },
  accent: {
    teal: '#00d9a3',      // positive insights, agent activity
    coral: '#fb7185',     // anomalies, problems
    amber: '#fbbf24',     // warnings
    purple: '#a78bfa',    // ai reasoning, agent traces
  },
} as const;

export const fonts = {
  display: 'Syne',           // headings
  body: 'Inter',             // body copy
  mono: 'JetBrains Mono',    // metrics, tool calls, data
} as const;
```

ui rules:
- lowercase throughout (matches personal voice)
- no border radius above 4px on functional elements (sharp aesthetic)
- monospace for all numeric values and tool names
- no emoji; use shape/color severity indicators
- generous whitespace between insight cards

---

## data model

### types

```ts
// lib/mcp/types.ts

export type Severity = 'critical' | 'warning' | 'info' | 'positive';

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
}

export interface ToolCall {
  id: string;
  agent: AgentName;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

export interface ReasoningStep {
  id: string;
  agent: AgentName;
  kind: 'thought' | 'tool_call' | 'hypothesis' | 'conclusion';
  content: string;
  toolCall?: ToolCall;
}

export interface Investigation {
  insightId: string;
  reasoning: ReasoningStep[];
  diagnosis: {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: string[];
  };
  recommendations: Recommendation[];
}

export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: string;    // "scenario", "segment", "campaign", "voucher"
  estimatedImpact: string;
  confidence: 'high' | 'medium' | 'low';
}

export type AgentName = 'coordinator' | 'monitoring' | 'diagnostic' | 'recommendation';
```

---

## mcp client layer

### auth

bloomreach uses oauth via browser flow. for hackathon scope:

1. on first tool call, server detects no session
2. server returns a 401 with an auth url
3. ui opens auth url in a new tab
4. user authenticates with bloomreach credentials
5. session token returned via callback to `/api/mcp/callback`
6. token stored server-side in a simple in-memory map keyed by user session (cookie)
7. subsequent tool calls include the bearer token
8. sessions last 30 days

```ts
// lib/mcp/auth.ts

export interface McpSession {
  token: string;
  expiresAt: number;
}

const sessions = new Map<string, McpSession>();

export async function getSession(sessionId: string): Promise<McpSession | null> {
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

export async function startAuthFlow(): Promise<{ authUrl: string; state: string }> {
  // generate state token, build oauth url pointing to bloomreach idp
  // include redirect_uri to /api/mcp/callback
  // ...
}

export async function handleCallback(code: string, state: string): Promise<McpSession> {
  // exchange code for token
  // store session
  // ...
}
```

reference the official bloomreach ts sample for the exact oauth params.

### client

```ts
// lib/mcp/client.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

interface CallToolOptions {
  cacheTtlMs?: number;          // default 60s
  skipCache?: boolean;
}

interface CallToolResult<T = unknown> {
  result: T;
  durationMs: number;
  fromCache: boolean;
}

export class McpClient {
  private client: Client;
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs = 200;  // ~5 req/s ceiling

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {}
  ): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }

    // rate limit
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }

    const start = Date.now();
    const result = await this.client.callTool({ name, arguments: args });
    const durationMs = Date.now() - start;
    this.lastCallAt = Date.now();

    this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
    return { result: result as T, durationMs, fromCache: false };
  }
}
```

### tools per agent

```ts
// lib/mcp/tools.ts

export const monitoringTools = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

export const diagnosticTools = [
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

export const recommendationTools = [
  'list_scenarios', 'get_scenario',
  'list_initiatives', 'get_initiative_items',
  'list_recommendations', 'get_recommendation',
  'list_segmentations', 'list_email_campaigns',
  'list_voucher_pools',
  'get_frequency_policies',
] as const;

export const bootstrapTools = [
  'whoami',
  'list_projects', 'get_project_overview',
  'get_event_schema', 'get_customer_schema', 'get_mapping',
] as const;
```

### schema bootstrap

called once on first authenticated session. caches workspace shape so agents don't waste tokens rediscovering it on every call.

```ts
// lib/mcp/schema.ts

export interface WorkspaceSchema {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[] }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
}

export async function bootstrapSchema(client: McpClient): Promise<WorkspaceSchema> {
  const project = await client.callTool('get_project_overview', {});
  const events = await client.callTool('get_event_schema', {});
  const customerSchema = await client.callTool('get_customer_schema', {});
  const catalogs = await client.callTool('list_catalogs', {});

  return {
    // ... shape from responses
  };
}
```

---

## agents

### coordinator

orchestrates the three specialists. has three modes:

**briefing mode** — called by `/api/briefing`:
1. invoke monitoring agent → returns top n anomalies
2. for top 3 anomalies, invoke diagnostic agent in parallel
3. for each diagnosis, invoke recommendation agent
4. assemble insight cards, return

**investigation mode** — called when user clicks an insight:
1. retrieve the cached anomaly
2. invoke diagnostic agent with full context
3. invoke recommendation agent on diagnosis
4. stream reasoning steps via sse as they happen

**query mode** — called by query box:
1. classify intent: is this monitoring (what's new), diagnostic (why), or recommendation (what to do)?
2. route to appropriate specialist(s)
3. if cross-cutting, invoke multiple in sequence
4. stream final synthesis

```ts
// lib/agents/coordinator.ts

export class Coordinator {
  constructor(
    private anthropic: Anthropic,
    private mcp: McpClient,
    private schema: WorkspaceSchema,
  ) {}

  async generateBriefing(): Promise<Insight[]> {
    // 1. monitoring agent scans for changes
    const anomalies = await this.monitoringAgent.scan();

    // 2. top 3 → diagnostic in parallel
    const diagnoses = await Promise.all(
      anomalies.slice(0, 3).map(a => this.diagnosticAgent.investigate(a))
    );

    // 3. each diagnosis → recommendations
    const insights: Insight[] = [];
    for (const [anomaly, diagnosis] of zip(anomalies, diagnoses)) {
      const recs = await this.recommendationAgent.propose(anomaly, diagnosis);
      insights.push({ ...anomaly, diagnosis, recommendations: recs });
    }
    return insights;
  }

  async *investigate(insightId: string): AsyncGenerator<ReasoningStep> {
    // streams reasoning steps as they happen
    // each yielded step is sent to the ui via sse
  }

  async *handleQuery(query: string): AsyncGenerator<ReasoningStep> {
    const intent = await this.classifyIntent(query);
    // route + stream
  }
}
```

### monitoring agent

prompt-engineered claude call with tool access. system prompt in `prompts/monitoring.md`.

**job**: read current workspace state, compare to recent baseline, return structured list of significant changes.

**output schema**:
```ts
interface Anomaly {
  metric: string;
  scope: string[];           // ["mobile", "checkout"]
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
}
```

**prompt skeleton** (`prompts/monitoring.md`):
```
you are the monitoring agent in blooming insights, an ai analyst for bloomreach engagement.

your job: watch the workspace and report what changed. you do not investigate causes.
you do not propose actions. you only detect and report significant changes.

available tools:
- list_dashboards / get_dashboard — read pre-built dashboards
- get_trend, get_funnel — read time-series and conversion data
- execute_analytics_eql — run custom analytical queries
- get_customer_prediction_score — read churn/ltv predictions

workspace schema:
{schema}

rules:
1. compare current state to a baseline (last 7d, last 14d, or last 30d depending on the metric)
2. report only changes that are statistically meaningful (>10% shift, or crossing a threshold)
3. include the scope (segment, device, channel, product, etc.) that's most affected
4. cite the specific tool calls that produced your conclusion
5. return a structured json array of anomaly objects

return at most 10 anomalies, sorted by severity. if you find fewer, that's fine.
```

### diagnostic agent

**job**: given an anomaly, investigate why. generate competing hypotheses, query to test each, conclude with evidence.

**output schema**:
```ts
interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
}
```

**prompt skeleton** (`prompts/diagnostic.md`):
```
you are the diagnostic agent in blooming insights. you investigate why something changed.

your job: given an anomaly, generate 2–3 competing hypotheses, query data to test each, and
conclude with the best-supported explanation.

available tools:
- execute_analytics_eql — your primary investigation tool
- get_event_segmentation, get_funnel — drill into behavior
- list_customers, list_customer_events — customer-level signal
- list_customers_in_segment — segment-level analysis
- list_email_campaigns, list_in_app_messages, list_banners — recent marketing activity
- list_experiments, list_scenarios — active automation
- list_catalog_items — product state
- get_customer_prediction_score — churn/ltv predictions

workspace schema:
{schema}

anomaly to investigate:
{anomaly}

rules:
1. generate 2–3 hypotheses before querying
2. for each hypothesis, identify what evidence would support or refute it
3. query strategically — use the cheapest tool first
4. show your work: every tool call should map to a hypothesis test
5. conclude with the single most-supported explanation, plus the evidence
6. if no hypothesis is well-supported, say so honestly

return a structured json diagnosis object.
```

### recommendation agent

**job**: given a diagnosis, propose 2–3 concrete actions grounded in bloomreach capabilities.

**output schema**:
```ts
interface Recommendation {
  title: string;                // "send recovery email to abandoned mobile cart segment"
  rationale: string;            // why this addresses the diagnosis
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];              // human-readable steps to execute
  estimatedImpact: string;
  confidence: 'high' | 'medium' | 'low';
}
```

**prompt skeleton** (`prompts/recommendation.md`):
```
you are the recommendation agent in blooming insights. you propose actions to fix problems or
amplify positive trends.

your job: given a diagnosis, propose 2–3 specific actions the merchant can take using
bloomreach engagement features. ground each recommendation in real capabilities.

available tools:
- list_scenarios, get_scenario — see what automation already exists
- list_initiatives, get_initiative_items — upcoming planned activity
- list_recommendations — existing recommendation models
- list_segmentations — available customer segments
- list_email_campaigns — email templates available
- list_voucher_pools — discount infrastructure
- get_frequency_policies — communication frequency rules

diagnosis:
{diagnosis}

rules:
1. propose 2–3 actions, not more
2. each action must reference a real bloomreach feature (scenario, segment, campaign, voucher)
3. check existing scenarios first — don't propose something that's already running
4. estimate impact qualitatively ("likely recovers ~20% of mobile abandonments")
5. mark confidence honestly — low if you're guessing, high if you have strong evidence
6. order by predicted impact, highest first

return a structured json array of recommendation objects.
```

---

## ui surfaces

### surface 1: insight feed (`/`)

morning briefing. loads `/api/briefing` on mount. shows insight cards stacked vertically.

```tsx
// app/page.tsx
export default async function FeedPage() {
  // 1. trigger briefing generation (or read cached)
  // 2. render insight cards with severity indicators
  // 3. each card links to /investigate/[id]
  // 4. query box fixed at bottom
}
```

card anatomy:
- severity dot (teal/amber/coral)
- mono headline ("mobile conversion · -18% · tuesday")
- one-line summary
- meta row (timestamp, agent badge, scope tags)
- subtle "investigate →" affordance on hover

### surface 2: investigation view (`/investigate/[id]`)

deep-dive. three-column layout on desktop, stacked on mobile.

```
left column: reasoning trace
  - timeline of agent steps
  - each step is a card: agent badge + content + (if tool call) collapsible result

center column: diagnosis
  - the conclusion in plain language
  - evidence list
  - hypotheses considered (collapsible)

right column: recommendations
  - 2-3 recommendation cards
  - each shows: title, rationale, bloomreach feature tag, steps, impact estimate
```

reasoning trace streams in via sse on initial load. ui updates as steps arrive.

### surface 3: query box (global)

fixed at bottom of every page. type a question, hit enter, response streams in below it. on the feed page, the response appears as a new "insight" pinned at the top. on the investigation page, it spawns a side panel.

---

## sse contract

agent endpoints stream events as ndjson-style messages. message shape:

```ts
type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; durationMs: number; result?: unknown }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

client uses `EventSource` to consume. ui updates progressively.

---

## phased implementation

### phase 1: foundation (highest priority)

goal: prove the mcp connection end-to-end with one real tool call rendered in the ui.

tasks:
1. scaffold next.js 15 app with app router, tailwind, ts
2. install `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`
3. implement `lib/mcp/auth.ts` oauth flow (reference bloomreach ts sample)
4. implement `lib/mcp/client.ts` with `callTool`
5. build a debug page at `/debug` that lets you click buttons to call individual mcp tools and see raw results
6. run `whoami`, `list_projects`, `get_project_overview`, `list_dashboards` — confirm responses

**acceptance**: from a deployed vercel preview, you can authenticate with bloomreach and see a json response from at least 4 mcp tools on the debug page.

### phase 2: monitoring agent + feed

goal: real insights generated from real data, rendered as cards.

tasks:
1. implement `lib/mcp/schema.ts` bootstrap; cache result in memory
2. write `prompts/monitoring.md` system prompt
3. implement `lib/agents/monitoring.ts` — claude tool-use loop calling the monitoring tool subset
4. build `/api/briefing` route — invokes monitoring agent, returns insight array
5. build feed ui (`app/page.tsx`) with `InsightCard` component
6. apply design tokens

**acceptance**: opening the deployed app shows 3–5 real insights generated from `wobbly-ukulele` data.

### phase 3: diagnostic agent + investigation view

goal: clicking an insight shows agent reasoning in real time.

tasks:
1. write `prompts/diagnostic.md`
2. implement `lib/agents/diagnostic.ts` — accepts an anomaly, returns a diagnosis
3. build `/api/agent` sse endpoint
4. build `/investigate/[id]/page.tsx` with reasoning trace ui
5. wire sse client in the investigation page
6. show tool calls as collapsible blocks with agent badge

**acceptance**: clicking any insight card opens an investigation view where the diagnostic agent's reasoning streams in step by step, including visible mcp tool calls and their results.

### phase 4: recommendation agent

goal: each investigation ends with 2-3 actionable recommendations.

tasks:
1. write `prompts/recommendation.md`
2. implement `lib/agents/recommendation.ts`
3. update `/api/agent` to invoke recommendation agent after diagnosis completes
4. build `RecommendationCard` component
5. add to investigation view (right column on desktop)

**acceptance**: every investigation view shows 2–3 recommendations with bloomreach feature tags and impact estimates.

### phase 5: query box

goal: free-form natural language queries route through the coordinator.

tasks:
1. implement `lib/agents/coordinator.ts` query routing
2. build `QueryBox` component (fixed bottom)
3. wire sse client for query responses
4. on feed page: pinned result card at top
5. on investigation page: side panel

**acceptance**: typing "show me which products lost engagement among returning customers last week" returns a coherent answer with reasoning trace.

### phase 6: polish (if time)

- briefing cron / autorefresh
- shareable investigation urls
- export reasoning trace as markdown
- one-click "apply" for recommendations (via transactional email rest api)
- loading skeletons, empty states, error states
- demo mode toggle (synthetic anomalies for offline demo)

---

## demo script

the hackathon requires a **5–6 minute** demo video uploaded to the submission portal. structured to the kit's recommended flow.

### required structure (kit spec)

| section | time | what to cover |
|---|---|---|
| executive context | 30s | problem, target user, why it matters |
| solution overview | 60s | what we built |
| architecture walkthrough | 60s | ui, agent runtime, mcps, data flow |
| core demo | 90–120s | the agent in action |
| mcp & tool usage | 45s | which mcps used, how deeply |
| agent reasoning | 45s | how the agent understands, decides, recommends |

total: ~5:30. record at 6 min ceiling; aim for 5:30 finished.

### detailed beats

**0:00–0:30 — executive context**
> "i'm rein, and this is blooming insights, built for track 3. it's an agentic workflow for marketing operations and merchandising teams. today, when a metric moves in their bloomreach workspace — conversion drops, a product starts declining, a segment behaves unexpectedly — they spend hours manually correlating signals across dashboards before they can even form a hypothesis. blooming insights collapses that work into seconds, with the agent's reasoning fully transparent."

**0:30–1:30 — solution overview**
> walk through the homepage. "the morning briefing surfaces what changed in the last 24 hours, ranked by significance. each card represents an anomaly the monitoring agent flagged."
>
> click an insight: "click any card and you enter the investigation view. you can watch the diagnostic agent work through its reasoning step by step. notice it's not just retrieving — it's generating hypotheses, testing each one against real workspace data, and reaching a conclusion with evidence."

**1:30–2:30 — architecture walkthrough**
> show the architecture diagram (one slide overlay or briefly switch to a diagram). "four agents: a coordinator orchestrates three specialists. monitoring detects change. diagnostic investigates causes. recommendation proposes actions. all four communicate via a shared mcp client layer that authenticates against loomi connect and calls tools across the marketing and analytics surfaces. the ui is next.js on vercel. agents stream their reasoning to the ui via server-sent events, so you see the work as it happens."

**2:30–4:30 — core demo (live workflow)**
> demonstrate end-to-end on a real insight. show:
> - the morning briefing loading with real data
> - clicking the top anomaly
> - the diagnostic agent's reasoning trace streaming in: hypothesis cards, mcp tool calls expanding to show real responses, evidence accumulating
> - the diagnosis appearing with the supporting evidence
> - 2–3 recommendations appearing on the right, each tagged with a bloomreach feature (scenario, segment, campaign, voucher)
> - typing a follow-up question in the query box: "which customer segments were most affected?"
> - the response streaming in with a new reasoning trace

**4:30–5:15 — mcp & tool usage**
> "we used the marketing and analytics mcp surfaces. across the three agents, we make calls to 25+ distinct tools — `execute_analytics_eql` for custom investigative queries, `get_funnel` and `get_event_segmentation` for behavior analysis, `get_customer_prediction_score` for churn signals, `list_scenarios` and `list_segmentations` to ground recommendations in real bloomreach capabilities. the depth matters: the diagnostic agent doesn't just call a tool — it strategically picks which tool to call next based on which hypothesis it's testing."

**5:15–6:00 — agent reasoning & what's next**
> "the differentiator is reasoning transparency. every other analyst tool shows you answers. blooming insights shows you why. you can see which hypotheses the agent considered, which it ruled out, which mcp calls produced the evidence. for a marketing operations user, this is the difference between trusting a recommendation and not."
>
> close: "for production, we'd add a write-path via the transactional email rest api so the human review step can flow into a simulated send, multi-workspace support, and an evaluation harness for agent quality. thanks."

### demo recording checklist

- [ ] dedicated chrome profile, no extensions
- [ ] dark mode os + dark mode app
- [ ] full-screen browser, hide menu bar and dock
- [ ] 1080p display setting (not native retina)
- [ ] system notifications silenced (do not disturb mode)
- [ ] all other apps closed
- [ ] mic test, audio levels checked
- [ ] script rehearsed at least 5x with a timer
- [ ] backup video recorded in case live demo fails
- [ ] uploaded to portal ≥24h before deadline
- [ ] link tested in incognito for accessibility

### anticipated judge questions

prep one-sentence answers:

1. *"what if mcp goes down during the demo?"* → "we built a cached mode behind a query param. for the live demo, real data; for resilience, cached responses replay the same flow."
2. *"how is this different from conjura, graas, or owly?"* → "transparent reasoning + mcp-native to bloomreach. they produce black-box outputs; we show the agent's work step by step."
3. *"what's simulated vs real?"* → "all data and reasoning are real, queried live from `wobbly-ukulele`. nothing is executed automatically — every recommendation is a human-review step. an 'apply' button is roadmap, not built."
4. *"what would you build next?"* → "write-path actions via the rest api, multi-workspace support, evaluation harness for agent quality, and a feedback loop where users mark recommendations as helpful or not so the agent improves."

---

## demo delivery

separate from the build itself, the demo presentation needs its own plan. how you present matters as much as what you built.

### browser setup
- dedicated chrome profile with no extensions (no ad blocker popups, no autofill chaos)
- bookmarks bar hidden, dock hidden, menu bar hidden
- browser zoom at 110–125% so judges sitting at the back can read
- pre-load the app in a tab; don't refresh during the demo unless intentional

### screen setup
- mac: system settings → displays → set to 1080p before demo (retina fits too much; text looks tiny on projector)
- dark mode app + dark mode os → seamless visual
- close slack, email, ide — anything that can notify mid-demo
- full-screen the browser

### demo data strategy
build both real and cached paths:

1. **real workspace data** — default. agents query `wobbly-ukulele` live via mcp. authentic, but brittle if data shifts or mcp has issues during pitch.
2. **cached responses** — for the exact queries in the demo script, cache tool responses and replay them. add a `?demo=cached` query param that forces cached mode.

build the cached path early — moved into phase 2, not phase 6. if anything goes wrong live, flip the flag and keep going.

### network plan
- bring a phone hotspot as backup; venue wifi fails at the worst moment
- pre-flight test: run the full demo on venue wifi 30 min before, not 2 min before
- if cached mode works, do a full dry run with wifi off to prove it

### polish touches that punch above their weight

- **skeleton loaders** while agents work (tailwind `animate-pulse` + bg color, ~10 lines)
- **typing animation on streamed text** — render character-by-character with 10-15ms delay; feels more alive than text dumps appearing (~20 lines)
- **status indicator in corner** showing "monitoring → diagnostic → recommendation" — makes the multi-agent architecture visible without explaining it
- **subtle motion** — insight cards fade up as they arrive (`motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-500`); one transition per element max

---

## required submission deliverables

per the hackathon kit, every team must submit a complete package before **jun 2, 2026, 4:00 pm pst**. all six items required.

### 1. project summary (≤500 words)

plain-language summary for non-technical judges. covers:
- the problem
- the solution
- the target user
- the value (time saved, decisions enabled)

**draft (target length ~400 words):**

> blooming insights is an agentic workflow that helps marketing operations and merchandising teams answer the question every ecommerce dashboard fails to answer: *"what just changed, why, and what should i do about it?"*
>
> today, when a metric moves in bloomreach — conversion drops, a product starts declining, a segment behaves unexpectedly — the team has to manually correlate data across funnel reports, customer events, campaign performance, and catalog state. it takes hours. most decisions end up driven by gut because the investigative work is too slow. existing analyst tools surface insights but hide their reasoning, so users can't trust them or learn from them.
>
> blooming insights coordinates three specialist ai agents through loomi connect's marketing and analytics mcp surfaces. a monitoring agent continuously watches workspace metrics and detects significant changes. when something moves, a diagnostic agent investigates — it generates competing hypotheses, queries data to test each, and concludes with evidence. a recommendation agent then proposes 2–3 concrete actions, each grounded in a real bloomreach feature (a scenario, a segment, a campaign, a voucher pool). a coordinator orchestrates the three and handles natural-language follow-up questions.
>
> what makes it different: the reasoning is fully transparent. users see which hypotheses the agent considered, which it ruled out, which mcp tools produced each piece of evidence, and how confident the agent is in its conclusion. it's the difference between "this is the answer, trust us" and "this is the answer, here's why."
>
> the product is built natively on loomi connect mcp — not a wrapper around a generic llm. each agent uses 8–15 mcp tools, with strategic selection based on the hypothesis being tested. the deeper the integration, the more capable the workflow.
>
> the target user is a merchandising lead, marketing operations manager, or small/mid-market store operator who owns performance outcomes but doesn't have a dedicated data analyst. for this user, the value is concrete: hours of investigation become 30 seconds of agent reasoning. decisions move from gut to evidence. the work that previously required a dashboards-fluent analyst becomes accessible to anyone who can ask a question.
>
> all recommendations are suggestions, not actions. nothing executes automatically. the workflow follows the loomi connect pattern: agent understands → agent recommends → human reviews → action prepared.

### 2. demo video (5–6 minutes)

structure and script in the demo script section above. upload to the submission portal ≥24h before deadline. test the link in incognito mode.

### 3. architecture overview

required diagram + written explanation. must show:
- ui layer (next.js on vercel)
- agent runtime (coordinator + 3 specialists)
- loomi connect mcp surfaces used (marketing + analytics)
- data flow (sse streaming from agents to ui)
- output artifacts (insights, diagnoses, recommendations)
- human review point

deliverable: a single image (draw.io / lucidchart / figma export) + 1-paragraph caption explaining flow. the tier diagram already in this spec is the source.

### 4. team details

- team name
- all member names + roles + slack handles
- one team lead identified

### 5. mcp usage explanation

required artifact explaining:
- which mcp surfaces were used (marketing + analytics)
- which specific tools (list 15–25 most-used)
- how deeply (per agent, what each agent does with the tools)
- why each tool was chosen (strategic selection, not exhaustive enumeration)

example wording to include: *"the diagnostic agent doesn't enumerate all available tools. it picks tools based on which hypothesis it's testing. for a 'mobile checkout abandonment' hypothesis, it calls `get_funnel` scoped to mobile, then `list_customer_events` filtered to abandoned-cart events, then `list_in_app_messages` to check for recent campaign interference. each call is reasoned, not retrieved by default."*

### 6. responsible design note

required artifact covering:
- **data handling**: live sandbox data, no production data, no pii
- **approval flow**: agent recommends → user reviews → no autonomous execution
- **simulated vs executed**: every recommendation is a suggestion; nothing is sent or applied
- **limitations**: read-only mcp scope; recommendation accuracy depends on workspace data quality; single-workspace scope for hackathon
- **safety considerations**: credentials stored server-side only, never client-exposed; oauth flow respects bloomreach iam permissions; rate-limiting in mcp client prevents accidental abuse
- **what would change for production**: write-path via rest api with explicit human-in-the-loop confirmation step; multi-workspace authentication; evaluation harness for agent output quality; logging and audit trail of all agent decisions

### deliverable checklist

- [ ] project summary (≤500 words, plain language)
- [ ] demo video (5–6 min, uploaded ≥24h early, link tested in incognito)
- [ ] architecture diagram + written explanation
- [ ] team details with one lead identified
- [ ] mcp usage explanation
- [ ] responsible design note
- [ ] code repo link with readme (if applicable)
- [ ] confirmation received from submission portal

---

## risks and mitigations

| risk | mitigation |
|---|---|
| mcp auth flow has gotchas in browser | start with the official bloomreach ts sample; do this in phase 1 |
| rate limits hit during demo | aggressive caching in mcp client; 60s ttl on tool responses |
| agent tool calls take too long | parallel calls in coordinator briefing mode; stream as results arrive |
| wobbly-ukulele has thin data | build a "demo mode" toggle with synthetic anomalies pre-seeded as fallback |
| agent hallucinates tool results | strict json schemas + validate every tool call result before passing forward |
| sse breaks in production | vercel route handlers support sse natively; test in preview deploy early in phase 1 |

---

## what to do first

1. clone the official bloomreach ts mcp sample, run it, see a successful tool call locally
2. set up the next.js project with the file structure above
3. port the auth flow into `lib/mcp/auth.ts`
4. build `/debug` page and confirm you can call mcp tools from the deployed app
5. only then start on phase 2

do not write agent code before the mcp client layer is solid. every hour of debugging at the agent layer is twice as expensive as the same debug at the client layer because the agent loop sits on top of the client.
