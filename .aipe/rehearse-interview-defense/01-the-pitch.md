# Chapter 1 — The pitch

In the first ninety seconds of every senior interview, someone says "tell me about a project you built." The candidates who fail this part don't fail by saying the wrong thing — they fail by saying *everything*. They list features. They explain their stack. They narrate two months of development. By the time they stop talking, the interviewer has stopped listening.

This chapter is about compression. You're going to learn the project in three lengths: ten seconds, thirty seconds, ninety seconds. Each is a different conversation. The ten-second pitch is the hallway. The thirty-second pitch is the recruiter screen. The ninety-second pitch is the actual answer to "walk me through what you built" — and it has a precise shape with a hook, a load-bearing detail, and a hand-off to the interviewer's next question.

## The project at a glance

The visual anchor for everything that follows. If you only remember one picture from this chapter, remember this one — it's the shape of the pitch.

```
  blooming insights — the project on one page

  WHO USES IT
  ┌────────────────────────────────────────────────────────────┐
  │  A marketer/analyst on Bloomreach Engagement                │
  │  (an ecommerce CDP — customers, events, revenue, catalogs)  │
  └────────────────────────────────────────────────────────────┘

  THE LOOP IT AUTOMATES
  ┌─── what changed ───┐  ┌─── why ────────┐  ┌─── what to do ──┐
  │ monitoring agent   │→ │ diagnostic     │→ │ recommendation  │
  │ 90-day window      │  │ agent (forms + │  │ agent (scenario │
  │ period-over-period │  │ tests hypoth.) │  │ /segment/camp.) │
  │ on EQL metrics     │  │ cites evidence │  │ + expected impact│
  └────────────────────┘  └────────────────┘  └─────────────────┘

  THE INTERESTING TECHNICAL CLAIM
  ┌────────────────────────────────────────────────────────────┐
  │  Three agents · streamed reasoning trace as a               │
  │  first-class UI surface (NDJSON over fetch)                 │
  │  · two-adapter data-source seam (Bloomreach / Synthetic)    │
  │  · third-party agent runtime (AptKit) behind a 3-class      │
  │    adapter boundary I own                                   │
  └────────────────────────────────────────────────────────────┘

  THE STACK
  ┌────────────────────────────────────────────────────────────┐
  │  Next.js 16 (App Router) · React 19 · TS · Sonnet 4.6 ·    │
  │  @aptkit/core@0.3.0 · MCP over OAuth PKCE+DCR · Vercel     │
  └────────────────────────────────────────────────────────────┘
```

That picture is the spine. Every pitch length below pulls from it.

## The ten-second pitch

The hallway answer. Someone you've just met asks "what have you been working on." You have time for one sentence — two if the first lands well.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What have you been working on?"              │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you compress without losing the           │
  │   load-bearing detail? Most engineers either    │
  │   say "an AI app" (no signal) or open the dev   │
  │   tools and read out their package.json.        │
  └─────────────────────────────────────────────────┘
```

Strong answer, in your voice:

> "I built **blooming insights** — a multi-agent AI analyst that sits on top of a Bloomreach ecommerce workspace and runs the loop a human analyst would: what changed, why, what to do."

That's it. One sentence, one cadence (`what changed → why → what to do`), one named system. If they want more, they'll ask. The strongest signal you can send in ten seconds is that you can stop talking.

```
  ┃ "Run the loop a human analyst would: what
  ┃  changed, why, what to do."
```

## The thirty-second pitch

The recruiter screen. The fly-by from a panel interviewer who hasn't read your resume. You have three or four sentences.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Tell me about a project from your portfolio."│
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you frame the technical interest in       │
  │   under a minute? Do you know what's actually   │
  │   novel about what you built vs the table       │
  │   stakes?                                       │
  └─────────────────────────────────────────────────┘
```

Strong answer:

> "I built **blooming insights** — a multi-agent AI analyst for a Bloomreach ecommerce workspace. Three agents — monitoring, diagnostic, recommendation — run the analyst loop: what changed, why, what to do. The interesting piece is the streaming surface: the agents' reasoning trace is a first-class UI element, so the user sees not just the conclusion but every tool call and hypothesis along the way. Next.js 16, Anthropic Sonnet, MCP over OAuth — and the agent runtime is **AptKit** behind a small adapter boundary I own."

Four sentences. Each one earns its place: the *what*, the *loop*, the *technical claim*, the *stack with the load-bearing detail*. Notice what's not there: the file layout, the data model, the test count, the demo mode. Save those for the ninety-second pitch.

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK 30-SEC PITCH       │ STRONG 30-SEC PITCH     │
  ├─────────────────────────┼─────────────────────────┤
  │ "It's a Next.js app     │ "I built blooming        │
  │ that uses Claude to     │ insights — a multi-      │
  │ analyze ecommerce data. │ agent AI analyst for a   │
  │ It's got monitoring     │ Bloomreach ecommerce     │
  │ and recommendations and │ workspace. Three agents  │
  │ a chat box. The agents  │ run the analyst loop:    │
  │ stream their reasoning. │ what changed, why, what  │
  │ It uses MCP to talk to  │ to do. The interesting   │
  │ Bloomreach over OAuth.  │ piece is that the        │
  │ I also have a demo mode │ reasoning trace is a     │
  │ that replays a snapshot │ first-class UI surface."  │
  │ for reliability..."     │                          │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Feature list, no shape. │ Names the *loop*, then  │
  │ The reader can't tell   │ the *technical claim*.  │
  │ what's interesting from │ Compresses without      │
  │ what's table-stakes.    │ losing what makes it    │
  │ The "I also" reads as a │ worth talking about.    │
  │ candidate who can't     │ Sets up the next        │
  │ stop adding.            │ question.               │
  └─────────────────────────┴─────────────────────────┘
```

The trap in the weak version is the urge to enumerate. Three agents, MCP, demo mode, reasoning trace — they're all real, but listed without a frame they sound like a brochure. The strong version puts one frame on top (the loop) and one technical claim underneath (the streamed trace as a UI surface). The interviewer now has a hook to pull on.

## The ninety-second pitch — the real one

This is the answer you give when an interviewer says "walk me through what you built." It has four parts, in order, each landing in roughly 20–25 seconds: **opener** (what and for whom), **the loop** (the analyst loop the system runs), **the interesting bit** (the technical claim that earns the conversation), and **the hand-off** (a sentence that hands the interviewer a thread to pull). Then you stop.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Walk me through a project you built."        │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you hold the wide-opener for 90 seconds   │
  │   without losing structure? Do you know what's  │
  │   load-bearing vs decorative in your own work?  │
  │   Will you hand me a thread to pull, or will I  │
  │   have to find one?                             │
  └─────────────────────────────────────────────────┘
```

The strong ninety-second answer, written so you can read it aloud and time it:

> **(Opener, ~20s)** "I built **blooming insights** — a multi-agent AI analyst that runs on top of a Bloomreach Engagement workspace. The user is a marketer or analyst who normally has to notice a metric moved, hunt for why, and figure out which Bloomreach feature to reach for. blooming insights does that proactively and end-to-end.
>
> **(The loop, ~25s)** "It runs the loop a human analyst would run: **what changed, why, what to do**. There are three agents wired in series. The monitoring agent scans the workspace, runs period-over-period on a 90-day window, and surfaces anomalies. The diagnostic agent picks one and tests hypotheses against the data, citing evidence. The recommendation agent proposes a concrete Bloomreach action — a scenario or a segment or a campaign — with an expected impact and a confidence level.
>
> **(The interesting bit, ~25s)** "The technical piece I'm proudest of is that the agents' reasoning is a first-class UI surface, not a log file. As each agent runs, it streams NDJSON to the browser — every tool call, every hypothesis, every conclusion — and the UI renders it live in a sticky sidebar. So the product's pitch is *an analyst that shows its work*. Under the hood the agent runtime is a small library called **AptKit**, and I own the boundary to it through three adapter classes — about two hundred lines — so the loop is the library's and the boundary is mine.
>
> **(The hand-off, ~15s)** "There are a few corners I'd be happy to walk through — the data-source seam that lets me swap Bloomreach for a synthetic adapter, the eval suite I built and then retired, or the streaming kernel that's shared across four surfaces. Where would you like to start?"

That's ninety seconds. The hand-off at the end is the most senior-feeling move in the whole pitch: it gives the interviewer three threads, each of which routes to a different chapter of this book. They pick one. You walk it.

```
  ┃ "The product's pitch is an analyst that shows
  ┃  its work."
```

## The hand-off — where the interview goes next

The last sentence of your ninety-second pitch determined the next ten minutes. Walk the branches so you're not surprised.

```
  Your hand-off offers three threads.
        │
        ▼
  Interviewer picks one of:
        │
        ├─► "The data-source seam"
        │     → goes to Chapter 3, Choice 3 (DataSource)
        │       and Chapter 4 (scale — what swap costs)
        │
        ├─► "The eval suite you retired"
        │     → goes to Chapter 6 (hard parts — least
        │       confident) and Chapter 8 (the AI
        │       question)
        │
        └─► "The shared streaming kernel"
              → goes to Chapter 2 (architecture)
                and Chapter 6 (hard part — StrictMode)
```

If they don't pick — if they say "let's start with the architecture" — that's the gift answer. Go to Chapter 2.

## When you don't know

Most "I don't know" moments in a pitch come from one of two places: a question about a number you don't have ("how many users?") or a question about a feature you cut ("what about real-time?"). Both have a clean recovery.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "How many users do you have?"     ║
  ║                                               ║
  ║   The honest answer is that you don't, and    ║
  ║   the pitch is about the system, not about    ║
  ║   traction. Don't invent a number.            ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "It's a portfolio project — no production   ║
  ║    traffic. The interesting scale question    ║
  ║    isn't user count, it's that the alpha      ║
  ║    Bloomreach server is rate-limited and      ║
  ║    revokes tokens after minutes. The system   ║
  ║    is designed around that, not around user   ║
  ║    load. Want me to walk you through what     ║
  ║    that forced?"                              ║
  ║                                               ║
  ║   What this signals: you know the real        ║
  ║   constraint, you don't fake traction, and    ║
  ║   you re-route the question to a thread       ║
  ║   you can actually defend.                    ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "It's still early but we're seeing strong   ║
  ║    early adoption from the marketing teams    ║
  ║    we've shown it to." This is fabrication.   ║
  ║   An interviewer will hear it and stop        ║
  ║   trusting the rest of the pitch.             ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change in the pitch

If you were giving this pitch six months from now, the one thing you'd add is a real production number. Not a fake one — a real one from one of the synthetic-adapter eval runs. Something like "across N anomalies the diagnostic agent's recommendations cleared the rubric on M%." Right now the pitch is honest about being a portfolio project, and that's fine. The next version earns one more sentence of credibility by leading with a number you can defend down to the methodology.

## One-page summary

**Core claim:** A good pitch is the project compressed three ways — ten seconds for the hallway, thirty for the recruiter, ninety for the actual interview. Each version has a different job and a different stop point.

**Questions covered:**
- "What have you been working on?" → one-sentence answer naming the system and the loop.
- "Tell me about a project from your portfolio." → four sentences: what, loop, technical claim, stack-with-detail.
- "Walk me through what you built." → 90 seconds in four parts (opener · loop · interesting bit · hand-off).
- "How many users do you have?" → honest "portfolio project," re-route to the real constraint.

**Pull quotes:**
```
  ┃ "Run the loop a human analyst would: what
  ┃  changed, why, what to do."

  ┃ "The product's pitch is an analyst that shows
  ┃  its work."
```

**What you'd change:** lead the next version of the pitch with one real number from the synthetic-adapter eval runs, defendable down to the methodology.
