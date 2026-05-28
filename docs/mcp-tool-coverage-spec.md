# Spec: MCP Tool Coverage & Data-Gathering Reliability

## Context

This codebase (`blooming insights`) is an AI analyst for Bloomreach Engagement. Four agents (monitoring, diagnostic, recommendation, query) drive a shared Claude + MCP tool-use loop (`lib/agents/base.ts`) to gather workspace data via the Bloomreach MCP server.

A review of MCP tool usage found that **tool breadth is adequate** — the gating problems are (1) the bootstrap tool list being out of sync with actual code, (2) rate limiting choking the data-gathering loop, and (3) brittle EQL syntax burning the limited call budget. This spec defines the fixes.

Do **not** treat "add more tools" as the goal. The goal is making the tools we already wire up reliably return data.

---

## Goal

Increase the share of investigations that conclude with a real, data-backed diagnosis (rather than "insufficient data") by fixing tool-list drift, rate-limit handling, and EQL-syntax failure modes.

---

## Findings & Required Changes

### 1. Reconcile `bootstrapTools` with actual usage — `lib/mcp/tools.ts`, `lib/mcp/schema.ts`

**Problem.** `bootstrapTools` does not match what the bootstrap code actually calls.

- Called in code but **missing** from `bootstrapTools`:
  - `list_cloud_organizations` (used in `resolveProject`)
  - `get_customer_property_schema` (used in `bootstrapSchema`)
  - `list_catalogs` (used in `bootstrapSchema`)
- Listed in `bootstrapTools` but **never called**:
  - `get_customer_schema`
  - `get_mapping`

**Required.**
- Update `bootstrapTools` to the set the code actually calls: `whoami`, `list_cloud_organizations`, `list_projects`, `get_project_overview`, `get_event_schema`, `get_customer_property_schema`, `list_catalogs`.
- Decide on `get_customer_schema` and `get_mapping`: either remove them, or (preferred, if the MCP server exposes them) confirm whether `get_customer_schema` is the correct name vs. `get_customer_property_schema` and consolidate. Do not leave dead names in the list.
- Verify each retained name against a live `listTools()` dump (see task 5) before finalizing.

**Acceptance.** Every name in `bootstrapTools` is called somewhere in `schema.ts`; every tool `schema.ts` calls is in `bootstrapTools`; no name in the list is absent from the server's `listTools()` output.

---

### 2. Fix rate-limit retry tuning — `lib/mcp/client.ts`

**Problem.** Bloomreach enforces ~1 req/s globally, but observed errors report a **10-second** window: `rate limit reached ... (1 per 10 second)`. Current config (`retryDelayMs: 1200`, `maxRetries: 3`) retries far too soon — all three retries can fall inside the same 10s penalty window and fail, wasting the call. Investigation traces show 2–3 of every 6 budgeted calls lost to `Too many requests`.

**Required.**
- Parse the retry-after hint from the error text when present (`Retry after ~N second(s)`) and sleep for that duration (plus a small buffer) instead of a fixed `retryDelayMs`.
- Raise the default `retryDelayMs` fallback to at least `10_000` (matching the observed window) for when no hint is parseable.
- Consider exponential backoff capped at a ceiling (e.g. 10s, 20s) rather than a flat delay.
- Keep `maxRetries` configurable; evaluate raising it to 4–5 now that each wait is longer, but bound total wait against the per-investigation latency budget (see note in `base.ts`: 60s).
- Ensure rate-limited results are still **not cached** (current behavior is correct — preserve it).

**Acceptance.** A simulated `(1 per 10 second)` error in a unit test triggers a wait that respects the parsed retry-after value; a call that is rate-limited then succeeds on retry returns the successful result and is cached.

---

### 3. Reduce wasted calls from EQL syntax errors — agent prompts

**Problem.** Traces show repeated first-attempt EQL failures that consume budget:
- Bare metric without `select` wrapper: `select count event purchase in last 365 days` → error "analysis type 'metric' cannot be executed directly". (The model often omits the grouping/report form.)
- Event-property access with leading dot: `by .category_level_1` / `by .source` / `by .device` → "Unexpected token ." The correct form is `by event <event>.<property>` or `by customer.<property>`.

These are recurring and predictable. The prompts already have EQL reminders but the model still trips on them.

**Required.** In `lib/agents/prompts/diagnostic.md`, `monitoring.md`, and `query.md`, strengthen the EQL section:
- Add an explicit **"common errors to avoid"** block with the exact failing forms above and their corrections, e.g.:
  - WRONG: `select count event purchase in last 7 days` used as a standalone metric → must be a report/segmented form.
  - WRONG: `by .device` → RIGHT: `by event session_start.device` (event property) or `by customer.device_type` (customer property).
- State the rule once, prominently: **event properties require the `event <event_name>.` prefix; customer properties require the `customer.` prefix; never a bare leading dot.**
- Reinforce that a syntax-error response still counts against the 6-call budget, so the model must use known-good forms on the first attempt.

**Acceptance.** Prompt files contain an explicit common-errors block covering the metric-wrapper and leading-dot cases. (Behavioral validation is qualitative — fewer syntax-failure tool results in new traces.)

---

### 4. Re-evaluate the tool-call budget — `lib/agents/diagnostic.ts`, `monitoring.ts`, `query.ts`

**Problem.** `maxToolCalls: 6` was set as a latency bound under the 1 req/s limit. But when 2–3 calls are lost to rate limits or syntax errors, the effective useful-call budget drops to 3–4, which is why diagnoses land on "insufficient data."

**Required.**
- Once tasks 2 and 3 reduce wasted calls, re-measure how many *successful* calls a typical investigation gets.
- Decide whether to (a) keep 6 now that fewer are wasted, or (b) raise the cap modestly. If raising, recompute worst-case latency: `maxToolCalls × (retry waits + response time)` must stay within the per-investigation budget. Document the chosen number and the latency math in a comment.
- Do not raise the budget blindly before tasks 2–3 land — that just increases latency without fixing the waste.

**Acceptance.** A comment in each agent file justifies the chosen `maxToolCalls` value against the latency budget and the post-fix success rate.

---

### 5. Add a live `listTools()` introspection check (supporting task)

**Problem.** Tool-name correctness is currently assumed, not verified. Task 1 depends on knowing the real server tool set.

**Required.**
- Add a small dev script or test that connects (or uses the existing `/debug` introspection path referenced in `client.ts`) and dumps `listTools()` names.
- Cross-check every name in `monitoringTools`, `diagnosticTools`, `recommendationTools`, and `bootstrapTools` against that dump. Flag any name not present on the server.

**Acceptance.** Running the check prints the server tool set and lists any configured-but-nonexistent tool names. No configured name is missing from the server (or each discrepancy is documented).

---

## Out of Scope

- Adding new MCP tools for new data domains. Current coverage (analytics/EQL, funnels, segments, scenarios, campaigns, vouchers, catalogs, prediction scores) is sufficient for the monitoring → diagnostic → recommendation flow.
- The OAuth/shared-store production hardening noted in `connect.ts` and `auth.ts` (tracked separately).

---

## Suggested Order

1. Task 5 (introspection) — gives ground truth for task 1.
2. Task 1 (reconcile bootstrap list).
3. Task 2 (rate-limit retry) — highest impact on data gathering.
4. Task 3 (EQL prompt hardening).
5. Task 4 (budget re-tuning) — last, since it depends on 2 and 3.
