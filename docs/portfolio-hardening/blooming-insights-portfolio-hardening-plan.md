# blooming insights — portfolio hardening path

> **PHASES 2 + 3 RETIRED 2026-06-18.** The authored Olist MCP server (Phase 2)
> and the eval pipeline scored against it (Phase 3) were removed from the
> codebase. Phase 1 (study) is unaffected. The phase-2-plan.md,
> phase-2-smoke-test.md, phase-3-plan.md, and next-moves.md docs carry their
> own retirement banners and remain as historical records. The umbrella plan
> below is preserved unchanged for the same reason.

- **book:** blooming-insights-hardening
- **summary:** Study the architecture until you can defend it cold, then make it source-agnostic by authoring your own MCP server, then prove it correct with evals. Each phase ships before the next starts.

Goal: take blooming insights from "impressive AI demo built for one company's MCP server" to "engineered, source-agnostic multi-agent system I can run live and prove is correct." This is the flagship AI-engineering project for the L4–L5 pivot.

## Don't change these

Not a phase — the parser skips this section. The parts below already work and carry the project's value. The study / swap / eval work must add around them, never rewrite them; if a phase starts changing this list, the plan has been left.

- `runAgentLoop` (`lib/agents/base.ts`) — the shared Claude + MCP tool-use loop
- the four agents (coordinator / monitoring / diagnostic / recommendation) + their typed outputs
- the `AgentEvent` NDJSON streaming contract (`lib/mcp/events.ts`)
- the stepper / feed / investigate UI and the streamed `StatusLog` surface
- the 144 Vitest tests (agent loops TDD'd with injected fakes, no network)
- the demo path (`bi:mode` toggle, committed `lib/state/demo-*.json`)

The only *new* artifacts this introduces: a `DataSource` seam, one MCP server over a public dataset, and an evals harness.

## Phase 1 — Study (defend it cold)

- **goal:** After this you can explain every architectural seam out loud, unprompted, and point to exactly where the agents touch Bloomreach.

Writing the code and defending it in a 30-minute loop are different skills. This phase is targeted defense prep, not open-ended reading — and it doubles as prep for Phase 2, because you can't extract the `DataSource` seam cleanly until you re-understand where the agents touch Bloomreach. Point `study.md` at the codebase and generate a per-seam defense for each step below.

### Step 1 — Hand-rolled runAgentLoop vs a framework
- **activity:** READ
- **rationale:** Why you wrote the loop instead of LangGraph: control, testability, no lock-in, streaming transparency.

### Step 2 — Multi-agent division of labor
- **activity:** READ
- **rationale:** How coordinator/monitoring/diagnostic/recommendation hand off; the diagnosis-to-recommendation handoff specifically.

### Step 3 — NDJSON over ReadableStream vs SSE
- **activity:** READ
- **rationale:** POST-body support, no reconnect baggage, simpler contract than EventSource.

### Step 4 — Deterministic agent testing with injected fakes
- **activity:** READ
- **rationale:** The most senior-coded thing in the repo; be able to walk the no-network TDD setup.

### Step 5 — MCP protocol decisions
- **activity:** READ
- **rationale:** OAuth PKCE + DCR, rate-limit/retry/cache, no-cache-on-error, envelope handling, auto-reconnect — each a why answer.

### Step 6 — Cost-aware model routing
- **activity:** READ
- **rationale:** Haiku for the intent classifier, sonnet for agents, and the tradeoff behind it.

### Step 7 — 90-day window enforcement
- **activity:** READ
- **rationale:** Short windows produce bogus swings on the sparse tail; this is a correctness decision, not a default.

Exit — you can explain every step above out loud without looking at the code, and point to exactly where each agent touches the Bloomreach MCP client (the Phase 2 input).

## Phase 2 — Swap (author your own MCP server)

- **goal:** After this blooming insights runs live end-to-end against your own MCP server over Olist, with the Bloomreach adapter dormant but switchable.

The high-value move is *authoring* your own MCP server over a public dataset, not adapting your auth to someone else's server. You currently consume an MCP server (the lower-signal half); authoring one means you own both sides of the protocol — the biggest gap-closer in the portfolio — and the auth refactor mostly evaporates. This answers "wasn't this just for Bloomreach?" with the best possible reply: *"no — Bloomreach was one adapter; here's the seam, and here's a second live adapter I run today."* Steps 1–4 are the seam extraction (2a), 5–7 the server (2b), 8–9 the wiring (2c).

### Step 1 — Identify every Bloomreach McpClient call site
- **activity:** EXERCISE
- **rationale:** 2a: the output of Phase 1's study — you can't extract the seam until you know the coupling.

### Step 2 — Define the DataSource interface
- **activity:** EXERCISE
- **rationale:** 2a: minimal surface the agents need — query + tool discovery + the {result, durationMs, fromCache} shape.

### Step 3 — Make Bloomreach McpClient implement DataSource
- **activity:** EXERCISE
- **rationale:** 2a: keep it as a dormant adapter; don't delete the OAuth/PKCE code — it proves the seam wasn't retrofitted.

### Step 4 — Route agents through DataSource
- **activity:** EXERCISE
- **rationale:** 2a: agents call the interface, never Bloomreach directly.

### Step 5 — Load a public ecommerce dataset
- **activity:** TODO
- **rationale:** 2b: Olist or UCI Online Retail into Postgres (or SQLite for zero-infra) so the domain stays identical.

### Step 6 — Write the MCP server query tool
- **activity:** EXERCISE
- **rationale:** 2b: SQL-backed query tool analogous to execute_analytics_eql — the tool-schema design is the senior artifact.

### Step 7 — Second DataSource implementation
- **activity:** EXERCISE
- **rationale:** 2b: the SQL-backed adapter behind the same interface.

### Step 8 — Wire SQL as the live default
- **activity:** EXERCISE
- **rationale:** 2c: extend bi:mode — demo snapshot, live SQL (default), dormant Bloomreach.

### Step 9 — SQL-shaped domain-prompt pass
- **activity:** EXERCISE
- **rationale:** 2c: the only agent-adjacent change, and it's prompt-level not loop-level.

Exit — blooming insights runs live on your own MCP server over Olist; agents unchanged except prompts; Bloomreach adapter still present and switchable.

## Phase 3 — Eval (prove it correct)

- **goal:** After this you can say the detection hits X% precision/recall and diagnoses pass rubric at Z% — numbers you generated against data you control.

Now tractable: you own the data, so you can construct known anomalies on purpose and have ground truth. This is the line that separates "built an AI demo" from "engineers AI systems," and the highest-signal thing you can say in a screen. The steps map onto the three fuzzy agent outputs plus a regression guard.

### Step 1 — Detection precision/recall
- **activity:** EXERCISE
- **rationale:** Seed known anomalies into Olist; score whether the monitoring agent catches them, ranks severity, avoids false positives.

### Step 2 — Diagnosis rubric (LLM-as-judge)
- **activity:** EXERCISE
- **rationale:** Reference diagnosis per seeded anomaly; judge for right hypothesis, real evidence, segment sizing — spot-check the judge.

### Step 3 — Recommendation rubric
- **activity:** EXERCISE
- **rationale:** Lighter-weight: is the action plausible, specific, impact-sized?

### Step 4 — Regression eval on the agent loop
- **activity:** EXERCISE
- **rationale:** Reuse the injected fakes you already have; assert stable structured output across prompt/model changes.

Exit — a runnable eval suite with reported numbers; you can state detection precision/recall and diagnosis rubric pass-rate from data you control.

## Sequencing rules

Parser skips this section. Study bleeds into Phase 2 naturally — but don't start the seam extraction until you can explain the current Bloomreach coupling out loud. The swap ships and runs live on Olist *before* any eval work begins. Each phase ships before the next starts; no interleaving. The "don't change these" list stays frozen the whole way through.

## What this closes

Agents — already strong (hand-rolled loop, multi-agent, deterministic tests); Phase 1 makes it defensible. MCP — upgraded from consuming to authoring (Phase 2), the biggest gap-closer. Evals — added (Phase 3), the missing pillar. Source-agnostic architecture — the `DataSource` seam turns the lost Bloomreach access into evidence of good design.

## After this — the RAG gap

The one pillar this project doesn't close is RAG, and forcing it here would be contrived (blooming insights queries live data). That's a separate phase-two project — the agentic RAG engine with a `KnowledgeDomain` adapter. One flagship done deeply first.
