# 13 · Forbidden patterns and rotating formulas

**Industry name:** *output diversity control* / *forbidden phrasings* / *rotating formulas* · Language-agnostic

## Zoom out — where output drift shows up

LLMs converge on phrasings. Every diagnosis from the same chain, given similar anomalies, starts sounding the same. The `conclusion` always opens with "The conversion drop was caused by...". The evidence bullets always start with "Data shows...". Every recommendation says "Consider setting up a...". Repetition is fine on one output; across N outputs on similar cases, it becomes an obvious tell.

```
  Zoom out — where phrasing drift lands

  ┌─ Diagnostic chain, run over 10 goldens ─────────────────┐
  │                                                          │
  │  case 01: "The conversion drop was caused by payment…"   │
  │  case 02: "The revenue decline was caused by fraud…"     │
  │  case 03: "The session drop was caused by SEO…"          │
  │  case 04: "The abandonment was caused by checkout…"      │
  │                                                          │
  │  every conclusion opens with "The [X] was caused by [Y]" │
  │  → uniform voice becomes a signal of AI generation        │
  └──────────────────────────────────────────────────────────┘
```

The problem lands hardest on user-facing generative chains — captions, summaries, personalization — where repetition is immediately visible to the user. On this codebase (diagnosis + recommendation as JSON), the surface is smaller, but it's still there.

## Zoom in — three related patterns

Three moves that address this:

1. **Forbidden openings.** "Do NOT start conclusions with 'The'." Explicit ban on the specific opener that keeps recurring.

2. **Rotating formulas.** "Rotate between these 5 opening frames: {list}." The prompt names alternatives explicitly.

3. **Rotation history.** For chains that run repeatedly over time, track what phrasings have been used recently and forbid them in the next run.

This codebase doesn't currently use any of these — the prompts don't include forbidden-phrasing lists. The reason is honesty: this chain runs once per case, outputs are structured JSON with short fields, and the small surface hasn't demanded rotation yet. But the pattern is worth understanding because *any* generative chain in production eventually grows into it.

## Structure pass — layers, axis, seams

Trace one axis: *how visible is phrasing repetition to the reader*.

- **Layer 1 — one-shot classifiers.** Repetition invisible; the output is a label, not a phrasing.
- **Layer 2 — structured JSON with short fields.** Repetition present but bounded; a `conclusion` field is one sentence, and a set of one-sentence conclusions looks less repetitive than a set of paragraphs would.
- **Layer 3 — structured JSON with prose fields.** Repetition visible; the `rationale` field of a recommendation, or the `evidence` bullets of a diagnosis, is where sameness starts to show.
- **Layer 4 — free-form prose (query agent).** Repetition most visible; every response starts to sound the same over N runs for the same user.

**The seam:** between "output surface where repetition doesn't matter" (Layers 1-2) and "output surface where it does" (Layers 3-4). This codebase is mostly Layer 2 with some Layer 3 exposure. The query chain is Layer 4.

## How it works

### Move 1 — the shape

You've read AI-generated text before. You know the tells. Every response opens with "Certainly! Let me help you with that." Every summary starts with "In summary,". Every recommendation says "You might consider...". The mechanism: token probabilities. On any given opening, one path is dramatically more likely than the others. The model picks it every time. Left uncorrected, the whole chain sounds like one voice.

```
  Pattern — convergence as token-probability landscape

  next-token distribution after "The conversion drop was":
    "caused by"    ── 0.42  ★ picked every time
    "driven by"    ── 0.11
    "attributable" ── 0.08
    "explained by" ── 0.06
    other          ── 0.33  (spread across many low-prob tokens)

  same input distribution → same picked token → same phrasing.
  variation lives in the tail, and the tail is thin.
```

The fix is to *narrow* what the model can pick from at the top by declaring the top options forbidden. Forced into the tail, the model produces variation. This works surprisingly well for phrasing-level diversity; it doesn't help with content-level variation (that's a temperature question, not a prompt question).

### Move 2 — walking the mechanism

#### Forbidden opening — the strongest single move

The pattern:

```
   In § 1 role/rules:

   Do NOT begin the `conclusion` field with any of:
     - "The [X] was caused by"
     - "The primary reason for"
     - "Based on the evidence"
     - "Analysis shows that"

   Instead, open with a specific fact, a specific number, or a
   specific mechanism.
```

Four bans + one positive direction. The model, denied its preferred openings, uses the tail of the distribution and produces variation. The positive direction ("open with a specific fact") is the guide rail — without it, the model might substitute a different forbidden opener that you didn't think to ban.

This isn't in this codebase's prompts. Adding it would be a low-cost, low-risk edit to any of the JSON-emitting chains where the `conclusion` / `rationale` field is starting to feel same-y across cases. Right now, spot-checking receipts across the baseline run `2026-07-03T04-08-28-644Z`, the diagnosis conclusions do open with variations of "The [X] was caused by [Y]" a majority of the time. It's noticeable to a reader looking for it.

#### Rotating formula — for multi-output cases

When a chain produces multiple outputs from one call (a `Recommendation[]` array of 2-3 items), rotation prevents the outputs from sounding the same as each other.

The pattern:

```
   You will produce 2-3 recommendations. Each recommendation's
   `rationale` field opens with a DIFFERENT frame:
     - Frame A: name the mechanism the recommendation addresses
     - Frame B: name the affected customer segment
     - Frame C: name the leverage — what makes this action higher-impact

   Use each frame at most once per response.
```

Explicit rotation across the items in one response. The model, constrained to not repeat the frame across items, distributes them.

Again, not in this codebase. The three recommendations from case 01 in the baseline run all open similarly ("This recommendation addresses..." with minor variants). Adding rotation would tighten the voice.

#### Rotation history — for chains run over time

The strongest move, and the most expensive. For a chain that runs repeatedly *for the same user or context* (a daily briefing that ships the same anomaly types week after week; a caption chain that produces one caption per user per day), you track what phrasings have already been used and pass "already used, don't repeat" as context on the next run.

The pattern:

```
   Recent conclusion openings (do NOT repeat any of these):
   - "The mobile conversion drop was caused by processor failure"
   - "The revenue decline reflects a fraud spike"
   - "Session traffic fell due to organic search shifts"

   Your conclusion must open with a phrasing not in the list.
```

Real state management. You'd store the recent conclusions in a durable store (a database, a Redis, a JSON file), pass them into the prompt as context, and update after each run.

The trade-off is context tokens vs freshness. In this codebase, briefings run against a workspace with a fixed category set and similar-shape anomalies over time. If the same "revenue drop by 30%" anomaly triggers the same "The revenue drop was caused by..." conclusion three weeks in a row, users notice. Rotation history is the fix.

Not implemented in this repo — the eval runs each case in isolation, not longitudinally. But if the production briefing loop grew a "recent runs" store, this pattern would be the natural home for it.

```
  Flow — rotation history injecting into the prompt

  ┌─ storage ────────────────────────────┐
  │  recent_openings.json                 │
  │  [ "The mobile conversion drop…",     │
  │    "The revenue decline reflects…",   │
  │    "Session traffic fell due to…" ]   │
  └────────────────┬─────────────────────┘
                   │  read on each run
                   ▼
  ┌─ prompt § 1 augmented at runtime ────┐
  │  … your normal role/rules …           │
  │  Do NOT open with any of: {recent}    │
  └────────────────┬─────────────────────┘
                   │
                   ▼
  ┌─ model output ───────────────────────┐
  │  conclusion: [new opening]            │
  └────────────────┬─────────────────────┘
                   │  append to storage
                   ▼
  ┌─ storage updated ────────────────────┐
  │  recent_openings.json now includes    │
  │  the new opening                      │
  └───────────────────────────────────────┘
```

#### When rotation doesn't matter

The pattern shouldn't be applied everywhere. Places where it's wasted or harmful:

- **One-shot classifiers.** Output is a label, not a phrasing. Rotation is irrelevant.
- **Structured outputs where the fields are terse.** Anomaly's `metric` field is `"purchase_revenue"`. Nobody notices if every anomaly uses `"purchase_revenue"` for revenue anomalies — that's correct, not repetitive.
- **Cases where the *content* is what matters.** A diagnosis's `conclusion` field should be accurate first, varied second. Forbidding openings can push the model into imprecise language to satisfy the ban. On this codebase, accuracy is the primary rubric axis (`root_cause_plausibility`), and rotation could regress it.

The Hamel Husain framing on this: measure before and after. If forbidding a phrasing improves reader experience without regressing the accuracy rubric, keep the forbidden list. If accuracy regresses, the ban is doing more harm than good.

### Move 2 variant — the load-bearing skeleton

Kernel of "output diversity as a discipline":

1. **Identify where repetition is visible.** Drop this and you apply the pattern to Layer 1 fields where it wastes tokens.
2. **Name the forbidden phrasings explicitly.** Drop this and "vary your outputs" as instruction has no lever.
3. **Provide positive direction alongside bans.** Drop this and the model substitutes an equally-repetitive different opener.
4. **For over-time chains, track and pass history.** Drop this and rotation resets every call.

Hardening on top: A/B testing forbidden lists, per-user rotation stores, temperature bumps as a coarser alternative. None of that is the skeleton.

### Move 3 — the principle

**The convergence problem is a token-distribution problem, and the fix is at the prompt layer, not the sampling layer.** Bumping temperature adds noise everywhere — you get variation in the conclusions and variation in the accuracy. Forbidden openings add variation at the specific position where it matters (the first token of a field), without touching accuracy. The prompt-layer fix is more surgical. This is why the pattern is a prompt engineering technique, not a decoding-config technique.

## Primary diagram

```
  Forbidden patterns — the full recap

  three moves, increasing weight:

  ┌─ 1. forbidden openings ────────────────────────────────────┐
  │  in § 1 or § 4:                                             │
  │  "Do NOT open the `conclusion` field with:                   │
  │    · 'The [X] was caused by'                                 │
  │    · 'The primary reason for'                                │
  │    · 'Based on the evidence' "                               │
  │  cost: ~50 tokens per call                                   │
  │  used in this repo: NOT YET                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ 2. rotating formulas ─────────────────────────────────────┐
  │  in § 4 for multi-output cases:                             │
  │  "Each recommendation opens with a DIFFERENT frame:         │
  │    - mechanism / segment / leverage                          │
  │  Use each frame at most once per response."                  │
  │  cost: ~30 tokens per call                                   │
  │  used in this repo: NOT YET                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ 3. rotation history ──────────────────────────────────────┐
  │  storage of recent phrasings                                │
  │  read on each run, passed as § 2 context                    │
  │  updated after each run                                     │
  │  cost: ~100-300 tokens per call + storage layer             │
  │  used in this repo: NOT YET (single-run eval; would         │
  │  land if briefings ran longitudinally)                       │
  └─────────────────────────────────────────────────────────────┘

  when to skip: classifiers, terse structured fields,
  cases where accuracy dominates over voice variation.
```

## Elaborate

The specific place where I've shipped this pattern in production: a caption generator for a social product. Every caption started with "Check out this...". Users noticed by day three. First fix was `temperature: 0.9`, which produced variation but also produced weird captions ("Check out this... incredible... hmm... thing?"). Second fix was forbidden openings — banned "Check out," "Take a look at," "Get ready for," and required opening with a specific noun. Variety improved without content regression. Third fix was rotation history — stored last 30 captions per user, passed them as forbidden phrasings. Users reported captions felt fresh. Total prompt engineering cost: about a day. Total impact: measurable in retention.

The Reddit / Twitter-thread advice on this problem is "just add temperature." That works for casual variation. It doesn't work for shipping to users who look at 20 outputs in a row. Forbidden lists are the production move; temperature bumps are the demo move. Ship both if the surface is critical.

The related pattern from concept 08 (few-shot): if you *do* include few-shot examples in a generative chain, the examples themselves become templates the model tends to imitate. Rotating the examples across runs — or randomizing which subset gets included — helps. In this codebase, the shape-example in each JSON prompt is fixed, which contributes to a bit of the shape-repetition problem. Rotating shape examples on every call would be a token cost with unclear benefit; not worth it here.

The failure mode this pattern *doesn't* fix: content-level repetition. If every anomaly in the workspace really is a "conversion drop due to payment processor failure," then every conclusion honestly is about payment processors. That's not a phrasing problem; that's the reality of the data. Forbidden lists don't help here; they'd only push the model into inaccurate variation. Diagnose the problem before applying the fix.

## Interview defense

**Q: When would you add forbidden phrasings to a prompt?**

When output repetition is visible to the reader. On classifiers or terse structured fields, don't bother — repetition is invisible or correct. On generative fields (a captioning chain, a `rationale` field in a recommendation, a `conclusion` in a diagnosis), repetition becomes a tell. The fix is to identify the specific opener the model prefers, ban it explicitly in § 1 or § 4 of the prompt, and provide positive direction ("open with a specific fact, not a template phrase"). This is a prompt-layer fix, not a decoding-config fix — temperature bumps add noise everywhere; forbidden openings add variation surgically at the position that matters.

```
  temperature: variation everywhere (including accuracy — bad)
  forbidden openings: variation at first-token position only (surgical)
```

Anchor: not currently in this repo — a targeted addition if the diagnosis `conclusion` field's uniformity became visible to users.

**Q: How does rotation history differ from forbidden openings?**

Forbidden openings is a static list in the prompt. Rotation history is a *dynamic* list, updated after each run, passed as context on the next run. Static forbidden lists prevent the model from ever using the banned phrasings. Rotation history prevents the model from using phrasings it just used — a caption "Check out this pizza!" is fine once a month, bad three days running. The cost is real: rotation history requires a storage layer plus per-run reads/writes, plus 100-300 tokens of context per call for the recent list. Worth it when the same chain runs repeatedly *for the same user or context* and freshness matters. In this codebase, the eval runs each case in isolation, so rotation history hasn't landed — but if the production briefing loop kept running against the same workspace, this is where it would live.

```
  static forbidden:  ban forever
  rotation history:  ban recent N, refresh window
```

## See also

- 08 · few-shot — few-shot examples become templates that need rotation.
- 03 · prompts as code — forbidden lists live in the versioned prompt file; rotation history lives in a runtime store.
- 06 · single-purpose chains — rotation applies per-chain, not to the pipeline as a whole.
- 05 · eval-driven iteration — measure before/after adding forbidden lists to catch accuracy regression.
