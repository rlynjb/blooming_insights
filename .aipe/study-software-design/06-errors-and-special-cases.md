# Errors and special cases

**Industry name(s):** Define errors out of existence · error masking · special-case sprawl · degrade-instead-of-throw
**Type:** Industry standard · Language-agnostic

> The best error handler is the one you didn't have to write. Ousterhout's move is to *define errors out of existence* (change the model so the error can't happen), *mask them low* (handle inside the module so callers never see them), or *aggregate them at one boundary* (so the rest of the code is unconditionally clean). blooming insights does the second move well — `try/catch` clusters around three intentional boundaries (the agent loop's tool execution, JSON-from-prose parsing, NDJSON line decoding) and the rest of the code stays clean. The finding: one special case — "the agent emitted no parseable JSON" — is handled with its own dedicated synthesis pass in TWO files, when it could be defined out of existence by hardening the agent loop's forceFinal turn.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Errors in this codebase have three lifecycles. **Bottom layer** (`McpClient`, `SdkTransport`): rate-limit errors are *retried* (not thrown), transport failures are *tagged with the tool name* and thrown as `McpToolError`. **Middle layer** (`runAgentLoop`, agent classes): every tool call is wrapped in try/catch so one failed tool doesn't kill the loop; JSON-from-prose parsing falls back gracefully. **Top layer** (routes, UI): NDJSON readers swallow malformed lines; the UI auto-reconnects on a revoked OAuth token. The pattern is **degrade-don't-throw**, which is good — but one special case (the agent "wants to keep querying" instead of emitting JSON) is handled in two places when it could be handled in one.

```
Zoom out — where errors are handled, by layer

┌─ UI ───────────────────────────────────────────────────────────┐
│  app/page.tsx ·  malformed NDJSON line → swallowed              │
│              ·  401 error → auto-reconnect (once)               │
│              ·  503 in stream → set error state                 │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Route ──────────────────▼─────────────────────────────────────┐
│  /api/agent · setup throws → 500 JSON with real message         │
│             · in-stream errors → { type: 'error' } NDJSON event  │
│             · per-step caught + returned                         │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Agent ──────────────────▼─────────────────────────────────────┐
│  runAgentLoop · tool error → tool_result with is_error=true      │
│  monitoring/diagnostic/recommendation/query · graceful: []       │
│  diagnostic + recommendation · "no JSON" → SYNTHESIZE (2 copies) │ ← we are here
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ MCP / Transport ────────▼─────────────────────────────────────┐
│  McpClient · rate-limit → retry loop with parsed wait           │
│            · transport failure → McpToolError(toolName, detail) │
│  SdkTransport · HTTP non-2xx body → captured + thrown with text │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: at each error boundary, what's the strategy — *raise it*, *retry it*, *swallow it*, or *change the model so it doesn't happen*? A healthy codebase has one strategy per boundary, named explicitly. A sprawled codebase has try/catch everywhere because no one decided. The next sections walk the three real boundaries here, name the strategy at each, then call out the one special case that's handled twice instead of once.

---

## Structure pass

**Layers.** Four error-handling layers, top to bottom: UI swallow-and-recover → route catch-and-stream-event → agent catch-and-degrade → MCP retry-and-tag. Each layer has a specific contract with the layer above.

**Axis: error-containment strategy.** For each catch block, name the strategy — does it (a) **mask** the error (swallow + degrade to a default), (b) **transform** the error (catch + re-throw with more info), (c) **propagate** the error (let it bubble), (d) **define it out** (change the model so the catch isn't needed)? This is the right axis because errors-as-special-cases is *literally* the question of which strategy each boundary chose. Cost is wrong; control is wrong; state-ownership is wrong. Strategy is the test.

**Seams.** Three load-bearing seams. **Seam 1: McpClient ↔ everything above it.** Strategy: rate-limit errors are *masked* (retried silently); transport errors are *transformed* (re-thrown as `McpToolError` with the tool name + detail). Clean. **Seam 2: runAgentLoop ↔ MCP.** Strategy: tool-execution errors are *masked* (caught and fed back as `is_error: true` tool_result, so the model can react). Clean. **Seam 3: agent class ↔ route.** Strategy: parse/validate failures are *masked* (return `[]` or `FALLBACK` instead of throwing). MOSTLY clean — except the diagnostic and recommendation agents add a SECOND masking layer (`synthesize()`) when the loop produces no JSON. Two masks for one error. That's the smell.

```
Structure pass — error strategy at each seam

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  UI · Route · Agent · MCP wrapper · Transport             │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  strategy: mask / transform / propagate / define-out      │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across seams
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: MCP layer            ★ MASK (rate-limit) + TRANSFORM │
│                             (transport errors → McpToolError)│
│  S2: runAgentLoop ↔ MCP   ★ MASK (tool errors → tool_result)│
│  S3: agent ↔ route        MOSTLY MASK (parse → [])         │
│      BUT: 2nd masking layer for "no JSON" — synthesize()   │
│      ★ THE SPECIAL CASE THAT SHOULD BE DEFINED OUT         │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the four error strategies

You know how `Array.prototype.find` returns `undefined` instead of throwing when nothing matches? That's "define the error out" — the function changed its shape so "not found" isn't an error case at all, it's just one of the valid return values. Compare with `Array.prototype.find(...).id` — *that* throws if nothing matches, because the model didn't define out the missing case. Same shape here.

```
The four strategies

  1. DEFINE OUT       change the model so the error can't happen
                      ┌────────────┐
                      │ Array.find │  returns undefined, never throws
                      └────────────┘

  2. MASK LOW         handle inside the module; callers never see it
                      ┌────────────┐
                      │ McpClient  │  rate-limit → retry → return result
                      └────────────┘  caller has no idea retry happened

  3. TRANSFORM        catch + re-throw with more info
                      ┌────────────┐
                      │ McpClient  │  transport 401 → McpToolError(name, detail)
                      └────────────┘  caller still has to catch, but with context

  4. PROPAGATE        let it bubble — caller's job
                      ┌──────────────┐
                      │ JSON.parse   │  bad input → SyntaxError to caller
                      └──────────────┘
```

### Move 2 — what blooming insights does well

**The MCP wrapper masks rate-limit errors so callers never see them.**

```
McpClient — rate-limit MASK strategy

  caller call:
    mcp.callTool('execute_analytics_eql', { query: '...' })

  what happens on a rate-limit:
    ┌─ inside McpClient.callTool ──────────────────────────┐
    │ result = await liveCall(...)                          │
    │ while (isRateLimited(result) && retries < max) {      │
    │   retries++                                           │
    │   wait = parseRetryAfterMs(result) ?? backoff         │
    │   sleep(wait)                                         │
    │   result = await liveCall(...)                        │
    │ }                                                     │
    │ return { result, durationMs, fromCache: false }       │
    └───────────────────────────────────────────────────────┘

  caller's view: { result, durationMs }   ← the same shape as on first-try success.
                                            no exception, no special return value,
                                            no "did this hit a rate limit?" check.
                                            the error was MASKED.
```

**The agent loop masks tool-call failures so one bad tool doesn't kill the run.**

```
runAgentLoop — tool error MASK strategy

  inside the for-loop, per tool_use:
    try {
      const { result, durationMs } = await mcp.callTool(tu.name, tu.input)
      tc.result = result
      resultContent = truncate(JSON.stringify(result))
    } catch (err) {
      isError = true
      tc.error = err.message
      resultContent = truncate(JSON.stringify({ error: err.message }))
    }
    toolCalls.push(tc)

    // feed back as tool_result regardless
    toolResults.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: resultContent,
      ...(isError ? { is_error: true } : {}),
    })

  → the model SEES the error (via is_error: true) and can react.
  → the LOOP keeps running.
  → no exception escapes the loop. clean mask, with information preserved.
```

**The agent classes mask parse/validate failures gracefully.**

```
MonitoringAgent.scan — JSON parse MASK strategy

  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];                                  ← masked: no exception escapes
  }
  if (!isAnomalyArray(parsed)) return [];       ← masked: validation fails → []
  return [...parsed].sort(...).slice(0, 10);

  the route caller writes:
    const anomalies = await agent.scan(...)
    const insights = anomalies.map(anomalyToInsight)
                              ────────
  no try/catch needed at the route — the agent's contract is "I always return
  an array, possibly empty, never throw." that's the mask paying for itself.
```

### Move 2 — the special case to define out

**The agent "won't emit JSON" → synthesize() recovery, twice.** When `runAgentLoop` returns text that can't be parsed (the model decided to "keep wanting to query" instead of emitting the JSON), both `DiagnosticAgent` and `RecommendationAgent` run a *second* tool-less call as recovery. Two copies of the same recovery shape.

```
The "no parseable JSON" special case — handled twice

  DiagnosticAgent.investigate (lib/agents/diagnostic.ts L74–L75)
    const diag = tryParseDiagnosis(finalText) ?? (await this.synthesize(...)) ?? FALLBACK
                                                   ──────────────────────────────
                                                   second model call, tool-less

  RecommendationAgent.propose (lib/agents/recommendation.ts L69–L72)
    const idless =
      tryParseRecommendations(finalText) ??
      (await this.synthesize(anomaly, diagnosis, toolCalls));
                                                   ──────────────────────────────
                                                   second model call, tool-less

  both synthesize() methods (L86–L126 in diagnostic, L82–L132 in recommendation)
  do the same shape:
    - serialize tool_call history as "Query N: ... Result: ..."
    - call anthropic.messages.create with model + prompt + history
    - parse the result with the same fence-grabbing logic
    - return null on any failure (so the caller falls back further)
```

**Why this is "a special case that could be defined out."** The forceFinal trick already exists in `runAgentLoop`: when `turn === maxTurns - 1`, the loop omits tools and appends the synthesis instruction. The model is *forced* to emit final text. In practice it sometimes still doesn't emit parseable JSON — that's the special case. But the right fix is in the loop, not in the agents:

```
Define it out — sketch

  in lib/agents/base.ts, add to runAgentLoop:
    // After the forceFinal turn, if the result still doesn't satisfy the
    // caller's parser, run ONE more tool-less attempt with the same
    // synthesisInstruction, feeding the evidence history as context.
    // This collapses the two synthesize() methods into one.

    runAgentLoop({
      ...
      // NEW option:
      parseResult?: (text: string) => T | null,        ← caller's parser
      recoveryPrompt?: (toolCalls: ToolCall[]) => string,  ← caller's recovery context
    }): Promise<{ finalText, toolCalls, parsed: T | null }>

  the loop:
    1. runs as normal
    2. on completion, runs parseResult(finalText)
    3. if null, runs ONE recovery turn using recoveryPrompt(toolCalls)
       (tool-less, model picks the structured answer from gathered evidence)
    4. returns { parsed: T | null, ... }

  diagnostic.ts collapses to:
    const { parsed } = await runAgentLoop({ ..., parseResult: tryParseDiagnosis,
                                              recoveryPrompt: buildDiagRecoveryCtx })
    return parsed ?? FALLBACK

  recommendation.ts collapses similarly.
  the two synthesize() methods delete.
```

**Why this isn't bigger than it sounds.** The recovery prompt is genuinely different per agent (output shape differs), so the loop can't hardcode it. But the *decision* to do a recovery turn is shared — it's the same "if parse failed, run one tool-less attempt" pattern. Lifting the decision and parameterizing the prompt is the partial pull-down.

### Move 2 — a small "could define out" that's smaller than the synthesize one

**`McpClient.errorDetail` (lines 55–62) tries to extract a useful detail from any thrown error, handling three shapes**: `Error` with a message + cause, `Error` without a cause, non-Error. Each is a small special case.

```
errorDetail — three branches that could collapse

  function errorDetail(err: unknown): string {
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause;
      const causeStr = cause instanceof Error ? cause.message
                       : cause ? safeStringify(cause) : '';
      return causeStr && causeStr !== err.message
        ? `${err.message} — ${causeStr}`
        : err.message;
    }
    return safeStringify(err);
  }
```

The three branches are real (Error+cause / Error / non-Error), but they all collapse to "produce the most useful string description." This isn't a *bad* special case — it's an unavoidable consequence of `unknown` error types in TypeScript. The right move is to accept it as is; it's local, well-named, and the alternative (treating every error as `unknown` at every call site) would be worse. Naming it for completeness; not a finding.

### Move 3 — the principle

The four error strategies aren't equally good — they're ranked. **Define out > mask low > transform > propagate.** A defined-out error doesn't cost the reader anything; a masked-low error costs one try/catch in the module; a transformed error costs every caller a catch with the enriched type; a propagated error costs every caller a catch with no help. When you see a try/catch, ask: could the model change so this didn't need to exist? If yes, that's a deeper fix than handling it.

---

## Primary diagram

The full error-strategy audit:

```
Error strategy audit — by file

  MASKED LOW (handled inside the module — strongest pattern in this repo)
  ──────────────────────────────────────────────────────────────────
  McpClient.callTool       rate-limit → silent retry            ★ strong
                            lib/mcp/client.ts L121–L132
  McpClient.callTool       error result → no cache write         ★ strong
                            lib/mcp/client.ts L137–L139
  runAgentLoop             tool call throws → is_error result    ★ strong
                            lib/agents/base.ts L140–L168
  agent classes            parse fails → return [] / FALLBACK    ★ strong
                            monitoring L112–L119, diagnostic L75
  bootstrapSchema          tool isError → McpToolError thrown    ★ strong
                            lib/mcp/schema.ts L136–L149
  app/page.tsx             malformed NDJSON line → swallowed     ★ strong
                            app/page.tsx L450–L456

  TRANSFORMED (catch + re-throw with more info)
  ──────────────────────────────────────────────────────────────────
  SdkTransport.callTool    error + captured body → Error w/ body  ★ healthy
                            lib/mcp/transport.ts L52–L58
  McpClient.liveCall       transport throws → McpToolError       ★ healthy
                            lib/mcp/client.ts L156–L162

  PROPAGATED (left to caller, used sparingly)
  ──────────────────────────────────────────────────────────────────
  bootstrapSchema          McpToolError → bubbles up              ★ correct
                            (caller route catches as 500)
  /api/agent route         setup errors → JSON 500                ★ correct

  SPECIAL CASES THAT SHOULD BE DEFINED OUT
  ──────────────────────────────────────────────────────────────────
  diagnostic + recommendation: "agent wouldn't emit JSON"          ⚠ FINDING
    handled with synthesize() in TWO files, ~50 lines each
    fix: lift recovery into runAgentLoop as parseResult + recoveryPrompt
    impact: deletes two ~50-line methods, retires the special case
```

---

## Implementation in codebase

### The strong mask — rate-limit retry inside callTool

```
lib/mcp/client.ts  (lines 121–132)

  // Rate-limit retry. Bloomreach enforces a multi-second global window and
  // states it in the error text; honor the parsed hint, else exponential
  // backoff off retryDelayMs — every wait capped at retryCeilingMs.
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
       │
       │  the rate-limit "error" never escapes McpClient. callers see only
       │  { result, durationMs } — same shape as on first-try success.
       │  if max retries hit, the result is returned with `isError: true`
       │  on the envelope (so the model can react via tool_result), but
       │  the wrapper still doesn't throw. the loop carries on.
       │
       └─ this is "mask low" at its best: handled at the layer that has
          the information (knows the Bloomreach grammar), invisible above.
```

### The strong transform — McpToolError tagging

```
lib/mcp/client.ts  (lines 68–77 + 156–162)

  export class McpToolError extends Error {
    constructor(
      public readonly toolName: string,
      public readonly detail: string,
      options?: { cause?: unknown },
    ) {
      super(`${toolName} → ${detail}`, options);
      this.name = 'McpToolError';
    }
  }

  // inside liveCall:
  } catch (err) {
    this.lastCallAt = Date.now();
    // Tag transport-level failures (e.g. a 401) with the tool name so the UI
    // can show which call failed, not just a generic message.
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
       │
       └─ the error is TRANSFORMED, not masked. it still throws — callers
          have to catch it eventually — but the error now carries the
          tool name and the server's actual detail, instead of a generic
          "Unauthorized" message. the UI shows "list_projects → invalid_token"
          instead of "Unauthorized". every catch upstream gets more signal.
```

### The special case — synthesize(), in two files

```
lib/agents/diagnostic.ts  (lines 73–75)

  const diag =
    tryParseDiagnosis(finalText) ?? (await this.synthesize(anomaly, toolCalls)) ?? FALLBACK;
                                     ────────────────────────────────────────
                                     this is the special-case path

  // and the method itself (L86–L126):
  private async synthesize(anomaly: Anomaly, toolCalls: ToolCall[]): Promise<Diagnosis | null> {
    try {
      const evidence = toolCalls.map((tc, i) => {
        const payload = tc.error ? { error: tc.error } : tc.result;
        return `Query ${i + 1}: ${tc.toolName} ${JSON.stringify(tc.args).slice(0, 200)}\n` +
               `Result: ${JSON.stringify(payload).slice(0, 900)}`;
      }).join('\n\n') || '(no successful queries were completed)';

      const res = await this.anthropic.messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,
        system: 'You are concluding a completed investigation. Output ONLY a JSON diagnosis...',
        messages: [{ role: 'user', content: `Anomaly investigated:\n${...}\n\nQueries run...\n${evidence}\n\n...` }],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);
      ...
      return tryParseDiagnosis(text);
    } catch { return null; }
  }


lib/agents/recommendation.ts  (lines 69–72 + 82–132)

  const idless =
    tryParseRecommendations(finalText) ??
    (await this.synthesize(anomaly, diagnosis, toolCalls));
                                     ──────────────────────────────
                                     same special-case path

  // and the method itself: same shape. evidence serialization (same 200/900 slice),
  // anthropic.messages.create with the same model + max_tokens, same try/catch shape.
```

**The fix sketched in Move 2:** lift the recovery into `runAgentLoop` as `parseResult` + `recoveryPrompt` options, return `{ parsed: T | null, finalText, toolCalls }`. Both `synthesize()` methods delete. The agent classes pass their parser + a prompt builder; the loop owns the recovery decision.

---

## Elaborate

The deeper move with errors is to **let the boundary be the contract**. Every error-handling decision implicitly says "this is where the next layer can stop worrying." When `McpClient` masks rate-limits, the agent loop's contract is "every callTool returns or throws cleanly — no rate-limit reasoning required." When the agent class masks parse failures, the route's contract is "every scan returns an array — no try/catch needed." Boundaries with clear contracts let the rest of the code stay unconditionally clean. Boundaries with leaky error semantics force every caller to defensively re-handle the same cases.

A subtle case: `bootstrapSchema` *propagates* (lets `McpToolError` bubble) instead of masking. That's correct, because the route caller above it already has a try/catch that converts the throw into a 500 JSON response — the propagation lands in a single, well-named place. The audit isn't "mask everything"; it's "mask where the strategy makes sense, propagate where one boundary upstream already handles it." Propagation is fine when there's a designated catcher.

A non-finding worth naming as praise: the NDJSON readers in both `app/page.tsx` (L450–L456) and `lib/hooks/useInvestigation.ts` (L193–L200) both swallow malformed lines silently. That looks risky but is actually right — NDJSON streams across HTTP can have buffer boundary artifacts; swallowing a bad line and moving on is the standard pattern. This is "mask low" at the consumption boundary.

## Interview defense

**Q: What's the strongest error-handling pattern in this codebase?**
A: Rate-limit masking inside `McpClient.callTool` (`lib/mcp/client.ts` L121–L132). Bloomreach throttles aggressively (1 req per N seconds, with N as high as 10), and the natural impulse would be to throw and let callers catch + retry. Instead, the wrapper masks the error entirely — parses the retry-after window from the error prose, sleeps, retries up to three times, and returns the eventual result with the same shape as a first-try success. The agent loop above never has to know rate limits exist. That's "mask low" paying for itself — every caller in the stack is simpler because one module owns the strategy.

**Q: Walk me through a special case you'd define out of existence here.**
A: The "agent emitted no parseable JSON" recovery, currently handled with a dedicated `synthesize()` method in both `DiagnosticAgent` (`lib/agents/diagnostic.ts` L86–L126) and `RecommendationAgent` (`lib/agents/recommendation.ts` L82–L132). Two ~50-line copies of the same shape — serialize the tool-call history, run one more tool-less Anthropic call with a recovery prompt, parse the result. The fix is to lift the recovery into `runAgentLoop` itself: add a `parseResult: (text) => T | null` option and a `recoveryPrompt: (toolCalls) => string` option. The loop runs as normal, attempts to parse, and on failure runs ONE recovery turn. Both `synthesize()` methods delete. The special case isn't gone — the recovery still happens — but it's now defined out of the agents' surface and into the shared loop where it belongs.

```
Interview-defense diagram — the synthesize() collapse

  before:
  runAgentLoop → finalText (string)
                  │
                  ▼
  DiagnosticAgent       RecommendationAgent
  ├─ tryParse            ├─ tryParse
  └─ if null:            └─ if null:
       synthesize()           synthesize()
       (50 lines)              (50 lines)

  after:
  runAgentLoop → { parsed: T | null, finalText, toolCalls }
                  │
                  │  loop owns: tryParse, if null run recovery, tryParse again
                  ▼
  DiagnosticAgent       RecommendationAgent
  └─ parsed ?? FALLBACK └─ parsed ?? []

  the special case is now defined out of the agents' surface entirely.
```

## Validate

1. **Reconstruct.** Without opening the file: name the strategy `McpClient` uses for rate-limit errors (mask/transform/propagate/define-out) and the one it uses for transport errors. Why are those two strategies different at the same boundary?

2. **Explain.** The `runAgentLoop` tool execution wraps each `mcp.callTool` in a try/catch (`lib/agents/base.ts` L140–L168). What would break if you removed the try/catch and let the throw escape? (Hint: one bad tool would kill the entire investigation; the model would have no chance to react to the failure via `is_error: true`.)

3. **Apply.** Look at `lib/mcp/validate.ts`'s `parseAgentJson` (L3–L13). It has three escalating attempts to extract JSON from the model's prose — fenced block, raw JSON, substring scan. Is this special-case sprawl or a justified ladder? Defend either way.

4. **Defend.** Someone says "the two `synthesize()` methods are different — different prompts, different parsers, different return types. They can't share code." Counter using the strategy axis. (Hint: the *strategy* is the same — "if parse failed, run one tool-less recovery turn." The prompt and parser are inputs to the strategy, not part of it. Strategies abstract; inputs parameterize.)

## See also

- `03-information-hiding-and-leakage.md` — the `synthesize` duplication appears there as a logic leak.
- `04-layers-and-abstractions.md` — boundary contracts depend on which errors are masked at which layer.
- `05-pull-complexity-downward.md` — the synthesis-instruction text is partially-pushed-up complexity; the synthesize() method is fully-pushed-up.
- `08-red-flags-audit.md` — "try/except everywhere" and "special-case sprawl" red flags are scored.
