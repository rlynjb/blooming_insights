# synthesize() recovery duplication — RESOLVED 2026-06-15

**Industry name(s):** Special-case sprawl · temporal decomposition (mild) · duplicated recovery logic · "define it out of existence" candidate
**Type:** Industry standard · Language-agnostic (historic candidate, now resolved — kept as worked example)

> **STATUS: RESOLVED.** The lift proposed below has landed exactly as predicted. `runAgentLoop` (`lib/agents/base.ts`) now accepts `parseResult: (text: string) => T | null` and `recoveryPrompt: (toolCalls: ToolCall[]) => string` (see L65-66). The post-loop recovery turn lives at `lib/agents/base.ts:213-217`: if `parseResult(finalText)` returns null and a `recoveryPrompt` is provided, the loop runs one tool-less turn and parses again. Both `synthesize()` methods are gone from `lib/agents/diagnostic.ts` and `lib/agents/recommendation.ts`. `DiagnosticAgent` now calls the loop with `parseResult: tryParseDiagnosis` + a per-anomaly recovery prompt (L77, L82-…); `RecommendationAgent` does the same with `tryParseRecommendations` (L67, L73). ~90 LOC removed as estimated. The verdict — "the canonical define-out target in the repo" — was true on 2026-06-02 and the file is preserved as the worked example of the lift-to-loop move.

> **Original verdict (historical).** The "agent emitted no parseable JSON" recovery was handled with a dedicated `synthesize()` method in BOTH `DiagnosticAgent` (`lib/agents/diagnostic.ts:86-126`) and `RecommendationAgent` (`lib/agents/recommendation.ts:82-132`). Two ~50-line copies of the same shape: serialize the tool-call history, run a tool-less Anthropic call with a recovery prompt, parse the result, return null on failure. The *strategy* was identical; only the prompt and parser differed. This was the canonical special case to define out of existence by lifting the recovery into `runAgentLoop`. **The fix below is now what the code looks like.**

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three of the four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`) need structured JSON output from the model. The agent loop has a `forceFinal` trick — on the last allowed turn, the loop omits tools and appends the synthesis instruction, forcing the model to emit a final answer. In practice, this works *most* of the time. The exceptions: sometimes the model still doesn't produce parseable JSON even on the forced turn (it explains why it can't, or it hedges). Two of the three agents handle this exception with a dedicated second tool-less call — a `synthesize()` method that re-serializes the tool-call history and asks the model one more time. Two copies, same shape, different prompts.

```
Zoom out — where the duplication lives

┌─ Route handler ─────────────────────────────────────────────────┐
│  /api/agent — invokes DiagnosticAgent or RecommendationAgent    │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ Agent classes ──────────▼─────────────────────────────────────┐
│  DiagnosticAgent.investigate                                    │
│    runAgentLoop({ ... }) → finalText                            │
│    tryParseDiagnosis(finalText) ?? synthesize(...) ?? FALLBACK  │  ← LEAK
│                                                                 │
│  RecommendationAgent.propose                                    │
│    runAgentLoop({ ... }) → finalText                            │
│    tryParseRecommendations(finalText) ?? synthesize(...)         │  ← LEAK (same shape)
│                                                                 │
│  MonitoringAgent.scan                                           │
│    runAgentLoop({ ... }) → finalText                            │
│    parseAgentJson(finalText) catch → []        ← no synthesize  │
│                                                                 │
│  QueryAgent.answer                                              │
│    runAgentLoop({ ... }) → finalText                            │
│    return finalText (prose, no parse needed)   ← no synthesize  │
└──────────────────────────┬─────────────────────────────────────┘
                           │ runs the shared loop
┌─ runAgentLoop ───────────▼─────────────────────────────────────┐
│  owns: tool-use protocol, forceFinal logic, budget enforcement  │
│  does NOT own: post-loop parse retry                            │  ← the gap
└─────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is "two files own one decision." The decision is "if the loop produced no parseable JSON, run one more tool-less attempt with a recovery prompt." That decision is the same in both agents; only the *prompt text* and the *parser function* differ. The fix is to lift the decision into `runAgentLoop` as two parameter functions (`parseResult` and `recoveryPrompt`), let the loop own the strategy, and delete both `synthesize()` methods. The special case doesn't disappear — the recovery still happens — but it's defined out of the agents' surface and into the loop where it belongs.

---

## Structure pass

**Layers.** Three for this concept: the **loop layer** (`runAgentLoop` — owns turns, tool calls, forceFinal), the **agent layer** (the four agent classes — own role, prompt, parser, fallback), and the **strategy layer** (the recovery decision — currently owned by two agent classes, should be owned by the loop).

**Axis: where the decision lives.** For each design move ("if X happens, do Y"), which module owns the if-X-then-Y logic? In a healthy codebase, recurring strategies live in one place — the module that has enough information to decide. Here the loop knows enough to decide ("I just finished my final tool-less turn; the caller's parser returned null; one more attempt with the recovery prompt is the standard fix"), but the decision lives in two agent classes instead.

**Seams.** The load-bearing seam is **loop ↔ agent**. The current contract is "loop returns `finalText`; agent parses or falls back." That's clean if the parse-or-fallback is a one-liner; it leaks when the fallback grows into a 50-line recovery method. The fix changes the contract to "loop returns `{ parsed: T | null, finalText, toolCalls }`; agent provides the parser and the recovery prompt as inputs." The seam moves the recovery into the loop's responsibility; the agent's surface shrinks.

```
Structure pass — the strategy split

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Loop · Agent · Strategy (currently in 2 agents)          │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  decision ownership: where does "if no JSON, retry"       │
│  live? loop (1) or agents (currently 2)?                  │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across the seam
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  loop ↔ agent contract                                    │
│   today:   loop returns finalText; agent runs synthesize  │
│            on parse-fail (TWO copies of the logic)        │
│   fixed:   loop returns { parsed, finalText, toolCalls };  │
│            agent passes parseResult + recoveryPrompt as   │
│            inputs; both synthesize() methods delete        │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the mental model (the duplicated strategy)

You know how `Promise.race([slowOp(), timeout(1000)])` is a strategy you can apply to any operation — the same logic ("if op doesn't finish in 1s, fall back") works for fetch, for SQL queries, for tool calls? Now imagine the opposite shape: every caller writes its own version of "if op doesn't finish in 1s, fall back," because the strategy never got extracted. That's the shape here. The strategy "if parse fails, run one more tool-less attempt with recovery context" works for every agent that needs structured JSON output — but today it's written twice (DiagnosticAgent and RecommendationAgent), with the agent-specific parts (prompt text, parser) inlined into the strategy code instead of passed in.

```
Strategy vs duplicated logic — picture

  STRATEGY (one owner)                  DUPLICATED (this case)
  ┌─ runAgentLoop ─────────────┐        ┌─ runAgentLoop ─────────────┐
  │  owns:                      │        │  owns:                      │
  │    parse-or-retry strategy  │        │    (nothing — agents do it) │
  │  accepts:                   │        │  returns: finalText          │
  │    parseResult fn           │        └─────────────────────────────┘
  │    recoveryPrompt fn        │
  │  returns: { parsed, ... }   │        ┌─ DiagnosticAgent ──────────┐
  └─────────────────────────────┘        │  if !parse: synthesize() {  │
                                          │    serialize history,       │
                                          │    anthropic.messages...    │
                                          │    parseDiagnosis(text)     │
                                          │  }                           │
                                          └─────────────────────────────┘
                                          ┌─ RecommendationAgent ──────┐
                                          │  if !parse: synthesize() {  │
                                          │    serialize history,       │
                                          │    anthropic.messages...    │  ← same shape
                                          │    parseRecommendations(t)  │
                                          │  }                           │
                                          └─────────────────────────────┘
                                                  two copies. same logic.
```

### Move 2 — the kernel (the shared shape, the divergent inputs)

Walk the two `synthesize()` methods side by side. They share:

- **The serialization shape.** Both build an "evidence" string by mapping `toolCalls` to lines like `Query N: ${toolName} ${args}\nResult: ${result}` with the same 200-char/900-char slice budgets.
- **The Anthropic call shape.** Both use `model: AGENT_MODEL` (`claude-sonnet-4-6`), both set `max_tokens: 2048`, both omit the `tools` parameter (tool-less).
- **The result extraction.** Both grab the first text block from the response, run their parser, return `null` on failure (so the caller falls back further).

They differ only in:

- **The system prompt.** "You are concluding a completed investigation. Output ONLY a JSON diagnosis..." vs "You are concluding a completed recommendation step. Output ONLY a JSON array of recommendations..."
- **The user-message context.** Anomaly only (diagnostic) vs Anomaly + Diagnosis (recommendation).
- **The parser function.** `tryParseDiagnosis` vs `tryParseRecommendations`.

```
The duplicated kernel

  shared (in both methods):
    1. serialize tool-call history with same slice budgets (200/900)
    2. anthropic.messages.create with same model + max_tokens
    3. NO tools (tool-less)
    4. extract first text block from response
    5. run the parser, return null on failure

  divergent (per agent):
    A. system prompt text
    B. user-message context shape
    C. parser function
```

### Move 2 — the fix (lift the strategy into the loop)

Add two optional parameters to `runAgentLoop`: `parseResult` (the agent's parser) and `recoveryPrompt` (a function from `toolCalls` to a recovery user-message). The loop runs as normal; on completion, it attempts `parseResult(finalText)`; on failure, it runs one tool-less turn with the recovery prompt and tries the parser again. The return shape grows from `{ finalText, toolCalls }` to `{ parsed: T | null, finalText, toolCalls }`.

```
Pseudocode — the loop with the lifted strategy

  async function runAgentLoop<T>(opts): Promise<{
    parsed: T | null,
    finalText: string,
    toolCalls: ToolCall[]
  }> {
    // ... existing loop (turn limit, tool-use protocol, forceFinal trick) ...

    // NEW: post-loop parse-or-recover
    let parsed: T | null = opts.parseResult ? opts.parseResult(finalText) : null

    if (parsed == null && opts.recoveryPrompt) {
      const recoveryUser = opts.recoveryPrompt(toolCalls)
      const recoveryRes = await opts.anthropic.messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,
        system: opts.system,
        messages: [{ role: 'user', content: recoveryUser }],
        // no tools — force final text
      })
      const recoveryText = extractFirstTextBlock(recoveryRes)
      parsed = opts.parseResult ? opts.parseResult(recoveryText) : null
      finalText = recoveryText                 // overwrite so caller sees recovery output
    }

    return { parsed, finalText, toolCalls }
  }
```

Then the two agent classes collapse:

```
Pseudocode — DiagnosticAgent after the lift

  async investigate(anomaly, hooks) {
    const { parsed } = await runAgentLoop({
      anthropic: this.anthropic,
      mcp: this.mcp,
      agent: 'diagnostic',
      system: PROMPT.replace(...),
      userPrompt: 'Investigate the anomaly...',
      toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: 'You have NO more tool calls available...',
      parseResult: tryParseDiagnosis,                   ← passes parser
      recoveryPrompt: (tcs) => buildDiagRecoveryCtx(anomaly, tcs),  ← passes prompt builder
    })
    return parsed ?? FALLBACK
  }
       │
       └─ synthesize() method DELETES.
          ~40 LOC removed from diagnostic.ts.
          ~50 LOC removed from recommendation.ts.
          shared "what does a recovery turn look like" logic now lives once.
```

### Move 2 — why this is "define out," not just "deduplicate"

Ousterhout names four error strategies, ranked: **define out > mask low > transform > propagate**. The duplicated `synthesize()` is at the "mask low" level — each agent masks the parse failure inside its own method. Lifting the recovery into `runAgentLoop` *defines the case out* of the agent's surface entirely — the agent no longer has to know that "sometimes the model doesn't emit JSON" is a thing that happens. It passes a parser; if the loop returns `parsed`, great; if not, the loop already tried recovery. The agent's mental model gets simpler. That's the difference between "we handle this case in two files" (mask) and "the loop owns this case, agents don't see it" (define out).

### Move 3 — the principle

When the same recovery shape appears in two callers, the recovery isn't a one-off — it's a strategy. Strategies belong in the module that has enough context to decide *whether* to run them, not in every caller that *might* need them. The loop has the context: it knows when the final tool-less turn completed, what the caller's parser is, what the recovery prompt would be. The agents don't have that context — they only know *after the fact* that the parse failed. Push the strategy down to the module with the timing, parameterize what differs (the prompt, the parser), and delete the duplication. That's the move.

---

## Primary diagram

The fix in one frame — before and after the lift.

```
The synthesize() collapse — recap

  BEFORE
  ┌─ runAgentLoop ──────────────────────────────────────┐
  │  returns: finalText (string)                         │
  └─────────────────────────┬───────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                                 ▼
  ┌─ DiagnosticAgent ─────────┐    ┌─ RecommendationAgent ──────┐
  │  tryParseDiagnosis(text)  │    │  tryParseRecommendations(t)│
  │  ?? this.synthesize(...)  │    │  ?? this.synthesize(...)   │
  │  ?? FALLBACK              │    │                             │
  │                           │    │                             │
  │  private synthesize(...) {│    │  private synthesize(...) {  │
  │    serialize history       │    │    serialize history        │
  │    anthropic.messages.    │    │    anthropic.messages.      │  ← same shape
  │    create(...)             │    │    create(...)              │
  │    parseDiagnosis           │    │    parseRecommendations    │
  │  }                          │    │  }                           │
  │  (40 LOC)                   │    │  (50 LOC)                    │
  └────────────────────────────┘    └─────────────────────────────┘
       ~90 LOC of duplicated recovery logic

  AFTER
  ┌─ runAgentLoop ──────────────────────────────────────┐
  │  accepts: parseResult, recoveryPrompt                │
  │  returns: { parsed: T | null, finalText, toolCalls } │
  │                                                       │
  │  internal:                                            │
  │    parsed = parseResult(finalText)                    │
  │    if (parsed == null && recoveryPrompt) {            │  ← strategy
  │      recoveryText = oneToolLessTurn(recoveryPrompt)   │     lives here
  │      parsed = parseResult(recoveryText)                │
  │    }                                                   │
  │    return { parsed, finalText, toolCalls }            │
  └─────────────────────────┬───────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                                 ▼
  ┌─ DiagnosticAgent ─────────┐    ┌─ RecommendationAgent ──────┐
  │  const { parsed } = ...   │    │  const { parsed } = ...    │
  │  return parsed ?? FALLBACK│    │  return parsed ?? []       │
  └────────────────────────────┘    └─────────────────────────────┘
       ~90 LOC removed. one strategy. one owner.
```

---

## Implementation in codebase

**Use cases.** Three places this duplication bites today.

- **Adding a fifth agent.** If a `PredictionAgent` ships needing structured JSON output, the contributor either writes a third `synthesize()` (three copies of the same shape) or skips it (the agent has worse recovery than its siblings). Either path is wrong.

- **Changing the recovery prompt template.** Today, the strings "You are concluding a completed investigation..." and "You are concluding a completed recommendation step..." follow parallel structure. Updating the format (e.g. adding "respond in plain JSON with no markdown") requires editing both files, remembering to keep them in sync.

- **Tuning the serialization budget.** Both methods use `JSON.stringify(args).slice(0, 200)` and `JSON.stringify(payload).slice(0, 900)`. If the model needs more context to recover well, those numbers have to change in two places, in sync.

### The two copies, side by side

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
        model: AGENT_MODEL,                                      ← shared
        max_tokens: 2048,                                         ← shared
        system: 'You are concluding a completed investigation. Output ONLY a JSON diagnosis...',
        messages: [{
          role: 'user',
          content: `Anomaly investigated:\n${JSON.stringify(anomaly, null, 2)}\n\nQueries run:\n${evidence}\n\nNow output your diagnosis JSON.`
        }],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);

      const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
      return tryParseDiagnosis(text);
    } catch { return null; }
  }


lib/agents/recommendation.ts  (lines 82–132)

  private async synthesize(
    anomaly: Anomaly, diagnosis: Diagnosis | null, toolCalls: ToolCall[]
  ): Promise<IdlessRecommendation[] | null> {
    try {
      const evidence = toolCalls.map((tc, i) => {
        const payload = tc.error ? { error: tc.error } : tc.result;
        return `Query ${i + 1}: ${tc.toolName} ${JSON.stringify(tc.args).slice(0, 200)}\n` +
               `Result: ${JSON.stringify(payload).slice(0, 900)}`;            ← SAME slice budgets
      }).join('\n\n') || '(no existing-feature queries were completed)';

      const res = await this.anthropic.messages.create({
        model: AGENT_MODEL,                                      ← SHARED
        max_tokens: 2048,                                         ← SHARED
        system: 'You are concluding a completed recommendation step. Output ONLY a JSON array...',
        messages: [{
          role: 'user',
          content: `Anomaly:\n${JSON.stringify(anomaly, null, 2)}\n\nDiagnosis:\n${...}\n\nQueries run:\n${evidence}\n\nNow output the recommendations JSON.`
        }],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);

      const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
      return tryParseRecommendations(text);
    } catch { return null; }
  }
       │
       └─ same serialize, same Anthropic call shape, same try/catch.
          only the prompt strings and the parser differ.
```

### How they're invoked

```
lib/agents/diagnostic.ts  (lines 73–75)

  const diag =
    tryParseDiagnosis(finalText) ?? (await this.synthesize(anomaly, toolCalls)) ?? FALLBACK;
                                     ──────────────────────────────────────
                                     the special-case path

lib/agents/recommendation.ts  (lines 69–72)

  const idless =
    tryParseRecommendations(finalText) ??
    (await this.synthesize(anomaly, diagnosis, toolCalls));
                                     ──────────────────────────────────────
                                     same special-case path
```

### The runAgentLoop seam the fix changes

```
lib/agents/base.ts  (lines 48–176, current signature)

  export async function runAgentLoop(opts: {
    anthropic, mcp, agent, system, userPrompt, toolSchemas,
    onToolCall?, onText?, onToolResult?,
    maxTurns?, maxTokens?, maxToolCalls?, synthesisInstruction?
  }): Promise<{ finalText: string, toolCalls: ToolCall[] }>
       │
       └─ current contract: loop returns finalText; agent runs its own
          synthesize() on parse fail.

  proposed addition (two new optional params):
    parseResult?: (text: string) => T | null
    recoveryPrompt?: (toolCalls: ToolCall[]) => string

  proposed return shape change:
    Promise<{ parsed: T | null, finalText: string, toolCalls: ToolCall[] }>

       │
       └─ new contract: loop owns parse-and-retry; agent passes its parser
          and prompt builder. both synthesize() methods delete.
```

---

## Elaborate

Where the pattern comes from: Ousterhout's "define errors out of existence" is one of the strongest moves in the book — it changes the model so the error case doesn't have to be handled at all. The classic example is `Array.find` returning `undefined` instead of throwing on no-match — the function shape eliminates the special case. The shape here is one step softer: the recovery still happens, but it moves from the agent's surface (where every agent owns its own copy) into the loop's surface (where it's invisible to agents that don't need it and shared by ones that do).

Adjacent concepts:
- **Pull complexity downward** — the recovery is a knob that lives at the agent layer because the agent has the parser and the prompt context. But the *strategy* (when to retry) is a knob the loop should own — same shape as `synthesisInstruction`'s partial pull-down.
- **Deep modules** — `runAgentLoop` is the deepest function in the codebase (one function, four callers). Adding the recovery strategy makes it *deeper* (one more decision absorbed) without widening its surface (just two more optional params). That's the right direction for a deep module.
- **Same-knowledge-in-two-places** — the duplication here is logic, not data, but the smell is the same as the Insight↔Anomaly leak. Both cases have the same fix shape: lift the shared part to one owner, parameterize what differs.

A subtlety on why this didn't get done earlier: the `synthesize()` shape evolved organically. `DiagnosticAgent` shipped first with the recovery; `RecommendationAgent` copied the shape when it shipped. The duplication wasn't an architectural decision; it was an incremental drift. That's typical — recovery patterns often start as one-off hacks and only become *strategies* once a second caller needs them. The audit is the moment to notice the pattern and lift it.

What to read next: the `read-aposd` chapter on errors and special cases (when present) carries the conceptual treatment. The `01-mcp-client-deep-module.md` file in this guide is the model — that's what "the loop owns the recovery, agents don't see it" looks like when the pattern is fully applied (the rate-limit retry inside `McpClient` is the same shape as the proposed `runAgentLoop` recovery).

A non-finding worth naming as praise: `MonitoringAgent.scan` and `QueryAgent.answer` don't have `synthesize()` methods. `MonitoringAgent` returns `[]` on parse fail (acceptable for a feed of zero anomalies); `QueryAgent` returns prose, no parsing needed. The pattern was already partial; the lift just completed it for the two agents that need recovery.

**Post-fix lesson worth carrying forward.** The prediction in the original Move 2 ("Why this is 'define out,' not just 'deduplicate'") held in practice. The post-fix `DiagnosticAgent.investigate` and `RecommendationAgent.propose` methods are noticeably simpler — they have *no* code path for "what to do if the parser returns null"; they just read `parsed` from the loop result and fall back to `FALLBACK` (or `[]`). The "if the parser fails, run recovery" decision doesn't appear at the agent layer at all anymore. That's the difference between deduplicating code (still leaves "remember to call recovery" as a per-agent obligation) and defining-out the case (no obligation; the loop always does it when `parseResult` returns null). The Ousterhout move ranked higher than a shared helper — and at the cost of two new optional parameters on the loop — was the right call.

## Interview defense

**Q: Walk me through a special case in this codebase you'd define out of existence.**
A: The "agent emitted no parseable JSON" recovery in `DiagnosticAgent` (`lib/agents/diagnostic.ts:86-126`) and `RecommendationAgent` (`lib/agents/recommendation.ts:82-132`). Two ~50-line `synthesize()` methods, same shape — serialize the tool-call history, run a tool-less Anthropic call with a recovery prompt, parse the result, return null on failure. Only the prompt and parser differ. The fix is to lift the recovery into `runAgentLoop`: add `parseResult: (text) => T | null` and `recoveryPrompt: (toolCalls) => string` as optional params. The loop runs as normal, attempts the parse, runs ONE recovery turn on failure, returns `{ parsed: T | null, finalText, toolCalls }`. Both `synthesize()` methods delete — ~90 LOC removed. The special case doesn't disappear; the recovery still happens — but it's now defined out of the agents' surface and into the loop where it belongs.

**Q: Why is "lifting to the loop" the right fix instead of "extracting a shared `synthesize()` helper into base.ts"?**
A: A shared helper would still require each agent to remember to call it. The contract stays the same — agent runs the loop, agent decides whether to recover, agent invokes the helper. Two callers means two opportunities to drift (one agent updates the helper's signature, the other doesn't follow). Lifting the *decision* into the loop changes the contract: the agent passes its parser and prompt as inputs, the loop owns when to invoke recovery. There's no "agent forgot to call recovery" failure mode anymore — the loop always does it when `parseResult` returns null. That's the difference between deduplicating code (helper) and defining out the case (lift the decision). The latter is the deeper fix.

```
Interview-defense diagram — helper vs lift

  HELPER (deduplication only)
  ┌─ base.ts ──────────────────────┐
  │  helper synthesize(opts) { ... }│  ← shared code
  └────────────┬───────────────────┘
               │ called explicitly by each agent
       ┌───────┴────────┐
       ▼                ▼
  Diagnostic        Recommendation
   if !parse:        if !parse:
     synthesize(...)   synthesize(...)
   (each agent must remember to call it)

  LIFT (define out)
  ┌─ runAgentLoop ─────────────────┐
  │  if !parse(text):               │  ← loop owns the decision
  │    one tool-less recovery turn  │
  │    parse(recovery text)         │
  │  return { parsed, ... }         │
  └────────────┬───────────────────┘
               │ agents pass parser + prompt as inputs
       ┌───────┴────────┐
       ▼                ▼
  Diagnostic        Recommendation
   parsed ?? FB      parsed ?? []
   (no synthesize() exists at the agent layer)
```

## See also

- `audit.md` — the errors-and-special-cases lens records the resolution and names a sibling instance (PR G goldens-empty pre-flight) where "design the safety in" was applied to infrastructure rather than agent flow.
- `01-mcp-client-deep-module.md` — the proof-of-concept for the lift; rate-limit recovery inside `BloomreachDataSource` (formerly `McpClient`) is the same shape as the now-applied `runAgentLoop` recovery.
- `03-insight-anomaly-silent-leak.md` — RESOLVED with the same fix shape (one owner, not two), different scale (data vs logic).

---
