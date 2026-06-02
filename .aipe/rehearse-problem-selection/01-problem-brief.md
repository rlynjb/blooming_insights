# 01 — Problem brief

The first four questions of any problem-selection brief, answered
against what the repo actually establishes — and labelled clearly
where the answer is **evidence** vs **inference** vs **discovery
still required**.

  ## The legend you read this chapter with

```
  [E]  EVIDENCE       — grounded in repo files, commits, docs,
                        or named external constraints
  [I]  INFERENCE      — reasonable read of the shape of the work;
                        not directly proven by the repo
  [D]  DISCOVERY      — open question; would need real validation
                        before any further investment
```

Every claim in this chapter carries one of those three tags. The
honest framing of a contest submission is "lots of [E] about the
contest constraints, lots of [I] about the merchant pain, a few
critical [D]s that we'd answer before turning this into a
product."

  ## 1. Who experiences the pain — beneficiaries and exclusions

  ### Primary beneficiary (named in the spec)

The spec names a target user, but it names them as a *positioning
choice*, not as a researched audience.

```
  THE NAMED USER (blooming-insights-spec.md L55)

  ┌─────────────────────────────────────────────────────────────┐
  │  "merch leads, store operators without analysts"            │
  │                                                             │
  │  hackathon rubric criterion 1, 20%:                         │
  │  "problem relevance & clarity — named target user           │
  │   (merch leads, store operators without analysts).          │
  │   specific pain (hours of manual correlation).              │
  │   measurable value (30-second time-to-answer)."             │
  └─────────────────────────────────────────────────────────────┘
```

[E] The persona exists in the spec and in the project context
(`.aipe/project/context.md` L9–L17). It's a real, namable user
category.

[I] The pain claim — "hours of manual correlation, decisions
end up driven by gut" — is a reasonable read of how non-analyst
operators interact with workspace tools. It's also a standard
trope. The repo does not contain user interviews, support tickets,
churn analysis, or workflow recordings that prove this pain
exists at scale for *this* product's actual users.

[D] What would establish the pain: at least 5 conversations with
people who fit the persona, ideally on a real Bloomreach
workspace, ideally with a recording of the "I spotted something
weird; what do I do" workflow they currently run. None of that
exists in the repo. **Naming this gap is not optional** — see
chapter 05 question 1 for how to answer when a reviewer asks
"where's the user research."

  ### Secondary beneficiary — the real one for this build

The submission is to a contest. The judges and the hiring panel
are the actual beneficiaries the build was optimised for.

```
  THE REAL AUDIENCE THIS WAS BUILT FOR

  ┌── tier 1: contest judges ──────────────────────────────────┐
  │  Loomi Connect AI Hackathon, Track 3                       │
  │  5-criterion rubric (problem relevance, MCP utilization,   │
  │  agent behavior, execution quality, innovation) × 20% each │
  │  submission deadline: jun 2, 2026, 4:00 pm pst             │
  │  evidence: blooming-insights-spec.md L37–L59               │
  └────────────────────────────────────────────────────────────┘

  ┌── tier 2: hiring panels and reviewers ─────────────────────┐
  │  Rein is mid-pivot from frontend (7+ yrs) into AI eng;     │
  │  the build exists as a portfolio artifact too              │
  │  evidence: me.md "THE ARC" diagram + the existence of      │
  │  this whole .aipe/ rehearse-* book set                     │
  └────────────────────────────────────────────────────────────┘

  ┌── tier 3 (aspirational): actual merchants ─────────────────┐
  │  the spec names them — but no real merchant has touched    │
  │  this product, validated this product, or asked for this   │
  │  product. inferred audience.                                │
  └────────────────────────────────────────────────────────────┘
```

[E] Tier 1 is dead-real: a named hackathon, a published rubric,
a fixed deadline. The whole architecture aligns with hitting all
five criteria intentionally (`blooming-insights-spec.md` L51–L59).

[E] Tier 2 is real for Rein specifically: the `me.md` reader
profile names the AI-engineering pivot; the existence of
`.aipe/rehearse-interview-defense/` and this whole brief
indicates the build is being prepared for technical-defense
scrutiny. Portfolio audience is named, not inferred.

[I] Tier 3 is the *positioned* user but not the validated one.
This is the gap the rubric criterion 1 is asking you to close
with a story, not the gap user research has closed with data.

  ### Exclusions — who is intentionally outside scope

The spec names these directly. Restate them so the reviewer can't
push you into them.

```
  OUT-OF-SCOPE USERS

  → enterprise data teams with dedicated analysts
       (they already have the SQL+BI muscle this replaces)
  → marketers on platforms other than Bloomreach
       (the build is MCP-native; deliberately not portable)
  → ops/support roles who need transactional answers
       (it's a what-changed-and-why tool, not a customer-lookup)
  → operators wanting writes / autonomous action
       (read-only MCP by construction — see blooming-insights-spec.md L26–L30)
```

[E] All four are spec-stated or architecturally enforced. The
read-only constraint is the deepest one — the tool whitelist in
`lib/mcp/tools.ts` makes "agent takes action" structurally
impossible, not just unimplemented. That's a deliberate scope
cut, not a missing feature (see chapter 02).

  ## 2. Evidence and current cost — what the repo actually proves

This is the question every skeptical reviewer asks first. The
honest answer in three buckets:

  ### What the repo proves [E]

```
  ┌─ what is genuinely evidenced ─────────────────────────────────┐
  │                                                                │
  │  → the technical problem is real and solvable                 │
  │     `audit.md` documents 4 working agents, an MCP client      │
  │     with TTL cache + spacing + retry, NDJSON streaming, and   │
  │     a schema-gated coverage system that actually runs against │
  │     a real Bloomreach workspace. The agent finds anomalies    │
  │     in `demo-insights.json`. The reasoning trace renders.     │
  │     The product exists.                                       │
  │                                                                │
  │  → the contest provides legitimate cover for the investment   │
  │     `blooming-insights-spec.md` L37–L59 names the hackathon,  │
  │     the track, the rubric, the deadline. This is a real       │
  │     event with real criteria — not a manufactured pretext.    │
  │                                                                │
  │  → Bloomreach's MCP surface is brand-new (alpha)              │
  │     `blooming-insights-spec.md` L62 cites the alpha endpoint  │
  │     `https://loomi-mcp-alpha.bloomreach.com/mcp`. The         │
  │     hackathon exists because the surface is new. Building     │
  │     a serious agent on a fresh MCP surface is itself          │
  │     a portfolio-credible move.                                │
  │                                                                │
  │  → the product's "transparent reasoning" angle is genuinely   │
  │     different from the named competitors                       │
  │     `blooming-insights-spec.md` L14–L16 names conjura, graas, │
  │     owly as black-box analyst tools. The streaming reasoning  │
  │     trace (`audit.md` system-map) is the architectural        │
  │     differentiator and it's actually implemented, not         │
  │     marketed.                                                  │
  └────────────────────────────────────────────────────────────────┘
```

  ### What the repo does NOT prove [D]

```
  ┌─ what is NOT evidenced and would have to be discovered ───────┐
  │                                                                │
  │  → that any merchant wants this                               │
  │     no interviews, no waitlist, no design-partner pilots,     │
  │     no support-ticket analysis. zero customer-discovery       │
  │     artifacts in the repo.                                    │
  │                                                                │
  │  → that "30 seconds to answer" is a meaningful metric for     │
  │     anyone but the rubric                                     │
  │     `blooming-insights-spec.md` L55 cites "measurable value   │
  │     (30-second time-to-answer)" but there's no baseline       │
  │     measurement of how long the current workflow takes, no    │
  │     comparative study, no user-reported pain magnitude.       │
  │                                                                │
  │  → that the diagnoses are *good enough* to bet on             │
  │     there's no eval set, no labeled ground truth, no          │
  │     accuracy measurement. The agent finds anomalies it        │
  │     thinks are real; whether a merchant would agree they're   │
  │     real, important, or actionable is untested.               │
  │     (see `study-ai-engineering` 05-evals: "evals are the      │
  │     Case-B gap" — explicitly named in the codebase audit.)    │
  │                                                                │
  │  → that the recommendations are right                         │
  │     the recommendation agent maps anomalies to Bloomreach     │
  │     features (scenario / segment / campaign / voucher /       │
  │     experiment) — but whether any of those recommendations    │
  │     would survive a merchandiser's gut-check has not been     │
  │     evaluated.                                                │
  └────────────────────────────────────────────────────────────────┘
```

  ### Current cost without the build [I]

The spec's framing of current cost is plausible but unmeasured.
State it that way:

> [I] **The inferred current cost** is some number of analyst-hours
> per anomaly per week per workspace, with an unknown error rate
> from gut-driven decisions. The repo does not contain measurements
> of either. The hackathon rubric *treats this cost as established*
> for the purpose of judging; whether it survives contact with a
> real customer is the discovery question.

If a reviewer presses on cost numbers, **do not invent them**. Say
"the spec frames the pain in qualitative terms; we'd quantify it
with [3 measurable things] before pitching this as a product."
The 3 measurable things (write them in chapter 05 question 1):
**(1)** time-to-first-action on a real anomaly today (stopwatch
five merchants), **(2)** post-hoc agreement rate ("would you have
acted on this anomaly the way the agent suggested"), **(3)**
self-reported confidence in current dashboard-driven decisions
on a 1–7 scale (the gap is the size of the pain).

  ## 3. Why now — what changed, what cost compounds

This is the *only* question with strong evidence beyond the
"this is a contest" answer. Three real forces converged in
mid-2026; the build rides all three.

```
  THE THREE FORCES CONVERGING (mid-2026)

      MCP becomes
      a serious            agent loops with
      protocol             tool use become            Bloomreach
      (Anthropic)          a standard primitive       opens
           │                       │                  loomi connect
           │                       │                  MCP (alpha)
           │                       │                       │
           ▼                       ▼                       ▼
   ┌──────────────────────────────────────────────────────────┐
   │   may–jun 2026: the hackathon exists BECAUSE all three    │
   │   landed at once. blooming insights is one of the first   │
   │   serious agents built against the Bloomreach surface.    │
   └──────────────────────────────────────────────────────────┘
```

[E] All three forces are real and verifiable:

- **MCP as a protocol** — `package.json` L14 (`@modelcontextprotocol/sdk ^1.29.0`) confirms the SDK exists and is on a 1.x version. The protocol stabilised enough in 2025 for a serious build to depend on it.
- **Anthropic SDK with tool use** — `package.json` L13 (`@anthropic-ai/sdk ^0.99.0`) confirms a near-1.0 SDK with the tool-use loop the agents use.
- **Bloomreach loomi connect alpha** — `blooming-insights-spec.md` L62 names the alpha endpoint. The hackathon exists *because* the surface is new and the company wants ecosystem builds.

[I] The "why now" for the *merchant* is weaker. Merchants have
been drowning in dashboards for 15 years; that's not new. What's
new is the *solution shape* — MCP-native agents are credible in
mid-2026 in a way they were not in mid-2024. The reframe a
skeptical reviewer accepts: *"we couldn't have built this two
years ago — the protocols and the model capability weren't there."*

[E] The deadline-induced "why now" is concrete: the submission
window closes June 2, 2026, 4:00 pm pst. After that date, this
specific build's contest-judged claim expires. The portfolio
claim doesn't expire; the rubric-criterion claim does.

  ## 4. Constraints — what's visible from the repo

Five real constraints shaped the build. Each is evidence in the
repo, each shaped a non-trivial decision.

  ### Constraint 1 — time-boxed by the contest [E]

The hackathon window (`blooming-insights-spec.md` L41–L43) is the
hard ceiling. Build window opened May 26, 2026; submission deadline
June 2, 2026, 4:00 pm pst. That's ~7 calendar days for the full
build. Every architecture decision is downstream of this.

```
  the 7-day window forced:
  → no database (state in Maps + cookies + committed JSON)
  → no test against real customers (no time for discovery)
  → no eval harness (no time to build labeled ground truth)
  → no multi-tenant (single workspace: wobbly-ukulele)
  → no write-path actions (read-only by construction)
```

This constraint is *load-bearing*. Half the scope cuts in
chapter 02 exist because of it.

  ### Constraint 2 — Bloomreach rate limit and alpha quirks [E]

`audit.md` documents the constraint precisely: **~1 req/s/user
GLOBAL** to the MCP server, and the alpha server **revokes
tokens after minutes** (`.aipe/project/context.md` L88–L89).

```
  the rate limit forced:
  → McpClient with 1.1s spacing + TTL cache + retry
       (lib/mcp/client.ts)
  → schema-gated coverage so the agent never burns the budget
       on impossible categories (lib/agents/categories.ts)
  → demo mode that replays a committed snapshot for the live demo
       (because live mode is too fragile for a presentation)
```

This is an evidenced operational constraint, not a hypothetical
one. It shaped real code.

  ### Constraint 3 — Vercel function ceiling (300s) [E]

`audit.md` documents `maxDuration = 300` on every route. That's
the hard ceiling on how long any single agent run can take.
Typical run is ~70–120s (`audit.md` Ceiling 2); headroom shrinks
when Bloomreach is slow.

```
  the 300s ceiling forced:
  → bounded tool-call budget (maxToolCalls: 6)
  → forced-final synthesis turn so the agent always returns
       structured output even if it ran out of turns
  → NDJSON streaming so the user sees progress, not a 90s blank
```

  ### Constraint 4 — solo build, no team [I → E]

[I] The build's commit history (`git log --oneline -30`) shows
a single author thread. No PR reviews, no collaborator commits.
This is a solo project.

[E] The `me.md` reader profile names Rein as the single builder;
the system-design portfolio lists this project as her work
specifically.

```
  solo build constraint forced:
  → "do the thing one person can ship in a week"
  → no team-coordination overhead, but also no spare hands for
       eval design, design-partner outreach, infra work
  → portfolio-shape thinking (one engineer's signature)
       over product-shape thinking (a team's roadmap)
```

  ### Constraint 5 — the AI-pivot frame [E]

The whole build sits inside Rein's deliberate pivot from frontend
specialist into AI engineering (`me.md` "THE ARC" diagram). This
is an organizational constraint of a different kind: **the
selection of this problem is itself a career move**.

```
  the AI-pivot frame favored:
  → multi-agent orchestration (the AI-engineering signal)
  → MCP integration (the protocol-fluency signal)
  → streaming + structured outputs (the production-AI signal)
  over:
  → CRUD frontend work (already in the portfolio 7x)
  → pure-frontend showcase projects (not the pivot direction)
```

Naming this is honest. If a reviewer asks "why this and not a
different hackathon problem," the answer "this maximally signals
the pivot I'm in" is a strong, defensible answer.

  ## What this chapter establishes — and what it doesn't

```
  ESTABLISHED [E]                  NOT ESTABLISHED [I/D]
  ──────────────────────────────   ──────────────────────────
  → real hackathon, real rubric    → merchant pain at scale
  → real fresh MCP surface         → 30s time-to-answer as
  → genuine architectural diff       a real user metric
  → 5 real shaping constraints     → diagnosis accuracy
                                   → recommendation quality
                                   → willingness to pay
```

This is the honest base. Chapter 02 takes those constraints and
shows the scope cuts that fell out of them. Chapter 03 puts this
option up against four real alternatives, including doing nothing.

Read chapter 02 next.
