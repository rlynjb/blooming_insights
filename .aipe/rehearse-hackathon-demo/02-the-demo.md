# Chapter 02 — The demo (1:00–6:00, 5 minutes)

This is the centerpiece. Half your slot. The chapter the rest of the book exists to support. By the end of these five minutes the room either gets why blooming insights is different from "a chatbot that summarizes my dashboard," or you've lost them — and no architecture diagram in chapter 03 will pull them back.

The differentiator you are demoing is **the streaming reasoning trace**. Not the answer. Not the recommendation. The fact that as the agent works, the room *watches it work* — each query, each hypothesis, each tool result appearing in the right column in real time, while the left column composes the conclusion. The money shot is the moment the trace fills the screen with the agent's actual thinking and the room realizes they are watching a *process*, not consuming an output. That moment lands at **2:30**, inside the first third of the slot. Everything before it sets the table. Everything after it builds on the fact that the room is now leaning in.

The stage path is `live-synthetic`: real agents, real Claude, real streaming trace, deterministic in-process data. No OAuth, no rate limits, no token revocation. This is the path that has the production agent behavior and none of the production reliability cliffs.

  ## The time-budget bar

```
  ┌────────────────────────────────────────────────────────────────┐
  │ ░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░ │
  │ 0:00 ────── 1:00 ───────────★ 2:30 ─────────── 6:00 ──── 10:00 │
  │             THE DEMO — you own 1:00 to 6:00 (5 minutes)         │
  │             ★ MONEY SHOT lands at 2:30 (inside the first third) │
  └────────────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the click path

Three stages, walked in order: **monitoring** (the feed paints), **investigation** (one card opens, the diagnostic agent runs), **decision** (the recommendation agent runs and proposes a Bloomreach action). The trace column is alive at every step. The screen layout is identical across stages — same stepper, same `max-w-5xl` width, same two-column grid — so the room follows the *process* rather than re-orienting to a new layout.

```
  THE CLICK PATH — 5 MINUTES, THREE STAGES

  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │  STAGE 1        │  │  STAGE 2        │  │  STAGE 3        │
  │  monitoring     │─▶│  investigation  │─▶│  decision       │
  │  (the feed)     │  │  (one card)     │  │  (the action)   │
  │                 │  │                 │  │                 │
  │  app/page.tsx   │  │  app/investigate│  │  .../recommend/ │
  │                 │  │   /[id]/page    │  │   page.tsx      │
  │                 │  │                 │  │                 │
  │  monitoring     │  │  diagnostic     │  │  recommendation │
  │  agent runs;    │  │  agent runs;    │  │  agent runs;    │
  │  cards paint    │  │  evidence       │  │  proposes a     │
  │  left, trace    │  │  panel paints,  │  │  bloomreach     │
  │  paints right   │  │  trace paints   │  │  feature with   │
  │                 │  │                 │  │  expected impact│
  │  ⏱ 1:00–3:30    │  │  ⏱ 3:30–5:00    │  │  ⏱ 5:00–6:00    │
  │  ★ money shot   │  │                 │  │                 │
  │    at 2:30      │  │                 │  │                 │
  └─────────────────┘  └─────────────────┘  └─────────────────┘
        click          click "see              click "see
        nothing —      investigation →"        recommendations →"
        wait & talk    on the card

  ProcessStepper across the top stays visible the whole time.
  StatusLog (the trace) stays in the right column the whole time.
  The room's eye doesn't reset between stages.
```

Three stages, two clicks. That's it. You are not navigating settings, you are not creating an account, you are not switching tabs. The whole demo is on the rail the user would actually use.

  ## Stage 1 — Monitoring (1:00–3:30) — where the money shot lives

You start on the feed. The mode toggle is set to `live-synthetic`. The page loads, the briefing route boots a fresh `SyntheticDataSource`, the monitoring agent starts running, and **the trace column comes alive**. This is the moment. Your job for the next 90 seconds is to do almost nothing — let the agent work and narrate the *value* of what the room is seeing.

| SHOW (on screen)                                                     | SAY (out loud)                                              |
|----------------------------------------------------------------------|-------------------------------------------------------------|
| Page first paints. Stepper at top: stage 1 active. Left column: skeleton cards. Right column: status log shows "scanning your workspace…" | "I'm picking live-synthetic mode — real agents, real Claude, deterministic data so the demo doesn't depend on the conference wifi being kind." |
| Trace begins to paint: `▸ scanning events…`, then a tool call: `execute_analytics_eql · count purchase` appears with a status dot | "the right column is the **monitoring agent**. Every line is one step it actually took — every tool call is one EQL query it ran against the workspace." |
| Another tool call appears: `execute_analytics_eql · sum purchase.total_price`. Then a hypothesis line in the trace. | "it's not following a script. There are no saved dashboards. The agent is deciding what to query based on what it sees." |
| **★ 2:30 — MONEY SHOT.** The trace column has ~6 tool calls now, scrolling. The first card paints on the left: `● usa purchase_revenue · -38.4%` with summary, why-it-matters, scope, prior→now bars. | *(let it paint — say nothing for 2 seconds)* "**that's it. An analyst that shows its work.**" |
| A second card paints below the first. Trace keeps scrolling. | "and it doesn't stop at one — it ranks by severity, scopes globally or to a country segment only when the data says to." |

You are now at roughly 3:00. The room has seen the trace fill the screen and a real card appear from it. The differentiator has landed.

The reason this works as a money shot — and the reason this product is different from a "ask GPT about my dashboard" wrapper — is that the trace is not a *log of work that already happened.* It is the work, streamed live as it happens. The NDJSON event stream from `app/api/briefing/route.ts` paints into `ReasoningTrace` as each `reasoning_step`, `tool_call_start`, `tool_call_end`, and `insight` event arrives. The room sees the agent thinking. That is the entire pitch in one visual.

```
  ┃ "Every line on the right is one step the agent actually took.
  ┃  Every tool call is one EQL query it ran against the workspace.
  ┃  Nothing here is pre-recorded."
```

  ## Stage 2 — Investigation (3:30–5:00)

Click the first card. You land on `app/investigate/[id]/page.tsx`. The stepper advances. The diagnostic agent starts. **The trace column comes alive again** — this time with the diagnostic agent's queries (a different agent, a different prompt, but the same streaming UX). The left column builds an `EvidencePanel`: the conclusion, the affected-customer callout, the evidence list, the hypotheses considered.

| SHOW (on screen)                                                | SAY (out loud)                                              |
|-----------------------------------------------------------------|-------------------------------------------------------------|
| Click on the USA card. Page navigates. Stepper now shows stage 2 active. Subject banner at top: "investigating: usa purchase_revenue −38.4%". Right column starts a new trace. | "I'm clicking into the USA drop. This is a **different agent now** — the diagnostic one. Its job is to find the cause." |
| Trace shows the diagnostic agent's tool calls scrolling: hypothesis lines, EQL queries against `view_item`, `cart_update`, `session_start`. | "you can see it's testing hypotheses against the data, not guessing. It's checking the funnel — view → cart → checkout — to see where the drop is concentrated." |
| EvidencePanel paints on the left: conclusion text, "affected customers: ~3,400", evidence list with `via execute_analytics_eql`, collapsible hypotheses. | "and it cites its evidence. Every conclusion comes with the exact tool call that produced it, the numbers it saw, and the hypotheses it ruled out — including the ones that didn't pan out." |

You are at roughly 4:30. Hover-show the hypotheses list briefly to make the point that ruled-out hypotheses are surfaced too — that's the "shows its work" promise extended past the happy answer.

```
  ┃ "It cites its evidence. Including the hypotheses that didn't
  ┃  pan out."
```

Click the "see recommendations →" button to advance to stage 3.

  ## Stage 3 — Decision (5:00–6:00)

You land on `app/investigate/[id]/recommend/page.tsx`. The stepper advances. The recommendation agent runs with the diagnosis handed over from stage 2. The trace column lights up again. The left column paints `RecommendationCard`s — each with a Bloomreach feature chip (`scenario` / `segment` / `campaign` / `voucher` / `experiment`), a confidence dot, a rationale, numbered steps, and a highlighted **expected impact** callout.

| SHOW (on screen)                                                | SAY (out loud)                                              |
|-----------------------------------------------------------------|-------------------------------------------------------------|
| Stepper now shows stage 3 active. New trace begins right column. | "stage three — the **recommendation agent**. It takes the diagnosis and proposes a Bloomreach action you can actually take." |
| First recommendation card paints: feature chip `voucher`, title, rationale, numbered steps, expected impact callout glowing. | "it's not 'do something about it.' It's a specific Bloomreach feature, the steps to build it, and an expected impact backed by the segment size from stage 2." |
| Second card paints below: `scenario`. | "and it offers more than one — different feature surfaces, different confidence levels — because the marketer is the one who picks." |

You are at roughly 5:45. Pause. Look at the room.

```
  ┃ "Three stages. Three agents. One streamed trace the whole way
  ┃  through. That's the loop."
```

Then hand off to chapter 03 with: *"that's what it does — here's the one thing under the hood worth ten seconds."*

  ## The IF-IT-BREAKS box — stage 1 fails to stream

╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ The trace column is dead at 1:30 — no events painting, no tool     ║
║ calls. The synthetic data source is choking, the model call is     ║
║ timing out, or the dev server crashed.                             ║
║                                                                    ║
║ → Switch the mode toggle to `demo`. The committed snapshot serves  ║
║   instantly. Same screen, same card, same trace — replayed at      ║
║   140ms intervals so it still LOOKS like it's painting.            ║
║ → Say: "let me show you a run from earlier — same workspace, same  ║
║   data, same trace" and keep the same SAY track running.           ║
║ → The room cannot tell the difference. The demo snapshot is real   ║
║   captured agent output, not a mockup.                             ║
║ → DO NOT try to restart the dev server on stage. DO NOT explain    ║
║   the network. Switch. Move. Keep going.                           ║
╚══════════════════════════════════════════════════════════════════╝

  ## The IF-IT-BREAKS box — stage 2 or 3 hangs

╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ Stage 1 worked, but clicking the card lands on a spinner that      ║
║ never resolves (the agent route timed out, or `useInvestigation`   ║
║ is stuck mid-stream).                                              ║
║                                                                    ║
║ → Hit back. Open a SECOND card on the feed instead. Different ID,  ║
║   different request, usually unblocks.                             ║
║ → If that also hangs: switch the toggle to `demo` and click the    ║
║   same card. The committed snapshot path runs the SAME replayed    ║
║   investigation, filtered to the step, NDJSON streamed at 140ms.   ║
║ → Say: "let me grab one I ran earlier" — once. Then keep going.    ║
╚══════════════════════════════════════════════════════════════════╝

  ## The "tighten it" cut

If you are running long out of stage 1 (you'll know — the money shot landed at 2:45 instead of 2:30, and you're at 4:00 still on the feed), **cut stage 3 entirely.** Skip the recommendation walkthrough. End on stage 2: "I'd show you the recommendation it proposes next, but you've already seen the loop — what changed, why, what to do — and the third agent is the 'what to do.'" The room got the differentiator at the money shot; stage 3 is reinforcement, not the point.

Floor for the demo: **the room must see the streaming trace paint into a real card.** Stages 2 and 3 are cuttable. Stage 1 plus the money shot is not.

Strong-vs-weak side-by-side for the cut decision:

```
  WEAK CUT                              STRONG CUT
  ────────────────────────────────      ───────────────────────────────
  rush through stage 3 in 30s,          end clean at stage 2,
  miss the expected-impact callout,     acknowledge stage 3 in one
  swallow the closing line              line, hand to under-the-hood
                                        on schedule
  → room sees a chaotic finish to       → room sees a confident
    the demo, and you eat into            choice. Same content
    chapter 03's budget                   coverage. Better pacing.
```

  ## The one-page run sheet — the demo

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ RUN SHEET — 02 THE DEMO                    1:00–6:00 (5 minutes) │
  │                                                                  │
  │ STATE BEFORE: browser on localhost:3000, mode = live-synthetic,  │
  │               feed NOT yet loaded (will paint on click)          │
  │               second tab: same URL, mode = demo (warm fallback)  │
  │                                                                  │
  │ STAGE 1 — monitoring (1:00–3:30)                                 │
  │   1:00   click reload / mode toggle to kick the briefing fetch   │
  │   1:00–2:30  trace paints; narrate value, NOT the clicks         │
  │   ★ 2:30  MONEY SHOT — first card paints; say:                   │
  │             "that's it. An analyst that shows its work."         │
  │   2:30–3:30  second card paints; let the trace keep scrolling    │
  │                                                                  │
  │ STAGE 2 — investigation (3:30–5:00)                              │
  │   3:30   click the USA card                                      │
  │   3:30–4:30  diagnostic trace paints; evidence panel builds      │
  │   4:30   point at "hypotheses considered" — including misses     │
  │   5:00   click "see recommendations →"                           │
  │                                                                  │
  │ STAGE 3 — decision (5:00–6:00)                                   │
  │   5:00–5:45  recommendation trace paints; cards paint left       │
  │   5:45   "three stages, three agents, one streamed trace"        │
  │          → hand off to chapter 03                                │
  │                                                                  │
  │ NAIL THIS:  the money shot at 2:30. "An analyst that shows       │
  │             its work."                                           │
  │ IF BREAKS:  switch mode toggle to `demo` in the other tab.       │
  │             Same screen, same trace. No apology.                 │
  │ TIGHTEN:    cut stage 3. End at stage 2 with one line.           │
  ╰──────────────────────────────────────────────────────────────────╯
```
