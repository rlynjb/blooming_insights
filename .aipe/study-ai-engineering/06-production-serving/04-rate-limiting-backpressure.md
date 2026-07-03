# 04 — Rate limiting and backpressure

**Type:** Industry standard. Also called: outbound throttling, load shedding, concurrency capping.

## Zoom out, then zoom in

Two rate-limit surfaces. One is present (outbound to the Bloomreach MCP server, ~1 req/s in `BloomreachDataSource`). The other isn't (inbound to `/api/agent` from the client).

```
  Zoom out — rate-limit surfaces

  ┌─ Client (browser) ────────────────────────────────────────────────┐
  │                    inbound rate limit ← NOT PRESENT (Case B)       │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  POST /api/agent
  ┌─ Route (Next.js) ───────────▼─────────────────────────────────────┐
  │  no queue, no per-user rate limit                                  │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  agent invokes DataSource
  ┌─ BloomreachDataSource ──────▼─────────────────────────────────────┐
  │  ~1 req/s outbound spacing + retry ladder on 429                   │
  │  ★ THIS CONCEPT (outbound present) ★                               │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
                         Bloomreach MCP (alpha, rate-limited)
```

Zoom in. The alpha MCP server has explicit rate limits (~1 req/s). `BloomreachDataSource` respects them proactively (minimum interval between calls) and reactively (parses `retry-after` from 429 responses). Inbound rate limiting on the app's own `/api/*` routes isn't present — the app assumes trusted first-party traffic today.

## Structure pass

Axis: where's the bottleneck vs where's the flow control?
- Outbound bottleneck: alpha MCP server (~1 req/s)
- Outbound flow control: BloomreachDataSource (proactive interval + retry-after parsing)
- Inbound bottleneck: (would be) LLM API quota / compute
- Inbound flow control: (missing) not implemented at the route

**Seam:** the DataSource port. Above: agents unaware of rate limits. Below: the adapter absorbs the throttling.

## How it works

### Move 1

You've throttled outbound API calls with a `sleep(1000)` between them or a token bucket. Same idea here — client-side spacing to stay under the server's rate limit.

```
  Two rate limit types

  outbound (this repo has):
    my code throttles before hitting a rate-limited external service

  inbound (this repo doesn't have):
    my code refuses excess incoming requests before they consume resources
```

### Move 2

**Outbound — `BloomreachDataSource`.**

Key file: `lib/data-source/bloomreach-data-source.ts`. Two behaviors:

1. **Proactive minimum interval (~1 req/s).** Before each `callTool`, ensures at least `minIntervalMs` (default ~1000ms) has passed since the previous call. Simple counter + sleep. Prevents bursts from tripping the rate limit at all.

2. **Reactive retry ladder on 429.** When the server responds with a rate-limit error, `parseRetryAfterMs` (`bloomreach-data-source.ts:64-71`) tries two patterns from the wild:
   - `"Retry after ~12 second(s)"` → 12000ms
   - `"rate limit reached (1 per 10 second)"` → 10000ms
   Falls back to backoff base if nothing parseable. Adds `RETRY_BUFFER_MS = 500` cushion so the retry lands just AFTER the penalty clears.

3. **Retry loop with a ceiling.** Bounded number of retries (`maxRetries`); each retry waits the parsed hint (or backoff), then re-invokes.

**Cache absorbs repeats.**

The 60s response cache in the same adapter absorbs repeated identical calls entirely — never touches the wire. Not strictly a rate limit but effectively increases throughput budget by eliminating redundant traffic.

**Inbound — missing.**

The `/api/agent` and `/api/briefing` routes have no per-user rate limit, no queue, no concurrency cap. Assumes trusted first-party traffic. Would matter if the app were opened to broader access:
- One user could hammer `/api/agent` and consume all Anthropic quota
- Concurrent investigations from many users could exceed a shared budget

Case B — add token-bucket rate limiting keyed on session id at the route entry, plus a per-user concurrent-investigation cap.

**Backpressure — the queue-and-shed pattern.**

Standard shape: incoming requests join a bounded queue. When queue depth > threshold, new requests get rejected (429). Prevents unbounded memory growth and gives fast-fail feedback to clients. This codebase doesn't have this because it has no queue — every request is served immediately, with no shedding.

### Move 3

Rate limits live at the boundary you can control. Outbound: your code, before hitting rate-limited services. Inbound: your code, before consuming resources. This codebase has outbound (necessary — alpha MCP server has strict limits); inbound is Case B (would matter if traffic grew).

## Primary diagram

```
  Outbound rate limit — the loop

  agent decides to call a tool
    │
    ▼
  BloomreachDataSource.callTool()
    │
    ▼
  wait until  now() - lastCallAt >= minIntervalMs   ← proactive spacing
    │
    ▼
  send to Bloomreach MCP
    │
    ├── success? → return {result, durationMs, fromCache: false}
    │
    └── 429 rate limit?
         │
         ▼
       parseRetryAfterMs(response)  ← parse server's stated window
         │
         ├── got hint → sleep(hint + BUFFER) → retry
         │
         └── no hint  → sleep(backoff) → retry
                       ↑
                       │
                       └── bounded by maxRetries
```

## Elaborate

Rate limiting patterns beyond what's here:
- **Token bucket** — accumulate tokens at rate R, spend one per request, block when empty. Cleaner than `sleep`-based spacing.
- **Leaky bucket** — fixed-capacity queue drains at rate R; overflow is dropped.
- **Adaptive** — measure rejection rate; back off dynamically.

For LLM app scaling, inbound rate limiting matters when a single user could exhaust shared quota. Anthropic's per-tier limits (requests per minute, tokens per minute, requests per day) are what you'd size against.

## Project exercises

### Exercise — inbound rate limiting per session

- **Exercise ID:** C5.4-B · Case B (inbound not built).
- **What to build:** middleware on `/api/agent` + `/api/briefing`. Token bucket per sessionId, 10 requests/hour, 3 concurrent investigations. On over-limit, respond 429 with `retry-after`. Log rejection events.
- **Why it earns its place:** protects Anthropic quota + LLM cost budget from a single misbehaving client. Interviewer signal: "I know inbound rate limiting is missing and here's how I'd add it."
- **Files to touch:** `lib/middleware/rate-limit.ts` (new), `app/api/agent/route.ts` (apply middleware), `app/api/briefing/route.ts`.
- **Done when:** load-testing with 20 rapid requests from one session produces 3 processed + 17 429s.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Where's your outbound rate limit?**

`BloomreachDataSource` at `lib/data-source/bloomreach-data-source.ts`. Two behaviors: proactive ~1 req/s minimum spacing between calls, and reactive retry-after parsing on 429. Two shapes of retry-after in Bloomreach's error envelope: `"Retry after ~N second(s)"` and `"rate limit reached (1 per N second)"`. Adds a 500ms buffer on top so the retry lands after the penalty clears.

**Q: Inbound rate limit?**

Not present. Assumes first-party trusted traffic today. If the app opened to broader access, I'd add token-bucket rate limiting keyed on session id at the route entry, plus a per-user concurrent-investigation cap. Case B — Anthropic quota exhaustion is the real concern; a single misbehaving client could tank the whole app.

```
  outbound: present  (alpha MCP is rate-limited)
  inbound:  Case B   (open access would need it)
```

**Q: What's backpressure vs rate limiting?**

Rate limiting caps THROUGHPUT (requests per second). Backpressure caps CONCURRENCY (in-flight requests). Both are needed at scale. Rate limit says "you can't send more than X per second." Backpressure says "you can't have more than N in-flight."

## See also

- `05-retry-circuit-breaker.md` — the retry ladder mentioned here
- `04-agents-and-tool-use/06-error-recovery.md` — how the agent reacts to injected 429s
- `lib/data-source/bloomreach-data-source.ts` — the outbound throttle
- `lib/data-source/fault-injecting.ts` — the fault injector that tests it
