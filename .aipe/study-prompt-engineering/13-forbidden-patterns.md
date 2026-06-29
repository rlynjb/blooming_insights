# Forbidden patterns and rotating formulas

**Industry standard** · the concept blooming hasn't needed yet

## Zoom out — where rotation would matter, and where it wouldn't

This concept covers what generative chains do to *avoid LLM repetition* — listing forbidden openings, enumerating rotating formulas, tracking what's been said before. blooming doesn't exercise this pattern today because no agent in this codebase is a generative chain run *repeatedly for the same user*. Each agent runs once per briefing or once per user click; the outputs are read once and persisted. The diagram below sketches what *would* trigger rotation and what doesn't.

```
  Zoom out — when rotation matters vs when it doesn't

  ┌─ what triggers rotation needs ──────────────────────────┐
  │   generative chains run repeatedly for the same user    │
  │   examples (outside this codebase):                      │
  │     - caption generator (per post, dozens per day)        │
  │     - daily summary email (one per user per day)          │
  │     - workout description (per workout, per user)         │
  │   without rotation: every output sounds the same         │
  └─────────────────────────────────────────────────────────┘

  ┌─ blooming's chains: rotation NOT needed ────────────────┐
  │   monitoring: structured anomaly array, once per briefing│
  │   diagnostic: structured diagnosis, once per anomaly     │
  │   recommendation: structured action set, once per diag   │
  │   query: prose answer, free-form per question            │
  │   intent: one-word label                                  │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in

LLMs converge on phrasings. Run the same chain ten times against ten different inputs and the outputs start to share opening sentences, hedging patterns, and stylistic tics — "It looks like...", "I noticed that...", "Based on the data...". For one-off outputs, this is invisible (the user sees one). For generative chains run repeatedly for the same user, it's the difference between a tool that feels fresh and a tool that feels like spam. The pattern: explicitly list forbidden openings, enumerate rotating formulas, track rotation history. This concept is curriculum target for blooming; it doesn't fire yet, and the file is honest about where it would land if a future feature triggered it.

## Structure pass

**Layers.** Two altitudes worth holding: the *single-output layer* (rotation doesn't matter — the user sees one thing) and the *repeated-output layer* (rotation matters — the user sees a stream).

**Axis traced — sameness perception.** Hold one question constant: *does the user see enough output from this chain to notice repetition?*

```
  Axis = does the user notice repetition?

  ┌─ one-off outputs (no rotation needed) ──────────────────┐
  │   anomaly impact strings    1 per anomaly per briefing  │
  │   diagnosis conclusions     1 per investigation         │
  │   recommendation titles     2-3 per recommendation run  │
  │   query answers              1 per question              │
  └─────────────────────────────────────────────────────────┘

  ┌─ repeated outputs (rotation needed) ────────────────────┐
  │   - not present in blooming today                        │
  │   - would be triggered by: a feature that auto-generates │
  │                            many outputs of the same shape│
  │                            for the same user over time    │
  └─────────────────────────────────────────────────────────┘
```

**Seams.** The "is this the same chain producing many outputs?" question is the seam. If the answer is no, the convergence-on-phrasing problem doesn't fire — the user sees one output and can't notice repetition. If the answer is yes, you need a mechanism (forbidden-openings list, rotation history, explicit "vary your opening" instruction) to break the convergence. blooming sits firmly on the "no" side today; this file exists to explain when and how it would move.

## How it works

### Move 1 — the pattern, as one picture

You know how a `Math.random()` always picks the same biased range if you don't track history? Same thing happens with LLM output: ten "creative" captions from the same prompt cluster around the same three opening words, because the model has a most-likely next token and gravitates toward it. The fix is to feed back what's been said before and ask the model to avoid it.

```
  Pattern — rotation with explicit history

  ┌─ static prompt ─────────────────────────────────────────┐
  │   "Generate a caption for this post."                    │
  │   → 10 captions, 8 start with "Just a"                   │
  │   → user notices on the 3rd one, dismisses the tool      │
  └─────────────────────────────────────────────────────────┘
                              │  add rotation
  ┌─ rotation-aware prompt ──▼──────────────────────────────┐
  │   "Generate a caption. Avoid these opening phrases       │
  │    (used in the last 10 captions): 'Just a', 'A quick',  │
  │    'Here's a'."                                          │
  │   → 10 captions, 10 different openings                   │
  │   → user perceives variety                               │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — what the mechanism looks like in practice

For a chain that needs rotation, the prompt has a rotation slot:

```
  Hypothetical caption chain with rotation (not in blooming)

  ## Avoid these openings
  The following opening phrases have been used recently.
  Choose a different opening for this caption:
  {recent_openings}

  ## Format
  - Use a different opening style than any in the avoid list
  - Vary tone: declarative, question, observation, action
  - 8-12 words

  ## The post
  {post_content}
```

The `{recent_openings}` slot is filled at request time from a rotation history (last N captions, extract first 2-3 words, deduplicate). The `## Format` section enumerates the rotation formulas — explicit categories the chain rotates through. The model sees both the avoid-list and the variety target.

The state cost of this pattern: somewhere has to remember the last N outputs. Typically that's a small JSON blob per user, updated after each call. blooming doesn't have user-scoped state of this kind today (the demo snapshots are workspace-scoped; the investigation cache is per-briefing); a rotation-needing feature would add it.

### Move 2 — why blooming's chains don't trigger this

Walk each agent and ask "does the user see enough output to notice repetition?":

**Monitoring.** Each briefing produces 0-10 anomalies. The `impact` field is one sentence per anomaly. A user runs at most a few briefings per day; within one briefing, the anomalies are different metrics (revenue drop, conversion drop, traffic spike), so the prose naturally varies. Across briefings, same workspace, same handful of metrics — there *is* some risk of repetition over weeks. Not today's problem.

**Diagnostic.** One diagnosis per investigation. A user clicks at most a few times per day. The `conclusion` field is one paragraph; the user reads it once. No rotation needed.

**Recommendation.** 2-3 recommendations per investigation. The `title` and `rationale` fields could converge across runs (every recommendation for an email-flow problem might start with "Send a follow-up to..."). Mild risk over time; not visible at current usage.

**Query.** Free-form prose per question. Each question is different; the answer shape depends on the question. No repetition pressure.

**Intent.** One-word output. No prose; rotation doesn't apply.

The honest summary: today's usage doesn't trigger the convergence problem. The risk is real if usage grows (a power user running many briefings per week against a stable workspace) or if a new feature adds a generative chain that runs many times per user (a daily-digest email, a per-customer recommendation explainer). Either would be the moment to revisit this concept.

### Move 2 — what's structurally already there

Two pieces of the rotation pattern blooming has, even though full rotation isn't implemented:

**Structured output reduces convergence pressure.** Anomalies and diagnoses are mostly *fields*, not paragraphs. The repetition risk is concentrated in the few free-text fields (`impact`, `conclusion`, `rationale`, `title`). Most of each output is metric names, severity values, evidence arrays — domain-specific data that varies naturally with the input. The structured-output discipline (concept #2) does some of rotation's work for free.

**Per-agent prompts mean per-chain phrasing styles.** Because monitoring, diagnostic, and recommendation each have their own prompt, the *phrasing styles* across the three are different. The monitoring agent says "Revenue down 30% versus..."; the recommendation agent says "Send a recovery email to..."; the diagnostic agent says "Mobile checkout regression confirmed by...". The cross-agent variety happens for free. Within-agent convergence is the residual risk.

### Move 2 — when this would earn its place

Three triggers would make rotation worth building:

1. **A new generative feature.** Anything that auto-generates many outputs per user over time — a daily summary, a per-customer write-up, a per-event narrative. Add the rotation mechanism in the prompt at the same time you add the feature; don't ship without it.

2. **User reports.** If a user says "all the recommendations sound the same" or "the impact text feels repetitive," that's the production signal. The fix at that point: add a rotation history to the user's session, pipe the last N `impact` strings into the monitoring prompt, ask the model to vary.

3. **Eval signal.** Once concept #5 (eval-driven iteration) is in place, a "diversity" check across a set of runs would catch convergence before users do. ("Across these 20 monitoring runs, how many distinct opening phrases did the impact field use?") This is the production version of self-eval; it would catch rotation drift the same way an eval suite catches behavior drift.

### Move 2 — the cousin pattern: "vary your tone" instructions

A weaker version of rotation that earns its place sometimes: an explicit "vary your opening / vary your tone / vary your phrasing" instruction in the prompt, with no history slot. The instruction is a soft constraint; the model still has a preferred next token, but explicit variety instructions nudge it toward less common openings.

Cost: a sentence in the prompt. Benefit: about half of full-rotation's effect, without the state. For features where you want some variety but don't want to track history, the soft instruction is the right starting point.

blooming's monitoring prompt has one line that gestures in this direction:

```
  // monitoring.md:93 (from the field rules)
  - `impact` — ... Do NOT just restate the percentage.
```

The "do not just restate the percentage" is a *forbidden-pattern* instruction — telling the model what NOT to do, which constrains output away from the convergent boring case. Not full rotation, but the same family.

### Move 3 — the principle

Rotating formulas and forbidden-patterns lists are the response to a specific problem: LLM convergence on phrasing in generative chains run repeatedly. The pattern earns its place when usage produces enough output of the same shape for the user to notice repetition. blooming's chains don't hit that threshold today; the concept stays on the curriculum target list for when a future feature triggers it. The lighter-weight versions (structured output, per-agent prompts, soft "vary" instructions, forbidden-pattern callouts in field rules) catch most of the risk in this codebase.

## Primary diagram

```
  Forbidden patterns / rotation — where the pattern lives, why blooming
  doesn't yet exercise the full version

  ┌─ THE FULL ROTATION PATTERN (not in blooming today) ───────────┐
  │                                                                 │
  │  ┌─ rotation history (state, per user) ──────────────────┐    │
  │  │   recent_outputs[] = last N outputs from this chain   │    │
  │  └────────────────────────┬────────────────────────────┘    │
  │                           │                                   │
  │  ┌─ prompt with avoid-list ▼───────────────────────────┐     │
  │  │   "Avoid these openings: {recent_openings}"         │     │
  │  │   "Vary tone: declarative / question / observation" │     │
  │  └────────────────────────┬────────────────────────────┘     │
  │                           │                                   │
  │  ┌─ output ────────────────▼───────────────────────────┐     │
  │  │   model produces output that avoids the avoid-list  │     │
  │  └────────────────────────┬────────────────────────────┘     │
  │                           │                                   │
  │  ┌─ history update ────────▼───────────────────────────┐     │
  │  │   recent_outputs.push(new_output) (cap at N)        │     │
  │  └─────────────────────────────────────────────────────┘     │
  └────────────────────────────────────────────────────────────────┘

  ┌─ WHAT BLOOMING HAS TODAY (lighter-weight) ─────────────────────┐
  │  - structured outputs ↓ convergence pressure (most fields vary  │
  │    naturally with input data)                                   │
  │  - per-agent prompts → distinct phrasing styles across agents    │
  │  - one explicit forbidden-pattern callout:                       │
  │      monitoring.md:93 "Do NOT just restate the percentage."      │
  │  - no rotation history · no avoid-list slot · no diversity eval │
  └────────────────────────────────────────────────────────────────┘

  ┌─ WHEN BLOOMING WOULD ADD THE FULL PATTERN ─────────────────────┐
  │  trigger 1: a new generative chain run many times per user      │
  │             (e.g. daily digest, per-customer narrative)         │
  │  trigger 2: user reports "everything sounds the same"            │
  │  trigger 3: eval (concept #5) measures and flags low diversity   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason this concept is in the curriculum even though blooming doesn't exercise it: every working AI engineer ships a generative chain that converges eventually. The Twitter-thread-generator with "Here are 5 things you should know about..." 50 times in a row. The product-description writer that opens every description with "Discover the...". The workout planner where every Monday's intro paragraph reads like every other Monday's. The pattern is *predictable*; the fix is well-known; the time to learn it is before you ship something that needs it.

The loopd project the reader has shipped is the kind of system where rotation matters in practice — captions, summaries, narratives generated repeatedly for the same user. blooming sits in the "analytics + decisions" half of LLM application work, where the output volume per user is naturally low; loopd sits in the "content generation" half, where output volume is high and rotation is load-bearing. The same engineer will work in both halves of the field over time; knowing the rotation pattern is part of the toolkit even when the current project doesn't need it.

The "soft constraint" version (explicit "vary your tone" instruction with no history) is underrated. It costs a sentence in the prompt and gets you about half the benefit of full rotation. For features where state management is awkward and the convergence problem is mild, soft constraints are the right first move. Full rotation is the second move, reserved for features where the convergence is undeniable in production.

The forbidden-pattern callout in monitoring.md (`Do NOT just restate the percentage`) is interesting as a single data point — it's the working AI engineer's instinct showing up in a small place. The author of that prompt knew the model would default to "Revenue is down 30%" for a 30% revenue drop, and explicitly told it not to. That's the same instinct that, scaled up, becomes a full forbidden-openings list in a content-generation system. The instinct is right; the scale of the constraint depends on the scale of the convergence problem.

Anthropic's prompt engineering guide and Simon Willison's writing both touch on this — the "model converges on the most likely sequence" problem and the "explicit variation instruction" fix. The eugeneyan.com blog has a longer treatment connected to evals (you can measure diversity, you can iterate against it). The literature is well-developed; the production-frequency of this pattern is just lower than for the other concepts in this guide.

## Interview defense

**Q: Why isn't this pattern in blooming, and when would you add it?**

A: It isn't in blooming because no chain in this codebase is run *many times for the same user with the same shape*. Monitoring produces one anomaly array per briefing; diagnostic produces one diagnosis per click; the user sees a handful of outputs per session, not a stream of dozens. The convergence-on-phrasing problem only becomes visible when the user is reading the 5th, 10th, 20th output and notices "everything sounds the same." blooming's current usage doesn't hit that volume; the structured-output discipline does the rest of rotation's work for free (most of an anomaly is metric name + severity + numbers, which vary with input; only the `impact` and `conclusion` free-text fields would converge). When *would* I add it? Three triggers: a new feature that auto-generates many same-shape outputs (a daily digest, a per-customer narrative), a user complaint that "the outputs feel repetitive," or an eval signal (once evals are in place) measuring low diversity across runs. The fix at any of those moments is the same — add a rotation history to user-scoped state, pipe the last N outputs into the prompt as an avoid-list, optionally add explicit "vary your tone" instructions. It's a one-day change when triggered; it's wrong to build pre-emptively because rotation state is just another thing to maintain.

```
  what I'd sketch:

  current blooming:                     when to add rotation:
  ─────────────────                     ─────────────────────
  small output volume per user          new feature: many same-
  diverse inputs                         shape outputs per user
  structured fields dominate             repetitive prose noticed
                                         in production
                                         eval shows low diversity

  → don't build it pre-emptively · do recognize the signals
    when they show up · 1-day implementation when needed.
```

**Q: What's the lighter-weight version of this pattern that's worth using even before full rotation?**

A: Two moves earn their place even without full rotation infrastructure. **First**, forbidden-pattern callouts in the prompt's field rules — like the line in `monitoring.md:93` that says "Do NOT just restate the percentage" for the `impact` field. That's a one-sentence constraint that pushes the model away from the most convergent boring case. Costs nothing; pays off every call. **Second**, explicit "vary your tone / vary your opening" instructions as a soft constraint — no history needed, just a line in the prompt asking for variety. Gets you about half of full rotation's benefit at zero state-management cost. Together those two moves cover most of the convergence risk for chains that aren't yet at the scale where full rotation earns its place. blooming has the first (one explicit forbidden pattern) and doesn't have the second (no "vary" instructions); adding the second to the recommendation agent's `title` and `rationale` fields would be the right move whenever someone notices repetition there.

```
  three tiers of rotation discipline:

  tier 0 (free):    forbidden-pattern callouts in field rules
                    "Do NOT just restate the percentage"
                    ← blooming has one of these

  tier 1 (cheap):   "vary your tone / opening / phrasing"
                    ← stateless, ~30 tokens per call
                    ← worth adding to recommendation agent

  tier 2 (full):    rotation history + avoid-list slot
                    ← needs per-user state
                    ← add when a generative chain runs
                       repeatedly for the same user
```

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — structured outputs reduce convergence pressure for free
- [06-single-purpose-chains.md](./06-single-purpose-chains.md) — per-agent prompts mean cross-agent phrasing varies naturally
- [05-eval-driven-iteration.md](./05-eval-driven-iteration.md) — eval would catch convergence drift the way it would catch behavior drift
- [11-meta-prompting.md](./11-meta-prompting.md) — the rotation history would be another code-generated slot, same family as `{categories}`
