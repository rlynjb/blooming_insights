# 06 — The Q&A   (post-clock · prep only)

  ## Opening hook

The buzzer went off. The room reacted. Now the judges have
ninety seconds to two minutes of questions. This chapter is the
prep — it does NOT count against your ten-minute slot. Read it
the night before, hold the run sheet during Q&A.

The discipline that wins Q&A: answer the question that was
asked, in one to three sentences, then stop. Most presenters
hear a question and unload the entire architecture in response.
Don't. Each answer here is a tight three-beat structure: the
direct answer, the specific evidence from the repo, the stop.

The eight probes below are the ones judges ALWAYS ask — at
hackathons, at demo days, at internal showcases. They're
predictable. Knowing the answer cold means you spend Q&A
listening instead of scrambling.

  ## The time-budget bar

This chapter runs AFTER the clock. No time budget — the
moderator runs Q&A. Your job is to be ready.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ───────────────────────────────────────────── 10:00 │
  │                                                            │
  │   Q&A — runs AFTER 10:00 · ~90 seconds of questions       │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the answer pattern

Every answer in Q&A follows the same three-beat shape. Internalize
this — it keeps you from rambling under pressure.

```
  the answer pattern · three beats, then stop

  BEAT 1  DIRECT          one sentence · answer the actual
                          question · no preamble
                                    │
                                    ▼
  BEAT 2  EVIDENCE        one sentence · one specific repo
                          anchor · a file, a number, a real
                          choice you made
                                    │
                                    ▼
  BEAT 3  STOP            silence · let the judge follow up if
                          they want · NEVER fill the silence

  total: 2 sentences, ~15 seconds per answer.
  goal: 4-5 answers in the Q&A window, not 1-2 monologues.
```

The hardest beat is beat 3. Stopping after two sentences feels
unfinished. It isn't. The judge asked, you answered, the
follow-up belongs to them. If they want more, they'll ask.

  ## Probe 1 — "Is this actually working? Or is the demo canned?"

The most important question to answer correctly. The default
mode is demo (cached replay), but the snapshot is real — it was
captured from a live agent run. The live mode runs the real
agents against the real workspace right now. You own this
matter-of-factly.

```
  ┃ "the demo mode is a cached replay of a live agent run from
  ┃  this morning — same UI, same data, same EQL queries. live
  ┃  mode in the header runs the agents against bloomreach in
  ┃  real time; i defaulted to demo for the slot because the
  ┃  alpha server rate-limits and a live investigation takes
  ┃  about two minutes."
```

If they push: offer to switch to live for them after the demos.
Don't switch on stage. The route in `app/api/briefing/route.ts`
makes the demo-vs-live decision based on the `?demo=cached`
query string; both paths emit the same NDJSON event stream.

  ## Probe 2 — "What was the hard part?"

Answer it the same way you answered it in chapter 4. The hard
part has a chosen name; use the same name twice so it sticks.

```
  ┃ "the schema gate. the first version would happily run a
  ┃  cart-abandonment check on a workspace that didn't emit
  ┃  cart events — wasted call, false coverage. the gate is
  ┃  three pure functions in lib/agents/categories.ts that
  ┃  compare the live schema to each category's required and
  ┃  enriching deps, and only the runnable ones get handed
  ┃  into the agent prompt."
```

If they want more: the gate also drives the coverage grid UI,
so the user sees the same honesty the agent gets. The faded
tiles on the feed are not styling; they're real "this workspace
doesn't have it" signals.

  ## Probe 3 — "What's the stack?"

Specific, no padding. Versions only if asked.

```
  ┃ "Next.js 16 App Router, React 19, TypeScript, Tailwind for
  ┃  styling. Anthropic SDK for the model — claude sonnet 4.6.
  ┃  Bloomreach via the MCP SDK with OAuth and dynamic client
  ┃  registration. NDJSON over a Next.js streaming response
  ┃  bridges the agent loop to the React UI."
```

If they push on infrastructure: vercel for hosting,
encrypted-cookie session store for cross-instance OAuth state,
in-process MCP client with rate-limit retry and a 60s response
cache. Files: `lib/mcp/client.ts`, `lib/mcp/auth.ts`,
`lib/mcp/connect.ts`.

  ## Probe 4 — "Did you build this during the hackathon?"

Own it. Don't defend.

```
  ┃ "yes — the agents, the schema gate, the streaming routes,
  ┃  the coverage grid, the investigate flow. the bones are
  ┃  the next.js scaffold, the MCP SDK, and the anthropic
  ┃  SDK; everything app-specific is hackathon-window code."
```

If they're skeptical: the git history shows the build order —
the most recent commits are the coverage grid, the diagnostic
time-series query, the tier-1/tier-2 UI enrichment. The full
log is in the repo. You wrote the architecture decisions; you
wrote the prompts; you wrote the streaming protocol; you wrote
the schema gate.

  ## Probe 5 — "Is there a business here? What's next?"

This is the vision-and-ask repeat. Don't restate chapter 5;
answer the question fresh.

```
  ┃ "the business is selling agent-driven monitoring as an
  ┃  add-on to existing ecommerce stacks — the workspace is
  ┃  the customer, the agent is the product. next steps are
  ┃  scheduled briefings, slack delivery, multi-workspace
  ┃  from one login. the ask is fifteen minutes with anyone
  ┃  here who runs a bloomreach workspace."
```

If they push on go-to-market: honest answer — "I haven't
validated price yet; the smallest interesting version is a $99
flat monthly that turns one workspace's analytics into a daily
slack briefing." Don't pretend you have a pricing deck. You
shipped a working agent in a weekend; that's the credibility.

  ## Probe 6 — "Did you use AI to build it?"

In 2026 every judge assumes the answer is yes. The judges who
ask this aren't trying to catch you — they want to see how you
talk about it. Own it directly. Defensiveness reads worse than
candor.

```
  ┃ "yes — heavily. claude code wrote a lot of the boilerplate,
  ┃  helped me iterate on the prompts, and pair-programmed the
  ┃  streaming pipeline. the architecture decisions are mine —
  ┃  picking MCP because bloomreach already speaks it, the
  ┃  schema gate as a real subsystem, the rate-limit handling
  ┃  built around the alpha server's actual penalty window.
  ┃  shipping in a weekend without AI assistance in 2026 would
  ┃  be a worse signal, not a better one."
```

If they push: which parts were you, which parts were the
model? Be specific. The agent prompts in
`lib/agents/prompts/*.md` are co-written — you set the
structure, the model iterated on the wording. The architectural
choices (MCP, NDJSON streaming, schema-gated coverage) are
yours; you can defend each one with what would break otherwise.
The hard debugging (cross-instance OAuth state, the request-vs-
response cookie split in `lib/mcp/auth.ts`) is also yours.

  ## Probe 7 — "Why MCP? Why not just call the Bloomreach API directly?"

Engineers in the room will ask this. The answer is structural —
MCP isn't faster, it's the right primitive when the model
itself is calling the tools.

```
  ┃ "two reasons. one, bloomreach already exposes their alpha
  ┃  via MCP — the tools are already typed, already documented,
  ┃  and claude can read the schema and pick the right one
  ┃  without me hand-rolling adapters. two, MCP is the protocol
  ┃  the industry is converging on for model-to-tool calls; if
  ┃  bloomreach adds tools tomorrow, my agent picks them up
  ┃  without a code change."
```

If they push on the cost: a small one. The MCP layer adds JSON-
RPC framing on top of HTTP and the SDK's auth flow is its own
debugging story (the comments in `lib/mcp/connect.ts` mark
points that needed live verification). Worth it.

  ## Probe 8 — "What happens when the agent gets it wrong?"

The "trust" question. Two parts to the answer: how the agent
shows its work, and what happens on the failure modes you've
seen.

```
  ┃ "the trace is the answer to half of it — every reasoning
  ┃  step and every tool call streams into the status log, so
  ┃  the user can see exactly what the agent looked at. the
  ┃  diagnosis also carries a confidence rating that gets
  ┃  downgraded if any tool calls errored. on the failure
  ┃  modes i've actually seen: rate-limit retries, the model
  ┃  refusing to emit JSON until i added a forced-synthesis
  ┃  turn, and the cached snapshot replaying when the alpha
  ┃  server revokes the token mid-investigation."
```

If they push on hallucination specifically: the diagnostic
agent's synthesis call (`lib/agents/diagnostic.ts`) is
tool-less and hands the model only the evidence already
gathered, then asks for a structured Diagnosis. The validator
in `lib/mcp/validate.ts` parses the JSON and falls back to a
"insufficient data" diagnosis if it can't. Hallucinated numbers
are bounded — the model is reading from real tool results, not
guessing them. What I don't have yet is a real eval — a goldset
of hand-curated cases with a judge that scores diagnosis quality
against ground truth. That's the next engineering move and
there's a drill spec for it in `.aipe/drills/`.

  ## The followup decision tree

Some probes have predictable follow-ups. Be ready to take ONE
follow-up cleanly; redirect a second follow-up to "happy to dig
in after."

```
  the follow-up tree — answer one, defer the second

  probe lands  →  give the two-sentence answer
                      │
                      ▼
                first follow-up  →  give ONE more specific
                  arrives             sentence with a file or
                                      a number
                                          │
                                          ▼
                                  second follow-up  →  "happy
                                    arrives             to dig
                                                        in
                                                        after
                                                        the
                                                        demos"
                                                        ← redirect
```

The "happy to dig in after" line is not a dodge. It's
respect for the time of the other presenters. The judges
notice. Two minutes of one demo's Q&A is fair; five minutes is
the next presenter's slot. Defer cleanly.

  ## Strong vs weak — the Q&A failure mode

The mistake is unloading the architecture in response to every
question. Two sentences land; ten sentences lose them.

```
  WEAK Q&A ANSWER                   STRONG Q&A ANSWER
  ─────────────────────────────     ─────────────────────────────
  judge: "what was the hard         judge: "what was the hard
   part?"                            part?"
                                    
  "well, there were a lot of        "the schema gate. the first
   hard parts honestly, like         version would happily run
   the OAuth flow was really         a cart-abandonment check on
   tricky because vercel uses        a workspace that didn't
   ephemeral instances and the       emit cart events. the gate
   PKCE verifier needed to           is three pure functions that
   survive across the connect        compare the live schema to
   and callback requests, and        each category's deps."
   then the rate limiting was       
   another one, and the JSON         (stop · let them follow up)
   parsing was tricky because…"
  ─────────────────────────────     ─────────────────────────────
  judge stops listening at          judge has space to ask
  sentence 3                        the follow-up they want
  ─────────────────────────────     ─────────────────────────────
  uses up the whole Q&A             leaves room for 3-4 more
  window on one question            questions
```

Two sentences. Then stop. The discipline IS the answer.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF YOU DON'T KNOW — the recovery move                     ║
  ## ║                                                            ║
  ║ A judge asks something you genuinely don't know. The recovery ║
  ║ move:                                                          ║
  ## ║                                                            ║
  ║   1. Don't bluff. Don't hedge. Say "i don't know" cleanly.     ║
  ║   2. Name what you DO know that's adjacent.                    ║
  ║   3. Offer a follow-up after the demos.                        ║
  ## ║                                                            ║
  ║ Example: judge asks "what's your token usage per investigation"║
  ║ and you don't have the number.                                 ║
  ║                                                                ║
  ║   "i don't have the exact number — i know each investigation   ║
  ║    fires up to 6 tool calls under a maxTokens of 4096, but i   ║
  ║    haven't tracked the per-run total. happy to pull it from    ║
  ║    the logs and send it after."                                ║
  ## ║                                                            ║
  ║ Judges respect "i don't know" delivered with composure. They   ║
  ║ remember the presenter who bluffed.                            ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## ────────────── RUN SHEET — chapter 6 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ Q&A · post-clock · prep only                              │
  ├───────────────────────────────────────────────────────────┤
  │ PATTERN     direct sentence + one repo anchor + stop      │
  │                                                            │
  │ "is it working?"   demo = real cached run · live in       │
  │                    header runs against bloomreach now     │
  │ "hard part?"       schema gate · 3 pure fns in            │
  │                    lib/agents/categories.ts                │
  │ "stack?"           next 16 · react 19 · anthropic sdk ·   │
  │                    MCP sdk · NDJSON streaming             │
  │ "in hackathon?"    yes — agents · gate · routes · UI ·    │
  │                    bones are scaffolds                     │
  │ "business?"        $99/mo per workspace · slack briefings │
  │                    · 15 min with a bloomreach customer    │
  │ "used AI?"         heavily · prompts + boilerplate ·       │
  │                    architecture is mine · would be worse  │
  │                    signal to not use it                    │
  │ "why MCP?"         bloomreach speaks it · model picks the │
  │                    right tool · industry convergence       │
  │ "when it's wrong?" trace shows work · confidence rating · │
  │                    forced-synthesis turn · validator falls │
  │                    back to "insufficient data"             │
  │                                                            │
  │ "i don't know"     name what you DO know · offer follow-up │
  │                    after demos · never bluff               │
  │                                                            │
  │ DEFER       second follow-up on same probe →               │
  │             "happy to dig in after the demos"              │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   the answer pattern (direct · evidence · stop) │
  │ MUST OWN    AI assistance · own it matter-of-factly       │
  └───────────────────────────────────────────────────────────┘
```

End of book. Run the demo end-to-end with a timer before reading
anything else.
