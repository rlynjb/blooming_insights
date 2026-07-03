# The problem brief

**The one file the review room reads first.** Who hurts, how much, what evidence, why now, who's inside scope, who's outside, what constraints hold.

## The user — one person, one workflow

The person you're building for: **a marketer or analyst working inside a Bloomreach Engagement ecommerce workspace**. Not a data scientist. Not a BI engineer. Someone whose job title says "growth" or "lifecycle marketer" and whose day includes a Bloomreach tab.

The specific workflow they run manually today — the one this product replaces:

```
  The human-analyst loop, done by hand today

  ┌─ 1. NOTICE ─────────────────────┐
  │  scroll dashboards, spot        │
  │  something moving               │
  │  "purchase revenue looks off"   │
  └──────────────┬──────────────────┘
                 │  hours to days later
                 ▼
  ┌─ 2. DIAGNOSE ───────────────────┐
  │  open the query tool,           │
  │  write EQL, run comparisons,    │
  │  form hypotheses, test them     │
  │  "is it traffic? checkout?      │
  │   a country? a segment?"        │
  └──────────────┬──────────────────┘
                 │  usually another session
                 ▼
  ┌─ 3. DECIDE ─────────────────────┐
  │  which Bloomreach feature to    │
  │  reach for — scenario? segment? │
  │  campaign? voucher? experiment? │
  │  what steps? what impact?       │
  └─────────────────────────────────┘
```

Three stages. Notice → why → what to do. That's the loop. The pain isn't that any *one* stage is hard — it's that (a) it takes a human hours to walk it end to end and (b) most people stop at stage 1 or 2 because stage 3 requires product knowledge across all five Bloomreach action surfaces (scenarios, segments, campaigns, vouchers, experiments).

## The pain, made concrete

Look at what the marketer actually types in a normal day. It's not one query — it's a *sequence* of queries where each one is chosen based on what the previous one showed.

- **Stage 1** (notice): "how did revenue trend the last 90 days?" → sees a dip → "is it global or a country?" → "which country?" → segment by `customer.country`.
- **Stage 2** (diagnose): "did traffic drop?" → `session_start` counts over the window → "did checkout conversion drop?" → funnel counts view → cart → checkout → purchase → "did the drop hit new customers or repeat?" → segment split.
- **Stage 3** (decide): matching the diagnosed cause to a Bloomreach feature. Checkout drop-off on repeat customers = a scenario. Country-scoped traffic drop = a campaign. New-vs-repeat difference = a segment definition.

Every one of those queries is EQL, ad-hoc, against a workspace with **no saved dashboards or pre-built funnels**. The marketer has to write them (or ask an analyst to). The workspace `wobbly-ukulele` — the actual one this product ships against — has zero pre-built reports. Every number is computed on demand.

## The evidence — what the repo proves

This is the part where you distinguish evidence from inference. The repo proves several load-bearing claims about the problem:

- **The workspace has no saved reports.** `lib/mcp/tools.ts` exposes the Bloomreach MCP tools, and `lib/mcp/schema.ts` walks the workspace on connect — the `WorkspaceSchema` has `events[]`, `customerProperties[]`, `catalogs[]`, but **no** `reports[]` or `funnels[]`. Every metric is ad-hoc EQL through `execute_analytics_eql`. That's not a design choice on this side — it's what the workspace actually is.
- **The workflow is genuinely a sequence, not a lookup.** `lib/agents/base.ts` — the `runAgentLoop` — runs a Claude tool-use loop where the model decides which tool to call *next* based on the previous result. If the answer were a single lookup, you wouldn't need a loop. The loop's existence is a claim about the problem shape, and the agent trace files under `lib/state/demo-*.json` show 6–12 tool calls per diagnosis in practice. This isn't the tool making noise — it's the diagnostic path having that many steps.
- **The three-stage separation is real.** The UI reflects it directly: `app/page.tsx` (feed = monitoring), `app/investigate/[id]/page.tsx` (step 2 = diagnostic only), `app/investigate/[id]/recommend/page.tsx` (step 3 = recommendation only). The stepper (`components/shared/ProcessStepper.tsx`) links them. This isn't a marketing decomposition — it's how the code is structured because the *task* is structured that way.
- **The reasoning has to show itself.** `StatusLog` (`components/shared/StatusLog.tsx`) wrapping `ReasoningTrace` (`components/investigation/ReasoningTrace.tsx`) is the differentiator's shipped form. Every agent step and every tool call streams to the sidebar in real time, with duration and expandable results. If the analyst can't see *how* the AI reached its conclusion, they can't trust it enough to act on it. The repo shipping this as a first-class UI surface — not a debug panel — is the evidence the "shows its work" pitch is load-bearing.

**What's inference, not evidence:** the claim that the target user's baseline is manual (they don't have another AI analyst on Bloomreach). The repo can't prove that — it's a market observation about Bloomreach's current state. Flagging it because the review room will.

## Why now — what changed, what compounds

Two things converged that make this problem tractable *now* in a way it wasn't 18 months ago.

- **Bloomreach shipped an MCP server.** `loomi-mcp-alpha.bloomreach.com/mcp` (see `lib/mcp/connect.ts`). Before this existed, an AI agent talking to Bloomreach meant scraping the UI or reverse-engineering an internal API. The MCP server is the *supply-side* enablement — it makes the "AI reads Bloomreach data" step technically possible without vendor cooperation on custom integrations.
- **Sonnet 4.6 is good enough at multi-turn tool use to run this loop.** `lib/agents/base.ts` uses `claude-sonnet-4-6` inside the agent loop; the diagnostic agent typically runs 6–12 tool calls per case. A model that stalls or loops after 3–4 tool calls can't do this workflow. Sonnet 4.6 can. That's the *demand-side* enablement.

Cost that compounds if the problem isn't solved: **every workspace where the marketer stops at stage 1 or stage 2**. The manual loop is skippable — you can look at a chart, decide it's fine, and move on. The action-taking stage (which Bloomreach feature to reach for) is exactly where the value lives, and it's the stage most likely to get abandoned. The longer the workspace sits without an analyst-loop closer, the more revenue-relevant anomalies go undiagnosed.

## Who's inside scope, who's outside

**Inside scope:**
- A single Bloomreach ecommerce workspace (`wobbly-ukulele` is the reference).
- The three-stage loop as it applies to *ecommerce metrics* — revenue, funnel, traffic, customer segments by country. Data model in `lib/mcp/types.ts` (`Anomaly`, `Diagnosis`, `Recommendation`).
- Bloomreach action recommendations across all five feature surfaces: scenario, segment, campaign, voucher, experiment. See `lib/agents/prompts/recommendation.md`.
- One user at a time, session-keyed. See the in-memory Map for insights in `lib/state/insights.ts` and investigations in `lib/state/investigations.ts`.

**Outside scope — deliberately:**
- **Not a multi-tenant SaaS.** No user accounts, no team collaboration, no shared workspaces. The product runs against one Bloomreach OAuth connection at a time. This is Ch 02 material — the DB cut lives there.
- **Not a Bloomreach replacement.** The product runs *inside* the marketer's Bloomreach workflow, reading the same data they'd read in Bloomreach's UI. It's a loop on top, not a rebuild underneath.
- **Not other Bloomreach modules.** Content, discovery, recommendations-as-a-service — none of those. This is Engagement (the event/customer/campaign product) only.
- **Not other analytics platforms.** No Segment adapter, no Amplitude adapter, no GA. The `DataSource` seam (`lib/mcp/tools.ts` + Synthetic adapter) exists partly so this *could* extend, but shipping-scope is Bloomreach.

## Constraints — what actually pins the shape

The constraints that show up in the code, not the ones on the whiteboard:

- **The MCP server rate-limits at ~1 req/s and revokes tokens after minutes.** `lib/mcp/client.ts` has the retry + rate-limit logic; `app/page.tsx` has the auto-reconnect-once-on-`invalid_token` guard. This is why demo mode exists at all — a live demo against the alpha server is not reliable for a 15-min presentation window. The presentation reliability constraint pinned the demo/live toggle in `app/page.tsx` (persisted in `localStorage` `bi:mode`).
- **The workspace has no pre-built reports.** Everything through `execute_analytics_eql`. The agent has to *decide* which EQL to run. This is why an LLM-in-the-loop makes sense at all — if there were a `getRevenueDashboard()` API, this would be a scripted ETL, not an agent.
- **Vercel Pro function timeout: 300s.** `maxDuration = 300` on `/api/briefing` and `/api/agent`. That's the streaming envelope. Anything requiring longer than 5 minutes of continuous streaming has to be redesigned (which is why the recommend step runs as a separate request after diagnose).
- **Presentation-first delivery.** The primary consumers of this product right now are you (for interview loops) and interviewers (for evaluating you). "Reliable demo path" is a first-class requirement, not a nice-to-have. It pinned the committed `lib/state/demo-*.json` snapshots and the demo/live toggle.

## What kind of problem this is

Name it directly for the interviewer's mental model: this is an **AI product problem, not an AI research problem**. You're not proving a novel technique. You're taking a well-understood pattern — LLM + tool use + streaming — and applying it to a workflow that currently doesn't have an AI-native version, in a way that respects the reality of the underlying data platform (Bloomreach MCP alpha), the model (Claude Sonnet 4.6), and the interface (web browser, streamed sidebar).

The interviewer bar for AI product work is *judgment*, not *invention*. This book is the receipts on judgment.
