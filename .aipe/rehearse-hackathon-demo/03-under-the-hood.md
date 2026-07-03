# Chapter 03 — Under the hood (6:00–8:00, two minutes)

The demo landed. The room has seen the trace, the fault receipt, and (optionally) the live MCP swap. Now they want to know how it works — and this is the chapter where you earn credibility without losing the room. Two minutes. One diagram. One mechanism. You go exactly one level deep and you stop.

The mechanism worth showing is the **DataSource seam**. Not the whole architecture, not the agent loop, not the OAuth chain. One boundary — the port that lets the same agents run against **any MCP server**, synthetic data, or synthetic-data-with-injected-faults. This is the seam that made the whole live-synthetic path possible, made the fault-injection receipt possible, made the settings-modal live swap possible, and is your strongest single technical signal.

The framing that matters here: **Bloomreach is the default MCP preset**, not the product's identity. The product is a multi-agent analyst that speaks MCP. Bloomreach is the server it was built against first, and it ships as the default in `MCP_URL`.

  ## The time-budget bar

  You own two minutes. Come in, draw the diagram, walk one axis across it, get out.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░  │
  │ 0:00 ── 1:00 ─────────────── 6:00 ── 8:00 ────────── 10:00 │
  │        UNDER THE HOOD — you own 6:00 to 8:00 (2 minutes)   │
  └──────────────────────────────────────────────────────────┘
```

  ## The one diagram — the DataSource seam

  This is the picture you draw on screen (or reference from a slide if you have one ready). The whole chapter hangs on it. If the room walks away with this one picture in their head, you have won the technical credibility beat.

```
  The DataSource seam — one interface, three adapters

  ┌─ agents (Claude · aptkit) ──────────────────────────────────┐
  │                                                              │
  │   monitoring    diagnostic    recommendation    query        │
  │        │             │              │             │           │
  │        └─────────────┴──────────────┴─────────────┘           │
  │                          │                                    │
  │                          ▼                                    │
  │                                                              │
  │        interface DataSource {                                │
  │          executeEQL(query): Promise<Result>                  │
  │          listCatalogs(): Promise<Catalog[]>                  │
  │          getSchema(): Promise<WorkspaceSchema>               │
  │        }                                                    │
  │                                                              │
  └──────────────────────────┬──────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
  ┌── adapter 1 ─────┐ ┌── adapter 2 ─────┐ ┌── adapter 3 ─────┐
  │ Mcp              │ │ Synthetic         │ │ FaultInjecting   │
  │ DataSource       │ │ DataSource        │ │ (decorator)      │
  │                  │ │                   │ │                  │
  │ MCP over HTTPS   │ │ in-process        │ │ wraps any        │
  │ + one of three   │ │ deterministic     │ │ DataSource +     │
  │ AuthProviders:   │ │ ecommerce data    │ │ injects timeouts │
  │   · bloomreach   │ │ (seeded PRNG)     │ │ + malformed JSON │
  │     OAuth PKCE   │ │                   │ │ (seeded PRNG)    │
  │   · bearer       │ │ used in:          │ │                  │
  │   · anonymous    │ │ live-synthetic    │ │ used in:         │
  │                  │ │ (default) +       │ │ eval:load        │
  │ used in:         │ │ demo replay       │ │                  │
  │ live-mcp         │ │                   │ │                  │
  └──────────────────┘ └───────────────────┘ └──────────────────┘

  lib/data-source/{mcp-data-source,synthetic-data-source,
                    fault-injecting}.ts
  lib/mcp/auth-providers/{bloomreach,bearer,anonymous}.ts

  ┌─ per-request UI override ──────────────────────────────────┐
  │ x-bi-mcp-config: <base64(json)>                             │
  │   { url?, authType?, bearerToken? }                          │
  │                                                              │
  │ modal → localStorage → header → route decode → makeDataSource│
  │ Session D of the synthetic-first plan; the "swap on stage"   │
  │ beat rides this transport.                                   │
  └──────────────────────────────────────────────────────────────┘
```

  You draw that on the whiteboard or click a diagram slide. Then you talk it.

  ## The verbatim script — talking the diagram

  Two minutes on the clock. Three sentences per box. Do not go deep — go direct.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  the diagram, DataSource             "the agents don't know where
  interface highlighted at the        their data comes from. they
  center                              talk to a port — one
                                       interface, three methods."
  ────────────────────────            ──────────────────────────
  highlight adapter 1                 "adapter one is a real MCP
  (McpDataSource + three               server — Bloomreach is the
  AuthProviders)                       default preset, but any
                                       HTTPS MCP endpoint works.
                                       three auth strategies plug
                                       in: bloomreach OAuth PKCE,
                                       a bearer token, or
                                       anonymous. that's what the
                                       settings modal was toggling
                                       between."
  ────────────────────────            ──────────────────────────
  highlight adapter 2                 "adapter two is deterministic
  (SyntheticDataSource)               synthetic ecommerce data,
                                       in-process. that's what you
                                       watched the demo run against.
                                       no creds, no network."
  ────────────────────────            ──────────────────────────
  highlight adapter 3                 "adapter three is a decorator
  (FaultInjectingDataSource)          — it wraps either of the other
                                       two and injects timeouts and
                                       malformed JSON at a
                                       configurable rate. that's how
                                       the fault-injection receipt
                                       works."
  ────────────────────────            ──────────────────────────
  highlight the arrow from            "same agents, three adapters.
  agents to the port                  the seam is what made the
                                       whole live-synthetic path
                                       possible, what makes the
                                       fault injection receipt
                                       honest, and what let the
                                       settings modal swap a live
                                       MCP server on stage. five
                                       independent uses — that's
                                       how i know the seam carries
                                       the contract."
  ────────────────────────            ──────────────────────────
```

  ┃ "Same agents, three adapters. The port is the seam that made the whole thing possible."

  ## The one axis worth tracing — control flow across the seam

  If you have thirty seconds left in the chapter, trace one axis across the seam. This is what a senior engineer in the room is watching for — evidence that you understand which boundary carries the contract.

  Ask: **who decides control flow?** Trace it across the seam.

```
  Tracing one axis across the boundary

  axis:  who decides what happens next?

  ┌─ agent side ─────────┐  seam  ┌─ adapter side ────────────┐
  │                       │        │                            │
  │  the model decides   │═══════►│  the adapter runs           │
  │  which tool to call   │        │  (executes EQL,             │
  │  and when to stop     │        │   returns rows or fails)    │
  │                       │        │                            │
  └───────────────────────┘        └───────────────────────────┘

     control lives on          control ends here;
     the model side            adapter is purely reactive

  the axis flips at the boundary → the seam carries a contract.
  which means: swapping the adapter (real / synthetic / fault-
  injected) cannot change agent behavior. that's what makes the
  eval reproducible.
```

  ┃ "The agent decides, the adapter obeys. That's why swapping adapters doesn't change how the agent thinks."

  If you're running long, drop this. The main diagram is the load-bearing part.

  ## Strong vs weak — the architecture tour trap

  Under-the-hood is where demos die of over-explaining. Do not try to fit the whole architecture in two minutes.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ pull up an architecture         │ one diagram: DataSource port    │
  │ diagram showing:                 │ + three adapters. that's it.   │
  │   - Next.js app router          │                                 │
  │   - OAuth PKCE                   │ walk it in three sentences:     │
  │   - MCP transport                │   → agents talk to a port      │
  │   - AsyncLocalStorage            │   → three adapters plug in     │
  │   - NDJSON streaming            │   → one is a decorator          │
  │   - the agent loop               │                                 │
  │   - the vitest eval config      │ close with the axis line:       │
  │                                 │   "agent decides, adapter obeys"│
  │  walk each layer in 15 seconds  │                                 │
  │                                 │  one level deep. stop.          │
  │  90 seconds in, room is lost;   │                                 │
  │  35 seconds left, you're        │                                 │
  │  panicking through the last     │                                 │
  │  half                           │                                 │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  The rule: one mechanism. One diagram. Three sentences per box. The room already trusts you from the demo — the technical beat is about showing you can *choose* what to explain, not that you can explain everything.

  ## IF IT BREAKS — the whiteboard-draw backup

  Under-the-hood has one on-screen beat — the diagram — so it needs a backup for the diagram surface.

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                       ║
  ║                                                                    ║
  ║ Slide deck / diagram viewer fails to render:                       ║
  ║   → hand-draw the diagram on the whiteboard (or on paper for a     ║
  ║      camera demo). Practice this — you should be able to sketch    ║
  ║      the DataSource port + three adapters in 20 seconds.           ║
  ║   → the diagram is simple by design so it survives being drawn     ║
  ║      live under stress                                             ║
  ║                                                                    ║
  ║ Whiteboard not available AND slide fails:                          ║
  ║   → talk it verbally, one sentence per adapter:                    ║
  ║      "there's a port. three adapters plug into it. one talks to    ║
  ║       any MCP server — bloomreach by default, bearer or anonymous   ║
  ║       for any other. one generates synthetic data in-process. one   ║
  ║       wraps either of them and injects faults. same agents, three   ║
  ║       adapters."                                                    ║
  ║   → this is the last-resort script; four sentences, ~15 seconds    ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝
```

  ## The "tighten it" cut

  If the demo ran long and you enter this chapter behind clock, cut in this order.

```
  Running long — drop these beats, in this order:

    1. drop the axis trace (the "who decides control flow" beat)
       cost: 30 seconds saved. keeps the main diagram intact.

    2. drop the third sentence on each adapter box
       one sentence per box instead of three; makes it a
       drive-by tour of the seam
       cost: 45 seconds saved. this is your last cut.

  Floor:
    → the room must see the diagram AND hear "same agents,
      three adapters." that pair is the whole point of the
      chapter. drop below that and the technical beat
      contributes nothing.
```

  ## One-page run sheet — under the hood

  This is what you hold on stage during the two-minute technical beat.

```
  ╭─ RUN SHEET · CHAPTER 03 · UNDER THE HOOD ────────────────╮
  │                                                           │
  │  Budget:     6:00–8:00 (2 minutes)                        │
  │  Money-shot marker:  N/A                                  │
  │                                                           │
  │  Pre-flight:                                              │
  │    → slide with DataSource diagram ready (or whiteboard   │
  │       marker in hand)                                     │
  │                                                           │
  │  Beats:                                                   │
  │    6:00  show the diagram                                 │
  │    6:15  "agents don't know where their data comes from   │
  │           — they talk to a port"                          │
  │    6:30  point at McpDataSource (adapter 1):              │
  │           any HTTPS MCP; three auth providers             │
  │           (bloomreach oauth / bearer / anonymous)         │
  │    6:50  point at SyntheticDataSource (adapter 2):        │
  │           in-process, seeded, default at page load        │
  │    7:10  point at FaultInjectingDataSource (adapter 3):   │
  │           decorator, injects timeouts + malformed JSON    │
  │    7:30  "same agents, three adapters, five uses"         │
  │    7:40  axis trace (optional): "agent decides,           │
  │           adapter obeys"                                  │
  │    7:55  hand to Chapter 04                               │
  │                                                           │
  │  The one line to nail:                                    │
  │    → "same agents, three adapters. that's the seam        │
  │       that made the whole thing possible."                │
  │                                                           │
  │  IF IT BREAKS:                                            │
  │    → slide fails → sketch on whiteboard in 20s            │
  │    → whiteboard unavailable → verbal 4-sentence version   │
  │                                                           │
  │  Tighten-it:                                              │
  │    1. drop the axis trace (−30s)                          │
  │    2. one sentence per adapter (−45s)                     │
  │                                                           │
  │  Floor:                                                   │
  │    → diagram visible + "same agents, three adapters"      │
  │                                                           │
  ╰──────────────────────────────────────────────────────────╯
```
