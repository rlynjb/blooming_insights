# Chapter 1 — The pitch

  ## Opening hook

You are roughly sixty seconds into every senior interview when someone asks "so tell me about a project you've built." This chapter is about doing that in ninety seconds without rambling and without burying the lead. The discipline you're learning is compression — most candidates use this question to talk for four minutes and the interviewer's eyes glaze at minute two. Compression is the senior signal here. You name the shape first, the mechanism second, and the receipt third — then you stop talking and let them drive.

The pitch is harder than it looks, because what you built (`blooming_insights`) does more than one thing: it monitors, it investigates, it recommends, it streams the agents' reasoning into the UI as a first-class surface, it runs on a primitive bridge to a library agent loop, and it survived two backend swaps without changing the caller surface. Every one of those is tempting to lead with. None of them are the lead. The lead is the *shape* — and the rest hangs off it.

  ## The picture you draw first

Before the pitch words, here is the picture that anchors every length below. You will redraw this on the whiteboard while you talk; on remote calls you will name the boxes in order. The interviewer's eye lands on the picture and they stop hearing the words for two seconds — use those two seconds to set up the lead.

```
  The 30-second mental picture — "an analyst that shows its work"

  ┌──────────────────────────────────────────────────────────────┐
  │           the loop a human data analyst runs                  │
  │                                                               │
  │     monitor          investigate          decide              │
  │   ┌─────────┐      ┌─────────────┐      ┌─────────────────┐   │
  │   │ what    │  →   │  why did    │  →   │  what should I  │   │
  │   │ changed │      │  it change  │      │  do about it    │   │
  │   └─────────┘      └─────────────┘      └─────────────────┘   │
  │       │                  │                       │            │
  │       ▼                  ▼                       ▼            │
  │  monitoring         diagnostic              recommendation    │
  │  agent              agent                   agent             │
  │                                                               │
  │  ──────── streamed to the UI as it happens ────────           │
  │  (tool calls, reasoning steps, evidence — not just answer)    │
  └──────────────────────────────────────────────────────────────┘
```

Three steps, three agents, one streamed surface that shows the work. Hold that picture. Every pitch length below is built on it.

  ## The body — three pitches by length

The trick to compressing a project pitch is not to keep cutting words. It's to know which sentences are load-bearing and which are filler, and to delete the filler first. The 90-second pitch has *all* the load-bearing sentences. The 30-second pitch has the load-bearing sentences with no expansion. The 10-second pitch has the single shape sentence and nothing else.

### The 10-second elevator

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Just one sentence — what's the project?"                 │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Can you compress without losing the shape? Most           │
  │   candidates either over-explain or hand you a tagline      │
  │   that's empty calories. The interviewer wants to hear      │
  │   the *thing* in one sentence and know what it is.          │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer (the one you memorize):**

> "It's a multi-agent AI analyst for a Bloomreach ecommerce workspace — it monitors, investigates, and recommends, and it streams the agents' reasoning to the UI as it goes, so you see the work and not just the answer."

That's it. One sentence. Three verbs (monitors, investigates, recommends), the substrate it runs on (Bloomreach ecommerce), and the differentiator (streamed reasoning, not just the answer). Stop talking. They will ask the next question.

```
  ┌─────────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER                 │ STRONG ANSWER                   │
  ├─────────────────────────────┼─────────────────────────────────┤
  │ "It's a Next.js app with    │ "It's a multi-agent AI analyst  │
  │  Anthropic that calls MCP   │ for a Bloomreach ecommerce      │
  │  to pull data from          │ workspace — it monitors,        │
  │  Bloomreach and shows it    │ investigates, and recommends,   │
  │  in a UI."                  │ and it streams the agents'      │
  │                             │ reasoning to the UI as it goes, │
  │                             │ so you see the work and not     │
  │                             │ just the answer."               │
  ├─────────────────────────────┼─────────────────────────────────┤
  │ Why it's weak:              │ Why it works:                   │
  │ Names the stack and the     │ Names what it *does* (the loop  │
  │ wiring but not what it      │ a human analyst runs), who it's │
  │ does. The interviewer       │ for (Bloomreach workspace), and │
  │ now has to ask "okay but    │ the differentiator (streamed    │
  │ what is it for." You've     │ reasoning). The interviewer     │
  │ wasted the opener.          │ now has a real picture to       │
  │                             │ probe.                          │
  └─────────────────────────────┴─────────────────────────────────┘
```

### The 30-second hallway

You're walking with the interviewer between rooms. They asked about the project. You have thirty seconds before you're in front of the next door. Use the picture above as your spine — name the three steps explicitly, name the substrate, name the streaming surface, stop.

**Strong answer (the one you actually use 70% of the time):**

> "It's a multi-agent AI analyst on top of Bloomreach Engagement. A marketer normally has to notice a metric moved, hunt for the cause, and figure out which Bloomreach feature to reach for. This does that proactively, end-to-end — monitoring agent finds the anomalies, diagnostic agent investigates them, recommendation agent proposes a Bloomreach action with expected impact. The whole reasoning trace streams into the UI as it happens, so you see which queries it ran and why — the pitch is 'an analyst that shows its work.'"

Notice what's *not* in that pitch: no framework name, no model name, no MCP, no AptKit, no NDJSON. Those are answers to *follow-up* questions. The pitch is the shape.

### The 90-second pitch (the actual answer to "tell me about a project you built")

This is the version you walk in expecting to use. Ninety seconds, four beats: the problem, the shape, what's interesting under the hood, the receipt.

> "It's called blooming insights — a multi-agent AI analyst built on top of a Bloomreach Engagement ecommerce workspace.
>
> *(beat 1 — the problem)* The user is a marketer or analyst on Bloomreach. Their normal day is: notice a metric moved, hunt for the cause across queries, figure out which Bloomreach feature is the right intervention. That's a loop a human runs, and it's slow and brittle.
>
> *(beat 2 — the shape)* The app runs that loop end-to-end with three agents. Monitoring agent detects significant anomalies in the workspace's ecommerce metrics over a 90-day window — purchases, revenue, funnel conversion. Diagnostic agent picks one anomaly, forms hypotheses, tests them against the data, and sizes the affected customer segment. Recommendation agent proposes a concrete Bloomreach action — scenario, segment, campaign — with steps and expected impact. The whole reasoning trace — tool calls, intermediate steps — streams into the UI as it happens.
>
> *(beat 3 — what's interesting under the hood)* Two things I'd point at. First, the agent loop itself runs on a small open-source primitive bridge — the library owns the loop, the app owns the boundary. Three adapter classes, around two hundred lines total. Second, the data backend sits behind an abstract DataSource seam — I've swapped backends twice without changing the caller surface, including a synthetic in-process adapter I use for development.
>
> *(beat 4 — the receipt)* The whole thing streams as newline-delimited JSON through one shared kernel — same NDJSON contract powers four different streaming surfaces in the UI. And every claim the agents make carries provenance: the exact tool calls, the current-vs-prior numbers, a full streamed log of the agent's thinking."

That's roughly ninety seconds spoken at normal pace. Four beats. The picture you drew at the top is the spine. If they interrupt at beat 2 to ask about agents, you're already in chapter 2 territory — that's fine, you walk them through the architecture next.

```
  ┃ "An analyst that shows its work."
  ┃ That's the pitch. Everything else is detail.
```

  ## Where they interrupt

The follow-ups branch on which beat caught their ear. You should know the branches before you walk in.

```
  After the pitch — where they go next
        │
        ▼
  You delivered the 90-second pitch.
        │
        ├─► IF THEY INTERRUPT AT BEAT 2 ("which agents?")
        │     You're going to Chapter 2 — the architecture.
        │     Pull up the system-at-a-glance diagram from
        │     the overview. Walk the four boxes.
        │
        ├─► IF THEY INTERRUPT AT BEAT 3 ("which primitive?")
        │     You're going to Chapter 3 — the choices.
        │     The answer is @aptkit/core@0.3.0; the three
        │     adapters live at lib/agents/aptkit-adapters.ts.
        │
        ├─► IF THEY INTERRUPT AT BEAT 3 ("DataSource seam?")
        │     Still Chapter 3. The seam lives at
        │     lib/data-source/types.ts; two adapters live
        │     beside it (Bloomreach + Synthetic).
        │
        └─► IF THEY ASK "WHY THIS PROBLEM?"
              You're being read for product sense. The honest
              answer is the loomi connect MCP server made the
              loop possible — when you can query a workspace
              with tool calls instead of a dashboard, an agent
              can BE the analyst.
```

  ## When you don't know

The hardest part of the pitch isn't delivering it. It's when the interviewer asks about a substrate detail you weren't ready for during the opener.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask, mid-pitch: "how does Bloomreach pricing scale     ║
  ║   for the kind of workspace you're targeting?"                ║
  ║                                                               ║
  ║   You haven't priced Bloomreach. You built against an alpha   ║
  ║   server and never had a billing conversation.                ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I haven't looked at Bloomreach pricing — I built this      ║
  ║    against their alpha MCP server, which doesn't have a       ║
  ║    public pricing surface. What I can tell you is the         ║
  ║    rate-limit constraint I designed around — roughly one      ║
  ║    request per second — and the auth lifetime, which is       ║
  ║    minutes. Both of those shape the live experience way       ║
  ║    more than per-query cost would. Want me to walk that?"     ║
  ║                                                               ║
  ║   What this signals: confidence about what you do know        ║
  ║   (the operational constraints you actually designed for),    ║
  ║   no fake confidence about what you don't (pricing), and      ║
  ║   a redirect to something material. All three are senior      ║
  ║   signals.                                                    ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "I think it's around X per query, depending on..." —        ║
  ║   guessing pricing numbers you don't have is a credibility    ║
  ║   collapse. The interviewer will check; you'll be wrong.      ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change about the pitch itself

If you were redoing this project today, you would lead with the streaming-reasoning surface even harder than you do. That is the part interviewers reliably stop the pitch to ask about — it is the differentiator from "another LLM app that calls an API and shows the result." You currently bury it at the end of beat 2. Move it to beat 1: *"It's an AI analyst that shows its work — every tool call, every intermediate step streams into the UI as the agent runs."* Then walk the loop. Same content; load-bearing line up front.

  ## One-page summary

**Core claim:** the pitch is the shape, not the stack. Lead with what the system *does* (the analyst loop) and the differentiator (streamed reasoning), not what it's built with.

**Questions covered:**
- *"Just one sentence — what's the project?"* → multi-agent AI analyst for a Bloomreach workspace; monitors, investigates, recommends; streams reasoning as it goes.
- *"Tell me about a project you built"* → the 90-second four-beat pitch: problem, shape, what's interesting under the hood, the receipt.
- *"What's Bloomreach pricing like?"* → I don't know; redirect to the operational constraints you actually designed for (rate limit, auth lifetime).

**Pull quotes:**
```
┃ "An analyst that shows its work — that's the pitch.
┃  Everything else is detail."
```
```
   ▸ The 10-second version is the load-bearing sentences with
     nothing expanded. The 90-second version is the same sentences
     with the expansion plugged in.
```

**What you'd change:** lead with the streamed-reasoning surface in beat 1, not the end of beat 2. That's the part interviewers reliably stop the pitch to ask about.
