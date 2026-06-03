# 05 — Skeptical reviewer questions

The chapter you keep open under pressure. Seven questions a
skeptical reviewer actually asks about problem selection — phrased
the way they'd phrase them, not the way they'd be polite about
them. For each: the **answer that holds**, the **answer that
loses**, and the **one-liner you say if you only have five
seconds**.

The reviewer is doing their job. The questions are sharp because
the right questions are sharp. Don't take them personally; the
goal is to have an answer ready that doesn't fold.

  ## How to use this chapter

```
  → read each question and try to answer it from memory FIRST
  → then read the "answer that holds" and check the gap
  → mark questions where you didn't have an answer ready — those
    are the ones to drill before the interview/demo/review
  → the "five-second" line is the safety net; the holding answer
    is what you actually want to say if you have 30–60 seconds
```

  ## Question 1 — "Where's your user research? Did you talk to any merchants?"

The first and hardest. Most reviewers ask this one. The dishonest
answer ("yes, we talked to several merchants") falls apart fast
because no notes, no recordings, no quotes exist. The honest
answer is stronger because it survives follow-up.

  ### The answer that holds

> No. Zero user research with merchants. This is a hackathon
> submission against a published rubric (Loomi Connect AI
> Hackathon, June 2026, Track 3), not a validated product. The
> persona in the spec — "merch leads, store operators without
> analysts" — was selected from the rubric's "problem relevance
> and clarity" criterion, not from interviews.
>
> What would close the gap, if this became a product investment,
> is **three measurable things**: (1) stopwatch on the current
> workflow with 5–10 real operators; (2) post-hoc agreement rate
> on each anomaly the agent surfaced ("would you have caught and
> acted on this"); (3) confidence delta in current dashboard-
> driven decisions on a 1–7 scale. None of that exists in the
> repo today, and the honest framing is that this is a
> contest-justified artifact, not a market-validated one.

  ### The answer that loses

> "Yes, we talked to several merchants and they all said this
> was a huge pain point." [followup: "great, can I see the
> notes?"] [you have no notes] [confidence collapses]

  ### Five-second version

> "Zero user research. This is a contest submission with a
> rubric-derived persona, not a validated product. The discovery
> work I'd do to validate is in the brief."

  ### Why this holds

Naming the gap is itself the strongest move. A reviewer
distinguishes between "didn't do the work and pretends they did"
(loses immediately) and "didn't do the work, knows exactly what
the work is, can name it precisely" (high signal — they could
do it). You're the second one.

  ## Question 2 — "Isn't this just a slicker dashboard? Why does it deserve an agent?"

This is the architectural skepticism. The reviewer is asking
whether the multi-agent design buys you anything a simple report
generator wouldn't.

  ### The answer that holds

> Three reasons agents earn their weight here, not one:
>
> **(1) The workspace doesn't have saved dashboards or funnels.**
> Every metric is computed ad-hoc with EQL through one MCP tool
> (`execute_analytics_eql`). There's nothing to *re-render* as
> a slicker dashboard. The agent's job is to *decide which EQL
> to write* — that's a synthesis task, not a rendering task.
>
> **(2) The diagnostic step is hypothesis-driven.** The agent
> forms hypotheses, runs queries to test each one, and concludes
> with evidence. A static dashboard can't form a hypothesis. A
> chatbot can talk about hypotheses but doesn't enforce the
> "test each one" discipline. Multi-agent orchestration — where
> the diagnostic agent has its own prompt + tool subset + output
> validator — is what makes the hypothesis-testing rigorous.
>
> **(3) The reasoning trace is the differentiator.** The named
> competitors in the spec (conjura, graas, owly) all produce
> black-box outputs. Showing the full agent reasoning — every
> tool call, every hypothesis, every piece of evidence — is the
> architectural reason this product is different from a slicker
> dashboard. The trace IS the trust-building move that a polished
> chart cannot make.

  ### The answer that loses

> "Because agents are cooler." [confidence collapses immediately]

  ### Five-second version

> "There are no saved dashboards in this workspace — every metric
> is ad-hoc EQL. The agent's job is deciding what to query.
> That's not a dashboard."

  ### Why this holds

It's grounded in a fact about the data layer (`.aipe/project/context.md`
L20: "no saved dashboards/funnels — every metric is computed
ad-hoc with EQL, so the agents decide what to query") that the
reviewer can verify, plus a substantive architectural reason
(hypothesis-driven diagnosis) that a dashboard can't replicate.

  ## Question 3 — "How do you know the agent's diagnoses are right?"

This is the eval question. It's the question with the weakest
answer — there's no eval harness. Don't pretend otherwise.

  ### The answer that holds

> I don't. There's no eval set, no labeled ground truth, no
> systematic accuracy measurement. The codebase's own AI-
> engineering audit (`study-ai-engineering/00-overview.md`)
> names this explicitly: "evals are the Case-B gap."
>
> What the build *does* substitute for an eval, deliberately,
> is **legibility**: the full reasoning trace, the citations to
> the exact EQL queries, the current-vs-prior numbers in the
> evidence panel, the hypotheses considered with their pass/fail
> verdicts. A judge or user can read the trace and form their
> own opinion on whether the diagnosis is right. That's not
> "the diagnoses are right" — that's "the diagnoses are
> *auditable*." Different claim.
>
> If this became a product, the first investment would be
> labeled ground truth: 50–200 anomalies the team independently
> agreed on (importance + action), then measure the agent's
> match rate against that set. ~2 weeks of work. Not done; not
> hidden — the starter version is already spec'd as the queue-
> head drill (`.aipe/drills/evals-observability-induce-eval-gap-
> build-min-eval-harness.md`): five files in `evals/` (goldset,
> rubric, runner, LLM-as-judge, agreement test), ~5 hours, and
> the eval substrate (NDJSON trace + deterministic replay) is
> already built — the harness is the keystone, and the keystone
> is the only stone missing (`.aipe/audit-refactor-eval-
> substrate/00-overview.md`).

  ### The answer that loses

> "Oh the agent's diagnoses are very accurate, I tested it
> myself." [followup: "what's the accuracy number?"] [you have
> no number] [confidence collapses]

  ### Five-second version

> "I don't have an eval set. The substitute is making the
> reasoning fully auditable — but that's auditability, not
> accuracy. If this went past the hackathon, evals are the
> first build."

  ### Why this holds

The codebase's own audit named this gap. Citing your own honest
self-audit (rather than hiding the gap until pressed) is a
strong move. The reframe — "auditability ≠ accuracy, but
auditability is itself valuable for a transparent-reasoning
product" — gives the reviewer a place to land that isn't
"caught lying."

  ## Question 4 — "What about yesterday's anomalies? Or sharing with my team? Or history?"

The product-shape question. A reviewer who's evaluating this as
a product (not a hackathon submission) reaches for the absent
durability fast.

  ### The answer that holds

> All three are intentionally outside the slice. The architecture
> has no database — state lives in in-memory `Map`s, an encrypted
> cookie, and committed demo JSON. That's a deliberate cut, not
> an oversight. The audit (`study-system-design/audit.md`) walks
> through it: 8 storage tiers, only 3 durable, and Bloomreach
> itself is the system of record.
>
> Each of those features — yesterday's anomalies, shared feeds,
> audit trail — requires durable storage for derived data. The
> smallest reversible add for any of them is Vercel KV keyed by
> `orgId` (~$5/month, ~200 LOC). That moves the architecture
> from "no durable storage" to "one durable cache" without
> becoming a database app. Postgres is correct only when
> relational features (history × users × shares with joins)
> actually exist.
>
> For a hackathon submission, none of those features are in the
> rubric. Adding any of them would have cost time that doesn't
> show up in the 10-minute demo.

  ### The answer that loses

> "Yeah, that's on the roadmap." [hand-waved; no concrete path]

  ### Five-second version

> "Cut deliberately. No DB by design. The smallest add for any
> of those features is Vercel KV — ~200 LOC, ~$5/month."

  ### Why this holds

You name the cut, name the reason, name the smallest reversible
fix with cost and LOC estimates. That's a designer thinking
about a tradeoff, not someone hand-waving.

  ## Question 5 — "Why this hackathon track and not a simpler one? Did you bite off too much?"

The risk question. A reviewer is testing whether the project
shipped at quality or shipped at panic.

  ### The answer that holds

> Track 3 (analytics agents) was the hardest of the tracks,
> and that's deliberate. Two reasons:
>
> **(1) The rubric rewards depth.** Criterion 4 (execution
> quality) and criterion 5 (innovation) both bias toward
> architectural depth, and a single-tool integration is easy
> to ship but hard to defend as innovative. Multi-agent
> orchestration on a brand-new MCP surface is unusual enough
> that the differentiation claim survives scrutiny.
>
> **(2) The harder track exercises more of the AI-engineering
> primitives I'm building fluency in.** The codebase's own AI-
> engineering audit names `04-agents-and-tool-use/` as the
> richest sub-section — agents-vs-chains, tool calling, ReAct,
> tool routing, memory, error recovery, capability gating. A
> simpler track wouldn't have exercised any of that.
>
> What I did to reduce the risk of shipping at panic: the
> architecture is calibrated to the 7-day window — no database,
> single tenant, demo mode default, read-only by construction.
> Each cut was deliberate, named in the brief, and bought
> shipping time. The demo runs in demo mode by default — instant,
> creds-free, same UI as live — so the presentation reliability
> doesn't depend on the alpha MCP server being healthy in the
> moment.

  ### The answer that loses

> "Yeah it was really hard but we got it done." [no signal that
> the difficulty was managed deliberately]

  ### Five-second version

> "Hardest track on purpose — depth is in the rubric and in my
> pivot. Cuts in the architecture were what reduced the risk."

  ### Why this holds

You're showing the reviewer that risk was a deliberate input,
not a surprise output. The cuts in chapter 02 are the evidence;
having them in your head ready to name is the signal.

  ## Question 6 — "What's the smallest validated slice? Where would you start over if you could?"

The maturity question. A reviewer is testing whether you can
distinguish "what shipped" from "what mattered" — and whether
you'd defend the shipped slice as the right one or admit you'd
have done it differently.

  ### The answer that holds

> The shipped slice and the slice I'd start over with are
> different. The shipped slice was calibrated to the rubric:
> feed + investigate + recommend, three surfaces, four agents,
> full reasoning trace. That was the right slice **for the
> contest**.
>
> If I were starting from scratch on the same problem as a
> product investment, the slice I'd lead with is **smaller**:
> the feed and the diagnostic agent only — no recommendation
> agent, no recommendation surface. The reason is the eval gap.
> The diagnostic agent's quality is testable against labeled
> anomaly→cause pairs. The recommendation agent's quality is
> testable only against outcome data (did the recommended
> action actually lift the metric), which requires running the
> recommendations and measuring — a much larger commitment.
>
> Starting smaller would let me build the eval harness for the
> diagnostic agent first, establish accuracy, *then* layer
> recommendations once the foundation is solid. The hackathon
> didn't allow that sequencing because the rubric explicitly
> grades the full "understand → decide → recommend" flow.
> Different shaped problem, different right slice.

  ### The answer that loses

> "I'd build it exactly the same way." [signals no reflection;
> or signals overconfidence]
>
> "I'd rebuild everything." [signals the existing build is
> wrong and you can't defend it]

  ### Five-second version

> "Shipped slice was right for the contest. Product slice would
> be smaller: feed + diagnostic only, no recommendations until
> evals exist."

  ### Why this holds

It distinguishes between optimisation for the contest vs
optimisation for a product — and shows you can think in both
modes. That's exactly the maturity signal a senior reviewer is
looking for.

  ## Question 7 — "Honestly, why did YOU build this?"

The personal-motivation question. A reviewer eventually asks
some version of this. The answer should be honest — overpolished
"impact statements" land badly here.

  ### The answer that holds

> Three honest reasons in order:
>
> **(1) I'm mid-pivot from frontend into AI engineering.** Seven
> years of frontend at FedEx, Amazon, CoreWeave is in the
> portfolio already. The AI-engineering side has one serious
> artifact (AdvntrCue) and needed a second. Multi-agent
> orchestration is a different shape from RAG, so this build
> broadens the portfolio from "shipped one AI thing" to "shipped
> two AI things on different architectural shapes."
>
> **(2) The contest provided a deadline and a rubric.** Side
> projects without a deadline routinely fail to ship — I'd have
> a 4-month half-finished side project instead of a 7-day
> completed contest entry. The deadline is load-bearing for
> completion, and the rubric is load-bearing for "did I build
> the right thing."
>
> **(3) MCP-on-Bloomreach was timely.** Loomi connect went into
> alpha in 2026; the hackathon exists because the surface is
> new. Building a serious agent on a fresh MCP surface is a
> portfolio-credible move that I couldn't have made two years
> ago — the protocols and the model capability weren't there.
>
> The honest framing is that this is a portfolio + contest
> artifact, not a startup. The 15 study books + 4 rehearse
> books in `.aipe/*` exist *because* this codebase exists —
> they're the second-order artifact, and they're as much of the
> output as the product itself.

  ### The answer that loses

> "I really care about helping merchants succeed." [hollow;
> no evidence of any specific merchant relationship]
>
> "I wanted to learn AI engineering." [true but undersells;
> there's a contest, a rubric, a deadline, a pivot — name them]

  ### Five-second version

> "AI-pivot artifact + contest deadline + brand-new MCP surface.
> Portfolio + contest, not startup."

  ### Why this holds

It's honest about the three real motivations and ordered by
weight. "I'm in a pivot, I needed an artifact, the contest had
a deadline that would force completion" is a respectable answer
that doesn't try to be more than it is.

  ## The dodge — what NOT to do under pressure

A reviewer pressing harder than expected can push you toward
two failure modes. Both are recoverable if you notice them:

```
  FAILURE MODE 1: invent
       you start fabricating numbers, users, or measurements
       to look stronger. one followup ("can I see the data?")
       and you're done.

  → THE FIX: stop. say "I don't have that — what I do have is
                       [the honest framing]." revisit chapter
                       01 evidence vs inference table in your
                       head.

  FAILURE MODE 2: collapse
       you concede every point and the conversation falls into
       "yeah, you're right, the whole thing is a problem."

  → THE FIX: stop. the build's case is real even when individual
                       questions land hard. return to the
                       verdict at the top of 00-overview:
                       contest-justified, not market-validated,
                       and that distinction is enough.
```

  ## The five-second cheat sheet

The seven holding lines, all on one page, for the morning of an
interview or demo Q&A.

```
  ┌─ Q1: where's your user research? ─────────────────────────┐
  │  → zero user research; contest-derived persona;            │
  │    discovery work named in the brief                       │
  ├─ Q2: isn't this just a slicker dashboard? ─────────────────┤
  │  → no saved dashboards in this workspace; every metric is  │
  │    ad-hoc EQL — agent's job is deciding what to query      │
  ├─ Q3: how do you know the diagnoses are right? ─────────────┤
  │  → no eval set; substitute is full auditability via the    │
  │    reasoning trace; evals are first build past hackathon   │
  ├─ Q4: what about yesterday's anomalies / sharing? ──────────┤
  │  → cut deliberately; no DB by design; smallest add is      │
  │    Vercel KV ~200 LOC, ~$5/month                          │
  ├─ Q5: did you bite off too much with the hard track? ───────┤
  │  → hardest track on purpose; rubric rewards depth; cuts   │
  │    in the architecture were the risk reduction             │
  ├─ Q6: where would you start over? ──────────────────────────┤
  │  → shipped slice right for contest; product slice would be │
  │    smaller (feed + diagnostic only, no recs until evals)   │
  ├─ Q7: honestly why did YOU build this? ─────────────────────┤
  │  → AI-pivot artifact + contest deadline + brand-new MCP    │
  │    surface; portfolio + contest, not startup               │
  └────────────────────────────────────────────────────────────┘
```

  ## What this chapter establishes

```
  → seven real skeptical-reviewer questions have answers ready
  → every answer is grounded in repo evidence or honest naming
    of the gap
  → for each: the holding answer, the failing answer, and the
    five-second version
  → the dodge patterns (invent / collapse) are named so you
    catch yourself in the room
  → the cheat sheet collects the seven one-liners on one page
```

The brief is done. Three reads of this chapter before any high-
stakes conversation is the recommended drill: the first to
absorb, the second to mark gaps, the third to say each holding
answer out loud and confirm it lands in spoken English. Words
on a page aren't words in the room.

See `00-overview.md` for the orientation, `01-problem-brief.md`
for the ten-question core, `02-scope-cuts-and-non-goals.md` for
the cut hierarchy, `03-options-and-opportunity-cost.md` for the
five-option decision matrix, and `04-success-metrics-and-
feedback-loop.md` for the two-layer success frame.

---
Updated: 2026-06-03 — Q3 "how do you know diagnoses are right" now names the queue-head eval drill (`.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md`) as the concrete first build, with the keystone-missing framing from `.aipe/audit-refactor-eval-substrate/00-overview.md`.
