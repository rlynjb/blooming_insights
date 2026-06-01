# Information hiding and leakage

**Industry name(s):** Information hiding · encapsulation · the "same knowledge in two places" smell · temporal decomposition
**Type:** Industry standard · Language-agnostic

> Information hiding is the engine that makes deep modules possible — a decision that lives in one module and is invisible elsewhere. Leakage is the failure: a fact known in two modules that forces them to change together. The strongest hiding example in blooming insights is `McpClient`'s retry-after parsing (no caller knows the Bloomreach error grammar). The worst leak is the Insight↔Anomaly field list — the same set of fields is encoded in three places (`anomalyToInsight`, `insightToAnomaly`, the `Insight` interface itself).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Information hiding shows up as a vertical question at every layer boundary: at each band edge, which side knows which fact? The healthy hides in this codebase concentrate in the **MCP wrapper band** (the cache key format, the retry-after parsing, the spacing window — all invisible above) and the **agent loop band** (the Anthropic tool-use protocol — invisible to the four agent classes). The leaks concentrate at one specific seam: the **route ↔ state ↔ agent boundary**, where the Insight/Anomaly mapping crosses three files instead of one.

```
Zoom out — hides and leaks by layer

┌─ UI client band ───────────────────────────────────────────────┐
│  app/page.tsx                                                  │
│  — knows the NDJSON event grammar (LEAK — see file 04)          │
│  — knows the reconnect regex (acceptable — local to error case) │
└──────────────────────────┬─────────────────────────────────────┘
                           │ NDJSON
┌─ Route handler band ─────▼─────────────────────────────────────┐
│  app/api/agent/route.ts                                        │
│  — knows the Insight → Anomaly shape (LEAK #1)                  │
│  — knows the AgentEvent.type tags by name (LEAK #2 — filterByStep)│
└──────────────────────────┬─────────────────────────────────────┘
                           │ runAgentLoop(opts)
┌─ Agent loop band ────────▼─────────────────────────────────────┐
│  runAgentLoop hides: the Anthropic tool-use protocol           │
│                       ★ STRONG HIDING ★                        │
│  monitoring/diagnostic/recommendation/query: all 4 see only    │
│  "give me a tool subset, give me a prompt, get finalText"      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ mcp.callTool(...)
┌─ MCP wrapper band ───────▼─────────────────────────────────────┐
│  McpClient hides:                                              │
│  — cache key construction (`${name}:${JSON.stringify(args)}`)  │
│  — Bloomreach retry-after error grammar                         │  ← strongest hide in the repo
│  — spacing gate semantics (1.1s minimum)                        │
│  — write-on-success-only cache discipline                       │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when a fact about the system changes, how many files have to change with it? A well-hidden fact lives in one file — change Bloomreach's retry-after format and only `McpClient` cares. A leaked fact lives in two or three — add a field to `Insight` and three files have to remember to copy it. The next sections walk both sides: the hides that make the deep modules deep, and the leaks that make the round-trips fragile.

---

## Structure pass

**Layers.** Same four-layer stack as elsewhere: UI client → route handler → agent loop → MCP wrapper. But the *interesting* layers for hiding/leaking are pairs of adjacent layers — the question is which side of each boundary owns each fact.

**Axis: knowledge ownership.** For each fact, which module owns it (i.e., which is the only one allowed to know it)? This is the right axis because hiding and leakage are *literally* questions about ownership. Cost is wrong (most facts are free to know); control is wrong (whoever decides isn't always whoever owns the data). Knowledge ownership pops the seams: at every layer boundary you ask "which side owns this fact?" — and a leak is when both sides own it.

**Seams.** Three seams matter here. **Seam 1: McpClient ↔ everyone above it.** Owns: cache keys, retry parsing, spacing window. Hidden cleanly — strongest hide in the repo. **Seam 2: runAgentLoop ↔ the four agent classes.** Owns: the Anthropic tool-use loop, the forceFinal trick, the budget enforcement. Hidden cleanly — second-strongest. **Seam 3: state module ↔ route handler ↔ agent.** Owns: nothing cleanly. The Insight/Anomaly mapping crosses three files; the field list is encoded in `anomalyToInsight` (state), `insightToAnomaly` (route), and the `Insight` interface itself (types). Three copies of the same knowledge. That's the leak.

```
Structure pass — knowledge ownership

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  UI · Route · Agent loop · MCP wrapper                    │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  knowledge ownership: which module owns this fact?        │
│  hidden = one owner; leaked = ≥2 owners                   │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across seams
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: McpClient ↔ callers     ★ HIDDEN (retry grammar)    │
│  S2: runAgentLoop ↔ agents   ★ HIDDEN (tool-use protocol)│
│  S3: state ↔ route ↔ agent    ★ LEAKED (Insight↔Anomaly) │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the hide-or-leak picture

You know how `localStorage.setItem(key, value)` works without you knowing whether the browser writes to disk, to IndexedDB, or to memory? That's hiding. The storage mechanism is *owned* by the browser; you, the caller, are forbidden from knowing. Now imagine the opposite — you call `setItem` AND you also have to manually serialize the value AND remember which storage backend the browser used last time AND check whether quotas are exceeded. That would be a leak — the implementation has bled up into the caller. Same shape here.

```
Hide vs leak — the picture

  HIDE                                LEAK
  ┌─ caller ──────┐                   ┌─ caller A ────┐  ┌─ caller B ────┐
  │ asks for X    │                   │ knows fact F  │  │ also knows F  │
  └───────┬───────┘                   └───────┬───────┘  └───────┬───────┘
          │                                    │                  │
          ▼                                    └─── change F ─────┘
  ┌─ module ──────┐                                  │
  │ owns fact F   │                                  ▼
  │ caller blind  │                          both files edit
  └───────────────┘                          OR one drifts
```

### Move 2 — the strongest hide in the repo

**The kernel: McpClient's retry-after parsing.** Bloomreach's rate-limit error envelope ships its penalty window in two different prose formats — "Retry after ~12 second(s)" and "rate limit reached (1 per 10 second)" — and `McpClient` is the only module in the codebase that knows either format exists.

```
The retry-after hide — three load-bearing facts, one owner

  what's hidden (owned by McpClient):
    1. the error grammar      "retry-after ~N second" / "per N second"
    2. the parsing regex       /retry[\s-]*after[^0-9]*(\d+)\s*second/i
    3. the buffer policy       hint + 500ms cushion, capped at 20s
    4. the backoff fallback    retryDelayMs × 2^retries when no hint

  who knows about it elsewhere?
    runAgentLoop                — no (calls mcp.callTool)
    DiagnosticAgent             — no
    RecommendationAgent         — no
    MonitoringAgent             — no
    QueryAgent                  — no
    /api/agent route            — no
    /api/briefing route         — no
                                  └─ ZERO leaks. the fact lives in ONE FILE.

  what could change without anyone noticing:
    - Bloomreach switches to "Retry-After: 12" HTTP header → only client.ts changes
    - the penalty window doubles to 20s → only client.ts changes
    - we add a third grammar pattern → only client.ts changes
```

**What makes this a strong hide:** every fact about how Bloomreach signals rate-limit recovery is concentrated in one ~30-line private helper (`parseRetryAfterMs`, `lib/mcp/client.ts` L31–L38). There is literally no other place in the repo where the regex `/retry-after.*second/` appears. That's the test of a real hide — search the codebase for the secret and find exactly one occurrence.

### Move 2 — the second-strongest hide

**The kernel: runAgentLoop's tool-use protocol.** The Anthropic Messages API's tool-use protocol — `tool_use` blocks, `tool_result` blocks, the requirement to feed results back as the next user turn, the assistant content array of typed blocks — is owned by one function.

```
The tool-use protocol hide

  what's hidden (owned by runAgentLoop):
    1. message.content is a typed-block ARRAY                (Anthropic-specific)
    2. tool_use blocks have id, name, input                  (Anthropic shape)
    3. tool_result blocks must be appended as a user turn    (Anthropic protocol)
    4. tool_use_id must match the original tool_use.id       (Anthropic linkage)
    5. on the final turn, omit tools to force JSON           (this repo's trick)
    6. on budget-spent, omit tools + append synthesis msg    (this repo's trick)

  who knows about it elsewhere?
    the four agent classes pass:
      anthropic: <client>           — they hold an Anthropic instance
      toolSchemas: <subset>         — they pass an Anthropic.Messages.Tool[]
      system, userPrompt, hooks
    they NEVER touch tool_use blocks, never construct tool_result blocks,
    never know about content-array shape.
                                  └─ STRONG HIDE. the protocol lives in one
                                    function the agents are blind to.
```

**Why it earns its place:** if Anthropic changes the tool-use API, exactly one file changes (`lib/agents/base.ts`). The four agent files don't even import `Anthropic.Messages.ToolUseBlock`.

### Move 2 — the worst leak

**The anti-kernel: the Insight↔Anomaly field list, encoded in three places.** A round-trip between `Anomaly` and `Insight` requires keeping a field list aligned across three files. Add a new field to one side and you have to remember to update at least one other place — sometimes two.

```
The Insight↔Anomaly leak

  the same knowledge ("what fields cross between Anomaly and Insight"),
  three locations:

  ┌─ lib/mcp/types.ts ─────────────────────────┐
  │  interface Anomaly  { metric, scope,        │
  │                       change, severity,      │
  │                       evidence, impact?,     │
  │                       history?, category? }  │
  │  interface Insight  { id, timestamp,         │
  │                       severity, headline,    │
  │                       summary, metric,       │
  │                       change, scope, source, │
  │                       evidence?, impact?,    │
  │                       ... } ★ truth source   │
  └────────────────────────────────────────────┘

  ┌─ lib/state/insights.ts  L8–L28 ────────────┐
  │  anomalyToInsight(a): Insight               │
  │    copies: metric, scope, change, severity, │
  │            evidence, impact, history,        │
  │            category                          │
  │    derives: id, timestamp, headline,         │
  │             summary, source                  │
  └────────────────────────────────────────────┘

  ┌─ app/api/agent/route.ts  L29–L31 ──────────┐
  │  insightToAnomaly(i): Anomaly               │
  │    copies: metric, scope, change, severity  │
  │    drops:  evidence, impact, history,        │
  │            category   ← silent loss!         │
  └────────────────────────────────────────────┘

  what changes when you add a new field (say `affectedCustomers`) to Anomaly?
    1. lib/mcp/types.ts:    interface change   ← compiler enforces
    2. lib/state/insights.ts: copy line        ← compiler does NOT enforce
    3. app/api/agent/route.ts: copy line       ← compiler does NOT enforce
       │
       └─ #2 and #3 silently drop the new field. tests still pass.
          the round-trip loses data. that's the leak.
```

**Why this is the worst leak:** the field list isn't just edited in multiple places — it's *implicitly* the same list, but TypeScript can't enforce that two functions copy the same subset. The leak is invisible to the compiler.

**The fix:** move `insightToAnomaly` into `lib/state/insights.ts` next to `anomalyToInsight`, and write them as inverses with a shared field-copy helper. Even better: emit `Anomaly` directly from the monitoring agent into the state module without round-tripping at all (the round-trip exists because the agent route accepts `Insight` from the browser via `?insight=`, but the route could accept either shape — the wire format is the leak source, not a requirement).

### Move 2 — a softer leak worth naming

**Temporal decomposition in the two agent classes.** `DiagnosticAgent` and `RecommendationAgent` each ship a `synthesize()` private method (L86–L126 and L82–L132). Both do the same thing — run the model tool-less with a recovery prompt when the main loop won't emit JSON. The fact that "when the main loop produces no parseable JSON, run a tool-less recovery turn" is now encoded twice.

```
The synthesize-method leak

  lib/agents/diagnostic.ts        lib/agents/recommendation.ts
  ┌────────────────────────┐      ┌────────────────────────────┐
  │ async synthesize(...) {│      │ async synthesize(...) {     │
  │   const evidence = ... │      │   const evidence = ...      │
  │   const res = await    │      │   const res = await         │
  │     anthropic.messages │      │     anthropic.messages      │
  │     .create({          │      │     .create({               │
  │       model: AGENT_    │      │       model: AGENT_         │
  │         MODEL,         │      │         MODEL,              │
  │       max_tokens: 2048,│      │       max_tokens: 2048,     │
  │       system: '...',   │      │       system: '...',        │
  │     ...                │      │     ...                     │
  │ }                       │      │ }                            │
  └────────────────────────┘      └────────────────────────────┘
                  same recovery pattern, two implementations
```

**Why this is a leak:** "the agent might not emit JSON on the main loop, so a tool-less recovery call is needed" is one *decision*. Today it lives in both files. Change the recovery prompt format and you have to remember to change it in both. The fix is to lift it into `runAgentLoop` as a `forceFinalRetry` mode — the loop already understands `forceFinal`, finish the abstraction.

### Move 3 — the principle

Hiding is the discipline that lets deep modules stay deep. Without it, every fact bleeds upward and the modules become shallow regardless of how well-named their methods are. The test is simple and adversarial: **search the codebase for the secret you think is hidden, and count the occurrences.** One = real hide. Two or three = leak. The retry-after grammar occurs once; the field-copy list occurs three times. That difference is the audit.

---

## Primary diagram

Hides and leaks, ranked:

```
Information hiding audit — ranked

  STRONG HIDES (praise)
  ────────────────────────────────────────────────────────────────────
  1. Bloomreach retry-after grammar
     owner:    lib/mcp/client.ts  L31–L38 (parseRetryAfterMs)
     callers:  none — every retry path goes through callTool
     score:    ★★★★★ one occurrence in the entire repo

  2. Anthropic tool-use protocol
     owner:    lib/agents/base.ts L48–L176 (runAgentLoop)
     callers:  the 4 agent classes touch zero tool-use blocks
     score:    ★★★★★

  3. Cache key construction (TTL cache)
     owner:    lib/mcp/client.ts  L102 (`${name}:${JSON.stringify(args)}`)
     callers:  none — callers pass name + args, never construct keys
     score:    ★★★★★

  4. OAuth storage backend selection (3 backends behind one provider)
     owner:    lib/mcp/auth.ts    L33–L143 (the file-vs-memStore-vs-cookie logic)
     callers:  callers see BloomreachAuthProvider — never know which backend
     score:    ★★★★

  LEAKS (debt)
  ────────────────────────────────────────────────────────────────────
  1. Insight↔Anomaly field-copy list           ★ WORST LEAK
     locations:  3
       lib/mcp/types.ts                    (the interface itself)
       lib/state/insights.ts L8–L28        (anomalyToInsight)
       app/api/agent/route.ts L29–L31      (insightToAnomaly)
     fix:        unify the two mapping functions; preferably colocate
                 with the type definition

  2. synthesize() recovery pattern             ★ SECOND-WORST LEAK
     locations:  2
       lib/agents/diagnostic.ts L86–L126
       lib/agents/recommendation.ts L82–L132
     fix:        lift into runAgentLoop as forceFinalRetry mode

  3. AgentEvent type-tag shape                  ★ DEPENDENCY LEAK
     locations:  2
       lib/mcp/events.ts L4–L12             (the union)
       app/api/agent/route.ts L66–L84       (filterByStep narrows by tag)
     fix:        either colocate filter with the union, or attach `agent`
                 to every variant so narrowing isn't needed
```

---

## Implementation in codebase

### The strong hide — `parseRetryAfterMs`

```
lib/mcp/client.ts  (lines 24–38)

  // Small cushion added on top of a server-stated retry window so the retry lands
  // just *after* the penalty clears rather than on its boundary.
  const RETRY_BUFFER_MS = 500;

  function isRateLimited(result: unknown): boolean {
    if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
    const text = JSON.stringify((result as any).content ?? result);
    return /rate limit|too many requests/i.test(text);
  }

  /**
   * Pull a wait hint (ms) out of a Bloomreach rate-limit error envelope. Two
   * shapes are observed in the wild:
   *   "Retry after ~12 second(s)"            → 12_000
   *   "rate limit reached (1 per 10 second)" → 10_000  (the penalty window)
   * Returns null when nothing parseable is present (caller falls back to backoff).
   */
  function parseRetryAfterMs(result: unknown): number | null {
    const text = JSON.stringify((result as any)?.content ?? result);
    const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
    if (after) return parseInt(after[1], 10) * 1000;
    const perWindow = text.match(/per\s*(\d+)\s*second/i);
    if (perWindow) return parseInt(perWindow[1], 10) * 1000;
    return null;
  }
       │
       └─ this is the only place in the codebase that knows the Bloomreach
          error grammar. grep the repo for /retry-after/ and only this file
          matches. that's a real hide.
```

### The leak — `insightToAnomaly` and `anomalyToInsight`

```
lib/state/insights.ts  (lines 8–28)

  export function anomalyToInsight(a: Anomaly): Insight {
    const id = crypto.randomUUID();
    const sign = a.change.direction === 'down' ? '-' : '+';
    const headline = `${a.scope.join(' ')} ${a.metric} · ...`.toLowerCase();
    return {
      id,                                       ← derived
      timestamp: new Date().toISOString(),      ← derived
      severity: a.severity,                     ← COPY
      headline,                                  ← derived
      summary: ...,                              ← derived
      metric: a.metric,                          ← COPY
      change: a.change,                          ← COPY
      scope: a.scope,                            ← COPY
      source: 'monitoring',                      ← stamped
      evidence: a.evidence,                      ← COPY
      impact: a.impact,                          ← COPY
      history: a.history,                        ← COPY
      category: a.category,                      ← COPY
      ...deriveInsightFields(a),                 ← enriched
    };
  }
       │
       │  fields copied verbatim: severity, metric, change, scope,
       │                          evidence, impact, history, category
       │
       └─ owns the full field list


app/api/agent/route.ts  (lines 29–31)

  function insightToAnomaly(i: Insight): Anomaly {
    return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
  }
       │
       │  fields copied: metric, scope, change, severity   ← FOUR of the seven
       │  fields dropped (silently): evidence, impact, history, category
       │
       └─ a different subset of the same knowledge. add `affectedCustomers`
          to Anomaly and you have to remember to add it to BOTH copies.
```

**The fix is mechanical**: lift both functions into `lib/state/insights.ts`, define them as a pair, and write tests that round-trip every Anomaly field. The colocation alone retires the leak because now any field-list change is one diff in one file.

### The second leak — `synthesize` recovery method

```
lib/agents/diagnostic.ts  (lines 86–126)

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
        messages: [{ role: 'user', content: `Anomaly investigated:\n${...}\n\n...` }],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);
      ...
    } catch { return null; }
  }


lib/agents/recommendation.ts  (lines 82–132)

  private async synthesize(anomaly, diagnosis, toolCalls): Promise<IdlessRecommendation[] | null> {
    try {
      const evidence = toolCalls.map((tc, i) => {
        const payload = tc.error ? { error: tc.error } : tc.result;
        return `Query ${i + 1}: ${tc.toolName} ${JSON.stringify(tc.args).slice(0, 200)}\n` +
               `Result: ${JSON.stringify(payload).slice(0, 900)}`;       ← SAME 200/900 slice
      }).join('\n\n') || '(no existing-feature queries were completed)';

      const res = await this.anthropic.messages.create({
        model: AGENT_MODEL,                                              ← SAME model
        max_tokens: 2048,                                                ← SAME budget
        system: 'You are concluding a completed recommendation step...', ← parallel system msg
        ...
```

Two copies. Same shape. Different prompts. The fact "agent loop sometimes ends with no parseable JSON; do one more tool-less call to force the structured output" is encoded twice. Lift to `runAgentLoop` and the two `synthesize` methods both delete.

---

## Elaborate

Leakage tends to follow one of three patterns: (1) **same data, two places** — the Insight↔Anomaly mapping; (2) **same logic, two places** — the `synthesize` recovery; (3) **implicit shape contract** — `filterByStep` reading shapes defined in another file. This audit found all three. They're the three classic shapes; spotting them is most of the skill.

A subtlety on `auth.ts`: the file selects one of three storage backends based on `NODE_ENV` (dev → file, test → memory, production → encrypted cookie). It looks at first glance like a leak — the backend choice is "exposed" — but it isn't. The choice is *internal* to the auth module; no caller of `BloomreachAuthProvider` ever knows which backend is active. The `NODE_ENV` check IS the secret, encapsulated. That's hiding, not leakage. The test for the distinction: can a caller distinguish between "the cookie backend is active" and "the file backend is active"? No — the public methods (`tokens()`, `saveTokens(t)`, etc.) behave the same. So it's hidden.

The deeper move: when you find a leak, ask *why* it was leaked. The Insight↔Anomaly leak exists because the wire format (the `?insight=` query param the browser sends to `/api/agent`) forces the conversion. The leak isn't fundamental; it's a *consequence* of accepting `Insight` shape from the browser instead of accepting `Anomaly` or the bare id and looking up. Fix the wire-format decision and the leak retires on its own.

## Interview defense

**Q: What's the test for whether something is "hidden" in a codebase?**
A: Search the codebase for the secret and count occurrences. If the secret is, say, "Bloomreach signals rate-limit recovery with the prose `retry-after N second`," then I grep for `/retry-after.*second/` and count files. One file = real hide; two or more = leak. In this repo, the retry-after grammar occurs in exactly one file (`lib/mcp/client.ts` L31–L38), the Anthropic tool-use shape occurs in one file (`lib/agents/base.ts`), and the Insight-to-Anomaly field list occurs in three files. The grep is the audit.

**Q: Walk me through the worst leak and how you'd fix it.**
A: The Insight↔Anomaly field-copy list. `anomalyToInsight` in `lib/state/insights.ts` (L8–L28) copies 8 fields; `insightToAnomaly` in `app/api/agent/route.ts` (L29–L31) copies 4 of those 8 and silently drops 4 (`evidence`, `impact`, `history`, `category`). Add a new field to `Anomaly` and the round-trip silently drops it; TypeScript can't catch it because both functions are valid. Fix is to colocate both functions in `lib/state/insights.ts` and write a round-trip test that asserts no field-loss. Better still: fix the wire format so the route doesn't need to convert at all — accept just the insight id and look up the cached anomaly.

```
Interview-defense diagram — the worst leak

  before:
  types.ts     ──── interface Anomaly      (truth)
  state/       ──── anomalyToInsight       (copies 8)
  api/agent/   ──── insightToAnomaly       (copies 4, drops 4)
                                                ▲
                                                │
                                  silent field-loss on round-trip

  after:
  types.ts     ──── interface Anomaly      (truth)
  state/       ──── { toInsight, toAnomaly } colocated, round-trip-tested
  api/agent/   ──── import { toAnomaly } from '@/lib/state/insights'
```

## Validate

1. **Reconstruct.** Without opening the file: which file owns the Bloomreach retry-after grammar? Which file would change if Bloomreach added a third error prose format?

2. **Explain.** Why is the three-backend logic in `lib/mcp/auth.ts` (L33–L143) NOT a leak, even though it inspects `NODE_ENV` in multiple places? What test distinguishes hiding from leakage here?

3. **Apply.** A new field `affectedCustomers: number` is added to `Anomaly` in `lib/mcp/types.ts`. Trace the leak: which files have to change to preserve the round-trip? Which file does TypeScript NOT force you to update?

4. **Defend.** Someone says "the two `synthesize()` methods in `diagnostic.ts` and `recommendation.ts` are different — diagnostic returns a `Diagnosis`, recommendation returns `Recommendation[]`. They shouldn't share code." Counter the argument. (Hint: the shape of the call is the same — gather evidence, run a tool-less recovery turn, parse the result. The output type differs but the *recovery decision* doesn't. Generic over the parser.)

## See also

- `02-deep-vs-shallow-modules.md` — McpClient's depth comes from its hides; the retry-after example reappears there.
- `04-layers-and-abstractions.md` — `insightToAnomaly` reappears as a pass-through-shaped mapping.
- `06-errors-and-special-cases.md` — the two `synthesize` methods reappear as a "special case defined twice" smell.
- `08-red-flags-audit.md` — "information leakage" red flag is scored.
