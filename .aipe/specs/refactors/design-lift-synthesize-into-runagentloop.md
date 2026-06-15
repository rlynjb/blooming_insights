# Design refactor — lift `synthesize()` into `runAgentLoop`

> Source: `.aipe/audits/design-2026-06-14.md` Lens 6 finding 6.1 (special-case sprawl, fires red-flag #3).
> Cross-ref: `.aipe/study-software-design/04-synthesize-recovery-duplication.md` (12-day comprehension walk).
> Cross-ref: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-later #5.

---

## What to refactor

The "agent emitted no parseable JSON, run one tool-less recovery turn" pattern is duplicated across two agent classes as two ~50-line `synthesize()` methods:

- `lib/agents/diagnostic.ts:87-126` (`DiagnosticAgent.synthesize(anomaly, toolCalls)`)
- `lib/agents/recommendation.ts:82-132` (`RecommendationAgent.synthesize(anomaly, diagnosis, toolCalls)`)

Both copies do the same six things in the same order:

1. Serialize the prior tool-call history to a string for the recovery prompt.
2. Build a recovery prompt that names what shape the model should produce.
3. Call `anthropic.messages.create({...})` WITHOUT tools — pure synthesis turn.
4. Log `res.usage` (the morning's cc43e7d commit instrumented this in both).
5. Extract `finalText` from the response content array.
6. Run the parse function (`tryParseDiagnosis` or `tryParseRecommendations`); return the parsed value or `null`.

The differences between the two copies are exactly two: (a) the `parseResult` function, (b) the `recoveryPrompt` string. Everything else is identical mechanics.

Lift the recovery into `runAgentLoop` (`lib/agents/base.ts:48-176`) so the loop owns both the happy path and the one-turn recovery. Both `synthesize()` methods delete (~90 LOC removed). The loop's caller passes `parseResult` + `recoveryPrompt` as options; the loop runs as normal, attempts the parse on `finalText`, and on failure runs ONE additional tool-less turn before giving up.

---

## Why

Three reasons, in order of leverage:

1. **AOSD red flag #3 (special-case sprawl) fires here directly.** Two files own one decision: "what do you do when the agent didn't emit parseable JSON?" The 12-day study named this; the morning's cleanup audit promoted it to `fix-later #5`; this audit emits the stub. Same finding, three artifacts — the cleanup classification was right; the design stub is the contract for how to retire it.

2. **The duplication is the kind that drifts.** The morning's cc43e7d commit added `console.log(JSON.stringify({ site, usage: res.usage }))` to BOTH copies. That worked this time. Next time — say, when someone adds a per-call timeout, or threads `sessionId` (which is the OTHER cleanup stub, `cleanup-thread-sessionid-to-anthropic-calls.md`) — one copy gets the change, the other doesn't, and they drift. The TODOs at `:117` and `:123` are commit-authored debt that prove the surface is being touched twice.

3. **`runAgentLoop` already has the shape to absorb this.** It owns `forceFinal` and `synthesisInstruction` (the existing escape hatch for the model that wants to keep tool-calling). Adding `parseResult` + `recoveryPrompt` is the same shape — two more options that turn the loop's existing final-turn into a final-turn-plus-recovery-turn. The mental model the reader already builds with `runAgentLoop` doesn't widen meaningfully.

---

## Refactor type

**Replace Conditional with Dispatch Table** (the parse-or-recover decision becomes one option call) + **Move Function** (the recovery logic moves from agent class to loop).

Not Strategy (the parse/recover steps aren't interchangeable algorithms swapped at runtime — there's one recovery shape, parameterized by two options). Not Template Method (the loop isn't a skeleton subclassed by the agent — it's a function the agent calls). Not Extract Function (the destination function already exists; this is lifting INTO the existing loop, not extracting OUT of one).

---

## Current structure

```
  lib/agents/diagnostic.ts:67-79          lib/agents/recommendation.ts:61-78
  ┌─────────────────────────────────┐    ┌─────────────────────────────────┐
  │ runAgentLoop({...,              │    │ runAgentLoop({...,              │
  │   onFinal: (t) => finalText=t   │    │   onFinal: (t) => finalText=t   │
  │ })                              │    │ })                              │
  │ ↓                               │    │ ↓                               │
  │ diagnosis =                     │    │ recommendations =               │
  │   tryParseDiagnosis(finalText)  │    │   tryParseRecs(finalText)       │
  │   ?? (await this.synthesize(    │    │   ?? (await this.synthesize(    │
  │       anomaly, toolCalls))      │    │       anomaly, diagnosis,       │
  │   ?? FALLBACK;                  │    │       toolCalls));              │
  └─────────────────────────────────┘    └─────────────────────────────────┘
                  │                                       │
                  ▼                                       ▼
  ┌─────────────────────────────────┐    ┌─────────────────────────────────┐
  │ private async synthesize(...) { │    │ private async synthesize(...) { │
  │   serializeToolCalls(toolCalls);│    │   serializeToolCalls(toolCalls);│
  │   build recovery prompt;        │    │   build recovery prompt;        │
  │   anthropic.messages.create({   │    │   anthropic.messages.create({   │
  │     tools: undefined            │    │     tools: undefined            │
  │   });                           │    │   });                           │
  │   log usage;                    │    │   log usage;                    │
  │   extract finalText;            │    │   extract finalText;            │
  │   return tryParseDiagnosis(...);│    │   return tryParseRecs(...);     │
  │ }                               │    │ }                               │
  └─────────────────────────────────┘    └─────────────────────────────────┘
       40 lines                                40 lines
       SAME SHAPE — two parameters differ
```

The two callers and the two `synthesize()` bodies are byte-shape-identical except for the parse function and the recovery prompt.

---

## Target structure

```
  lib/agents/base.ts (runAgentLoop)
  ┌─────────────────────────────────────────────────────────────┐
  │ type RunAgentLoopOpts<T> = {                                │
  │   ...existing...                                            │
  │   parseResult?:    (finalText: string) => T | null;         │
  │   recoveryPrompt?: (toolCalls: ToolCall[]) => string;       │
  │ };                                                          │
  │                                                             │
  │ async function runAgentLoop<T>(opts: RunAgentLoopOpts<T>) { │
  │   ...existing loop, ending with finalText...                │
  │                                                             │
  │   if (opts.parseResult) {                                   │
  │     const parsed = opts.parseResult(finalText);             │
  │     if (parsed !== null) return { ...result, parsed };      │
  │     if (opts.recoveryPrompt) {                              │
  │       const recoveryText = await runRecoveryTurn(           │
  │         opts, opts.recoveryPrompt(toolCalls)                │
  │       );                                                    │
  │       return {                                              │
  │         ...result,                                          │
  │         parsed: opts.parseResult(recoveryText),             │
  │       };                                                    │
  │     }                                                       │
  │   }                                                         │
  │   return result;                                            │
  │ }                                                           │
  └─────────────────────────────────────────────────────────────┘

  lib/agents/diagnostic.ts                lib/agents/recommendation.ts
  ┌─────────────────────────────────┐    ┌─────────────────────────────────┐
  │ const { parsed } = await        │    │ const { parsed } = await        │
  │   runAgentLoop({                │    │   runAgentLoop({                │
  │     ...,                        │    │     ...,                        │
  │     parseResult:                │    │     parseResult:                │
  │       tryParseDiagnosis,        │    │       tryParseRecommendations,  │
  │     recoveryPrompt: (tc) => `…`,│    │     recoveryPrompt: (tc) => `…`,│
  │   });                           │    │   });                           │
  │ return parsed ?? FALLBACK;      │    │ return parsed ?? [];            │
  │                                 │    │                                 │
  │ // synthesize() DELETED         │    │ // synthesize() DELETED         │
  └─────────────────────────────────┘    └─────────────────────────────────┘
       ~10 lines                              ~10 lines
       SAME SHAPE — by design
```

Net: ~90 LOC removed from the two agents; ~30 LOC added to the loop; one decision lives in one file.

---

## Must not change

- External API of `DiagnosticAgent.investigate()` and `RecommendationAgent.propose()` — same input shape, same output shape, same fallback semantics on parse failure.
- The recovery prompt content for each agent — the strings move from `synthesize()` into the `recoveryPrompt: (toolCalls) => string` option, but their content is identical (preserve every word; the prompts are tuned).
- `tryParseDiagnosis` / `tryParseRecommendations` — these stay where they are; the refactor only changes who calls them.
- The `console.log({ site, usage })` lines at `:118` and `:124` — these stay (per the morning's cc43e7d commit's intent); they move into the loop's `runRecoveryTurn` helper. **Note:** `cleanup-thread-sessionid-to-anthropic-calls.md` is the sibling refactor that threads `sessionId` through these log lines; if THAT stub ships first, this stub picks up the `sessionId` plumbing already in place. If this stub ships first, the cleanup stub picks up one fewer site to thread (the recovery log line collapses to one call inside the loop).
- Do not touch the four agent classes' constructor signatures (the `sessionId` plumbing is the sibling cleanup stub's job).
- Do not touch `lib/agents/intent.ts` or `lib/agents/query.ts` or `lib/agents/monitoring.ts` — they don't have `synthesize()` methods (their schemas are simpler / they don't need the recovery turn).
- The fallback values — `DiagnosticAgent` returns `FALLBACK` (a sentinel diagnosis); `RecommendationAgent` returns `[]`. These stay at the call site, not inside `runAgentLoop`.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond `parseResult` + `recoveryPrompt` options on `runAgentLoop`. Do not invent a `RecoveryStrategy` interface; do not generalize to "any retry policy"; do not pull in a state-machine library.
- No additional refactors discovered along the way — if the executor session notices the four agents' constructors all take the same four args (which `study-software-design/02-shallow-module-page-component.md`'s sibling chapter discusses), that's a separate finding and a separate spec. Do not fold it in.
- Do not change `runAgentLoop`'s existing `forceFinal` / `synthesisInstruction` machinery. The recovery turn is a NEW path that runs AFTER the loop's existing exit; it does not modify the existing exit.

---

## Done when

- Both `synthesize()` methods are deleted from `DiagnosticAgent` and `RecommendationAgent`.
- `runAgentLoop` carries `parseResult` + `recoveryPrompt` options; the recovery turn runs when `parseResult` returns null AND `recoveryPrompt` is provided.
- All 183 existing Vitest tests still pass (the morning's count; verify with `npm test`).
- The four agent test files under `test/agents/` still pass without modification.
- The two `// TODO: thread sessionId` comments at `lib/agents/diagnostic.ts:117` and `lib/agents/recommendation.ts:123` are removed only if their TODO surface was the `synthesize()` log line and that log line now lives inside `runAgentLoop`'s recovery helper (the cleanup stub for sessionId threading is the right place to decide that).
- `grep -n "synthesize" lib/agents/` returns zero matches in `diagnostic.ts` and `recommendation.ts` (the methods are gone; the option names live in `base.ts`).
- A quick smoke test: run the demo briefing end-to-end (`/api/briefing?demo=1`) and a live investigation (`/api/agent?insightId=...`) — both still produce the same final shape.
