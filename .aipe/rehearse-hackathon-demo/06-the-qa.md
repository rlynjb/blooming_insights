# Chapter 06 — The Q&A (after the clock, prep only)

The buzzer went off. The room is polite-clapping. A judge raises a hand. This is the chapter that runs after the ten-minute slot and never eats it — but it's the chapter that decides whether the demo lands with a "nice work" or a business card.

The Q&A rules are different from the demo. In the demo you were choreographing a room; here you're one-on-one with a judge who has one probe and about 45 seconds of patience. The answers are short. They point at receipts. They own the rough edges. They never hedge.

Six probes come up almost every time. You rehearse the verbatim answer to each. When a variant of a probe lands, you recognize the shape and use the answer. If a probe is genuinely off-script, you have a fallback move: "the honest answer is I don't know — here's what I'd need to find out." That answer beats a fabricated one, always.

  ## The Q&A shape — six anticipated probes

  Each probe has a category. Recognizing the category is 80% of answering well.

```
  The six probes — what judges ask after a hackathon demo

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

  ┃ "Demo is the default for reliability. Live-bloomreach when there's a real workspace plus OAuth tokens. Live-synthetic is the dev / test / judge-friendly path — no creds, no upstream dependency. Deployed to Vercel Pro; maxDuration 300 on the streaming routes. Auto-reconnect when the alpha server revokes tokens mid-session."

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

  Judges in 2026 assume heavy AI use in a hackathon build. Defensiveness reads worse than candor. If the question comes up:

  ┃ "AI-assisted, absolutely. I use Claude Code as a pair programmer — the agent loop, the DataSource seam, the eval flywheel, all shipped with heavy AI assistance. What I own: the architecture decisions, the seam choice, the eval design, the retirement of the wrong substrate in phase 3. What the tools did: a lot of the typing. Both matter."

  The move: **name what you own and what the tools did, without flinching**. This is the sentence that separates someone who used AI to ship from someone who used AI to hide.

  ## One-page run sheet — the Q&A

  This is what you glance at before the Q&A session starts, not during. During the Q&A, your eyes are on the judge.

```
  ╭─ RUN SHEET · CHAPTER 06 · THE Q&A ───────────────────────╮
  │                                                           │
  │  When:       after the clock; not counted in the slot     │
  │  Posture:    short answers, point at receipts, own rough  │
  │              edges, never hedge                           │
  │                                                           │
  │  The six probes — recognize the category, pick the answer:│
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
  │  4. "production deployment?"                               │
  │     → three modes: demo / live-bloomreach / live-         │
  │        synthetic; Vercel Pro; auto-reconnect               │
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
  │  Off-script fallback:                                     │
  │    → name the file/module                                 │
  │    → ask a clarifying question back                       │
  │    → "the honest answer is i don't know — here's what     │
  │       i'd need to find out"                                │
  │                                                           │
  │  On AI use:                                               │
  │    → matter-of-fact. name what you own (architecture,     │
  │       seam choice, eval design, phase-3 retirement) and   │
  │       what the tools did (a lot of the typing). both      │
  │       matter.                                              │
  │                                                           │
  ╰──────────────────────────────────────────────────────────╯
```
