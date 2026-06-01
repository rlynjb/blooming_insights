# 05 — Edge cases and error paths

**Industry name:** Negative testing / boundary-value analysis / property-style coverage. **Type:** Industry standard.

## Zoom out, then zoom in

The happy path is usually tested. The rest isn't — empties, nulls, malformed inputs, the third retry of a rate-limited call. blooming insights does this *well* in three places (type-guard rejection paths, retry ladder, parser robustness) and *poorly* in one (every agent test asserts the parsed happy path; very few assert what happens when the parser throws on the agent's actual output).

```
Zoom out — where edge-case coverage is strong vs absent

  ┌─ STRONG: type-guard rejection paths ──────────────────────────────────┐
  │  validate.test.ts has 25 tests; ~12 of them assert REJECTION:         │
  │  isAnomalyArray rejects bad severity, bad direction, missing fields    │
  │  isDiagnosis rejects null, string, missing conclusion, non-array       │
  │  isRecommendationArray rejects bad feature, bad confidence, missing   │
  │     steps, missing range on object impact                              │
  │  parseAgentJson throws on text with no json                            │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ STRONG: the retry ladder in client.ts ───────────────────────────────┐
  │  client.test.ts has 14 tests; 5 of them exercise the rate-limit       │
  │  retry path: parse "1 per 10 second" hint → wait 10s + buffer →       │
  │  succeed and cache; parse "Retry after ~7 seconds" → honor 7s;        │
  │  no parseable hint → exponential backoff; give up after maxRetries.   │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ STRONG: parser robustness ──────────────────────────────────────────┐
  │  schema.test.ts has a dedicated "robustness" describe block (lines    │
  │  170–297) covering empty events arrays, missing event_types_overview, │
  │  missing default_group.properties, text-only fallback (no              │
  │  structuredContent). Four tests prove the parser doesn't blow up      │
  │  on degenerate inputs.                                                 │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ WEAK: agent error paths ────────────────────────────────────────────┐
  │  Agents have happy-path coverage (parse a valid JSON), no-op coverage │
  │  (parse an empty array), and fallback coverage (synthesis call when   │
  │  loop output is unusable). What's MISSING: what happens when the      │
  │  Anthropic SDK *throws* (network error, 401, rate limit on the model │
  │  itself)? No test scripts a throw from anthropic.messages.create.    │
  └────────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting mechanism is the *rejection-path discipline* in the type guards — every guard has a 1:1 acceptance test and at least one rejection test for every gate. That pattern is the right model for the rest of the codebase.

## Structure pass

**Layers:** the happy path → the empty/degenerate input → the malformed input → the throw. **Axis traced:** *what is the test asserting about the failure?* **The seams where the answer flips:**

```
The axis "what failure is being asserted?" — across input shapes

  ┌─ happy path ──────────────────────────────────────┐
  │  isDiagnosis(validDiagnosis) → true               │  assertion = success
  │  parseWorkspaceSchema(realFixture) → schema       │
  └──────────────────────┬───────────────────────────┘

  ┌─ degenerate-but-valid input ──────────────────────┐
  │  isAnomalyArray([]) → true                         │  assertion = still
  │  parseWorkspaceSchema({events: []}) → {events:[]}  │  success on empty
  └──────────────────────┬───────────────────────────┘

  ┌─ ★ malformed input (the rejection seam) ★ ─────────┐
  │  isAnomalyArray([{...badSeverity}]) → false        │  FLIP: assertion
  │  isDiagnosis(null) → false                          │  shifts from "is
  │  isDiagnosis('some string') → false                 │  this true" to "is
  │  isRecommendationArray([{...badFeature}]) → false  │  this false / does
  │                                                     │  this throw"
  └──────────────────────┬───────────────────────────┘

  ┌─ thrown error (the throw seam) ───────────────────┐
  │  parseAgentJson('no json here') → throws           │  assertion = throws
  │  c.callTool('list_…', {}) when transport throws    │  with specific
  │     → rejects with McpToolError                    │  shape
  └──────────────────────┬───────────────────────────┘

  ┌─ untested: the Anthropic throw ───────────────────┐
  │  what if anthropic.messages.create throws?         │  NO TEST asserts
  │  what does the agent do?                            │  what should happen
  └────────────────────────────────────────────────────┘
```

The seam that matters: **the rejection seam is well-defended; the Anthropic-throw seam is undefended.** Every type guard has acceptance + rejection tests. No agent test scripts a throw from the model call.

## How it works

### Move 1 — the mental model

For every gate in a validator, there are two tests: one that says "this input passes" and at least one that says "this input fails *because* of this specific gate." Drop the second test and the gate is just decoration — you don't know that the guard rejects bad severity vs that it's bypassing the severity check entirely.

```
The acceptance + rejection pair — the kernel of negative testing

  ┌─ the guard ─────────────────────────┐
  │  isAnomalyArray(v):                  │
  │    every gate:                       │
  │      v is array                      │
  │      v.every(a => ...                │
  │        typeof a.metric === 'string'  │  ← gate 1
  │        Array.isArray(a.scope)        │  ← gate 2
  │        typeof a.change.value         │  ← gate 3
  │           === 'number'               │
  │        a.change.direction in {up,    │  ← gate 4
  │           down}                       │
  │        a.change.baseline a string    │  ← gate 5
  │        SEVERITIES.includes(severity) │  ← gate 6
  │      )                                │
  └──────────────────────┬──────────────┘
                         │
                         ▼
  ┌─ the test pair per gate ───────────────────────────┐
  │  accept: isAnomalyArray([good]) → true              │
  │  reject (gate 4): isAnomalyArray([{                  │
  │    ...good[0],                                       │
  │    change: { value: 1, direction: 'sideways',       │  ← exercises ONLY
  │              baseline: '7d' }                        │     the direction
  │  }]) → false                                         │     gate
  │  reject (gate 6): isAnomalyArray([{                  │
  │    ...good[0], severity: 'huge'                      │  ← exercises ONLY
  │  }]) → false                                         │     the severity
  │                                                      │     gate
  │  reject (gate 5): isAnomalyArray([{                  │
  │    metric: 'x'                                       │  ← missing fields
  │  }]) → false                                         │     altogether
  └─────────────────────────────────────────────────────┘
```

This is the pattern. Every guard in `validate.ts` has this shape in `validate.test.ts`.

### Move 2 — the walkthrough

#### Move 2.1 — type-guard rejection: `isAnomalyArray` (the canonical example)

**The shape.** The guard is in `lib/mcp/validate.ts` lines 17–27; the tests are in `test/mcp/validate.test.ts` lines 22–30. Six gates, six paired tests (acceptance, empty, non-array, missing-field, bad direction, bad severity).

```
test/mcp/validate.test.ts (lines 22–30)

  describe('isAnomalyArray', () => {
    const good = [{ metric: 'conversion_rate', scope: ['mobile'],
                    change: { value: -18, direction: 'down', baseline: '7d' },
                    severity: 'warning', evidence: [] }];

    it('accepts a well-formed anomaly array', () => {
      expect(isAnomalyArray(good)).toBe(true);              ← acceptance
    });
    it('accepts an empty array', () => {
      expect(isAnomalyArray([])).toBe(true);                ← degenerate-valid
    });
    it('rejects a non-array', () => {
      expect(isAnomalyArray({})).toBe(false);               ← gate: array check
    });
    it('rejects a missing-field object', () => {
      expect(isAnomalyArray([{ metric: 'x' }])).toBe(false);← gate: required fields
    });
    it('rejects a bad severity', () => {
      expect(isAnomalyArray([{ ...good[0], severity: 'huge' }])).toBe(false);
                                                            ← gate: severity enum
    });
    it('rejects a bad direction', () => {
      expect(isAnomalyArray([{ ...good[0],
        change: { value: 1, direction: 'sideways', baseline: '7d' } }])).toBe(false);
                                                            ← gate: direction enum
    });
  });
       │
       └─ each rejection test KEEPS every other field valid via spread —
          that isolates the gate being tested. If you also broke another
          field, the test wouldn't tell you WHICH gate caught it.
```

**Why this matters.** If you delete the severity enum check in `validate.ts` (typo it from `SEVERITIES.includes(...)` to `true`), four tests still pass — only "rejects a bad severity" fails. The test points at the exact gate that broke.

#### Move 2.2 — `isDiagnosis` and `isRecommendationArray` (same pattern, more gates)

`isDiagnosis` has 6 tests covering: well-formed accept, empty-arrays accept, null reject, string reject, missing-conclusion reject, evidence-not-array reject. Same pattern.

`isRecommendationArray` has 9 tests covering: well-formed accept, rich object-impact accept, bad object-impact reject (missing range), empty accept, non-array reject, bad feature reject, bad confidence reject, missing steps reject. Adds an *interesting* edge case: the guard accepts both legacy `estimatedImpact: string` and the richer `estimatedImpact: { range, rangeUsd, assumption }` object — and there's a test for each, plus a test that the object form rejects when missing `range`.

```
test/mcp/validate.test.ts (lines 83–98) — the dual-shape coverage

  it('accepts the richer object estimatedImpact shape', () => {
    const rich = { ...good, estimatedImpact: {
      range: '+$14k – $23k recovered this week',
      rangeUsd: { low: 14000, high: 23000 },
      assumption: 'assumes 15–25% reactivation of ~340 buyers at ~$1,124 aov',
    }};
    expect(isRecommendationArray([rich])).toBe(true);     ← rich shape accepted
  });

  it('rejects an object estimatedImpact missing range', () => {
    expect(isRecommendationArray([{ ...good, estimatedImpact:
      { assumption: 'x' } }])).toBe(false);               ← required `range` enforced
  });
       │
       └─ this is exactly the kind of test that catches a migration bug —
          when the schema gained the rich shape, did the guard correctly
          require `range` and not silently accept `{}`?
```

#### Move 2.3 — the retry ladder (failure-mode coverage on `McpClient`)

**The shape.** When Bloomreach returns a rate-limit error, `McpClient.callTool` retries — parsing the wait hint out of the error text, capping at `retryCeilingMs`, giving up after `maxRetries`. Five tests in `client.test.ts` cover the ladder.

```
The retry-ladder test cases — each test exercises one rung

  test/mcp/client.test.ts                                      what it proves
  ────────────────────────                                     ──────────────
  (89–99)  'does not cache an error result'                    error → no
                                                                 cache poison
  (101–109) 'retries a rate-limited result then succeeds'      simple retry
                                                                 succeeds
  (111–140) 'waits the parsed retry-after window for           parsing the
            "(1 per 10 second)", then succeeds and caches'      10s window
                                                                 hint
  (142–167) 'honors an explicit "Retry after ~N seconds" hint  parsing the
            over the backoff base'                              "after ~Ns"
                                                                 hint
  (169–176) 'gives up after maxRetries and returns the         the ceiling
            error result'
```

```
test/mcp/client.test.ts (lines 111–140) — the load-bearing retry test

  it('waits the parsed retry-after window for "(1 per 10 second)", …', async () => {
    vi.useFakeTimers();                       ← time isolation
    let n = 0;
    let firstFailAt = 0;
    let retryAt = 0;
    const t = {
      async callTool() {
        n++;
        if (n === 1) {
          firstFailAt = Date.now();
          return { isError: true, content: [{ type: 'text',
            text: 'Too many requests: rate limit reached (1 per 10 second)' }] };
        }
        retryAt = Date.now();
        return { isError: false, ok: true };
      },
      async listTools() { return { tools: [] }; },
    };
    const c = new McpClient(t, { minIntervalMs: 0 });
    const p = c.callTool('x', {});
    await vi.runAllTimersAsync();             ← drains the awaited sleep
    const r = await p;
    expect((r.result as any).ok).toBe(true);
    expect(n).toBe(2);
    expect(retryAt - firstFailAt).toBeGreaterThanOrEqual(10_000);
                                              ← actually waited the 10s
                                                window, not 1.2s
    const r2 = await c.callTool('x', {});
    expect(r2.fromCache).toBe(true);          ← success was cached
  });
       │
       └─ this test asserts THREE things at once: (1) the regex pulled "10"
          out of "(1 per 10 second)", (2) the sleep actually ran for 10s in
          fake time, (3) the eventual success was cached. Lose any of the
          three and a real rate-limit will burn the retry budget.
```

#### Move 2.4 — `parseAgentJson` and the throw

**The shape.** The parser tries fenced JSON, then plain JSON, then an embedded JSON substring scan. If all three fail, it *throws*. Test asserts that.

```
test/mcp/validate.test.ts (lines 17–19)

  it('throws on text with no json', () => {
    expect(() => parseAgentJson('no json here')).toThrow();
       │
       └─ this is the "fail loudly" contract. The agent classes catch this
          throw and fall back to the synthesis call — but the test proves
          the throw HAPPENS, which is what the catch depends on.
  });
```

The agent classes (`DiagnosticAgent`, `RecommendationAgent`) build on top of this throw — they wrap `parseAgentJson` in try/catch and run a synthesis fallback when it throws. Diagnostic tests (`diagnostic.test.ts` lines 273–291) exercise this fallback path: loop returns unparseable text, dedicated synthesis call returns valid JSON, agent returns the synthesized result. That covers the *catch* side of the throw contract.

#### Move 2.5 — the gap: untested error path on `anthropic.messages.create`

**The shape that doesn't exist.** No test scripts a *throw* from `anthropic.messages.create`. Every scripted-Anthropic fake returns a response; none throw. If the Anthropic SDK throws (network down, 401 on a stale API key, 429 on the model), the agent's behaviour is undefined-by-test.

```
What the missing test would look like (pseudocode)

  it('rejects with a useful error when anthropic.messages.create throws', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('Anthropic API: 401 Unauthorized')
        })
      }
    };
    const agent = new DiagnosticAgent(anthropic as any, buildFakeMcp(),
                                       FIXTURE_SCHEMA, FAKE_TOOL_DEFS);
    await expect(agent.investigate(SAMPLE_ANOMALY)).rejects.toThrow(/Unauthorized/);
                                          ← OR: returns the fallback diagnosis,
                                            OR: catches and emits an error event.
                                          The behaviour isn't specified anywhere.
  });
       │
       └─ this test would force the team to DECIDE what should happen when
          the model itself is unreachable. Today the answer is "whatever
          happens to happen" — likely an uncaught exception propagating to
          the route handler, which then 500s.
```

**Why this matters.** The whole point of the agent's `synthesize()` fallback is graceful degradation when the parsed output is bad. But there's no equivalent fallback when the *call itself* fails. That asymmetry is invisible until production, where it shows up as 500-ing investigations.

### Move 2 variant — the load-bearing skeleton of negative testing

What is the minimum that makes negative testing useful?

1. **An acceptance test, so you know the guard *can* return true.** Without it, a guard that always returns false also passes every rejection test. Drop this and you can't tell "always rejects" from "rejects this specific bad input."

2. **At least one rejection test per gate, isolating that gate.** Use spread to keep every *other* field valid. Drop this and you can't tell which gate caught the bad input — could be the one you're testing or could be a different one upstream.

3. **A test that asserts the *kind* of failure.** `.toBe(false)` for guards, `.toThrow(/specific message/)` for throws, `.rejects.toThrow()` for async. Drop this and "the function didn't return success" includes both "rejected for the right reason" and "blew up at the wrong gate."

Skeleton = positive-control + isolated-rejection-per-gate + specific-failure-shape. Drop any one and the rejection coverage is decoration.

### Move 3 — the principle

**Test the failure modes, not just the success modes.** A function is defined by what it accepts *and* what it rejects; testing only the accept side documents half the contract. The pattern that works: for every gate, write a test that fails *only* because of that gate. The discipline scales — apply it to the type guards (done well here), then to the agent error paths (gap here), then to the route handlers (gap here too).

## Primary diagram

The edge-case + error-path coverage map for blooming insights:

```
Edge case / error path coverage — the rejection map

  ┌─ STRONG ─────────────────────────────────────────────────────────────┐
  │                                                                       │
  │  validate.ts type guards                                              │
  │    ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  25 tests, ~half rejection paths        │
  │       isAnomalyArray   (6 tests)   bad severity, direction, …          │
  │       isDiagnosis      (6 tests)   null, string, missing field          │
  │       isRecommendationArray (9)    bad feature, confidence, range       │
  │       parseAgentJson   (5 tests)   throws on unparseable                 │
  │                                                                       │
  │  client.ts retry ladder                                                │
  │    ▌▌▌▌▌▌▌▌▌▌▌▌▌▌  14 tests, 5 retry-path                              │
  │       parse "10 second", "after ~7s", no-hint backoff, ceiling, cache  │
  │       not poisoned, give up at maxRetries                              │
  │                                                                       │
  │  schema.ts robustness                                                  │
  │    ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  24 tests, 4 robustness-path                     │
  │       empty events, missing event_types_overview,                      │
  │       missing default_group.properties, text-only fallback             │
  │                                                                       │
  │  base.ts agent loop                                                    │
  │    ▌▌▌▌▌▌▌▌  8 tests, 1 error-path                                     │
  │       mcp.callTool throws → recorded as error, loop continues          │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  ┌─ GAP ────────────────────────────────────────────────────────────────┐
  │                                                                       │
  │  anthropic.messages.create throws (network, 401, model 429)           │
  │    ▌  0 tests                                                          │
  │    Behaviour undefined: likely uncaught exception → route 500          │
  │                                                                       │
  │  NDJSON stream truncated mid-flight (client disconnects)              │
  │    ▌  0 tests (also: no NDJSON stream tests at all)                    │
  │                                                                       │
  │  Concurrent investigations on the same insight (race)                 │
  │    ▌  0 tests                                                          │
  │                                                                       │
  │  OAuth callback with mismatched state (CSRF)                          │
  │    ▌  1 partial test (consumeState in auth.test.ts), but no end-to-end │
  │       callback test that asserts the rejection actually fails the flow │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the dual-shape `estimatedImpact` rejection in `validate.ts`.**

```
lib/mcp/validate.ts  (lines 42–57)

  export function isRecommendationArray(v): v is Omit<Recommendation, 'id'>[] {
    return Array.isArray(v) && v.every((r) => {
      const x = r as any;
      // estimatedImpact may be the legacy string OR the richer { range, ... } shape
      const impactOk =
        typeof x.estimatedImpact === 'string' ||
        (!!x.estimatedImpact && typeof x.estimatedImpact === 'object'
         && typeof x.estimatedImpact.range === 'string');     ← the gate
      return !!x && typeof x === 'object'
        && typeof x.title === 'string'
        && typeof x.rationale === 'string'
        && FEATURES.includes(x.bloomreachFeature)
        && Array.isArray(x.steps)
        && impactOk
        && CONFIDENCE.includes(x.confidence);
    });
  }
       │
       └─ four interesting gates: legacy string OK, rich object OK iff has
          range, neither without title/rationale/feature/steps/confidence.

test/mcp/validate.test.ts  (lines 84–98)

  it('accepts the richer object estimatedImpact shape', () => {
    …expect(isRecommendationArray([rich])).toBe(true);
  });

  it('rejects an object estimatedImpact missing range', () => {
    expect(isRecommendationArray([{ ...good, estimatedImpact:
                                  { assumption: 'x' } }])).toBe(false);
       │
       └─ this is the one that catches a regression where someone refactors
          the gate to typeof x.estimatedImpact === 'object' and drops the
          range check — every other test still passes.
  });
```

**Use case B — the agent-loop error path in `base.ts`.**

```
test/agents/base.test.ts  (lines 182–214)

  it('records tool error and continues when mcp.callTool throws', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      { content: [toolUseBlock('tu2', 'get_project_overview', { project_id: 'x' })],
        stop_reason: 'tool_use' },
      { content: [textBlock('recovered after error')], stop_reason: 'end_turn' },
    ]);

    const mcp = buildFakeMcp(async () => {
      throw new Error('MCP transport failed');               ← script the throw
    });

    const result = await runAgentLoop({ … });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toBeDefined();
    expect(result.toolCalls[0].error).toContain('MCP transport failed');
    expect(result.finalText).toContain('recovered after error');
    expect(callCount()).toBe(2);
       │
       └─ this proves THREE behaviours of the loop's error handling:
          (1) the error is captured into ToolCall.error (not silently dropped)
          (2) is_error: true is sent back to the model as a tool_result
          (3) the loop CONTINUES — the model gets a chance to recover
          Without this test, a refactor could break any of the three silently.
  });
```

## Elaborate

The pair "acceptance + per-gate rejection" is descended from boundary-value analysis (Glenford Myers, *The Art of Software Testing*, 1979). The variant that uses object spread to isolate one gate at a time is property-style coverage in disguise — you're holding every other property valid while varying one. Pushed further, this is what `fast-check` (property-based testing in JS) generates automatically, but for small enums and known shapes, the hand-rolled pattern in `validate.test.ts` is more readable and just as tight.

Cross-reference: `study-software-design`'s "deep interface, shallow implementation" principle — the type guards in `validate.ts` are deep (a small interface: `(v: unknown) => v is T`) and the rejection tests are the leverage that makes the depth real. A shallow interface (one method per gate) would require N times the tests for the same coverage.

## Interview defense

**Q: What's the single highest-leverage edge case still untested?** `anthropic.messages.create` throwing. Every scripted-Anthropic fake returns a response; none throw. If the SDK throws — network blip, expired key, model-side 429 — the agent's behaviour is whatever happens to happen. Probably an uncaught exception bubbling to the route handler, which 500s. A two-test fix would specify the contract: either "agent rejects with a useful error" or "agent emits an error event and returns the fallback diagnosis." Today neither is locked.

```
The contract gap — what's specified vs what isn't

  WHAT IS TESTED                    WHAT ISN'T
  ──────────────                    ──────────
  mcp.callTool throws               anthropic.messages.create throws
   → toolCall.error captured        → undefined
   → is_error: true forwarded       → undefined
   → loop continues                 → undefined
  (base.test.ts lines 182–214)
```

**Q: Why is `isAnomalyArray` better tested than the parser fallback path in `parseWorkspaceSchema`?** Surface area. The type guard has 6 named gates; the parser has a tree of conditionals (`structuredContent ?? JSON.parse(content[0].text) ?? throw`). The guard tests are the *paradigm* — one rejection per gate. The schema robustness tests cover the obvious degenerates (empty events, missing fields, no `structuredContent`) but don't enumerate every conditional branch the way the guard tests do. Honest gap.

**Q: Object spread to isolate one gate — why does that matter?** Because if you write `isAnomalyArray([{ severity: 'huge' }])` you've broken severity AND the metric, scope, change fields. The test fails — but you don't know whether the severity check caught it or one of the missing required fields did. With spread (`{ ...good[0], severity: 'huge' }`), only severity is bad; if the test fails, it's because of the severity gate specifically.

## Validate

1. **Reconstruct:** Without looking, list the four "rung" tests in `client.test.ts` retry ladder and what each proves.
2. **Explain:** Why does `isAnomalyArray`'s "rejects bad severity" test use object spread instead of writing the object literal from scratch?
3. **Apply:** Write the missing test for `anthropic.messages.create` throwing in `DiagnosticAgent.investigate`. Decide what the agent SHOULD do (reject, emit error event, or fall back to synthesis) and justify the choice.
4. **Defend:** A reviewer says the four `schema.ts` robustness tests are redundant — "the type system already says `events: Event[]`." Push back with the "type doesn't validate runtime input from MCP" argument.

## See also

- [03-tests-as-design-pressure.md](03-tests-as-design-pressure.md) — the `McpCaller` interface is what lets `base.test.ts` script a tool throw
- [04-determinism-isolation-and-flakiness.md](04-determinism-isolation-and-flakiness.md) — `vi.useFakeTimers` is the isolation tool the retry ladder tests depend on
- [06-testing-ai-features.md](06-testing-ai-features.md) — the synthesis-fallback path is the agent-layer counterpart to the parser throw
