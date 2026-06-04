# Story: cut the Tier 2 sparkline + gap chart so schema-gated coverage could earn its place on stage

**Competency:** prioritization-and-saying-no
**Also probes:** technical-judgment (recognizing what's load-bearing for the demo's money shot)
**Lands at:** Anthropic | Meta | Google | all
**Project / context:** blooming insights (Loomi Connect AI Hackathon, 2026-05-27 → 2026-06-02)
**Cross-link:** [`.aipe/rehearse-interview-defense/07-the-counterfactuals.md`](../rehearse-interview-defense/07-the-counterfactuals.md) · [`.aipe/study-system-design/08-schema-gated-coverage.md`](../study-system-design/08-schema-gated-coverage.md)

---

## Situation

Day 2 of the 7-day Loomi Connect window (`2026-05-28`). I'd just shipped commit `e2e3a87` — "Tier 1" UI enrichment with business-owner value (the enriched insight cards with sparklines + gap chart) — and the same day, commit `570502e`: "Tier 2 — 12-week sparkline + 'where the gap landed' chart." Tier 2 was the longer-range visualization layer: a 12-week trend view designed to give context beyond the 90-day briefing window. I had ~4 hours of work invested in it at that point and another ~4 hours of estimated work to ship it cleanly.

## Task

I owned the demo's money shot. The single decision I owned that afternoon: **does Tier 2 land in the final demo, or does it get cut to free hours for something else?** Hackathon demos live or die on one moment — the wow shot — and I had to call whether Tier 2 was carrying that moment or just decorating around it.

## Action

I asked the question that protected against the sunk-cost trap: *"if I cut Tier 2, what does the demo lose?"* The honest answer was: nothing load-bearing. The demo's money shot is **the diagnostic agent streaming reasoning live to the browser** — the user clicks "investigate this anomaly," and within ~3 minutes of demo time the trace shows the agent's thoughts, the EQL tool calls, the structured Diagnosis arriving. Tier 2 was a static chart that would render *after* the wow moment had already landed. It decorated the surface; it didn't drive the narrative.

I considered three options and rejected two:

1. **Ship Tier 2 and skip the schema-gated coverage subsystem.** Rejected — the coverage subsystem was the thing that would make the monitoring agent feel *intentional*. Without it, the monitoring agent looks like "ran 10 random anomaly checks." With it, the monitoring agent looks like "deliberately scanned 10 categories that the workspace's schema supports, told you which categories couldn't be checked and why." That's a substantive demo difference.

2. **Ship both, accept reduced polish elsewhere.** Rejected — the 7-day window was already tight, and "reduced polish" on a hackathon demo means the live agent stream stutters or the OAuth flow breaks on stage. The polish budget is non-negotiable.

3. **Cut Tier 2, ship schema-gated coverage instead.** Chose this. The 4 hours I'd have spent finishing Tier 2 went into commit `7b3d219` ("anomaly coverage grid — a 10-category checklist gated by workspace schema") and `7b5707b` ("stream the coverage grid progressively + replay the demo briefing"). That shipped on day 2 — same day I started Tier 2.

The harder part wasn't the call. The harder part was killing work I'd already shipped. Commit `570502e` was *in* the repo. The cut was: stop adding to it, route the briefing UI past it, build the coverage grid that the briefing actually shows. Tier 2 stayed in the commit history as a thing I'd built and chosen not to surface — which is the right shape; deleting it would have erased the evidence that the cut happened.

## Result

The schema-gated coverage subsystem became a load-bearing pattern in the demo. It earned its own pattern file: `.aipe/study-system-design/08-schema-gated-coverage.md` — and the `2026-06-02` recon audit names it explicitly: *"This is rare and good — most L1 codebases skip it"* (`recon-2026-06-02.md` line 50). It's one of the artifacts that pushes the repo's agent-architecture competency to L2.

The 12-week sparkline never shipped. Commit `570502e` is in the git history and the components are in the codebase, but no route surfaces them. That's the honest shape of the cut — it's not "I deleted it," it's "I stopped feeding it." The artifact is the trace of the decision.

The demo on `2026-06-02` ran clean: the live agent stream landed inside ~3 minutes of demo time, the schema-gated coverage grid told the audience *which 10 categories were checked and why*, and the wow moment landed. If Tier 2 had been in the demo path, the schema-gated coverage subsystem would not exist, and the monitoring agent would have read as "random anomaly checks" instead of "deliberate, schema-aware coverage."

## What I'd do differently / what I learned

I'd make the cut six hours sooner. By the time I called it on day 2 afternoon, I had already shipped commit `570502e` (the partial Tier 2). If I'd framed the question — *"is this load-bearing for the money shot?"* — earlier in the morning, the 4 hours I spent starting Tier 2 would have gone into the coverage subsystem from the start. The lesson: **the "is this on the demo's critical path?" question is the first one to ask each morning of a hackathon, not the one to ask after the work is in progress.** Sunk-cost narrows your options; pre-commit framing keeps them open.

---

## Defense — likely follow-ups

- **Q: How did you know Tier 2 wasn't load-bearing? You'd already started building it.**
  A: I asked the inverted question — "if I cut Tier 2, what does the demo lose?" — and the honest answer was nothing on the critical path. The demo's wow moment is the live agent stream, not the 12-week chart. Charts decorate; the stream drives the narrative. Asking the question that way kept the sunk cost from contaminating the decision.

- **Q: Why is schema-gated coverage load-bearing for the demo when a chart isn't?**
  A: Schema-gated coverage is what makes the monitoring agent feel *intentional* instead of random. The audience sees "here are 10 categories we scan, and here's why we can't scan category X — your workspace doesn't have the schema fields for it." That's a substantive claim about the agent's behavior. A 12-week sparkline doesn't make a claim about the agent — it just shows historical data. One drives the agent narrative; the other decorates around it.

- **Q: You committed Tier 2 (commit 570502e) and then cut it. Why didn't you revert the commit?**
  A: Two reasons. First, the cut was "stop adding to it," not "erase the evidence it existed" — the commit history is honest about what I built and what I chose not to surface. Second, the components might earn their place later (post-hackathon, in a v2 that has more screen real estate). Deleting the code now would have meant rebuilding it from scratch then. The cost of keeping unused code in the repo is low; the cost of erasing the decision trace is higher.

- **Q: This sounds like "I cut a feature." What makes it a senior move vs a normal hackathon trade-off?**
  A: Two parts. First, naming what to cut by reference to a load-bearing criterion (the demo's money shot), not by reference to effort or polish. "What's hardest to ship" cuts the wrong things; "what's load-bearing for the audience's wow moment" cuts the right ones. Second, the cut freed budget for a *substantively different* thing (schema-gated coverage) that earned its way onto stage — the audit's pattern file confirms that. The senior move isn't the cut itself; it's the redirected budget that made the cut worth it.

- **Q: What would you have done if cutting Tier 2 had freed 4 hours and you'd had nothing equally load-bearing to spend them on?**
  A: I'd have rehearsed the demo. A 7-day hackathon demo where the live agent stream stutters once on stage is worse than the same demo with no stutter. "Re-running the same flow under timing pressure" is real work, not slack — the cost of a stage failure is non-recoverable. The honest version: I had the coverage subsystem queued up, so the redirect was natural. If I hadn't, the 4 hours would have gone into rehearsal and observability hardening (better logs, faster fallback to the cache-replay path), not into a different feature.
