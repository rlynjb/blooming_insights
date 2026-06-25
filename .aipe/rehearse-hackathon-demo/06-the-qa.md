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

The most important question to answer correctly. With
live-synthetic as the demo mode, the honest answer is "the
agents are running live right now." Own that directly.

```
  ┃ "what you just watched was live — real agent loop, real
  ┃  anthropic calls, real reasoning. the data source is an
  ┃  in-process synthetic ecommerce dataset i wrote, because
  ┃  the live bloomreach mode needs an OAuth dance i'm not
  ┃  going to do on stage. there's a third mode — 'demo' —
  ┃  that replays a cached snapshot for when the model latency
  ┃  is too long for the slot. all three are real toggles in
  ┃  the header."
```

If they push: the toggle is `bi:mode` in `localStorage`, three
values: `demo` | `live-bloomreach` | `live-synthetic`. The route
in `app/api/agent/route.ts` branches on it. Live-bloomreach
goes through the OAuth handshake, hits the rate-limited alpha
server, and takes ~2 minutes per investigation. Live-synthetic
goes through the same agent code path but the DataSource
(`lib/data-source/synthetic-data-source.ts`, 516 LOC) is
in-process — no auth, no rate limit, just model latency. Offer
to toggle to live-bloomreach after the demos if they want to
see the OAuth flow. Don't switch on stage.

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
  ┃  styling. @aptkit/core 0.3 for the agent runtime — it's a
  ┃  library i published. anthropic SDK for the model — claude
  ┃  sonnet 4.6. bloomreach via the MCP SDK with OAuth and
  ┃  dynamic client registration. NDJSON over a Next.js
  ┃  streaming response bridges the agent loop callbacks to
  ┃  React."
```

If they push on infrastructure: vercel for hosting,
encrypted-cookie session store for cross-instance OAuth state,
in-process MCP client with rate-limit retry and a 60s response
cache. Files: `lib/mcp/client.ts`, `lib/mcp/auth.ts`,
`lib/mcp/connect.ts`. The Blooming agents are thin wrappers
over `@aptkit/core` agents — `lib/agents/aptkit-adapters.ts`
(206 LOC) holds the three bridge classes (model provider, tool
registry, trace sink). The legacy hand-rolled loop is preserved
at `lib/agents/base-legacy.ts` for reference.

  ## Probe 4 — "Did you build this during the hackathon?"

Own it. Don't defend.

```
  ┃ "yes — the agents, the schema gate, the streaming routes,
  ┃  the coverage grid, the investigate flow, the DataSource
  ┃  seam and both adapters. i also published the agent-loop
  ┃  library, @aptkit/core, as a separate package. the bones
  ┃  are the next.js scaffold, the MCP SDK, and the anthropic
  ┃  SDK; everything app-specific is hackathon-window code."
```

If they're skeptical: the git history shows the build order —
the most recent commits are the synthetic DataSource (c75ec3e),
the Olist substrate removal (PR #8 / 62c24d7), the AptKit 0.3
upgrade, the page decomposition (817 → 461 LOC), and the
session-keyed state fix for the concurrent-user wipe bug. 221
tests across `*.test.ts`. You wrote the architecture decisions;
you wrote the prompts; you wrote the streaming protocol; you
wrote the schema gate; you wrote @aptkit/core.

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
parses the JSON and falls back to a "insufficient data"
diagnosis if it can't. Hallucinated numbers are bounded — the
model is reading from real tool results, not guessing them.

On evals specifically: i built a 4-pillar eval suite earlier
in the project — K=10 reruns, an LLM-as-judge calibrated 8/8
and 3/3 against my own labels, ran against an Olist
e-commerce substrate. It surfaced three real bugs: BRL prices
in cents getting reported as Reais, binary calibration fooling
the confidence rating, and conclusion instability across
reruns. I fixed all three. Then i retired the substrate when
the synthetic adapter shipped — the in-process shape made
the eval pipeline the wrong shape, and i'd rather have no
scaffolding than the wrong scaffolding. The replacement for
it isn't built yet; that's the honest gap.

  ## Probe 9 — "Why pull the agent loop out into a library? Isn't that over-engineering for a hackathon?"

A senior probe. The honest answer is "I built three agents
hand-rolling the same loop, noticed the duplication, and
extracted it — and then realized the seam was useful for more
than deduplication."

```
  ┃ "i hand-rolled it three times — monitoring, diagnostic,
  ┃  recommendation — and the third time it was clearly the
  ┃  same loop with different prompts. so i extracted it into
  ┃  @aptkit/core and published the package. the win wasn't
  ┃  just deduping the code — it was that the adapter boundary
  ┃  let me swap the data source without touching the agents.
  ┃  that's how live-synthetic shipped — a new DataSource
  ┃  adapter, zero agent changes. the legacy hand-rolled loop
  ┃  is still in lib/agents/base-legacy.ts if you want to see
  ┃  what i moved away from."
```

If they push: AptKit is `@aptkit/core@0.3.0`, source at
`github.com/rlynjb/aptkit-core`. The Blooming-owned adapters
(`lib/agents/aptkit-adapters.ts`, 206 LOC) are three classes:
`AnthropicModelProviderAdapter` (bridges to the Anthropic SDK),
`McpToolRegistryAdapter` (bridges to the DataSource interface),
and a trace sink that fires Blooming's callback shapes. Three
files, one boundary. The loop is library code; the domain
shapes are Blooming code.

  ## Probe 10 — "Isn't synthetic data just fake data? That's not a real demo."

Engineers will push on this. The answer is structural: the
agent code path is real, the model call is real, the reasoning
is real — only the queried substrate is synthetic. That's a
much smaller claim than "fake demo" and a much bigger claim
than "cached replay."

```
  ┃ "the agent loop is real. the anthropic call is real. the
  ┃  EQL queries on screen are queries the model just generated.
  ┃  the only thing that's synthetic is the data the queries
  ┃  hit — and it's deterministic, in-process, designed to
  ┃  exercise the same anomaly patterns the real bloomreach
  ┃  workspace would. swap the DataSource adapter for the
  ┃  bloomreach one and the agents don't know the difference.
  ┃  that IS the test — if the seam is right, the agents are
  ┃  oblivious to the substrate."
```

If they push: the synthetic data source is
`lib/data-source/synthetic-data-source.ts` (516 LOC). It
implements the same `DataSource` interface as
`bloomreach-data-source.ts`. The agents (and the agent code in
`@aptkit/core` they wrap) import the interface, not either
implementation. That's the load-bearing property: "vendor
swappability" isn't a slogan; it's something you can prove by
running the same agents through a different DataSource and
watching them behave identically.

  ## Probe 11 — "You built an eval pipeline and then deleted it. Why?"

The "show your engineering judgment" probe. Senior judges will
ask this if you opened the door in the build story. The honest
answer is that the eval substrate was tied to the wrong shape,
and when the right shape arrived, keeping the old eval would
have been worse than starting over.

```
  ┃ "the eval suite was built against an Olist e-commerce
  ┃  substrate i'd swapped in for testing — public dataset,
  ┃  rich enough to exercise the agents. when the in-process
  ┃  synthetic adapter shipped, the substrate was redundant —
  ┃  i had a cleaner shape that ran in the same process as
  ┃  the agents. keeping the old eval pipeline against a
  ┃  retired substrate would mean maintaining two data paths
  ┃  to test one. the discipline of writing evals stayed; the
  ┃  scaffolding of THAT eval pipeline didn't. the next eval
  ┃  is a smaller, in-process suite against the synthetic
  ┃  adapter — and i haven't built it yet. that's the honest
  ┃  gap right now."
```

If they push on judgment: the eval flywheel earned its keep
while it ran. It surfaced three real bugs the agents had — BRL
cents-vs-Reais, binary calibration in the confidence rating,
conclusion instability across reruns. All three got fixed.
Then the substrate retired and the pipeline came with it. The
move is "delete what's no longer earning its keep," not
"abandon evals." Documented in `.aipe/audits/refactors/` and
`.aipe/audit-refactor-eval-substrate/`.

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
  │ "is it working?"   what you watched WAS live · synthetic  │
  │                    DataSource adapter · real loop+model · │
  │                    bloomreach mode exists, OAuth on stage │
  │                    is the only reason to skip it          │
  │ "hard part?"       schema gate · 3 pure fns in            │
  │                    lib/agents/categories.ts                │
  │ "stack?"           next 16 · react 19 · @aptkit/core 0.3  │
  │                    (i wrote it) · anthropic sdk · MCP sdk │
  │ "in hackathon?"    yes — agents · gate · routes · UI ·    │
  │                    DataSource seam · both adapters ·       │
  │                    @aptkit/core (separate package)         │
  │ "business?"        $99/mo per workspace · slack briefings │
  │                    · 15 min with a bloomreach customer    │
  │ "used AI?"         heavily · prompts + boilerplate ·       │
  │                    architecture is mine · would be worse  │
  │                    signal to not use it                    │
  │ "why MCP?"         bloomreach speaks it · model picks the │
  │                    right tool · industry convergence       │
  │ "when it's wrong?" trace shows work · confidence rating · │
  │                    forced-synthesis turn · had an eval     │
  │                    pipeline, surfaced 3 bugs, retired it   │
  │ "why a library?"   hand-rolled the loop 3 times · third   │
  │                    time it was clearly the same loop ·     │
  │                    seam → DataSource swap is free          │
  │ "isn't synthetic   the agent code is real · the model     │
  │  just fake?"        call is real · only the substrate is  │
  │                    synthetic · agents are oblivious to it │
  │ "you deleted        the substrate retired · the eval was  │
  │  the eval?"         tied to it · 3 real bugs found+fixed  │
  │                    before retirement · next eval not yet  │
  │                                                            │
  │ "i don't know"     name what you DO know · offer follow-up │
  │                    after demos · never bluff               │
  │                                                            │
  │ DEFER       second follow-up on same probe →               │
  │             "happy to dig in after the demos"              │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   the answer pattern (direct · evidence · stop) │
  │ MUST OWN    AI assistance · own it matter-of-factly       │
  │ MUST OWN    retired eval pipeline · "delete what stopped  │
  │             earning its keep" is a SENIOR move             │
  └───────────────────────────────────────────────────────────┘
```

End of book. Run the demo end-to-end with a timer before reading
anything else.
