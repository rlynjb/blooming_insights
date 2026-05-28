# Forbidden patterns and rotating formulas

**Industry name(s):** forbidden patterns, negative constraints, rotating formulas, anti-repetition, phrasing-convergence mitigation
**Type:** Industry standard · Language-agnostic

> blooming insights uses negative-constraint "forbidden" instructions pervasively — "do NOT re-run variations of the same query," "Never report a change derived from an empty window," "Do NOT use customers matching," "Do NOT include an `id` field" — but it uses *no* rotating formulas, correctly: its repeated chains emit structured output (phrasing never converges) and its one prose agent is one-shot per question, not repeated for the same user.

**See also:** → 02-structured-outputs.md · → 01-anatomy.md · → 09-chain-of-thought.md · → 06-single-purpose-chains.md

---

## Why care

You have built a form validator with two kinds of rules: positive ones ("email must contain @") and negative ones ("reject disposable-domain addresses," "strip script tags"). The negative rules carry more weight per character because they encode *the specific bad thing that happened* — someone pasted a script tag once, it broke something, and now there is a rule with that exact shape. A negative constraint is scar tissue; it names a failure you already paid for.

An LLM prompt has the same two kinds of rules, and the question this file answers splits cleanly: blooming insights uses negative constraints heavily — and it does *not* use rotating formulas at all. Both choices are correct, and knowing *why* each is right is the whole concept. Rotating formulas fight a problem (phrasing convergence in repeated generation) that this codebase's output shape does not have.

**The pivot: a "forbidden" instruction is a production incident compressed into one line, and rotating formulas only earn their place when the *same* generation runs repeatedly for the *same* user in prose.** I once shipped a daily-digest feature that emailed users a generated summary every morning. Within a week, every digest opened "Here's what happened today" — the model converged on one phrasing and the feature felt robotic. The fix was a rotating set of opening formulas. But I have also shipped structured extractors that ran millions of times and never needed rotation, because their output was JSON — there is no phrasing to converge. blooming insights is the second kind, and it would be wrong to add rotation to it.

Before understanding the split:
- "Add anti-repetition to the agents" — but the agents emit JSON; there is no phrasing to vary
- "The forbidden instructions are over-defensive" — but each one is a real incident encoded as a rule
- "The query agent should rotate its openings" — but it runs once per question, never repeatedly for one user

After:
- Negative constraints are recognized as scar tissue and read as incident history
- Rotating formulas are recognized as correctly *absent* — the output shape removes the need
- The one scenario where rotation *would* be needed (a recurring prose digest) is named precisely

It is the negative-validation-rule discipline, plus the judgment to know when phrasing-convergence is even a problem worth fighting.

---

## How it works

**Mental model.** This concept has two halves that solve different problems. *Negative constraints* ("do NOT X") fence off specific behaviors the model would otherwise drift into — they shape a *single* generation. *Rotating formulas* fight a different problem: when you generate the *same kind of thing repeatedly for one user*, free-form prose converges on a house style and feels robotic, so you rotate openings/structures to keep it fresh. The decision is conditional: rotation is only needed when output is **prose** AND **repeated for the same user**.

```
the two halves — different problems
─────────────────────────────────────────────────────────────
 NEGATIVE CONSTRAINTS    "do NOT re-run variations"
   │                     shapes ONE generation; fences off drift
   │                     ← used pervasively in blooming insights
 ROTATING FORMULAS       rotate openings to avoid convergence
                         needed ONLY when: prose AND repeated-for-one-user
                         ← correctly ABSENT — output is structured / one-shot
```

The two are not a pair you always ship together. blooming insights ships the first heavily and the second nowhere, and the reason is its output shape.

---

### The negative-constraint half — forbidden instructions as scar tissue

The prompts are dense with "do NOT" / "Never" rules, and each one reads as a fixed bug. Four representative ones:

```
forbidden instructions across the prompts
─────────────────────────────────────────────────────────────
 monitoring.md   L11  "do NOT re-run variations of the same query"
 monitoring.md   L31  "Never report a change derived from an empty
                       or zero window"
 diagnostic.md   L33  "Do NOT use a `customers matching ...` clause —
                       it is NOT supported in this EQL flavor"
 recommendation.md L64 "Do NOT include an `id` field — the system
                        assigns it after validation"
```

Each is a specific incident compressed:

- **L11 (monitoring) / L33 (diagnostic) repeated** — the model burned its tool-call budget re-running near-identical queries. The negative constraint caps wasted calls, working *with* the `maxToolCalls` budget (→ 04-token-budgeting.md).
- **L31 (monitoring)** — the model once computed a ±100% swing off an empty data tail and reported it as real. "Never report a change derived from an empty window" is that bogus-number bug, fenced off. The surrounding prose (`monitoring.md` L14–L31) even narrates the failure: short windows "land on an empty tail and produce meaningless ±100% swings."
- **L33 (diagnostic)** — the model kept reaching for `customers matching`, an unsupported EQL clause that "wastes a call." This is a *negative format exemplar* (→ 08-few-shot.md): show the forbidden shape so the model avoids it.
- **L64 (recommendation)** — the model would invent an `id`; the system owns identity (`crypto.randomUUID()` after validation). The constraint keeps the model out of the system's lane and matches the id-less shape `isRecommendationArray` validates (→ 02-structured-outputs.md).

```
each "do NOT" = a bug that happened once, now fenced off
   L11/L33 → wasted-budget incident   L31 → bogus-number incident
   L33     → unsupported-clause bug    L64 → model-owned-identity bug
```

These are not generic best practices; they are this workspace's specific failures, encoded where the model will read them every call.

---

### The rotating-formula half — correctly absent, and why

Rotating formulas are nowhere in this codebase, and that is the right call. The reason is the output shape of every repeated generation.

**The three repeated chains emit structured output.** monitoring, diagnostic, and recommendation return JSON (`monitoring.md` L50–L73, `diagnostic.md` L44–L81, `recommendation.md` L44–L71). JSON has no phrasing to converge — `{ "severity": "critical" }` is `{ "severity": "critical" }` every time, and that *sameness is correct*. The spec's own rule applies: rotating formulas are *not* needed when output is structured. You do not rotate the openings of a JSON array; identical structure is the contract.

```
repeated chains → JSON output → no phrasing to converge → no rotation needed
 { "metric": "...", "severity": "critical", ... }   ← sameness IS the contract
```

**The one prose agent is one-shot per question.** The query agent returns free prose (`query.md` L36, "No JSON shape is required — just the answer text") — so it *has* phrasing that could converge. But it runs *once per question* (`route.ts` L135–L143: classify → answer → done), not repeatedly for the same user on a schedule. Convergence is a problem of *repetition for one recipient over time*; a one-shot answer to a distinct question each time has nothing to converge against. The user asks something new; the answer is new.

```
query agent → prose output → BUT one-shot per question → nothing repeats → no rotation
 (convergence needs: same generation × same user × over time — none hold here)
```

So both conditions for rotation fail everywhere: the repeated generations are structured (no phrasing), and the prose generation is not repeated (no convergence). Rotation correctly absent.

---

### Move 2.5 — when rotation WOULD be needed here

Name the exact scenario, because it is one feature away. Suppose blooming insights added a **daily prose digest** — every morning, generate a natural-language summary of the workspace's overnight changes and email it to the *same* merchant. Now both conditions hold: the output is prose (it has phrasing), and the same generation runs repeatedly for the same user over time. Within a week, every digest would open "Here's what changed in your workspace today," and the feature would feel like a robot.

```
the scenario that flips it: a recurring prose digest
─────────────────────────────────────────────────────────────
 same generation  +  same user  +  over time  +  PROSE output
        └──────────── all four hold → phrasing converges ───────┘
 fix: forbidden openings ("never open with 'Here's what…'")
      + a rotating set of opening formulas / structures
```

That feature does not exist today — which is exactly why rotation is correctly absent today. The discipline is conditional: add rotation *when* you add a recurring prose generation for a fixed recipient, not before.

---

### The principle

Forbidden patterns split into two halves with different triggers. Negative constraints encode specific incidents and belong in any prompt where the model drifts into a known bad behavior — blooming insights uses them pervasively, one per real failure. Rotating formulas fight phrasing convergence, which only happens when *prose* is generated *repeatedly for the same user over time* — a condition that holds nowhere in this codebase, because every repeated chain emits structured output and the one prose agent is one-shot. The codebase uses the half it needs and omits the half it does not, and the only thing that would flip the second decision is a feature it has not built: a recurring prose digest.

---

## Forbidden patterns — diagram

This diagram spans both halves. The Negative-constraint layer fences off drift in every prompt; the Rotation-decision layer shows why rotation is absent (structured or one-shot) and the single condition that would require it. A reader who sees only this should grasp that the forbidden half is used and the rotating half is correctly skipped.

```
┌──────────────────────────────────────────────────────────────────────┐
│  NEGATIVE CONSTRAINTS (used pervasively — one per incident)          │
│                                                                       │
│  monitoring.md   L11  do NOT re-run variations    ← wasted budget    │
│  monitoring.md   L31  Never report empty-window   ← bogus numbers    │
│  diagnostic.md   L33  Do NOT use customers matching ← unsupported    │
│  recommendation.md L64 Do NOT include an id field ← system owns id   │
│           │  each fences off a specific bug, read every call         │
└───────────┼────────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ROTATION DECISION (correctly ABSENT)                                │
│                                                                       │
│  repeated chains → STRUCTURED output → no phrasing to converge       │
│    monitoring/diagnostic/recommendation = JSON  (→ 02)              │
│  prose agent → ONE-SHOT per question, not repeated for one user      │
│    query.md L36 prose · route.ts L135–143 classify→answer→done       │
│           │                                                          │
│  would flip IF: recurring prose digest (same user, over time)       │
│    → then add forbidden openings + rotating formulas                 │
└──────────────────────────────────────────────────────────────────────┘

  Forbidden half: used heavily.  Rotating half: skipped, correctly —
  no prose-repeated-for-one-user generation exists to converge.
```

The codebase ships the negative-constraint half and omits the rotation half, because its output shape removes the convergence problem rotation solves.

---

## In this codebase

**Case A for negative constraints · Case B for rotating formulas.**

### Negative constraints — forbidden instructions (used pervasively)

- **File:** `monitoring.md`, `diagnostic.md`, `recommendation.md`, `query.md`
- **Function / class:** the Hard rules / method / field-rules sections (prompt text)
- **Line range:** `monitoring.md` L11 ("do NOT re-run variations"), L31 ("Never report a change derived from an empty or zero window"); `diagnostic.md` L33 ("Do NOT use a `customers matching` clause"); `recommendation.md` L64 ("Do NOT include an `id` field"); `query.md` L11 (the same unsupported-clause ban)
- **Role:** each fences off a specific, previously-hit failure — wasted budget, bogus numbers, unsupported syntax, model-owned identity — read by the model on every call.

### Rotating formulas — absent (and correctly so)

- **File:** the repeated chains + the prose agent
- **Function / class:** structured outputs vs. one-shot prose
- **Line range:** structured: `monitoring.md` L50–L73, `diagnostic.md` L44–L81, `recommendation.md` L44–L71 (JSON — no phrasing to converge); one-shot prose: `query.md` L36 + `route.ts` L135–L143 (one classify→answer→done per question)
- **Role:** rotation is unnecessary because every repeated generation is structured and the one prose generation is not repeated for the same user — neither condition for convergence holds.

### The condition that would require rotation (not yet built)

- **File:** would live alongside a new recurring-digest feature
- **Function / class:** a hypothetical daily prose summary emailed to the same merchant
- **Line range:** n/a — does not exist; the closest existing prose is `query.md` (one-shot, so exempt)
- **Role:** the only scenario that flips the decision — prose generated repeatedly for the same user over time — and the point at which forbidden openings + rotating formulas would earn their place.

### Why this split is correct

The negative-constraint half is present because the model genuinely drifts into known bad behaviors, and a "do NOT" line is the cheapest fence. The rotating-formula half is absent because the problem it solves — phrasing convergence — requires prose repeated for one recipient over time, and the codebase has structured repeated output plus one-shot prose. Adding rotation now would be solving a problem the codebase does not have; the team correctly did not.

---

## Elaborate

### Where this comes from

Negative constraints are as old as prompting itself — the OpenAI cookbook and Anthropic's prompt guide both note that telling a model what *not* to do is sometimes necessary, with the caveat that positive framing ("do X") usually outperforms negative framing ("don't do Y") because the model attends to the salient token (tell it "don't mention price" and "price" is now in its context). blooming insights' negative constraints survive that caveat because they fence off *behaviors* (re-running queries, reporting empty windows) and *syntax* (`customers matching`), not topics — there is no salient-token backfire.

Rotating formulas are a newer, narrower practitioner technique — they emerged from consumer-facing generative features (caption generators, daily digests, notification copy) where the *same* generation runs for the *same* user and free-form prose converges on a house phrasing that reads as robotic. The fix is a rotating pool of openings/structures, sometimes with explicit "forbidden openings" so the model cannot fall back to the convergent phrase.

### The deeper principle

```
negative constraint                  rotating formula
──────────────────────────────      ──────────────────────────────
shapes ONE generation                shapes a SEQUENCE of generations
fences off a known bad behavior      fights phrasing convergence
trigger: model drifts into a bug     trigger: prose × same user × over time
always applicable to that prompt     applicable ONLY under that condition
```

The two live at different scopes. A negative constraint operates within a single call; a rotating formula operates across many calls to one recipient. Conflating them — "we generate text repeatedly, so add anti-repetition" — is the error, because *structured* repeated output has no phrasing to repeat. The condition that makes rotation necessary is specifically prose-for-one-user-over-time, and it is absent here.

### Where this breaks down

1. **Negative constraints can backfire by salience.** Telling the model "do NOT use `customers matching`" puts `customers matching` in its context every call. For *behaviors* this is fine (the alternative, `by <attribute>`, is shown right after at `diagnostic.md` L33), but a poorly-worded negative constraint can prime the exact thing it forbids. Pairing each "do NOT" with the positive alternative (as L33 does) is the mitigation.

2. **Forbidden instructions accumulate as cruft.** Each incident adds a line, and prompts grow into a wall of "Never"/"do NOT" that the model attends to unevenly (the dense CRITICAL blocks in `monitoring.md` L25–L31 and `diagnostic.md` L36–L42). Without an eval suite (→ 05-eval-driven-iteration.md), there is no way to know which forbidden lines still earn their place after a model upgrade — some may now be unnecessary.

3. **The rotation decision is workspace-specific, not permanent.** "Rotation absent is correct" holds *because* the output is structured and the prose is one-shot. The moment a recurring prose feature ships, the decision must be revisited — and a team that learned "we don't need rotation" as a rule rather than a conditional will miss it.

### What to explore next

- **Convert behavioral negatives to positive framing where possible** — "re-run variations" → "issue each distinct query once," reducing salience backfire.
- **Eval the forbidden lines** — after a model upgrade, test which "do NOT" constraints still change behavior and prune the dead ones.
- **Build the recurring digest with rotation from day one** — if a daily prose summary is added, ship forbidden openings + rotating formulas with it, rather than discovering convergence in production.

### Where the literature lands

Anthropic's prompt guide and the OpenAI cookbook both recommend positive over negative framing as the default, reserving negatives for cases where the bad behavior is specific and the positive form is awkward. blooming insights' negatives are exactly those cases — specific behaviors and unsupported syntax — which is why they survive the guidance rather than violating it.

---

## Tradeoffs

### Negative constraints + no rotation (this codebase) vs. positive-only vs. rotation-everywhere

| Dimension | This codebase (negatives, no rotation) | Positive framing only | Rotation on all repeated output |
|---|---|---|---|
| Encodes specific incidents | Yes — one "do NOT" per bug | Awkward for some bugs | N/A |
| Salience backfire risk | Present (mitigated by paired positives) | None | N/A |
| Fights phrasing convergence | N/A — not needed | N/A | Yes, but solves a non-problem here |
| Cost on structured output | None | None | Wasted — JSON has no phrasing |
| Prompt growth / cruft | Accumulates without evals | Cleaner | Adds unneeded rotation logic |
| Correct for this output shape | Yes | Partially | No |

**What we gave up.** Some prompt cleanliness and salience-safety. The negative constraints accumulate into dense "Never"/"do NOT" blocks, and each one re-introduces the forbidden token into context. The codebase accepts this because each negative encodes a real incident and is paired with a positive alternative where it matters (`diagnostic.md` L33).

**What the alternative would have cost.** Positive-only framing would have made some constraints awkward ("issue each distinct query exactly once" is clumsier than "do NOT re-run variations") and could not cleanly express the empty-window ban. Rotation-everywhere would have added machinery to fight a convergence problem that structured output does not have — pure cost, since JSON sameness is the contract, not a defect.

**The breakpoint.** No rotation is correct while every repeated generation is structured and the only prose is one-shot. The decision flips the moment a recurring prose generation for a fixed recipient ships — a daily digest, a weekly email summary — at which point phrasing convergence becomes real and forbidden-openings + rotating formulas become necessary. The trigger is a *feature*, not a metric: the day "same prose, same user, over time" becomes true.

---

## Tech reference (industry pairing)

### negative constraints (forbidden instructions)

- **Codebase uses:** `monitoring.md` L11/L31, `diagnostic.md` L33, `recommendation.md` L64 — "do NOT" / "Never" rules, one per known incident.
- **Why it's here:** to fence off specific behaviors (re-running queries, reporting empty windows), unsupported syntax (`customers matching`), and model-owned identity — each a real failure.
- **Leading today:** positive framing is the default-leading guidance in 2026 (Anthropic prompt guide, OpenAI cookbook); negative constraints lead for specific-behavior and forbidden-syntax cases where the positive form is awkward.
- **Why it leads:** the model attends to the salient token, so positives avoid priming the bad thing — but specific behavioral/syntax bans are clearer stated negatively.
- **Runner-up:** structured-output validation (`validate.ts` type guards) — enforces some constraints (id-less shape) in code so the prompt does not have to (→ 02-structured-outputs.md).

### rotating formulas (anti-convergence — NOT used here)

- **Codebase uses:** nothing — no agent rotates openings or structures.
- **Why it's here:** named as correctly absent; the convergence problem it solves requires prose repeated for one user over time, which no agent does.
- **Leading today:** rotating formula pools + forbidden openings lead for recurring consumer-facing prose (digests, captions, notifications) in 2026.
- **Why it leads:** they keep repeated prose from converging on a robotic house phrasing.
- **Runner-up:** higher temperature / sampling diversity — increases variance but does not target the *opening* convergence the way a curated rotation pool does.

### structured output as the convergence-eliminator

- **Codebase uses:** `monitoring.md` L50–L73, `diagnostic.md` L44–L81, `recommendation.md` L44–L71 — JSON output on every repeated chain.
- **Why it's here:** structured output has no phrasing to converge, so it removes the need for rotation on the repeated generations.
- **Leading today:** structured output (tool-use / response_format) leads for repeated machine-consumed generations in 2026 (→ 02-structured-outputs.md).
- **Why it leads:** sameness is the contract — identical structure is correct, not robotic.
- **Runner-up:** templated prose with slotted values — structured-ish output that still reads as language; needed when a human reads every instance.

---

## Project exercises

### Add forbidden openings + rotating formulas to a new recurring prose digest

- **Exercise ID:** B1.13 (adapted) — rotating formulas where they earn their place.
- **What to build:** add a daily-digest feature that generates a natural-language summary of the workspace's recent changes for the *same* merchant on a schedule, and ship it with a "forbidden openings" list (e.g. never open with "Here's what changed…") plus a rotating pool of opening formulas/structures so successive digests do not converge.
- **Why it earns its place:** this is the *one* scenario that flips the rotation decision — prose, same user, over time — so building it demonstrates you know exactly when rotation is needed and when it is not.
- **Files to touch:** new `lib/agents/prompts/digest.md` (with forbidden openings + rotation pool), new `lib/agents/digest.ts`, a scheduled route, `test/agents/digest.test.ts` (assert successive runs do not share an opening).
- **Done when:** five successive digests for one merchant open with distinct formulas and none uses a forbidden opening, while the underlying facts stay accurate.
- **Estimated effort:** 1–2 days

### Convert behavioral negatives to positive framing and eval the difference

- **Exercise ID:** B1.13 (adapted) — negative-to-positive constraint conversion.
- **What to build:** rewrite the behavioral negatives ("do NOT re-run variations," `monitoring.md` L11) as positive instructions ("issue each distinct query exactly once"), keep the genuinely-negative ones (empty-window ban, unsupported clause), and measure whether the rewrite changes tool-call behavior on a fixed set of runs.
- **Why it earns its place:** addresses the salience-backfire failure and exercises the "positive over negative framing" guidance against real prompt lines, measured rather than assumed (→ 05-eval-driven-iteration.md).
- **Files to touch:** `lib/agents/prompts/monitoring.md`, `lib/agents/prompts/diagnostic.md`, a small eval harness counting redundant tool calls, `test/agents/monitoring.test.ts`.
- **Done when:** the positive-framed prompts produce equal-or-fewer redundant tool calls than the negative ones on the eval set, decided on the count.
- **Estimated effort:** 1–4hr

---

## Summary

Forbidden patterns split into two halves with different triggers, and blooming insights ships one and correctly omits the other. The negative-constraint half is used pervasively — "do NOT re-run variations" (`monitoring.md` L11), "Never report a change derived from an empty window" (`monitoring.md` L31), "Do NOT use a `customers matching` clause" (`diagnostic.md` L33), "Do NOT include an `id` field" (`recommendation.md` L64) — each a specific incident compressed into a line the model reads every call. The rotating-formula half is absent, and correctly: the three repeated chains emit JSON (no phrasing to converge, `monitoring.md` L50–L73 etc.), and the one prose agent is one-shot per question (`query.md` L36, `route.ts` L135–L143), so neither condition for phrasing convergence holds. The decision flips only if a recurring prose digest for the same user ships — at which point forbidden openings + rotating formulas would earn their place.

**Key points:**
- A "do NOT" instruction is a production incident compressed into one line — scar tissue, read every call.
- blooming insights uses negative constraints heavily and pairs them with positive alternatives where salience backfire would bite (`diagnostic.md` L33).
- Rotating formulas fight phrasing convergence, which needs prose generated repeatedly for the same user over time.
- Rotation is correctly absent: repeated chains are structured (no phrasing) and the prose agent is one-shot (no repetition).
- The decision flips only with a recurring prose digest — a feature not yet built.

---

## Interview defense

### What an interviewer is really asking

"How do you keep generated output from getting repetitive?" tests whether you reflexively reach for rotation or first ask whether convergence is even the problem. The senior signal is splitting the concept — negative constraints (used) vs. rotating formulas (correctly absent) — and naming the exact condition (prose × same user × over time) under which rotation becomes necessary.

### Likely questions

**[mid] "Point to a forbidden instruction in this codebase and explain what bug it prevents."**

`monitoring.md` L31 — "Never report a change derived from an empty or zero window." The bug: the model computed a ±100% swing off an empty data tail and reported it as real (the prose at L14–L31 narrates it — short windows land on the empty tail). The constraint fences off that bogus-number incident. Each "do NOT" in these prompts is a bug that happened, encoded as a rule.

```
empty-window ±100% swing reported as real  →  "Never report ... empty window"
```

**[senior] "Your agents generate output constantly. Why no anti-repetition or rotating formulas?"**

Because rotation fights *phrasing convergence*, and that needs prose generated repeatedly for the same user over time — which holds nowhere here. The three repeated chains emit JSON (`monitoring.md` L50–L73 etc.); JSON has no phrasing to converge, and identical structure is the contract, not a defect. The one prose agent is one-shot per question (`query.md` L36, `route.ts` L135–L143) — a new question each time, nothing to repeat against. Adding rotation now would solve a problem the codebase does not have.

```
repeated → structured (no phrasing)   |   prose → one-shot (no repetition)
           neither condition for convergence holds → rotation correctly absent
```

**[arch] "When would this codebase actually need rotating formulas?"**

The day it ships a recurring prose digest — a daily natural-language summary emailed to the *same* merchant. Then all four conditions hold: prose output, same generation, same user, over time. Within a week every digest would open "Here's what changed today" and feel robotic. *That* is when you add forbidden openings plus a rotating pool. Until that feature exists, rotation is correctly absent — the trigger is a feature, not a metric.

```
recurring prose digest: prose × same generation × same user × over time
                        → phrasing converges → add forbidden openings + rotation
```

### The question candidates always dodge

**"Doesn't telling the model 'do NOT use `customers matching`' make it more likely to use `customers matching`?"** It can — the model attends to the salient token, so a negative constraint re-introduces the forbidden thing into context every call. The honest answer names the risk and the mitigation: `diagnostic.md` L33 pairs the ban with the positive alternative ("Segment with `by <attribute>` instead") in the same breath, so the model has somewhere to go. A bare "don't do X" with no "do Y instead" is the trap.

### One-line anchors

- `monitoring.md` L11 — "do NOT re-run variations": wasted-budget incident, paired with `maxToolCalls`.
- `monitoring.md` L31 — "Never report a change derived from an empty window": bogus-number incident.
- `diagnostic.md` L33 — "Do NOT use `customers matching`": unsupported-clause ban, paired with the positive alternative.
- `recommendation.md` L64 — "Do NOT include an `id` field": model-owned-identity bug (→ 02).
- `query.md` L36 + `route.ts` L135–L143 — prose but one-shot: why rotation is correctly absent.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the two halves of the concept: negative constraints (one generation) and rotating formulas (a sequence). State the condition under which rotation is needed (prose × same user × over time) and whether it holds anywhere in this codebase (it does not).

### Level 2 — Explain

Out loud: why is rotation correctly *absent* for the monitoring/diagnostic/recommendation chains even though they run repeatedly? Tie it to their JSON output (`monitoring.md` L50–L73) — structured output has no phrasing to converge, so sameness is the contract.

### Level 3 — Apply

Scenario: you are adding a daily prose digest for one merchant. Open `query.md` L36 (the one-shot prose precedent) and explain why the digest, unlike the query agent, *does* need rotation. Then list the two pieces you would add (forbidden openings + a rotating formula pool) and where they would live (a new `digest.md`).

### Level 4 — Defend

A reviewer says: "The agents generate text all day — add anti-repetition to all of them." Defend leaving the structured chains alone (JSON has no phrasing to converge) and the query agent alone (one-shot per question), and name the single feature — a recurring prose digest — that would actually require rotation.

### Quick check — code reference test

Name two forbidden ("do NOT" / "Never") instructions in the prompts and the bug each prevents. (Answer: `monitoring.md` L31 "Never report a change derived from an empty or zero window" — prevents bogus ±100% swings off an empty data tail; `recommendation.md` L64 "Do NOT include an `id` field" — prevents the model inventing identity the system assigns via `crypto.randomUUID()` after validation.)
