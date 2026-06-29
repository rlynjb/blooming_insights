# Output mode mismatch

**Industry standard** · the failure mode at the chain-handoff seam

## Zoom out — where output modes live

Five agents, two output modes. The four structured agents (monitoring, diagnostic, recommendation, intent) emit JSON; the query agent emits prose. The route assembles the message stream and the validator decides what to do with each shape. When the mode at the producer doesn't match the mode at the consumer, the parser breaks — and the failure mode is silent in production (the type guard returns false; the route returns `[]`; the user sees an empty state with no error).

```
  Zoom out — output mode is per-agent, set in two places

  ┌─ producer (the agent) ──────────────────────────────────┐
  │   prompt: '## Output\nReturn ONLY a JSON array...'      │
  │           '...wrapped in a ```json fenced block:'        │
  │   →  declared mode: JSON-in-fence                        │
  └─────────────────────────────────────────────────────────┘
                              │  finalText
  ┌─ consumer (the route) ───▼──────────────────────────────┐
  │   parseAgentJson(finalText) ──► unknown                  │
  │   isAnomalyArray(parsed)    ──► Anomaly[] | false        │
  │   →  expected mode: JSON-in-fence                        │
  └─────────────────────────────────────────────────────────┘

  match: anomaly cards render
  mismatch: empty state, no error
```

## Zoom in

Output mode mismatch is when the prompt declares one shape and the consumer expects another. The classic version: chain A returns JSON, chain B's prompt expects markdown, the parser silently fails. Subtler versions exist in this codebase: the query agent returns prose, the route knows that and streams it as text; if someone "improved" the query prompt to also return JSON, the route's prose-passthrough would render the raw JSON to the user. This concept is about how to spot mismatches in code review before they ship.

## Structure pass

**Layers.** Two: the *declared mode* in the prompt's `## Output` section, and the *handled mode* in the route's response-processing code.

**Axis traced — contract.** Hold one question constant: *what shape does the consumer expect to receive?*

```
  Axis = output contract — what shape, what wrapper, what guard?

  ┌─ four structured agents ────────────────────────────────┐
  │   declared:  JSON (array or object) inside ```json fence│
  │   handled:   parseAgentJson + type guard                 │
  │   on miss:   degrade to [] or null                       │
  └─────────────────────────────────────────────────────────┘

  ┌─ query agent (prose) ───────────────────────────────────┐
  │   declared:  plain prose, no JSON, no fence              │
  │   handled:   streamed as text to the UI                  │
  │   on miss:   user sees raw JSON in the chat panel        │
  └─────────────────────────────────────────────────────────┘
```

**Seams.** The producer-consumer seam is where mismatches live. The producer's contract is in the `.md` file (the `## Output` section). The consumer's contract is in the route's parse-and-validate code. Both sides have to agree on (a) format wrapper — fence or no fence, (b) shape — array or object or string, (c) field schema — what's required, what's optional. Mismatches on any of the three produce a silent failure.

## How it works

### Move 1 — the contract per agent, side by side

```
  Five agents, five output contracts — read each one's ## Output section

  ┌─ monitoring.md:71-72 ───────────────────────────────────┐
  │  Return ONLY a JSON array of anomaly objects, at most    │
  │  10 items, sorted by severity..., wrapped in a ```json   │
  │  fenced block                                            │
  │   → shape: array · wrapper: ```json fence · validator: isAnomalyArray
  └─────────────────────────────────────────────────────────┘

  ┌─ diagnostic.md:58-60 ──────────────────────────────────┐
  │  Return ONLY a JSON object (in a ```json fenced block)   │
  │  of exactly this shape: { "conclusion": ..., ... }       │
  │   → shape: object · wrapper: ```json fence · validator: isDiagnosis
  └─────────────────────────────────────────────────────────┘

  ┌─ recommendation.md:49-50 ──────────────────────────────┐
  │  Return ONLY a JSON array (in a ```json fenced block) of│
  │  at most 3 objects, each of exactly this shape: ...      │
  │   → shape: array · wrapper: ```json fence · validator: isRecommendationArray
  └─────────────────────────────────────────────────────────┘

  ┌─ intent (inline in intent.ts:29-31) ────────────────────┐
  │  'Reply with ONLY the one word.'                         │
  │   → shape: string (one word) · wrapper: none ·            │
  │     validator: parseIntent (substring match)              │
  └─────────────────────────────────────────────────────────┘

  ┌─ query.md:46-50 ───────────────────────────────────────┐
  │  Give a clear, concise answer in plain prose — a few    │
  │  sentences; you may use short markdown bullets.          │
  │  No JSON shape is required — just the answer text.       │
  │   → shape: prose · wrapper: none · validator: none       │
  └─────────────────────────────────────────────────────────┘
```

Three of the five use the same ```json fence convention; one (intent) uses bare text expected to match a substring; one (query) uses prose. The consistency where it exists is deliberate — three agents using the same wrapper means `parseAgentJson` works for all of them. Inconsistency where it exists is also deliberate (intent needs to fit in 16 tokens; prose can't be parsed).

### Move 2 — the mismatch in code review

Here's the bug you're looking for in a PR. Someone "improves" the query agent's prompt to also return structured data:

```
  PR diff that introduces an output-mode mismatch

  --- a/lib/agents/legacy-prompts/query.md
  +++ b/lib/agents/legacy-prompts/query.md
  @@ -46,4 +46,8 @@ ## Output

  -Give a clear, concise answer in plain prose...
  -No JSON shape is required — just the answer text.
  +Return a JSON object with shape:
  +```json
  +{ "answer": "...", "citations": [...] }
  +```
  +Wrap the answer in plain prose; the JSON is for the UI.
```

The diff looks reasonable. The reviewer needs to know to ask: *who consumes this output? does the consumer parse JSON?* Looking at the route:

```
  // app/api/agent/route.ts:255-257 (current)
  const answer = await queryAgent.answer(q, intent, { ... });
  stepFor('coordinator', 'conclusion', answer);
  send({ type: 'done' });
```

The route does `stepFor('coordinator', 'conclusion', answer)` — passing the answer straight to the trace, which the UI renders as text. If the answer is now JSON, the user sees raw JSON in the chat panel. The fix has to land in two places: the prompt change *and* the route change *and* probably a new type guard. If only the prompt changes, the failure is silent.

```
  Code-review checklist for output-mode changes

  ┌─ when reviewing a prompt change ────────────────────────┐
  │   1. did the ## Output section change?                  │
  │   2. who consumes this output (grep the agent's call)?  │
  │   3. does the consumer's parsing match the new shape?   │
  │   4. is there a type guard? does it need updating?      │
  │   5. is the degradation path still safe?                │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — mismatch from chain composition

The other place mismatches show up: when chain A's output is chain B's input. The recommendation agent takes a `Diagnosis` (from the diagnostic agent) and an `Anomaly` (from monitoring). The contract for "what fields a Diagnosis has" is defined in `lib/mcp/types.ts`:

```
  // lib/mcp/types.ts:95-104 — the Diagnosis contract
  export interface Diagnosis {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: { hypothesis: string; supported: boolean;
                             reasoning: string }[];
    affectedCustomers?: { count: number; segmentDescription: string };
    confidence?: 'high' | 'medium' | 'low';
    timeSeries?: { day: string; value: number }[];
  }
```

The recommendation agent's prompt interpolates the Diagnosis as JSON via the `{diagnosis}` slot:

```
  // recommendation-legacy.ts:46
  .replace('{diagnosis}', JSON.stringify(diagnosis));
```

If a future PR adds a new required field to `Diagnosis` (let's say `severity: Severity`), three things have to update together:
- The TypeScript type
- The `isDiagnosis` type guard (so the new field is checked)
- The recommendation agent's prompt (so it knows the field exists and what it means)

Miss one and you have a mismatch. The TypeScript type protects the compile-time path; the type guard protects the runtime path; the prompt protects the model's understanding. All three are part of the same contract; all three move together.

### Move 2 — the contract pinned in the prompt example

The thing that prevents most output-mode mismatches in this codebase is the worked example in each prompt. Look at the monitoring prompt's `## Output` section: the example JSON object is *not* just illustrative; it's the canonical shape the model is expected to emit. If a developer changes the type guard to require a new field, they should also update the example. If they update the example but not the guard, the guard fails on the new field. If they update the guard but not the example, the model emits the old shape and the guard rejects.

```
  The three places the contract has to agree

  ┌─ TypeScript type (lib/mcp/types.ts) ────────────────────┐
  │   Anomaly { ... category?: CategoryId; ... }            │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Type guard (lib/mcp/validate.ts) ─▼────────────────────┐
  │   isAnomalyArray checks: metric, scope, change,         │
  │                          severity                       │
  │   does NOT check: category, impact (optional)           │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Prompt example (legacy-prompts/monitoring.md:73-85) ─▼─┐
  │   { "metric": "...", "category": "...", "scope": [...], │
  │     "change": {...}, "severity": "...", "impact": "...",│
  │     "evidence": [...] }                                  │
  └─────────────────────────────────────────────────────────┘

  these three must agree on:
    - required vs optional fields
    - enum values (severity, direction, bloomreachFeature)
    - shape of nested objects (change, evidence)
```

When you add a new required field, you edit all three. When you add a new optional field, you edit the type + the prompt example (the guard doesn't need to check it). The discipline is: *if you change the contract, change every place it's expressed*. If you can't, you don't have one contract; you have three.

### Move 2 — the silent-failure case

The reason mismatch matters: the failure is silent. Look at the degrade behavior at `lib/agents/monitoring-legacy.ts:128-136`:

```
  // monitoring-legacy.ts:128-136
  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];                              // ← parse failed → empty array
  }
  if (!isAnomalyArray(parsed)) return [];   // ← shape failed → empty array
```

Both failure modes return `[]`. The route still streams `done`. The UI shows "no anomalies found." The user has no idea anything went wrong. The on-call engineer sees nothing in the logs because the route didn't error. The only way to notice is to look at the captured raw output (which isn't logged) or to spot that briefings have been suspiciously empty for the last 48 hours.

This is the strongest argument for evals (concept #5): the type guards prevent crashes, but they don't prevent silent regressions. An eval would catch "the monitoring agent suddenly returns 0 anomalies for inputs that used to produce 3" before it shipped. The type guards alone cannot.

### Move 3 — the principle

Output mode is a contract between producer and consumer, and the contract lives in three places: the producer's prompt, the consumer's parser, and the typed boundary between them. Change one without the others and you ship a silent mismatch. Read every prompt change in PR review with the question "what consumes this output?" — if the answer isn't immediately clear, the change isn't ready to merge.

## Primary diagram

```
  Output mode mismatch — where it hides, how to spot it

  ┌─ producer side ────────────────────────────────────────────┐
  │  ## Output section in the .md template                      │
  │    declares: shape, wrapper, field schema                   │
  │  ## Output example (a worked JSON object)                   │
  │    pins: the canonical instance                             │
  └────────────────────────────┬───────────────────────────────┘
                               │  finalText
  ┌─ boundary (lib/mcp/validate.ts) ▼──────────────────────────┐
  │  parseAgentJson  ← extracts JSON from text + fence          │
  │  isAnomalyArray  ← narrows unknown → Anomaly[]              │
  │  isDiagnosis     ← narrows unknown → Diagnosis              │
  │  isRecommendationArray ← narrows unknown → Recommendation[] │
  └────────────────────────────┬───────────────────────────────┘
                               │  typed value | false
  ┌─ consumer side ────────────▼───────────────────────────────┐
  │  monitoring-legacy.ts:128-136                                │
  │    on parse fail   → return []                              │
  │    on guard fail   → return []                              │
  │  route handles the empty value                              │
  │  UI shows empty state                                       │
  └────────────────────────────────────────────────────────────┘

  silent-failure path:
    declared mode changes  →  guard returns false  →  []  →  UI silent
    (no log line · no error · no user-visible feedback)
```

## Elaborate

The silent-failure property is what makes output mismatch sneakier than most prompt bugs. A typo in the prompt that breaks the model's reasoning shows up in the output (the user sees a weird answer). A mismatch shows up as *nothing* — the type guard returns false, the route returns the empty value, the UI handles the empty case gracefully (as it should), and there's no log line that says "the output was rejected by the guard." The guard is doing its job (degrade safely). The route is doing its job (handle empty values). The UI is doing its job (render the empty state). And yet the user has had a broken briefing for two weeks.

The fix is observability at the guard boundary. The guards are the place where "the model gave us something we didn't accept" is decided; logging that decision (with a sampled fraction of the rejected output) is the single highest-leverage observability change this codebase could make for prompt debugging. Right now, guard failures are silent. Logging them would surface mismatches the day they ship.

The chain-handoff version of mismatch — diagnostic output feeding recommendation input — is partially protected by TypeScript. The `Diagnosis` type's shape is enforced at compile time on the `recommendation.propose(anomaly, diagnosis)` call signature. What TypeScript doesn't protect is the *prompt's understanding* of the diagnosis shape: if the diagnostic agent's prompt is updated to put information in a new field, the recommendation agent's prompt doesn't automatically know. The handoff is typed at the data layer and prose-bound at the model layer.

The reader's loopd portfolio (per `me.md`) exercises chain composition; this concept's failure mode is the one that bites all chain-composed LLM systems eventually. The discipline that prevents it: every prompt change asks "what reads this output?" and every output-shape change asks "do all three places agree?" (TypeScript type, type guard, prompt example). Make this part of code review; you won't catch every mismatch, but you'll catch the ones that would have shipped.

## Interview defense

**Q: How would you catch an output-mode mismatch in code review?**

A: Two-part check. **First**, on any change to a prompt's `## Output` section, grep for who calls that agent and read the parsing code: does the parser expect a fence? does the type guard expect those fields? does the route handle the new shape? If any answer is "no" or "not yet," the change isn't ready. **Second**, on any change to a type guard or a TypeScript interface like `Diagnosis`, check that the prompt's worked example reflects the new shape. The three places the contract is expressed — TypeScript type, type guard, prompt example — have to agree, and a PR that updates one without the others is a silent-failure waiting to ship. Treat the contract as a triangle: if you move one corner, you move all three.

```
  what I'd sketch:

         TypeScript type
         /            \
        /              \
  Type guard ─────── Prompt example

  move one corner → must move the others
  (compiler only enforces type ↔ guard;
   prompt is freelance — review for it.)
```

**Q: What's the worst failure mode here?**

A: Silent regression. The type guard returns false, the route returns the empty value, the UI renders an empty state gracefully — and nobody knows the model has been producing rejected output for the last two weeks. There's no error in the log. There's no error in the UI. The only signal is "the product seems to be returning fewer anomalies than usual." The fix that has the highest leverage is logging at the guard boundary: every time `isAnomalyArray` returns false, log the rejected output (sampled, with PII stripped) and the agent name. That single log line turns mismatches from a two-week mystery into a same-day alert. The whole "silent failures are degraded gracefully" path is good design; what's missing is the observability hook that says "degraded gracefully" without saying "and nothing is going wrong." The guard rejection is exactly that signal.

```
  observability gap → log change to close it:

  today:   guard returns false → return []      (silent)
  fix:     guard returns false → console.error( (loud)
             { site: 'validate', agent: 'monitoring',
               sample: sampledOutput })
           return []

  cost: one log line · benefit: same-day alerts on mismatch
```

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — the parser and guards that decide what counts as a mismatch
- [03-prompts-as-code.md](./03-prompts-as-code.md) — the prompt-change PR review is where mismatches get caught
- [05-eval-driven-iteration.md](./05-eval-driven-iteration.md) — eval would catch behavior regressions the guards miss
- [06-single-purpose-chains.md](./06-single-purpose-chains.md) — typed handoffs make the chain-handoff version of mismatch a compile-time error
