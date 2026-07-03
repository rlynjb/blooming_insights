# Tool routing

## Subtitle

Tool selection / heuristic + LLM routing hybrid — Industry standard.

## Zoom out, then zoom in

Two routing layers pick tools in blooming: a **schema coverage gate** filters tools *before* the agent runs (pure code), and the **LLM inside the agent loop** picks among the remaining tools *per turn*. The gate is heuristic-before-LLM applied to tool availability; the per-turn pick is LLM-routed. Both are live.

```
  Zoom out — two routing stages

  ┌─ Config-time / boot-time ───────────────────────────┐
  │  runnableCategories(schema) — pure code             │
  │  → drops categories the workspace can't answer      │
  │  → filters the tool set the agent sees              │
  └───────────────────────┬──────────────────────────────┘
                          │  filtered tools
                          ▼
  ┌─ Per-turn LLM routing ★ ────────────────────────────┐ ← we are here
  │  model picks from the surviving tools each turn      │
  │  no explicit routing code — the model routes         │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the gate is deterministic; the per-turn pick is LLM. Together they form the tiered pattern — cheap route at the front, smart route at the back.

## Structure pass

- **Layers:** all tools → schema gate → agent-filtered subset → LLM pick per turn → executed tool. Five bands.
- **Axis: cost of the routing decision.** Gate: free (pure code). Per-turn: paid (part of the model turn's tokens).
- **Seam:** the boundary between the filter step and the agent. The filter is one function call; the agent is a long-running loop.

## How it works

### Move 1 — the mental model

```
  Two-stage routing — the shape

  ┌─ Stage 1: gate (pure code) ─────────────────────┐
  │  runnableCategories(schema)                      │
  │  drops tools whose required events are missing   │
  │  · deterministic                                 │
  │  · runs once per briefing                        │
  └────────────────────────┬────────────────────────┘
                           │
                           ▼
  ┌─ Stage 2: LLM (per-turn) ───────────────────────┐
  │  model sees remaining tool schemas, picks one    │
  │  · non-deterministic                             │
  │  · runs per model turn                           │
  └─────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The schema gate.** `lib/agents/categories.ts:26-27` — `runnableCategories(schema)` iterates the fixed set of ecommerce anomaly categories, checks each `requires: string[]` list against the schema's exposed event set, and returns only categories whose requirements are fully met.

Example — the "conversion drop" category might `require: ["view_item", "purchase"]`. If the workspace has both events, category is runnable. If either is missing, category is dropped and the monitoring agent never even sees it in the prompt. Zero wasted tool calls chasing something the substrate can't answer.

**Per-agent tool subsets.** `lib/agents/tool-schemas.ts:9` — `filterToolSchemas(all, allowed)` narrows the *full* MCP tool list down to the tools each agent's role justifies:

- Monitoring agent gets tools for running EQL queries, listing catalogs.
- Diagnostic agent gets everything monitoring gets plus `submit_diagnosis`.
- Recommendation agent gets `submit_recommendation` and enough analytics tools to size impact.

This filter reduces prompt size (fewer tool defs = fewer tokens in the fixed prefix) and reduces the LLM's search space per turn.

**LLM routing at the turn level.** Given the filtered tool set, aptkit's agent loop invokes the model with `tools: filteredSchemas` per turn. The model reads the schemas as part of its context and emits a `tool_use` block naming the chosen tool. No explicit routing code — the model does the routing purely by pattern-matching over descriptions + args.

Diagram of one briefing flowing through both routers:

```
  Briefing — two-stage routing

  workspace schema:
    events: [purchase, view_item, session_start,
             cart_update, checkout]     ← no payment_failure event

  ┌─ Stage 1: schema gate ─────────────────────────┐
  │  categories:                                    │
  │    conversion_drop      ← requires present     │
  │    payment_failure_rate ← requires MISSING     │
  │      → DROPPED                                  │
  │    session_drop         ← requires present     │
  │  → agent sees only: conversion_drop, session_drop│
  └──────────────────┬─────────────────────────────┘
                     │
                     ▼
  ┌─ Stage 2: LLM per-turn routing ────────────────┐
  │  turn 1: model picks execute_analytics_eql      │
  │          (only relevant tool; no ambiguity)     │
  │  turn 2: model picks execute_analytics_eql      │
  │          (different EQL args this time)         │
  │  ...                                             │
  │  turn N: model picks submit_anomalies            │
  └────────────────────────────────────────────────┘
```

**Where a rules-based per-turn routing would earn its place.** If the input surface (QueryBox) had strong lexical patterns — "@catalog fetch X" always means catalog lookup — a regex prefix router could beat LLM routing on cost and latency. Blooming's QueryBox is free-form English, so LLM routing wins.

### Move 3 — the principle

Route cheap-first. The pure-code filter drops what can't work; the LLM picks among what remains. If any subset of "what remains" is predictable by rules, add a rules layer for it. The general principle: LLM routing is for cases rules can't cover; use rules everywhere else.

## Primary diagram

```
  Tool routing in blooming — full frame

  ┌─ All MCP tools (~50 tools from Bloomreach server) ──────┐
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ filterToolSchemas(all, agentAllowlist) ────────────────┐
  │  lib/agents/tool-schemas.ts:9                           │
  │  → per-agent subset (~10-15 tools per agent)            │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ runnableCategories(schema)  (monitoring path only) ────┐
  │  lib/agents/categories.ts                                │
  │  → drops categories the workspace lacks events for       │
  └───────────────────────┬─────────────────────────────────┘
                          │
                          ▼
  ┌─ Agent loop: LLM routes per-turn ───────────────────────┐
  │  model reads schemas in prompt, emits tool_use per turn  │
  │  observed: 5-10 tool calls per investigation             │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

Tool routing conversations often present rules vs LLM as an either/or; production systems use both. The rules layer is where you catch predictable inputs; the LLM layer is where you handle ambiguity. Blooming's split is characteristic: pure-code coverage gate + tool filter (cheap, deterministic), then aptkit's LLM-driven pick (expensive per turn, but selection is embedded in the same call that would happen anyway).

The blooming gate has one extra property worth calling out: it prevents *silent budget burn*. Without it, the agent could pick a tool whose call fails (missing events), waste a rate-limited slot, and produce nothing. The gate stops that at boot.

Related: **01-agents-vs-chains.md** (routing is one of the things the agent kernel does), **../01-llm-foundations/07-heuristic-before-llm.md** (the same idea at the query level).

## Project exercises

### B4.4 · Add a per-tool cost budget to the routing decision

- **Exercise ID:** B4.4 (Case A — schema gate live; add cost dimension)
- **What to build:** Extend `runnableCategories()` to consider not just "does this category's tools work" but "given the remaining budget, is this category affordable." Route budget-heavy categories to the front so they run early, or drop them if the remaining budget can't fit them.
- **Why it earns its place:** Turns the coverage gate into a *cost*-aware gate. Directly ties routing to the budget-tracker infrastructure (`lib/agents/budget.ts`).
- **Files to touch:** `lib/agents/categories.ts` (extend with budget check), `lib/agents/budget.ts` (add per-category cost estimates), `test/agents/categories.test.ts`.
- **Done when:** for a workspace with a $0.05 remaining budget, budget-heavy categories get skipped or deferred; a receipt row records the gate decision.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: When does rule-based routing beat LLM routing?**

When the input surface has strong regularities. If 90% of QueryBox inputs are exact-form ("@catalog X" or "for last N days X"), a regex prefix router catches them at zero cost and zero latency. If the inputs are free-form English, the LLM router adapts to phrasing you couldn't enumerate. Blooming's inputs today are free-form; the classifier + coverage gate does the routing job.

**Q: The schema gate seems obvious. Isn't it just filtering?**

Sort of. What makes it interesting is *what* it filters — categories whose required events are missing. That's a live-schema-aware gate; the agent doesn't waste tokens trying tools that structurally cannot work. Without it, the agent would burn 3–5 rate-limited MCP calls discovering the same thing on every briefing.

## See also

- [../01-llm-foundations/07-heuristic-before-llm.md](../01-llm-foundations/07-heuristic-before-llm.md) — the parallel pattern at the query level.
- [02-tool-calling.md](02-tool-calling.md) — the tool_use / tool_result loop that runs after routing.
- [06-error-recovery.md](06-error-recovery.md) — what happens when routing to a tool that then fails.
