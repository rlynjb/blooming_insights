# Pull complexity downward

**Industry name(s):** "Pull complexity downward" · sensible defaults · the lower-layer-decides principle · avoidable configuration
**Type:** Industry standard · Language-agnostic

> When a module could decide something itself but instead asks its caller to decide, complexity has been pushed *upward* — every caller now carries a decision the module had enough information to make. The right move is to pull that decision into the module. blooming insights mostly does this well — `McpClient` defaults nearly all its knobs sensibly, and the agent classes hide their max-turn budgets. The two findings worth naming: `cacheTtlMs` is exposed at the call site (one caller actually overrides it), and the synthesis prompts in each agent are hardcoded inline instead of derived from the agent's role.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Configuration in this codebase shows up in three places: **constructor options** (most knobs land here, defaulted), **per-call options** (a few specific decisions land here), and **inline literals** (a handful of magic numbers and string prompts sit in the call sites themselves). The healthy default is that callers pass almost nothing — the module decides. The exceptions are worth naming.

```
Zoom out — where configuration lives

┌─ Per-call options (bleeds the most) ──────────────────────────┐
│  mcp.callTool(name, args, opts?)                              │
│    opts.cacheTtlMs    ← knob pushed up                         │ ← we are here
│    opts.skipCache     ← knob pushed up (debug-only — earned)   │
│  runAgentLoop({ maxTurns, maxToolCalls, synthesisInstruction })│
│    ← all of these are agent-class decisions, not loop decisions│
└──────────────────────────┬────────────────────────────────────┘
                           │ uses
┌─ Constructor options (well-defaulted) ────────────────────────┐
│  new McpClient(transport, {                                   │
│    minIntervalMs?: 200,                                       │
│    maxRetries?:    3,                                         │
│    retryDelayMs?:  10_000,                                    │
│    retryCeilingMs?: 20_000                                    │
│  })                                                           │
│  → defaults work; production overrides only when it must      │
└──────────────────────────┬────────────────────────────────────┘
                           │ used by
┌─ Inline literals (smell when role-coupled) ───────────────────┐
│  MAX_TOOL_RESULT_CHARS = 16_000     (base.ts L29)             │
│  AGENT_MODEL = 'claude-sonnet-4-6'  (base.ts L9)              │
│  REPLAY_DELAY_MS = 180              (route L105)              │
│  the synthesisInstruction strings inside each agent class     │
│  → some are fine; the synthesis strings are the leak          │
└───────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: for each knob a module exposes, did the module *have* to expose it, or could the module have decided itself? A knob the module could have decided is "complexity pushed upward" — every caller now carries a decision the module didn't need to delegate. The fix is mechanical: change the parameter to a default, and let the rare caller override only when needed. The next sections walk three actual knobs in this repo, decide who should own each, and name the one place where the default is wrong.

---

## Structure pass

**Layers.** Three layers of configuration in this codebase: per-call options (most fluid, most leakage potential), constructor options (least leakage, default-driven), and inline literals (least fluid, but smell when they encode role-specific decisions). The question changes shape at each layer.

**Axis: who has enough information to decide.** For each knob, ask: does the module itself have enough information to pick a sensible default? If yes, expose nothing (or a default). If no — the decision genuinely depends on the caller's context — expose the knob. This is the right axis because it's the only one that distinguishes "necessary configuration" from "complexity pushed upward." Cost is wrong (defaults are free); guarantees is wrong (most knobs don't change guarantees). Information ownership is the test.

**Seams.** Two seams matter. **Seam 1: McpClient ↔ its callers.** Mostly the lower layer (McpClient) has enough info to decide — and does (spacing, retry, ceilings). The one exception is `cacheTtlMs`, which the route handler genuinely should be able to override for one specific case (the `/debug` force-fresh path). That's an earned knob. The audit catches that and lets it through. **Seam 2: runAgentLoop ↔ the four agent classes.** The loop exposes `maxTurns`, `maxToolCalls`, and `synthesisInstruction` — and that's correct, because the agent (not the loop) is the one who knows the role's tolerable depth and the role's recovery wording. So those knobs ARE pushed up correctly. The smell isn't the knob; it's that *the synthesis strings are inline* in each agent class rather than derived from the agent's role.

```
Structure pass — who should own each knob

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Per-call opts · Constructor opts · Inline literals       │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  who has enough information to decide?                    │
│  module has it → default. caller has unique context → knob│
└─────────────────────────────┬────────────────────────────┘
                              │  trace at each seam
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: McpClient ↔ callers   MOSTLY HEALTHY                │
│      knobs: minIntervalMs, maxRetries, retryDelayMs,     │
│             retryCeilingMs — all defaulted, prod tunes    │
│      one exception: cacheTtlMs (earned — /debug uses it)  │
│  S2: runAgentLoop ↔ agents HEALTHY ON KNOBS, LEAKY STR   │
│      knobs: maxTurns, maxToolCalls — correctly pushed up  │
│      smell: synthesisInstruction is inline in each agent  │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the "who decides" question

You know how `JSON.stringify(value)` works without you passing a "should I pretty-print?" flag every time? It picked a default (compact). When you actually want pretty-printed output, you pass `(value, null, 2)`. The 99% case has zero ceremony; the 1% case has explicit ceremony. That's pull-complexity-downward — the module decided, and the caller opts out only when context demands.

```
Pull-complexity-downward — picture

  WRONG (complexity pushed up)
  ┌─ every caller ─────────────────┐
  │ mcp.callTool('x', args, {       │
  │   cacheTtlMs: 60_000,           │   ← every caller picks
  │   minIntervalMs: 200,            │     the same number
  │   maxRetries: 3,                  │
  │   retryDelayMs: 10_000           │
  │ })                                │
  └────────────────────────────────┘

  RIGHT (complexity pulled down)
  ┌─ every caller ─────────────────┐
  │ mcp.callTool('x', args)         │   ← no knobs
  └─────────────────┬───────────────┘
                    ▼
  ┌─ module decides ───────────────┐
  │ - default ttl 60s              │
  │ - default spacing 200ms        │   ← module knows enough to pick
  │ - default retries 3            │
  │ - prod overrides at start-up    │
  └────────────────────────────────┘
```

### Move 2 — what blooming insights does well

**McpClient's constructor defaults.** Every knob in `ClientOpts` is optional, with a default the wrapper picked from the real production constraints (Bloomreach's observed 1-per-10-second window for the retry delay, a 1.1s spacing in production).

```
McpClient's knobs — all defaulted

  constructor signature:
    new McpClient(transport, opts: ClientOpts = {})

  knobs available:                         defaults:
  ┌────────────────────────────────────┐  ┌─────────────┐
  │ minIntervalMs    spacing gate       │  │ 200         │
  │ maxRetries       retry budget        │  │ 3           │
  │ retryDelayMs     fallback wait       │  │ 10_000      │
  │ retryCeilingMs   cap on any wait     │  │ 20_000      │
  └────────────────────────────────────┘  └─────────────┘

  production caller (connect.ts L91–L96) overrides only because
  the prod-vs-test constraints differ:
    new McpClient(transport, {
      minIntervalMs: 1100,    ← prod-specific (alpha server rate-limits hard)
      retryDelayMs: 10_000,   ← matches the observed window
      retryCeilingMs: 20_000,
      maxRetries: 3,
    })
       │
       └─ this is the GOOD pattern: defaults work for tests; production
          overrides at construct-time once; per-call code never touches it.
```

**runAgentLoop's maxTurns / maxToolCalls.** These ARE pushed up to the four agent classes — and that's correct, because the loop has no idea what role it's running. A monitoring scan can spend 6 tool calls; a coordinator query might need 6 too; a recommendation step lives within 4. The loop doesn't know the role's tolerable depth, but the agent does.

```
runAgentLoop's knobs — pushed up CORRECTLY

  loop signature:
    runAgentLoop({ maxTurns?: 8, maxToolCalls?, synthesisInstruction?, ... })

  who decides? the agent class — because the loop has no role knowledge.

    MonitoringAgent.scan:        maxToolCalls: 6
    DiagnosticAgent.investigate: maxToolCalls: 6
    RecommendationAgent.propose: maxToolCalls: 4
    QueryAgent.answer:            maxToolCalls: 6

  these numbers differ because the roles differ. the loop COULD NOT
  have picked a single sensible default that works for all four.
  this is a knob that's correctly pushed up — the agent has unique
  context the loop lacks.
```

### Move 2 — the one earned per-call knob

**`cacheTtlMs` on callTool.** This is exposed because *one* caller has a genuine reason to override — the `/debug` page wants to force-fresh a tool call to bypass the cache.

```
The earned per-call knob

  mcp.callTool(name, args, options?)
    options.cacheTtlMs   ← can override per-call
    options.skipCache    ← can bypass cache entirely

  who uses it?
    grep across the codebase shows:
    - /api/mcp/call/route.ts uses skipCache for /debug force-fresh
    - the agents NEVER override either

  test of "is this knob earned": is there a caller that genuinely
  needs to override?
    YES (the /debug fresh-fetch path)
    → knob earned, stays
```

The cushion this gives: the default TTL (60s) is right for every other caller; the override path is one specific feature with a real reason. That's the pattern — a knob exists *because* one caller has unique context.

### Move 2 — the leak (the only real finding)

**Synthesis-instruction strings, inline in each agent.** Each agent class hardcodes its `synthesisInstruction` string at the call site. That's a knob pushed up *correctly* (the loop can't know the role), but the *value* is inline rather than derived from the agent's role.

```
The synthesis-string leak

  lib/agents/monitoring.ts  L102–L105
    synthesisInstruction:
      'You have NO more tool calls available. Stop querying now and output ' +
      'your final answer. Respond with ONLY a JSON array of anomaly objects ' +
      'in a ```json fence (or [] if nothing meaningful), based on the data ' +
      'you have already gathered. Do not say you need more queries.',

  lib/agents/diagnostic.ts  L63–L67
    synthesisInstruction:
      'You have NO more tool calls available. Stop investigating now and ' +
      'output your final answer. Respond with ONLY a single JSON object in ' +
      'a ```json fence matching the diagnosis shape (conclusion, evidence, ' +
      'hypothesesConsidered). Base it on the evidence you have already ' +
      'gathered — state your best-supported explanation, even if partial. ' +
      'Do not say you need more queries.',

  lib/agents/recommendation.ts  L58–L62
    synthesisInstruction:
      'You have NO more tool calls available. Stop querying now and output ' +
      'your final answer. Respond with ONLY a JSON array of at most 3 ' +
      'recommendation objects in a ```json fence (or [] if you cannot ' +
      'propose grounded actions), based on the diagnosis and the data you ' +
      'have already gathered. Do NOT include an id field. Do not say you ' +
      'need more queries.',

  lib/agents/query.ts  L42–L44
    synthesisInstruction:
      'You have NO more tool calls available. Now answer the user question ' +
      'directly and concisely in plain prose, citing the key numbers you ' +
      'found. Do not say you need more queries.',

       │
       └─ FOUR copies of "You have NO more tool calls available..." prefix
          THREE copies of "based on the data you have already gathered" tail
          FOUR copies of "Do not say you need more queries" closer

  the agent-specific part is the OUTPUT SHAPE INSTRUCTION (json array of
  anomalies vs json object diagnosis vs json array of recommendations vs
  plain prose). that's a small string per agent. the rest is shared.
```

**Why this is "complexity pushed up that the module could own":** `runAgentLoop` *could* own the shared shell ("You have NO more tool calls available..." + "Do not say you need more queries"), and each agent could pass just the output-shape clause. Or — even cleaner — `runAgentLoop` could accept a `synthesisOutputShape` enum and derive the full string itself. The reason this is a "pull down" finding rather than just a duplication finding (file 03) is that the agent has no genuine context the loop lacks — the boilerplate prefix and closer are role-independent.

```
Fix sketch

  // lib/agents/base.ts
  function buildSynthesisInstruction(shape: string): string {
    return [
      'You have NO more tool calls available.',
      'Stop now and output your final answer.',
      shape,                                        ← the only role-specific part
      'Do not say you need more queries.',
    ].join(' ');
  }

  // lib/agents/diagnostic.ts
  synthesisInstruction: buildSynthesisInstruction(
    'Respond with ONLY a single JSON object in a ```json fence matching ' +
    'the diagnosis shape...'
  ),
```

The agent now passes only the shape clause; the rest lives in the loop. One copy of the shared text.

### Move 3 — the principle

The right question isn't "should this be configurable?" — it's "*who has the information to make the decision*?" If the module has it, the module owns the default and the knob disappears (or becomes a rarely-used override). If only the caller has it, the knob earns its place. Most knobs in a young codebase are pushed-up complexity in disguise — the module had enough info but the author didn't want to pick. Picking is the job.

---

## Primary diagram

All exposed knobs in this codebase, with the "who decides" verdict:

```
Configuration audit — who decides

  MCP CLIENT KNOBS
  ──────────────────────────────────────────────────────────────────
  minIntervalMs      defaulted  ★ healthy (module decides)
  maxRetries         defaulted  ★ healthy
  retryDelayMs       defaulted  ★ healthy (Bloomreach window)
  retryCeilingMs     defaulted  ★ healthy
  cacheTtlMs         per-call   ★ EARNED (/debug fresh-fetch path)
  skipCache          per-call   ★ EARNED (same)

  RUNNAGENTLOOP KNOBS
  ──────────────────────────────────────────────────────────────────
  maxTurns           per-call   ★ EARNED (role-specific budget)
  maxToolCalls       per-call   ★ EARNED (role-specific budget)
  maxTokens          defaulted  ★ healthy
  synthesisInstruction per-call ⚠ LEAK (shared boilerplate inline ×4)

  INLINE LITERALS
  ──────────────────────────────────────────────────────────────────
  MAX_TOOL_RESULT_CHARS = 16_000   module-private  ★ healthy
  AGENT_MODEL = 'claude-sonnet-4-6' module-private  ★ healthy
  REPLAY_DELAY_MS = 180             route-private   ★ healthy
  RETRY_BUFFER_MS = 500             module-private  ★ healthy

  MONITORING / DIAGNOSTIC / RECOMMENDATION CLASS CONSTRUCTORS
  ──────────────────────────────────────────────────────────────────
  anthropic, mcp, schema, allTools  ★ EARNED (all injected for testability)
```

---

## Implementation in codebase

### The healthy default — `McpClient` constructor

```
lib/mcp/client.ts  (lines 79–95)

  export class McpClient {
    private cache = new Map<...>();
    private lastCallAt = 0;
    private minIntervalMs: number;
    private maxRetries: number;
    private retryDelayMs: number;
    private retryCeilingMs: number;

    constructor(private transport: McpTransport, opts: ClientOpts = {}) {
      this.minIntervalMs = opts.minIntervalMs ?? 200;
      this.maxRetries = opts.maxRetries ?? 3;
      // Bloomreach's observed penalty window is ~10s ("1 per 10 second"), so a
      // fixed sub-second retry just burns the attempt inside the same window.
      // Default the fallback base to that window; the parsed hint is preferred.
      this.retryDelayMs = opts.retryDelayMs ?? 10_000;
      this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
    }
       │
       └─ every knob defaulted. callers can construct with `new McpClient(transport)`
          and get production-sane behavior. the comment above retryDelayMs is the
          load-bearing detail: the default IS the production constraint, learned
          from observing the real server. that's the module owning what it knows.
```

### The earned override — production tuning at construction

```
lib/mcp/connect.ts  (lines 89–96)

  return {
    ok: true,
    mcp: new McpClient(new SdkTransport(client, httpErrors), {
      minIntervalMs: 1100,        ← production override (the prod server runs at ~1 req/s)
      retryDelayMs: 10_000,
      retryCeilingMs: 20_000,
      maxRetries: 3,
    }),
  };
       │
       └─ overrides happen ONCE, at construction, in a single file the
          caller route never touches. per-call code in the agents never
          worries about retry strategy.
```

### The leak — the synthesis instruction repetition

```
lib/agents/diagnostic.ts  (lines 51–68)

  const { finalText, toolCalls } = await runAgentLoop({
    anthropic: this.anthropic,
    mcp: this.mcp,
    agent: 'diagnostic',
    system,
    userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',
    toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),
    onToolCall: hooks.onToolCall,
    onText: hooks.onText,
    onToolResult: hooks.onToolResult,
    maxTurns: 8,
    maxToolCalls: 6,
    synthesisInstruction:                                           ← inline string starts
      'You have NO more tool calls available. Stop investigating now and output your final answer. ' +
      'Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape ' +
      '(conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — ' +
      'state your best-supported explanation, even if partial. Do not say you need more queries.',
  });
       │
       │  the BOLDED parts are shared across all four agents:
       │    'You have NO more tool calls available.'
       │    'Do not say you need more queries.'
       │
       │  the UNIQUE part is the shape clause in the middle:
       │    'Respond with ONLY a single JSON object in a ```json fence matching ...'
       │
       └─ the loop COULD own the prefix + closer; the agent COULD pass just the shape.
          today the prefix + closer is duplicated four times.
```

**The fix is small (~10 lines of code added to `base.ts`, ~50 lines of strings deleted across the four agents) and worth it because it consolidates "what the synthesis call asks of the model" in one place — change the recovery wording later and one file changes.**

---

## Elaborate

The deeper principle behind pull-complexity-downward is **information ownership**. A module that has the information to decide *should* decide; pushing the decision up means every caller has to learn the information the module already had. That's why the test is "does the module have enough info?" rather than "is this knob useful?" — knobs are always *useful*, the question is whether they're *necessary*.

A subtle case worth naming: the agent's `synthesisInstruction` is genuinely complex because the recovery prompt has to specify the output shape (JSON object vs JSON array of N items vs plain prose). The loop doesn't know the shape. So the knob *does* belong at the agent layer — what's wrong is only that the surrounding boilerplate is duplicated. This is why the audit calls it a leak rather than a fully pushed-up knob. The right fix is partial extraction, not full extraction. Knowing the difference is the skill.

A non-finding worth naming as praise: the `bootstrapSchema` cache in `lib/mcp/schema.ts` is a *module-level* variable (`let cached: WorkspaceSchema | null = null`), not a constructor option. That's pulled-down to its limit — no caller knows the cache exists or could ask to invalidate it (except the test-only `_resetSchemaCache()` helper). The whole "should the schema be cached?" decision lives in one file, decided once, with one escape hatch for tests. Textbook.

## Interview defense

**Q: How do you decide whether a parameter belongs on the call site or as a constructor default?**
A: I ask who has the information to make the decision. If the answer is "the module itself" — it has enough info to pick a sensible default — then the parameter belongs as a default, ideally hidden entirely unless rare overrides are needed. If the answer is "only the caller has this context," the knob belongs on the call site. `McpClient.minIntervalMs` is the first case — the module knows the Bloomreach rate limit, so it picks 1100ms in production. `runAgentLoop.maxToolCalls` is the second — the loop has no idea what role it's running, but the agent knows. Same shape of decision, different ownership.

**Q: Walk me through a place this codebase pushed complexity up when it shouldn't have.**
A: The `synthesisInstruction` string in the four agent classes (`monitoring.ts` L102, `diagnostic.ts` L63, `recommendation.ts` L58, `query.ts` L42). Each one starts with "You have NO more tool calls available..." and ends with "Do not say you need more queries." Four copies of the same boilerplate, inline. The shape-of-output clause in the middle genuinely *does* belong at the agent layer — only the agent knows whether it wants a JSON object or a JSON array of 3 items. But the boilerplate is shared and lives nowhere. The fix is to add `buildSynthesisInstruction(shape: string)` to `runAgentLoop`, take the shape clause as the only agent input, and delete the four copies of the prefix/closer.

```
Interview-defense diagram — partial pull-down

  before:
  monitoring.ts:   [PREFIX] + [shape A] + [CLOSER]   ← all inline
  diagnostic.ts:   [PREFIX] + [shape B] + [CLOSER]   ← all inline
  recommend.ts:    [PREFIX] + [shape C] + [CLOSER]   ← all inline
  query.ts:        [PREFIX] + [shape D] + [CLOSER]   ← all inline

  after:
  base.ts:         buildSynthesisInstruction(shape) = [PREFIX] + shape + [CLOSER]
  monitoring.ts:   synthesisInstruction: build('shape A')
  diagnostic.ts:   synthesisInstruction: build('shape B')
  recommend.ts:    synthesisInstruction: build('shape C')
  query.ts:        synthesisInstruction: build('shape D')

  prefix + closer now live in one place. shape (the role-specific part) stays
  at the agent. partial pull-down — only what the loop has info to own.
```

## Validate

1. **Reconstruct.** Without opening the file: name two knobs `McpClient` exposes that ARE earned (per-call, can't be defaulted) and one knob that's defaulted but production overrides at construction.

2. **Explain.** Why is `runAgentLoop.maxToolCalls` a correctly pushed-up knob, even though the four agents each pass a literal number?

3. **Apply.** Look at `lib/agents/base.ts` constants (`AGENT_MODEL`, `MAX_TOOL_RESULT_CHARS`). Should either be a constructor option of `runAgentLoop`? Decide using the "who has the information" test.

4. **Defend.** Someone says "let's make the synthesis prefix a constant `SYNTHESIS_PREFIX` in `base.ts` so the agents can just concatenate it themselves." Argue why that's worse than `buildSynthesisInstruction(shape)`. (Hint: the constant approach still leaves every agent constructing the full string; the function ensures the prefix and closer can never drift. Also, the function is the seam if a future agent needs a different prefix.)

## See also

- `03-information-hiding-and-leakage.md` — the synthesis-string leak reappears as duplication of role-independent text.
- `04-layers-and-abstractions.md` — the agent classes earn their layer through transformation; the synthesis string is the one place the layer didn't pull its weight.
- `08-red-flags-audit.md` — "configuration parameter" red flag is scored.
