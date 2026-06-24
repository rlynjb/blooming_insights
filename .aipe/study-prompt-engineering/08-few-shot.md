# Few-shot prompting

**Industry name(s):** few-shot prompting, in-context examples, example-driven prompting, k-shot
**Type:** Industry standard · Language-agnostic

> blooming insights is example-driven for *format* — the EQL reminders, the worked query plan, and the JSON output blocks are syntax exemplars that shape what the model emits — but its actual classifier (`classifyIntent`) is *zero-shot*: query.md lists the three intent label definitions, not labeled input→output examples. Format-shaping few-shot: yes. Classifier few-shot: no.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Few-shot examples in this codebase live in two distinct sub-regions of the Per-agent definitions band. The format exemplars — `## EQL reminders`, the suggested query plan, the JSON output block — sit inside each agent's `.md` file, shaping what the model emits before any consumer ever sees it. The one true classifier decision (`classifyIntent`) sits one step outside, in `lib/agents/intent.ts`, with its system prompt declared inline in code — and it uses *no* examples at all. So the diagram marks two sub-regions of the same band: where examples are shown (format) and where they are deliberately absent (classification).

```
  Zoom out — where few-shot lives

  ┌─ Pipeline coordinator ──────────────────────────┐
  │  classify → monitoring/diagnostic/recommendation │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent definitions ─▼────────────────────────┐  ← we are here
  │                                                  │
  │  ★ FORMAT exemplars (shown, imitated) ★          │
  │   EQL reminders   monitoring.md L49–54           │
  │                   diagnostic.md L27–37           │
  │   query plan      monitoring.md L39–47           │
  │   JSON output     monitoring.md L73–85 (one-shot)│
  │                                                  │
  │  ★ CLASSIFIER decision (ZERO-shot) ★             │
  │   classifyIntent  intent.ts L17–31                │
  │   label DEFINITIONS, no query→label examples     │
  │                                                  │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop / Provider ──▼────────────────┐
  │  the model imitates demonstrated shapes here     │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: when blooming insights wants the model to emit a specific shape — an EQL query, a JSON object, an intent label — does it *show* the shape (few-shot) or *describe* it (zero-shot), and which choice did it make where? Format exemplars are everywhere the codebase wants shape-imitation; the JSON output block doubles as the request side of the structured-output contract (→ 02). The classifier is zero-shot by choice — three distinct categories, `max_tokens: 16`, definitions plausibly suffice. Below, you'll see why showing six correct EQL shapes plus one forbidden one constrains syntax (not judgment), and why the one place few-shot would measurably help is the buildable experiment, not a settled answer.

---

## Structure pass

**Layers.** Few-shot sits in four layers, and you have to name them or "where do we use few-shot?" becomes an unfalsifiable question. Layer A is the *prompt's exemplar block* — the worked EQL lines, the filled JSON output block, the suggested-query-plan sequence. Layer B is the *prompt's descriptive block* — field-rules prose, label definitions, "Reply with ONLY the one word." Layer C is the *model's emission* — the actual EQL it writes, the actual JSON it returns, the actual intent label. Layer D is the *consumer / next link* — the parser that reads the JSON, the loop that executes the EQL, the route handler that branches on the intent.

**Axis: control.** *How* is the model being told what to emit at each layer — by demonstration (an example to imitate) or by description (a rule to parse)? Control via demonstration vs control via description — that's the lens that distinguishes a few-shot exemplar from a zero-shot definition. The wrong axis here would be "guarantees" (Layer D enforces the guarantee for JSON paths regardless of whether the request came from an exemplar or a rule); the right axis is which form of control the prompt uses, because that decides what the model *actually does* on the path.

**Seams.** Two seams, and the load-bearing one is where the codebase's design choice lives. Seam 1 (A↔B) — within the prompt, control flips from *demonstrated shapes* (filled JSON, worked queries) to *described rules* (field rules, label defs). Both exist in the same `.md`, and the model attends to demonstration more reliably than description — which is why the output exemplar is the request side of the structured-output contract and the field-rules prose is the also-ran. The load-bearing seam is Seam 2 — between the *format-shaping use* and the *classification-decision use*. Control via demonstration is used pervasively for *format* (the model copies the JSON exemplar's shape, the EQL one-liners' syntax); control via description is used for *the actual classification* (`classifyIntent` gives three label definitions, zero query→label examples). The codebase made one of these choices for shape (demonstrate) and the other for the discrete decision (describe), and whether the second choice is *correct* is the project exercise — a measured question, not a settled one.

```
  Structure pass — few-shot prompting

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: exemplar block (filled JSON, worked EQL)   │
  │  B: descriptive block (field rules, defs)       │
  │  C: model emission (what comes out)             │
  │  D: consumer / next link (parser, executor)     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: demonstration (example to imitate)   │
  │  vs description (rule to parse)?                │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (A↔B): demonstrated shapes → described     │
  │            rules in the same prompt             │
  │  S2 (format use ↔ classification use):         │
  │            format → demonstrate (used)         │
  │            decision → describe (chosen here)   │
  │            (LOAD-BEARING — the codebase's      │
  │             measured-question split)            │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "how is the model told what to emit?" answered two ways

  ┌─ format-shaping ─┐    seam     ┌─ classification ─────┐
  │  DEMONSTRATE:    │ ═════╪═════► │  DESCRIBE:           │
  │  filled JSON,    │  (the split │  three label defs,   │
  │  worked EQL      │   chosen    │  no labeled pairs    │
  │                  │   here)     │                      │
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → format wants demonstration; the classification
                   decision was given description — defensible,
                   measurable, not yet measured
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Few-shot is showing the model k worked examples of the task *inside the prompt* so it infers the pattern from the demonstrations rather than from a description. There is a spectrum: zero-shot (describe the task, no examples), few-shot (show 1–5 examples), and the in-between blooming insights actually occupies most — *format exemplars*, where you show the shape of the output without showing labeled input→output pairs for the actual decision.

```
the spectrum, and where blooming insights sits
─────────────────────────────────────────────────────────────
 ZERO-SHOT          describe the task           "classify as one word"
   │                                            ← intent classifier lives here
 FORMAT EXEMPLAR    show the output SHAPE        a worked EQL line, a JSON block
   │                (not labeled in→out pairs)   ← the four prompts live here
 FEW-SHOT (k-shot)  show k labeled in→out pairs  "Q: ... → billing"  ×3–5
                    for the actual decision      ← NOT used anywhere here
```

The distinction matters: a format exemplar shapes *how the answer looks*; a true few-shot example shapes *what the answer is*. blooming insights uses the first heavily and the second nowhere.

---

### Format exemplars for EQL — showing the supported syntax

The prompts do not describe EQL grammar; they show it. The `## EQL reminders` blocks are worked one-liners:

```
diagnostic prompt — EQL reminders
─────────────────────────────────────────────────────────────
 Count one event:   select count event purchase in last 7 days
 Sum a property:    select sum event purchase.total_price ...
 Segment by dim:    select count event purchase by customer.country...
 Segment by device: ... by customer.device_type grouping top 5 ...
 Multiple metrics:  select count event view_item, count event ...
 NEGATIVE example:  Do NOT use a `customers matching ...` clause
 Funnels:           funnel view_item followed by purchase ... end
```

These are exemplars, not grammar. The model is shown six *correct* query shapes and one *forbidden* one (a negative example — the scar tissue of the model repeatedly inventing an unsupported clause). The model copies the demonstrated forms. This is few-shot applied to format: the examples constrain the *syntax* of the queries the model writes, without being labeled examples of "given anomaly X, write query Y."

```
six correct shapes shown  →  model emits queries matching them
one forbidden shape shown →  model avoids `customers matching`
```

---

### A worked end-to-end exemplar — the monitoring query plan

The monitoring prompt goes further: it shows a worked *sequence* of calls, not just isolated lines. The `## Suggested query plan` section is a five-step exemplar of an entire investigation:

```
monitoring prompt — Suggested query plan
─────────────────────────────────────────────────────────────
 1. select count event purchase, sum ...total_price in last 90 days
 2. select ... in last 180 days
 3. select count event view_item, cart_update, checkout, purchase...
 4. select ... in last 180 days
 5. select count event session_start in last 90 days
 "Derive: purchase count & revenue change, the conversion-rate ..."
```

This is the strongest exemplar in the codebase — a full worked example of *which queries to run in what order to produce a briefing*. It shapes the agent's whole exploration trajectory, not just one query's syntax. It is still format/process-shaping, not a labeled "input anomaly → output anomaly-array" pair, but it is the closest the prompts get to demonstrating the task end to end.

---

### The JSON output block IS a few-shot of the output form

The single clearest few-shot pattern is the output example block in each prompt. The model is handed a fully-populated instance of the exact shape it must return:

```
monitoring prompt — output exemplar
─────────────────────────────────────────────────────────────
 [
   {
     "metric": "purchase_revenue",
     "scope": ["global"],
     "change": { "value": 18.5, "direction": "down", "baseline": "90d" },
     "severity": "critical",
     "evidence": [ { "tool": "...", "result": { "current": 42000, ... } } ]
   }
 ]
```

This is a one-shot example of the output. The model sees a real, filled-in object — `18.5`, `"down"`, `"critical"` — and produces the same shape with its own values. This interacts directly with structured outputs (→ 02-structured-outputs.md): the example *is* the contract's request side. The agent-JSON parser + the anomaly-array guard enforce the shape, but the output exemplar is what makes the model *emit* the shape in the first place. The recommendation prompt even shapes a field through the example plus a prose rule: the exemplar shows no `id` and a sibling rule says "Do NOT include an `id` field — the system assigns it" — the example demonstrates the id-less shape the recommendation guard expects.

```
output exemplar (the request)  →  model emits matching shape
parser + type guard (the guarantee)  →  shape enforced
the example and the validator describe the SAME shape from two sides
```

---

### The classifier is zero-shot, not few-shot

Here is the honest split. The component whose *whole job* is classification — the intent classifier — uses **no examples at all**. Its system prompt is a description, inline in the code, of the three labels:

```
  system:
    "Classify the user query as exactly one word: monitoring (what changed / what is new), "
    "diagnostic (why did something happen), or recommendation (what should I do). "
    "Reply with ONLY the one word."
```

That is a zero-shot prompt: label *definitions*, no labeled query→label pairs. The query prompt's `## Framing` section mirrors the same three definitions for the answering agent — again definitions, not examples:

```
query prompt — Framing
─────────────────────────────────────────────────────────────
 monitoring     = what changed / what's new
 diagnostic     = why did something happen
 recommendation = what should I do
```

So the classifier defines its labels and trusts the model to map a query onto one. There is no `"refund status?" → monitoring` exemplar anywhere. This is a deliberate-by-omission choice: zero-shot is cheaper (the classifier's `max_tokens` is 16, → 04-token-budgeting.md) and the three categories are distinct enough that a capable model handles them from definitions. Whether it would be *more accurate* with three labeled examples is an open, measurable question — and the project exercise below is exactly that experiment.

```
classifier today:   [label definitions] + query  →  one word   (ZERO-shot)
classifier could:   [label defs] + [3 query→label examples] + query  (FEW-shot)
                    ← measurable: does accuracy improve enough to pay the tokens?
```

---

### The principle

Examples constrain output more reliably than instructions, but *what* they constrain depends on whether they are format exemplars or labeled decision examples. blooming insights uses format exemplars pervasively — EQL one-liners, a worked query plan, JSON output blocks — to pin the *shape* of what the model emits, and the output block doubles as the request side of the structured-output contract. But its one true classifier is zero-shot: it defines the labels and shows no examples. The split is honest and defensible — format wants demonstration, the classifier's three distinct categories survive on definitions — and the one place where adding few-shot might measurably help (the intent classifier) is the buildable experiment, not a settled answer.

---

## Few-shot prompting — diagram

This diagram spans the prompt's example use. The Format-exemplar layer shows shapes the model imitates; the Output-exemplar layer is the request side of the structured contract; the Classifier layer shows where examples are *absent* and definitions stand in. A reader who sees only this should grasp that the codebase demonstrates format heavily and the classification decision not at all.

```
┌──────────────────────────────────────────────────────────────────────┐
│  FORMAT EXEMPLARS (syntax/process shaping)                           │
│                                                                       │
│  EQL reminders        monitoring + diagnostic prompts                 │
│    6 correct query shapes + 1 forbidden (customers matching clause)   │
│  Suggested query plan monitoring prompt                               │
│    5-step worked investigation (shapes the whole trajectory)          │
│           │ model imitates the demonstrated shapes                    │
└───────────┼───────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  OUTPUT EXEMPLARS = few-shot of the OUTPUT FORM                      │
│                                                                       │
│  filled JSON block   monitoring · diagnostic · recommendation prompts │
│                      (recommendation: id-less + "Do NOT include id")  │
│    ── this is the REQUEST side of the structured-output contract ──   │
│       (parser + type guard = the GUARANTEE side, → 02)                │
└──────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────┐
│  CLASSIFIER = ZERO-SHOT (no examples)                                │
│                                                                       │
│  intent classifier   system = label DEFINITIONS                       │
│  query prompt Framing   same three definitions, no pairs              │
│    ← few-shot would add "query → label" examples here (the exercise)  │
└──────────────────────────────────────────────────────────────────────┘

  Format: shown and imitated.  Output form: shown (one-shot).
  The classification decision: described, never demonstrated.
```

The codebase demonstrates shapes pervasively and the actual classification decision not at all — an honest, measurable split.

---

## Implementation in codebase

**Case A — partial.** Format-shaping few-shot is present; classifier few-shot is absent.

### Format exemplars — EQL reminders

- **File:** `lib/agents/prompts/monitoring.md`, `lib/agents/prompts/diagnostic.md`
- **Function / class:** the `## EQL reminders` blocks (prompt text)
- **Line range:** `monitoring.md` L49–L54; `diagnostic.md` L27–L37 (negative example at L35)
- **Role:** worked query one-liners that demonstrate supported EQL syntax (and one forbidden clause), so the model copies the shapes instead of inventing grammar.

### The worked query plan (end-to-end process exemplar)

- **File:** `lib/agents/prompts/monitoring.md`
- **Function / class:** the `## Suggested query plan` section
- **Line range:** L39–L47
- **Role:** a five-step worked sequence that shapes the agent's whole exploration trajectory — the closest the prompts get to demonstrating the task end to end.

### Output exemplars (few-shot of the output form)

- **File:** the three JSON prompts
- **Function / class:** the `## Output` example blocks
- **Line range:** `monitoring.md` L73–L85; `diagnostic.md` L63–L85; `recommendation.md` L49–L74 (id-less; reinforced by L82 "Do NOT include an `id` field")
- **Role:** a filled instance of the exact return shape — the request side of the structured-output contract (`parseAgentJson` + type guards in `validate.ts` are the guarantee side).

### The classifier — zero-shot (the absence)

- **File:** `lib/agents/intent.ts` + `lib/agents/prompts/query.md`
- **Function / class:** `classifyIntent` (label definitions, no examples)
- **Line range:** `intent.ts` L17–L31 (system at L21–L23); query.md Framing L15–L21
- **Role:** classifies via label *definitions*, not labeled query→label pairs — the one true classification decision is demonstrated nowhere.

### Why this split is defensible

Format wants demonstration: showing a JSON block or an EQL line pins a shape that prose cannot. The classifier wants cheap, decisive output: three distinct categories, `max_tokens: 16`, a capable model — definitions suffice without paying for examples on every call. The codebase put examples exactly where shape-imitation is the goal and withheld them where definitions plausibly suffice. Whether the classifier would be *more accurate* with examples is left open and measurable.

---

## Elaborate

### Where this comes from

Few-shot prompting was the headline result of the GPT-3 paper (Brown et al., 2020, "Language Models are Few-Shot Learners") — the model performed tasks from a handful of in-context examples with no fine-tuning. The practical refinements came later: the OpenAI cookbook and Anthropic's prompt guide both teach that 3–5 *well-chosen* examples beat 20 mediocre ones, that example *diversity* matters more than count, and that examples should be formatted exactly as you want the output. The format-exemplar pattern blooming insights uses — show a filled JSON block, show worked query lines — is the version that survives in production code, because it constrains structure without the token cost of many full input→output pairs.

### The deeper principle

```
instruction                          example
──────────────────────────────      ──────────────────────────────
"return a JSON array of anomalies"   [{ "metric": "...", "change": {...} }]
parsed semantically                  imitated structurally
model fills gaps with guesses        model fills gaps by analogy
3–5 good > 20 mediocre               (diversity beats count)
```

An instruction is parsed; an example is imitated. The model's strongest behavior is pattern-completion, so a demonstrated shape recruits exactly that strength. This is why the JSON output block is more reliable than the field-rules prose beside it (`monitoring.md` L66–L71): the prose describes, the block demonstrates, and the model anchors on the block. The cost is tokens — every example sits in the prefix on every call (→ 04-token-budgeting.md) — so the discipline is "few, diverse, exactly-formatted," not "many."

### Where this breaks down

1. **Examples can over-constrain.** The monitoring output exemplar shows `"metric": "purchase_revenue"` and `"baseline": "90d"`. A model anchored on the example can echo those literal values even when the real metric is `conversion_rate` — imitating the example's *content*, not just its *shape*. Diverse examples mitigate this; a single exemplar risks it.

2. **Format exemplars do not teach the decision.** Showing six EQL shapes teaches *syntax*, not *which query answers this anomaly*. The model can write a perfectly-shaped query that tests the wrong hypothesis. Format few-shot improves form, not judgment.

3. **Zero-shot classification has no calibration anchor.** Because `classifyIntent` shows no examples, there is no in-context signal for the *boundary* cases — a query like "is my refund rate climbing?" sits between monitoring and diagnostic, and the model decides from definitions alone with nothing to imitate. The `parseIntent` fallback to `'diagnostic'` (`intent.ts` L11) catches misses but does not improve accuracy.

4. **Dual-adapter format exemplars carry double the cost.** Since Phase 2 the monitoring prompt has to work against TWO data backends — Bloomreach (EQL syntax) and Olist (SQL-backed domain tools: `get_metric_timeseries`, `get_segments`, `get_anomaly_context`). The prompt now carries an EQL example block AND a parallel "Olist (SQL-backed tools)" example block, both in the prefix on every call regardless of which adapter is live. This is the unavoidable token cost of one prompt serving two contracts. The mitigation in the codebase is structural rather than few-shot: the prompt opens with "The available tools you receive at runtime reveal which adapter is live — use whichever set you actually see," so the model uses the tool catalog to decide which exemplar applies. Few-shot demonstrating shapes for two grammars at once is a real prompt-engineering bound — there is no way to demonstrate the SQL tool shape *and* the EQL string shape without paying for both.

5. **Enumerated-step exemplars survive eval pressure better than prose plans.** The Phase 2.5 monitoring fix replaced a generic "scan globally then pick a dimension if interesting" prose plan with a *numbered 3-dimension scan plan* — call 1 against `state`, call 2 against `category`, call 3 against `payment_type`, each shown as a literal `get_metric_timeseries({...})` call with the exact argument shape. That is exemplars-as-checklist few-shot: the agent imitates the call shape AND walks the list. The detection eval scored that change with a 5x loose-recall lift (→ 05-eval-driven-iteration.md). The takeaway for few-shot: when the failure mode is *missed-coverage* (the agent skipped a dimension entirely), enumerated worked examples are a stronger fix than instruction-prose — the model imitates the count.

### What to explore next

- **Add 3–5 labeled examples to `classifyIntent`** and measure accuracy on a held-out set (the exercise below).
- **Diversify the output exemplar** — show two anomaly objects with different metrics/directions to reduce content-echo.
- **Dynamic few-shot** — retrieve the k most similar past queries as examples per call, instead of a fixed set (the production frontier for classifiers).

---

## Project exercises

### Add few-shot exemplars to the intent classifier and measure accuracy

- **Exercise ID:** B1.8 (adapted) — few-shot classification.
- **What to build:** assemble a held-out set of ~30 real-shaped queries labeled `monitoring` / `diagnostic` / `recommendation`, measure `classifyIntent`'s zero-shot accuracy on it, then add 3–5 diverse labeled `query → label` examples to the system prompt (`intent.ts` L21–L23) and re-measure. Keep `max_tokens: 16`.
- **Why it earns its place:** turns "should the classifier be few-shot?" from a hunch into a measured comparison, and exercises the few-shot-meets-evals seam (→ 05-eval-driven-iteration.md).
- **Files to touch:** `lib/agents/intent.ts` (add examples to the system string), new `test/agents/intent.eval.test.ts` (the labeled set + accuracy harness).
- **Done when:** the eval reports zero-shot and few-shot accuracy side by side, and the decision to keep or drop the examples is made on the number, not the vibe.
- **Estimated effort:** 1–4hr

### Diversify the monitoring output exemplar to reduce content-echo

- **Exercise ID:** B1.8 (adapted) — example diversity over count.
- **What to build:** replace the single `purchase_revenue` output exemplar (`monitoring.md` L73–L85) with two objects of different metrics, directions, and severities (e.g. a `conversion_rate` "up"/"positive" alongside the revenue "down"/"critical"), so the model imitates the *shape* without anchoring on one metric's literal values.
- **Why it earns its place:** demonstrates the "diverse beats numerous" rule and addresses the over-constraint failure where the model echoes the exemplar's content.
- **Files to touch:** `lib/agents/prompts/monitoring.md` (the output block), `test/agents/monitoring.test.ts` (assert the agent still parses both shapes).
- **Done when:** monitoring runs still parse via `isAnomalyArray`, and a manual check shows the model varying metric names rather than echoing `purchase_revenue`.
- **Estimated effort:** <1hr

---

## Interview defense

### What an interviewer is really asking

"Where do you use few-shot?" tests whether you can distinguish a format exemplar from a labeled decision example, and whether you know your own codebase well enough to say "format yes, classifier no." The senior signal is naming that the JSON output block is itself a one-shot, and that the classifier is zero-shot *by choice*, with a measurable condition for changing it.

### Likely questions

**[mid] "Show me a few-shot example in this codebase."**

The clearest one is the output block — `monitoring.md` L73–L85 hands the model a fully-filled anomaly object (`18.5`, `"down"`, `"critical"`) and the model returns the same shape with its own values. That is a one-shot of the output form. The EQL reminders (`diagnostic.md` L27–L37) are format exemplars too — worked query shapes the model copies.

```
filled JSON exemplar  →  model emits same shape, own values
worked EQL lines      →  model copies supported syntax
```

**[senior] "Your classifier handles intent. Is it few-shot? Should it be?"**

It is zero-shot — `classifyIntent` (`intent.ts` L17–L31) gives label *definitions* (L21–L23), no labeled query→label examples. That is defensible: three distinct categories, a capable model, `max_tokens: 16`, definitions are cheaper per call. Should it be few-shot? That is a *measured* question — if a held-out eval shows boundary cases (refund/return queries) landing on the wrong agent above tolerance, 3–5 diverse examples become worth the prefix tokens. I would not add them on a hunch.

```
now:    [definitions] + query → label              (zero-shot, cheap)
if eval shows boundary misses → add [3–5 query→label examples]  (few-shot)
```

**[arch] "Why not just write better instructions instead of examples?"**

Because the model imitates shapes more reliably than it parses rules. The field-rules prose (`monitoring.md` L66–L71) *describes* the output; the JSON block *demonstrates* it — and the model anchors on the block. An instruction is parsed and the model fills gaps with guesses; an example is imitated and the model fills gaps by analogy. The trade is tokens — every example rides the prefix on every call — so the rule is "few, diverse, exactly-formatted," not "many."

```
instruction → parsed → gaps filled by guess
example     → imitated → gaps filled by analogy   ← stronger structural constraint
```

### The question candidates always dodge

**"Does showing the model six correct EQL shapes make it write the *right* query?"** No — it makes it write a *well-formed* query. Format exemplars constrain syntax, not judgment; the model can emit a perfectly-shaped EQL line that tests the wrong hypothesis (`diagnostic.md` L27–L37 teaches form, not which dimension to segment by). Conflating "the output is shaped right" with "the decision is right" is the dodge — and it is why format few-shot needs evals on top.

### One-line anchors

- `monitoring.md` L73–L85 — the output exemplar: a one-shot of the return shape.
- `diagnostic.md` L27–L37 — EQL format exemplars, with a negative example at L35.
- `monitoring.md` L39–L47 — the five-step worked query plan (process exemplar).
- `intent.ts` L21–L23 — the classifier system prompt: definitions, zero-shot.
- `query.md` L15–L21 — Framing: the same three label definitions, no examples.

---

## See also

→ 01-anatomy.md · → 02-structured-outputs.md · → 09-chain-of-thought.md · → 04-token-budgeting.md

---
Updated: 2026-05-29 — Resynced monitoring.md exemplar refs after the `{categories}` shift: EQL reminders L43–48→L49–54, Suggested query plan L33–41→L39–47 (with inner step annotations L35–41→L41–47), output exemplar L54–64→L73–85 (verified against the live JSON block, which sits lower than the +6 estimate due to the expanded field-rules).
Updated: 2026-05-29 — Resynced sibling-prompt refs (pre-existing drift): diagnostic.md EQL reminders L26–34→L27–37 and negative-example L33→L35, diagnostic.md output exemplar L48–66→L63–85, recommendation.md output exemplar L49–59→L49–74 and id-ban L64→L82.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-16 — Added items 4 (dual-adapter format exemplars: prompt now carries parallel Bloomreach-EQL + Olist-SQL exemplar blocks since Phase 2) and 5 (enumerated 3-dim scan plan as exemplars-as-checklist few-shot — measured 5x loose-recall lift on the Phase 3 eval suite).
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
