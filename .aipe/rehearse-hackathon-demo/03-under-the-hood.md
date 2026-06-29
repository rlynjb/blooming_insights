# Chapter 03 — Under the hood (6:00–8:00, 2 minutes)

You have two minutes. The room has just seen the agent loop run. Now they want to know if it is real — whether what they saw is a thin wrapper around one LLM call or actually the multi-agent system you claimed it was. The job of this chapter is to earn that credibility in two minutes and stop.

The discipline you are training against is the architecture tour. You will be tempted to walk every box on the diagram, explain every adapter, justify every choice. Don't. Pick **one** mechanism — the one most worth showing — go exactly one level deep, and hand the room a clean enough mental model that they can ask intelligent follow-ups in Q&A. The mechanism that earns the most credibility for the least time is the **4-agent loop on the `@aptkit/core` runtime**, anchored on **the DataSource seam** that makes the synthetic mode possible.

The reason that one mechanism is the right pick: it explains both the differentiator (the streaming trace they just watched) and the demo-day reliability (why `live-synthetic` exists at all). Two questions, one diagram. Then you stop and move on.

  ## The time-budget bar

```
  ┌────────────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─────────── 6:00 ──────────── 8:00 ──────────────── 10:00 │
  │             UNDER THE HOOD — you own 6:00 to 8:00 (2 minutes)  │
  └────────────────────────────────────────────────────────────────┘
```

Two minutes. One diagram. Three sentences per box. Then stop.

  ## The chapter-opening diagram — the architecture in one screen

This is the only diagram you will draw in this chapter. Everything below the diagram is sentences against it.

```
  THE LOOP — 4 AGENTS, 1 RUNTIME, 1 SEAM

  ┌────────────────────────────────────────────────────────────────┐
  │                       ROUTE HANDLERS                            │
  │   app/api/briefing/route.ts       app/api/agent/route.ts        │
  │            │                            │                       │
  │            │   NDJSON stream            │                       │
  │            ▼                            ▼                       │
  │   ┌────────────────────────────────────────────────────────┐    │
  │   │              THE 4 AGENTS  (lib/agents/)               │    │
  │   │   monitoring    diagnostic   recommendation    query   │    │
  │   │       │             │              │             │     │    │
  │   │       └─────────────┴──────────────┴─────────────┘     │    │
  │   │                       │                                │    │
  │   │             all 4 run on the same runtime              │    │
  │   └───────────────────────┼────────────────────────────────┘    │
  │                           ▼                                     │
  │   ┌────────────────────────────────────────────────────────┐    │
  │   │     APTKIT CORE  ·  @aptkit/core@0.3.0                 │    │
  │   │     (owns: tool-use loop, model calls, trace emission) │    │
  │   │                                                        │    │
  │   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │    │
  │   │   │ ModelProvider│  │ ToolRegistry │  │ TraceSink    │ │    │
  │   │   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │    │
  │   └──────────┼─────────────────┼─────────────────┼─────────┘    │
  │              │ adapted by      │ adapted by      │ adapted by   │
  │              ▼                 ▼                 ▼              │
  │   ┌──────────────────────────────────────────────────────────┐  │
  │   │   3 ADAPTER CLASSES  ·  lib/agents/aptkit-adapters.ts    │  │
  │   │   AnthropicModelProviderAdapter   (model:  anthropic SDK)│  │
  │   │   BloomingToolRegistryAdapter     (tools:  DataSource)   │  │
  │   │   BloomingTraceSinkAdapter        (trace:  NDJSON out)   │  │
  │   └──────────────────────────────────┬───────────────────────┘  │
  │                                      │                          │
  │                                      ▼                          │
  │              ┌───────────────────────────────────────┐          │
  │              │   THE SEAM  ·  lib/data-source/types  │          │
  │              │       interface DataSource            │          │
  │              └──┬───────────────────────────────┬────┘          │
  │                 │                               │               │
  │     ┌───────────▼──────────┐         ┌──────────▼──────────┐    │
  │     │ BloomreachDataSource │         │ SyntheticDataSource │    │
  │     │ (real MCP server,    │         │ (in-process fake    │    │
  │     │  OAuth, ~1 req/s)    │         │  ecommerce data)    │    │
  │     └──────────────────────┘         └─────────────────────┘    │
  │       mode = live-bloomreach          mode = live-synthetic     │
  └────────────────────────────────────────────────────────────────┘

  Reading the picture: agents run the loop on AptKit, AptKit talks
  to whatever DataSource the route handed it. The route picks based
  on `bi:mode`. Same agent code, two data substrates.
```

The whole thing fits on one screen. The colors of the demo you just watched are now labeled.

  ## Beat 1 — The 4-agent loop on a generic runtime (6:00–6:50)

There are four agents — `monitoring`, `diagnostic`, `recommendation`, `query` — each with its own prompt, its own tool subset, and its own job. The thing worth pointing at is that **none of them implement the agent loop themselves.** The loop — tool-use turn after tool-use turn, model call → tool call → tool result → model call again until done — lives in `@aptkit/core`. The agent files are *configuration* on top of that loop: prompt, tools, hooks.

```
  ┃ "Each agent is a prompt and a tool subset on top of a generic
  ┃  runtime. The loop itself lives in @aptkit/core. The agent
  ┃  files are configuration, not control flow."
```

Why mention this on stage: it signals senior judgment. The room knows what hand-rolled agent loops drift into — duplicated retry logic, four slightly-different tool-call parsers, three places where the trace gets emitted. Lifting the loop to a library and keeping the agents thin is the move a staff engineer makes. **Say one sentence about it, don't lecture.**

  ## Beat 2 — The 3-adapter bridge (6:50–7:20)

The library is provider-neutral. It does not know about Anthropic, about Bloomreach, or about NDJSON streaming. Three adapter classes bridge those concerns in about 200 lines:

```
  AnthropicModelProviderAdapter   →  satisfies AptKit's ModelProvider
                                      port using the @anthropic-ai/sdk
  BloomingToolRegistryAdapter     →  satisfies AptKit's ToolRegistry port
                                      by delegating to whichever
                                      DataSource the route passed in
  BloomingTraceSinkAdapter        →  satisfies AptKit's TraceSink port
                                      by emitting NDJSON events on the
                                      response stream
```

| SHOW (on screen)                                                | SAY (out loud)                                              |
|-----------------------------------------------------------------|-------------------------------------------------------------|
| open `lib/agents/aptkit-adapters.ts` in editor briefly (don't scroll the whole file — show the three `export class` lines) | "the library owns the loop. I own the boundary — three adapter classes, about 200 lines. Anthropic on one side, the data source on another, the NDJSON stream on the third." |

That's the under-the-hood credibility moment. You don't have to defend any of the choices — you just have to show the room there is a clean boundary, and that the boundary is exactly three classes wide.

  ## Beat 3 — The DataSource seam (7:20–8:00)

This is the beat that connects back to the demo and to chapter 04. The agents don't talk to Bloomreach directly. They talk to an interface called `DataSource` (defined in `lib/data-source/types.ts`), and there are two implementations behind it:

```
  ┌───────────────────────────────────────────────────────────────┐
  │   interface DataSource {                                       │
  │     bootstrap(): Promise<...>                                  │
  │     listTools(): Promise<ToolDef[]>                            │
  │     callTool(name, input, ...): Promise<ToolResult>            │
  │   }                                                            │
  └───────────────────┬───────────────────────────┬───────────────┘
                      │                           │
                      ▼                           ▼
        BloomreachDataSource           SyntheticDataSource
        (real MCP transport,           (in-process; same
         OAuth, server rate            tool surface, deterministic
         limits)                       ecommerce data)
```

| SHOW (on screen)                                                | SAY (out loud)                                              |
|-----------------------------------------------------------------|-------------------------------------------------------------|
| stay on the architecture diagram; point at the DataSource box and its two children | "and below the adapter is the seam that made today's demo possible — DataSource. Two implementations behind it. The agents don't know which one they're running against. The route picks based on the mode toggle." |
| (no click, just point) | "that's why I can demo `live-synthetic` on stage and switch to `live-bloomreach` in production without changing any agent code. **Same loop, swappable substrate.**" |

```
  ┃ "Same loop. Swappable substrate. The agents don't know which
  ┃  side of the seam they're on."
```

This is also the sentence chapter 04 picks up — the seam was proven by *using* it, not by hoping it worked.

  ## The IF-IT-BREAKS box

╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ The editor won't open `aptkit-adapters.ts`, or you tab into a      ║
║ different window by accident, or the projector loses the screen.   ║
║                                                                    ║
║ → Skip the file. Stay on the architecture diagram in slides /      ║
║   in a static image you keep in a third tab. Point at the three    ║
║   adapter boxes and the DataSource boxes — that's all the room     ║
║   needs to see.                                                    ║
║ → Say: "the three adapters are about 200 lines total — I won't     ║
║   pull them up, but the boundary is clean enough to fit on this    ║
║   one screen."                                                     ║
║ → The file open is a nice-to-have, not the beat. The diagram       ║
║   carries the beat.                                                ║
╚══════════════════════════════════════════════════════════════════╝

  ## The "tighten it" cut

If you're running long, **drop Beat 2 (the adapter file open).** Stay on the diagram, walk straight from "agents are configuration on a generic runtime" (Beat 1) to "and the DataSource seam is what makes today's demo possible" (Beat 3). The credibility comes from the diagram and the seam, not from opening the file.

Floor for this chapter: **the diagram is on screen and you say the seam sentence.** If you cut everything else and only land "same loop, swappable substrate," you have done the chapter's job — the room understands there is real engineering under the demo and you have set up chapter 04's build story.

The trap to avoid is the opposite cut: dropping the diagram and trying to do the chapter from prose. The diagram is the entire chapter. Without it you are reciting architecture words and the room loses interest in 20 seconds.

  ## The one-page run sheet — under the hood

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ RUN SHEET — 03 UNDER THE HOOD             6:00–8:00 (2 minutes)  │
  │                                                                  │
  │ STATE BEFORE: architecture diagram on screen (slide or image     │
  │               in a tab). Optional: editor with                   │
  │               lib/agents/aptkit-adapters.ts queued.              │
  │                                                                  │
  │ 6:00–6:50  BEAT 1 — the 4-agent loop on a runtime                │
  │             "Each agent is a prompt and a tool subset on top of  │
  │              a generic runtime. The loop lives in @aptkit/core." │
  │                                                                  │
  │ 6:50–7:20  BEAT 2 — the 3-adapter bridge                         │
  │             show `aptkit-adapters.ts`, point at 3 export class   │
  │             "the library owns the loop. I own the boundary —    │
  │              three adapter classes, about 200 lines."            │
  │                                                                  │
  │ 7:20–8:00  BEAT 3 — the DataSource seam                          │
  │             point at the DataSource box and its two children     │
  │             NAIL THIS LINE:                                      │
  │             "Same loop. Swappable substrate. The agents don't    │
  │              know which side of the seam they're on."            │
  │             → hand off to chapter 04                             │
  │                                                                  │
  │ NAIL THIS:  the "same loop, swappable substrate" line.           │
  │ IF BREAKS:  skip the file open. Stay on the diagram.             │
  │ TIGHTEN:    drop Beat 2 entirely. Diagram + seam sentence is     │
  │             the floor.                                           │
  ╰──────────────────────────────────────────────────────────────────╯
```
