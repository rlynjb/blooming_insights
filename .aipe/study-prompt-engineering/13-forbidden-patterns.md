# 13 — Forbidden patterns and rotating formulas

*Output-style anti-drift · Industry standard*

## Zoom out, then zoom in

LLMs converge on phrasings. Run the same generative prompt 50 times and you'll see the same 5–10 sentence openings drift to the top. Pull up where this matters in this codebase.

```
  Where output convergence shows up — the recommendation rationale

  ┌─ /api/agent — recommendation chain ──────────────────────────┐
  │  prompt: legacy-prompts/recommendation.md                      │
  │  output: Recommendation[] with rationale field                 │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
  ┌─ over 50 recommendations across investigations ▼ ──────────────┐
  │  rationale openings start to converge:                          │
  │   "By targeting customers who have abandoned..."                │
  │   "By targeting customers who haven't..."                        │
  │   "By targeting customers in the affected segment..."           │
  │   ★ DRIFT: every output starts the same way ★                   │ ← we are here
  │  the recommendation cards begin to feel templated                │
  └────────────────────────────────────────────────────────────────┘
```

This is the failure mode in any generative LLM chain run repeatedly for the same user. The model picks up on what's worked in past outputs (from training) and converges on it. The output stops feeling individuated; the user notices it as "AI-generated." The fix is in the prompt itself — enumerate the forbidden openings, list the rotating formulas. Concept 11's spec discipline applied to the running prompts.

## Structure pass

**Layers.** Outer: the generative chain (any chain that emits prose). Middle: the specific phrasings the model converges on. Innermost: the prompt rule that prevents convergence.

**Axis — where does the convergence live.** Walk it:

```
  one axis — "where does this convergence live?" — three layers

  ┌─ training data ──────────────────┐
  │  model has seen 10K "recovery     │  ROOT CAUSE: you can't fix this
  │  email" rationales — they all     │  at the model layer
  │  start "By targeting..."           │
  └───────────────────────────────────┘
       ┌─ prompt's example ───────────┐
       │  if your one few-shot example │  CONTRIBUTES: example starts
       │  starts "By targeting..."     │  with the convergent phrasing
       │  the model copies              │
       └───────────────────────────────┘
            ┌─ prompt's anti-rule ─────┐
            │  "Don't start with 'By    │  THE FIX: enumerate forbidden
            │   targeting...' Rotate    │  openings, give the model
            │   among: 'Recover...',    │  permitted alternatives
            │   'Win back...', ..."      │
            └───────────────────────────┘
```

**Seams.** The biggest seam is between the *generative* and *structured-classifier* chains. Generative chains drift; classifiers don't (the output range is too small for convergence to be visible). The defense is only needed where the model is writing prose.

## How it works

### Move 1 — the mental model

You know how every Hollywood action trailer cuts the same way — "in a world..." → quick cuts → orchestral hit → text on screen — and you can tell within five seconds it's a trailer even with the sound off? LLM-generated prose has the same convergence problem. Every output starts to *sound* the same. The defense is what every good editor does: ban the cliché openings, name the rotation.

```
  Pattern — forbidden patterns, the kernel

  ┌─ generative chain ──┐
  │  recommendation     │
  │  rationale: prose    │
  └──────────┬──────────┘
             │ run 50 times
             ▼
       ┌──────────────────────────────┐
       │ outputs start with:           │
       │   "By targeting..."  (12x)    │
       │   "Send a..."  (8x)           │
       │   "To recover..."  (7x)       │
       │   "Trigger an..."  (5x)       │
       │   "Set up a..."  (4x)         │
       │   ... convergence!            │
       └────────────┬─────────────────┘
                    │
                    ▼  add to prompt:
       ┌──────────────────────────────┐
       │  ## Forbidden openings        │
       │  Do NOT begin the rationale   │
       │  with any of:                  │
       │   - "By targeting..."         │
       │   - "Send a..."                │
       │   - "To recover..."            │
       │  Instead, rotate among these   │
       │  patterns:                     │
       │   - lead with the EVIDENCE     │
       │     ("Mobile cart revenue       │
       │      fell 23%; ...")            │
       │   - lead with the IMPACT       │
       │     ("~340 buyers were         │
       │      affected; ...")            │
       │   - lead with the ACTION        │
       │     ("Recovery email to the     │
       │      gap-window segment...")    │
       └──────────────────────────────┘
```

The mechanism: forbidding the convergent openings AND listing rotating alternatives gives the model both a *don't* and a *do*. The *do* is what makes the rule work — banning without providing alternatives leaves the model to pick a *different* convergent opening from a smaller set.

### Move 2 — the walkthrough

**Step 1 — when this concept matters.** Two situations:

  → **Any generative chain run repeatedly for the same user.** The recommendation agent in this codebase fits — a single user sees N recommendations across multiple investigations. Convergence makes the cards feel templated.
  → **Any output that's *meant* to feel individuated.** Marketing copy, email drafts, product descriptions, code comments. If two outputs from the same chain look like reskins of each other, the user notices and trust drops.

**Step 2 — when this concept doesn't matter.** Two situations:

  → **One-shot classifiers.** The intent classifier returns one word. Convergence is *the goal* (always "monitoring" for "what's changed?" queries). No rotation needed.
  → **Structured outputs.** The monitoring agent returns `Anomaly[]` with `category`, `severity`, etc. The fields are typed; there's no prose to converge on. The closest thing is the `impact` field, which IS prose — and where this concept applies even inside a structured output.

**Step 3 — what this codebase does today (mostly nothing).** Look at the recommendation prompt at `legacy-prompts/recommendation.md`. There's a worked example showing one recommendation with a `title: "Send recovery email..."` and a `rationale`. There are no forbidden-pattern rules. After 50 recommendations, the rationale field probably has the convergence problem named above.

The same applies (weaker) to:

  → **Monitoring's `impact` field.** Every anomaly's `impact` is prose. After 50 anomalies, openings drift. Look at the worked example at `legacy-prompts/monitoring.md:81`: *"Revenue down 30% versus the prior 90 days on a baseline of ~12k purchases — a sustained drop at this magnitude..."*. The next 50 impact sentences will look a lot like this one.
  → **Diagnostic's `conclusion` field.** Prose explanation of why the anomaly happened. Same drift risk.

These are real opportunities for the concept. None are exercised today. Honest framing: this codebase doesn't have the *measurement* to know how bad the drift is, because there's no eval set (concept 05) tracking output diversity over runs. Adding the rotation rules is cheap; measuring whether they help requires the substrate.

**Step 4 — what the rule looks like in practice.** A concrete addition I'd make to `recommendation.md`:

```
  Pattern — the rotation rule, added to recommendation.md

  ## Style rules for rationale and steps

  The `rationale` field MUST NOT start with any of these convergent
  openings:
    - "By targeting customers..."
    - "Send a..."
    - "To recover..."
    - "Trigger an automated..."

  Instead, vary the opening across these patterns (pick the one that
  fits the diagnosis):

    EVIDENCE-FIRST: lead with the specific number from the diagnosis.
      Example: "Mobile cart abandonment jumped 23% in the last 30 days;
      a recovery email targeting that segment ..."

    IMPACT-FIRST: lead with the affected customer count or dollar value.
      Example: "~340 gap-window buyers represent ~$380K in foregone
      revenue at the current AOV; a recovery campaign ..."

    ACTION-FIRST: lead with the Bloomreach feature being proposed.
      Example: "A 'cart abandonment' scenario triggered after 24 hours
      of inactivity recovers ..."

  Aim for roughly equal distribution across the three patterns over
  any 10 consecutive recommendations.
```

The shape: *forbidden list* + *alternative list* + *distribution hint*. All three are needed. Just forbidding doesn't work (model picks another convergent opening); just listing alternatives doesn't help if the convergent ones are still allowed; without the distribution hint the model picks one alternative and over-uses it.

**Step 5 — the structured-output workaround.** This concept has an *architectural* alternative for some cases: move the prose to a typed field with constrained sub-fields. Instead of `rationale: string` (free prose), use:

```
  Pattern — structured rationale, anti-convergence by design

  rationale: {
    leadType: "evidence" | "impact" | "action"   // rotates explicitly
    leadNumber: number                            // forces the model to pick
                                                   // a specific number to cite
    bodyText: string                              // shorter, less room to drift
  }
```

The model now has to *choose* the lead type per recommendation, and the lead type is visible in the schema. You can audit the distribution after the fact. The body text still has drift risk but it's a shorter window.

This codebase doesn't do this — the rationale is a free-string field — because the engineering cost of restructuring the type isn't paid back without measured drift. The concept I'd reach for first is the prompt-level forbidden-pattern rules; the structured-output workaround is for when prompt rules don't suffice.

**Layers-and-hops view of how a forbidden-pattern rule reaches the output:**

```
  Layers-and-hops — forbidden-pattern rule, prompt to output

  ┌─ Prompt source (recommendation.md) ────────────────────────┐
  │  ## Style rules for rationale                                │
  │   - forbidden list                                           │
  │   - alternative list                                          │
  │   - distribution hint                                         │
  └──────────────┬─────────────────────────────────────────────┘
                 │ hop 1: included in system prompt every call
  ┌─ Each chain run ▼ ─────────────────────────────────────────┐
  │  model generates rationale; checks against forbidden list  │
  │  → picks an opening from the alternative list              │
  └──────────────┬─────────────────────────────────────────────┘
                 │ hop 2: structured output
  ┌─ Recommendation[] ▼ ───────────────────────────────────────┐
  │  rationale text varies across the alternative patterns     │
  └──────────────┬─────────────────────────────────────────────┘
                 │ hop 3: post-hoc audit (gap — needs evals)
  ┌─ Audit ▼ ──────────────────────────────────────────────────┐
  │  count rationale openings across N runs                    │
  │  if any pattern > 40% of runs, add it to forbidden list    │
  └────────────────────────────────────────────────────────────┘
```

The audit step is what closes the loop. Without it, you guess at which patterns to forbid. With it, you measure and add to the list as new convergence patterns emerge. The audit is downstream of concept 05's eval substrate — another reason that gap matters.

### Move 3 — the principle

LLMs converge on phrasings because next-token prediction rewards the most likely next token. Generative output run repeatedly for the same user collides with this — every output starts to sound like the previous one. The fix is to forbid the convergent patterns AND provide rotating alternatives AND audit the distribution. The principle generalises to any system whose output is meant to feel individuated: rules alone aren't enough; the *measurement* of whether outputs are still diverse is what makes the rules adaptive.

## Primary diagram — the forbidden-pattern rule, end to end

```
  ┌─ Prompt source (recommendation.md, with the rule added) ─────────┐
  │  ## Style rules for rationale                                       │
  │                                                                      │
  │  ★ Forbidden openings ★                                              │
  │    - "By targeting customers..."                                     │
  │    - "Send a..."                                                     │
  │    - "To recover..."                                                 │
  │    - "Trigger an automated..."                                       │
  │                                                                      │
  │  ★ Rotating alternatives ★                                           │
  │    - EVIDENCE-FIRST: lead with the diagnosis number                  │
  │    - IMPACT-FIRST: lead with the affected count / dollars            │
  │    - ACTION-FIRST: lead with the Bloomreach feature                  │
  │                                                                      │
  │  ★ Distribution hint ★                                               │
  │    - aim for ~1/3 each across any 10 consecutive recommendations    │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │
  ┌─ Each chain run ▼ ────────────────────────────────────────────────┐
  │  model picks lead pattern, generates rationale                     │
  │  output rotates across the three alternatives                       │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │
  ┌─ Post-hoc audit (the missing piece) ▼ ───────────────────────────┐
  │  count rationale openings across N runs                            │
  │  IF any new pattern emerges at >40% → add to forbidden list        │
  │  IF distribution drifts away from 1/3 each → tighten the rule      │
  │  (this is a concept-05 eval-set responsibility)                    │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The convergence problem is the same problem as *mode collapse* in image-generation models — train a model on photographs of dogs and it'll happily generate the same kind of dog over and over. In LLMs the analog is style collapse: prose starts to look generic. The defense (enumerate forbidden patterns, list alternatives, audit distribution) is the same shape as mode-collapse mitigation in image models.

This is one of the older concepts in the prompt-engineering folklore — it predates structured outputs and tool use; people writing GPT-3 marketing copy in 2021 hit it immediately. The framing here is the production version: not "make the output sound less AI-y" (vague), but "audit the distribution of openings and prevent any one from exceeding a threshold" (measurable).

Three places to deepen:

- **OpenAI's prompt-engineering best practices.** The "vary the format" guidance is the official version of this concept. Lighter than what this guide covers.
- **Anthropic's docs on creative-writing prompting.** They acknowledge convergence and recommend few-shot diversity (concept 08) as the defense; this guide reaches for explicit forbidden-pattern rules instead because they're more controllable.
- **The literature on n-gram repetition penalties (decoding-time).** A different defense — at decoding time, penalize tokens that have already appeared. Works inside one generation; doesn't help with cross-generation convergence. Complementary, not redundant.

In this codebase, concept 08 (few-shot) is the *first* defense — if your one worked example doesn't start with the convergent opening, the model is less likely to copy it. Concept 05 (eval-driven iteration) is the *measurement* prerequisite — without an eval that tracks output diversity, you can't tell whether the forbidden-pattern rules are working.

## Project exercises

### Exercise — Add forbidden-pattern rules to the recommendation prompt

  → **Exercise ID:** FORBID-RECCO
  → **What to build:** Modify `lib/agents/legacy-prompts/recommendation.md` to add a `## Style rules for rationale` section with the three-part structure: forbidden openings (list 4–6 patterns observed in current outputs), rotating alternatives (EVIDENCE-FIRST / IMPACT-FIRST / ACTION-FIRST patterns with examples), distribution hint (roughly equal across 10 consecutive recommendations).
  → **Why it earns its place:** The recommendation rationale is the most user-exposed prose field in the codebase. Adding the rule is cheap (no code changes); the audit step is harder (requires concept 05's eval substrate). The rule alone is a measurable improvement.
  → **Files to touch:** `lib/agents/legacy-prompts/recommendation.md`.
  → **Done when:** the prompt has the three-part rule; a manual run of 5 different anomalies produces 5 recommendations with 3 different opening patterns.
  → **Estimated effort:** ~1 hour to author the rule (the harder part is identifying the 4–6 convergent openings to forbid, which requires running ~30 recommendations and tallying).

### Exercise — Add forbidden-pattern rules to the monitoring `impact` field

  → **Exercise ID:** FORBID-IMPACT
  → **What to build:** Similar to above, but for `legacy-prompts/monitoring.md`'s `impact` field. The convergence here is weaker (impact sentences are constrained by the metric and direction) but real. Add forbidden openings ("Revenue down...", "This represents a..."), rotating alternatives (lead with downstream effect, lead with customer count, lead with timing), and the distribution hint.
  → **Why it earns its place:** The impact field is what makes anomaly cards feel like analyst notes vs. templated alerts. The convergence problem here matters for the same reason it matters for recommendations.
  → **Files to touch:** `lib/agents/legacy-prompts/monitoring.md`.
  → **Done when:** the prompt has the three-part rule; 5 different anomalies produce 5 impact sentences across 3 different opening patterns.
  → **Estimated effort:** ~1 hour.

## Interview defense

**Q: "Why do all my LLM-generated outputs start to sound the same?"**

LLMs are next-token predictors. Run the same generative prompt repeatedly and the model converges on the highest-probability openings — "By targeting...", "Send a...", "To recover...". The output stops feeling individuated; users start clocking it as AI-generated. The defense is in the prompt: enumerate forbidden openings AND list rotating alternatives AND give a distribution hint. All three are needed.

```
  the rule shape:
    ★ FORBIDDEN list  (the convergent openings)
  + ★ ALTERNATIVES list (the patterns to rotate)
  + ★ DISTRIBUTION hint (roughly equal use)
  = output that stays diverse over N runs
```

Anchor: *"forbid the convergent openings, list the alternatives, hint at the distribution. Just forbidding picks another convergent opening from a smaller set."*

**Q: "When does this NOT matter?"**

One-shot classifiers and structured outputs. The intent classifier returns one word — convergence is the *goal*. The monitoring agent returns typed Anomaly fields — `category`, `severity`, `change.direction` are enumerated, no prose to drift on. The concept only matters where the model is writing prose, and only when the chain runs repeatedly for the same user. A one-time email draft doesn't need this; a recommendation feed the same user sees 50 times does.

Anchor: *"only for generative chains run repeatedly for the same user. One-shot or structured outputs don't need it."*

**Q: "How would you audit whether your rules are working?"**

Count opening phrases across N runs. If any single pattern exceeds ~40% of runs, the rule isn't holding — add it to the forbidden list. If the distribution drifts away from the intended ~1/3-1/3-1/3, tighten the rule. Honest gap in this codebase: there's no eval set today (concept 05), so the audit is by-hand. The first thing I'd build in the eval set is exactly this — a diversity metric over the recommendation rationale field across a fixture batch.

Anchor: *"audit by counting openings. >40% in any one pattern means the rule failed."*

**Q: "What about decoding-time repetition penalties?"**

Different problem. Decoding-time penalties prevent tokens from repeating *within one generation* — useful for avoiding "the cat the cat the cat" loops. They don't help with *cross-generation* convergence — the model still picks the same opening on each independent call. The two are complementary, not interchangeable. The prompt-level forbidden-pattern rule is what works for cross-generation drift.

Anchor: *"decoding-time penalties are within-one-generation; prompt-level forbidden patterns are cross-generation. Different defenses for different drifts."*

## See also

- `01-anatomy.md` — forbidden patterns live in section 1 (system role) as style rules.
- `08-few-shot.md` — your worked example's opening should NOT be one of the convergent patterns, or the model copies it.
- `05-eval-driven-iteration.md` — the audit step (counting openings across N runs) is an eval responsibility; without the eval substrate, the rule's effectiveness is by-eyeball.
- `11-meta-prompting.md` — the spec discipline (`format.md` banning hedging and marketing phrases) is the meta-prompting application of this concept.
