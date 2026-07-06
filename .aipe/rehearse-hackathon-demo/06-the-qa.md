# Chapter 06 — The Q&A (after the clock, prep only)

The buzzer went off. The room is polite-clapping. A judge raises a hand. This is the chapter that runs after the ten-minute slot and never eats it — but it's the chapter that decides whether the demo lands with a "nice work" or a business card.

The Q&A rules are different from the demo. In the demo you were choreographing a room; here you're one-on-one with a judge who has one probe and about 45 seconds of patience. The answers are short. They point at receipts. They own the rough edges. They never hedge.

Eleven probes come up almost every time. You rehearse the verbatim answer to each. When a variant of a probe lands, you recognize the shape and use the answer. If a probe is genuinely off-script, you have a fallback move: "the honest answer is I don't know — here's what I'd need to find out." That answer beats a fabricated one, always.

  ## The Q&A shape — eleven anticipated probes

  Each probe has a category. Recognizing the category is 80% of answering well.

```
  The eleven probes — what judges ask after a hackathon demo

  ┌── probe ──────────────────────┬── category ─────────────────┐
  │ 1. isn't synthetic just fake?  │ credibility of the demo     │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 2. how do you know the eval    │ credibility of the receipts │
  │    isn't measuring itself?     │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 3. what if i break a prompt?   │ regression story            │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 4. what's the production       │ deployment story            │
  │    deployment story?           │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 5. what about scale?           │ scale honesty               │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 6. why NOT route monitoring    │ cost / model choice         │
  │    to a cheaper model?         │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 7. so this isn't just for      │ scope / product framing     │
  │    Bloomreach?                 │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 8. how much of this was        │ AI-assist honesty           │
  │    AI-generated?               │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 9. is the eval harness         │ receipts realness           │
  │    actually real?              │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 10. you mention evals — did    │ eval as safety net          │
  │     they ever catch something? │                             │
  ├────────────────────────────────┼─────────────────────────────┤
  │ 11. how do you handle race     │ concurrency / serverless    │
  │     conditions in a serverless │                             │
  │     setup?                     │                             │
  └────────────────────────────────┴─────────────────────────────┘
```

  ## Probe 1 — "isn't synthetic just fake data?"

  This is the credibility probe. A judge is checking whether the demo they just saw was real reasoning or a puppet show. The answer has two parts: name what's fake (the data, not the agent behavior), and produce a receipt that proves it.

  ┃ "It's deterministic Blooming-owned synthetic ecommerce — purchase, view_item, session_start, cart_update events with realistic properties. Real Claude, real reasoning, in-process data. The fake is the data, not the agent behavior. And here's the fault injector receipt: 9 injected faults across 3 investigations, 0 failed. Seeded PRNG so you can replay it."

  The move: **name what's fake, produce the receipt**. The receipt is the fault-injection number — 9 faults injected across 3 investigations, 0 failed — because if the agent behavior were faked, injecting real errors wouldn't produce that outcome. The receipt closes the loop.

  Follow-up decision tree:

```
  If judge presses "but the DATA is fake, so results are meaningless" →
    "The data is fake; the agent's reasoning process is what's under
     test. When I run against the real Bloomreach workspace, the
     agent uses the same reasoning process. What live-synthetic gives
     me is a reproducible substrate to gate my prompts against."

  If judge asks "why not just use real data" →
    "Because real data is behind OAuth, rate-limited to ~1 req/s, and
     the alpha server revokes tokens after minutes. Synthetic lets me
     rehearse, run evals, and demo without waiting on that. Live mode
     hits the real workspace when I need it to."
```

  ## Probe 2 — "how do you know the eval isn't measuring itself?"

  This is the receipts-credibility probe. A judge is checking whether you've thought about circularity — the eval scoring itself against its own definition of correct. This one is answered by owning the rough edge.

  ┃ "Blind calibration protocol. Session D was AI-vs-AI, stamped `pilotWarning` in the receipt because I know it's not real calibration. The interview-defensible number needs a blind human pass — 30-60 minutes, worksheet already generated. That's the honest answer."

  The move: **own the rough edge, name the next step**. Do not pretend the AI-vs-AI pilot is calibration. The judge is asking whether you understand the difference between measurement and self-measurement, and the answer is yes — and here's how you close the gap.

  Follow-up decision tree:

```
  If judge asks "so your numbers are AI-scored?" →
    "For the pilot session, yes. That's why they're stamped
     pilotWarning. The rubrics are grounded — 2 rubrics, 4 dimensions,
     5-point scale — and the baseline is committed. The next pass
     needs a human rater. Worksheet is at eval/calibration/."

  If judge asks "how would you rate it yourself" →
    "I'd expect the diagnosis rubric to hold up better than the
     recommendation rubric under blind human review. Diagnosis is
     more mechanical — evidence, scope, hypothesis. Recommendation
     is judgment-heavy, so drift is more likely."
```

  ## Probe 3 — "what if i break a prompt?"

  This is the regression probe. A judge is checking whether the eval is decorative or load-bearing. Load-bearing means it gates.

  ┃ "npm run eval:gate. Blocks the PR if any dimension regressed more than 10pp. Baseline is committed at eval/baseline.json. Watch — here's the self-check: baseline vs baseline all deltas +0pp, gate passes. Now if I go to eval/rubrics/diagnosis-quality.ts and lower a score threshold, gate goes red."

  The move: **demonstrate it, don't just describe it**. If you're near a terminal, run the self-check. If not, name exactly what the output looks like. "Gate passes" and "gate goes red" are concrete phrases judges can hold onto.

  Follow-up decision tree:

```
  If judge asks "is that wired into CI?" →
    "Yes. .github/workflows/eval.yml runs on PR. Any dim regressed
     more than 10pp blocks the merge. That's the shipped state."

  If judge asks "10pp is a lot — why not 5?" →
    "10pp is the honest signal-to-noise threshold at 10 goldens.
     With more goldens the threshold tightens. It's a tunable — the
     number is not the point; the gate is."
```

  ## Probe 4 — "what's the production deployment story?"

  This is the deployment probe. A judge is checking whether "demo" and "shippable" are the same thing.

  ┃ "Live-synthetic is the default at page load — real agents, no creds, no upstream dependency. Live-mcp is the production path: any HTTPS MCP server, three auth providers (bloomreach oauth / bearer / anonymous), and a per-visitor override via the settings modal. Demo mode replays committed snapshots for a bulletproof fallback. Deployed to Vercel Pro; maxDuration 300 on the streaming routes. Auto-reconnect when the alpha server revokes tokens mid-session."

  The move: **name the three modes and what each is for**. The judge is expecting a hedge; instead, name the specific runtime posture for each mode.

  Follow-up decision tree:

```
  If judge asks "what happens when the token dies mid-session?" →
    "The route catches invalid_token errors, resets auth via
     /api/mcp/reset, and reloads the page once (guarded flag to
     prevent loops). The UX is a reconnect button on error panels."

  If judge asks "is state persisted?" →
    "In-memory maps in production; gitignored JSON files in dev.
     Demo snapshots are committed to lib/state/demo-*.json — that's
     the reliable-demo path. No database."
```

  ## Probe 5 — "what about scale?"

  This is the scale-honesty probe. A judge is checking whether you overclaim. Do not.

  ┃ "The bottleneck is browser session state on a warm Vercel instance. Trigger for revisit: multi-instance. Load harness at N=20, K=3 is roughly 28 minutes wall clock estimated — I smoke-tested at N=2, K=1 which took 208 seconds. Real p99 numbers need a real load run at production scale. That's honest."

  The move: **name the bottleneck, name the trigger, name what you've measured and what you haven't**. "Real p99 numbers need a real load run" is the sentence that separates senior signal from junior overclaim.

  Follow-up decision tree:

```
  If judge asks "why haven't you run one?" →
    "Cost. Full load at N=20 costs about $26 in Claude tokens and
     takes half an hour of wall clock. Worth doing when there's a
     production trigger. Not worth doing to have a number for a
     demo."

  If judge asks "what's the horizontal scale story?" →
    "It's not built yet. Session state lives in memory; multi-
     instance would need shared state (Redis or a DB). The MCP
     server rate-limits at ~1 req/s per workspace, so per-workspace
     concurrency is capped upstream regardless."
```

  ## Probe 6 — "why NOT route monitoring to Haiku?"

  This is the cost-choice probe. A judge is checking whether you make cost decisions with data or with vibes.

  ┃ "The eval doesn't measure monitoring cost — it skips monitoring and feeds golden anomalies straight to DiagnosticAgent. Routing to Haiku blind would be the exact anti-pattern the eval flywheel exists to prevent. Deferred until we have production data. That's the receipt of a decision, not procrastination."

  The move: **explain what the eval measures and doesn't, then explain what would justify the change**. This is the answer that shows you understand the difference between "cheaper" and "cheaper without regressing quality."

  Follow-up decision tree:

```
  If judge asks "isn't that expensive?" →
    "About nine cents per case per full investigation. The intent
     classifier is already on Haiku — that's the cheap first hop.
     The reasoning agents are on Sonnet because that's where the
     accuracy shows up in the eval."

  If judge asks "what would flip you to Haiku?" →
    "Golden cases running through monitoring in the eval, so I can
     compare Sonnet-monitoring vs Haiku-monitoring on the same
     dimensions. Right now the eval starts at diagnosis. Adding
     that layer is on the roadmap."
```

  ## Probe 7 — "wait, so this isn't just for Bloomreach?"

  This is the scope / product-framing probe. A judge saw the settings-modal swap (or heard you mention it) and is checking whether the pitch was misleading — the product name looks Bloomreach-specific, but you just pointed at any-MCP.

  ┃ "Correct — Bloomreach is the default MCP preset in MCP_URL, not the product's identity. The product is a multi-agent analyst that speaks MCP. Any HTTPS MCP server works — you saw the settings-modal swap. Three auth flows: bloomreach oauth PKCE, bearer token, anonymous. The name reflects where it was built and tested first, not where it's constrained to run."

  The move: **name the default vs the identity**. Do not defensively insist it was always framed that way — say plainly that Bloomreach was the first-party target, and the seam that makes any-MCP possible is the same seam that made the fault-injection receipt possible.

  Follow-up decision tree:

```
  If judge asks "why is it named after Bloomreach then?" →
    "Because it was built against Bloomreach Engagement first —
     that's where the loomi connect MCP server exists, that's the
     workspace i had access to. Refactoring the name isn't the
     priority; refactoring the assumption is, and the seam already
     did that."

  If judge asks "have you tested it against another MCP server?" →
    "The synthetic adapter is a different data source through the
     same port, which is the strongest confirmation the seam is
     honest. A second real MCP server is on the list — the settings
     modal made it a five-minute task instead of a rebuild."
```

  ## Probe 8 — "how much of this was AI-generated?"

  This is the AI-assist honesty probe. It comes up in every 2026 hackathon. Do not flinch, do not overclaim, do not undersell.

  ┃ "AI-assisted heavily — Claude Code as a pair programmer. What i own: the architecture (agent loop, DataSource seam, three-adapter split, per-request UI override via base64 header), the eval design, retiring the wrong substrate in phase 3, the decision to make live-synthetic the default. What the tools did: a lot of the typing, a lot of the tests. Both matter. If you want to see the decision receipts, the seam is at lib/data-source/ and Sessions A–D are in the commit history."

  The move: **name what you own and what the tools did without flinching, then point at a receipt**. The receipt is the seam and the session commits — verifiable in the repo.

  Follow-up decision tree:

```
  If judge asks "what would you have gotten wrong without AI?" →
    "The typing speed, mostly. The wrong-substrate call in phase 3
     was mine — the AI would have kept helping me build on it. The
     retirement decision cost a chunk of the timeline; recovering
     the receipts cost more. That's the kind of judgment call the
     tools do not make for you."

  If judge asks "could you have shipped this without AI?" →
    "In the hackathon window? no. In three months? probably yes.
     The tools compress calendar time, not decision-making."
```

  ## Probe 9 — "what about the eval harness — is that actually real?"

  This is the receipts-realness probe. A judge has heard "shipped, measured, gated" and wants to know if there's actual code behind the words.

  ┃ "Yes — 10 golden cases in eval/cases/, 2 rubrics (diagnosis-quality, recommendation-quality) at 4 dimensions × 5-point scale, committed baseline at eval/baseline.json (baseline runId 2026-07-03T04-08-28-644Z). Per-case cost is about nine cents; per-phase p50 is around 50 seconds for diagnose and 51 for recommend. Regression gate blocks the PR at >10pp on any dimension. All wired into .github/workflows/eval.yml. Receipts live in eval/receipts/."

  The move: **name the file paths and the numbers**. Specificity is the receipt. Judges do not fact-check baseline runIds live — they respect that you can produce one.

  Follow-up decision tree:

```
  If judge asks "why 10 goldens? isn't that thin?" →
    "For a hackathon window, yes. It's enough to gate against
     obvious regressions and to earn the CI wiring. Scaling to 50
     is a corpus problem, not a design problem — the harness runs
     the same way at 10 or 50."

  If judge asks "how much does one full eval run cost?" →
    "About $1.30 wall clock; ~46 minutes on a warm connection.
     The eval:report table you saw at the end of the demo is the
     receipt from the latest committed run."
```

  ## Probe 10 — "you mention evals — did they ever catch something?"

  This is the eval-as-safety-net probe. A judge is checking whether the eval is decorative or whether it has ever bitten. The answer is a lived negative-result rep, dated, with a commit hash. Deliver it plainly — the receipt does the work.

  ┃ "Yes. Commit be05240, two days ago. I shipped a coordination pass called filterSupportedHypotheses on the multi-agent handoff. Ran the full 10-case eval. Four recommendation dimensions regressed by 13 to 23 points. Reverted the change. The eval was the safety net — that's the receipt that proves the gate is load-bearing on real work, not just theoretical."

  The move: **name the commit, name the number, name the outcome**. The judge is asking whether you have ever been saved by the tooling you built. The answer is yes, and it's the strongest single receipt in the whole book because it's a *negative* result — a failure you ate on purpose because the eval caught it.

  Follow-up decision tree:

```
  If judge asks "why did you ship it if you weren't sure?" →
    "That's what the eval is for. Four study audits pointed at
     coordination failure as a risk. filterSupportedHypotheses was
     the drill for it. You ship the drill, you run the eval, you
     find out. Reverting on a 13–23pp regression across four dims is
     the shipped state of the discipline, not a mistake in it."

  If judge asks "would you have caught it in code review?" →
    "No — the regression was in recommendation quality across four
     dimensions, not in a testable invariant. That's exactly the
     class of thing evals catch that unit tests don't."
```

  ## Probe 11 — "how do you handle race conditions in a serverless setup?"

  This is the concurrency-under-serverless probe. A judge is checking whether you understand where in-memory session state is actually safe and where it isn't. Answer with a lived receipt.

  ┃ "The obvious one is shared-state Maps across warm-instance invocations. The one I hit was subtler — concurrent-briefing race in the same session. Four study audits flagged it; I read the code and reframed the actual mechanism from a shared-Map race to a concurrent-briefing race, then shipped a route-level gate at lib/state/in-flight-briefings.ts with eight tests. Commit cab85c6, two days ago. The gate is the honest answer — in-memory session state is fine per-instance; concurrent briefings on the same session are what needed guarding."

  The move: **name the actual mechanism, not the assumed one, and point at the shipped gate**. The differentiator here is the reframing — the audits found a symptom, you found the real mechanism and shipped against that. That is a senior-signal answer.

  Follow-up decision tree:

```
  If judge asks "what about across warm instances?" →
    "Session state lives in memory per instance; the MCP server
     rate-limits at ~1 req/s per workspace, so cross-instance
     coordination is capped upstream. Multi-instance shared state
     would need Redis or a DB — not built, called out honestly on
     the scale probe."

  If judge asks "how did you know it was concurrent-briefing and not
     Map races?" →
    "Read the code. The Map lookups were synchronous; the race was
     between two briefing NDJSON streams for the same session
     landing in overlapping windows. The gate reserves the session
     for the in-flight briefing and rejects the second request until
     the first drains. Eight tests cover it."
```

  ## The off-script fallback — the "i don't know" move

  When a probe genuinely surprises you, do not fabricate. The strongest recovery move in a hackathon Q&A is naming the gap honestly.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ judge: "how does your rate      │ judge: "how does your rate      │
  │  limiter handle burst traffic?" │  limiter handle burst traffic?" │
  │                                 │                                 │
  │ "so it's basically a token      │ "the honest answer is i don't   │
  │  bucket, and it kind of…        │  know off the top of my head —  │
  │  buffers requests, and…"        │  the client is at lib/mcp/      │
  │                                 │  client.ts, and it's roughly    │
  │ (fabricated; a follow-up will   │  one request per second with     │
  │  expose it)                     │  a retry. what specifically      │
  │                                 │  are you asking about — burst    │
  │                                 │  handling or fairness?"          │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  Three moves for off-script probes:

  → **Name the file/module the answer lives in.** Judges respect specificity even when the answer isn't complete.

  → **Ask a clarifying question back.** Turns the probe into a conversation instead of an exam.

  → **Never speculate past what you actually know.** A fabricated technical answer costs more trust than an honest "I don't know" ever will.

  ## On owning AI-assisted development

  Probe 8 above is the primary answer. Keep the sentence tight; the hackathon-Q&A version is shorter than the interview-defense version (Chapter 08 of the interview-defense book carries the long form).

  The one-line default if a variant hits: **"AI-assisted heavily; the architecture, the seam choice, and the substrate retirement are mine — the typing was the tool's."** Do not extend without a follow-up prompt.

  ## One-page run sheet — the Q&A

  This is what you glance at before the Q&A session starts, not during. During the Q&A, your eyes are on the judge.

```
  ╭─ RUN SHEET · CHAPTER 06 · THE Q&A ───────────────────────╮
  │                                                           │
  │  When:       after the clock; not counted in the slot     │
  │  Posture:    short answers, point at receipts, own rough  │
  │              edges, never hedge                           │
  │                                                           │
  │  The eleven probes — recognize the category, pick the    │
  │  answer:                                                  │
  │                                                           │
  │  1. "isn't synthetic fake?"                               │
  │     → name what's fake + fault receipt (9/3/0)            │
  │                                                           │
  │  2. "how do you know the eval isn't measuring itself?"    │
  │     → blind calibration protocol; pilotWarning stamp;     │
  │        human pass needed; worksheet ready                 │
  │                                                           │
  │  3. "what if i break a prompt?"                           │
  │     → npm run eval:gate; blocks PR at >10pp regression;   │
  │        CI-wired                                            │
  │                                                           │
  │  4. "production deployment?"                              │
  │     → live-synthetic (default) / live-mcp (any HTTPS      │
  │        MCP, 3 auth providers, settings-modal override)   │
  │        / demo (snapshot fallback); Vercel Pro;           │
  │        auto-reconnect                                     │
  │                                                           │
  │  5. "what about scale?"                                   │
  │     → session state = bottleneck; N=20 K=3 ~ 28min        │
  │        estimated; real p99 needs a real load run;         │
  │        honest                                              │
  │                                                           │
  │  6. "why not route monitoring to Haiku?"                  │
  │     → eval doesn't measure monitoring cost; blind         │
  │        routing = anti-pattern eval exists to prevent      │
  │                                                           │
  │  7. "isn't this just for Bloomreach?"                     │
  │     → Bloomreach is the DEFAULT MCP preset, not the      │
  │        identity; any HTTPS MCP works; 3 auth flows;       │
  │        you saw the swap on stage                          │
  │                                                           │
  │  8. "how much was AI-generated?"                          │
  │     → heavily AI-assisted; you own architecture / seam /  │
  │        substrate-retirement; tools did the typing;        │
  │        Sessions A–D in commit history                     │
  │                                                           │
  │  9. "is the eval harness actually real?"                  │
  │     → 10 goldens, 2 rubrics × 4 dims, baseline.json       │
  │        (runId 2026-07-03T04-08-28-644Z), ~$0.09/case,    │
  │        p50 diagnose 50s / recommend 51s, CI wired         │
  │                                                           │
  │ 10. "did evals ever catch something?"                     │
  │     → Move 3 · be05240 · filterSupportedHypotheses;       │
  │        4 rec dims regressed 13–23pp; reverted;            │
  │        negative-result rep = strongest single receipt     │
  │                                                           │
  │ 11. "race conditions in a serverless setup?"              │
  │     → Move 4 · cab85c6 · 4 audits flagged; reframed       │
  │        (concurrent-briefing race, not shared-Map race);   │
  │        route-level gate at lib/state/in-flight-           │
  │        briefings.ts + 8 tests                             │
  │                                                           │
  │  Off-script fallback:                                     │
  │    → name the file/module                                 │
  │    → ask a clarifying question back                       │
  │    → "the honest answer is i don't know — here's what     │
  │       i'd need to find out"                                │
  │                                                           │
  ╰──────────────────────────────────────────────────────────╯
```
