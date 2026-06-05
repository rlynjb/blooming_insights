# blooming insights — portfolio hardening plan

goal: take blooming insights from "impressive AI demo built for one company's MCP server" to "engineered, source-agnostic multi-agent system i can run live and prove is correct." this is the flagship AI-engineering project for the L4–L5 AI Product Engineer pivot.

three phases, run **in order, each shipped before the next starts**: study → swap → eval.

the reorder vs. the original instinct: source-swap goes *before* evals. evaling the current Bloomreach-shaped pipeline and then swapping the source invalidates the labeled set and rubrics. swapping first gives a dataset you control + ground truth, which is what makes evals tractable.

---

## the moat — freeze this across all three phases

these don't change. if a phase starts rewriting them, the plan has been left.

- `runAgentLoop` (`lib/agents/base.ts`) — the shared Claude + MCP tool-use loop
- the four agents (coordinator / monitoring / diagnostic / recommendation) + their typed outputs
- the `AgentEvent` NDJSON streaming contract (`lib/mcp/events.ts`) — route producers + UI consumers depend on it
- the stepper / feed / investigate UI and the streamed `StatusLog` reasoning surface
- the 144 Vitest tests (agent loops TDD'd with injected fakes, no network)
- the demo path (`bi:mode` toggle, committed `lib/state/demo-*.json`)

the only *new* artifacts this plan introduces: a `DataSource` seam, one MCP server over a public dataset, and an evals harness.

---

## phase 1 — study the architecture (defend it cold)

writing the code and defending it in a 30-min loop are different skills. this phase is targeted defense prep, not open-ended reading. it doubles as prep for phase 2 — you can't extract the `DataSource` seam cleanly until you re-understand exactly where the agents touch Bloomreach.

point `study.md` at this codebase and generate per-pattern defenses for the seams an interviewer will push on:

- [ ] **hand-rolled `runAgentLoop` vs. a framework** — why you wrote the loop instead of reaching for LangChain/LangGraph. tradeoffs you can name: control over the tool-use cycle, testability, no framework lock-in, transparency for the streaming surface.
- [ ] **multi-agent division of labor** — how coordinator → monitoring → diagnostic → recommendation hand off, what each owns, why split vs. one mega-agent. the diagnosis→recommendation handoff (step 2 output feeds step 3) specifically.
- [ ] **NDJSON-over-`ReadableStream` vs. SSE/`EventSource`** — why you chose newline-delimited JSON consumed via a fetch stream reader. (POST body support, no reconnect semantics baggage, simpler contract.)
- [ ] **deterministic agent testing** — how injected fakes let you TDD agent loops with no network. this is the single most senior-coded thing in the repo; be able to walk the setup.
- [ ] **MCP protocol decisions** — OAuth PKCE + dynamic client registration, ~1 req/s rate-limit + retry + cache, no-cache-on-error, `structuredContent`-vs-`content[0].text` envelope handling, auto-reconnect on `invalid_token`. each one is a "why did you do it this way" answer.
- [ ] **cost-aware model routing** — haiku for the intent classifier, sonnet for agents. the tradeoff and why.
- [ ] **the 90-day window enforcement** — why short windows produce bogus ±100% swings on the sparse tail, and why this is a *correctness* decision, not a default.

exit criteria: you can explain each of the above out loud, unprompted, without looking at the code. and you can point to exactly where in the code each agent touches the Bloomreach MCP client (this is the phase-2 input).

---

## phase 2 — swap the data source (author your own MCP server)

reframe vs. the original "swap MCP server + refactor auth": the high-value move is **authoring** your own MCP server over a public dataset, not adapting your auth to someone else's server. you currently *consume* an MCP server (the lower-signal half); authoring one means you own both sides of the protocol — the biggest remaining gap-closer in the portfolio. it also makes the auth refactor mostly evaporate (your own server, your own simple/no-auth in dev, no OAuth-against-an-alpha-server pain).

this answers the "wasn't this just for Bloomreach?" question with the best possible reply: *"no — Bloomreach was one adapter; here's the seam, and here's a second live adapter i run today."*

### 2a. extract the `DataSource` seam
- [ ] identify every call site where the agents currently reach the Bloomreach `McpClient` (output of phase 1).
- [ ] define a `DataSource` interface — the minimal surface the agents actually need (a `query` capability + tool discovery + the `{ result, durationMs, fromCache }` return shape the rest of the code depends on).
- [ ] make the existing Bloomreach `McpClient` implement `DataSource`. it stays — **dormant adapter that proves the abstraction is real.** do not delete the OAuth/PKCE code; it's evidence the seam wasn't retrofitted.
- [ ] agents call `DataSource`, never Bloomreach directly.

### 2b. write a minimal MCP server over a public dataset
- [ ] dataset: a real, queryable ecommerce corpus so the domain (revenue, funnels, segments, anomalies) stays identical and the agent layer barely moves. candidates: **Olist Brazilian e-commerce** (rich: orders, customers, payments, geography) or **UCI Online Retail**. load into Postgres (or SQLite for zero-infra).
- [ ] MCP server exposes a `query` tool over the dataset (SQL-backed, analogous to Bloomreach's `execute_analytics_eql`). this tool-schema design *is* the senior artifact — be deliberate about what you expose and why.
- [ ] second `DataSource` implementation backed by this server.
- [ ] dev auth: none or trivial. no OAuth.

### 2c. wire it as the live default
- [ ] extend the existing mode toggle: demo snapshot → **live SQL (default)** → (dormant) Bloomreach. reuses `bi:mode`.
- [ ] one small domain-prompt pass so agents emit SQL-shaped queries instead of EQL. this is the *only* agent-adjacent change — and it's prompt-level, not loop-level.

exit criteria: blooming insights runs live, end-to-end, against your own MCP server over Olist. agents unchanged except prompts. Bloomreach adapter still present and switchable.

---

## phase 3 — evals (turn the demo into an engineered system)

now tractable: you own the data, so you can construct known anomalies on purpose and have ground truth. this is the line that separates "built an AI demo" from "engineers AI systems" — and the highest-signal thing you can say in a screen.

evals map onto the three fuzzy agent outputs:

- [ ] **detection — precision/recall.** seed the Olist dataset with known anomalies (drop revenue in a segment, spike cart-abandons in a window). score the monitoring agent: does it catch them, rank severity correctly, avoid false positives?
- [ ] **diagnosis — rubric / LLM-as-judge.** for each seeded anomaly, a reference diagnosis. grade the diagnostic agent's output against it: right hypothesis? cited real evidence? sized the segment correctly? use LLM-as-judge with the judge itself spot-checked against your manual labels (don't trust the judge blind).
- [ ] **recommendation — qualitative rubric.** is the proposed action plausible, specific, impact-sized? lighter-weight; rubric-scored.
- [ ] **regression — reuse the fakes.** you're ~80% set up already: the agent loops are TDD'd with injected fakes offline. add a regression eval that runs the loop against fixed fakes and asserts stable structured output across prompt/model changes.

exit criteria: you can say *"an analyst that shows its work — and i can prove the detection hits X% precision / Y% recall and the diagnoses pass rubric at Z%."* numbers you generated, against data you control.

---

## sequencing rules

- study bleeds into phase 2 naturally — but don't start the seam extraction until you can explain the current Bloomreach coupling out loud.
- swap ships and runs live on Olist **before** any eval work begins.
- each phase ships before the next starts. no interleaving.
- the moat list above stays frozen the whole way through.

## what this closes

- **agents** — already strong (hand-rolled loop, multi-agent, deterministic tests). phase 1 makes it defensible.
- **MCP** — upgraded from *consuming* to *authoring* (phase 2). biggest gap-closer.
- **evals** — added (phase 3). the missing pillar.
- **source-agnostic architecture** — the `DataSource` seam turns the lost Bloomreach access into evidence of good design.

remaining portfolio gap after this: **RAG.** not forced into this project (it queries live data; RAG would be contrived). that's a separate phase-two *project* — the `study.md` / aipe direction, built as its own app over a real corpus. one flagship done deeply first.
