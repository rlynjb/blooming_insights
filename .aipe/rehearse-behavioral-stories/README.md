# Behavioral story bank — rein

> **Coach posture, verdict first.** This bank covers ~30% of the senior bar. Four real stories, all from one week of solo hackathon work on blooming insights. The remaining six competencies are **CAREER-HISTORY gaps, not story gaps** — the raw material file (`~/.config/aipe/global/career-history.md`) has one real entry plus four `[EXAMPLE]` scaffolds. The bank refuses to fabricate from the examples. If you want a bank that can carry a full senior loop, the next move is to add real entries to the career-history file — full-time roles, peer-conflict stories, stakeholder-pushback moments — and re-run this generator.

---

## What's in the bank

Four stories, each grounded in commits, RFCs, and audit artifacts from this repo:

```
  01-auth-secret-vi-stubenv-fix.md         failure-recovery ★ (non-negotiable)
  02-deterministic-supervisor-not-llm-router.md   technical-judgment
  03-tier-2-scope-cut.md                   prioritization-and-saying-no
  04-eval-gap-honest-naming.md             technical-judgment + failure-recovery
```

The `00-overview.md` file is the navigation layer — competency × company coverage matrix, gaps named honestly, recommended rehearsal order per company's loop.

---

## Reading order

**If you're prepping a loop in <48 hours:** read `00-overview.md` first to see which story leads at each company, then drill the four stories cold (cover the Defense block, answer the probes out loud, peek to score). Story `01` is the failure-recovery slot and the one a senior interviewer will pull on regardless of company — rehearse it twice.

**If you're prepping for the first time:** read `00-overview.md`, then read each story end-to-end once, then come back and rehearse each Defense block out loud. The Result and What-I'd-Do-Differently blocks are the senior-bar load-bearing parts; the Situation/Task/Action carry the narrative.

---

## Competency-to-company quick map

```
  Anthropic       lead with 02 (technical-judgment, RFC quality + agent depth)
                  then 01 (failure-recovery)
                  then 04 (honest gap-naming + AI-eval discipline = mission-aligned signal)

  Meta            lead with 02 (technical-judgment, anti-framework conviction)
                  then 03 (prioritization, cut what doesn't earn its place)
                  then 01 (failure-recovery)

  Google          lead with 01 (failure-recovery, post-mortem discipline)
                  then 02 (technical-judgment)
                  then 04 (what-you'd-do-differently → eval harness as the L5 move)

  all loops       carry 01 as the failure-recovery answer; it's the only one in the bank
```

The honest framing: **none of these stories carry mission-alignment, none carry stakeholder-pushback or peer-conflict, none carry impact-at-scale.** Those are bigger structural gaps — see `00-overview.md` for the explicit list.

---

## What's NOT in the bank (and why)

The `[EXAMPLE]` entries in `~/.config/aipe/global/career-history.md` (HackTheBackend, StackHack, DevPost) are illustrative scaffolds. They show the file's SHAPE but contain no real material — generating stories from them would be pure fabrication, which the spec explicitly forbids ("does not fabricate stories — if the career-history file is thin, the bank is thin").

The fix is **not** to dress up the examples. The fix is to **add real entries** — your prior roles, your prior projects, the moments you'd want to tell as stories at a loop. Then re-run `/aipe:rehearse-behavioral-stories` and the bank grows past the four hackathon-week stories.

---

## Cross-links to defense books

This bank pairs with `.aipe/rehearse-interview-defense/` (the project-defense book for blooming insights specifically). The behavioral bank covers **WHO you are as an engineer**; the defense book covers **WHAT you built on this repo**. Pair them at every loop:

- Story `01` (failure-recovery) ↔ `rehearse-interview-defense/05-the-failure-story.md`
- Story `02` (technical-judgment) ↔ `rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` + `rehearse-interview-defense/03-the-choices.md`
- Story `03` (prioritization) ↔ `rehearse-interview-defense/07-the-counterfactuals.md`
- Story `04` (eval gap) ↔ `rehearse-interview-defense/08-the-ai-question.md` + `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md`

---

## The honest verdict on this bank

**Covers ~30% of senior bar.** The four stories that exist are real, defensible, and grounded. The six competencies the bank cannot fill (ambiguity-navigation, peer-conflict-resolution, stakeholder-pushback, influence-without-authority, impact-at-scale, mission-alignment) are not story-quality gaps — they are CAREER-HISTORY gaps. Hackathon-week material does not produce stakeholder-pushback stories because there were no PMs to push back against. It does not produce influence-without-authority stories because solo entrants have no one to influence. It does not produce impact-at-scale stories because the demo ran once on stage.

The fix is to grow the career-history file with full-time-role-shaped material. The bank is then re-runnable.

---

## See also

- `.aipe/audits/recon-2026-06-02.md` — the L1+L2-spike verdict for blooming insights; sources the technical context for stories 02 and 04
- `.aipe/study-debugging-observability/05-auth-secret-flake-postmortem.md` — the canonical post-mortem for story 01
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — RFC source for story 02
- `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md` — the eval-gap drill referenced by story 04
- `.aipe/rehearse-interview-defense/` — the project-defense book this bank pairs with
- `~/.config/aipe/global/career-history.md` — the raw-material file; grow this to grow the bank
