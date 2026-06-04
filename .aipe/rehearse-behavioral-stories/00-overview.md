# Overview — competency × company coverage matrix

> **Verdict first.** The bank holds the **failure-recovery** slot (non-negotiable at senior bar) and three other stories grounded in this repo. Six of the ten competencies are unfilled — not because the stories are weak, but because the career-history file has one real entry's worth of material. Treat this overview as the loop-prep checklist: open the matrix, see what lands at the company you're prepping for, lead with what's strongest, name the gaps honestly when probed.

---

## The matrix — competency × company × story

Rows: 10 competencies. Columns: Anthropic, Meta, Google, all. Cells: the story slug that covers that competency at that company, or `gap` if uncovered.

```
  competency                          Anthropic         Meta              Google            all (lead with)
  ────────────────────────────────    ──────────────    ──────────────    ──────────────    ───────────────
  1. scope-expansion                  gap               gap               gap               gap (career-history gap)
  2. ambiguity-navigation             gap               gap               gap               gap (career-history gap)
  3. peer-conflict-resolution         gap               gap               gap               gap (career-history gap)
  4. stakeholder-pushback             gap               gap               gap               gap (career-history gap)
  5. influence-without-authority      gap               gap               gap               gap (career-history gap)
  6. technical-judgment               02 (primary)      02 (primary)      02 (primary)      02
                                      04 (secondary)    04 (secondary)    04 (secondary)
  7. prioritization-and-saying-no     03                03 (primary)      03                03
  8. failure-recovery   ★             01                01                01 (primary)      01 ★
                                      04 (secondary)                      04 (secondary)
  9. impact-at-scale                  gap               gap               gap               gap (career-history gap)
  10. mission-alignment               gap               gap               gap               gap (career-history gap)
                                      (would land
                                       hardest here)
```

**Read the columns honestly:**

- **Anthropic** weighs mission-alignment most heavily (`rehearse-behavioral-stories.md` spec). The bank has NO mission-alignment story. The closest substitute is story `04` (the honest-naming-of-AI-eval-gap move) which signals safety-adjacent thinking — *measuring* AI output quality is the discipline that ships before "AI that's good." Use it, but name the gap if probed: "I haven't worked on a directly mission-driven role yet; the eval-discipline move is the closest signal I can show."

- **Meta** weighs technical-judgment + prioritization. Story `02` lands hardest here — anti-framework conviction, deterministic over LLM-supervised, named the rejected alternative. Story `03` is the prioritization secondary.

- **Google** weighs post-mortem discipline + technical depth. Story `01` lands hardest here — the AUTH_SECRET fix has the SRE-book template arc (detect → diagnose → fix → prevent → verify), with a fingerprint sentence ("isolated pass, parallel flake = shared mutable state") that's reusable beyond this incident. Story `02` is the technical-judgment chaser.

- **all loops** carry story `01` as the failure-recovery answer regardless of company. The senior bar will pull on "name a wrong call you owned" in every loop. Story `01` is the only one in the bank that survives that pull.

---

## The gaps — named honestly

Six of the ten competencies are **CAREER-HISTORY gaps, not story gaps.** The hackathon-week material that grounds the four real stories cannot produce these competencies — not because the bank is weak, but because hackathon-week scope structurally cannot produce them.

```
  competency                       why it's a career-history gap
  ────────────────────────────    ──────────────────────────────────────────────────────
  1. scope-expansion              hackathon scope is fixed by the sponsor track; expanding
                                  is "I shipped more features," not "I named a gap and owned
                                  the solution." Needs a full-time-role moment.

  2. ambiguity-navigation         solo entrant + sponsor-defined track = no real ambiguity.
                                  Needs an unclear-spec or conflicting-stakeholder moment.

  3. peer-conflict-resolution     solo project = no peers to conflict with. Needs a
                                  team-disagreement-resolved-into-decision moment.

  4. stakeholder-pushback         hackathon has judges, not stakeholders. Needs a PM /
                                  business / customer renegotiation moment.

  5. influence-without-authority  solo project = no one to influence. Needs a cross-team
                                  change or mentorship-outside-reporting-line moment.

  9. impact-at-scale              hackathon demo runs once on stage. Needs a "shipped to
                                  N users, measured Y% impact" moment from a prior role.

  10. mission-alignment           hackathon project chosen because of sponsor track, not
                                  mission. Anthropic weighs this most heavily; without it,
                                  the Anthropic-shaped story is missing. Needs a "I chose
                                  this work over alternatives because [mission reason]"
                                  moment, ideally safety/alignment-adjacent.
```

**The bank refuses to fabricate these.** Filling them with hackathon material would be either (a) inventing peer conflicts the project didn't have, (b) inflating "the judges asked a hard question" into stakeholder-pushback, or (c) calling "I cared about the project" mission-alignment. All three would collapse under a real interviewer's follow-up. The honest move is to name the gaps and grow the career-history file with real entries.

---

## Recommended rehearsal order — per loop

```
  Anthropic loop (4 rounds, behavioral on round 2-3)
  ──────────────────────────────────────────────────
  rep 1: story 01 cold (failure-recovery — Google asks it, Meta asks it, Anthropic asks it)
  rep 2: story 02 cold (technical-judgment — defends against "why not multi-agent?")
  rep 3: story 04 cold (honest gap-naming as mission-adjacent signal)
  rep 4: story 03 cold (prioritization-and-saying-no — chaser)
  prep:  rehearse the gap-naming sentence for mission-alignment: "I haven't worked on
         a directly mission-driven role yet. The closest signal I can show is the
         discipline of measuring AI output quality before claiming AI quality — which
         is story 04. I'm actively looking for a role where the mission is the
         load-bearing reason I'm there."
```

```
  Meta loop (4-5 rounds, behavioral on round 2-3)
  ──────────────────────────────────────────────────
  rep 1: story 02 cold (technical-judgment, anti-framework, deterministic-over-LLM)
  rep 2: story 03 cold (prioritization-and-saying-no, cutting Tier 2)
  rep 3: story 01 cold (failure-recovery — senior bar non-negotiable)
  rep 4: story 04 cold (technical-judgment secondary, what-I'd-do-differently)
  prep:  rehearse the gap-naming for peer-conflict + impact-at-scale (Meta will probe these
         on the senior loop): "I haven't worked in a multi-engineer codebase in the past
         year — the closest peer-conflict signal I have is [from prior frontend roles, to
         be added to career-history]. On impact-at-scale, my prior frontend work shipped
         to FedEx and Amazon customers at scale; the AI work in this portfolio hasn't
         been measured at scale yet."
```

```
  Google loop (5-6 rounds, behavioral spread across rounds)
  ──────────────────────────────────────────────────
  rep 1: story 01 cold (failure-recovery — Google bar loves the SRE-book post-mortem arc)
  rep 2: story 02 cold (technical-judgment — RFC quality + alternatives matrix is L4 signal)
  rep 3: story 04 cold (what-you'd-do-differently — eval harness in week one is the L5 move)
  rep 4: story 03 cold (prioritization)
  prep:  rehearse the gap-naming for impact-at-scale: "the hackathon material in this
         portfolio runs at solo-demo scale. My distributed-systems-at-scale exposure
         is from frontend at FedEx/Amazon, not from owning a backend system at
         horizontal scale. Naming that gap is the honest answer."
```

---

## The four stories — one-line anchors

```
  01-auth-secret-vi-stubenv-fix.md
     failure-recovery ★ — "isolated pass, parallel flake is always shared mutable state"
     anchor: vitest tests passed in isolation, flaked under parallel workers because
     process.env.AUTH_SECRET was mutated directly; fixed with vi.stubEnv + vi.unstubAllEnvs
     in beforeEach/afterEach. Commit e83a8e0. Production code unchanged.

  02-deterministic-supervisor-not-llm-router.md
     technical-judgment — "the supervisor is six lines of if-ladder, not an LLM"
     anchor: at the start of the 7-day build, the default 2026 instinct was multi-agent
     with an LLM supervisor (LangGraph / CrewAI). Argued against it; sequential pipeline
     with typed Diagnosis as the inter-stage carrier; ~3,400 LOC across 58 files; 169 tests;
     RFC-003 documents the rejected alternatives matrix.

  03-tier-2-scope-cut.md
     prioritization-and-saying-no — "the 12-week sparkline never shipped because schema-
     gated coverage earned its place on stage instead"
     anchor: day 3 of the 7-day window, building Tier 2 UI (12-week sparkline + gap chart);
     realized it wasn't load-bearing for the demo's money shot. Cut it. Spent the 4 hours
     on the schema-gated coverage subsystem instead. Commits 570502e (Tier 2 started),
     7b3d219 (schema-gated coverage shipped).

  04-eval-gap-honest-naming.md
     technical-judgment (+ failure-recovery secondary) — "169 tests, zero quality signal"
     anchor: shipped 169 vitest tests on the agents; recon audit revealed all of them
     test plumbing (the harness extracted the JSON I pre-wrote), not answer quality.
     No goldset, no judge, no agreement rate. The honest move was to NAME the gap and
     write the recipe at .aipe/drills/, not claim the 169 tests covered output quality.
     Estimate: 5h of work to move 5 LENS rungs. The L5 senior move was to ship the
     eval harness in the same week as the agent loop — I didn't, and the bank flags
     this as the central "what I'd do differently."
```

---

## Senior-bar non-negotiables — checked

```
  ✓  failure-recovery story present     → story 01 (AUTH_SECRET flake fix)
  ✓  named the cost of the wrong call   → story 01 names the cost of untracked env mutation
                                          (parallel-worker flake, ~1-in-N failure rate);
                                          story 04 names the cost of shipping evals late
                                          (cap rule fires repo-wide, L1 ceiling)
  ✓  named what changed                 → story 01: tracked-mutation discipline as
                                          regression guard; story 04: drill recipe + the
                                          rehearsal of NOT overclaiming the 169 tests
  ✓  cross-link to defense book         → all four stories cross-link
  ✗  mission-alignment story present    → CAREER-HISTORY gap, named honestly above
  ✗  impact-at-scale story present      → CAREER-HISTORY gap, named honestly above
```

The first three are met. The last two are named gaps, not silenced ones — the spec's "do not fabricate" rule is the load-bearing discipline here.

---

## See also

- `README.md` — bank-level reading order and the honest verdict on coverage
- `.aipe/audits/recon-2026-06-02.md` — the L1+L2-spike audit that grounds stories 02 and 04
- `.aipe/rehearse-interview-defense/` — the project-defense book this bank pairs with
- `~/.config/aipe/global/career-history.md` — grow this file to grow the bank
