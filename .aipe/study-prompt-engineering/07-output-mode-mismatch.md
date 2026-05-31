# Output mode mismatch (declare the mode, enforce it at the boundary)

**Industry name(s):** output mode mismatch, format contract drift, JSON-vs-prose mismatch, output-mode declaration
**Type:** Industry standard · Language-agnostic

> blooming insights runs three JSON agents and one prose agent — the query agent deliberately opts out of JSON ("No JSON shape is required", `query.md` L49) while the other three demand it. Each prompt declares its mode, the validators enforce it at the boundary, and the bug to watch for is a prompt whose declared mode doesn't match the consumer that handles its output: the `parseAgentJson`/`synthesize()` path assumes JSON, and query is the one path that must not touch it.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Output mode mismatch lives at the boundary between Per-agent definitions (where the `## Output` section declares JSON or prose) and the consumer code that reads `finalText` — `parseAgentJson` + a type guard for the JSON agents, or a bare `.trim()` for the prose agent. The concept is exactly that boundary: producer declares, consumer assumes, and a mismatch is the two sides disagreeing about which mode is in play. The mismatch never crashes — it silently degrades, which is why you catch it by reading the two ends together, not by waiting for an exception.

```
  Zoom out — where output mode mismatch lives

  ┌─ Per-agent definitions ─────────────────────────┐  ← we are here (producer)
  │  monitoring.md L71  "ONLY JSON, fenced"  ─┐      │
  │  diagnostic.md L61  "ONLY JSON, fenced"   ├─JSON │
  │  recommendation.md L49 "ONLY JSON, fenced"─┘     │
  │  query.md L49 "No JSON — just answer text" ─PROSE│
  │  (mode also declared in synthesisInstruction)    │
  └─────────────────────────┬────────────────────────┘
                            │  finalText (untrusted string)
  ┌─ Consumer band ─────────▼────────────────────────┐  ← we are here (consumer)
  │  ★ JSON path: parseAgentJson + isDiagnosis ★     │
  │     mon.ts L85–92 · diag.ts L73–77 · rec L69–76 │
  │  ★ PROSE path: finalText.trim() ★                │
  │     query.ts L47  (NO parseAgentJson)            │
  │  separate consumer code → modes can't share enforcement│
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ UI / next agent ───────▼────────────────────────┐
  │  silent mismatch shows up here (degraded output) │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: how is each agent's output mode declared, where is it enforced, and how would you catch a mismatch before it ships? Three agents share the JSON path (declare-fenced-JSON → parseAgentJson → guard → reject-on-mismatch) and one agent is deliberately on the prose path (declare-prose → trim → default), with *separate* consumer code so the modes can't accidentally share enforcement. The mode is also declared a second time in each agent's `synthesisInstruction`, so a refactor must keep three sites in sync. Below, you'll see how each mismatch direction degrades silently, and the three-site checklist that catches one in review.

---

## How it works

**Mental model.** Each agent is a producer with a declared output mode; each agent's caller is a consumer with an assumed mode. The two must agree. The declaration is a line (or block) in the prompt's `## Output` section; the enforcement is the code that reads `finalText`. Picture a switch in each agent's `## Output`: flip it to JSON and the output flows into `parseAgentJson` + guard; flip it to prose and the output flows straight into `.trim()`. A mismatch is the switch declared one way and the consumer wired the other.

```
PRODUCER (prompt ## Output)          CONSUMER (the code that reads final_text)
─────────────────────────────        ──────────────────────────────────────
monitoring "JSON array, fenced"   →  parse_agent_json + is_anomaly_array
diagnostic "JSON object, fenced"  →  parse_agent_json + is_diagnosis
recommend  "JSON array, fenced"   →  parse_agent_json + is_recommendation_array
query      "No JSON required,      →  final_text.trim()
            just the answer text"      (NEVER parse_agent_json)
```

Three switches point at the JSON path; one points at the prose path. The mismatch bug is any switch whose declaration and consumer disagree.

---

### Three agents declare JSON

The structured agents each declare JSON mode unambiguously in `## Output`, with "ONLY" and a fenced example:

```
monitoring prompt      "Return ONLY a JSON array of anomaly objects … wrapped in a ```json fenced block"
diagnostic prompt      "Return ONLY a JSON object (in a ```json fenced block) of exactly this shape"
recommendation prompt  "Return ONLY a JSON array (in a ```json fenced block) of at most 3 objects"
```

"ONLY" is doing real work — it tells the model the *entire* response is the artifact, no prose around it. The fence is the extraction anchor (→ 02-structured-outputs.md). These three feed the parse-validate-repair funnel: their final text goes into the agent-JSON parser and a type guard, and a synthesize retry exists for the diagnostic and recommendation agents when the JSON doesn't materialize.

---

### One agent declares prose — deliberately

The query agent's `## Output` says the opposite, and the opposite-ness is the whole point:

```
query prompt — ## Output
  Give a clear, concise answer in plain prose — a few sentences; you may use
  short markdown bullets. Cite the key numbers you found. If you couldn't get
  the data, say so plainly. No JSON shape is required — just the answer text.
```

"No JSON shape is required — just the answer text" is the mode declaration. The query agent answers a free-form human question; forcing that through a JSON schema would be the wrong contract — the consumer (the UI) wants prose to show the user, not a typed object. So its consumer reads the output as a string and trims it:

```
  return final_text.trim() || "I was unable to find enough data to answer that question."
```

No JSON parser. No type guard. No synthesize retry returning a typed shape — the query agent's synthesis instruction says "answer the user question directly and concisely in plain prose," not "emit JSON." The prose path is a deliberately *separate* consumer from the JSON path — the modes don't share enforcement code, which is exactly what keeps the mismatch from happening.

---

### Enforcement lives at the boundary, not the prompt

The declaration is necessary but not sufficient — the model honors "Return ONLY JSON" statistically (→ 02-structured-outputs.md). The *enforcement* is the validator at the consuming boundary:

```
JSON mode enforcement (monitoring consumer):
  parsed = parse_agent_json(final_text)         ← extract
  if NOT is_anomaly_array(parsed): return []   ← REJECT wrong-mode output, floor to []

prose mode "enforcement" (query consumer):
  final_text.trim() || "<fallback sentence>"   ← accept any text; floor to a sentence
```

The JSON consumers *reject* output that isn't valid JSON of the right shape — that rejection is the enforcement. The prose consumer accepts any text (prose can't be "wrong shape"), flooring only to a default sentence when the text is empty. So the two modes have two different enforcement disciplines: JSON mode validates and rejects; prose mode accepts and defaults. The mismatch danger is asymmetric — feed prose to the JSON consumer and it rejects everything to `[]`; feed JSON to the prose consumer and it cheerfully returns the raw JSON string to the user as if it were an answer.

```
prose → JSON consumer:  parser throws / guard false → [] (silent empty)
JSON → prose consumer:  .trim() returns "[{...}]" → user sees raw JSON (silent ugly)
```

Both failures are *silent* — neither throws an error a monitor would catch. That's what makes mode mismatch insidious: it degrades the output, it doesn't crash.

---

### How to catch a mismatch in review

The mismatch is invisible in the prompt alone — you have to read the prompt's declared mode *and* its consumer together. The review checklist:

```
for each agent:
  1. read ## Output — what mode does the prompt DECLARE?   (JSON-fenced? prose?)
  2. read the code that reads final_text — what does it ASSUME?
       parse_agent_json + guard  → it assumes JSON
       .trim()                    → it assumes prose
  3. do (1) and (2) agree?
       monitoring: JSON ↔ parse_agent_json ✓
       diagnostic: JSON ↔ parse_agent_json ✓
       recommend:  JSON ↔ parse_agent_json ✓
       query:      prose ↔ .trim()         ✓   ← MUST NOT use parse_agent_json
  4. check the synthesis_instruction too — does the forced-final nudge declare
       the SAME mode as ## Output?  (query says prose; the others say JSON)
```

Step 4 is the subtle one: the mode is declared *twice* — in `## Output` and in the synthesis instruction (→ 01-anatomy.md) — and they must agree. If a refactor changed query's `## Output` to demand JSON but left the synthesis nudge saying "plain prose," the model would get conflicting mode instructions on the final turn. The reviewer's job is to check that an agent's declared mode is consistent across both places *and* matches its consumer.

---

### The principle

Output mode is a contract with two ends — the prompt declares it, the consumer enforces it — and the contract is only sound when both ends agree, in both the `## Output` section and the synthesis nudge. blooming insights keeps three agents on the JSON path (declare-fenced-JSON → parse → guard → reject-on-mismatch) and one agent on the prose path (declare-prose → trim → default), with *separate* consumer code so the modes can't accidentally share enforcement. A mismatch never crashes; it silently degrades — which is why you catch it by reading the declaration and the consumer side by side, not by waiting for an exception.

---

## Output mode mismatch — diagram

This diagram spans producers (four prompts, two modes) and consumers (two enforcement paths). A reader who sees only this should grasp that mode is declared per prompt, enforced at the boundary, that three agents share the JSON path and query is deliberately on the prose path, and that a mismatch degrades silently.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRODUCERS — each prompt's ## Output declares a MODE                  │
│                                                                       │
│   monitoring prompt      "ONLY a JSON array … ```json fenced"   ─┐    │
│   diagnostic prompt      "ONLY a JSON object … ```json fenced"   ├─JSON│
│   recommendation prompt  "ONLY a JSON array … ```json fenced"  ─┘     │
│                                                                       │
│   query prompt  "No JSON shape is required — just the answer text" ─ PROSE │
└───────────────┬───────────────────────────────────────────┬───────────┘
       JSON mode │                                  prose mode │
┌────────────────▼──────────────────────────┐  ┌──────────────▼───────────┐
│  JSON CONSUMER (validate + REJECT)         │  │  PROSE CONSUMER (accept) │
│   parse_agent_json                          │  │   final_text.trim()      │
│   + shape guards (anomaly/diagnosis/rec)    │  │                          │
│   wrong shape → [] / FALLBACK               │  │   empty → default sentence│
│   monitoring · diagnostic · recommendation  │  │   NO parser path          │
└────────────────────────────────────────────┘  └──────────────────────────┘

  MISMATCH (silent, never throws):
    prose → JSON consumer  = guard false → [] (empty output)
    JSON  → prose consumer = .trim() → user sees raw "[{...}]"
  catch it: read ## Output mode AND the consumer AND the synthesis nudge together.
```

Mode is declared per prompt and enforced per consumer; three agents share the JSON path, query is deliberately on the prose path, and any disagreement degrades silently.

---

## Implementation in codebase

**Case A — implemented.**

### JSON-mode declarations and consumers

- **File:** `lib/agents/prompts/{monitoring,diagnostic,recommendation}.md` + their `.ts`
- **Function / class:** `## Output` (declaration) → `parseAgentJson` + type guard (enforcement)
- **Line range:** declarations at `monitoring.md` L71, `diagnostic.md` L61, `recommendation.md` L49; consumers at `monitoring.ts` L85–92 (`parseAgentJson` + `isAnomalyArray` else `[]`), `diagnostic.ts` L73–77 (`tryParseDiagnosis ?? synthesize ?? FALLBACK`), `recommendation.ts` L69–76 (`tryParseRecommendations ?? synthesize` then `[]`).
- **Role:** declare fenced JSON; enforce by extracting, validating, and rejecting non-conforming output to a safe floor.

### Prose-mode declaration and consumer

- **File:** `lib/agents/prompts/query.md` + `lib/agents/query.ts`
- **Function / class:** `## Output` (declaration) → `finalText.trim()` (consumption)
- **Line range:** declaration at `query.md` L49 ("No JSON shape is required — just the answer text"); consumer at `query.ts` L47 (`finalText.trim() || '<fallback>'`); prose synthesis nudge at `query.ts` L42–44.
- **Role:** declares prose, consumes as a trimmed string, never touches `parseAgentJson` — the deliberately separate path.

### The mode declared twice (must agree)

- **File:** the prompt `## Output` section *and* the `synthesisInstruction`
- **Function / class:** per-agent `synthesisInstruction` passed to `runAgentLoop`
- **Line range:** JSON nudges at `monitoring.ts` L75–78, `diagnostic.ts` L62–66, `recommendation.ts` L58–62 (all say "JSON … fence"); prose nudge at `query.ts` L42–44 ("plain prose").
- **Role:** the forced-final-turn instruction must declare the same mode as `## Output`; a mismatch here gives conflicting final-turn instructions.

### Why this is a codebase strength

The two modes have *separate* consumer code — the JSON path and the prose path never share a function — so an agent can't accidentally be enforced under the wrong mode by a shared helper. And the mode is stated consistently in both `## Output` and the synthesis nudge for all four agents, so the final-turn instruction never contradicts the section above it.

---

## Elaborate

### Where this comes from

The output-mode contract is the LLM version of `Content-Type` negotiation — the producer declares the format, the consumer must handle that format, and a mismatch is a class of bug as old as HTTP. In LLM tooling, the distinction became sharp once apps started mixing structured-extraction calls (JSON) with conversational calls (prose) in the same system: LangChain's split between `OutputParser`-backed chains and plain text chains is the same two-mode split. The discipline of declaring the mode in the prompt *and* enforcing it at the boundary is the consensus answer to "the model sometimes returns the wrong format" — declare to bias the model, enforce to guarantee.

### The deeper principle

```
mode declared (prompt)        mode enforced (consumer)        agree?
──────────────────────        ────────────────────────        ──────
"ONLY JSON, fenced"           parseAgentJson + guard          ✓ JSON path
"no JSON, just prose"         .trim()                         ✓ prose path
"ONLY JSON" + .trim()         (declared JSON, consumed prose) ✗ user sees raw JSON
"just prose" + parseAgentJson (declared prose, consumed JSON) ✗ guard false → []
```

A mode contract is two-ended. Declaring it only biases the producer; enforcing it only at the consumer can reject everything if the producer was told the wrong mode. Both ends must name the same mode — and in this codebase the producer names it twice (`## Output` and the synthesis nudge), so "both ends agree" is really "all three sites agree."

### Where this breaks down

1. **Both mismatch directions are silent.** Neither feeding prose to the JSON consumer (`[]`) nor JSON to the prose consumer (raw JSON to the user) throws — so a mode mismatch passes tests that only check "didn't crash" and surfaces as degraded output a human has to notice.
2. **The mode is declared in two places.** `## Output` and the `synthesisInstruction` both state the mode; a refactor can change one and miss the other, leaving the model with conflicting instructions on the final turn.
3. **Prose mode has no shape to validate.** The query consumer accepts any non-empty string (`query.ts` L47), so a wrong-but-prose answer (e.g. the model apologizing instead of answering) passes the boundary — prose mode trades shape-checkability for flexibility.

### What to explore next

- **A mode-consistency test:** assert each agent's `## Output` mode matches its `synthesisInstruction` mode and its consumer (parseAgentJson vs trim), so a refactor that flips one site fails CI.
- **A prose-quality guard:** add a light check that the query answer actually contains the cited numbers it claims, catching the "apologized instead of answering" prose-mode failure the string-accept can't.
- **Typed mode tagging:** give each agent an explicit `outputMode: 'json' | 'prose'` field in code so the consumer is selected by the tag, not by which function the author happened to call.

---

## Project exercises

### Add a mode-consistency test across all four agents

- **Exercise ID:** C1.12 (adapted) — output-mode contract integrity.
- **What to build:** a Vitest test that, for each agent, asserts the declared mode is consistent across three sites — the prompt's `## Output` (JSON-fence vs prose), the `synthesisInstruction`, and the consumer (`parseAgentJson` present vs `.trim()` only) — so a refactor that flips one site without the others fails CI.
- **Why it earns its place:** turns the "read declaration and consumer together" review step into an enforced invariant, catching the silent mismatch class before it ships.
- **Files to touch:** new `test/agents/output-mode.test.ts`; reads the four `lib/agents/prompts/*.md` and inspects the four agent `.ts` modules.
- **Done when:** the test passes for the current four agents and fails if you change `query.md` L49 to demand JSON without also wiring `query.ts` to `parseAgentJson`.
- **Estimated effort:** 1–4hr

### Add a grounding check to the prose consumer

- **Exercise ID:** C1.12 (adapted) — prose-mode quality enforcement.
- **What to build:** since prose mode accepts any non-empty string (`query.ts` L47), add a light post-check that the answer actually cites at least one number when the query asked for figures (or explicitly says data was unavailable), surfacing the "apologized instead of answering" failure that the bare `.trim()` lets through.
- **Why it earns its place:** gives the prose mode the boundary enforcement the JSON mode has — accept-and-default becomes accept-check-and-default.
- **Files to touch:** `lib/agents/query.ts` (L47 — add the check), `test/agents/query.test.ts`.
- **Done when:** an empty-or-evasive prose answer triggers the explicit "unable to find data" path rather than returning a vacuous string, and a real numeric answer passes unchanged.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"You have agents returning different formats — how do you keep that straight?" tests whether you treat output format as a per-prompt contract with two ends. The senior signal is naming where the mode is declared, where it's enforced, that a mismatch degrades silently rather than crashing, and how you'd catch it in review.

### Likely questions

**[mid] "Which of your agents return JSON and which return prose, and how do you know?"**

Three return JSON — monitoring, diagnostic, recommendation — each `## Output` says "Return ONLY a JSON … fenced block" (`monitoring.md` L71, `diagnostic.md` L61, `recommendation.md` L49), and their consumers run `parseAgentJson` + a type guard. The query agent returns prose: `query.md` L49 says "No JSON shape is required — just the answer text," and its consumer is `finalText.trim()` (`query.ts` L47), no parsing.

```
JSON: ## Output "ONLY JSON fenced" → parseAgentJson + guard
prose: ## Output "no JSON, prose"  → .trim()
```

**[senior] "How would a mode mismatch show up, and would your tests catch it?"**

It degrades silently — it doesn't crash. If the query prompt were changed to demand JSON but still consumed by `.trim()`, the user would see raw `[{...}]` as their answer. The reverse — a JSON agent's output sent through `.trim()` — would dump JSON at the user too; prose sent through `parseAgentJson` floors to `[]`. Tests that only assert "didn't throw" miss all of this. I'd catch it by reading the `## Output` mode, the synthesis nudge, and the consumer together — and pin it with a mode-consistency test across those three sites.

```
prose → JSON consumer = [] (silent empty)
JSON  → prose consumer = raw JSON to user (silent ugly)
neither throws → "didn't crash" tests pass
```

**[arch] "Why is the query agent prose instead of JSON when the other three are JSON?"**

Because its consumer is a human reader, not a validator. The query agent answers a free-form question; the UI shows that answer directly. Forcing it through a JSON schema means emitting `{ "answer": "..." }` that the UI immediately unwraps back into prose — ceremony with no benefit, and a schema constraining an inherently unstructured output. The three structured agents produce *artifacts* (typed `Anomaly[]`, `Diagnosis`, `Recommendation[]`) for machine handoff (→ 06-single-purpose-chains.md), so JSON is the right mode for them and prose is right for query.

```
artifact for machine handoff → JSON (parseAgentJson + guard)
answer for a human reader     → prose (.trim())
```

### The question candidates always dodge

**"What happens if the model returns the wrong format anyway?"** It depends which way, and both are silent. A JSON agent that returns prose gets rejected by the guard to `[]` or `FALLBACK` — safe but empty. A prose agent that returns JSON gets `.trim()`'d and handed to the user as-is — the user reads raw JSON. Candidates dodge because the honest answer is "nothing throws, the output just gets worse," which undercuts the comfort of "we validate." The real safety net for JSON is the reject-to-floor; the prose side has no shape to reject against, which is its weak point.

### One-line anchors

- `lib/agents/prompts/query.md` L49 — "No JSON shape is required — just the answer text" — the prose mode declaration.
- `lib/agents/query.ts` L47 — `finalText.trim() || '<fallback>'` — the prose consumer, no `parseAgentJson`.
- `lib/agents/prompts/monitoring.md` L71 — "Return ONLY a JSON array … fenced" — a JSON mode declaration.
- `lib/agents/monitoring.ts` L85–92 — `parseAgentJson` + `isAnomalyArray` else `[]` — JSON boundary enforcement.
- mode stated twice: `## Output` + the `synthesisInstruction` (`query.ts` L42–44 prose vs `diagnostic.ts` L62–66 JSON) — both must agree.

---

## Validate

### Level 1 — Reconstruct

From memory, list the four agents and each one's output mode, draw the two consumer paths (JSON: parseAgentJson+guard; prose: trim), and state what each mismatch direction does (prose→JSON consumer; JSON→prose consumer).

### Level 2 — Explain

Out loud: why does the query agent deliberately *not* use `parseAgentJson` (`query.ts` L47), and why would forcing it onto the JSON path be the wrong contract for its consumer?

### Level 3 — Apply

Scenario: a teammate's PR changes `query.md` L49 to "Return ONLY a JSON object with an `answer` field" but leaves `query.ts` L47 as `finalText.trim()`. Walk through what the user sees, why no test that checks "didn't throw" catches it, and which two other sites (`## Output`, the synthesis nudge at `query.ts` L42–44, the consumer) you'd read together to flag it in review.

### Level 4 — Defend

A reviewer says: "Make all four agents return JSON so there's one consumer and no mismatch class." State what that removes (the prose path and its mismatch surface) and what it costs (wrapping a human answer in `{ "answer": "..." }` the UI just unwraps; a schema constraining inherently unstructured output), and the condition under which uniform JSON would be right (every agent's output becomes machine-consumed — which query's human-facing answer prevents here).

### Quick check — code reference test

Which agent consumes its `finalText` without calling `parseAgentJson`, and what is the exact consuming expression? (Answer: the query agent — `finalText.trim() || 'I was unable to find enough data to answer that question.'` at `lib/agents/query.ts` L47; it declares prose mode at `query.md` L49 and never touches the JSON parse path.)

## See also

→ 02-structured-outputs.md · → 06-single-purpose-chains.md · → 01-anatomy.md

---
Updated: 2026-05-29 — Corrected the monitoring.md JSON-output fence reference L52→L71 (the `## Output` "Return ONLY a JSON array" line moved down after the `{categories}` section) across all 7 citations.
Updated: 2026-05-29 — Resynced sibling-prompt refs (pre-existing drift from an earlier prompt-file revision): diagnostic.md output fence L46→L61, recommendation.md output fence L46→L49, query.md prose-output L36→L49, across all prose + diagram citations.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
