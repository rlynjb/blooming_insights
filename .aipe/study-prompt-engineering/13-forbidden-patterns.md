# 13 · Forbidden patterns and rotating formulas

**Forbidden openings / anti-repetition / rotating formulas — Industry standard (folk practice)**

## Zoom out, then zoom in

LLMs converge on phrasings. Every anomaly's `impact` field starts with "Revenue down X%." Every recommendation's `rationale` starts with "This targets the diagnosed cause by." Every diagnostic conclusion says "The most likely cause is." These convergences aren't neutral — they make outputs feel machine-generated, they signal "AI wrote this" to users, and for a product whose pitch is "an analyst that shows its work," that signal is a real UX cost. Forbidden patterns is the discipline of naming the phrasings the model should NOT use and enumerating rotating alternatives.

```
  Zoom out — where forbidden patterns sit

  ┌─ Generative chain runs many times per user ─────────────┐
  │  MonitoringAgent produces N anomalies per scan          │
  │  each has an `impact` sentence                          │
  │  → all N tend to sound the same                          │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ ★ FORBIDDEN PATTERN SEAM ★ ▼────────────────────────────┐
  │  the prompt names forbidden openings AND enumerates      │  ← we are here
  │  rotating alternatives                                    │
  │  → variance across N outputs increases                    │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Not applicable ───────▼─────────────────────────────────┐
  │  single-word classifiers (no repetition surface)         │
  │  structured outputs (schema-locked)                       │
  │  edge-case emissions (only rendered once per session)     │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** This concept applies specifically to **generative chains that run repeatedly for the same user** — captions, tag lines, summary blurbs, impact sentences. It does not apply to structured JSON emissions, single-shot classifiers, or edge-case templates. In this codebase, the `impact` field on monitoring anomalies and the `rationale` field on recommendations are the two surfaces where this discipline would earn tokens. Neither currently uses forbidden-pattern discipline — that's an honest gap; the prompts today rely on the model's natural variance across cases, and the eval doesn't score for phrasing variance. Adding forbidden patterns is a Tier 2 hardening for the specific case where a user reads multiple outputs from the same chain in a session.

## Structure pass

### Axes — the dimension we're tracing

**Does the same user read multiple outputs from this chain in one session?** If yes, phrasing convergence is a UX cost and forbidden patterns earn tokens. If no (single-shot classifier, structured JSON, edge-case template), phrasing convergence doesn't matter and the discipline is ceremony.

### Seams — where the discipline applies vs doesn't

Two seams:

- **Generative vs structured** — a free-text field (`impact`, `rationale`) has phrasing variance; a schema field (`bloomreachFeature: 'scenario'`) has enum variance. The discipline applies to the first, not the second.
- **One-shot vs repeated** — one output per session doesn't need rotation. Many outputs per session where the user reads them all in one view (feed of anomalies) does.

### Layered decomposition

"Does this chain need forbidden patterns?" — traced across altitudes:

```
  "Does this chain need forbidden patterns?" — three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the chain's job                          │  → classifier: no
  │        (what does it produce)                   │    generator: maybe
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: how often is it read together       │  → single output: no
      │                                              │    N in one view: yes
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: is the surface fixed or free-text│  → schema: no
          │                                          │    free-text: yes
          └────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You know how a good copywriter for a product page writes twelve headlines and picks the one that sounds least like a template? The LLM without discipline writes one headline shape and copies it twelve times. Forbidden patterns is the discipline of telling the model "these openings are off-limits; these alternatives rotate" — it doesn't eliminate the convergence, but it moves the convergence from one shape to several.

```
  Without vs with forbidden patterns

  without:                                with:

  impact 1: "Revenue down 30% versus…"    impact 1: "Revenue down 30% versus…"
  impact 2: "Revenue down 22% versus…"    impact 2: "A 22% slide in revenue over…"
  impact 3: "Revenue down 18% versus…"    impact 3: "Conversion dropped 18% —…"
  impact 4: "Revenue down 15% versus…"    impact 4: "The mobile channel lost…"

  4 outputs, 1 shape                      4 outputs, 4 shapes
  feels machine-generated                 feels considered
```

### Move 2 — the step-by-step walkthrough

**Step 1 — name the convergence.**

The first move is *seeing* the convergence, which is easy to miss in single-case testing. Run the monitoring chain 10 times on similar inputs; read all the outputs side-by-side. If every `impact` sentence starts with the same three words, that's convergence. If every `rationale` uses the same connector phrase ("This targets the diagnosed cause by..."), that's convergence.

This codebase doesn't have a specific instrumentation to catch phrasing convergence — the eval scores content quality (rubrics), not phrasing variance. Adding a "phrasing distinctiveness" dimension to a rubric is one way. A simpler way: `grep` the last 20 anomalies' `impact` fields for the top three most common opening bigrams. If one opening dominates, you have convergence.

```
  Detecting convergence — the simple check

  grep "^impact" recent-anomalies.json |
    awk '{print $1, $2}' |
    sort | uniq -c | sort -rn |
    head -3

  if one bigram > 50% of outputs → convergence
  fix: forbidden patterns for that bigram
```

**Step 2 — name the forbidden openings in the prompt.**

The pattern would look like this (not currently in this codebase's prompts):

```
The `impact` sentence must NOT start with:
- "Revenue down"
- "This is critical because"
- "The impact is"

Instead, rotate among these openings across anomalies:
- A [X%] [direction] in [metric] over the [window]…
- The [scope] channel [verb] $[Y] in [window]…
- [Metric] moved from [prior] to [current]…
- Behind this [X%] shift is…
- Over [window], [what happened]…
```

Two things worth noting. First, forbidden openings are *literal strings* — "Revenue down" specifically, not "sentences that start with metric names." The model reads literal exclusions better than abstract categories. Second, the rotation list is a set of *shape templates* with brackets for variable content, teaching the model both what shapes are allowed AND that variety is expected.

```
  Forbidden list + rotation list — the two-part discipline

  ┌── forbidden openings ─────────────────────────────────┐
  │  literal strings the model must not use                │
  │  "Revenue down", "This is critical because", …         │
  └───────────────────────────────────────────────────────┘

  ┌── rotation list ──────────────────────────────────────┐
  │  shape templates with brackets                         │
  │  "A [X%] [direction] in [metric] over the [window]…"  │
  │  model substitutes and rotates                         │
  └───────────────────────────────────────────────────────┘

  together: constrain what's out, teach what's allowed
```

**Step 3 — the case for skipping this discipline (which is what this codebase currently does).**

Not every generative chain earns the token cost of forbidden patterns. Reasons this codebase's prompts don't have them today:

- **User rarely reads multiple outputs from the same chain in one view.** The feed shows N anomalies but each has a distinct metric/scope, so the underlying content naturally varies. Convergence at the phrasing layer is masked by content variance.
- **The prompts are already token-heavy.** Adding 10 lines of forbidden openings + 8 lines of rotation shapes = ~500 tokens per chain × 3 chains = ~1500 tokens of overhead. That's real prompt-caching cost (see `04-token-budgeting.md`) for a UX gain the current eval doesn't measure.
- **The eval doesn't score phrasing variance.** Adding forbidden patterns without an eval that scores whether they earned tokens is shipping ceremony.

The honest answer is: this discipline lands when (a) users start reading many outputs from the same chain (the feed grows to 20+ anomalies), (b) a phrasing-variance eval dimension is added, and (c) the convergence is observed in real feed data. Until then, the natural variance from the anomaly-content diversity is enough.

**Step 4 — the specific chain in this codebase that would earn it first.**

The `RecommendationAgent` produces up to 3 recommendations per invocation. The user reads all three side-by-side. If all three have the same `rationale` opening ("This targets the diagnosed cause by..."), the effect is that the second and third recommendations feel like weaker versions of the first. Forbidden-pattern discipline applied to `rationale` would spread the openings across the three recommendations so each one reads distinctly.

The current recommendation prompt at `@aptkit/prompts/dist/src/recommendation.js` doesn't have this discipline, and the eval doesn't score for it. When the observation "all three recommendations sound the same" becomes a real user complaint, forbidden patterns on the `rationale` opening is the specific fix.

```
  The load-bearing case — three recommendations per output

  without forbidden patterns:              with forbidden patterns:

  rec 1: "This targets the diagnosed…"     rec 1: "Because the payment processor…"
  rec 2: "This targets the diagnosed…"     rec 2: "A/B testing the checkout flow…"
  rec 3: "This targets the diagnosed…"     rec 3: "Over the next two weeks…"

  side-by-side reads as one template       reads as three distinct proposals
```

**Step 5 — the interaction with structured output.**

Structured output chains (JSON emissions) do NOT need forbidden patterns for the *schema* — the schema is fixed. Where they might need it: for the free-text fields *inside* the structured output (the `rationale`, `title`, `impact` strings). This is the specific place the discipline applies within Blooming's shape.

```
  Structured output + forbidden patterns — where they intersect

  ┌── the schema ─────────────────────────────────────────┐
  │  { title: string, rationale: string, steps: string[],  │
  │    bloomreachFeature: enum, confidence: enum }         │
  └───────────────────────────────────────────────────────┘

  forbidden patterns apply to:
    → title (free text)
    → rationale (free text)
    → steps[i] (free text)

  forbidden patterns do NOT apply to:
    → bloomreachFeature (enum)
    → confidence (enum)
    → estimatedImpact.rangeUsd (numeric)
```

### Move 2 variant — the load-bearing skeleton

The kernel of forbidden patterns is three moves:

```
  name the forbidden opening (literal) + enumerate rotations (shape) + apply only where read together
```

What breaks if you skip each:

- **Skip "name the forbidden opening"** — the model doesn't know which openings to avoid. Convergence continues.
- **Skip "enumerate rotations"** — the model knows what to avoid but not what to reach for. Falls into the next-most-common convergence.
- **Skip "apply only where read together"** — the discipline lands on chains where nobody notices convergence (single outputs, structured-schema fields). Wasted tokens.

Hardening layered on top: rotation memory across a session (this recommendation used opening #2; the next one must not), varied literal exemplars in the rotation list, phrasing-variance eval dimension.

### Move 3 — the principle

**LLMs converge on phrasings; humans reading multiple outputs feel that convergence as "machine-written."** Forbidden patterns is the discipline of naming the specific phrasings to avoid and enumerating alternatives — but it earns tokens only when the user reads outputs together, and it costs tokens (prompt size, cache economics). Skip it for structured/single-output chains; adopt it when a user's session shows them ~3+ outputs from the same chain side-by-side.

## Primary diagram

```
  Forbidden patterns — the discipline (planned, not currently in this codebase)

  ┌── observation: convergence ─────────────────────────────┐
  │  three recommendations per output                        │
  │  all three start with "This targets the diagnosed…"      │
  │  user complaint: "they sound the same"                   │
  └────────────────────┬────────────────────────────────────┘
                       │
  ┌── prompt addition ─▼────────────────────────────────────┐
  │  ## Rationale field openings                            │
  │  Do NOT open the `rationale` with:                      │
  │  - "This targets the diagnosed cause by"                │
  │  - "This addresses the issue by"                        │
  │  - "By doing this, you"                                 │
  │                                                          │
  │  Rotate among these opening shapes across the 3 recs:   │
  │  - "Because [diagnosed cause] happens when [X]…"        │
  │  - "A/B testing [the specific change] against…"          │
  │  - "Over the next [window], [what to expect]…"          │
  │  - "The evidence shows [X], and [what to do]…"          │
  └────────────────────┬────────────────────────────────────┘
                       │
  ┌── eval verification ▼───────────────────────────────────┐
  │  add phrasing-variance dimension to rubric              │
  │  score: how many distinct openings across N outputs?     │
  │  regression if all N converge to one opening             │
  └─────────────────────────────────────────────────────────┘

  ┌── skip this discipline for: ────────────────────────────┐
  │  intent classifier   (one word)                          │
  │  structured schema fields (enum, numeric)                │
  │  edge-case templates (rendered once per session)         │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

Forbidden patterns is folk practice, not a canonical academic technique. The name comes from copywriting — where "forbidden openings" is a house-style discipline. The practice ported into prompt engineering around 2023 when teams building generative surfaces (Instagram caption chains, ecommerce product descriptions, LinkedIn post generators) noticed all their outputs sounded the same. The specific canonical reference: Instagram's caption feature had this exact problem in its 2023 launch. Every caption started with "Here's what I love about..." Fix: forbidden opening + rotation list.

The Anthropic prompt guide covers rotation discipline lightly. OpenAI's cookbook has an example around "vary the tone across outputs" that is essentially this discipline under a different name. It's not called "forbidden patterns" in either — this is one of the concept files where the industry name is imperfect and each team invents their own local term.

Two failure modes I've watched:

- **The "forbid everything" bug.** Someone adds 20 forbidden openings. The model runs out of allowed shapes and starts violating the forbidden list. Fix: 3-5 forbidden openings max, matched with 4-6 rotation shapes.
- **The "forbid the wrong thing" bug.** Team forbids `"Revenue down"` but the actual convergence is `"revenue down"` (lowercase). Model complies with the literal forbidden list and drifts to a different convergence. Fix: case-insensitive framing, or forbid the shape not the exact string ("do not open with the metric name").

Related concepts:
- **Few-shot** (`08-few-shot.md`) — the rotation list is a form of few-shot for allowed shapes.
- **Single-purpose chains** (`06-single-purpose-chains.md`) — the specific chains where this discipline applies.
- **Anatomy** (`01-anatomy.md`) — forbidden patterns sit in the rules section of the prompt.

## Interview defense

**Q: When does forbidden-pattern discipline earn its tokens?**

When the user reads multiple outputs from the same chain in one session and the outputs converge on phrasings. The recommendation agent in this codebase produces up to 3 recommendations per output, and the user reads them side-by-side. If all three `rationale` fields open the same way, the user reads that as "the AI produced three variations of one idea" instead of three distinct proposals. Forbidden patterns would name the convergent opening and enumerate rotation shapes. Doesn't earn tokens on classifiers, structured-schema fields (enum, numeric), or one-shot outputs where the user reads one at a time.

```
  Decision — forbidden patterns yes/no

  N outputs read side-by-side?
   ├── yes, free-text fields    → forbidden patterns worth it
   ├── yes, all enum/numeric    → skip (schema handles variety)
   └── no, one output per view  → skip (no convergence surface)
```

Anchor: the recommendation agent's 3-per-output shape at `@aptkit/prompts/dist/src/recommendation.js:52` ("Return ONLY a JSON array ... of at most 3 objects").

**Q: This codebase doesn't currently use forbidden patterns. Why not, and when would you add them?**

Not currently because (a) users see the feed of anomalies but each has distinct metric/scope, so content variance masks phrasing convergence; (b) the eval doesn't score phrasing variance, so adding forbidden patterns without a measurement is shipping ceremony; (c) prompt token cost is real — 15 lines of forbidden + rotation would add ~500 tokens per chain and impact cache economics. When would I add it: when a user complaint lands ("all three recommendations sound the same"), or when the eval adds a phrasing-variance dimension, or when the observation `grep` on recent outputs shows one opening bigram dominates >50% of emissions. It's a hardening for a specific UX problem, not a default discipline.

```
  Trigger conditions to add forbidden patterns

  user complaint about repetition       → add
  new eval dimension for phrasing var   → add
  grep shows one bigram > 50% of opens → add
  none of the above                     → don't add, ceremony
```

**Q: What's the load-bearing part people forget?**

The rotation list. Everyone remembers to name forbidden openings. Nobody remembers to *enumerate what to rotate through*. Model reads "don't start with X" and finds the next-most-common opening — which is now the new convergence. Rotation list gives it 4-6 shapes to spread across, and the spread is what makes outputs feel distinct. Every "we forbade repetition and the outputs still all sound the same" retro I've read had "no rotation list, just a forbidden list."

## See also

- `06-single-purpose-chains.md` — the chains where this discipline applies.
- `08-few-shot.md` — the rotation list is few-shot for allowed shapes.
- `01-anatomy.md` — forbidden patterns sit in the rules section.
