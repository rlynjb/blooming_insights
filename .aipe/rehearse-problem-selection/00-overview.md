# 00 — Overview · the problem-selection brief

You're walking into a room — a judge, a hiring panel, a skeptical
peer — and the first question is going to be a version of this:
**"why did you build this?"** Not "how does it work" (that's the
defense book). Not "show me the demo" (that's the hackathon
book). The question underneath both: *why does this problem
deserve the week of your life you spent on it.*

This brief is the answer. Five chapters, each a load-bearing piece
of the case. Read them once front to back to know the argument,
then keep chapter 05 open under pressure — that's where the
skeptical-reviewer questions live with the answers that hold.

  ## What this brief is — and what it is not

It is a problem-selection artifact: ten questions answered against
the actual repo. **User pain, evidence, why now, beneficiaries,
constraints, options including do-nothing, smallest validated
slice, non-goals, success metrics, risks.**

It is *not* a pitch deck. It is not a market-sizing exercise. It
is not a justification of the choices inside the build (that's
the design doc) or a defense of the architecture under pressure
(that's the interview-defense book). It is the layer **before**
solution design — the layer that says "this problem is worth
solving, here's the case, here's what we deliberately won't do."

```
  WHERE THIS BRIEF SITS

  ┌─ rehearse-problem-selection ────────────────────┐
  │  WHY this problem deserves investment   ★ here ★ │
  └────────────────────┬────────────────────────────┘
                       │  once the WHY holds
                       ▼
  ┌─ rehearse-design-doc ───────────────────────────┐
  │  HOW the significant technical decisions land    │
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ rehearse-hackathon-demo ───────────────────────┐
  │  HOW the resulting value is shown in 10 min      │
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ rehearse-interview-defense ────────────────────┐
  │  HOW the work is defended under scrutiny         │
  └─────────────────────────────────────────────────┘
```

If the WHY doesn't hold, the next three books are decoration on a
problem nobody asked for.

  ## The verdict up front

**The problem is contest-justified, not market-validated.** That
distinction is the whole frame. Read it twice.

Blooming insights was built for the **Loomi Connect AI Hackathon
(June 2026, Track 3 — Analytics Agents & Decision Intelligence)**.
The submission deadline was June 2, 2026 (`blooming-insights-spec.md` L37–L45).
The "user" is not a paying merchant; the user is a **hackathon
judge scoring against a 5-criterion rubric** plus, downstream, **a
hiring panel evaluating the portfolio**. The problem statement
("merchants drown in dashboards, decisions get made on gut")
appears in the project context (`.aipe/project/context.md` L9–L17)
as a framing claim — **not as validated user research**.

That doesn't make the project unjustified. It makes the
*justification different* than a startup founder's would be. The
case for the build is:

```
  1. a real hackathon track existed with a real rubric
     → the build hits all 5 criteria intentionally
  2. the MCP server it depends on is a real, brand-new
     surface (Bloomreach loomi connect alpha)
     → "first to demo a serious agent on this" is a
       legible portfolio claim
  3. the "transparent reasoning trace as UI" angle is
     a genuine differentiator vs the named competitors
     (conjura, graas, owly — all black-box outputs)
  4. the build exercises the AI-engineering pivot Rein
     is in — agent loops, MCP, structured-output
     validation, streaming — in one coherent shape
```

Four reasons to spend the week. None of them are "we validated
the merchant pain." Stating that honestly is the strongest move —
overclaiming validated user pain is the fastest way to lose the
room.

  ## The 1-line problem statement (the version that holds)

```
  ┃ "ecommerce merchants on Bloomreach already have the data
  ┃  to know what changed and why — but the answers are
  ┃  scattered across dashboards, EQL editors, and tribal
  ┃  knowledge; an agent that reads the workspace and shows
  ┃  its reasoning end-to-end is a credible solution shape
  ┃  for a hackathon judging that exact capability."
```

Two halves. The first half is the inferred user problem. The
second half — **"a credible solution shape for a hackathon judging
that exact capability"** — is the part that's actually evidenced
by the work. Lead with the honest framing; let the first half
ride on the second's coattails, not the other way around.

  ## The chapters — what each one carries

```
  01  PROBLEM BRIEF
      who has the pain · what's evidence vs inference · why now ·
      beneficiaries and exclusions · the constraints visible
      from the repo

  02  SCOPE CUTS AND NON-GOALS
      the smallest useful slice · what NOT to build · the cuts
      that made the build shippable in the hackathon window

  03  OPTIONS AND OPPORTUNITY COST
      five real options including DO NOTHING · what each buys
      and what each costs · why this option won

  04  SUCCESS METRICS AND FEEDBACK LOOP
      observable outcomes for a hackathon-shaped project ·
      the rubric as the feedback loop · what "success" cannot
      mean here (and why)

  05  SKEPTICAL REVIEWER QUESTIONS
      the seven questions a senior reviewer asks · the answer
      that holds for each one · the dodge that does not
```

  ## How to read this brief

```
  pass 1   read chapters 01 → 05 in order              ~25 min
           hold the verdict above as the spine while you do

  pass 2   re-read 05 only — speak each answer out loud  ~10 min
           the answers must land in spoken English, not
           just on the page

  pass 3   morning of (interview / demo Q&A / review)    ~5 min
           skim chapter 05's first sentence of each answer
           those are your in-the-room one-liners
```

If you have time for only one pass, make it pass 2. Pass 1 builds
the case in your head; pass 2 is what you actually say.

  ## What this brief deliberately does not do

```
  → it does not invent users
       no fake personas, no "we talked to 17 merchants"
  → it does not invent metrics
       no NPS, no conversion lift, no "30% time saved"
  → it does not invent market evidence
       no TAM, no competitive teardown beyond what the spec names
  → it does not invent organizational constraints
       no fake stakeholders, no fake roadmap pressure
  → it does not pretend the problem is bigger than it is
       the hackathon framing is named; not buried
```

If a reviewer asks "where's your user research?" the honest
answer is in chapter 05 question 1: *we don't have any, this is
a contest submission, here's what would be required to validate
the problem if we wanted to take it past the hackathon.* The
discovery questions are real outputs of this brief, not failures
of it.

Read chapter 01 next.
