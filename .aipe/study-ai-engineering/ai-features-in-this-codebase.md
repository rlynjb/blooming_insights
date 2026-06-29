# AI features in this codebase

Every place AI shows up in blooming insights, what pattern it uses, and why.

## AI features table

```
  ┌────────────────────┬────────────────────────┬────────────────────────────────┐
  │ Feature            │ Pattern used           │ Why this pattern               │
  ├────────────────────┼────────────────────────┼────────────────────────────────┤
  │ Anomaly monitoring │ Agent loop +           │ The schema isn't known up      │
  │ (briefing)         │ fixed checklist of     │ front; the model picks WHICH   │
  │                    │ ecommerce categories   │ EQL queries to run from a      │
  │                    │ (10 categories)        │ category recipe — but ONLY     │
  │                    │                        │ from the gated 10.             │
  ├────────────────────┼────────────────────────┼────────────────────────────────┤
  │ Diagnostic         │ Agent loop +           │ 2–3 hypotheses, query each,   │
  │ investigation      │ structured hypothesis  │ pick the supported one. Loop  │
  │ (per anomaly)      │ list                   │ size capped at 6 tool calls.  │
  ├────────────────────┼────────────────────────┼────────────────────────────────┤
  │ Recommendation     │ Agent loop +           │ Reads the diagnosis, checks   │
  │ generation         │ feature-discovery      │ existing scenarios so it       │
  │ (per diagnosis)    │ tool reads             │ doesn't propose dupes; loop    │
  │                    │                        │ capped at 4 tool calls.        │
  ├────────────────────┼────────────────────────┼────────────────────────────────┤
  │ Free-form query    │ Heuristic intent       │ Cheap haiku classifier picks   │
  │ ("ask anything")   │ classify → routed      │ monitoring / diagnostic /      │
  │                    │ to one of the three    │ recommendation; sonnet runs    │
  │                    │ shapes                 │ the actual query loop.         │
  ├────────────────────┼────────────────────────┼────────────────────────────────┤
  │ Intent             │ Single LLM call        │ One-shot, no tools, no loop.   │
  │ classification     │ (no agent, no tools)   │ Routes free-form questions     │
  │                    │                        │ into the agent-loop shapes.    │
  └────────────────────┴────────────────────────┴────────────────────────────────┘
```

## Per-feature spec

### 1. Anomaly monitoring (briefing)

  → **Inputs (typed):** `WorkspaceSchema` (lib/mcp/schema.ts) — events, customer
    properties, catalogs, totals. Plus the gated category list from
    `lib/agents/categories.ts` (an array of `AnomalyCategory` filtered by
    `runnableCategories()` against the schema's available signals).

  → **Outputs (typed):** `Anomaly[]` — `{ metric, scope, change: {value,
    direction, baseline}, severity, evidence[], impact?, category? }`. The
    handler converts each `Anomaly` into an `Insight` (id + timestamp +
    headline derived) and streams `{ type: 'insight', insight }` lines.

  → **Model and provider:** `claude-sonnet-4-6` via Anthropic SDK (default
    `AGENT_MODEL` in `lib/agents/base.ts:7`).

  → **Approximate token cost per call:** input ~3–6k tokens (system prompt +
    schema summary + category checklist), output ~1–2k (10 anomalies max,
    JSON-shaped). The monitoring loop iterates ~3–6 times (tool calls
    capped at 6 in the prompt), so total tokens per briefing land around
    20–35k input + 5–10k output. At Sonnet pricing (~$3/M in, ~$15/M out)
    that's roughly $0.20–$0.30 per briefing.

  → **Failure modes observed:**
    - Empty-window bug: the workspace's most recent days can be empty, so a
      naive `in last 7 days` query returns 0 and produces a bogus ±100%
      swing. The prompt enforces 90d windows + a volume-check first call.
    - Bloomreach rate-limit (1 per 10s globally per user) — handled by
      the adapter's (`BloomreachDataSource`) parse-hint retry ladder.
    - Token revocation: the alpha MCP server revokes after minutes; the UI
      catches `invalid_token` errors and reloads via `useReconnectPolicy`.

  → **Eval set:** none in repo. The closest substitute is the committed
    `lib/state/demo-insights.json` snapshot, which is the "this is what
    a good briefing looks like" reference for the demo.

### 2. Diagnostic investigation

  → **Inputs (typed):** `Anomaly` (from monitoring) + `WorkspaceSchema`.

  → **Outputs (typed):** `Diagnosis` — `{ conclusion, evidence[],
    hypothesesConsidered[{hypothesis, supported, reasoning}],
    affectedCustomers?, confidence?, timeSeries? }`.

  → **Model and provider:** `claude-sonnet-4-6`.

  → **Approximate token cost per call:** input ~4–7k per turn (prompt +
    anomaly context), output ~500–1.5k per turn. Loop runs 3–6 turns; total
    ~25–40k input + 3–8k output ≈ $0.10–$0.20.

  → **Failure modes observed:**
    - LLM emits a `customers matching ...` clause (unsupported in EQL) and
      wastes a call. The prompt explicitly forbids this.
    - LLM picks a tool that's not in the `diagnosticTools` allowlist —
      AptKit's `ToolRegistry` simply doesn't list it, so the model can't
      call it (forced into the allowlist).

  → **Eval set:** none. Demo replay (`lib/state/demo-investigations.json`)
    is the reference shape.

### 3. Recommendation generation

  → **Inputs (typed):** `Anomaly` + `Diagnosis`.

  → **Outputs (typed):** `Recommendation[]` — id-less from the agent, ids
    assigned post-validation in `lib/mcp/validate.ts:42-56`.

  → **Model and provider:** `claude-sonnet-4-6`.

  → **Approximate token cost per call:** tightest loop — capped at 4 tool
    calls. ~15–25k input + 2–4k output ≈ $0.08–$0.12.

  → **Failure modes observed:**
    - Proposing automation that already exists. The prompt mitigates by
      requiring a `list_scenarios` check first.

  → **Eval set:** none.

### 4. Free-form query ("ask anything")

  → **Inputs (typed):** a query string + the schema.

  → **Outputs (typed):** `string` (the final natural-language answer).

  → **Model and provider:** `claude-haiku-4-5-20251001` for intent classification,
    `claude-sonnet-4-6` for the query loop.

  → **Approximate token cost per call:** intent classify is ~500 in + 50 out
    (haiku, ~$0.0003). The sonnet query loop varies wildly with what was
    asked; budget similar to a diagnostic call.

  → **Failure modes observed:**
    - Ambiguous queries → classifier picks the wrong intent. No fallback;
      the user re-asks.

  → **Eval set:** none. Live-only feature (the QueryBox is inert in demo).

### 5. Intent classification

  → **Inputs (typed):** raw query string.

  → **Outputs (typed):** `QueryIntent` (defined inside `@aptkit/core`;
    re-exported from `lib/agents/intent.ts:9`).

  → **Model and provider:** `claude-haiku-4-5-20251001` — the only place
    haiku is used. Chosen for cost + latency: a one-shot classify shouldn't
    pay sonnet rates.

  → **Approximate token cost per call:** ~500 in + 50 out ≈ $0.0003 per
    classify. Haiku is ~10x cheaper than sonnet on input and ~6x on output.

  → **Failure modes observed:**
    - `parseIntent` is lenient and defaults to `'diagnostic'` when the model
      returns junk (`lib/agents/intent.ts:12-14`).

  → **Eval set:** none.

## The non-feature: where AI is deliberately NOT used

  → **Headline derivation, severity dot, sparkline data** — derived
    deterministically in `lib/insights/derive.ts`, not LLM-generated. Adding
    the LLM here would add latency and a failure mode without buying anything.

  → **Coverage grid (which categories ran)** — computed from the schema
    capabilities + the category requirements (`schemaCapabilities()` +
    `coverageReport()` in `lib/agents/categories.ts`). Pure logic.

  → **Demo replay** — pre-captured JSON. No model is called when the user is
    in demo mode. This is the whole reason the demo is reliable.

  → **Bootstrap (schema discovery)** — fixed MCP tool sequence
    (`list_cloud_organizations` → `list_projects` → `get_event_schema` …),
    not an LLM-driven exploration. The LLM only sees the *summary* of what
    was discovered.
