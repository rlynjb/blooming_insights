# 02 — Scope cuts and non-goals

The honest test of a good problem brief is the **non-goals list**.
Anyone can list what they're building. The signal of someone who's
actually selected a problem is what they're *deliberately not*
building, and being able to defend each cut on the way out.

This chapter has two halves: the **smallest useful slice** that
shipped in 7 days, and the **scope cuts** that made that slice
shippable. Each cut is graded by *whether the cut is reversible* —
because the difference between a tactical cut and a load-bearing
omission is whether you could add the thing back without
rebuilding the architecture.

  ## The smallest useful slice — what actually shipped

The slice is the narrowest version of the product that lets you
demo all five rubric criteria. Anything not in this list was cut.

```
  THE SHIPPED SLICE — what makes the demo run end-to-end

  ┌─ surface 1: the feed (what changed) ────────────────────────┐
  │  → app/page.tsx                                              │
  │  → 10-category coverage grid, gated by workspace schema      │
  │  → 3–N anomaly cards (real EQL results, real % deltas)      │
  │  → status log streaming the monitoring agent's reasoning     │
  │  → demo/live toggle (localStorage, default demo)             │
  └─────────────────────────────────────────────────────────────┘

  ┌─ surface 2: investigate (why) ──────────────────────────────┐
  │  → app/investigate/[id]/page.tsx                             │
  │  → diagnostic agent runs LIVE, streaming reasoning + tools   │
  │  → evidence panel materializes on the right                  │
  │  → markdown export                                           │
  └─────────────────────────────────────────────────────────────┘

  ┌─ surface 3: recommend (what to do) ─────────────────────────┐
  │  → app/investigate/[id]/recommend/page.tsx                   │
  │  → recommendation agent with diagnosis handoff               │
  │  → 2–3 typed recommendations with expected impact            │
  └─────────────────────────────────────────────────────────────┘

  ┌─ the infra that holds it together ──────────────────────────┐
  │  → 5 single-purpose agents (monitoring / diagnostic /        │
  │    query / recommendation / intent) now thin wrappers over   │
  │    @aptkit/core@0.3.0 (post-hackathon migration);            │
  │    runAgentLoop preserved at lib/agents/base-legacy.ts       │
  │  → DataSource SEAM (lib/data-source/types.ts) with 2         │
  │    adapters: Bloomreach + Synthetic                          │
  │  → McpClient with cache + rate-limit spacing + retry         │
  │  → OAuth (PKCE + DCR) with encrypted cookie store            │
  │  → NDJSON streaming over ReadableStream                     │
  │  → schema-gated coverage (free filter before expensive scan) │
  │  → vitest test suite (221 tests, pure logic + agent fakes)   │
  └─────────────────────────────────────────────────────────────┘
```

[E] All of this is in the audit (`.aipe/study-system-design/audit.md`).
This is what the agent actually does, end to end, today.

  ### Why this slice and not a smaller one

A smaller slice — say, just the feed and the diagnostic agent —
would have missed the rubric. The hackathon explicitly judges
"understand → decide → recommend" as the agent workflow pattern
(`blooming-insights-spec.md` L62–L66). Cutting the recommendation
agent would have left the build hitting 4 of 5 rubric criteria
instead of 5.

A larger slice — adding eval harness, design-partner feedback,
multi-tenant — would have exceeded the 7-day window. None of
those things show up in the demo; they would have eaten time
from things that do.

```
  THE SLICE BOUNDARY — what makes it the minimum

  smaller        │ this slice              │ larger
  ───────────────┼─────────────────────────┼──────────────────
  miss criterion │ all 5 rubric criteria   │ time that doesn't
  3 (agent       │ demonstrably hit:       │ show up in 10
  behavior)      │  · target user named    │ minutes:
               or│  · MCP utilization deep │  · eval harness
  miss criterion │  · 4 agents coordinated │  · design partners
  5 (innovation: │  · execution quality    │  · multi-tenant
  the reasoning  │    (real auth, real     │  · permissions
  trace)         │     MCP, real tests)    │  · billing
               or│  · innovation (the      │
  miss the demo  │     reasoning trace)    │
  flow entirely  │                         │
```

The slice is calibrated to **exactly** the rubric plus the demo's
choreography. That's not coincidence — the build was reverse-
engineered from the rubric.

  ## The cuts — what was deliberately NOT built

Each cut is named, evidenced, and graded for reversibility. The
grade is one of three:

```
  GRADE LEGEND

  [TACTICAL]   reversible — adds in <1 week with current arch
  [STRUCTURAL] reversible — adds in 2–6 weeks, may need infra
  [LOAD-BEARING] not reversible without rebuilding the architecture
                 (and that's fine; it's a deliberate identity choice)
```

  ### Cut 1 — no database [LOAD-BEARING]

[E] `audit.md` storage section: 8 storage tiers, only 3 durable.
The system-of-record IS Bloomreach. No Postgres, no Redis, no
KV store.

```
  what's cut          → all derived data persistence
  what's preserved    → re-run the briefing to recover anything
  what this enables   → ship in 7 days, no schema design,
                         no migrations, no cache invalidation policy
  what this prevents  → "yesterday's anomalies", shared feeds,
                         audit trail, history queries
```

This is the deepest architectural commitment in the project. It's
not reversible because the *whole point of the architecture* is
that there's no database. Adding one isn't a feature — it's a
different product.

The cut is defensible because the rubric doesn't ask for any of
the prevented capabilities. A reviewer who says "what about
yesterday's anomalies?" is asking a real product question, but
not a hackathon-rubric question. Chapter 05 question 4 has the
answer that holds.

  ### Cut 2 — no evals [STRUCTURAL] — then BUILT, USED, RETIRED

[E] At the time of the hackathon (June 2026), this was a clean
cut: `.aipe/study-ai-engineering/00-overview.md` legend named
*"evals are the Case-B gap"* explicitly. No labeled ground
truth, no accuracy measurement, no regression suite.

**Post-hackathon, this cut got the most interesting arc of any
in the brief: it was unwound, exercised, then put back.** The
story is worth telling end-to-end because it's the strongest
"shipped engineering judgement under pressure" signal in the
codebase.

```
  THE PHASE 3 EVAL FLYWHEEL — built · used · retired

  ┌─ phase 2 (own MCP server over Olist e-commerce SQLite) ────┐
  │  built mcp-server-olist; added DataSource SEAM at           │
  │  lib/data-source/types.ts; ran agents over a substrate     │
  │  the project owned end-to-end                              │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ phase 3 (build the eval suite the cut named) ─────────────┐
  │  4-pillar suite:                                            │
  │   1. detection precision/recall on labeled anomalies        │
  │   2. diagnosis 5-criterion rubric (LLM-as-judge)            │
  │   3. recommendation 3-criterion rubric (LLM-as-judge)       │
  │   4. regression capture-and-score                           │
  │  judge calibration: 8/8 + 3/3 manual spot-check agreement  │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ what the flywheel actually surfaced (3 real bugs) ────────┐
  │  → BRL cents-vs-Reais unit-narration: recommendation judge  │
  │    caught at run 8 — R$131,965 implausible AOV              │
  │  → binary calibration in 29/30 diagnosis runs (the rubric   │
  │    judges scored 0 or 1, never the middle)                  │
  │  → conclusion instability at 30% regression baseline        │
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ phase 3 RETIRED with the Olist substrate (PR #8) ─────────┐
  │  62c24d7: cleaned up retired Olist references;              │
  │  eval/ deleted, mcp-server-olist/ deleted;                  │
  │  DataSource SEAM survived (still serves 2 adapters today:   │
  │   Bloomreach + Synthetic)                                   │
  └────────────────────────────────────────────────────────────┘
```

```
  what's cut TODAY    → systematic measurement of diagnosis
                        quality / recommendation quality
                        (same gap as June 2026 — but now with
                        receipts of having shipped it once)
  what's preserved    → vitest suite for the deterministic
                        infra (221 tests today, up from 169)
                        + the DataSource SEAM + the Synthetic
                        adapter as a deterministic substrate
                        the next eval round would score against
  what this enabled   → originally: ship in 7 days
                        post-hackathon: prove the gap was a
                        deliberate cut by closing it once and
                        choosing to re-open it (different signal
                        than "never built")
  what this prevents  → confident accuracy claims TODAY · but
                        not "I don't know how to build an eval
                        harness" — the build + retire arc is
                        the demonstration
```

**Why retire it.** The eval suite scored against Olist e-commerce
data through a project-owned MCP subprocess. When the Olist
substrate was removed (PR #8, commit 62c24d7), the suite had
nothing to score against — the eval/ directory was deleted in
the same cleanup. The receipts (the 3 bugs surfaced) live in the
git history and in the retired study artifacts; the substrate
that produced them does not.

This is the cut whose **future cost is now bounded by experience,
not by speculation**. Round 2 of the eval suite would score
against the Synthetic adapter — same agent contracts, same
NDJSON trace shape — and the build cost is ~5 hours not ~2 weeks
because the patterns are now known. Honestly defensible for the
current state because what's been demonstrated is judgement
(when to invest, when to retire), not absence of capability.

  ### Cut 3 — no write actions / no autonomy [LOAD-BEARING]

[E] `blooming-insights-spec.md` L26–L30 and L66: *"not a write-path
tool (read-only mcp; recommendations are suggestions, not
actions)"* and *"human review for any business-impacting action."*
`lib/mcp/tools.ts` enforces this: the tool whitelist is read-only
by construction.

```
  what's cut          → "apply this recommendation" button
                        that actually does anything
  what's preserved    → recommendations as suggestions, with
                        steps the user could follow manually
  what this enables   → no permission model · no audit trail ·
                        no rollback · no "the agent broke
                        production" failure mode
  what this prevents  → end-to-end automation of the workflow
                        the build optimises for partial automation of
```

Cutting writes is reversible *technically* (Bloomreach has write
tools), but structurally not — adding writes turns this from a
"transparent analyst" product into a "autonomous merchandiser"
product. Different trust model, different liability surface,
different judging axis. This is identity, not feature scope.

The cut is *also* a hackathon-rubric alignment move: the kit
specifies "human review for any business-impacting action"
(`blooming-insights-spec.md` L66). The cut is the rubric.

  ### Cut 4 — no multi-tenant [STRUCTURAL]

[E] `blooming-insights-spec.md` L31: *"not multi-tenant (single
workspace: wobbly-ukulele)."* The original audit.md Ceiling 1
documented a concurrent-user wipe bug: the in-memory `Map` in
`lib/state/insights.ts` was global per Vercel instance, so two
users on the same instance clobbered each other.

**That specific bug is RESOLVED.** `lib/state/insights.ts` is now
session-keyed (Map<sessionId, SessionFeed>); the concurrent-user
wipe no longer happens. The broader cut still stands —
workspace switcher, per-tenant authorization, tenant-isolated
rate-limit budgets — but the in-process state hazard is closed.

```
  what's cut          → "log in with your own Bloomreach workspace"
  what's preserved    → "demo against the sandbox workspace
                        the team set up for the hackathon"
  what this enables   → no auth UX work, no workspace switching,
                        no per-tenant rate-limit isolation,
                        no tenant-isolated state design
  what this prevents  → any path to a real product
                        any actual customer signing up
```

This cut is reversible (the `audit.md` names a ~30 LOC fix to
session-key the Map), but adding real multi-tenancy past that fix
is 2–6 weeks of work: workspace selector UI, per-tenant
authorization checks, tenant-isolated rate limit budgets, billing,
support escalations, etc.

The cut is defensible because the contest provides a single
workspace (`blooming-insights-spec.md` L73: *"data source: live
`wobbly-ukulele` sandbox workspace via mcp"*). Multi-tenant in
the demo would be solving a problem the contest didn't ask you
to solve.

  ### Cut 5 — no user research, no design-partner outreach [STRUCTURAL → DISCOVERY]

[I] The repo contains zero artifacts that would result from talking
to a merchant: no interview notes, no persona research, no
workflow recordings, no Hotjar / FullStory captures, no support-
ticket analysis, no waitlist signups. The persona at
`blooming-insights-spec.md` L55 ("merch leads, store operators")
was selected from the rubric, not from validated user pain.

```
  what's cut          → any direct merchant input on what to build
  what's preserved    → the spec's own framing of the problem
  what this enables   → ship in 7 days (you can't talk to enough
                        merchants in 7 days to change the spec)
  what this prevents  → defensibility on "is this what users want"
                        — see chapter 01 evidence vs inference split
```

This is the cut that's hardest to defend if a reviewer presses on
"would anyone actually use this." Chapter 05 question 1 names the
discovery work that would close the gap; don't pretend the gap
isn't there.

  ### Cut 6 — no observability / no production monitoring [TACTICAL]

[E] `audit.md` Top-3 fix list #2: *"add minimal phase-timing
observability — ~20 LOC, makes the next production incident
actually diagnosable."* No structured logs, no OpenTelemetry, no
phase timings. Not even `performance.now()` pairs around the
expensive stages.

```
  what's cut          → any production-grade monitoring
  what's preserved    → console.log in the agent loops · the
                        AgentEvent stream IS the trace, so for
                        debugging-the-agent-itself you can use
                        the same stream the UI consumes
  what this enables   → ship in 7 days without an
                        observability rabbit hole
  what this prevents  → diagnosing the first production incident
```

This is the cheapest cut to reverse — `audit.md` estimates ~20
LOC. It's not in the slice because the product is in "demo + dev
+ portfolio" mode, not "real users behind the wheel" mode.

  ## The cut hierarchy — what each cut buys

A different way to read this list: each cut buys you something
specific. Stack them and the architecture is the result.

```
  THE STACK OF CUTS — what each one bought

  ┌─ 7-day shippable product ────────────────────────────────┐
  │   buys: hackathon submission                              │
  │   pays: no time for the cuts below                        │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ no database ──────────────────────────────────────────▼─┐
  │   buys: no schema design, no migrations, no DB ops        │
  │   pays: no history, no shared feeds, no audit trail       │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ no evals ─────────────────────────────────────────────▼─┐
  │   buys: no need for labeled ground truth                  │
  │   pays: no defensible accuracy claims                     │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ read-only / no autonomy ──────────────────────────────▼─┐
  │   buys: no permissions, no audit, no rollback             │
  │   pays: partial-automation only                           │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ single tenant ────────────────────────────────────────▼─┐
  │   buys: no workspace switcher, no tenant isolation         │
  │   pays: no path to a real customer signing up             │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ no user research ─────────────────────────────────────▼─┐
  │   buys: no time waiting on availability/legal             │
  │   pays: the inferred-vs-evidenced gap in chapter 01       │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ no production observability ──────────────────────────▼─┐
  │   buys: no instrumentation rabbit hole                    │
  │   pays: first production incident is blind                │
  └──────────────────────────────────────────────────────────┘

   each cut compounds. take any one back and at least one
   other has to give. that compounding IS the architecture.
```

  ## The cuts that came back (or that the architecture quietly took back)

A separate section because these aren't "scope cuts" in the same
sense — they're cuts the original brief named that the codebase
has since either unwound deliberately or sidestepped through a
different architectural choice. Each one is a signal that the
brief is alive, not a tombstone.

```
  CUT REVISITS — what the brief said, what the code now does

  ┌─ cut 2 (no evals) ─────────────────────────────────────────┐
  │   ORIGINAL: deferred for time                                │
  │   PHASE 3:  built 4-pillar suite, calibrated judge,           │
  │             surfaced 3 real bugs (BRL unit-narration,         │
  │             binary calibration, conclusion instability)       │
  │   TODAY:    retired with the Olist substrate; receipts in    │
  │             git; would rebuild against Synthetic in ~5h      │
  └────────────────────────────────────────────────────────────┘

  ┌─ cut 4 (no multi-tenant) ──────────────────────────────────┐
  │   ORIGINAL: single workspace + global Map = concurrent      │
  │             user wipe bug                                    │
  │   TODAY:    Map<sessionId, SessionFeed> resolved the wipe;   │
  │             multi-tenant still cut, but state hazard closed │
  └────────────────────────────────────────────────────────────┘

  ┌─ "MCP-native by design" (chapter 01 exclusion) ────────────┐
  │   ORIGINAL: tool path = Bloomreach MCP only                 │
  │   TODAY:    DataSource SEAM (lib/data-source/types.ts)      │
  │             serves 2 adapters — Bloomreach + Synthetic.     │
  │             The "MCP-native" claim is narrower now: the     │
  │             agent contracts are MCP-shaped; the substrate   │
  │             is pluggable.                                   │
  └────────────────────────────────────────────────────────────┘

  ┌─ "built the agent loop from scratch" (implicit) ───────────┐
  │   ORIGINAL: hand-rolled runAgentLoop at lib/agents/base.ts  │
  │   TODAY:    5 active agents are thin wrappers over          │
  │             @aptkit/core@0.3.0; runAgentLoop preserved at   │
  │             lib/agents/base-legacy.ts. See chapter 03 for   │
  │             the option-revisit framing.                     │
  └────────────────────────────────────────────────────────────┘
```

This section exists because **a static problem brief is a
liability**. The brief that says "we cut X for time" and is
silent two months later when X has been built, used, and re-cut
loses a credibility moment it should have claimed.

  ## The non-goals list — say these out loud

Memorise this list. When a reviewer asks "did you consider X?"
the answer is "we deliberately scoped X out — here's why." Not
"we didn't get to X." Different answer; different signal.

```
  NON-GOALS — what blooming insights deliberately does NOT do

  → write data back to Bloomreach (read-only by construction)
  → run autonomously without human review
  → multi-tenant onboarding flow
  → durable storage of insights / history / yesterday's runs
  → share feeds / collaborate across teammates
  → evaluate diagnosis quality systematically TODAY
       (Phase 3 eval harness was built + retired with its
        Olist substrate; rebuild round 2 against Synthetic
        is named, not in the current slice)
  → measure recommendation outcome (no feedback loop on actions)
  → embedding-based RAG over historical data (live MCP only)
  → support workspaces outside Bloomreach (MCP-native by design)
  → expose a public API (one user, one workspace, one demo)
  → real-time alerting / push notifications
  → fine-tune any model (off-the-shelf Claude only)
```

Twelve non-goals. Each one is a real ask a reviewer might make.
Each one has a defensible reason it's out of scope. Naming them
*before* the reviewer does is the strongest move.

  ## What this chapter establishes

```
  → the shipped slice is calibrated to the rubric, not over-
    or under-built relative to it
  → six deliberate cuts shaped the architecture; each one is
    named with what it bought and what it cost
  → the cuts compound — the architecture is the consequence
    of stacking them, not a separate design choice
  → twelve non-goals are explicit; "we didn't get to X" is
    not the answer to any of them
  → four cuts have been revisited since June 2026 — evals
    (built/used/retired), wipe bug (resolved), MCP-native
    (broadened to a SEAM), own loop (migrated to AptKit);
    the brief is alive, not a tombstone
```

Read chapter 03 next — the options analysis, including "do
nothing" as a real option.

---
