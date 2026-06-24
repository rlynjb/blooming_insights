# Synthesize as cost concentration

**Industry name(s):** forced-synthesis fallback · structured-output forcing turn · cost concentration · the unmeasured line item
**Type:** Project-specific (the synthesize fallback) · Industry standard (cost concentration as a pattern)

> The `synthesize()` methods at `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132` are the suspected dominant per-investigation cost line — and as of 2026-06-15, this pair is **the only remaining unmeasured Anthropic call site in the codebase**. The other 3 of 5 sites (`base.ts:135` runAgentLoop, `base.ts:257` runRecoveryTurn, `intent.ts:36` intent classifier) now log `res.usage`. The two suspect synthesize() retries still don't — exactly the call sites this file argues dominate. Phase 3 produced first measured per-investigation cost data: ~$10-15 total across K=10 × 4 eval pillars on the Olist adapter, but that aggregate doesn't decompose into per-call attribution. The synthesize call fires when the agent loop fails to parse valid JSON from the model's final turn (`lib/agents/diagnostic.ts:78-86`, `lib/agents/recommendation.ts:74-80`). It's a tool-less Anthropic call that asks the model to emit a long structured JSON payload (a `Diagnosis` with evidence + hypotheses, or 2-3 full `Recommendation` objects). Output tokens cost roughly 5× input tokens, and this call is *almost all output*. **The unmeasured state IS still the pattern, but the gap is narrower**: ~2 lines of `console.log` at the 2 remaining sites confirms or refutes the dominant-cost hypothesis.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Every multi-agent LLM system has a "cost concentration" — one specific call type that dominates the per-investigation bill. Usually it's the longest-context call (input-token heavy) or the most-output call (output-token heavy). For blooming insights, it's strongly suspected to be the `synthesize()` fallback: tool-less, output-heavy, fires whenever the agent loop's parse fails. The structural problem isn't that it costs money — it's that *no measurement confirms or refutes the suspicion*. Without `res.usage` logging, every claim about cost is an inference from code shape. Cost concentration with no meter is the worst combination: the dominant line item is also the invisible one.

```
  Zoom out — where the cost concentration lives

  ┌─ UI ───────────────────────────────────────────────┐
  │  user clicks "investigate"                         │
  │  no visible cost to user (no per-call $ display)  │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Route ────────────────▼────────────────────────────┐
  │  agent run kicks off                                │
  │  no cost accounting at the route                    │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ Agent loop ───────────▼────────────────────────────┐
  │  runAgentLoop (lib/agents/base.ts:79)               │
  │    fires maxTurns × anthropic.messages.create       │
  │    each turn returns res.usage (UNREAD)             │
  │                                                      │
  │  if loop ends without valid JSON:                   │
  │    ★ synthesize() fallback fires ★                  │  ← we are here
  │    tool-less call, output-heavy structured JSON     │
  │    res.usage returned (UNREAD)                      │
  └────────────────────────┬────────────────────────────┘
                           │
  ┌─ External ────────────▼─────────────────────────────┐
  │  Anthropic API: returns res.usage on every call     │
  │  free data, dropped on the floor                    │
  └─────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what is the synthesize call, why is it suspected to be the cost concentration, and why does "suspected" matter more than "is"?* The answer is *it's the tool-less structured-JSON fallback fired when the loop's final turn fails to parse; it's suspected to be the dominant line item because it emits large output (output tokens cost ~5× input tokens) and runs at a frequency that's never been counted; and "suspected" matters because the cheapest fix in the codebase (5 lines of `console.log`) would turn it from suspected to measured.* Below, you'll see the synthesize call's shape, the cost arithmetic that makes it suspect, the failure mode of leaving it unmeasured, and the five-line fix that resolves all of it.

---

## Structure pass

**Layers.** Two layers carry the cost concentration. The agent loop runs the main per-turn calls (input-heavy, growing messages array). The synthesize fallback runs *one* additional call when the loop fails to emit valid JSON on its final turn (output-heavy, no tools, forces a structured payload).

**Axis: where the dollars go.** Hold one question constant across every call site: *what does this specific call cost, in what split (input vs output tokens)?* Cost in the input/output split is the right axis because LLM pricing is asymmetric — Anthropic charges roughly 5× more for output tokens than input tokens. A call that's "small input, big output" is dramatically more expensive per call than a call that's "big input, small output," even though both fire the same `messages.create` endpoint.

**Seams.** Three load-bearing.

- **CC1: input-heavy ↔ output-heavy.** The main loop turn is input-heavy (the full messages array re-tokenized each turn). The synthesize call is output-heavy (the structured JSON payload is the main work). The cost shapes are inverted.
- **CC2: measured ↔ unmeasured.** Both call types return `res.usage`. Neither is logged. The cost is *recovery-cost free* (the data is already delivered) but currently *recovery-effort zero* (we don't read it).
- **CC3: suspected ↔ confirmed.** Today, "synthesize is the dominant cost" is a structural inference. Confirming it requires `res.usage` logging — the five-line fix that the audit ranks as R2.

```
  Structure pass — Synthesize as cost concentration

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Agent loop (input-heavy turns) ·                 │
  │  Synthesize fallback (output-heavy)               │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  where the dollars go: input vs output tokens     │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across calls
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  CC1: input-heavy ↔ output-heavy                  │
  │  CC2: measured ↔ unmeasured       ★ the meter is  │
  │                                      five lines    │
  │  CC3: suspected ↔ confirmed       ★ today: only   │
  │                                      suspected     │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the synthesize call's shape, the cost arithmetic, and the five-line fix.

---

## How it works

### Move 1 — the mental model

You've shipped a feature where the LLM is supposed to return JSON, and you've watched it return prose instead — every senior LLM engineer has been bitten. The standard fix is *forced structured output*: drop the tools, append "Output ONLY a JSON object…" to the system prompt, and let the model emit the structured payload on a final turn. blooming insights does exactly this in the synthesize fallback. The cost wrinkle is that this final call is *almost all output tokens* — the input is small (the conversation history + the synthesis instruction) but the output is the full structured JSON (a `Diagnosis` with confidence + summary + evidence array + hypotheses array; or 2-3 `Recommendation` objects each with title + rationale + suggested_actions). At Anthropic's pricing (output ~5× input), an output-heavy call is the line item that dominates the bill.

```
  Pattern — input-heavy vs output-heavy turn (the asymmetric cost)

   MAIN LOOP TURN (input-heavy)
     input:  full messages[] history (~5-20KB) + system prompt (~5-10KB)
              + tools schema (~5-15KB)
              ≈ 5,000-12,000 input tokens
     output: model's reasoning + tool_use blocks
              ≈ 500-2,000 output tokens
     cost split: ~80% input, ~20% output (relative to per-token rate)

   SYNTHESIZE FALLBACK (output-heavy)
     input:  conversation history (smaller — no tools, no schema)
              + synthesis instruction (~few hundred chars)
              ≈ 3,000-6,000 input tokens
     output: full structured JSON payload
              ≈ 1,500-4,000 output tokens (Diagnosis) or
                3,000-6,000 output tokens (3 Recommendations)
     cost split: ~30-50% input, ~50-70% output (relative to per-token rate)

   the synthesize call's PER-CALL cost is comparable to a loop turn,
   but the output is amplified by Anthropic's ~5× output multiplier.

   on a typical investigation where synthesize fires once per agent:
     diagnostic agent: 6 loop turns (input-heavy) + 1 synthesize (output-heavy)
     recommendation agent: same shape
     total: 12 loop turns + 2 synthesize = 14 calls, with 2 being the
            output-heavy line item that dominates the bill
```

The model: **the synthesize call is the few-shot of cost concentration**. Most of the calls in the system are similar in cost shape (input-heavy loop turns); two calls per investigation are the output-heavy outliers. Those two calls plausibly account for 30-50% of the per-investigation token cost — but nobody knows for sure.

---

### Move 2 — the synthesize shape, the cost math, the unmeasured state, the fix

#### Move 2.1 — what the synthesize call actually does

The agent loop completes its turns (up to `maxTurns` or `maxToolCalls`). The final turn is `forceFinal: true` — tools are dropped, the synthesis instruction is appended (`lib/agents/base.ts:88-101`). If the model's response *parses as valid JSON*, the loop succeeds and we're done. If parsing fails, the `synthesize()` method fires as a *separate* additional Anthropic call.

```
  Pattern — the synthesize fallback fires (when loop's final JSON fails to parse)

   1. agent loop runs (up to maxTurns turns, up to maxToolCalls tool calls)
        │
        ▼
   2. final turn: forceFinal=true
        - tools dropped from request
        - synthesis instruction appended to system prompt
        - model emits a final text response
        │
        ▼
   3. caller (investigate / propose) tries to parse the final text as JSON
        │
        ├─ parse SUCCEEDS:   loop's output is the structured answer; DONE
        │
        └─ parse FAILS:      synthesize() fires as a SEPARATE call
             │
             ▼
   4. synthesize() makes ONE MORE anthropic.messages.create call
        - input:  the full conversation history + a strict synthesis instruction
                  "Output ONLY a JSON object matching the schema..."
        - tools:  NONE
        - output: the structured JSON payload (Diagnosis or Recommendations)
        │
        ▼
   5. parse the synthesize response → return the structured answer

   the cost wrinkle: synthesize is fired ONLY when the loop's final
   turn already failed to parse. so synthesize is an ADDITIONAL call,
   not a REPLACEMENT for the loop's final turn.
```

The boundary: **synthesize is a recovery mechanism, not the primary path**. The intended flow is "loop completes → final turn parses → done." The actual flow on a non-trivial fraction of runs is "loop completes → final turn doesn't parse → synthesize fires → parses → done." The frequency of the second path is one of the unmeasured numbers.

#### Move 2.2 — the cost arithmetic (what makes it the concentration)

Anthropic's pricing (for sonnet, as of this writing) is roughly $3/MTok input and $15/MTok output — output is 5× input. The cost of any given call is dominated by its output tokens unless the input is dramatically larger than the output (which is the case for loop turns but NOT for synthesize).

```
  Pattern — per-call cost rank (estimates, would be confirmed by R2)

  ─── per loop turn (input-heavy) ────────────────────────────────────────
   input:   6,000 tokens × $3/MTok    = $0.018
   output:    800 tokens × $15/MTok   = $0.012
   ────────────────────────────────────
   per-call: ~$0.030

  ─── per synthesize call (output-heavy) ────────────────────────────────
   input:   4,000 tokens × $3/MTok    = $0.012
   output:  3,000 tokens × $15/MTok   = $0.045
   ────────────────────────────────────
   per-call: ~$0.057

   synthesize is ~2× the per-call cost of a loop turn, primarily
   because of the output-token amplification.

  ─── per investigation (rough estimate, NOT MEASURED) ───────────────────
   diagnostic agent:    6 loop turns × $0.030  = $0.18
                        + 1 synthesize × $0.057  = $0.057   (IF fires)
                                                  ────────
                                                  $0.24
   recommendation agent: 3 loop turns × $0.030  = $0.09
                         + 1 synthesize × $0.057 = $0.057   (IF fires)
                                                  ────────
                                                  $0.15
   intent classifier:    1 haiku call            = $0.005 (cheap)
   ────────────────────────────────────────────────────
   per-investigation:    ~$0.40 with both syntheses firing
                         ~$0.27 with neither firing
                         synthesize = ~30% of total when fires

   ★ ALL OF THESE NUMBERS ARE INFERRED. THE METER WOULD CONFIRM. ★
```

The boundary: **the relative ranking is structural; the absolute numbers are estimates**. We can say with confidence "synthesize is per-call more expensive than a loop turn" because output tokens cost more and synthesize is output-heavier. We can NOT say with confidence "synthesize is 30% of the per-investigation cost" because we don't know the synthesize fire rate, the actual output token counts, or whether a model swap (sonnet → opus) has happened.

#### Move 2.3 — the unmeasured state (the load-bearing pattern)

Here's the part that makes this a pattern worth its own file. There are four `anthropic.messages.create` call sites in the codebase. None of them read `res.usage`.

```
  Pattern — the four call sites, all unread

   lib/agents/base.ts:102          (main loop turn)
     const res = await this.anthropic.messages.create(params);
     // res.usage is returned. Nobody reads it.

   lib/agents/diagnostic.ts:97     (synthesize fallback for Diagnosis)
     const res = await this.anthropic.messages.create({...});
     // res.usage is returned. Nobody reads it.

   lib/agents/recommendation.ts:96 (synthesize fallback for Recommendations)
     const res = await this.anthropic.messages.create({...});
     // res.usage is returned. Nobody reads it.

   lib/agents/intent.ts:18         (haiku intent classifier)
     const res = await anthropic.messages.create({...});
     // res.usage is returned. Nobody reads it.

   res.usage shape:
     { input_tokens:  number,
       output_tokens: number,
       cache_creation_input_tokens: number,
       cache_read_input_tokens:     number }

   ★ FREE DATA. ALREADY DELIVERED. DROPPED ON THE FLOOR. ★
```

The boundary: **the data is recovery-free**. The network already delivered `res.usage` on every call; the client SDK already parsed it; the response object already has it as a typed field. Reading it requires one property access per call site. There is no cost to recovering the data — only the cost of *not bothering*.

The failure mode of leaving it unmeasured: **every cost-related decision is shipped blind**.

```
  Pattern — what's silently invisible without res.usage

   - the actual per-investigation cost (today: estimated, not measured)
   - the synthesize fire rate (today: unknown — could be 0%, could be 80%)
   - the cost impact of a prompt change (today: no before/after possible)
   - the cost impact of a model swap (today: no before/after possible)
   - whether prompt-prefix caching (R4) would help (today: can't compute the savings)
   - whether maxToolCalls=6 is right (today: no data on synthesize fire rate
                                       to compare against the 6-call budget)
   - whether the haiku classifier saves what we think (today: no measurement)

   every soft budget in file 01 depends on this measurement landing.
```

#### Move 2.4 — the five-line fix that resolves all of it

Here's the entire fix. Five lines.

```
  Pattern — the five-line fix (R2 in the audit)

   lib/agents/base.ts (after line 102):
     const res = await this.anthropic.messages.create(params);
   + console.log('[perf]', { agent, kind: 'loop_turn', turn, ...res.usage });

   lib/agents/diagnostic.ts (after line 117 — inside synthesize()):
     const res = await this.anthropic.messages.create({...});
   + console.log('[perf]', { agent: 'diagnostic', kind: 'synthesize', ...res.usage });

   lib/agents/recommendation.ts (after line 122 — inside synthesize()):
     const res = await this.anthropic.messages.create({...});
   + console.log('[perf]', { agent: 'recommendation', kind: 'synthesize', ...res.usage });

   lib/agents/intent.ts (after line 26):
     const res = await anthropic.messages.create({...});
   + console.log('[perf]', { agent: 'coordinator', kind: 'classify', ...res.usage });

   four lines (well, 4-5 lines counting the loop-turn one).
   ships to Vercel function logs (which are queryable).
```

What this unblocks:

```
  Pattern — what the five lines turn on

   - synthesize fire rate becomes countable (filter by kind: 'synthesize')
   - per-investigation cost becomes summable (sum over all four kinds)
   - per-call cost becomes measured (mean/p95 per kind)
   - cost regressions become detectable (before/after a prompt change)
   - R1 (cost concentration) becomes CONFIRMED or REFUTED (not just suspected)
   - R3 (route budget headroom) becomes correlatable with cost (heavy investigations
       are also slow investigations)
   - R4 (prompt-prefix caching) becomes economically justifiable with numbers
   - every soft budget in file 01 becomes possible to set

   the unblock asymmetry: 5 lines unblock ~7 distinct decisions.
   this is the cheapest fix-to-leverage ratio in the entire codebase.
```

---

### Move 3 — the principle

**Cost concentration without measurement is the worst combination.** Having a dominant line item is fine (every system has one); having an *unmeasured* dominant line item is dangerous (any change can move the bill silently). The synthesize call is the structural cost concentration in blooming insights, but the load-bearing fact isn't the call — it's the missing meter. The right discipline is: **before optimizing any LLM cost, log `res.usage` on every call**. The data is free. The fix is trivial. The unblock is enormous. blooming insights ships without the meter today; until the meter lands, every cost claim in this file is an inference, not a measurement. The general principle: **measurement before optimization, even (especially) when the optimization is obvious.**

---

## Primary diagram

The full picture — the synthesize call's role, the four unread `res.usage` sites, the five-line fix, and what it unblocks.

```
  blooming insights — synthesize as cost concentration

  ┌─ Agent loop (every investigation) ────────────────────────────────┐
  │                                                                    │
  │  lib/agents/base.ts:102                                            │
  │    const res = await this.anthropic.messages.create(params);       │
  │    ★ res.usage RETURNED but UNREAD ★                               │
  │                                                                    │
  │  fires up to maxTurns times per agent (default 8)                  │
  │  cost shape: INPUT-heavy (messages[] grows per turn)               │
  │  per-call cost (estimated): ~$0.030                                │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │  if loop's final JSON fails to parse:
                                   ▼
  ┌─ Synthesize fallback (recovery, output-heavy) ─────────────────────┐
  │                                                                    │
  │  lib/agents/diagnostic.ts:87-126                                   │
  │    private async synthesize(...): Promise<Diagnosis> {             │
  │      const res = await this.anthropic.messages.create({            │
  │        system: PROMPT + "\nOutput ONLY a JSON object..."           │
  │        messages,                                                    │
  │        // no tools                                                  │
  │      });                                                            │
  │      ★ res.usage RETURNED but UNREAD ★                             │
  │      return parseDiagnosis(res);                                    │
  │    }                                                                │
  │                                                                    │
  │  lib/agents/recommendation.ts:82-132   (same shape, returns        │
  │                                          Recommendation[])         │
  │                                                                    │
  │  cost shape: OUTPUT-heavy (~3-6K output tokens)                    │
  │  per-call cost (estimated): ~$0.057  (~2× a loop turn)             │
  │  fires: ONLY when loop's final turn fails to parse                 │
  │  fire rate: UNKNOWN (no counter, no metric)                        │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │
  ┌─ Anthropic API (returns res.usage on EVERY call) ──────────────────┐
  │                                                                    │
  │  res.usage = {                                                     │
  │    input_tokens:  number,                                          │
  │    output_tokens: number,                                          │
  │    cache_creation_input_tokens: number,                            │
  │    cache_read_input_tokens:     number                             │
  │  }                                                                  │
  │                                                                    │
  │  ★ FREE DATA — delivered on the wire — never read ★                │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ THE FIVE-LINE FIX (R2 in the audit) ──────────────────────────────┐
  │                                                                    │
  │  add `console.log('[perf]', { agent, kind, ...res.usage })`        │
  │  at each of the four call sites:                                   │
  │   - lib/agents/base.ts:102               (loop_turn)               │
  │   - lib/agents/diagnostic.ts:97          (synthesize / Diagnosis)  │
  │   - lib/agents/recommendation.ts:96      (synthesize / Recommends) │
  │   - lib/agents/intent.ts:18              (haiku classifier)        │
  │                                                                    │
  │  ships to Vercel function logs (already queryable)                 │
  │                                                                    │
  │  unblocks:                                                         │
  │   - per-investigation cost (now SUMMABLE)                          │
  │   - synthesize fire rate (now COUNTABLE)                           │
  │   - R1 cost concentration (now CONFIRMED or REFUTED)               │
  │   - R3 budget headroom correlation                                 │
  │   - R4 prompt-prefix caching ROI                                   │
  │   - every soft budget in file 01                                   │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where synthesize fires (and where it doesn't)

- **Diagnostic agent: synthesize for Diagnosis.** Fires when the loop's final turn returns a text response that can't be parsed as a `Diagnosis` (missing fields, malformed JSON, prose instead of JSON). `lib/agents/diagnostic.ts:78-86` is the trigger; `lib/agents/diagnostic.ts:87-126` is the synthesize call.
- **Recommendation agent: synthesize for Recommendation[].** Same shape — parse fails on the loop's final turn, synthesize fires. `lib/agents/recommendation.ts:74-80` triggers `lib/agents/recommendation.ts:82-132`.
- **Monitoring agent: NO synthesize.** The monitoring scan doesn't have a synthesize fallback — its output structure is different (it emits anomalies as they're detected via the `emit_anomaly` tool, not a final structured JSON). So the monitoring agent's cost shape lacks the synthesize concentration.
- **Query agent: NO synthesize.** Same as monitoring — the query agent returns either a text answer or an EQL result; no fallback for structured-JSON parsing.
- **Intent classifier (`lib/agents/intent.ts`): cheap, NOT a concentration.** Single haiku call per `?q=` query. Output is a short classification, not a structured payload. Cost is ~$0.005/call — noise.

### Code side by side

**The diagnostic synthesize call — the recovery path that's suspected to be the cost concentration.**

```
  lib/agents/diagnostic.ts  (lines 87–126, abbreviated)

  private async synthesize(
    inv: Investigation,
    history: Anthropic.Messages.MessageParam[],
  ): Promise<Diagnosis> {
    const sys = `${PROMPT}\n\n${SYNTHESIS}`.replace(/\{\{SCHEMA\}\}/g, summary);
    const messages = [
      ...history,
      {
        role: 'user',
        content: 'Output ONLY a JSON object matching the Diagnosis schema...',
      },
    ];

    const res = await this.anthropic.messages.create({                    ← THE CALL
      model: AGENT_MODEL,
      max_tokens: 4096,                                                   ← bounds output
      system: sys,
      messages,
      // ★ NO tools — this is the tool-less forcing call ★
    });
    // ★ res.usage RETURNED but UNREAD ★                                  ← THE GAP

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseDiagnosis(text);                                          ← parse the output
  }
        │
        └─ FIVE design decisions, four of which are correct:
           (1) max_tokens: 4096 — bounds the output (good)
           (2) no tools — forces text output (good, required for structured JSON)
           (3) explicit "Output ONLY a JSON object..." instruction (good)
           (4) appends to the conversation history (good — keeps context)
           (5) ★ no res.usage logging ★ (THE GAP — load-bearing)
```

**The recommendation synthesize — same shape, slightly larger output.**

```
  lib/agents/recommendation.ts  (lines 82–132, abbreviated)

  private async synthesize(
    inv: Investigation,
    diagnosis: Diagnosis,
    history: Anthropic.Messages.MessageParam[],
  ): Promise<Recommendation[]> {
    const sys = `${PROMPT}\n\n${SYNTHESIS}`.replace(/\{\{SCHEMA\}\}/g, summary);
    const messages = [
      ...history,
      {
        role: 'user',
        content: 'Output ONLY a JSON array of 2-3 Recommendation objects...',
      },
    ];

    const res = await this.anthropic.messages.create({                    ← THE CALL
      model: AGENT_MODEL,
      max_tokens: 4096,
      system: sys,
      messages,
    });
    // ★ res.usage RETURNED but UNREAD ★                                  ← THE GAP

    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseRecommendations(text);                                    ← parse 2-3 objects
  }
        │
        └─ output payload is BIGGER than diagnostic's synthesize (2-3
           full Recommendation objects = ~3-6K output tokens), so this
           call is plausibly the most expensive single call in the whole
           system. Without res.usage, we cannot prove it.
```

**The five-line fix — illustrative, not yet applied.**

```
  // ── PROPOSED FIX FOR R2 (the five-line fix) ──
  //
  // lib/agents/base.ts (after line 102):
  //   const res = await this.anthropic.messages.create(params);
  // + console.log('[perf]', {
  // +   agent,
  // +   kind: 'loop_turn',
  // +   turn,
  // +   input_tokens: res.usage.input_tokens,
  // +   output_tokens: res.usage.output_tokens,
  // +   cache_creation: res.usage.cache_creation_input_tokens ?? 0,
  // +   cache_read: res.usage.cache_read_input_tokens ?? 0,
  // + });
  //
  // lib/agents/diagnostic.ts (after line 97):
  //   const res = await this.anthropic.messages.create({...});
  // + console.log('[perf]', {
  // +   agent: 'diagnostic',
  // +   kind: 'synthesize',
  // +   ...res.usage,
  // + });
  //
  // lib/agents/recommendation.ts (after line 96):
  //   const res = await this.anthropic.messages.create({...});
  // + console.log('[perf]', {
  // +   agent: 'recommendation',
  // +   kind: 'synthesize',
  // +   ...res.usage,
  // + });
  //
  // lib/agents/intent.ts (after line 18):
  //   const res = await anthropic.messages.create({...});
  // + console.log('[perf]', {
  // +   agent: 'coordinator',
  // +   kind: 'classify',
  // +   ...res.usage,
  // + });
  //
  // total: 4 console.log additions (~5 lines total counting whitespace).
  // ships to Vercel function logs. R1, R3, R4, and every soft budget
  // become measurable immediately.
```

**The trigger condition — when synthesize fires (loop's final turn fails to parse).**

```
  lib/agents/diagnostic.ts  (lines 78–86, abbreviated)

  const { finalText, toolCalls } = await runAgentLoop({
    anthropic: this.anthropic,
    mcp: this.mcp,
    // ... other params ...
    maxTurns: 8,
    maxToolCalls: 6,
    synthesisInstruction: SYNTHESIS,
  });

  try {
    return parseDiagnosis(finalText);                          ← happy path: parse OK
  } catch {
    return this.synthesize(inv, /* history */);                ← FALLBACK: synthesize fires
  }
        │
        └─ the parse attempt is what gates synthesize. If the loop's final
           turn (already forced via forceFinal=true in base.ts:88-101)
           returns valid JSON, no synthesize. If parsing fails (which
           happens when the model hallucinates the schema or wraps the
           JSON in markdown), synthesize fires as a SEPARATE call. This
           is why synthesize is suspected to be costly — every fired
           synthesize is an ADDITIONAL call on top of the loop's already
           input-heavy run.
```

---

## Elaborate

**Where this pattern comes from.** "Cost concentration" as a concept comes from FinOps (cloud cost optimization) and is borrowed by LLMOps. The general observation: in any multi-call system, the cost distribution is heavy-tailed — a small fraction of call types account for the majority of the bill. The fix isn't to make every call cheaper; it's to find the dominant line item and decide whether to *measure* it (so changes can be evaluated), *cap* it (so it can't run away), or *replace* it (with a cheaper alternative). blooming insights' synthesize call is the suspected concentration; the right first move is *measure*, not *cap* or *replace*.

**Why "forced structured output" is the standard pattern (and why it's expensive).** Every LLM tool-use system eventually hits the "model decides to chat instead of emit JSON" failure mode. The standard fixes are (1) JSON-mode (a model setting that forces JSON output — supported by some models), (2) Pydantic/Zod-style schema validation with retries, or (3) the "drop the tools and force the final turn" pattern that blooming insights uses. All three add cost because they add a recovery turn. The synthesize pattern is the most flexible (works on any model), but it's also the most expensive because it's a full additional call.

**Why "suspected" matters more than "is."** Engineering decisions made on suspicion are different from decisions made on measurement. A "suspected" cost concentration justifies *adding the meter*. A "measured" cost concentration justifies *fixing it*. The wrong sequence is "ship a fix based on suspicion, then later add the meter." The right sequence is "add the meter, then decide if the fix is needed." Today, the audit's R2 (add `res.usage` logging) is the prerequisite for R1 (act on cost concentration). Reversing the order — say, ripping out the synthesize fallback because we *think* it's expensive — could ship a worse system if the actual cost wasn't where we suspected.

**Connection to adjacent concepts.** `01-300s-vercel-budget-as-hard-ceiling.md` is the time-budget sibling; this is the *cost*-budget sibling. Both suffer from the same missing-meter pattern. `02-ttl-cache-with-no-cache-on-error.md` is the cache that reduces *Bloomreach* cost (calls saved) but not Anthropic cost (synthesize would still fire). `study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` covers the *theory* of LLM cost optimization (output-token amplification, model tiering, prompt-prefix caching) that this file's measurement gap would unblock.

---

## Interview defense

### Q: What's the most expensive call type in blooming insights, and what makes it expensive?

**Answer:** The `synthesize()` fallback at `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132`. It's suspected to be the cost concentration because (a) it's tool-less and output-heavy — emits a full structured JSON payload (~3-6K output tokens), and (b) Anthropic charges roughly 5× more for output tokens than input tokens. So per-call, synthesize is ~2× the cost of a normal loop turn even though the input is similar. The wrinkle is *suspected* — there's no `res.usage` logging on any Anthropic call site in this codebase, so the actual cost is inferred from code shape, not measured. The cheapest fix in the codebase (five `console.log` lines, one per call site) would confirm or refute the suspicion immediately.

```
  per-call cost rank (estimated)

   synthesize:       ~$0.057   ← suspected dominant per-call
   loop turn:        ~$0.030   ← input-heavy, runs more often
   haiku classifier: ~$0.005   ← cheap, runs rarely

   per-investigation: ~$0.27 - $0.40 (depending on synthesize fire rate)
   ALL ESTIMATED. ALL CONFIRMABLE with 5 lines.
```

### Q: Why is "the cost is unmeasured" a more important finding than "the cost is high"?

**Answer:** Because cost being high is recoverable — you can act on a measured high cost (cap it, model-tier it, swap the prompt). Cost being unmeasured is *uncorrectable* until you measure it — you can't safely "optimize" a number you don't know. The worst combination is "high cost + unmeasured": you might be over-spending dramatically and not know, or you might be over-spending modestly and over-correct. The unmeasured state means every cost-related decision is shipped blind. A prompt change that doubles the input tokens lands silently; a model swap (sonnet → opus) lands silently; the synthesize fire rate going up over time lands silently. The five-line fix (`console.log` of `res.usage` at four call sites) costs almost nothing and turns every one of those silent regressions into observable ones.

### Q: A teammate proposes "just remove the synthesize fallback — if the loop's final turn doesn't parse, return an error." Defend or change.

**Answer:** Don't ship that — at least not before R2 lands. Here's why: today we don't know the synthesize fire rate. It might be 5% (in which case removing it would silently break 5% of investigations) or 50% (in which case it's a load-bearing recovery mechanism). The fix is *measure first*. Add `res.usage` logging AND a counter for synthesize invocations. Run for a week. See the actual fire rate. THEN decide: if fire rate is high, the right move isn't to remove synthesize — it's to *fix the loop* so the final turn parses correctly (tighter prompt, schema-aware few-shots, JSON-mode if the model supports it). If fire rate is low, synthesize is cheap recovery and can stay. The general principle: never remove a recovery mechanism without measuring how often it saves you. Five lines of measurement; the decision becomes data-driven.

---

---

## See also

- `audit.md` — the lens-level findings, including this pattern as R1 and R2 in the ranked risks
- `01-300s-vercel-budget-as-hard-ceiling.md` — the time-budget sibling, same missing-meter pattern
- `02-ttl-cache-with-no-cache-on-error.md` — the Bloomreach cache (reduces tool-call cost, not Anthropic cost)
- `03-spacing-gate-as-rate-limit-compliance.md` — the rate-limit floor (orthogonal to Anthropic cost)
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — the cost-theory layer the measurement would unblock
- `.aipe/study-ai-engineering/06-production-serving/01-llm-caching.md` — prompt-prefix caching (R4 in the audit, would need this meter to justify the ROI)
- `.aipe/study-prompt-engineering/` — the prompt-shape decisions that affect synthesize fire rate

---
Updated: 2026-06-16 — 3 of 5 Anthropic call sites now log `res.usage` (`base.ts:135`, `base.ts:257`, `intent.ts:36`); the 2 suspect synthesize() retries are the only remaining unmeasured sites. Phase 3 evals produced ~$10-15 aggregate cost data but no per-call decomposition. Gap is narrower; finish line is 2 more `console.log` lines.

---
Updated: 2026-06-19 — Phase 3 evals (the source of the ~$10-15 measured cost data) are GONE; per-call attribution remains uncomputed. The 2 unmeasured synthesize() sites are still the only remaining unmeasured Anthropic call sites. ~2 lines of console.log still closes the gap.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
