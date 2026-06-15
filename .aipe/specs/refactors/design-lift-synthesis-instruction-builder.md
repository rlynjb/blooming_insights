# Design refactor — lift `synthesisInstruction` boilerplate into `buildSynthesisInstruction(shape)`

> Source: `.aipe/audits/design-2026-06-14.md` Lens 5 finding 5.1 (partially-pushed-up config, fires red-flag #4).
> Cross-ref: `.aipe/study-software-design/audit.md` red-flag #5 (12-day comprehension).
> Cross-ref: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-later #13 (promoted from `accept` morning #18 to pair with `synthesize()` lift).
> Ride-along with: `design-lift-synthesize-into-runagentloop.md` (same files touched, same through-line).

---

## What to refactor

Four agent classes pass a `synthesisInstruction` string into `runAgentLoop` that share a literal prefix and a literal closer; the middle is genuinely role-specific. The four sites:

- `lib/agents/monitoring.ts:102` — `synthesisInstruction: \`...JSON array of anomalies...\``
- `lib/agents/diagnostic.ts:63` — `synthesisInstruction: \`...single JSON object diagnosis...\``
- `lib/agents/recommendation.ts:58` — `synthesisInstruction: \`...JSON array of recommendations...\``
- `lib/agents/query.ts:42` — `synthesisInstruction: \`...plain prose answer...\``

The shared prefix is along the lines of "You have NO more tool calls available. Synthesize the final answer now."; the shared closer is "Do not say you need more queries"; the middle clause names the output shape (JSON-array-of-X / single-JSON-object-Y / plain-prose). Four strings; the prefix and closer are duplicated inline across all four.

Lift the boilerplate into a helper `buildSynthesisInstruction(shape: string): string` in `lib/agents/base.ts` (next to the existing `runAgentLoop`). The four agents pass only the `shape` clause; the helper returns the full instruction.

---

## Why

Two reasons, in order of leverage:

1. **AOSD red flag #5 (partially-pushed-up config) fires here directly.** `runAgentLoop` already owns `synthesisInstruction` as an opt-in — but the *shape* of the instruction (prefix + role-clause + closer) is the loop's design, not the agent's. The agents push UP the prefix and closer when they should push DOWN the shape clause. The loop has enough info to own everything except the shape clause; that's exactly the test for pull-complexity-downward.

2. **It rides along with `design-lift-synthesize-into-runagentloop.md` perfectly.** That stub adds `parseResult` + `recoveryPrompt` options to `runAgentLoop` and edits all four agent classes' `runAgentLoop({...})` call sites. While the executor is in `lib/agents/base.ts` adding two options and editing four call sites, adding one more helper export and replacing one more field in each call site is the same shape of edit. **Two stubs, one execution session if the executor pairs them.** They're kept separate per the "one technique per spec" rule in `refactor.md`, but the natural execution order is: ship 6.1 first (the bigger move), then this stub as the ride-along.

---

## Refactor type

**Extract Function** (the inline string concatenation in 4 places becomes one named helper) + **Parameterize Function** (the variable middle clause becomes the `shape` parameter; the prefix and closer are baked into the helper).

Not Replace Magic String with Named Constant (the strings aren't single constants — they're templated). Not Move Function (the helper is new). Not a structural refactor — single file gains an export; four files lose ~3 lines each.

---

## Current structure

```
  lib/agents/monitoring.ts:102
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: `You have NO more tool calls       │
  │ available. Synthesize the final answer now as a JSON      │
  │ array of anomalies. Do not say you need more queries.`   │
  └──────────────────────────────────────────────────────────┘

  lib/agents/diagnostic.ts:63
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: `You have NO more tool calls       │
  │ available. Synthesize the final answer now as a single   │
  │ JSON object diagnosis. Do not say you need more queries.`│
  └──────────────────────────────────────────────────────────┘

  lib/agents/recommendation.ts:58
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: `You have NO more tool calls       │
  │ available. Synthesize the final answer now as a JSON     │
  │ array of recommendations. Do not say you need more       │
  │ queries.`                                                 │
  └──────────────────────────────────────────────────────────┘

  lib/agents/query.ts:42
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: `You have NO more tool calls       │
  │ available. Synthesize the final answer now as a plain    │
  │ prose answer. Do not say you need more queries.`         │
  └──────────────────────────────────────────────────────────┘

   ▲                                                       ▲
   │ same prefix everywhere                                │ same closer everywhere
   │ "You have NO more tool calls available."              │ "Do not say you need
   │ + "Synthesize the final answer now as "               │  more queries."
   │                                                       │
   └─── duplicated 4×, edits-in-4-places when reworded ───┘
```

The middle ("a JSON array of anomalies" / "a single JSON object diagnosis" / "a JSON array of recommendations" / "a plain prose answer") is the only thing that varies.

---

## Target structure

```
  lib/agents/base.ts (add export)
  ┌──────────────────────────────────────────────────────────┐
  │ /** Build the forced-final synthesis prompt. The prefix  │
  │  *  and closer are owned by the loop because they reflect│
  │  *  the loop's decision to spend the last turn without   │
  │  *  tools; only the output shape clause is the agent's   │
  │  *  to provide. */                                       │
  │ export function buildSynthesisInstruction(               │
  │   shape: string,                                         │
  │ ): string {                                              │
  │   return (                                               │
  │     `You have NO more tool calls available. ` +          │
  │     `Synthesize the final answer now as ${shape}. ` +    │
  │     `Do not say you need more queries.`                  │
  │   );                                                     │
  │ }                                                        │
  └──────────────────────────────────────────────────────────┘

  lib/agents/monitoring.ts:102
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: buildSynthesisInstruction(         │
  │   'a JSON array of anomalies'                            │
  │ ),                                                       │
  └──────────────────────────────────────────────────────────┘

  lib/agents/diagnostic.ts:63
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: buildSynthesisInstruction(         │
  │   'a single JSON object diagnosis'                       │
  │ ),                                                       │
  └──────────────────────────────────────────────────────────┘

  lib/agents/recommendation.ts:58
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: buildSynthesisInstruction(         │
  │   'a JSON array of recommendations'                      │
  │ ),                                                       │
  └──────────────────────────────────────────────────────────┘

  lib/agents/query.ts:42
  ┌──────────────────────────────────────────────────────────┐
  │ synthesisInstruction: buildSynthesisInstruction(         │
  │   'a plain prose answer'                                 │
  │ ),                                                       │
  └──────────────────────────────────────────────────────────┘
```

End state: one file owns the prompt shape; four files own only their output-shape clause. Reword the prefix or closer once; four sites pick it up.

---

## Must not change

- The exact text of the prefix, the closer, and each shape clause — these strings are tuned for the model. The lift is a no-text-change refactor; the assembled string at each site must be byte-identical to today's inline string. Verify by capturing the string before and after at one site and `diff`ing.
- The behavior of `runAgentLoop` — it still reads `synthesisInstruction` exactly the way it does today (one string opt-in, appended to `system` on the forced-final turn). This stub only changes who BUILDS the string.
- The order or content of fields in the `runAgentLoop({...})` opts object at each call site — only the `synthesisInstruction:` value changes.
- The `lib/agents/intent.ts` and any other agent helper that doesn't use `synthesisInstruction` — don't touch them. Only the four `runAgentLoop` callers that pass `synthesisInstruction` are in scope.
- Do not touch the recovery prompts (`recoveryPrompt` introduced by `design-lift-synthesize-into-runagentloop.md`) — those are a different shape from `synthesisInstruction` and are out of scope for this stub.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond `buildSynthesisInstruction(shape: string): string`. Do not invent a `PromptBuilder` class; do not generalize to `buildInstruction(prefix, middle, closer)`; do not parameterize the prefix or closer. The whole point is that the prefix and closer are owned by the loop and don't take parameters.
- No additional refactors discovered along the way — if the executor session notices that the four agents' `runAgentLoop({...})` opts objects share *other* fields, that's a separate finding and a separate spec. Do not fold it in.
- Do not change the semantics of the forced-final turn (the loop's existing `forceFinal && synthesisInstruction ? \`${system}\n\n${synthesisInstruction}\` : system` at `lib/agents/base.ts:98` stays).

---

## Done when

- `buildSynthesisInstruction` is exported from `lib/agents/base.ts`.
- All four agent files (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) call `buildSynthesisInstruction('shape clause')` instead of inlining the full string.
- The assembled string at each site is byte-identical to the pre-refactor version (verify with a one-shot console.log diff, or by running the test suite — the existing 183 tests don't pin the exact synthesis string, so the verification has to be manual).
- All 183 existing Vitest tests still pass.
- `grep -nE "You have NO more tool calls" lib/agents/` returns exactly one match — the line inside `buildSynthesisInstruction`.
- A quick smoke test: run the demo briefing (`/api/briefing?demo=1`) — same final output. Run a live `/api/agent` step — same final output. The synthesis prompt change is a no-op at the model boundary; if the output changes, the lift introduced a string diff and must be reverted.
