# Per-tool circuit breaking

**Industry name(s):** Per-tool circuit breaker, agent-aware fail-fast, observation-as-control, breaker state as agent context
**Type:** Industry standard · Language-agnostic

> An agent loop can call the same flaky tool on every turn — retrying a dead tool inside a loop multiplies the failure by the iteration count and burns the whole budget. A per-tool circuit breaker scoped to each tool, fed back to the agent as an *observation* the model reads, lets the agent route around the dead tool instead of looping on it. blooming insights has bounded exponential-backoff retry in `McpClient.callTool` (`lib/mcp/client.ts` L122–L132, configured with `retryDelayMs: 10_000` / `retryCeilingMs: 20_000` / `maxRetries: 3` in `connect.ts` L92–L95) but no per-tool circuit breaker — and crucially, no path that feeds open-state back to the agent so it routes around the failing tool.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A per-tool circuit breaker for agents would sit at the seam between the Provider/MCP-transport wrappers and the Shared agent loop — failing fast at the wrapper layer (closed/open/half-open) AND surfacing the open-state back to the loop as an *observation* so the model routes around the dead tool. In blooming insights, the wrapper layer has *bounded retry* (`lib/llm/retry.ts` for the LLM side; per-call backoff inside `lib/mcp/client.ts` for tools) but no per-tool breaker, and nothing is surfaced to the agent as a "this tool is open" observation. The retry layer protects the upstream; what's missing is the feedback loop that would let the model avoid the dead tool on the next turn.

```
  Zoom out — where per-tool circuit breaking WOULD live

  ┌─ Shared agent loop ─────────────────────────────┐  ← we are here
  │  runAgentLoop — would read breaker state and     │
  │  surface "tool X open" as a tool_result obs.     │
  └─────────────────────────┬────────────────────────┘
                            │  every model call
  ┌─ Provider wrappers ─────▼────────────────────────┐
  │  lib/llm/retry.ts (bounded retry + backoff)      │
  │  closest analog on the LLM side                   │
  └─────────────────────────┬────────────────────────┘
                            │  every tool call
  ┌─ Tools + MCP transport ─▼────────────────────────┐
  │  ★ PER-TOOL BREAKER (★ THIS ★, absent):           │
  │    per-tool closed/open/half-open state           │
  │    feedback to agent loop as an observation       │
  │  ── absent in blooming insights ──                │
  │  what's here today: bounded retry per call only   │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when the agent is the caller, what does the circuit breaker have to do *more than* fail fast? A service-to-service breaker stops at "fail the call quickly" — your handler catches the error and moves on. An agent breaker has to do that AND surface the open-state as an *observation the model reads*, so the next turn picks a different tool instead of retrying the same dead one. Without the feedback path, the agent burns its whole budget on retries. blooming insights has the retry but not the breaker-as-observation; below, you'll see the closed/open/half-open mechanics and the specific gap where "feed it to the agent" would slot in.

---

## Structure pass

**Layers.** Four layers carry a would-be agent-aware breaker: the **Shared agent loop** (where the model emits `tool_use` blocks and reads `tool_result` observations), the **Provider/MCP wrapper** (today: bounded retry + backoff in `McpClient.callTool` and `lib/llm/retry.ts`), the **Per-tool breaker state machine** (would be: closed / open / half-open per tool, absent today), and the **Observation feedback path** (would surface open-state back to the agent loop as a `tool_result` saying "tool X is open, route around it" — also absent today). The first two exist; the second two are the gap this file is describing.

**Axis: failure.** Where does a flaky tool's failure originate, how does it propagate (an agent re-calling a dead tool every turn multiplies the failure by iteration count!), and where does it get contained? This is the right axis because the whole concept is *containing a per-tool failure inside an autonomous loop that has no instinct to give up*. Cost is downstream (every retry burns model tokens + provider quota); control is downstream (the model would route around if it knew, but it doesn't). Failure is the lens.

**Seams.** Two seams are load-bearing. Seam 1 sits between the per-call retry layer and the per-tool breaker state — failure-containment flips from "this call is bounded" (bounded retry, what blooming insights has) to "this *tool* is bounded for some window" (open state across calls). That seam is what stops a flaky tool from burning the agent's whole budget across many turns. Seam 2 sits between the breaker state machine and the agent loop *as an observation* — failure flips from "the wrapper knows the tool is open" (silent) to "the model knows the tool is open and chooses something else" (observable). Seam 2 is the load-bearing one because *without it*, the breaker just fails fast over and over and the agent keeps re-calling the same dead tool — the loop doesn't learn. Surfacing open-state as a tool_result is what turns the breaker from "service mesh pattern" into "agent-aware pattern."

```
  Structure pass — Per-tool circuit breaking

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Shared agent loop (emits tool_use, reads obs) │
  │  Provider/MCP wrapper (bounded retry today)    │
  │  Per-tool breaker state (closed/open/half-open │
  │     — absent today)                            │
  │  Observation feedback (open-state →            │
  │     tool_result — absent today)                │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  failure: where does a flaky tool's failure    │
  │           propagate / get contained?           │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: per-call retry ↔ per-tool breaker     │
  │          (one call bounded → tool bounded for  │
  │          some window)                          │
  │  Seam 2: breaker state ↔ agent loop (as obs.)  │
  │          (wrapper knows → model knows)         │
  │          ★ load-bearing — without it, the loop │
  │          re-calls the dead tool forever        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the closed/open/half-open mechanics and the specific gap where "feed it back to the agent" would slot in.

---

## How it works

**The mental model: closed/open/half-open, one breaker per tool, and the open-state surfaces as an observation.** You know the closed/open/half-open shape from service mesh and resilience libraries (Hystrix, resilience4j, Polly). The agent-specific addition is the *observation feedback* — the breaker isn't just a guard around the call site; it's a fact the agent's reasoning has to know about so the next turn picks a different tool.

```
Per-tool circuit breaker — three states, one per tool

  ┌───────── per-tool breaker state machine ─────────┐
  │                                                    │
  │       ┌─────────┐                                  │
  │       │ CLOSED  │ ◄──────── success on probe       │
  │       │ calls   │                                  │
  │       │ pass    │ ──────► consecutive failures ≥ N │
  │       │ through │                  │                │
  │       └─────────┘                  ▼                │
  │                              ┌─────────┐            │
  │                              │  OPEN   │            │
  │                              │ fail    │            │
  │                              │ fast,   │            │
  │                              │ no call │            │
  │                              └────┬────┘            │
  │                                   │ after cooldown T│
  │                                   ▼                  │
  │                            ┌────────────┐            │
  │                            │ HALF-OPEN  │            │
  │                            │ try 1 probe│            │
  │                            └────┬───────┘            │
  │                  success ◄──────┴────────► failure   │
  │                                                       │
  └───────────────────────────────────────────────────────┘

  ONE breaker instance per tool name, not one global breaker.
  Per-tool because tools can fail independently (Bloomreach is
  fine but the third-party LLM tool is down).
```

The strategy in plain English: **three states, scoped to one tool, and the state itself is something the agent can read.** Without the third clause, you have a service breaker bolted onto an agent loop, which is the textbook *single-call* pattern (covered in the ai-eng file). The agent-architecture version names the gap and closes it: the breaker's open state is an input to the agent's next reasoning step.

### The state machine — closed, open, half-open

The technical thing: each tool has its own breaker with three states. **Closed** = calls flow normally; failure counter ticks up on each failure, resets on success. **Open** = next call to this tool fails fast without hitting the upstream; cooldown timer counts down. **Half-open** = after cooldown, the next call is a probe — success closes the breaker, failure re-opens it for another cooldown.

If you're coming from frontend, this is the same shape as a "broken integration" flag in your error boundary. After three failed reloads of the embedded widget, you stop trying for a minute and show "this widget is offline." After the minute, you try once more — if it works, you go back to normal; if not, you wait again. The breaker formalizes the conditions: counter, threshold, cooldown.

```
The three states, with thresholds named

  CLOSED                                         OPEN
  ────────────────────────────────────           ─────────────────────────────
  call passes to upstream                        call fails fast (no upstream)
  on failure: counter++                          cooldown timer counts down
  if counter ≥ N (threshold):                    when timer = 0:
    → OPEN, reset counter, start cooldown          → HALF-OPEN
  on success: counter = 0

  HALF-OPEN
  ─────────────────────────────────────────────────
  next call is a probe (one call allowed)
  if success: → CLOSED, counter = 0
  if failure: → OPEN, restart cooldown
```

The practical consequence: the breaker turns "every call pays the retry tax" into "fail fast during the cooldown window, then try once to recover." Across many callers hitting the same dead tool, the cooldown serializes recovery probes — only one half-open probe at a time, not every caller hammering the recovery point.

The condition under which it works: the failure threshold and cooldown have to match the failure shape. Threshold too low (open on first failure) = false positives on transient blips; too high = breaker never trips and you get the no-breaker behavior. Cooldown too short = repeated open/close churn; too long = the system stays degraded after recovery. Production tuning is workload-specific.

### Per-tool scope — independent breakers for independent dependencies

The technical thing: each tool gets its own breaker instance. The MCP server might be down (so `execute_analytics_eql` is open) while the LLM provider is fine (so `chat.completions` is closed). One global breaker would over-trip on independent failures; one per-tool breaker isolates the blast.

If you're coming from frontend, this is the difference between "one global loading spinner" (everything blocks until everything's ready) and "per-section spinner" (each section reveals when its data lands). The granularity makes the system feel responsive when only part of it is sick.

```
Why per-tool, not global

  Global breaker:                       Per-tool breakers:
  ┌──────────────────┐                  ┌──────────────────┐
  │ any failure ticks │                 │ exec_analytics    │ ── CLOSED
  │ the global counter│                  │ get_schema        │ ── OPEN
  │                   │                 │ list_catalogs     │ ── HALF-OPEN
  │ trips → ALL tools │                  │                   │
  │ blocked           │                  │ (each independent) │
  └──────────────────┘                  └──────────────────┘
   over-trips on            isolates failures to the
   independent failures     specific tool that's sick
```

The practical consequence: in a topology where some tools are healthy and some are sick (a multi-source agent — vector store fine, web search down, internal DB fine), the per-tool breaker keeps the healthy paths open and only fails-fast the sick one. Global breaker would degrade the whole agent to "everything off" on any single tool's failure.

The condition under which per-tool is enough: tools fail independently. If two tools share the same backend (two MCP tools both routed through one transport), they share a failure mode — when the transport's down, both should be open, but a per-tool breaker has to discover that independently for each. Mitigation: a layered breaker — per-tool on top, per-transport underneath — so the transport's failure is visible to the layer above.

### The agent-specific extra — feed open state back as an observation

The technical thing — this is what distinguishes the agent-architecture version from the ai-eng single-call version: when a tool's breaker is open and the agent emits a `tool_use` block for it, the loop intercepts the call and returns a *synthetic observation* describing the open state. The model reads that observation on its next turn and routes its reasoning around the dead tool.

If you're coming from frontend, this is the difference between "the API call failed silently" and "the form shows a clear error message naming what's broken." The user (or the model) can only act on what they can see; a fail-fast that's invisible to the agent might as well not exist for routing purposes.

```
The observation feedback — what the breaker tells the agent

  Without observation feedback (just a service-style breaker):
    model: tool_use { name: 'execute_analytics_eql', input: {...} }
       ▼
    breaker: OPEN → fail fast
       ▼
    loop: return error result
       ▼
    model: "huh, that didn't work, let me try the same tool again"
       │   (no signal it should switch)
       ▼
    next turn: tool_use { name: 'execute_analytics_eql', input: {...} }
       (same dead tool, again)

  With observation feedback (the agent-aware breaker):
    model: tool_use { name: 'execute_analytics_eql', input: {...} }
       ▼
    breaker: OPEN
       ▼
    loop: return synthetic tool_result {
            tool_use_id: ...,
            content: "tool 'execute_analytics_eql' is currently
                      unavailable (3 failures, cooldown 90s remaining)
                      — try a different tool or report 'no data'",
            is_error: true,
          }
       ▼
    model: "okay, that tool is dead — let me try get_schema instead
            or abstain"
       ▼
    next turn: tool_use { name: 'get_schema', ... }
       (routed around the dead tool)
```

The practical consequence: the agent's iteration budget gets spent on tools that *can* succeed, not on retries of one that can't. A 6-call budget against one sick tool with no agent observation = 6 wasted turns. The same budget with observation feedback = the agent realizes after turn 1 and uses turns 2–6 on different tools or to synthesize an honest abstention.

The condition under which it works: the model has to understand the synthetic observation. Production prompts include a short "if a tool returns 'unavailable,' do not retry it — choose a different tool or report what you have" instruction so the model's reasoning includes the breaker state. Without that prompt-level guidance, the model might treat the synthetic error the same as a regular error and retry.

### What blooming insights has — bounded exponential-backoff retry, no breaker

The technical thing: the MCP client wrapper's tool-call path retries rate-limited calls up to 3 times with exponential backoff. The wait is computed two ways and the smaller-of-(chosen, ceiling) wins: a parsed `Retry-After` hint from the error text + 500 ms buffer, else `retry_delay_ms × 2^(retries-1)` off a 10s base, every wait capped at `retry_ceiling_ms = 20_000`. Configuration: `retry_delay_ms: 10_000`, `retry_ceiling_ms: 20_000`, `max_retries: 3`.

If you're coming from frontend, this is `fetch` retry with `Retry-After` honoring — done correctly. It's the right thing for transient blips: one bad call clears on retry, the budget allows for it, the wait honors the server's stated penalty window.

```
call_tool — retry shape (no breaker), pseudocode

  result = live_call(name, args)
  retries = 0
  while is_rate_limited(result) and retries < 3:
    retries += 1
    hint_ms    = parse_retry_after_ms(result)
    backoff_ms = retry_delay_ms × 2^(retries-1)    # base 10s
    wait_ms    = min(hint_ms + 500 if hint_ms else backoff_ms,
                     retry_ceiling_ms)              # 20s ceiling
    await sleep(wait_ms)
    result = live_call(name, args)

  After 3 retries: return the error result to the agent.
  No breaker state. No fail-fast. No agent observation
  saying "this tool is dead — try something else."
```

The practical consequence: a transient rate-limit blip clears on retry (typically the second attempt, after a ~10s wait honoring Bloomreach's stated window). A *sustained* Bloomreach outage, on the other hand, means every call from every agent pays the full retry tax — 3 retries × up to 20s each = up to 60s per call — before the failed result reaches the agent. The agent then... tries the same tool again on its next turn, because there's no state telling it not to. The 6-call budget can vanish entirely on a sick tool.

The condition under which this is enough: the failure mode is transient, not sustained. Bloomreach's rate limit is a real failure mode the retry handles correctly (the parsed `Retry-After` is honored, so the retry lands after the penalty clears). The breaker pattern would add value when (a) the failure is sustained (a Bloomreach outage, not a rate limit) or (b) the topology has multiple tools the agent could route between.

### Why the gap matters — what "feed it back to the agent" would unlock

The technical principle: the retry handles "this call failed; try again." The breaker handles "this *tool* is dead; stop trying." The agent-observation extension handles "the agent should *know* this tool is dead so it picks a different one." Each layer covers a failure mode the lower layer doesn't.

```
Three layers of failure handling — and what each covers

  layer                       failure it handles            in this codebase
  ──────────────              ──────────────────────────    ─────────────────
  retry (bounded)             transient blip                BUILT
                              (rate-limit window, jitter)   (the MCP client
                                                             wrapper's retry)
  circuit breaker             sustained outage              ABSENT
                              (provider down for minutes)
  + agent observation         agent retrying a dead tool    ABSENT
                              every turn (loop blowup)
```

The practical consequence: today, a sustained outage of Bloomreach means every agent turn pays the full retry tax and the agent has no signal to stop trying. With a per-tool breaker that feeds open-state back as an observation, the first failure trips the counter, the second trips the breaker, the third call (and every subsequent call to that tool) returns "tool unavailable" instantly, AND the model reads it and picks a different tool. In this codebase that "different tool" would be limited (one transport, one server) — the agent might switch from `execute_analytics_eql` to `get_schema` or abstain — but even abstention is better than the current "burn 6 turns retrying."

The principle: **agent loops invert the cost equation.** A service that retries a dead dependency wastes one call's worth of time. An agent that retries a dead dependency wastes a whole *trajectory* — every turn, every model call, every observation in the window. The breaker's job in an agent is to bound the trajectory's blast radius, not just the individual call's.

### Phase A vs Phase B — where the breaker + observation feedback would slot in

Right now there's bounded retry, no breaker, no observation. Naming where they would slot makes the gap concrete.

```
       Phase A (now — bounded retry only)
┌────────────────────────────────────────────────────────────┐
│ agent emits tool_use                                       │
│   ▼                                                         │
│ mcp_client.call_tool                                        │
│   ├─ cache check                                           │
│   ├─ live_call                                             │
│   │   on rate-limit error: retry up to 3 times             │
│   │   (waits 10–20s each)                                  │
│   └─ return result (success or final error)                │
│   ▼                                                         │
│ loop feeds tool_result back to agent                        │
│   error or success → agent reads, decides next call         │
│   (no signal "this tool is dead, switch")                   │
└────────────────────────────────────────────────────────────┘

       Phase B (per-tool breaker + agent observation feedback)
┌────────────────────────────────────────────────────────────┐
│ agent emits tool_use                                       │
│   ▼                                                         │
│ mcp_client.call_tool                                        │
│   ├─ breaker.state(name) ?                                  │ ← NEW
│   │   ├─ OPEN  → return synthetic "tool unavailable"        │ ← NEW
│   │   │          observation (no upstream call)             │
│   │   ├─ HALF-OPEN → allow one probe                        │ ← NEW
│   │   └─ CLOSED → existing flow                              │
│   ├─ cache check                                            │
│   ├─ live_call                                              │
│   │   on failure: breaker.record_failure(name)              │ ← NEW
│   │   on success: breaker.record_success(name)              │ ← NEW
│   │   retry as before                                       │
│   └─ return result                                          │
│   ▼                                                         │
│ loop feeds tool_result back to agent (UNCHANGED shape)      │
│   if synthetic "unavailable" → model picks different tool   │
└────────────────────────────────────────────────────────────┘
   the breaker state has to be per-instance lived per
   investigation (matches the cache lifecycle), or shared
   across investigations if outage detection should span
   them (more useful, more ops to maintain)
```

*Phase A (now):* retry handles transient blips well; sustained outages burn the budget. Acceptable when Bloomreach availability is high and outages are short (the retry covers most of them).

*Phase B (breaker + observation):* the agent learns to route around dead tools mid-trajectory. The cost is one new component (the breaker state, per-tool) plus prompt-level guidance to the agents about how to read the synthetic observation. The win is *bounded* trajectory cost during sustained failure — the budget doesn't vanish into retries.

The takeaway: **the breaker's value in an agent isn't fail-fast for its own sake; it's keeping the iteration budget alive so the agent can finish, even if it has to finish with "I couldn't reach this data."** That's a structurally better failure mode than "the budget burned silently and the answer is empty."

This is what people mean when they say "agent retry is the worst kind of retry." A retry inside a loop amplifies the wait by the loop's iteration count, and the cost is the whole task, not one call. The breaker is the answer; the observation feedback is what makes the breaker actually useful to an agent.

The full picture is below.

---

## Per-tool circuit breaking — diagram

```
The canonical per-tool circuit breaker — with the agent-observation extension

  agent emits tool_use { name: 'X', input: {...} }
       │
       ▼
  ┌───────────────────────────────────────────────────────────┐
  │ Per-tool breaker state for 'X'                            │
  │   CLOSED / OPEN / HALF-OPEN                                │
  └────────────────────┬───────────────────────────────────────┘
                       ▼
       ┌───────────────┼────────────────┐
       ▼ CLOSED        ▼ HALF-OPEN      ▼ OPEN
   call passes      probe allowed   FAIL FAST
       │            (one)              │
       ▼              │                ▼
   upstream X     upstream X      ┌────────────────────────────┐
       │              │            │ SYNTHETIC OBSERVATION:     │
       ▼              ▼            │  tool_result { is_error: true,
   success/fail   success/fail     │   content: "tool 'X' is     │
   record on        record on      │   currently unavailable;    │
   breaker          breaker        │   try a different tool" }   │ ← THE EXTENSION
                                    └───────────────┬────────────┘
                                                    │
                                                    ▼
                                       agent reads observation,
                                       picks a DIFFERENT tool
                                       (or abstains honestly)

  WHAT THIS CODEBASE HAS:
   bounded exponential-backoff retry (the MCP client wrapper)
   ─ honors Retry-After hint from error text
   ─ retry_delay_ms=10_000, retry_ceiling_ms=20_000, max_retries=3
   ─ no breaker state, no fail-fast
   ─ no agent observation saying "switch tools"

  THE GAP:
   sustained-outage handling
   ─ today: every call pays full retry tax (~50s × 6 calls = budget gone)
   ─ with breaker + observation: first failures trip the breaker, rest
     return synthetic observations the agent reasons on, budget preserved
```

---

## Implementation in codebase

**Case B (partial) — bounded exponential-backoff retry exists; per-tool circuit breaker does not.** The honest sentence: the retry layer covers transient blips correctly (Retry-After-honoring, exponential backoff, bounded to 3 retries), but there's no breaker state and no path that feeds an open-state observation back to the agent for routing.

**Bounded retry (built)**
**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool` — the retry while-loop
**Line range:** L122–L132 (the retry guard at L122; retry counter at L123; wait calculation at L124–L129; sleep at L130; retry call at L131)

The retry loop. `isRateLimited(result)` (L18–L22) decides whether to retry — the test is "is this an `isError: true` result whose text matches `/rate limit|too many requests/i`." `parseRetryAfterMs(result)` (L31–L38) pulls a stated window out of Bloomreach's error text; when present, the retry waits `hintMs + RETRY_BUFFER_MS` (500 ms cushion, L16). When no hint parses, the fallback is exponential backoff `retryDelayMs × 2^(retries-1)` off a 10s base. Every wait is capped at `retryCeilingMs = 20_000`.

**Retry configuration**
**File:** `lib/mcp/connect.ts`
**Function / class:** the `McpClient` constructor call
**Line range:** L89–L96 (the options: `minIntervalMs: 1100`, `retryDelayMs: 10_000`, `retryCeilingMs: 20_000`, `maxRetries: 3`)

Where the retry numbers are tuned. The 10s base matches Bloomreach's observed `1 per 10 second` window — a sub-second retry would burn the attempt inside the same window. The 20s ceiling caps a single retry's wait so one retry can't blow the route's 60s investigation budget. `maxRetries: 3` × ~10s each gives a worst case of ~30s on a single call (comment in `client.ts` L118–L120).

**Per-tool circuit breaker (not built)**
**Honest sentence:** there is no breaker state in `McpClient`. The fields tracking call state (`cache` L80, `lastCallAt` L81) cover memoization and spacing, not failure-counting per tool. There is no `failureCount`, no `openUntil`, no per-tool state machine. Every retry sequence runs to completion regardless of how many recent calls to the same tool have failed.

**Agent observation feedback (not built)**
**Honest sentence:** `runAgentLoop` (`lib/agents/base.ts` L48–L176) feeds the tool result back to the model unmodified (L161–L171). On a final retry-exhausted error, the model sees an `is_error: true` tool result the same shape as any other failure; nothing tells the model "this tool has been failing for a while — try a different one."

```
shape (not full impl):
  // TODAY — bounded retry only (client.ts L122–L132)
  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
      this.retryCeilingMs,
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args);
  }
  // result returned to agent; no breaker state, no observation

  // PHASE B — breaker + observation (not here):
  // class McpClient {
  //   private breakers = new Map<string, { state, failures, openUntil }>();
  //   async callTool(name, args) {
  //     const b = this.breakers.get(name);
  //     if (b?.state === 'OPEN' && b.openUntil > Date.now()) {
  //       return { result: syntheticUnavailable(name, b.openUntil), ... };
  //     }
  //     // ... existing flow, plus record failure/success on breaker
  //   }
  // }
  // // agent prompt addition:
  // "if a tool returns 'currently unavailable', do not retry it —
  //  choose a different tool or report what you have."
```

---

## Elaborate

### Where this pattern comes from

The circuit breaker pattern came from telephony (Hystrix at Netflix popularized it in microservices, ca. 2012) — a state machine wrapping calls to a dependency, tripping on N failures, cooling down for T, probing once before fully reopening. The pattern's been re-implemented in resilience libraries across every major stack (resilience4j, Polly, Bulkhead, Istio/Envoy circuit breakers). The *agent-specific* twist — feed open-state back to the agent as an observation — got named more recently as multi-agent and multi-tool systems started hitting the loop-blowup failure mode the service-style breaker didn't address.

### The deeper principle

There are three layers of failure handling for any callee, and they cover different failure modes. **Retry** handles transient blips — one call, one wait, one or more attempts. **Circuit breaker** handles sustained outages — many callers, one dead dependency, fail fast across all of them. **Agent observation feedback** handles loop-internal routing — one caller (the agent), one dead tool, switch tools instead of retrying. The first two are universal patterns; the third is what makes them work *inside* an autonomous loop instead of around it.

```
  layer                  failure mode           who acts on the state
  ────────────          ─────────────────       ──────────────────────
  retry                  transient (blip)       the call-site code
  circuit breaker        sustained (outage)     all callers, including
                                                  the call-site code
  + observation          agent retrying a       the AGENT's reasoning
                         dead tool every turn   (next turn picks differently)
```

### Where this breaks down

The breaker pattern itself has tuning gaps — threshold too low triggers on noise, cooldown too short churns open/closed. The observation-feedback extension has a deeper problem: the model has to understand the synthetic observation as a routing signal, not as a regular error to retry. Without prompt-level guidance, the model might emit the same `tool_use` on the next turn even after seeing "unavailable." Mitigation is structural: include the prompt instruction, and consider a hard rule in the loop ("if the same tool just returned 'unavailable,' refuse to call it again this turn") as a safety net.

### What to explore next
- Single-call retry + breaker mechanics: `../../study-ai-engineering/06-production-serving/05-retry-circuit-breaker.md` → the layer this file extends
- Coordination failure modes: `../03-multi-agent-orchestration/09-coordination-failure-modes.md` → "tool-call cascade" failure mode this breaker pattern bounds
- Capability gating: `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md` → pre-call routing as a complement to post-call breaker state
- Fan-out backpressure: `02-fan-out-backpressure.md` → the related serving discipline at the concurrency layer

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "what happens when a tool keeps failing," they're testing whether you can distinguish three different failure modes (blip, outage, agent-loop blowup) and name which of them your code handles. The strong signal is naming all three and being honest about which you cover. The weak signal is saying "we have retry" and stopping.

### Likely questions

[mid] Q: What happens when a tool call to Bloomreach fails?

A: There's bounded exponential-backoff retry in `McpClient.callTool` (`lib/mcp/client.ts` L122–L132). On a rate-limit error, it retries up to 3 times. The wait honors a `Retry-After` window parsed from the error text (plus a 500 ms cushion), else falls back to exponential backoff off a 10s base, capped at 20s per wait. So a transient blip — a single 429 because the spacing window was unlucky — clears on the next attempt. Configuration is in `lib/mcp/connect.ts` L92–L95.

Diagram:
```
  result = liveCall(...)
  while isRateLimited(result) && retries < 3:
    wait = min(parsedRetryAfter+500ms ?? 10s·2^n, 20s)
    sleep(wait)
    result = liveCall(...)
```

[senior] Q: What happens when Bloomreach is *down* for an hour?

A: That's where the gap is. The retry handles transient blips well; it doesn't handle a sustained outage. During an hour-long Bloomreach outage, every agent call pays the full retry sequence — up to 60s per call — before returning an error to the agent. And the agent has no signal saying "this tool is dead, try a different one" — it sees an error result the same shape as any other failure and may retry on its next turn. So a 6-call budget can burn through 3-5 minutes of wall clock on retries and finish with no diagnosis. The fix is a per-tool circuit breaker that trips on N consecutive failures and feeds the open state back to the agent as a synthetic `tool_result` saying "tool unavailable" — the model reads that observation and routes around the dead tool or abstains honestly.

Diagram:
```
  today (retry only)               with breaker + observation
  ──────────────────              ────────────────────────────
  call 1: retry 3× → fail (~60s)   call 1: retry 3× → fail; breaker counts
  call 2: retry 3× → fail (~60s)   call 2: retry 3× → fail; trips OPEN
  ...                              call 3: synthetic "unavailable" → 0ms
  budget burned, no diagnosis      agent abstains or routes around
```

[arch] Q: If you added the breaker tomorrow, where exactly would it sit and what would the agent see?

A: The state would live on `McpClient` — a `Map<string, BreakerState>` keyed on tool name, lifecycle matching the existing cache (per-investigation, so the breaker resets each run unless we want it cross-investigation, which is a separate decision). The hook is in `callTool` at the top: check `breakers.get(name)?.state` and if it's `OPEN`, return a synthetic `tool_result` with `is_error: true` and `content: "tool '<name>' is currently unavailable — try a different tool"` *without* calling `liveCall`. Record success/failure on the breaker after a real call returns. The prompt change is one line in each agent's system prompt — "if a tool returns 'currently unavailable,' do not retry it; choose a different tool or report what you have." The model sees a regular-shaped tool_result it already knows how to read.

Diagram:
```
  callTool(name, args):
    if breaker(name).state === OPEN:
      return { result: { is_error: true, content: "tool unavailable" }, ... }
    // existing flow
    result = await liveCall(...)
    if isError: breaker(name).recordFailure()
    else: breaker(name).recordSuccess()
    return result
```

### The question candidates always dodge
Q: You're describing the breaker pattern but you said tools fail independently. In this codebase there's basically *one* tool (`execute_analytics_eql`) against one upstream — what does "route around" even mean here?

A: Honest answer: not much, today. The codebase has a handful of MCP tools (the EQL one, schema introspection, catalog list) but they're all routed through the same MCP transport against the same Bloomreach backend — they share a failure mode. So when Bloomreach is down, every tool is sick at once and "route around" effectively means "abstain." Even that's a real win compared to the current behavior (burn the budget on retries, then abstain anyway), because the abstention happens in seconds instead of minutes. The full value of per-tool breaker + observation feedback only shows up when the topology has independently-failing tools — a vector store *and* a live API, say, where the agent can switch from "the live numbers are unreachable" to "let me check what we know from past investigations." So my honest framing: today the breaker buys *fast abstention*; the day a second source ships it buys *routing around* in the literal sense. Both are improvements over the current "loop on a dead tool until the budget's gone" behavior; the second is the larger win.

Diagram:
```
   today (one effective source)            tomorrow (multi-source)
   ────────────────────────────            ──────────────────────────────
   breaker buys: FAST ABSTENTION           breaker buys: ROUTING AROUND
   (~50s saved per outage call)            (the agent switches tools)
   agent says "I couldn't reach            agent says "the live data is
   Bloomreach right now"                    unreachable, but here's what
   in seconds instead of minutes            past investigations show"
```

### One-line anchors
- "Three layers of failure handling: retry (transient), breaker (outage), observation feedback (agent loop)."
- "This codebase has retry; breaker + observation feedback are the gap."
- "Per-tool scope — tools fail independently, so breakers should too."
- "The agent-specific extension is the synthetic observation — open-state has to be readable by the model, not just by the call-site code."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three breaker states (closed, open, half-open) with the transition triggers (N consecutive failures → OPEN; cooldown T elapses → HALF-OPEN; success → CLOSED; failure → OPEN). Then draw the agent-observation extension: open-state intercepts the `tool_use` and returns a synthetic `tool_result` the model reads on its next turn.

Open the file. Compare.

✓ Pass: you drew the three states with named triggers, drew the per-tool scope (one state machine per tool name), and drew the synthetic observation feeding back to the agent
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague asks "why isn't your retry loop enough? You have exponential backoff, you have Retry-After honoring, what's missing?" No notes. Under 90 seconds.

Checkpoints — did you:
- Distinguish transient blip (retry handles) from sustained outage (breaker handles) from agent-loop-on-dead-tool (observation feedback handles)?
- Name the worst-case budget burn during a sustained outage (3 retries × up to 20s × N calls)?
- Explain why a service-style breaker isn't enough (agent has no signal to route around)?
- Name the synthetic `tool_result` observation as the specific agent-architecture extension?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: a vector store over past investigations is added beside the MCP-EQL tool. The agent can now retrieve from either source. Without opening the code: how would the per-tool breaker pattern apply, and what does "route around" look like if the vector store goes down but Bloomreach is fine?

Write your answer (4–6 sentences). Then open `lib/mcp/client.ts` L79–L95 to see where per-tool state would slot in, and `runAgentLoop` (`base.ts` L143–L171) for the result-handling block where the synthetic observation would be constructed.

### Level 4 — Defend the decision you'd change
"You said the breaker is worth building when sustained outages become a real failure mode. If Bloomreach had a known 30-minute outage scheduled for tomorrow and you had two hours to ship a fix, would you (a) add the breaker, (b) increase `maxRetries`, or (c) put up a banner and disable investigations during the window? Walk the cost of each — what does it buy, what's left exposed?"

Reference the code: point to `McpClient`'s retry loop (`client.ts` L122–L132) and configuration (`connect.ts` L92–L95) for what's tunable today.

### Quick check — code reference test
Without opening any files:
- What file holds the retry loop and what line range?
- What three retry parameters are configured in `connect.ts` and what are their values?
- What's the agent-architecture extension that makes the breaker different from a service-style breaker?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ 01-cross-turn-caching.md · → 02-fan-out-backpressure.md · → single-call retry/breaker: `../../study-ai-engineering/06-production-serving/05-retry-circuit-breaker.md` · → coordination failure modes: `../03-multi-agent-orchestration/09-coordination-failure-modes.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
