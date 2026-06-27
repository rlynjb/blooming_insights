# Error recovery

**Industry name(s):** graceful degradation, bounded retry, fallback chains, loop protection / budget caps
**Type:** Industry standard · Language-agnostic

> Every agent failure mode in blooming insights has a coded recovery: the forced-final tool-less turn caps the loop, a dedicated `synthesize()` rescues a loop that yields no valid JSON, `FALLBACK` is the last-resort diagnosis, the MCP client retries rate-limits with exponential backoff and never caches errors, the route's pre-stream setup is wrapped so a config throw returns the real error, and on the client a revoked alpha token triggers a one-time auto-reconnect. The budget IS the loop protection.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Error recovery is a cross-cutting discipline — every band has its own named failure mode and its own recovery. The Agent loop caps runaway loops (`forceFinal`); the Per-agent fallback chain catches parse failures (`tryParseDiagnosis ?? synthesize ?? FALLBACK`); the Provider wrappers handle 429s (`McpClient` exponential-backoff + no-cache-on-error); the Route's `try/catch/finally` turns thrown errors into `error` events without dropping the stream. Each layer guards the one below it.

```
  Zoom out — the recovery stack (one per layer)

  ┌─ Route handler ──────────────────────────────────┐
  │  try/catch → send('error') + finally close       │
  │  pre-stream setup try/catch → real error JSON     │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent (parse-failure fallback chain) ───────┐  ← we are here
  │  ★ tryParseDiagnosis ?? synthesize ?? FALLBACK ★  │
  │  monitoring: parseAgentJson failure → []          │
  │  diagnostic.ts L74–75 / monitoring.ts L113–118   │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Agent loop (loop-runaway cap) ──────────────────┐
  │  budgetSpent → forceFinal → tools omitted L101    │
  │  caps token bleed and runaway exploration         │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider wrappers + Tools ──────────────────────┐
  │  McpClient exponential-backoff on 429             │
  │  no-cache-on-error guard (L58–60)                 │
  │  alpha-token auto-reconnect ONCE                  │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what are the ways an agent run fails, and what coded recovery does each one have? An agent has more failure modes than a fetch — a model that will not stop querying, a model that returns prose where JSON was required, a backend that rate-limits mid-run — and any one of them, unhandled, breaks the whole run. blooming insights maps each failure to a specific recovery, and the unifying mechanism is the budget: the thing that bounds the loop is the same thing that protects it. How it works walks each failure mode and its named recovery.

---

## Structure pass

**Layers.** Four layers each guard against a different failure: the route handler (try/catch → `error` event + finally close), the per-agent fallback chain (`tryParseDiagnosis ?? synthesize ?? FALLBACK`), the agent loop (`budgetSpent → forceFinal` caps the runaway), and the provider/MCP wrappers (`McpClient` exponential-backoff on 429, no-cache-on-error, alpha-token one-time auto-reconnect). Each layer guards the one below it.

**Axis: failure.** Where does each failure mode originate, propagate, and get contained — and is there a recovery at every layer? This axis is the right lens because the file is structured by failure mode: each layer has a named failure (parse failure, loop runaway, 429, config throw) with a named recovery. Cost is downstream of failure; control doesn't move; the load-bearing question is "where does this error get caught and turned into something safe."

**Seams.** The cosmetic seam is within the per-agent fallback chain — `?? synthesize ?? FALLBACK` are three steps of *one* recovery. The load-bearing seams are *between* layers: each one represents "if the lower layer's recovery fails, the next layer up catches it." The most important is between agent loop and per-agent: failure containment flips from "loop terminated cleanly via `forceFinal`" to "loop produced unusable output → fallback chain absorbs." The route's try/catch is the outermost guarantee — even a config throw becomes an `error` event, not a dropped stream.

```
  Structure pass — error recovery

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  route handler (try/catch/finally)             │
  │  per-agent fallback chain (?? ?? FALLBACK)     │
  │  agent loop (forceFinal caps runaway)          │
  │  provider/MCP wrappers (429 retry, etc.)       │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  failure: where does each failure originate    │
  │  and where does it get contained?              │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  within fallback chain: cosmetic               │
  │  agent loop↔per-agent: LOAD-BEARING            │
  │    loop-terminated → output unusable           │
  │    fallback chain absorbs                      │
  │  per-agent↔route: LOAD-BEARING                 │
  │    fallback returned → route guarantees event  │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Error recovery here is a `try/catch` cascade with a guaranteed safe default at the bottom — the same shape as `data ?? cachedData ?? emptyState` in a component, extended to an agent. Each `??` is a recovery tier: try the primary, fall to the secondary, and if all else fails return a value that is *valid* (a non-crashing empty or fallback) rather than an exception. The budget is the loop's `for (i < max)` bound — the structural guarantee that the loop terminates no matter what the model does.

```
the recovery cascade (per agent)
─────────────────────────────────────────────────────────────
 runAgentLoop (bounded by budget) ──→ finalText
        │
   tryParse(finalText)        ← tier 1: loop's forced-final JSON
        ?? synthesize(...)    ← tier 2: clean-context retry call
        ?? FALLBACK / []      ← tier 3: safe default (never throws)
─────────────────────────────────────────────────────────────
 underneath, the MCP client recovers transport failures:
   429 → backoff retry  ·  error → not cached  ·  parse fail → []
 around it, the route wraps setup, the client auto-reconnects on
   a revoked alpha token (reset + reload, once).
```

The layers are independent. The agent-level cascade handles "the model did not produce valid output." The transport-level recovery handles "the backend call failed." The route's pre-stream try/catch handles "setup threw before any event streamed." The client's auto-reconnect handles "the alpha server revoked the token mid-session." A run survives a rate-limit (transport retry) *and* a prose-instead-of-JSON response (agent fallback) on the same investigation.

---

### Loop protection — the budget IS the cap

The most dangerous agent failure is non-termination: a model that keeps emitting `tool_use` blocks forever. The shared agent loop makes this structurally impossible with two bounds. The `for (turn=0; turn<maxTurns; turn++)` loop is the outer cap (`maxTurns = 8`). The `maxToolCalls` budget is the inner cap: `budgetSpent` is true once `toolCalls.length >= maxToolCalls`, and `forceFinal` is true on the last turn *or* when the budget is spent.

```
the bound, in the agent loop
─────────────────────────────────────────────────────────────
 for turn in 0..maxTurns:
     budgetSpent = (count(toolCalls) >= maxToolCalls)
     forceFinal  = (turn == maxTurns - 1) or budgetSpent
     if not forceFinal:
         params.tools = toolSchemas             ← tools WITHHELD on final
```

On a `forceFinal` turn, `params.tools` is not set. With no tools in the request, the model *cannot* emit a `tool_use` block — it must produce text. This is loop protection by construction: the loop does not "ask nicely" for the model to stop; it removes the model's ability to continue. The per-agent budgets are tuned to the job: diagnostic `maxToolCalls: 6`, recommendation `4`, monitoring `6`, query `6`. The budget bounds latency (each tool call is ~1.1s under the MCP spacing limit) *and* protects against runaway loops — one mechanism, two guarantees. That is the line: the budget IS the loop protection.

```
diagnostic timeline (maxTurns:8, maxToolCalls:6)
─────────────────────────────────────────────────────────────
 turn 0: 0 calls  forceFinal=false  tools sent  → 2 calls
 turn 1: 2 calls  forceFinal=false  tools sent  → 2 calls
 turn 2: 4 calls  forceFinal=false  tools sent  → 2 calls
 turn 3: 6 calls  budgetSpent=TRUE  forceFinal=TRUE  NO tools → must emit text
```

---

### Recovery tier 1→2 — synthesize() rescues unparseable output

When the forced-final turn produces prose, partial JSON, or a hybrid, the parse-and-validate step returns `null` (the JSON parser throws, the wrapper catches, returns `null`). The recovery is a dedicated, tool-less `synthesize()` call: a fresh model call with `max_tokens: 2048`, no tool definitions, no loop history — just the gathered tool-call results formatted as evidence text and an instruction to emit ONLY the JSON.

```
tier 1 → tier 2 (in the diagnostic agent)
─────────────────────────────────────────────────────────────
 diag = try_parse_diagnosis(finalText)             ← tier 1 (loop's JSON)
        OR (await synthesize(anomaly, toolCalls))  ← tier 2 (clean retry)
        OR FALLBACK                                 ← tier 3 (safe default)

 synthesize: create({
     max_tokens: 2048, (no tools),
     system: "Output ONLY a JSON diagnosis",
     user:   anomaly + evidence-from-toolCalls,
 })
   → try_parse_diagnosis(text)
   catch → return null                              ← never throws
```

The reason a *separate* call works where the loop's final turn failed: the loop's message history contains tool_use / tool_result scaffolding and partial reasoning that keeps the model in "exploration mode." `synthesize()` gives it a clean slate — only evidence and a schema — which breaks that mode. The recommendation agent has the identical structure. The whole `synthesize()` body is wrapped in `try/catch` returning `null`, so even if the retry call itself errors, it degrades to the next tier rather than throwing.

---

### Recovery tier 3 — the safe default

The bottom of every cascade is a value that is valid and never throws. For diagnostic it is `FALLBACK`: a `Diagnosis` with `conclusion: 'Insufficient data to determine a cause for this change.'` and empty `evidence`/`hypothesesConsidered`. For recommendation it is `[]`. For monitoring it is `[]` on any parse failure.

```
the safe defaults
─────────────────────────────────────────────────────────────
 diagnostic:     FALLBACK   { conclusion:'Insufficient data…', evidence:[] }
 recommendation: []         (if (!idless) return [])
 monitoring:     []         (catch → return [])
```

These guarantee the route always emits a valid `diagnosis` event and zero-or-more `recommendation` events — the stream never breaks, the UI never hangs on a malformed payload. A `FALLBACK` diagnosis flows into `propose`, which safely returns `[]`; the user sees "Insufficient data" rather than a crash. The safe default is the contract: an agent returns a typed value or a typed empty, never an exception that escapes to the route.

---

### Monitoring's graceful degrade

The monitoring agent's `scan` does not use the `synthesize`/`FALLBACK` chain — it degrades directly. After the loop, it tries `parse_agent_json(finalText)` inside a `try/catch`; on a throw it returns `[]`, and if the parsed value fails the anomaly-array guard it also returns `[]`.

```
the monitoring graceful degrade
─────────────────────────────────────────────────────────────
 try:
     parsed = parse_agent_json(finalText)
 catch:
     return []                              ← no anomalies, not a failure
 if not is_anomaly_array(parsed):
     return []
 return sorted(parsed, ...).slice(0, 10)
```

The framing matters: an unparseable monitoring output is treated as "nothing meaningful to report," not as an error. A briefing with no anomalies is a valid briefing. This is the right degrade for a scan whose normal result on a quiet day is genuinely empty — failing the whole briefing because one scan returned prose would be over-strict.

---

### Transport-level recovery — retry and no-cache-on-error

Underneath the agents, the MCP client wrapper's `callTool` recovers transport failures. A rate-limit response (an `isRateLimited` predicate: `isError` plus a regex match on `/rate limit|too many requests/i`) triggers a bounded retry loop: up to `maxRetries` (3) re-calls, each going back through the live-call path's spacing gate. The wait per retry is the *server-stated* window when one is parseable (`parseRetryAfterMs` + a small buffer), else **exponential backoff** off `retryDelayMs` (`retryDelayMs * 2 ** (retries - 1)`), and every wait is capped at `retryCeilingMs`. And any error result is *never cached*: caching a 429 for 60s would make the next minute of calls return the cached failure without retrying. Errors must stay live-retryable.

```
  while is_rate_limited(result) and retries < maxRetries:
      hintMs    = parse_retry_after_ms(result)            ← server-stated window
      backoffMs = retryDelayMs * 2 ** (retries - 1)        ← exponential
      waitMs    = min(hintMs ?? backoffMs, retryCeilingMs) ← capped
      await sleep(waitMs)
      result    = live_call()
  if result.isError == true:
      return { result, ... }                                ← do NOT cache
  cache.set(key, { result, expiresAt })
```

The defaults are tuned to the alpha backend's observed ~10s penalty window: `retryDelayMs = 10_000`, `retryCeilingMs = 20_000`, `maxRetries = 3` (the same numbers set explicitly at construction alongside `minIntervalMs: 1100`). There IS exponential backoff now (with the parsed-hint preference); what is still honestly absent is a *circuit breaker* — under a sustained outage every call still pays its full retry budget. The bounded backoff-with-hint retry is the deliberate, sufficient choice for a single-process, ~1 req/s constraint (see the system-design caching/rate-limiting file).

---

### Route-level recovery — pre-stream setup is wrapped

Before the `ReadableStream` can emit a single event the route must establish a session and connect to MCP — and either can throw (e.g. a missing `AUTH_SECRET` breaking cookie encryption in production). That setup is wrapped in its own `try/catch` so the failure returns the *real* message as JSON instead of a bare framework 500.

```
the pre-stream setup guard
─────────────────────────────────────────────────────────────
 try:
     sid  = await get_or_create_session_id()
     conn = await connect_mcp(sid)
 catch e:
     return json_response({ error: "/api/agent setup · " + msg }, 500)
 if not conn.ok:
     return json_response({ needsAuth, authUrl }, 401)    ← auth, not error
```

This is distinct from the in-stream `try/catch` that turns a mid-run throw into an `{ type: 'error', message }` event. Two guards, two phases: setup failures become an HTTP error body (the stream never opened); in-flight failures become a streamed `error` event the client renders inline.

---

### Client-level recovery — auto-reconnect on a revoked alpha token

The alpha MCP server revokes tokens after a few minutes and its own 401 instructs the client to re-register. The feed page does this automatically: when a streamed `error` event's message matches `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`, it `POST`s `/api/mcp/reset` to clear the revoked token and reloads — **once**, guarded by a `bi:reconnecting` sessionStorage flag so a freshly-revoked token cannot loop. On the investigate path, the investigation hook handles the related `401 { needsAuth, authUrl }` setup response by redirecting to the auth URL; the one-time silent reconnect itself lives only on the feed.

```
  if AUTH_RE.test(msg):
      alreadyTried = (sessionStorage["bi:reconnecting"] == "1")
      if not alreadyTried:
          sessionStorage["bi:reconnecting"] = "1"           ← guard
          fetch("/api/mcp/reset", POST).finally(reload)     ← clear + reload
      else:
          clear the flag and surface the error
```

---

### The principle

**Name every failure mode and give each a recovery whose worst case is a valid value, not an exception.** The agent cascade and the transport recovery are the same idea at two layers: try the primary, fall through bounded tiers, and bottom out at something safe. The budget unifies the loop's two needs — terminate, and protect against runaway — into one mechanism. The test of a production agent is not "does it work when the model behaves" but "what does each misbehavior return" — and here the answer is always a typed value the route can stream, never a thrown error that breaks the run.

---

---

### Code in this codebase

**Case A — implemented.**

#### Loop protection (budget = cap)

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` — `forceFinal` logic
- **Line range:** L85 (turn loop), L90 (`budgetSpent`), L91 (`forceFinal`), L101 (tools withheld on final); `maxTurns = 8` at L73
- **Role:** Structurally terminates the loop — withholding tools on the forced-final turn makes a further `tool_use` impossible.

#### Per-agent budgets

- **File:** `lib/agents/diagnostic.ts` L62 (`maxToolCalls: 6`) · `recommendation.ts` L57 (`4`) · `monitoring.ts` L84 (`6`) · `query.ts` L41 (`6`)
- **Role:** The tuned caps; bound latency under the ~1.1s MCP spacing and protect against runaway loops.

#### Output cascade (tier 1→2→3)

- **File:** `lib/agents/diagnostic.ts` (and `recommendation.ts`)
- **Function / class:** `investigate` cascade + `synthesize`; `FALLBACK`
- **Line range:** cascade L74–L75; `synthesize` L87–L126 (`create` L97, `max_tokens: 2048`, `try/catch → null` L123); `FALLBACK` L16–L20. Recommendation: cascade L69–L73 (`[]` at L73), `synthesize` L82–L133.
- **Role:** Three recovery tiers ending in a safe default that never throws.

#### Monitoring graceful degrade

- **File:** `lib/agents/monitoring.ts`
- **Function / class:** `MonitoringAgent.scan`
- **Line range:** L95–L102 (parse `try/catch → []` at L98–99; `isAnomalyArray` guard → `[]` at L101)
- **Role:** Treats an unparseable scan as "no anomalies," not as a failure.

#### Transport recovery

- **File:** `lib/mcp/client.ts`
- **Function / class:** `callTool` + `isRateLimited` + `parseRetryAfterMs`
- **Line range:** `isRateLimited` L18–L22; backoff retry L122–L132 (`maxRetries` 3, `retryDelayMs` 10_000, `retryCeilingMs` 20_000 — defaults L89/L93–94; parsed-hint preference via `parseRetryAfterMs` L31–38); no-cache-on-error L137–L139; construction `minIntervalMs: 1100` in `connect.ts` L92
- **Role:** Retries rate-limits with exponential backoff (preferring the server-stated window) within the spacing gate; never caches error results.

#### Route pre-stream setup guard

- **File:** `app/api/agent/route.ts`
- **Function / class:** `GET` — `getOrCreateSessionId` + `connectMcp` wrapper
- **Line range:** L155–L165 (`try/catch` → real error JSON); the in-stream throw → `error` event at L255–L260
- **Role:** A setup throw returns the real message as a 500 body instead of a bare framework 500; a mid-run throw becomes a streamed `{ type:'error' }` event.

#### Client auto-reconnect (revoked alpha token)

- **File:** `app/page.tsx` (feed) + `lib/hooks/useInvestigation.ts`
- **Function / class:** streamed-`error` handler (feed) + `useInvestigation` 401 handler
- **Line range:** `app/page.tsx` L386–L410 (match → `/api/mcp/reset` + reload once, guarded by `bi:reconnecting` L389/L395); `useInvestigation.ts` L171–L177 (401 `needsAuth` → redirect)
- **Role:** Recovers the alpha server's minutes-long token revocation without surfacing an error, exactly once.

**Pseudocode — the full recovery cascade** (`base.ts` + `diagnostic.ts` + `client.ts`):

```typescript
// LOOP PROTECTION (base.ts) — budget IS the cap
for (let turn = 0; turn < maxTurns; turn++) {           // L85
  const forceFinal = turn === maxTurns - 1 ||
    (maxToolCalls !== undefined && toolCalls.length >= maxToolCalls);  // L90-91
  if (!forceFinal) params.tools = toolSchemas;          // L101 — withheld on final
}

// OUTPUT CASCADE (diagnostic.ts) — three safe tiers
const diag = tryParseDiagnosis(finalText)               // L75 tier 1
    ?? (await this.synthesize(anomaly, toolCalls))      // L75 tier 2 (try/catch → null)
    ?? FALLBACK;                                         // L75 tier 3 (never throws)

// TRANSPORT (client.ts) — exponential backoff + no-poison
while (isRateLimited(result) && retries < maxRetries) { // L122
  retries++;
  const hintMs   = parseRetryAfterMs(result);           // L124 — server-stated window
  const backoffMs = retryDelayMs * 2 ** (retries - 1);  // L125 — exponential
  const waitMs   = Math.min(hintMs ?? backoffMs, retryCeilingMs);  // L126 — capped
  await sleep(waitMs); result = await this.liveCall(name, args);   // L130-131
}
if (result.isError) return { result, durationMs, fromCache: false };  // L137 — not cached
```

---

## Error recovery — diagram

The diagram spans four layers. The Client layer auto-reconnects on a revoked token. The Route layer wraps setup and turns safe defaults into guaranteed events. The Agent layer holds the three-tier output cascade and the budget that bounds the loop. The Provider boundary holds the transport recovery (backoff retry, no-cache-on-error). Every arrow that fails falls to a recovery, never to a crash.

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER   app/page.tsx (feed) · useInvestigation                │
│   streamed error matches invalid_token → /api/mcp/reset + reload ONCE │
│   (guarded by bi:reconnecting)   ·  401 needsAuth → redirect authUrl  │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts                                 │
│   pre-stream: try { session + connectMcp } catch → real error JSON     │
│   in-stream:  emits diagnosis + 0..N recommendation + done            │
│   in-stream throw → { type:'error', message } event                   │
│   (guaranteed because agents return typed values, never throw)        │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│  AGENT LAYER   lib/agents/                                            │
│                                                                       │
│  BUDGET = loop protection:                         │
│    for turn<maxTurns; budgetSpent → forceFinal → tools WITHHELD       │
│    (model cannot emit tool_use → must produce text → loop ends)       │
│                                                                       │
│  OUTPUT CASCADE:                              │
│    tryParse(finalText)         ── valid? ──→ return  (tier 1)         │
│         │ null                                                        │
│         ▼                                                             │
│    synthesize(toolCalls)       ── valid? ──→ return  (tier 2, clean)  │
│         │ null                                                        │
│         ▼                                                             │
│    FALLBACK / []               ─────────────→ return  (tier 3, safe)  │
│                                                                       │
│  monitoring: parse fail → return []      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ mcp.callTool (may fail)
┌───────────────────────────────▼───────────────────────────────────────┐
│  PROVIDER BOUNDARY   lib/mcp/client.ts                                │
│   isRateLimited? → backoff retry (maxRetries 3, hint||2^n, ≤20s)      │
│   isError? → return WITHOUT caching (no poison)                       │
│   (exponential backoff present; NO circuit breaker — honest gap)     │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: the client reconnects once on a revoked token, the route wraps setup and always streams a valid value, the budget bounds the loop, the output cascade falls through three safe tiers, and the transport backs off and never caches errors.

---

## Elaborate

### Where this pattern comes from

Graceful degradation and bounded retry are foundational resilience patterns — codified in Nygard's *Release It!* (the Stability Patterns: Timeout, Circuit Breaker, Bulkhead, Fail Fast) and in every cloud SDK's retry policy. The agent-specific addition is the **forced-final turn**: the original ReAct paper assumes the model stops cleanly, but production models often want to keep querying, so the budget-plus-synthesis pass is the engineering patch. Anthropic's "Building effective agents" makes the same point — agents need explicit stopping conditions and guardrails, because the model will not reliably impose them itself.

### The deeper principle

The recovery hierarchy mirrors the failure hierarchy: structural failures (non-termination) get structural fixes (remove the model's ability to continue), probabilistic failures (prose instead of JSON) get probabilistic retries (a clean-context call), and the irreducible failures (the retry also failed) get a typed safe default. You do not retry a structural problem and you do not structurally prevent a probabilistic one — match the recovery mechanism to the failure's nature. The budget being *both* the latency bound and the loop protection is an instance of a deeper truth: a good constraint often solves two problems, and recognizing when one mechanism covers two needs is how you keep a system small.

### Where this breaks down

The transport recovery still has an honest gap: there is no circuit breaker — if Bloomreach is hard-down, every call still pays its full retry budget (up to 3 waits, each up to `retryCeilingMs = 20_000`) before failing, with no fast-fail after repeated failures. (Exponential backoff with a parsed-hint preference *is* now implemented, capped at the ceiling — there is no jitter, so simultaneous wakers can still align.) And the agent cascade's `FALLBACK` is *too* graceful in one case: a `FALLBACK` diagnosis produced because every tool call failed looks identical to one produced because the data was genuinely inconclusive — the route emits "Insufficient data" either way, hiding a transport outage behind a benign-looking result. The `diagnostic.ts` confidence-downgrade (a `'high'` is dropped to `'medium'` when any query errored, L80–82) softens this for the *surfaced confidence* but does not distinguish the all-errors case from inconclusive data in the conclusion text.

### What to explore next

- **Circuit breaker** (`cockatiel`, `opossum`) — fast-fail after N consecutive failures instead of paying the full retry budget every time; the named absent pattern.
- **Backoff jitter** — the backoff is exponential and capped (`client.ts` L125–129) but has no jitter, so callers that hit the limit together still wake together; adding randomization avoids the thundering herd.
- **Distinguishing fallback causes** — tagging a `FALLBACK` with *why* (all-tools-failed vs inconclusive-data) so an outage is not mistaken for a benign empty result; the `diagnosisConfidence` downgrade (`diagnostic.ts` L80–82) is a partial step; cross-link to observability (../05-evals-and-observability/).

---

## Project exercises

### Tag FALLBACK diagnoses with their cause

- **Exercise ID:** C4.7 (adapted to blooming insights)
- **What to build:** Distinguish a `FALLBACK` caused by *all tool calls failing* from one caused by *genuinely inconclusive data*. `investigate` already inspects `toolCalls` for `tc.error` to downgrade confidence (L80–82) — extend that: if *every* entry has `tc.error`, emit a distinct `FALLBACK` (or an `error` reasoning step) so a Bloomreach outage is observable instead of masked as "Insufficient data."
- **Why it earns its place:** Demonstrates you can prevent a recovery mechanism from hiding a real failure — the subtle production bug in over-graceful degradation.
- **Files to touch:** `lib/agents/diagnostic.ts` (L74–L82, `FALLBACK` L16–L20); `app/api/agent/route.ts` (`hooksFor` / emit, L181–L195).
- **Done when:** An investigation where every tool call errors emits a distinguishable signal, and a genuinely inconclusive run still emits the standard `FALLBACK`.
- **Estimated effort:** 1–4hr

### Add a circuit breaker to McpClient

- **Exercise ID:** C5.5 (adapted to blooming insights)
- **What to build:** Wrap `liveCall` with a simple circuit breaker: after N consecutive `isError` results, open the circuit and fast-fail subsequent calls for a cooldown window instead of paying the full bounded-retry budget each time; half-open after the cooldown to test recovery.
- **Why it earns its place:** Implements the named-absent resilience pattern; the interview-grade signal that you know retry alone is insufficient under sustained outage.
- **Files to touch:** `lib/mcp/client.ts` (`callTool` L97–L146, `liveCall` L148–L163, add breaker state); `test/mcp/client.test.ts` (open/half-open/closed transitions).
- **Done when:** After N consecutive errors the next call fast-fails without hitting the transport, and a success after the cooldown closes the circuit — proven by unit tests with a fake transport.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How does your agent handle failure?" tests whether you have actually enumerated the failure modes or just hope the model behaves. The strong answer names each mode and its specific recovery, and recognizes that the budget does double duty (terminate + protect). The senior signal is naming the *gaps* — over-graceful `FALLBACK`, no circuit breaker — before the interviewer finds them.

### Likely questions

**[mid] "What stops the agent loop from running forever?"**

The budget. `forceFinal` (`base.ts` L91) is true on the last turn or once `toolCalls.length >= maxToolCalls`. On a `forceFinal` turn, `params.tools` is not set (L101), so the model has no tools to call and must emit text — `toolUses.length === 0` (L121) is then always true and the loop returns. It is not a polite request; it is the removal of the model's ability to continue.

```
budget spent → forceFinal=true → tools withheld (L101) → model can't emit tool_use
            → toolUses.length===0 (L121) → return  ← loop guaranteed to end
```

**[senior] "The loop's final turn returns prose instead of JSON. Walk me through the recovery."**

`tryParseDiagnosis(finalText)` calls `parseAgentJson`, which throws on non-JSON; the `try/catch` returns `null` (`diagnostic.ts` L22–L29). The `?? synthesize(anomaly, toolCalls)` (L75) fires a fresh tool-less call (`create` at L97) with the gathered evidence and a JSON-only instruction — clean context breaks the model's exploration momentum. If that also fails, `synthesize`'s own `try/catch` returns `null` (L123), and `?? FALLBACK` (L75) supplies a valid empty diagnosis. The route always gets a `Diagnosis`, never an exception.

```
finalText prose → tryParse=null → synthesize (clean retry) → valid? return
                                       │null
                                       ▼
                                  FALLBACK (safe, never throws)
```

**[arch] "Your retry handles a 429. What happens if Bloomreach is hard-down for a minute?"**

It degrades poorly, and I would name that. The retry itself is sound — exponential backoff that prefers the server's stated window, capped at `retryCeilingMs = 20_000` (`client.ts` L122–129) — but there is no fast-fail: every call still pays its full retry budget (up to 3 waits) before surfacing the error, because there is no circuit breaker (the breaker is honestly absent). Worse, if every tool call errors, the diagnosis falls to `FALLBACK`, which renders as "Insufficient data" — indistinguishable from a genuinely inconclusive investigation, so the outage is masked (the confidence-downgrade at L80–82 only dims the badge, not the conclusion). The fixes are a circuit breaker (fast-fail after N failures) and tagging the `FALLBACK` with its cause.

```
Bloomreach down: each call → up to 3 backoff retries (≤20s) → error → FALLBACK
                 looks like "inconclusive data" → outage hidden
fix: circuit breaker (fast-fail) + cause-tagged FALLBACK
```

### The question candidates always dodge

**"Is your error handling ever too graceful?"**

Yes — and this is the one candidates avoid because graceful sounds good. The `FALLBACK` diagnosis is emitted both when the data was genuinely inconclusive *and* when every single tool call failed due to an outage. The user sees the same "Insufficient data to determine a cause" message in both cases, so a transport outage is silently dressed up as a benign result. Graceful degradation that erases the distinction between "nothing to report" and "everything broke" is a monitoring blind spot. The honest fix is to make the failure observable — tag the fallback's cause — which is the first exercise above.

### One-line anchors

- `lib/agents/base.ts` L91 / L101 — `forceFinal` withholds tools — the budget IS the loop protection.
- `lib/agents/diagnostic.ts` L74–L75 — `tryParse ?? synthesize ?? FALLBACK` — the three-tier cascade.
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize` — clean-context retry, `try/catch → null`.
- `lib/agents/monitoring.ts` L98–L99 — parse fail → `[]` — graceful degrade.
- `lib/mcp/client.ts` L122–L139 — exponential-backoff rate-limit retry + no-cache-on-error.
- `app/api/agent/route.ts` L156–L165 — pre-stream setup `try/catch` → real error JSON.
- `app/page.tsx` L386–L410 — one-time auto-reconnect on a revoked alpha token.

---

## See also

→ 01-agents-vs-chains.md · → 02-tool-calling.md · → 03-react-pattern.md · → 04-tool-routing.md · → ../../study-system-design/04-caching-and-rate-limiting.md · → ../../study-system-design/06-multi-agent-orchestration.md

---
