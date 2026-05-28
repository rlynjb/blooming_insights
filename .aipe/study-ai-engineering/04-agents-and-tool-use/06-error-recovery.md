# Error recovery

**Industry name(s):** graceful degradation, bounded retry, fallback chains, loop protection / budget caps
**Type:** Industry standard · Language-agnostic

> Every agent failure mode in blooming insights has a coded recovery: the forced-final tool-less turn caps the loop, a dedicated `synthesize()` rescues a loop that yields no valid JSON, `FALLBACK` is the last-resort diagnosis, the MCP client retries rate-limits and never caches errors, and monitoring returns `[]` on any parse failure. The budget IS the loop protection.

**See also:** → 01-agents-vs-chains.md · → 02-tool-calling.md · → 03-react-pattern.md · → 04-tool-routing.md · → ../../study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md · → ../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md

---

## Why care

You have written a data-fetching component that handles every branch: loading, success, empty, and error — and within error, you distinguish "retry might help" (a 429 or a network blip) from "retry will not help" (a 404). You wrapped the fetch in a bounded retry, you rendered a safe empty state instead of crashing the tree, and you made sure a transient failure did not get cached so the next render could try again. That discipline — name every failure, give each one a recovery, never let one failure cascade — is exactly what an agent loop needs, except the failures are stranger: a model that will not stop querying, a model that returns prose where JSON was required, a backend that rate-limits mid-run.

The question this file answers: what are the ways an agent run fails, and what coded recovery does each one have?

**Answering it matters because an agent has more failure modes than a fetch, and any one of them, unhandled, breaks the whole run.** A model with no turn cap runs until the 60-second route timeout kills the stream mid-flight — the user gets a truncated trace and no result. A model that emits reasoning prose instead of JSON makes `JSON.parse` throw, and a thrown parse error in the wrong place takes down the investigation. A rate-limit error cached for 60 seconds poisons every subsequent call. The difference between a demo and a product is whether each of these has a recovery wired in *before* it happens. blooming insights maps each failure to a specific recovery, and the unifying mechanism is the budget — the thing that bounds the loop is the same thing that protects it.

```
Failure mode                            Recovery (this codebase)
────────────────────────────────       ──────────────────────────────────
model never stops querying              forceFinal turn (no tools) caps the loop
loop returns prose, not JSON            synthesize() — clean-context retry
synthesize() also fails                 FALLBACK diagnosis / [] recommendations
backend rate-limits (429)               bounded retry in McpClient
error result cached → poison            no-cache-on-error guard
monitoring output unparseable           return [] (graceful degrade)
```

One-line summary: **every failure has a named recovery, fallbacks are layered three deep, and the per-agent budget is the loop protection.**

---

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
   429 → bounded retry  ·  error → not cached  ·  parse fail → []
```

The two layers are independent. The agent-level cascade handles "the model did not produce valid output." The transport-level recovery handles "the backend call failed." A run survives a rate-limit (transport retry) *and* a prose-instead-of-JSON response (agent fallback) on the same investigation.

---

### Loop protection — the budget IS the cap

The most dangerous agent failure is non-termination: a model that keeps emitting `tool_use` blocks forever. `runAgentLoop` makes this structurally impossible with two bounds. The `for (turn=0; turn<maxTurns; turn++)` loop (`base.ts` L85) is the outer cap (`maxTurns = 8`, L73). The `maxToolCalls` budget is the inner cap: `budgetSpent` is true once `toolCalls.length >= maxToolCalls` (L90), and `forceFinal` is true on the last turn *or* when the budget is spent (L91).

```
base.ts — the bound   (L85–L101)
─────────────────────────────────────────────────────────────
 for (turn=0; turn<maxTurns; turn++)                       L85
   budgetSpent = toolCalls.length >= maxToolCalls          L90
   forceFinal  = turn === maxTurns-1 || budgetSpent        L91
   if (!forceFinal) params.tools = toolSchemas             L101  ← tools WITHHELD on final
```

On a `forceFinal` turn, `params.tools` is not set (L101). With no tools in the request, the model *cannot* emit a `tool_use` block — it must produce text. This is loop protection by construction: the loop does not "ask nicely" for the model to stop; it removes the model's ability to continue. The per-agent budgets are tuned to the job: diagnostic `maxToolCalls: 6` (`diagnostic.ts` L61), recommendation `4` (`recommendation.ts` L57), monitoring `6` (`monitoring.ts` L74), query `6` (`query.ts` L41). The budget bounds latency (each tool call is ~1.1s under the MCP spacing limit) *and* protects against runaway loops — one mechanism, two guarantees. That is the line: the budget IS the loop protection.

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

When the forced-final turn produces prose, partial JSON, or a hybrid, `tryParseDiagnosis(finalText)` returns `null` (`diagnostic.ts` L21–L28 — `parseAgentJson` throws, caught, returns `null`). The recovery is a dedicated, tool-less `synthesize()` call (`diagnostic.ts` L82–L121): a fresh `anthropic.messages.create` (L92) with `max_tokens: 2048`, no tool definitions, no loop history — just the gathered `toolCalls` formatted as evidence text and an instruction to emit ONLY the JSON.

```
diagnostic.ts — tier 1 → tier 2   (L73–L77, L82–L121)
─────────────────────────────────────────────────────────────
 return tryParseDiagnosis(finalText)              L74  ← tier 1 (loop's JSON)
   ?? (await this.synthesize(anomaly, toolCalls)) L75  ← tier 2 (clean retry)
   ?? FALLBACK                                     L76  ← tier 3 (safe default)

 synthesize: create({ max_tokens: 2048, no tools,  L92
   system: "Output ONLY a JSON diagnosis", 
   user: anomaly + evidence-from-toolCalls })      L97–110
   → tryParseDiagnosis(text)                        L117
   catch → return null                              L118  ← never throws
```

The reason a *separate* call works where the loop's final turn failed: the loop's message history contains tool_use/tool_result scaffolding and partial reasoning that keeps the model in "exploration mode." `synthesize()` gives it a clean slate — only evidence and a schema — which breaks that mode. `recommendation.ts` L82–L127 has the identical structure (`create` at L96, `max_tokens: 2048`). The whole `synthesize()` body is wrapped in `try/catch` returning `null` (L118), so even if the retry call itself errors, it degrades to the next tier rather than throwing.

---

### Recovery tier 3 — the safe default

The bottom of every cascade is a value that is valid and never throws. For diagnostic it is `FALLBACK` (`diagnostic.ts` L15–L19): a `Diagnosis` with `conclusion: 'Insufficient data to determine a cause for this change.'` and empty `evidence`/`hypothesesConsidered`. For recommendation it is `[]` (`recommendation.ts` L73 — `if (!idless) return []`). For monitoring it is `[]` on any parse failure.

```
the safe defaults
─────────────────────────────────────────────────────────────
 diagnostic:     FALLBACK   { conclusion:'Insufficient data…', evidence:[] }  L15–19
 recommendation: []          (if (!idless) return [])                          L73
 monitoring:     []          (catch → return [])                              L88–89
```

These guarantee the route always emits a valid `diagnosis` event and zero-or-more `recommendation` events — the stream never breaks, the UI never hangs on a malformed payload. A `FALLBACK` diagnosis flows into `propose`, which safely returns `[]`; the user sees "Insufficient data" rather than a crash. The safe default is the contract: an agent returns a typed value or a typed empty, never an exception that escapes to the route.

---

### Monitoring's graceful degrade

`MonitoringAgent.scan` (`monitoring.ts` L60–L93) does not use the `synthesize`/`FALLBACK` chain — it degrades directly. After the loop, it tries `parseAgentJson(finalText)` inside a `try/catch`; on a throw it returns `[]` (L86–L89), and if the parsed value fails `isAnomalyArray` it also returns `[]` (L91).

```
monitoring.ts — graceful degrade   (L85–L92)
─────────────────────────────────────────────────────────────
 try { parsed = parseAgentJson(finalText) }
 catch { return [] }                              L88–89  ← no anomalies, not a failure
 if (!isAnomalyArray(parsed)) return []           L91
 return [...parsed].sort(...).slice(0, 10)        L92
```

The framing matters: an unparseable monitoring output is treated as "nothing meaningful to report," not as an error. A briefing with no anomalies is a valid briefing. This is the right degrade for a scan whose normal result on a quiet day is genuinely empty — failing the whole briefing because one scan returned prose would be over-strict.

---

### Transport-level recovery — retry and no-cache-on-error

Underneath the agents, `McpClient.callTool` (`client.ts` L30–L67) recovers transport failures. A rate-limit response (`isRateLimited`, L7–L11: `isError` + matches `/rate limit|too many requests/i`) triggers a bounded retry loop (L49–L53): up to `maxRetries` (3) re-calls with `retryDelayMs` (1200ms) sleeps, each going back through `liveCall`'s spacing gate. And any error result is *never cached* (L57–L60): caching a 429 for 60s would make the next minute of calls return the cached failure without retrying. Errors must stay live-retryable.

```
client.ts — transport recovery   (L49–L60)
─────────────────────────────────────────────────────────────
 while (isRateLimited(result) && retries < maxRetries)   L49
   retries++; sleep(retryDelayMs); result = liveCall()    L51–52
 if (result.isError === true) return { result, ... }      L58  ← do NOT cache
 cache.set(key, { result, expiresAt })                    L65
```

There is no exponential backoff and no circuit breaker — the `connect.ts` comment (L54) names backoff as a "Phase 2 hardening follow-up," and a circuit breaker is honestly absent. The fixed-delay bounded retry is the deliberate, sufficient choice for a single-process, ~1 req/s constraint (see the system-design caching/rate-limiting file).

---

### The principle

**Name every failure mode and give each a recovery whose worst case is a valid value, not an exception.** The agent cascade and the transport recovery are the same idea at two layers: try the primary, fall through bounded tiers, and bottom out at something safe. The budget unifies the loop's two needs — terminate, and protect against runaway — into one mechanism. The test of a production agent is not "does it work when the model behaves" but "what does each misbehavior return" — and here the answer is always a typed value the route can stream, never a thrown error that breaks the run.

---

## Error recovery — diagram

The diagram spans three layers. The Agent layer holds the three-tier output cascade and the budget that bounds the loop. The Provider boundary holds the transport recovery (retry, no-cache-on-error). The Route layer is where the safe defaults become guaranteed events. Every arrow that fails falls to a recovery, never to a crash.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts                                 │
│   always emits: diagnosis event + 0..N recommendation events + done   │
│   (guaranteed because agents return typed values, never throw)        │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│  AGENT LAYER   lib/agents/                                            │
│                                                                       │
│  BUDGET = loop protection (base.ts L85–101):                         │
│    for turn<maxTurns; budgetSpent → forceFinal → tools WITHHELD       │
│    (model cannot emit tool_use → must produce text → loop ends)       │
│                                                                       │
│  OUTPUT CASCADE (diagnostic.ts L73–77):                              │
│    tryParse(finalText)         ── valid? ──→ return  (tier 1)         │
│         │ null                                                        │
│         ▼                                                             │
│    synthesize(toolCalls)       ── valid? ──→ return  (tier 2, clean)  │
│         │ null                                                        │
│         ▼                                                             │
│    FALLBACK / []               ─────────────→ return  (tier 3, safe)  │
│                                                                       │
│  monitoring: parse fail → return []  (graceful degrade, L88–89)      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ mcp.callTool (may fail)
┌───────────────────────────────▼───────────────────────────────────────┐
│  PROVIDER BOUNDARY   lib/mcp/client.ts                                │
│   isRateLimited? → bounded retry (maxRetries 3, 1200ms)   L49–53     │
│   isError? → return WITHOUT caching (no poison)            L57–60     │
│   (no exponential backoff, no circuit breaker — honest gaps)         │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: the budget bounds the loop, the output cascade falls through three safe tiers, the transport retries and never caches errors, and the route always gets a valid value.

---

## In this codebase

**Case A — implemented.**

### Loop protection (budget = cap)

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` — `forceFinal` logic
- **Line range:** L85 (turn loop), L90 (`budgetSpent`), L91 (`forceFinal`), L101 (tools withheld on final); `maxTurns = 8` at L73
- **Role:** Structurally terminates the loop — withholding tools on the forced-final turn makes a further `tool_use` impossible.

### Per-agent budgets

- **File:** `lib/agents/diagnostic.ts` L61 (`maxToolCalls: 6`) · `recommendation.ts` L57 (`4`) · `monitoring.ts` L74 (`6`) · `query.ts` L41 (`6`)
- **Role:** The tuned caps; bound latency under the ~1.1s MCP spacing and protect against runaway loops.

### Output cascade (tier 1→2→3)

- **File:** `lib/agents/diagnostic.ts` (and `recommendation.ts`)
- **Function / class:** `investigate` cascade + `synthesize`; `FALLBACK`
- **Line range:** cascade L73–L77; `synthesize` L82–L121 (`create` L92, `max_tokens: 2048`, `try/catch → null` L118); `FALLBACK` L15–L19. Recommendation: cascade L69–L77 (`[]` at L73), `synthesize` L82–L127.
- **Role:** Three recovery tiers ending in a safe default that never throws.

### Monitoring graceful degrade

- **File:** `lib/agents/monitoring.ts`
- **Function / class:** `MonitoringAgent.scan`
- **Line range:** L85–L92 (parse `try/catch → []` at L88–89; `isAnomalyArray` guard → `[]` at L91)
- **Role:** Treats an unparseable scan as "no anomalies," not as a failure.

### Transport recovery

- **File:** `lib/mcp/client.ts`
- **Function / class:** `callTool` + `isRateLimited`
- **Line range:** `isRateLimited` L7–L11; bounded retry L49–L53 (`maxRetries` 3, `retryDelayMs` 1200, defaults L26–27); no-cache-on-error L57–L60; construction `minIntervalMs: 1100` in `connect.ts` L58
- **Role:** Retries rate-limits within the spacing gate; never caches error results.

**Pseudocode — the full recovery cascade** (`base.ts` + `diagnostic.ts` + `client.ts`):

```typescript
// LOOP PROTECTION (base.ts) — budget IS the cap
for (let turn = 0; turn < maxTurns; turn++) {           // L85
  const forceFinal = turn === maxTurns - 1 ||
    (maxToolCalls !== undefined && toolCalls.length >= maxToolCalls);  // L90-91
  if (!forceFinal) params.tools = toolSchemas;          // L101 — withheld on final
}

// OUTPUT CASCADE (diagnostic.ts) — three safe tiers
return tryParseDiagnosis(finalText)                     // L74 tier 1
    ?? (await this.synthesize(anomaly, toolCalls))      // L75 tier 2 (try/catch → null)
    ?? FALLBACK;                                         // L76 tier 3 (never throws)

// TRANSPORT (client.ts) — retry + no-poison
while (isRateLimited(result) && retries < maxRetries) { // L49
  retries++; await sleep(retryDelayMs); result = await this.liveCall(name, args);
}
if (result.isError) return { result, durationMs, fromCache: false };  // L58 — not cached
```

---

## Elaborate

### Where this pattern comes from

Graceful degradation and bounded retry are foundational resilience patterns — codified in Nygard's *Release It!* (the Stability Patterns: Timeout, Circuit Breaker, Bulkhead, Fail Fast) and in every cloud SDK's retry policy. The agent-specific addition is the **forced-final turn**: the original ReAct paper assumes the model stops cleanly, but production models often want to keep querying, so the budget-plus-synthesis pass is the engineering patch. Anthropic's "Building effective agents" makes the same point — agents need explicit stopping conditions and guardrails, because the model will not reliably impose them itself.

### The deeper principle

The recovery hierarchy mirrors the failure hierarchy: structural failures (non-termination) get structural fixes (remove the model's ability to continue), probabilistic failures (prose instead of JSON) get probabilistic retries (a clean-context call), and the irreducible failures (the retry also failed) get a typed safe default. You do not retry a structural problem and you do not structurally prevent a probabilistic one — match the recovery mechanism to the failure's nature. The budget being *both* the latency bound and the loop protection is an instance of a deeper truth: a good constraint often solves two problems, and recognizing when one mechanism covers two needs is how you keep a system small.

### Where this breaks down

The transport recovery has honest gaps. There is no exponential backoff — a fixed 1200ms delay means multiple callers waking simultaneously still burst (`connect.ts` L54 calls this a Phase 2 follow-up). There is no circuit breaker — if Bloomreach is hard-down, every call still pays the full retry budget (3 × 1200ms) before failing, with no fast-fail after repeated failures. And the agent cascade's `FALLBACK` is *too* graceful in one case: a `FALLBACK` diagnosis produced because every tool call failed looks identical to one produced because the data was genuinely inconclusive — the route emits "Insufficient data" either way, hiding a transport outage behind a benign-looking result.

### What to explore next

- **Circuit breaker** (`cockatiel`, `opossum`) — fast-fail after N consecutive failures instead of paying the full retry budget every time; the named absent pattern.
- **Exponential backoff with jitter** — replace the fixed `retryDelayMs` to avoid thundering-herd on simultaneous retries (the `connect.ts` Phase 2 note).
- **Distinguishing fallback causes** — tagging a `FALLBACK` with *why* (all-tools-failed vs inconclusive-data) so an outage is not mistaken for a benign empty result; cross-link to observability (../05-evals-and-observability/).

---

## Tradeoffs

### Comparison: layered fallbacks + fixed bounded retry vs alternatives

| Dimension | This codebase | No fallback (trust the loop's JSON) | Exponential backoff + circuit breaker |
|---|---|---|---|
| Unparseable output | 3-tier recovery → safe default | `tryParse` fails → run breaks | Same as this (orthogonal) |
| Non-termination | Budget withholds tools → forced stop | Runs to 60s route timeout | Same as this (orthogonal) |
| Rate-limit recovery | Bounded fixed-delay retry | None | Backoff + jitter, fast-fail |
| Backend hard-down | Pays full retry budget every call | Fails immediately | Circuit opens → fast-fail |
| Setup complexity | Low — `??` chains + a `while` loop | Lowest | Higher — breaker state + jitter |

**What we gave up.** Fast-fail under sustained outage. With no circuit breaker, every call to a hard-down Bloomreach pays the full bounded-retry budget (3 retries × 1200ms ≈ 3.6s wasted per call) before surfacing the error — and across a 6-call investigation that compounds toward the 60s route ceiling. We accept this because Bloomreach hard-down is rare relative to transient rate-limits, and the fixed bounded retry handles the common case (a single 429) cleanly; a circuit breaker is justified only once sustained outages become frequent enough to matter.

**What the alternative would have cost.** Trusting the loop's final-turn JSON (dropping `synthesize` and `FALLBACK`) would remove two API calls' worth of cost on the failure path — but any run where the forced-final turn emits prose would break: `tryParse` returns `null`, and with nothing below it the route would either throw or emit a malformed diagnosis. The fallback tiers cost one extra clean-context call *only* when the loop's JSON fails, and zero when it succeeds; that is cheap insurance against a stream-breaking failure.

**The breakpoint.** The current recovery is right while failures are transient and isolated (a stray 429, an occasional prose response). It stops being right when failures become correlated or sustained — a Bloomreach outage, a model regression that fails `tryParse` on most runs — at which point the fixed retry burns budget pointlessly and the indistinguishable `FALLBACK` masks the outage. Then add a circuit breaker (fast-fail after N failures) and tag fallbacks with their cause so an outage is observable rather than hidden.

---

## Tech reference (industry pairing)

### Forced-final turn (loop protection)

- **Codebase uses:** `forceFinal` withholds `params.tools` on the budget-spent / last turn (`base.ts` L91, L101).
- **Why it's here:** It is the only reliable way to make a model stop querying — remove its ability to call tools.
- **Leading today:** Hard iteration/tool-call budgets are the adoption-leading agent loop-protection in 2026.
- **Why it leads:** Every serious agent runtime (LangGraph, Anthropic Agent SDK) enforces a max-iterations cap; the default without one is run-to-limit.
- **Runner-up:** A "done" tool the model must call to terminate (passing the result as the tool argument) — guarantees valid JSON at the cost of one extra hop.

### Fallback chain (graceful degradation)

- **Codebase uses:** `tryParse ?? synthesize() ?? FALLBACK` (`diagnostic.ts` L73–L77); `?? []` for recommendation/monitoring.
- **Why it's here:** The route must always get a typed value to stream, never an exception.
- **Leading today:** Layered fallbacks with a safe default are the adoption-leading degradation pattern in 2026.
- **Why it leads:** Each tier handles a distinct failure; the bottom tier guarantees no crash reaches the user.
- **Runner-up:** Constrained decoding (Outlines, OpenAI structured outputs) — forces valid JSON at the token level, removing the need for the parse-fallback tiers (not available at this codebase's Anthropic vintage).

### Bounded retry (transport recovery)

- **Codebase uses:** `while (isRateLimited && retries < maxRetries)` with fixed `retryDelayMs` (`client.ts` L49–L53).
- **Why it's here:** A single 429 under the ~1 req/s limit is recoverable by waiting and re-calling.
- **Leading today:** `p-retry`-style bounded retry is adoption-leading; exponential backoff + jitter is the production standard.
- **Why it leads:** Bounds the retry count and gives the server time to recover.
- **Runner-up:** `cockatiel` / `opossum` — full resilience toolkits adding circuit breaker, timeout, and fallback (the absent breaker).

---

## Project exercises

### Tag FALLBACK diagnoses with their cause

- **Exercise ID:** C4.7 (adapted to blooming insights)
- **What to build:** Distinguish a `FALLBACK` caused by *all tool calls failing* from one caused by *genuinely inconclusive data*. Inspect the `toolCalls` array in `investigate` — if every entry has `tc.error`, emit a distinct `FALLBACK` (or an `error` reasoning step) so a Bloomreach outage is observable instead of masked as "Insufficient data."
- **Why it earns its place:** Demonstrates you can prevent a recovery mechanism from hiding a real failure — the subtle production bug in over-graceful degradation.
- **Files to touch:** `lib/agents/diagnostic.ts` (L73–L77, `FALLBACK` L15–L19); `app/api/agent/route.ts` (`hooksFor` / emit, L147–L154).
- **Done when:** An investigation where every tool call errors emits a distinguishable signal, and a genuinely inconclusive run still emits the standard `FALLBACK`.
- **Estimated effort:** 1–4hr

### Add a circuit breaker to McpClient

- **Exercise ID:** C5.5 (adapted to blooming insights)
- **What to build:** Wrap `liveCall` with a simple circuit breaker: after N consecutive `isError` results, open the circuit and fast-fail subsequent calls for a cooldown window instead of paying the full bounded-retry budget each time; half-open after the cooldown to test recovery.
- **Why it earns its place:** Implements the named-absent resilience pattern; the interview-grade signal that you know retry alone is insufficient under sustained outage.
- **Files to touch:** `lib/mcp/client.ts` (`callTool` L30–L67, `liveCall` L69–L77, add breaker state); `test/mcp/client.test.ts` (open/half-open/closed transitions).
- **Done when:** After N consecutive errors the next call fast-fails without hitting the transport, and a success after the cooldown closes the circuit — proven by unit tests with a fake transport.
- **Estimated effort:** 1–4hr

---

## Summary

Every agent failure in blooming insights has a coded recovery. Non-termination is prevented structurally: the `forceFinal` turn withholds tools (`base.ts` L91, L101) so the model must stop — the per-agent `maxToolCalls` budget is simultaneously the latency bound and the loop protection. Unparseable output falls through a three-tier cascade: the loop's forced-final JSON, then a clean-context `synthesize()` retry (`diagnostic.ts` L82–L121), then a safe `FALLBACK`/`[]` that never throws. Monitoring degrades an unparseable scan to `[]` (treating it as "no anomalies"). Underneath, `McpClient` retries rate-limits with a bounded fixed-delay loop and never caches error results (`client.ts` L49–L60). The honest gaps — no exponential backoff, no circuit breaker — are named, not hidden.

Key points:
- The budget IS the loop protection: `forceFinal` (`base.ts` L91) removes the model's ability to keep querying.
- The output cascade is three safe tiers — `tryParse ?? synthesize ?? FALLBACK` — bottoming out at a typed value, never an exception.
- `synthesize()` is a clean-context retry; a fresh single-turn call breaks the loop's "exploration momentum."
- Transport recovery: bounded rate-limit retry (3 × 1200ms) and never caching errors (no poison).
- Honest absences: no exponential backoff (Phase 2), no circuit breaker; and a `FALLBACK` from total failure looks identical to one from inconclusive data.

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

`tryParseDiagnosis(finalText)` calls `parseAgentJson`, which throws on non-JSON; the `try/catch` returns `null` (`diagnostic.ts` L21–L28). The `?? synthesize(anomaly, toolCalls)` (L75) fires a fresh tool-less call (`create` at L92) with the gathered evidence and a JSON-only instruction — clean context breaks the model's exploration momentum. If that also fails, `synthesize`'s own `try/catch` returns `null` (L118), and `?? FALLBACK` (L76) supplies a valid empty diagnosis. The route always gets a `Diagnosis`, never an exception.

```
finalText prose → tryParse=null → synthesize (clean retry) → valid? return
                                       │null
                                       ▼
                                  FALLBACK (safe, never throws)
```

**[arch] "Your retry handles a 429. What happens if Bloomreach is hard-down for a minute?"**

It degrades poorly, and I would name that. Every call pays the full bounded retry (3 × 1200ms ≈ 3.6s) before surfacing the error, with no fast-fail — there is no circuit breaker (`connect.ts` L54 marks backoff as Phase 2; the breaker is absent). Worse, if every tool call errors, the diagnosis falls to `FALLBACK`, which renders as "Insufficient data" — indistinguishable from a genuinely inconclusive investigation, so the outage is masked. The fixes are a circuit breaker (fast-fail after N failures) and tagging the `FALLBACK` with its cause.

```
Bloomreach down: each call → 3 retries × 1200ms → error → FALLBACK
                 looks like "inconclusive data" → outage hidden
fix: circuit breaker (fast-fail) + cause-tagged FALLBACK
```

### The question candidates always dodge

**"Is your error handling ever too graceful?"**

Yes — and this is the one candidates avoid because graceful sounds good. The `FALLBACK` diagnosis is emitted both when the data was genuinely inconclusive *and* when every single tool call failed due to an outage. The user sees the same "Insufficient data to determine a cause" message in both cases, so a transport outage is silently dressed up as a benign result. Graceful degradation that erases the distinction between "nothing to report" and "everything broke" is a monitoring blind spot. The honest fix is to make the failure observable — tag the fallback's cause — which is the first exercise above.

### One-line anchors

- `lib/agents/base.ts` L91 / L101 — `forceFinal` withholds tools — the budget IS the loop protection.
- `lib/agents/diagnostic.ts` L73–L77 — `tryParse ?? synthesize ?? FALLBACK` — the three-tier cascade.
- `lib/agents/diagnostic.ts` L82–L121 — `synthesize` — clean-context retry, `try/catch → null`.
- `lib/agents/monitoring.ts` L88–L89 — parse fail → `[]` — graceful degrade.
- `lib/mcp/client.ts` L49–L60 — bounded rate-limit retry + no-cache-on-error.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the recovery cascade for a diagnosis: the budget bound at the top (forceFinal withholds tools), then the three output tiers (tryParse → synthesize → FALLBACK), then the transport recovery below (retry + no-cache-on-error). Mark which tier never throws.

### Level 2 — Explain

Out loud: explain why the budget is both the latency bound and the loop protection, and why a *separate* `synthesize()` call recovers output that the loop's own final turn could not produce.

### Level 3 — Apply

Scenario: an investigation returns `FALLBACK` ("Insufficient data") even though the trace shows six successful tool calls with real data. Where do you look? Start at `lib/agents/diagnostic.ts` L73–L77: both `tryParseDiagnosis(finalText)` and `synthesize()` returned `null`. Check whether the forced-final turn emitted prose (was `synthesisInstruction` appended at `base.ts` L98?) and whether `synthesize`'s `try/catch` (L118) swallowed an error. Name the fix path.

### Level 4 — Defend

A reviewer says: "Drop the `synthesize()` call and the `FALLBACK` — if the loop returns JSON it is fine, and the extra call is wasted cost." Defend the tiers using the failure mode they prevent (a stream-breaking `null` diagnosis) and the fact that `synthesize` costs nothing when the loop succeeds. Then concede the one alternative that would make them redundant (constrained decoding).

### Quick check — code reference test

When `McpClient.callTool` gets an error result, does it write it to the cache, and why? (Answer: no — `lib/mcp/client.ts` L57–L60 returns the error result without caching, so a transient failure cannot poison the next 60s of calls.)
