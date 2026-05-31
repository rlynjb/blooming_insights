# 03 — Under the hood   (6:00–8:00, 2 minutes)

  ## Opening hook

The demo just landed. The room is leaning in. Now they have a
question: how did that actually work? Chapter 3 answers it in
two minutes, one level deep, then stops.

This is where most hackathon demos lose the audience a second
time. The presenter has earned the room's attention with the
money shot, then immediately squanders it on an architecture
tour — five boxes, four arrows, six acronyms — until the room
checks out again. Don't. You pick the single most impressive
mechanism in the codebase, you draw one diagram of it, and you
explain it in three sentences. Then you move on.

The one mechanism worth showing for blooming insights is the
NDJSON streaming pipeline that bridges the agent loop running on
the server to the React UI rendering in the browser. It's what
makes the money shot possible. Every other architectural choice
serves it.

  ## The time-budget bar

Two minutes. The room is willing to hear ONE technical thing
right now. Spend the budget on the right thing.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ────────────────── 6:00 ─── 8:00 ─────────────10:00 │
  │   UNDER THE HOOD — you own 6:00 to 8:00 (2 minutes)      │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the streaming pipeline

One picture, the whole thing. This is the architecture diagram
you draw on screen or hold up on a slide. Everything you say in
chapter 3 maps onto a part of this diagram.

```
  the streaming pipeline · click → live reasoning → diagnosis

  ┌─ browser ───────────────────────────────────────────────────┐
  │  useInvestigation()  ← hook in lib/hooks/useInvestigation    │
  │   reader = res.body.getReader()                              │
  │   for each '\n'-delimited line:                              │
  │     JSON.parse(line) as AgentEvent                           │
  │     switch (e.type) { reasoning_step | tool_call_start | … } │
  │     setItems((p) => [...p, traceItem])  ← React state grows  │
  └─────────────────────────────────────────┬───────────────────┘
                                            │  HTTP body, NDJSON
                                            │  Content-Type:
                                            │   application/x-ndjson
                                            ▼
  ┌─ server (app/api/agent/route.ts) ────────────────────────────┐
  │  new ReadableStream({                                        │
  │    async start(controller) {                                 │
  │      const send = (e: AgentEvent) =>                         │
  │        controller.enqueue(encoder.encode(encodeEvent(e)))    │
  │      …                                                       │
  │      const diag = await diagAgent.investigate(anomaly, {     │
  │        onToolCall:   (tc) => send({ type:'tool_call_start',  │
  │                                     toolName, agent }),      │
  │        onToolResult: (tc) => send({ type:'tool_call_end',… })│
  │        onText:       (t)  => send({ type:'reasoning_step',…})│
  │      })                                                      │
  │      send({ type:'diagnosis', diagnosis: diag })             │
  │      send({ type:'done' })                                   │
  │    }                                                         │
  │  })                                                          │
  └─────────────────────────────────────────┬───────────────────┘
                                            │  injected hooks
                                            ▼
  ┌─ agent loop (lib/agents/base.ts · runAgentLoop) ─────────────┐
  │  for (turn = 0; turn < maxTurns; turn++) {                   │
  │    res = await anthropic.messages.create({ tools, … })       │
  │    onText?(textBlocks…)            ← fires every turn        │
  │    for each tool_use in res:                                 │
  │      onToolCall?(tc)               ← fires per tool call     │
  │      const r = await mcp.callTool(tu.name, tu.input)         │
  │      onToolResult?(tc)             ← fires after result      │
  │    if (no tool_use) return finalText                         │
  │  }                                                           │
  └─────────────────────────────────────────┬───────────────────┘
                                            │  MCP JSON-RPC
                                            ▼
  ┌─ bloomreach mcp server ─────────────────────────────────────┐
  │  execute_analytics_eql · get_event_schema · …                │
  └──────────────────────────────────────────────────────────────┘
```

The reasoning steps don't reach React after the agent finishes —
they reach React as the agent thinks them. That's the whole
trick. Read that diagram once a day until the demo.

  ## The three sentences

You explain this in three sentences. Practice them. Don't
improvise; you'll over-explain.

  ## Sentence 1 — the loop   (6:00–6:30)

```
  ┃ "every agent — monitoring, diagnostic, recommendation — runs
  ┃  the same loop: claude asks for a tool, we call bloomreach
  ┃  through mcp, we feed the result back, and we keep going
  ┃  until claude has no more tool calls left."
```

Then point at the third band of the diagram. Don't elaborate.
Don't say "this is implemented in TypeScript with async/await"
— the room can see it's code. The shape is the point.

  ## Sentence 2 — the streaming bridge   (6:30–7:00)

```
  ┃ "the agent loop fires three callbacks as it runs — every
  ┃  thought, every tool call start, every tool result. the
  ┃  route turns each callback into one line of NDJSON and
  ┃  pushes it into a streaming response. the browser reads the
  ┃  stream line-by-line and appends each event to react state.
  ┃  that's why the trace fills in live instead of all at once."
```

Then point at the top two bands. The whole pipeline lives in
about two hundred lines of code — the agent loop in
`lib/agents/base.ts` is the bottom of the diagram, the route in
`app/api/agent/route.ts` is the middle, and the
`useInvestigation` hook in `lib/hooks/useInvestigation.ts` is
the top.

  ## Sentence 3 — the load-bearing constraint   (7:00–7:30)

This is the engineering detail that earns credibility. Pick the
constraint, name it, name what would break without it.

```
  ┃ "the bloomreach server rate-limits at one request every ten
  ┃  seconds globally per user. the client parses the rate-limit
  ┃  error to find out how long to wait, waits exactly that
  ┃  long, then retries — capped at three. without that, a
  ┃  single investigation would burn its budget on the first
  ┃  rate-limit hit and produce nothing."
```

That sentence is the difference between "I built a UI for an
agent" and "I built around the real failure modes of a
production-grade API." Judges who have shipped systems will
notice.

  ## The "I built one" beat — 30 seconds left   (7:30–8:00)

You have thirty seconds left in chapter 3. Use them to deflect
to chapter 4 (the build story) — but don't burn them on dead
silence either. Show ONE thing on screen that proves the trace
they just watched is real.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  scroll the status log up so       "every blue line in this log
   the EQL query text from the        is a real query the agent
   live trace is visible              wrote. nothing is canned."
  ──────────────────────────        ───────────────────────────
  hand-off into chapter 4           "let me tell you the part
                                      that was hard to build."
```

  ## Strong vs weak — the under-the-hood failure mode

The mistake is going one level too deep. Two levels is a
lecture; one is a credibility win. Stop at one.

```
  WEAK UNDER-THE-HOOD               STRONG UNDER-THE-HOOD
  ─────────────────────────────     ─────────────────────────────
  opens a separate slide with       points at the running app,
   five boxes and twelve arrows      draws or shows ONE diagram
                                     of the streaming pipeline
  walks through every box:
   "this is the Next.js route,      says THREE sentences:
    which uses streaming response     · the agent loop
    bodies via ReadableStream,        · the streaming bridge
    which then is consumed in the     · one load-bearing
    React component using a useRef…"    constraint (rate limit)
  ─────────────────────────────     ─────────────────────────────
  3 minutes · room is glazing       90 seconds · room is nodding
  by minute 2                       presenter has 30s buffer
  ─────────────────────────────     ─────────────────────────────
  judges' next question:            judges' next question:
   "what does it do, exactly?"       "what was hard to build?"
   (you already lost them)           (this is the question you
                                      WANT — chapter 4 answers it)
```

The strong version sets up chapter 4. The weak version makes
chapter 4 redundant because you've already burned through the
budget. Trust the diagram. Three sentences.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF IT BREAKS — under the hood                             ║
  ## ║                                                            ║
  ## ║ This chapter has no live interaction — it's the diagram   ║
  ## ║ and three sentences. The only way it breaks is if a judge ║
  ## ║ interrupts mid-sentence with a deep technical question     ║
  ## ║ ("what model? what's the context window? why MCP?"). DO   ║
  ## ║ NOT answer it inside chapter 3. Say:                      ║
  ## ║                                                            ║
  ## ║   "great question — i'll cover that in q&a after the      ║
  ║    demo. for now, this is the one thing i want to show you." ║
  ## ║                                                            ║
  ## ║ Then finish the three sentences. The q&a chapter (06) has ║
  ## ║ the answers prepped: claude sonnet 4.6, model context     ║
  ## ║ protocol because bloomreach already speaks it, the agent   ║
  ## ║ loop is in lib/agents/base.ts, the rate-limit handling in  ║
  ║ lib/mcp/client.ts. You're ready for it — just not right now.  ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## Tighten it — if you're running long

You have two minutes for this chapter. If you walked into it
with ninety seconds because chapter 2 ran long, here's the cut
order:

```
  cut 1   drop the "I built one" beat at 7:30
            saves 30s · costs only the bridge into chapter 4

  cut 2   drop sentence 3 (the rate-limit constraint)
            saves 30s · costs the credibility moment with
            engineers in the room. you keep the streaming-
            pipeline story, which is the load-bearing part.

  cut 3   show the diagram for 5 seconds without explaining
            it, say "the short version is: real agent loop,
            streamed live, real MCP calls" and skip to ch 4.
            saves 60s · costs almost everything. only do this
            if you're at 7:30 with chapter 3 still on screen.
```

The floor: the streaming-pipeline diagram and at least one
sentence about it. That's the irreducible minimum. The diagram
alone (with the right line) is enough to land "this is real
infrastructure, not a wrapper."

  ## ────────────── RUN SHEET — chapter 3 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ UNDER THE HOOD · 6:00–8:00 · 2 minutes                    │
  ├───────────────────────────────────────────────────────────┤
  │ 6:00   show the streaming-pipeline diagram                │
  │ 6:05   SENTENCE 1 — the agent loop                        │
  │         "every agent runs the same loop: claude asks for  │
  │          a tool, we call bloomreach, we feed it back…"    │
  │ 6:30   SENTENCE 2 — the streaming bridge                  │
  │         "the loop fires three callbacks · the route turns │
  │          each into NDJSON · browser appends to react…"    │
  │ 7:00   SENTENCE 3 — the rate-limit constraint             │
  │         "bloomreach rate-limits 1 req per 10s globally.   │
  │          the client parses the error, waits, retries…"    │
  │ 7:30   scroll the status log up, show real EQL text       │
  │         "every blue line is a real query."                │
  │ 7:55   bridge: "let me tell you the part that was hard."  │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   the streaming-pipeline diagram + 1 sentence   │
  │ IF BREAKS   "i'll cover that in q&a" · finish sentences   │
  │ TIGHTEN     cut the "i built one" beat → sentence 3 →     │
  │             diagram alone + one line                       │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 4 next.
