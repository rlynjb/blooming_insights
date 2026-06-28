# 01 — Problem brief

**Industry name:** Problem statement / opportunity brief — Coach posture

The 90-second answer to *"what is this for, and why does it deserve to exist?"* Coach voice: lead with the verdict, then rank what carries weight.

---

## Zoom out — where this problem lives

```
  Where the problem sits — the analyst's day

  ┌─ The marketer/analyst on Bloomreach Engagement ──────┐
  │  opens the workspace, eyeballs metrics, thinks:      │
  │   "huh, revenue is down in USA — why?"               │
  └─────────────────────────┬────────────────────────────┘
                            │  the loop they run manually
                            ▼
  ┌─ 1. NOTICE ──────────────────────────────────────────┐
  │  scan dashboards, spot a metric that moved           │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ 2. HUNT ────────────────────────────────────────────┐
  │  run ad-hoc EQL, slice by country/segment,           │
  │  form hypotheses, eliminate them one by one          │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ 3. DECIDE ──────────────────────────────────────────┐
  │  pick a Bloomreach action:                            │
  │  scenario / segment / campaign / voucher / experiment│
  └──────────────────────────────────────────────────────┘

  blooming insights = an agent that runs all three,
  AND streams its reasoning so the analyst sees HOW it
  reached each conclusion.
```

This whole loop sits *outside* Bloomreach today — in the analyst's head, in a Notion doc, in a Slack thread. The product moves it inside the workspace and makes the reasoning visible.

---

## The verdict — what this is for

**An AI analyst that runs the analyst's loop end-to-end, and shows its work as a first-class UI surface.**

Not "a chatbot for Bloomreach." Not "a dashboard." An agent that does the three-stage loop above — **monitoring → diagnosis → recommendation** — and streams the reasoning trace, tool calls, and current-vs-prior numbers so every conclusion is auditable.

The differentiator is not the loop itself. Plenty of agents run loops. The differentiator is **provenance** — you click into the trace and see the EQL query that produced the number, the prior 90-day baseline it compared against, and the hypothesis the diagnostic agent eliminated before landing on its conclusion.

---

## The user — who hurts

A marketer or growth analyst working in a Bloomreach Engagement ecommerce workspace. Concretely: someone whose week looks like this:

- Monday: check the dashboard, notice purchase revenue dipped in one country.
- Monday afternoon: run a few EQL queries to figure out *why* — was it traffic? funnel conversion? a specific catalog category?
- Tuesday: write up a finding, propose a campaign or segment change in Bloomreach.
- Wednesday: build the scenario or segment in the UI.

The pain isn't *any one step*. It's that the loop is **manual, slow, and unrecorded.** By Friday, no one can reconstruct the reasoning that led to the campaign — the EQL queries are gone, the hypotheses are in someone's head, the prior baseline was eyeballed.

**Specifically:**
- **Noticing** is slow because there are no saved dashboards in this workspace; every metric is ad-hoc EQL (the workspace fact, not a product limitation).
- **Hunting** is slow because forming and testing hypotheses requires writing more EQL, and analysts who write EQL daily are scarce.
- **Deciding** is slow because the analyst has to map "purchase revenue is down in USA" to "which of {scenario, segment, campaign, voucher, experiment} is the right Bloomreach feature" — and that mapping isn't documented anywhere.

---

## The evidence — what proves the pain

This is where you separate "I think this is useful" from "I built it because the workspace told me to."

**Evidence from the workspace itself** (the "wobbly-ukulele" Bloomreach project the agents run against):

- **No saved funnels or dashboards** — every metric the product computes is built ad-hoc from EQL (`execute_analytics_eql` via MCP). If the analyst wants to know revenue trend, someone has to write the query. The MCP server has no `get_dashboard` tool because there's nothing to get.
- **Sparse tail in the dataset** — the 90-day window discipline (`lib/agents/monitoring.ts`) exists because shorter windows produce bogus ±100% swings on this workspace's tail. That's a real constraint discovered by running the agent and seeing it return garbage.
- **The MCP server's rate limit** (~1 req/s, alpha) and **token revocation** (minutes) — `lib/mcp/client.ts` carries the rate-limit + retry logic because the first version of the agent loop hammered the server and got 429'd. Real operational pain, real engineering response.

**Evidence from the workflow inferred** (label honest — this is the inference, not measured):

- *Inference:* analysts at this level don't have time to write 6 EQL queries per investigation. *Cannot prove this from the repo alone* — would need user-research interviews to verify. Listed as a discovery question, not a fact.
- *Inference:* the "which Bloomreach feature is the right one" mapping is undocumented and tribal. *Partially proved* by the agent's recommendation prompt (`lib/agents/prompts/recommendation.md`) having to enumerate the five Bloomreach feature types and their use cases — if the mapping existed in docs, the prompt could cite them.

**Discovery questions still open** (the honest gaps):

- How many anomalies per week does a typical Bloomreach analyst actually investigate?
- What's the median time-to-recommendation today, end-to-end?
- Do analysts trust LLM-generated diagnoses, or do they rerun every query themselves?

A staff reviewer will respect these questions being named more than they'll respect fake numbers.

---

## Why now — what changed

```
  The three "why now" pressures

  ┌─ 1. MCP standardization (2024-2025) ─────────────────┐
  │  Bloomreach published a loomi connect MCP server     │
  │  → tools (queries, segments, customers) are now      │
  │     callable from any agent runtime                  │
  │  → the "how do I get the data" problem went from     │
  │     "build a custom integration" to "speak MCP"      │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ 2. Tool-use models matured (Claude Sonnet 4.6) ─────┐
  │  multi-turn tool use is reliable enough that the     │
  │  agent can plan→query→re-plan without the orchestra- │
  │  tor having to micromanage every step                │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ 3. Streaming-trace UX is normalized ────────────────┐
  │  users have seen ChatGPT/Claude thinking traces and  │
  │  expect to see the reasoning, not just the answer    │
  │  → "show your work" is a sellable feature, not a     │
  │     debugging UI                                      │
  └──────────────────────────────────────────────────────┘
```

The "why now" is not *"AI is hot."* It's that three specific things — MCP, reliable tool-use, and normalized streaming UX — all landed in a window where building this with three engineer-weeks is possible. Two years ago it would have been six months and a custom integration per data source. One year from now, every BI vendor has shipped their own version.

**Coach note:** when a reviewer asks "why now?" — DO NOT say "AI is the future." Say "MCP made the data callable, tool-use models got reliable, and streaming traces became a normal UI primitive — three things that weren't true 18 months ago."

---

## Beneficiaries and exclusions

**Who benefits:**
- The marketer/analyst working in Bloomreach Engagement on an ecommerce workspace — primary user.
- The growth team lead who reviews the analyst's recommendations — secondary, gets auditable receipts.
- The Bloomreach platform itself — every recommendation is a Bloomreach feature, so successful adoption deepens platform usage.

**Who is intentionally outside scope:**
- Non-Bloomreach workspaces. The agent is hardcoded to MCP tools the loomi connect server exposes. Porting to Segment / Amplitude / Snowflake would be a separate product, not a config.
- Non-ecommerce workspaces. Subscription / B2B / media workspaces have different metric shapes — the prompts and `WorkspaceSchema` (`lib/mcp/schema.ts`) assume ecommerce primitives (revenue, AOV, funnel: view → cart → checkout → purchase).
- Real-time alerting. The product is a 90-day-window analyst, not a 5-minute-window monitor. If something breaks in production *right now*, this isn't the tool.
- Engineers debugging the Bloomreach platform itself. The agent reads through the customer's lens, not the operator's.

The exclusions matter as much as the inclusions. Naming what this is NOT for tells the reviewer you've thought about the boundary.

---

## Constraints — what shapes the solution

These come from the repo and the workspace, not from imagination.

**Technical:**
- **Rate limit** — ~1 req/s on the alpha MCP server (`lib/mcp/client.ts`). Every agent design has to budget tool calls; the `maxToolCalls` cap was load-bearing in the hand-rolled loop and remains so under AptKit.
- **Token revocation** — the alpha server revokes OAuth tokens after minutes. Auto-reconnect on `invalid_token` is required (`app/page.tsx`), and "live" mode is recovery-oriented rather than presentation-reliable. Demo mode exists because of this.
- **No saved reports** — every metric is ad-hoc EQL, so the agent has to know how to compose queries, not just consume pre-built dashboards.
- **Vercel function ceiling** — `maxDuration = 300` on the agent routes. The agent loop has to finish in 5 minutes or stream a partial result.

**Product:**
- **Provenance is non-negotiable** — the differentiator IS the trace. Any design that hides the reasoning trace (e.g. "wait for the final answer, then render") loses the product. The NDJSON streaming contract (`lib/mcp/events.ts`) exists to keep the trace surface live.
- **Demo mode must work without auth** — the alpha server's token revocation makes live demos fragile, so the demo replays a committed snapshot. This isn't a hack; it's the presentation-reliable path.

**Time:**
- This is a portfolio/interview project, not a funded product. Scope every decision against "what can one engineer ship in N weeks and defend in a 45-minute conversation."

**Migration / organizational:**
- N/A — solo project, no migration constraints, no organizational politics. Naming this explicitly tells a reviewer you know what *would* matter at scale.

---

## The smallest useful scope — what validates the premise

The narrowest slice that proves "an analyst that shows its work is genuinely useful" is **one anomaly, end-to-end, with the trace visible.**

That means:
- The monitoring agent detects one significant change in the workspace.
- The diagnostic agent forms and tests at least one hypothesis against real EQL queries.
- The recommendation agent proposes one concrete Bloomreach action.
- The UI streams the reasoning trace, tool calls, and current-vs-prior numbers for all three stages.

If that loop works once, end-to-end, with the trace visible — the premise is validated. Everything else (multiple anomalies, ranking, free-form Q&A, demo mode, eval harness) is hardening on the kernel.

**The repo state today proves this slice works:** the demo snapshot in `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` is a captured live run of exactly this loop. Click "investigate" on a card, watch the trace stream, read the recommendation. That's the validated premise, shipped.

---

## The takeaway

The problem is real (analysts manually run this loop today, slowly, without records), the evidence is mixed-but-honest (workspace facts proven; user-workflow inferences labeled), the "why now" is specific (MCP + tool-use + streaming-trace UX in the same window), the boundary is named (ecommerce Bloomreach, not generic BI), and the validating slice is shipped.

The next chapter is the harder one — **what you did NOT build, and why.** That's where senior judgment shows up.

---

## See also

- `02-scope-cuts-and-non-goals.md` — what got cut and why
- `03-options-and-opportunity-cost.md` — what else you could have built
- `04-success-metrics-and-feedback-loop.md` — how you know any of this works
- `.aipe/project/context.md` — the project framing
