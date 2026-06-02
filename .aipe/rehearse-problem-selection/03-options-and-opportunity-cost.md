# 03 — Options and opportunity cost

The reviewer who asks "why this and not something else?" is
testing whether you actually had options. A problem-selection
brief that lists one option is a project plan, not a selection.
This chapter puts blooming insights up against four real
alternatives, with **do nothing** as the first one, and names
the opportunity cost of each.

The frame for all five options is the **same 7-day window**, the
**same builder** (one person, mid-pivot into AI engineering), and
the **same explicit goal** (a portfolio-and-rubric-credible
build). That keeps the comparison honest.

  ## The five options

```
  THE OPTION SPACE — five real ways to spend the week

  ┌─ option A: DO NOTHING ─────────────────────────────────────┐
  │  skip the hackathon entirely · invest the week elsewhere   │
  └────────────────────────────────────────────────────────────┘

  ┌─ option B: smaller frontend showcase project ──────────────┐
  │  a slick, polished, single-feature React/Next demo          │
  │  ("the kind Rein's already shipped seven times")            │
  └────────────────────────────────────────────────────────────┘

  ┌─ option C: a different hackathon track ────────────────────┐
  │  same hackathon, different track (e.g. content gen,         │
  │  customer personalization), simpler MCP surface             │
  └────────────────────────────────────────────────────────────┘

  ┌─ option D: solo AI side-project, no contest ───────────────┐
  │  a multi-agent build, but for a domain Rein cares about     │
  │  personally (notes, fitness, dev-tools), no deadline        │
  └────────────────────────────────────────────────────────────┘

  ┌─ option E: blooming insights (the choice that won) ────────┐
  │  multi-agent analyst on Bloomreach MCP, hackathon track 3   │
  └────────────────────────────────────────────────────────────┘
```

Each option is evaluated against four axes the reader actually
cares about:

```
  THE FOUR AXES (per me.md THE ARC + the rubric)

  1. PORTFOLIO SIGNAL   does this advance the AI-engineering pivot?
  2. CONTEST UPSIDE     is there a judged outcome with a defined rubric?
  3. RISK / FRAGILITY   what's the likelihood it ships / works in the demo?
  4. WHAT IT FORECLOSES the opportunity cost — what does it prevent?
```

  ## Option A — do nothing (the load-bearing baseline)

The first option in any honest selection. *Don't* spend the week
on this. Take the week back for something else, or for nothing.
This is the option every other option has to beat.

```
  axis             reading
  ─────────────    ────────────────────────────────────────
  portfolio        [0] no new artifact · IK curriculum and
                       existing portfolio still represent you
  contest upside   [0] no submission, no rubric, no judging
  risk             [LOW] no risk of a broken demo
  forecloses       [HIGH] forecloses the hackathon (it's a
                       fixed-window event, doesn't repeat
                       this year) and the AI-pivot artifact
```

**Why this is the right option to take seriously.** A common
failure mode is treating "ship something" as automatically better
than "ship nothing." It's not. A bad demo is worse than no demo.
A half-finished portfolio piece looks worse than no entry. The
honest question is "is the *expected value* of the build positive
given all the failure modes?" If the build was going to ship at
50% quality, do-nothing wins.

**Why it loses here.** Three reasons it loses, in order:

1. **The hackathon is non-recurring this year.** Loomi connect
   AI hackathon, June 2026 (`blooming-insights-spec.md` L37–L43).
   The window is fixed. Skipping means the option is gone, not
   deferred. That's a load-bearing fact — it changes the EV
   calculation.

2. **Rein is mid-pivot and needs the artifact.** The `me.md`
   "THE ARC" diagram is explicit: 7 years of frontend, now
   transitioning into AI engineering. The portfolio currently
   has the five system-design shapes (`me.md` table) but the
   AI-engineering work is concentrated in AdvntrCue (one RAG
   project). A second serious AI build broadens the portfolio
   from "shipped one AI thing" to "shipped two AI things on
   different shapes."

3. **The build is structurally completable in the window.** The
   audit (`.aipe/study-system-design/audit.md`) confirms the
   architecture is small enough that one person could ship it
   in a week — and the architecture choices (no DB, single
   tenant, demo-mode snapshot) are explicitly calibrated to that
   constraint. The risk wasn't "it won't ship." The risk was
   "it ships at 70%." Do-nothing only wins if the realistic
   landing was below ~50%.

**The opportunity cost of NOT doing nothing** — i.e. of choosing
to build anything at all in the window — is whatever Rein would
have done with that week. The honest framing: a week of IK
curriculum advancement, or a week of resting before interviews,
or a week of catching up on personal projects. Real costs. The
build had to be worth them.

  ## Option B — a polished frontend showcase

A different shape entirely: spend the week on a single-feature
React/Next demo with great visual polish. Something like a
sophisticated data-grid, an animation showcase, a design-system
build — the kind of project Rein has already shipped seven times
professionally.

```
  axis             reading
  ─────────────    ────────────────────────────────────────
  portfolio        [+] adds a polish artifact, but DOESN'T
                       advance the AI pivot — it reinforces
                       the "frontend specialist" identity
                       Rein is explicitly pivoting OUT of
  contest upside   [0] no contest unless picked into one
  risk             [LOW] frontend polish is Rein's home turf;
                       7 years of practice; very low risk
  forecloses       [HIGH] forecloses the contest entry;
                       forecloses the AI-pivot artifact;
                       forecloses the MCP-fluency signal
```

**Why this loses for THIS builder.** The portfolio already has
the frontend signal in volume. Another frontend polish project
is *additive*, not *load-bearing*. Rein doesn't need more
frontend evidence; she needs more AI-engineering evidence to
counterbalance the seven years of frontend that already
dominates the portfolio.

This option would be the right choice for a different builder —
someone newer to frontend, or someone where polish is the gap.
For this builder, it reinforces the wrong identity.

  ## Option C — a different hackathon track, simpler MCP

Same hackathon, different track. The Loomi Connect AI hackathon
likely had multiple tracks; track 3 (analytics agents) is the
hardest. Simpler tracks (content generation, personalization,
single-tool integrations) would have been easier to ship at
higher quality.

```
  axis             reading
  ─────────────    ────────────────────────────────────────
  portfolio        [+] still an AI-engineering artifact, but
                       a simpler one — less differentiation
                       in a portfolio review
  contest upside   [+] easier to ship at higher quality;
                       possibly higher chance of winning a
                       simpler track
  risk             [LOWER] less surface area, fewer moving parts,
                       fewer ways to break
  forecloses       [MEDIUM] forecloses the hardest-track signal;
                       forecloses the multi-agent architecture
                       (single-tool tracks don't justify it)
```

**Why this loses.** Two reasons:

1. **The rubric specifically rewards the hard track.** Criterion 4
   (execution quality) and criterion 5 (innovation) both bias
   toward depth. A single-tool MCP integration is easier to ship
   but harder to defend as innovative. Multi-agent orchestration
   on a fresh MCP surface is unusual enough to be a real
   differentiation claim.

2. **The harder track teaches Rein more.** Sub-section
   `04-agents-and-tool-use/` in `.aipe/study-ai-engineering/` is
   explicitly named as the richest area of the codebase — *agents-
   vs-chains, tool calling, ReAct, tool routing, memory, error
   recovery, capability gating*. A simpler track would not have
   exercised any of that. The portfolio value of the build comes
   *from* the architectural difficulty, not despite it.

The opportunity cost of choosing the hard track is real: higher
risk of incomplete shipping, longer hours, more failure modes.
The honest counter: the cuts in chapter 02 (no DB, no evals,
single tenant, demo mode default) are exactly what reduce that
risk to manageable.

  ## Option D — solo AI side-project, no contest

Build the same kind of multi-agent project, but for a personal-
domain problem (notes-on-fitness, dev-tools, code-review
assistant) on a self-defined timeline. No external deadline. No
external judging. Total creative control.

```
  axis             reading
  ─────────────    ────────────────────────────────────────
  portfolio        [+] adds an AI-engineering artifact, but
                       without external validation or rubric
                       to anchor the claim
  contest upside   [0] no contest
  risk             [MEDIUM] no deadline pressure means project
                       likely takes 4–8 weeks instead of 1,
                       higher risk of mid-build pivot or
                       scope creep that never resolves
  forecloses       [HIGH] forecloses the hackathon (non-
                       recurring); forecloses the third-party
                       validation; forecloses the MCP-on-a-
                       brand-new-surface claim
```

**Why this is the closest runner-up.** Genuinely. The personal-
domain version of this build would have been more fun, more
creatively controlled, and would have the same architectural
shape. Most of the lessons from blooming insights would transfer.

**Why it still loses.** Three reasons, in order:

1. **External validation matters in a portfolio review.** "Built
   a multi-agent system for a hackathon, here's the rubric it
   scored against" is a stronger claim than "built a multi-agent
   system for myself, here's what I think it's worth." A judged
   contest gives the work a third-party anchor that a side
   project cannot.

2. **No-deadline projects routinely fail to ship.** The 7-day
   contest deadline is *load-bearing for completion*. Side
   projects without a deadline tend to grow into 6-month
   half-finished things that never make it to the portfolio.
   The hackathon's hardness is partially what forces the
   completion.

3. **The MCP surface itself is the timely angle.** Bloomreach
   loomi connect went into alpha in 2026; building on it now is
   "early to a real protocol on a real platform." A side
   project on a personal domain doesn't carry that "first to
   the platform" signal.

The right call is to do *both*, sequentially. Hackathon first
(blooming insights, June 2026), then a personal-domain AI build
when the rest of the schedule allows. Chapter 04 names what
"success" looks like for blooming insights specifically.

  ## Option E — blooming insights (the choice that won)

The build that exists. Multi-agent analyst on Bloomreach MCP,
hackathon track 3, 7-day window, shipped on time.

```
  axis             reading
  ─────────────    ────────────────────────────────────────
  portfolio        [++] advances the AI pivot · adds multi-
                        agent + MCP fluency · second serious
                        AI artifact alongside AdvntrCue
  contest upside   [++] real rubric · real deadline · real
                        judging · all 5 criteria intentionally
                        addressed (blooming-insights-spec.md
                        L51–L59)
  risk             [MEDIUM] real risk on the alpha MCP surface;
                        mitigated by demo mode that replays a
                        committed snapshot
  forecloses       [REAL] forecloses the week · forecloses
                        anything else that would have used
                        the same 7 days
```

The case for this option, in one paragraph:

> The hackathon is non-recurring; the MCP surface is brand-new;
> the architecture is small enough to ship in a week; the build
> exercises exactly the AI-engineering primitives Rein is pivoting
> into; the rubric provides a defensible scoring frame; the cuts
> in chapter 02 make the demo reliable; and the portfolio gains
> an AI-engineering artifact with third-party validation. The
> opportunity cost is one week, and the realistic landing was
> >70% — which beat do-nothing's flat 0.

  ## The decision matrix — the five options side by side

The visual that holds the whole comparison.

```
  THE DECISION MATRIX

  option   portfolio   contest    risk         forecloses
  ─────    ─────────   ───────    ────         ──────────
  A NOTH   0           0          LOW          HIGH (hackathon
                                                gone, no artifact)
  B FE     +           0          LOW          HIGH (AI pivot
                                                + contest)
  C ALT    +           +          LOWER        MEDIUM (depth
                                                signal cut)
  D SOLO   +           0          MEDIUM       HIGH (contest
                                                gone, no anchor)
  E THIS   ++          ++         MEDIUM       REAL (the week
                                                is gone)

  the winner has the only ++ in both portfolio AND contest,
  with MEDIUM risk mitigated by the demo-mode cut (chapter 02).
```

  ## The opportunity cost no other option pays

Every option except A pays "the week." That's the same cost
across B/C/D/E. The *differentiating* costs are what each option
forecloses.

```
  WHAT EACH OPTION COSTS YOU IRREVERSIBLY

  A  loses: the hackathon window (non-recurring), the artifact
  B  loses: the AI-pivot signal, the contest, the MCP-fluency claim
  C  loses: the hard-track signal, the multi-agent depth
  D  loses: the contest, the third-party validation anchor
  E  loses: the week (recoverable) + the optionality to do A/B/C/D
            (also recoverable later, since none of those are
            time-locked the way the hackathon is)
```

Option E is the only one whose foreclosures are recoverable later.
A/B/C/D each foreclose at least one thing that doesn't come back.
That's the asymmetry that tips the call.

  ## What this chapter establishes

```
  → five real options were considered, including do-nothing
  → the same four axes were applied to each
  → do-nothing is the load-bearing baseline; named explicitly,
    not waved past
  → the closest runner-up is option D (solo AI side project);
    its loss case is narrow and named
  → option E wins on the only ++ in BOTH portfolio AND contest,
    with the highest-recoverable opportunity cost
```

The selection holds. Chapter 04 picks up the question of how
"success" is measured for a project shaped like this one — and
why some standard product-success metrics deliberately don't
apply.

Read chapter 04 next.
