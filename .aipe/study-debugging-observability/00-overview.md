# Overview — debugging & observability, applied

## The repo, told through what it can explain about itself

blooming insights is a Next.js multi-agent LLM app that streams agent
reasoning to the browser as newline-delimited JSON. The interesting
observability question isn't "does the server log HTTP status codes"
— every framework does that. It's **"when a diagnosis comes out
wrong, or a request eats the 300s budget, what does the repo let
you reconstruct after the fact?"**

The answer is a stacked evidence surface, and it's better than most
repos this size:

```
  What you can reconstruct                Where the evidence lives

  what the agent said, live               NDJSON on the wire → StatusLog
  which tool it called + result           tool_call_start / _end events
  per-phase wall-clock latency            console.log summary in finally
  per-invocation tokens + cost            eval/receipts/*.json (usage row)
  regression vs baseline                  eval/gate-<runId>.json
  behavior under fault load               eval/load-receipts/load-*.json
  auth token leak in an error body        transport.ts redactSecrets()
  who cancelled and how much was burned   phase log's `aborted: true`
```

## Verdict-first — the top-three ranked findings

**1 · The NDJSON trace is the load-bearing observability surface.**
Every claim the product makes ("here's the anomaly, here's the
diagnosis, here's the recommendation") has a matching event on the
wire (`lib/mcp/events.ts:5-14`). Strip it and the product's whole
"agent shows its work" pitch collapses — the UI is *literally*
rendering that stream. → see `01-ndjson-live-trace.md`.

**2 · The receipts are what makes debugging tractable across runs.**
Live traces vanish when the browser closes. `eval/receipts/*.json`
persists a 35KB-per-case JSON — anomaly, diagnosis, judgment, tool
calls, tokens, cost, budget — so "why did case 09 take 675s at rec-
judge?" is a question you can answer without re-running. →
`03-capability-trace-receipts.md`.

**3 · The regression gate is the incident-prevention layer.**
`eval/baseline.json` (committed) plus `eval/gate.eval.ts` turns
"the judge model's per-dimension pass rate dropped 12pp" into a
CI failure. This is the mechanism that catches quality regressions
from prompt changes or model swaps. → `04-baseline-and-regression-
gate.md`.

## The ranked risks (from `audit.md`'s red-flags lens)

  → **`console.log` is the only production log sink.** Vercel scrapes
    stdout, but there's no structured shipping, no per-tenant redaction
    beyond `redactSecrets` for OAuth tokens, and no correlation ID beyond
    the session cookie value. Fine for the current alpha; expensive to
    retrofit if a paying customer arrives.

  → **The client-side trace is transient.** If the browser tab closes
    mid-investigation, the `sessionStorage` copy of the trace is gone.
    The server keeps the *combined* run only (via
    `saveInvestigation`, `app/api/agent/route.ts:305`) — the split
    diagnose / recommend runs live only in the client.

  → **The per-tool-call latency in the report already reads 0ms for
    receipts written before the recorder captured it.** The report tags
    "backfilled" rows explicitly (`eval/report.eval.ts:136-142`), but a
    reader who trusts the number without noticing the tag will
    under-count.

  → **Cache-tier tokens are under-counted in the budget.** The
    `AnthropicModelProviderAdapter` sums `input_tokens` and
    `output_tokens` from the SDK response (`aptkit-adapters.ts:105-108`)
    but not `cache_read_input_tokens` — so when caching is on, the
    budget tracker under-counts the actual API cost. This is
    intentional (documented in `pricing.ts:6-13`) but a future
    on-call reading the receipt should know.

## What's `not yet exercised`

- **Structured shipping.** No pino/winston/OTel/Sentry. All logs go
  to stdout as `JSON.stringify(...)` and Vercel scrapes them.
- **Distributed tracing.** No span IDs, no OpenTelemetry, no cross-
  service correlation. The whole system is one Next.js process.
- **Metrics with SLOs and alerts.** There is no metrics pipeline
  (Prometheus/Datadog/etc.). Percentiles live in receipts and get
  computed on demand by the report; nothing alerts on them.
- **Production runbooks.** No `docs/runbooks/` and no incident
  playbooks. The alpha server's known revoked-token behavior is
  handled by client-side reconnect logic (`useReconnectPolicy.ts`),
  not by a documented on-call procedure.

Each of these gets a "when it starts to matter" note in `audit.md`.
