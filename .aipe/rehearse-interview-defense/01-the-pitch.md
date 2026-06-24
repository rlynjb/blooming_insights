# Chapter 1 — The pitch

In the first five minutes of every interview, someone says "tell me about a project you built." How you answer the next ninety seconds sets the frame for everything after it. Get it tight and the interviewer leans in and starts asking *your* questions, on *your* terrain. Ramble and you spend the rest of the hour being rescued.

This chapter gives you blooming insights in three lengths — ten seconds, thirty seconds, ninety seconds — and teaches the discipline of compression. You are a frontend engineer who built a multi-agent AI system; the pitch has to land both halves without drowning in either. The goal is not to say everything. It is to say the one shape that makes the interviewer want the rest.

## The project at a glance

Before you can compress it, hold the whole thing in one picture — this is what every pitch length is carving down from.

```
  blooming insights — "an analyst that shows its work"
  ════════════════════════════════════════════════════════════════════

   THE LOOP a human analyst runs                  THE PRODUCT
   ─────────────────────────────                  ───────────────────────
     what changed?  ──►  monitoring   ─┐          a feed of ranked
          │                            │           anomaly cards,
          ▼                            │           each one click-through
        why?       ──►  diagnosis     ─┼──►        to a streamed
          │                            │           investigation +
          ▼                            │           a recommended
     what to do?   ──►  decision      ─┘           Bloomreach action

   GROUNDED IN                       SHOWN AS
   ───────────                       ────────
     Bloomreach loomi MCP              every conclusion carries its
     ad-hoc EQL queries                provenance — the exact queries,
     (no saved dashboards)             the current-vs-prior numbers,
     90d-vs-prior-90d method           a live-streamed log of the
                                       agent's reasoning

   STACK                             SHAPE
   ─────                             ─────
     Next.js 16 · React 19            4 agents · shared runtime
     Anthropic claude-sonnet-4-6      NDJSON streamed to the UI
     MCP SDK · NDJSON · no DB         demo / live-bloomreach /
                                      live-synthetic (3-way toggle)
```

Everything below is this picture, said at three zoom levels.

---

## The 10-second version (the elevator)

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "So what did you build?" (half-listening, still reading     │
> │    your resume)                                               │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Can you compress? Do you know what the project actually     │
> │   *is*, stripped of every feature you're proud of? The        │
> │   ten-second answer is the hardest one to write.              │
> └─────────────────────────────────────────────────────────────┘

In your voice, out loud:

▸ "blooming insights is an AI analyst for a Bloomreach ecommerce workspace. It watches the metrics, finds what changed, works out why, and proposes the fix — and it streams its reasoning to the screen, so you see *how* it got there, not just the answer."

That's it. One sentence of what, one clause of what makes it different. You do not say "Next.js" in the ten-second version. You do not say "multi-agent." You say what it *does for a person*, then stop and let them pull.

```
┃ "An analyst that shows its work." If you only get one
┃  sentence, that's the one. It's the whole product.
```

---

## The 30-second version (the hallway)

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Tell me a bit more — how does it work?"                    │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Can you go one layer down without dumping the whole stack?  │
> │   Do you have a *structure* in your head, or a pile of        │
> │   features? They want to hear the shape, not the tour.        │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"It runs the loop a human analyst runs — *what changed, why, what to do* — as three stages. A monitoring agent scans the workspace for anomalies and ranks them by severity. Click one and a diagnostic agent investigates the cause, forming and testing hypotheses against the real data. Then a recommendation agent proposes a concrete Bloomreach action — a campaign, a segment, an experiment — with an expected impact. The thing I care most about is that every step streams its reasoning to the UI as it happens: which queries it ran, the actual numbers, the hypotheses it ruled out. It's an analyst that shows its work."

Thirty seconds, three stages, one differentiator. Notice what you still haven't said: the framework, MCP, the agent loop, the demo toggle. You're holding those in reserve as answers to questions you *want* them to ask.

---

## The 90-second version (the real answer)

This is the one you rehearse until it's boring. Most candidates ramble here because they try to fit everything; you're going to deliver a structured arc — problem, shape, one hard part, one honest edge — and land it.

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Walk me through a project you're proud of."                │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Can you tell a complete story with a beginning (the         │
> │   problem), a middle (what you built and why), and a          │
> │   senior-flavored ending (a tradeoff you'd own)? Do you       │
> │   sound like you understand it, or like you're reciting it?   │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"A marketer on Bloomreach has to do three things by hand: notice a metric moved, hunt for the cause, and figure out which Bloomreach feature to reach for. blooming insights does that loop end-to-end and proactively.

It's a Next.js 16 app built on Bloomreach's loomi connect MCP server, with a Blooming-owned synthetic adapter behind the same interface so the live path works without the upstream. There are no saved dashboards in the workspace, so every metric is computed ad-hoc with EQL — which means the agents have to decide *what* to query. There are four agents — monitoring, diagnostic, recommendation, and a free-form query agent — running claude-sonnet-4-6 on a shared agent runtime; I started with a hand-rolled loop and migrated the active path to a generic agent library, keeping three small adapter classes on my side that hide the Anthropic SDK, the data source, and the streaming hooks behind library primitives. Monitoring runs a fixed checklist of ecommerce anomaly categories, but only after a gate checks which categories the workspace's event schema can actually support — so it never wastes a query on data that isn't there.

The part I'm proudest of is that the reasoning is a first-class UI surface. As an agent works, the exact EQL it runs, the current-vs-prior numbers, and its hypotheses stream to a side panel over NDJSON. You're not looking at a spinner and then an answer — you watch the analysis happen.

The honest edge: it has no database. State lives in memory, with a committed demo snapshot for a creds-free presentation path. That was the right call for a hackathon against an alpha MCP server that revokes tokens after a few minutes — but it's the first thing I'd change for real multi-user use."

That last paragraph is the move. You volunteered the weakness *and* the reason it was right *and* what you'd change — in one breath, before they asked. That is the single highest-signal thing you can do in a pitch.

```
        ▸ End the 90-second pitch on a tradeoff you'd own.
          It tells the interviewer you're senior before
          they've asked a single follow-up.
```

### Weak vs strong: the same project, two pitches

The difference between a pitch that works and one that sinks is almost never the project. It's the compression.

```
┌──────────────────────────────────┬──────────────────────────────────┐
│ WEAK PITCH                        │ STRONG PITCH                      │
├──────────────────────────────────┼──────────────────────────────────┤
│ "It's a Next.js app that uses     │ "It's an AI analyst for a         │
│  AI and the Bloomreach API and    │  Bloomreach ecommerce workspace.  │
│  it has agents and streaming and  │  It finds what changed, diagnoses │
│  a coverage grid and a demo mode  │  why, and proposes the fix — and  │
│  and OAuth and it caches things   │  streams its reasoning so you see │
│  and..."                          │  how it got there."               │
├──────────────────────────────────┼──────────────────────────────────┤
│ Why it's weak:                    │ Why it works:                     │
│ a feature list, not a shape. The  │ leads with what it does for a     │
│ interviewer can't tell what       │ person, names the one             │
│ matters. Every noun has equal     │ differentiator, and stops. It     │
│ weight, so none of them land.     │ invites the follow-up instead of  │
│ You sound like you're listing     │ pre-empting it. You sound like    │
│ your commit history.              │ you know what the project IS.     │
└──────────────────────────────────┴──────────────────────────────────┘
```

### Where the conversation goes after the pitch

A good 90-second pitch is bait. You've named four or five threads; the interviewer will pull one. Know where each leads so you're never surprised by your own pitch.

```
You deliver the 90-second pitch.
        │
        ▼
  ├─► IF THEY PULL "four agents on one loop"
  │     → go to Chapter 2 (architecture). Draw the shared
  │       runAgentLoop and the four agents hanging off it.
  │
  ├─► IF THEY PULL "no database"
  │     → go to Chapter 3 (choices) + Chapter 7 (counterfactuals).
  │       This is the tradeoff you teed up on purpose — you have
  │       a full answer ready.
  │
  ├─► IF THEY PULL "streams its reasoning"
  │     → go to Chapter 2/3. NDJSON over a ReadableStream,
  │       consumed by a fetch reader, not EventSource. Have the
  │       "why not EventSource" answer loaded.
  │
  └─► IF THEY PULL "AI agents / did you use AI to build it"
        → go to Chapter 8. Matter-of-fact, three decision modes,
          no defensiveness.
```

You are never caught off guard, because you chose the threads.

---

╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   You say "it's built on the loomi connect MCP server" and    ║
║   the interviewer asks, in the first two minutes, "what's     ║
║   MCP exactly, at the protocol level?" — before you've even   ║
║   finished the pitch.                                         ║
║                                                               ║
║   Say:                                                        ║
║   "MCP is the Model Context Protocol — a standard way for an  ║
║    LLM app to call external tools and data sources. I use     ║
║    Anthropic's MCP SDK to talk to Bloomreach's server, so I   ║
║    work at the SDK level — listing tools, calling them with   ║
║    arguments, handling the OAuth. I haven't gone to the wire  ║
║    format of the protocol itself. Want me to walk the SDK     ║
║    layer I actually built on, or is the protocol the part     ║
║    you're after?"                                             ║
║                                                               ║
║   What this signals: you know exactly where your knowledge    ║
║   ends, you're fluent at the layer you actually worked, and   ║
║   you hand the interviewer the choice instead of bluffing.    ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "It's like... a protocol for AI to use tools, with          ║
║    messages back and forth, JSON-RPC I think, over a          ║
║    stream..." — trailing into half-remembered protocol        ║
║   detail in your opening minutes is the fastest way to lose   ║
║   the frame you just built.                                   ║
╚═══════════════════════════════════════════════════════════════╝

---

## What you'd change

If you rebuilt the pitch itself, you'd cut the word "agents" from the thirty-second version. It's a magnet for "so what's an agent?" debates that pull you off the product and into definitions before you've established what the thing *does*. The strongest version of this pitch sells the analyst's loop first — what changed, why, what to do — and lets "multi-agent" arrive as the *answer* to "how is it built," not as part of the headline. Lead with the human job; let the architecture be something they have to ask for.

---

## One-page summary (night-before review)

**Core claim:** The pitch sells the *job* the product does for a person — find what changed, diagnose why, propose the fix, and show its work — and saves the architecture as bait for the follow-up.

**The three lengths:**
- **10s** — "An AI analyst for a Bloomreach ecommerce workspace that finds what changed, diagnoses why, proposes the fix, and streams its reasoning so you see how it got there."
- **30s** — the above + the three-stage loop (monitoring → diagnosis → decision) and the "shows its work" differentiator. No stack names yet.
- **90s** — problem (analysts do this by hand) → shape (4 agents on one loop, gated by schema coverage, claude-sonnet-4-6, MCP/EQL) → proudest part (reasoning as a first-class streamed surface) → honest edge (no DB; right for the context, first thing you'd change).

**Pull quotes:**
- "An analyst that shows its work." — the whole product in one sentence.
- End the 90-second pitch on a tradeoff you'd own — it signals senior before the first follow-up.

**What you'd change:** Cut "agents" from the 30-second version; let "multi-agent" arrive as the answer to "how's it built," not part of the headline.

---
