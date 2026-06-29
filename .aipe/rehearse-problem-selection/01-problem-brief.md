# 01 — Problem Brief

> Who experiences what pain, with what evidence, and why now.

```
  THE ANALYST'S CURRENT LOOP — what's being automated

  ┌─ context 1: dashboards ─────────┐
  │  marketer notices a metric      │  "huh, revenue dropped"
  │  moved in Bloomreach Engagement │
  └─────────────┬───────────────────┘
                │  switch context, lose state
  ┌─ context 2: query / pivot ──────▼───────────────┐
  │  hunt for the cause — by country? device?       │  "is this everywhere
  │  segment? time window? regression?              │   or just Brazil?"
  └─────────────┬───────────────────────────────────┘
                │  switch context again
  ┌─ context 3: Bloomreach features ▼───────────────┐
  │  decide: scenario? segment? campaign? voucher?  │  "okay, what do I
  │  with what configuration?                       │   actually DO about it?"
  └─────────────────────────────────────────────────┘

  three contexts · three tools · no continuity · all by hand
```

## The user

**The marketer/analyst working inside a Bloomreach Engagement workspace.** Not a data scientist. Not an ML engineer. Someone whose job is to keep ecommerce metrics moving the right direction and who has to **explain to a stakeholder why they're recommending the action they're recommending.**

The user has to be able to tell their boss: "Brazil purchase revenue is down 38% over the last 90 days vs prior 90; it's localized to Brazil (other regions are flat); I want to launch a re-engagement campaign for Brazil customers who churned in the last 60 days." With **the numbers**, **the segment**, and **the feature** all named, with provenance.

## The pain (the three-context loop)

The diagram above is the workflow. Three things hurt about it:

1. **Context-switching cost.** Each tool has its own mental model, its own filters, its own segment definitions. The analyst loses state every time they switch.
2. **No memory between steps.** What got hypothesized in step 2 has to be re-stated by hand in step 3. The hypothesis that produced the recommendation doesn't travel with it.
3. **No provenance at the end.** When the analyst presents the recommendation, the chain of reasoning ("I queried X, saw Y, ruled out Z, therefore W") is locked in their head. The stakeholder either trusts the analyst or they don't.

The third one is the load-bearing pain. **A recommendation without a visible chain of reasoning is a recommendation the stakeholder can't pressure-test.** That's the part the product has to fix — and the part the repo treats as a first-class surface, not a debug log.

## The evidence (what the repo proves)

The workflow above isn't inferred — it's encoded in the repo's structure. Three pieces of evidence:

### Evidence 1 — the three-stage stepper IS the analyst loop

The shared `ProcessStepper` component (`components/shared/ProcessStepper.tsx`, used on every page) has three steps: **monitoring anomalies → investigating the issue → decision & recommendation**. That's not a UX choice. That's the workflow being modeled. The split into **diagnose** and **recommend** as separate routes (`app/investigate/[id]/page.tsx` for diagnose, `app/investigate/[id]/recommend/page.tsx` for recommend, with `step=diagnose|recommend|null` on the `/api/agent` route) reflects the analyst's actual reasoning sequence: first form the hypothesis, then decide the action.

**Inference:** the analyst persona thinks in these three steps. (The repo encodes the steps; whether real Bloomreach analysts experience them as three steps is the discovery question — see below.)

### Evidence 2 — EQL ad-hoc-only proves "no saved dashboards" is real

`execute_analytics_eql` is the only metrics tool the agents call. There are no saved Bloomreach dashboards / funnels in this workspace to read from — every metric is computed ad-hoc. This proves the **monitoring step is currently un-automated** for any user of that workspace: there's nothing to glance at; you have to ask. That's the gap the monitoring agent (`lib/agents/monitoring.ts`) plugs.

The 90-day window enforcement (current 90d vs prior 90d, derived from 90d & 180d) is in the code because the dataset's sparse tail produces bogus ±100% swings on shorter windows. That's a constraint the repo discovered by running the loop against real data — not a guess.

### Evidence 3 — the reasoning trace is built as a product surface

The `StatusLog` (`components/shared/StatusLog.tsx`) is a sticky sidebar on every page (feed + both investigate steps). It wraps `ReasoningTrace` (`components/investigation/ReasoningTrace.tsx`) which renders per-line **agent badge + step kind + content + timestamp**, with `ToolCallBlock`s showing status dot + tool name + duration + expandable JSON result. This is not a log file. It's not a debug panel hidden behind a dev flag. It's **a 1/3-width column of the main UI** alongside the 2/3-width insight column.

The NDJSON streaming contract (`AgentEvent` in `lib/mcp/events.ts`: `reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error`) carries the trace events as **first-class messages**, not as a side-channel. The route producers + UI consumers both depend on this — it's locked as "what must not change" in the project context.

**This is the strongest evidence:** when the product team commits to "the reasoning trace is part of the contract, not the debug output," that's a deliberate stance on **what kind of analytics product this is.** The bet is on trust, not magic.

## Why now

Three things that make this the right moment, in order of how repo-visible they are:

1. **The MCP layer exists.** Bloomreach shipped the loomi connect MCP server in alpha. Before MCP, an integration like this would have meant a custom API client per feature surface (events, segments, scenarios, campaigns). The MCP surface flattens that into a tool-call interface the agent can drive — `lib/mcp/tools.ts` lists the tools the agent gets for free. **The integration cost just collapsed.**
2. **The model is good enough.** `claude-sonnet-4-6` is the agent model; `claude-haiku-4-5-20251001` is the intent classifier. Eighteen months ago, sustaining a multi-turn diagnosis (form hypothesis → test against data → refine) was a research project. Today it's a working loop in `lib/agents/diagnostic.ts` — built on `@aptkit/core@0.3.0` after migrating from a hand-rolled `runAgentLoop` (legacy preserved at `lib/agents/base-legacy.ts` as a rollback receipt). The capability isn't the differentiator anymore; the **trust surface** is.
3. **The streaming UI primitive landed.** NDJSON over `ReadableStream` (consumed in the browser via `fetch` + a stream reader, not `EventSource` — see `lib/mcp/events.ts`) is what makes the "show your work" surface possible at human-perceptible latency. Without first-class streaming, the trace would arrive as a wall of text after the conclusion — defeating the entire point.

## Beneficiaries and exclusions

**Who benefits:** the marketer/analyst inside a Bloomreach Engagement workspace whose job involves the three-context loop above and who has to **explain their recommendations to a stakeholder.**

**Who is intentionally excluded — and what their problem is:**

- **Data engineers / analytics engineers.** They have SQL, dbt, notebooks, and BI tools that already chain query-and-explain. They don't need this product; they need pipelines.
- **Multi-workspace customer success / agency teams.** No multi-tenant isolation in the repo — one workspace per session. (See `lib/mcp/auth.ts` — the OAuth client is per-user.) Serving them would mean re-architecting auth, state, and rate limits.
- **Non-Bloomreach users.** The MCP server is the seam, and it's Bloomreach-specific. Generalizing the agents to "any ecommerce analytics platform" is a different product. (The agent layer is somewhat portable — see `lib/agents/aptkit-adapters.ts` for the boundary — but the tool inventory in `lib/agents/tool-schemas.ts` is Bloomreach-shaped.)
- **Read-only stakeholders who consume the analyst's output.** The product is the analyst's tool, not the stakeholder's report. Export-to-markdown exists (`lib/export/investigationMarkdown.ts`) as the bridge.

## Constraints (visible from the repo)

The constraints are not aspirational — they're enforced in code:

- **Bloomreach alpha MCP server rate limit.** ~1 req/s in `lib/mcp/client.ts`, with retry. **Any feature that needs sub-second multi-call interactivity is off the table** until the server matures.
- **Token revocation after minutes.** The alpha server revokes tokens; the feed has auto-reconnect on `invalid_token` (`app/page.tsx`). **Long-running background monitoring is off the table** until token lifetimes are stable.
- **No database.** State lives in in-memory maps; dev persistence is gitignored JSON. **Cross-session memory, save/share, and team workspaces are off the table** without picking a storage substrate first.
- **No write-back to Bloomreach.** The agents read via MCP; they don't push scenarios/segments/campaigns back. **One-click execution is off the table** — the recommendation is the artifact the analyst takes to Bloomreach themselves.
- **Demo path is the reliable presentation path.** `?demo=cached` serves a committed snapshot (`lib/state/demo-*.json`) — **because live is rate-limited and token-revoked, the demo is the surface that gets shown.** This is a constraint on how the product is demonstrated, not a future limitation.

## The discovery questions (what the repo cannot establish)

Honesty requirement — these are real gaps:

- **How many Bloomreach analysts experience the three-context loop as painful enough to want a tool?** The workflow is encoded in the repo; the **prevalence** of the pain is not. Discovery move: 5 conversations with marketers on Bloomreach Engagement before scaling the agent count.
- **Does "show your work" actually beat "magic answer" for this persona?** The bet is yes — but the repo cannot prove a preference. Discovery move: A/B the same recommendation with and without the trace visible, see which one the analyst forwards to their stakeholder.
- **Is the 90-day window the right window for the analyst persona, or just for this dataset's sparse tail?** The window is currently enforced for technical reasons (bogus swings on shorter windows). Whether a marketer would want 30 / 60 / 90 / 180 as a user-controllable knob is unknown.

A brief that pretends the repo answers these is a brief that loses credibility. Naming them is the move.

## The sharp answer

If the reviewer asks "in one sentence, what's the problem you're solving" — **"A marketer on Bloomreach Engagement currently runs a three-tool, three-context loop by hand to go from 'something moved' to 'here's what I'm doing about it' — and at the end of it, they have a recommendation but no visible reasoning to defend it. We collapse the three steps into one continuous loop and make the reasoning itself the product surface."**

The defensible move is showing the repo encodes that exact loop already — the stepper, the dual-agent split, the streaming trace as 1/3 of the main UI. The product is not a hypothesis; it's a built thing being defended.
